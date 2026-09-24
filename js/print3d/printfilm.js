// Print timelapse: a film of the product being printed, layer by layer, like a printer's own
// timelapse. The nozzle traces the real toolpath (toolpath.js, or a dropped G-code via gcode.js),
// plastic appears as extruded beads in the chosen filament colours, the bed or the head moves like
// the chosen printer, the first colour change gets its own pause, and a counter shows the layer, Z
// and the estimated print time.
//
//   openPrintTimelapse({ parts, colors, printer, product, art }) -> { close }
//       parts    buildProduct(...).parts ([{ name, mesh, color }], print coordinates, mm)
//       colors   { base, ink, backdrop } (also accepts plate/line/background); part colours otherwise
//       printer  'a2l' | PRINTERS entry | products.js PRINTER ({ name, bed: { x, y, z } })
//       product  buildProduct's result (uses .settings, .id, .product.name) or a product id
//       art      a caption ('Line art · bust') or { title }
//   createPrintFilm(toolpath, { camera, seconds, fps, colors, title, subtitle }) -> film
//       film.frames, film.map, film.draw(i, ctx2d, W, H), film.info, film.dispose()
//   renderPrintFilm(film, { width, height, signal, onProgress }) -> encodeVideo result (MP4 blob)
//
// Rendering: WebGL2, one instanced draw for all beads (a static buffer; the vertex shader grows the
// bead being extruded and hides the future ones from the print clock), a procedural textured-PEI
// plate, a simple toolhead and gantry. The HUD is drawn with Canvas 2D on top, in a dark panel so it
// reads on any backdrop.
import { buildToolpath, filmTimeMap, nozzleAt, layerAt, clock, formatDuration, resolvePrinter, PRINTERS, FILAMENTS } from './toolpath.js';
import { PRINTERS as PRESETS } from './presets.js';

export const FILM_FORMATS = {
  story: { w: 1080, h: 1920, name: '9:16' },
  square: { w: 1080, h: 1080, name: '1:1' },
  wide: { w: 1920, h: 1080, name: '16:9' },
};
export const FILM_SECONDS = [10, 15, 30];
export const FILM_FPS = [30, 60];

// ------------------------------------------------------------------------------ colour helpers
export function hexRgb(c) {
  if (Array.isArray(c)) return c.some(v => v > 1) ? c.slice(0, 3).map(v => v / 255) : c.slice(0, 3);
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return [0.94, 0.93, 0.9];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
const lin = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export const luminance = c => { const [r, g, b] = hexRgb(c).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrastRatio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const DARK_BACKDROP = '#2A2B2E', LIGHT_BACKDROP = '#E9E6E0';

/** A backdrop that keeps the part readable: the asked one unless it is too close to the part colours. */
export function pickBackdrop(asked, palette) {
  const main = palette[palette.length - 1] || '#F2F0EA';
  const ok = c => palette.every(p => contrastRatio(c, p) >= 1.6) || contrastRatio(c, main) >= 2.2;
  if (asked && ok(asked)) return { color: asked, adjusted: false };
  const alt = luminance(main) > 0.35 ? DARK_BACKDROP : LIGHT_BACKDROP;
  return { color: alt, adjusted: !!asked };
}

// ------------------------------------------------------------------------------ small math
const DEG = Math.PI / 180;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(e, c, up) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}

// ------------------------------------------------------------------------------ shaders
const LIGHT = `
uniform vec3 uEye; uniform vec3 uKey;
vec3 shade(vec3 base, vec3 N, vec3 P, float gloss, float cur) {
  vec3 V = normalize(uEye - P);
  if (dot(N, V) < 0.0) N = -N;
  float ndl = max(dot(N, uKey), 0.0);
  vec3 H = normalize(uKey + V);
  float spec = pow(max(dot(N, H), 0.0), 70.0) * gloss;
  float hemi = mix(0.30, 0.52, N.z * 0.5 + 0.5);
  float fill = max(dot(N, normalize(vec3(0.7, 0.2, 0.35))), 0.0) * 0.18;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.22;
  vec3 c = base * (hemi + 0.78 * ndl + fill) + spec + rim * mix(vec3(0.9), base, 0.3);
  c *= 1.0 + cur * 0.16; c += cur * 0.025;
  return c;
}
vec3 toSRGB(vec3 c) { c = c / (1.0 + c * 0.15); return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
`;
const BEAD_VS = `#version 300 es
layout(location=0) in vec4 aLoc;      // along (0|1), cos, sin, cap sign
layout(location=1) in vec3 iP0;
layout(location=2) in vec3 iP1;
layout(location=3) in vec2 iT;
layout(location=4) in vec3 iMeta;     // colour, feature, layer
uniform mat4 uVP; uniform float uTime, uLayer, uHW, uHH; uniform vec3 uBedOff; uniform vec3 uPal[8];
out vec3 vN; out vec3 vP; flat out vec3 vCol; flat out float vCur;
void main() {
  if (iT.x > uTime) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float f = clamp((uTime - iT.x) / max(1e-5, iT.y - iT.x), 0.0, 1.0);
  vec2 d = iP1.xy - iP0.xy; float L0 = length(d);
  vec2 dir = L0 > 1e-6 ? d / L0 : vec2(1.0, 0.0);
  vec2 side = vec2(-dir.y, dir.x);
  float L = L0 * f;
  float along = mix(-uHW * 0.8, L + uHW * 0.8, aLoc.x);
  vec3 p = vec3(iP0.xy + dir * along + side * aLoc.y * uHW, iP0.z - uHH + aLoc.z * uHH) + uBedOff;
  vec3 ns = normalize(vec3(side * aLoc.y / uHW, aLoc.z / uHH));
  vN = aLoc.w != 0.0 ? normalize(vec3(dir * aLoc.w, 0.0) + ns * 0.7) : ns;
  vP = p;
  vCol = uPal[int(iMeta.x + 0.5)];
  vCur = abs(iMeta.z - uLayer) < 0.5 ? 1.0 : 0.0;
  gl_Position = uVP * vec4(p, 1.0);
}`;
const BEAD_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vP; flat in vec3 vCol; flat in float vCur;
out vec4 o;
${LIGHT}
void main() { o = vec4(toSRGB(shade(vCol, normalize(vN), vP, 0.32, vCur)), 1.0); }`;
const SOLID_VS = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in vec3 aC;
uniform mat4 uVP; uniform vec3 uOff; uniform vec3 uScale;
out vec3 vN; out vec3 vP; out vec3 vC;
void main() { vec3 p = aP * uScale + uOff; vP = p; vN = aN; vC = aC; gl_Position = uVP * vec4(p, 1.0); }`;
const SOLID_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vP; in vec3 vC; out vec4 o;
${LIGHT}
void main() { o = vec4(toSRGB(shade(vC, normalize(vN), vP, 0.25, 0.0)), 1.0); }`;
const PLATE_VS = `#version 300 es
layout(location=0) in vec2 aP;
uniform mat4 uVP; uniform vec3 uBedOff; uniform vec2 uBed;
out vec2 vB; out vec3 vP;
void main() { vec2 b = mix(vec2(-14.0), uBed + 14.0, aP); vB = b; vP = vec3(b, 0.0) + uBedOff; gl_Position = uVP * vec4(vP, 1.0); }`;
const PLATE_FS = `#version 300 es
precision highp float;
in vec2 vB; in vec3 vP; out vec4 o;
uniform vec2 uBed; uniform vec3 uPlate; uniform float uGrit;
${LIGHT}
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  bool on = vB.x >= 0.0 && vB.y >= 0.0 && vB.x <= uBed.x && vB.y <= uBed.y;
  vec3 base;
  if (on) {
    float fw = max(fwidth(vB.x), fwidth(vB.y));
    float g = mix(vnoise(vB * 3.1) * 0.6 + vnoise(vB * 9.7) * 0.4, 0.5, smoothstep(0.08, 0.4, fw));
    base = uPlate * (1.0 - uGrit * 0.5 + uGrit * g);
    vec2 q = abs(fract(vB / 50.0 + 0.5) - 0.5) * 50.0;
    float line = 1.0 - smoothstep(0.0, max(0.25, fw * 1.2), min(q.x, q.y));
    base *= 1.0 - line * 0.06;
    float edge = min(min(vB.x, vB.y), min(uBed.x - vB.x, uBed.y - vB.y));
    base *= 0.82 + 0.18 * smoothstep(0.0, 3.0, edge);
  } else base = vec3(0.035, 0.036, 0.04);
  o = vec4(toSRGB(shade(base, vec3(0.0, 0.0, 1.0), vP, on ? 0.10 : 0.05, 0.0)), 1.0);
}`;

function program(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Print film shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Print film program: ' + gl.getProgramInfoLog(p));
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); const name = a.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, a.name); }
  return { p, u };
}

// bead cross-section: 8-sided ring at both ends plus end caps (fans)
function beadGeometry() {
  const S = 8, v = [], idx = [];
  for (const x of [0, 1]) for (let i = 0; i < S; i++) { const a = i / S * 2 * Math.PI; v.push(x, Math.cos(a), Math.sin(a), 0); }
  for (let i = 0; i < S; i++) { const j = (i + 1) % S; idx.push(i, S + i, S + j, i, S + j, j); }
  for (const [x, sgn] of [[0, -1], [1, 1]]) {
    const c = v.length / 4; v.push(x, 0, 0, sgn);
    for (let i = 0; i < S; i++) { const a = i / S * 2 * Math.PI; v.push(x, Math.cos(a), Math.sin(a), sgn); }
    for (let i = 0; i < S; i++) { const j = (i + 1) % S; if (sgn < 0) idx.push(c, c + 1 + j, c + 1 + i); else idx.push(c, c + 1 + i, c + 1 + j); }
  }
  return { v: new Float32Array(v), i: new Uint16Array(idx) };
}

// solid meshes (toolhead, gantry): flat-shaded boxes and cylinders with per-vertex colour
function meshBuilder() {
  const P = [], N = [], C = [];
  const tri = (a, b, c, n, col) => { P.push(...a, ...b, ...c); N.push(...n, ...n, ...n); C.push(...col, ...col, ...col); };
  const quad = (a, b, c, d, n, col) => { tri(a, b, c, n, col); tri(a, c, d, n, col); };
  return {
    box(x0, y0, z0, x1, y1, z1, col) {
      quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col);
      quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], col);
      quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col);
      quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], col);
      quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0], col);
      quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], col);
    },
    cyl(cx, cy, z0, z1, r0, r1, segs, col) {
      for (let i = 0; i < segs; i++) {
        const a = i / segs * 2 * Math.PI, b = (i + 1) / segs * 2 * Math.PI, m = (a + b) / 2;
        const p = (r, t, z) => [cx + r * Math.cos(t), cy + r * Math.sin(t), z];
        const slope = (r0 - r1) / Math.max(1e-6, z1 - z0);
        const n = [Math.cos(m), Math.sin(m), slope]; const l = Math.hypot(...n);
        quad(p(r0, a, z0), p(r0, b, z0), p(r1, b, z1), p(r1, a, z1), n.map(x => x / l), col);
        tri([cx, cy, z1], p(r1, a, z1), p(r1, b, z1), [0, 0, 1], col);
      }
    },
    done() { return { p: new Float32Array(P), n: new Float32Array(N), c: new Float32Array(C), count: P.length / 3 }; },
  };
}
const srgbLin = c => hexRgb(c).map(lin);
function toolheadMesh() {
  const m = meshBuilder();
  const brass = srgbLin('#C9A04E'), shell = srgbLin('#D9DADC'), dark = srgbLin('#2B2C30'), alu = srgbLin('#A9AEB5'), orange = srgbLin('#E0662F');
  m.cyl(0, 0, 0, 2.4, 0.45, 2.3, 16, brass);
  m.cyl(0, 0, 2.4, 5.2, 3.6, 3.6, 6, brass);
  m.box(-8, -7, 5.2, 8, 9, 12.5, alu);
  m.box(-21, -14, 16, 21, 24, 62, shell);
  m.box(-21.4, -14.5, 34, 21.4, -14, 44, dark);            // front visor
  m.box(-6, -14.8, 50, 6, -14.3, 52, orange);              // status light
  m.box(12, -8, 9, 20, 12, 16.5, shell);                  // part-cooling duct (to the side)
  m.box(-20, -8, 9, -12, 12, 16.5, shell);
  return m.done();
}
function unitBox(col) { const m = meshBuilder(); m.box(0, 0, 0, 1, 1, 1, srgbLin(col)); return m.done(); }

// ------------------------------------------------------------------------------ the film
/**
 * @param tp    Toolpath (buildToolpath or parseGcode)
 * @param opts  { camera: 'orbit'|'printer', seconds, fps, colors: { backdrop }, title, subtitle, canvas }
 */
export function createPrintFilm(tp, opts = {}) {
  const canvas = opts.canvas || document.createElement('canvas');
  canvas.width = canvas.width || 640; canvas.height = canvas.height || 640;
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw Object.assign(new Error('This browser has no WebGL2, which the print timelapse needs'), { code: 'unsupported' });
  const beadP = program(gl, BEAD_VS, BEAD_FS), solidP = program(gl, SOLID_VS, SOLID_FS), plateP = program(gl, PLATE_VS, PLATE_FS);
  const printer = tp.printer || PRINTERS.a2l;
  const bed = [printer.bed[0], printer.bed[1]];
  const palette = tp.palette.slice(0, 8);
  const palLin = new Float32Array(24); palette.forEach((c, i) => palLin.set(srgbLin(c), i * 3));
  const backdrop = pickBackdrop(opts.colors?.backdrop, palette);
  const bdLin = hexRgb(backdrop.color);
  // plate: textured gold PEI unless the first layer is gold-ish, then the dark smooth plate
  const firstCol = palette[tp.beads.c[0] ?? 0] || palette[0];
  const plateHex = contrastRatio(firstCol, '#B8995A') >= 1.45 ? '#B8995A' : '#303134';
  const plateLin = srgbLin(plateHex);

  // --- beads (one interleaved instance buffer: p0 3, p1 3, t 2, meta 3 = 11 floats)
  const nb = tp.beads.n, inst = new Float32Array(Math.max(1, nb) * 11);
  for (let i = 0; i < nb; i++) {
    const o = i * 11, p = tp.beads.p;
    inst[o] = p[6 * i]; inst[o + 1] = p[6 * i + 1]; inst[o + 2] = p[6 * i + 2];
    inst[o + 3] = p[6 * i + 3]; inst[o + 4] = p[6 * i + 4]; inst[o + 5] = p[6 * i + 5];
    inst[o + 6] = tp.beads.t[2 * i]; inst[o + 7] = tp.beads.t[2 * i + 1];
    inst[o + 8] = Math.min(7, tp.beads.c[i]); inst[o + 9] = tp.beads.k[i]; inst[o + 10] = tp.beads.l[i];
  }
  const geo = beadGeometry();
  const beadVao = gl.createVertexArray(); gl.bindVertexArray(beadVao);
  const gb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, gb); gl.bufferData(gl.ARRAY_BUFFER, geo.v, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
  const attr = (loc, size, off) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 44, off * 4); gl.vertexAttribDivisor(loc, 1); };
  attr(1, 3, 0); attr(2, 3, 3); attr(3, 2, 6); attr(4, 3, 8);
  const eb = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.i, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const beadT0 = new Float32Array(nb); for (let i = 0; i < nb; i++) beadT0[i] = tp.beads.t[2 * i];
  // beads are in time order for our toolpaths; a G-code's are too (file order)
  const beadsBefore = t => { let lo = 0, hi = nb; while (lo < hi) { const m = (lo + hi) >> 1; if (beadT0[m] <= t) lo = m + 1; else hi = m; } return lo; };

  const solidVao = mesh => {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    for (const [loc, arr] of [[0, mesh.p], [1, mesh.n], [2, mesh.c]]) {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    return { vao, count: mesh.count };
  };
  const head = solidVao(toolheadMesh()), rail = solidVao(unitBox('#5E636B')), yrail = solidVao(unitBox('#3B3E44'));
  const plateVao = gl.createVertexArray(); gl.bindVertexArray(plateVao);
  const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // --- timeline
  const seconds = opts.seconds || 15, fps = opts.fps || 30;
  const map = filmTimeMap(tp, { seconds, fps });
  const box = tp.box, C = [(box.lo[0] + box.hi[0]) / 2, (box.lo[1] + box.hi[1]) / 2, (box.lo[2] + box.hi[2]) / 2];
  const ext = [box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]];
  const R = Math.max(20, 0.5 * Math.hypot(...ext));
  const tall = ext[2] > 0.45 * Math.max(ext[0], ext[1]);
  const zTop = box.hi[2];
  const start = [bed[0] / 2, bed[1] / 2, (tp.zBase || 0) + 8];
  const H = tp.layerMm || 0.2, HW = (tp.lineMm || 0.42) * 0.56;
  let camera = opts.camera === 'printer' ? 'printer' : 'orbit';

  function stateAt(i) {
    const a = map.at(i);
    const prev = map.at(Math.max(0, i - 1)), next = map.at(Math.min(map.frames - 1, i + 1));
    const perFrame = Math.max(0, (next.t - prev.t) / 2);                 // print seconds per film frame
    const t = a.t;
    const noz = a.phase === 'intro' ? start : nozzleAt(tp, t, start);
    const layer = a.phase === 'intro' ? 0 : a.phase === 'outro' ? tp.layers.length - 1 : layerAt(tp, t);
    return { ...a, i, perFrame, noz, layer, film: (i + 0.5) / fps };
  }

  function render(st, W, H2) {
    if (canvas.width !== W || canvas.height !== H2) { canvas.width = W; canvas.height = H2; }
    gl.viewport(0, 0, W, H2);
    gl.clearColor(...bdLin.map(lin).map(v => Math.pow(v / (1 + v * 0.15), 1 / 2.2)), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    // who moves: a bedslinger slides the bed in Y while the print is slow enough to follow; once
    // the film runs fast the bed settles (like a smooth timelapse) and the head moves instead.
    const [nx, ny, nz] = st.noz;
    const settle = st.phase === 'outro' ? 1 : smooth(2.5, 9, st.perFrame);   // the finished part rests in frame
    let bedOff = [0, 0, 0], headW = [nx, ny, nz];
    if (printer.kin === 'bedslinger') {
      // the X gantry never moves in Y on a bed slinger: slow, the bed slides under the head; fast,
      // it parks like Bambu's smooth timelapse (the bed forward, the part clear of the gantry, the
      // head at the left purge chute) and each layer appears between two parked frames
      const parkDy = C[1] + 13 - box.hi[1];
      const dy = mix(C[1] - ny, parkDy, settle);
      bedOff = [0, dy, 0];
      headW = [mix(nx, -32, settle), C[1], mix(nz, Math.max(nz, zTop) + 4, settle)];
    } else {
      const layerZ = tp.layers[st.layer]?.z ?? nz;
      const dz = (zTop - layerZ) * 0.999;
      bedOff = [0, 0, dz]; headW = [nx, ny, nz + dz];
    }
    // camera
    const aspect = W / H2, fovy = 30 * DEG, fovx = 2 * Math.atan(Math.tan(fovy / 2) * aspect);
    const fit = R / Math.sin(Math.min(fovy, fovx) / 2);
    let eye, target;
    if (camera === 'orbit') {
      const u = st.film / map.D;
      const yaw = (-32 + 46 * u + (st.phase === 'outro' ? 40 * smooth(0, 1, st.u) : 0)) * DEG;
      const zoomT = smooth(0, 1, (st.film - map.intro * 0.5) / (map.intro + map.P * 0.35));
      // a low nozzle-cam at the start (under the toolhead's shell), rising as it pulls back
      const pitch = mix(tall ? 12 : 17, tall ? 15 : 36, zoomT) * DEG;
      const k = mix(tall ? 0.6 : 0.5, 0.92, zoomT);
      const nb = [nx, ny, Math.max(nz, 0.5)];
      const tgt = [mix(nb[0], C[0], zoomT), mix(nb[1], C[1], zoomT), mix(nb[2] + 2, C[2], zoomT)];
      target = [tgt[0] + bedOff[0], tgt[1] + bedOff[1], tgt[2] + bedOff[2]];
      const d = fit * k;
      eye = [target[0] + d * Math.cos(pitch) * Math.sin(yaw), target[1] - d * Math.cos(pitch) * Math.cos(yaw), target[2] + d * Math.sin(pitch)];
    } else {
      const yaw = -38 * DEG, pitch = (tall ? 14 : 30) * DEG;
      target = [C[0], C[1], printer.kin === 'bedslinger' ? C[2] : zTop * 0.5];
      const d = fit * (printer.kin === 'bedslinger' ? 1.22 : 1.12);
      eye = [target[0] + d * Math.cos(pitch) * Math.sin(yaw), target[1] - d * Math.cos(pitch) * Math.cos(yaw), target[2] + d * Math.sin(pitch)];
    }
    const dist = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
    const VP = mul(perspective(fovy, aspect, Math.max(0.5, dist * 0.02), dist * 8 + 1200), lookAt(eye, target, [0, 0, 1]));
    const key = (() => { const k = [-0.45, -0.55, 0.75]; const l = Math.hypot(...k); return k.map(x => x / l); })();
    const common = pr => {
      gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uVP, false, VP);
      gl.uniform3fv(pr.u.uEye, eye); gl.uniform3fv(pr.u.uKey, key);
    };
    // plate
    common(plateP);
    gl.uniform3fv(plateP.u.uBedOff, bedOff); gl.uniform2fv(plateP.u.uBed, bed);
    gl.uniform3fv(plateP.u.uPlate, plateLin); gl.uniform1f(plateP.u.uGrit, plateHex === '#B8995A' ? 0.22 : 0.1);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(plateVao); gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.CULL_FACE);
    // beads
    const count = st.phase === 'intro' ? 0 : beadsBefore(st.t + 1e-6);
    if (count) {
      common(beadP);
      gl.uniform1f(beadP.u.uTime, st.t + 1e-6); gl.uniform1f(beadP.u.uLayer, st.phase === 'outro' ? -9 : st.layer);
      gl.uniform1f(beadP.u.uHW, HW); gl.uniform1f(beadP.u.uHH, H * 0.5);
      gl.uniform3fv(beadP.u.uBedOff, bedOff); gl.uniform3fv(beadP.u.uPal, palLin);
      gl.bindVertexArray(beadVao);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1);
      gl.drawElementsInstanced(gl.TRIANGLES, geo.i.length, gl.UNSIGNED_SHORT, 0, count);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    // toolhead, X gantry (and the Y rail under a bedslinger's bed)
    common(solidP);
    gl.uniform3fv(solidP.u.uOff, headW); gl.uniform3fv(solidP.u.uScale, [1, 1, 1]);
    gl.bindVertexArray(head.vao); gl.drawArrays(gl.TRIANGLES, 0, head.count);
    const railZ = headW[2] + 30;
    // (parked, a bed slinger's gantry is lifted out of the shot, as in a smooth timelapse where the
    // camera sees the part between layers; it never sweeps across the part in Y)
    if (printer.kin !== 'bedslinger' || settle < 0.5) {
      gl.uniform3fv(solidP.u.uOff, [-45, headW[1] + 24, railZ + (printer.kin === 'bedslinger' ? 400 * smooth(0.2, 0.5, settle) : 0)]); gl.uniform3fv(solidP.u.uScale, [bed[0] + 90, 12, 18]);
      gl.bindVertexArray(rail.vao); gl.drawArrays(gl.TRIANGLES, 0, rail.count);
    }
    if (printer.kin === 'bedslinger') {
      gl.uniform3fv(solidP.u.uOff, [bed[0] / 2 - 30, -60, -26]); gl.uniform3fv(solidP.u.uScale, [60, bed[1] + 120, 14]);
      gl.bindVertexArray(yrail.vao); gl.drawArrays(gl.TRIANGLES, 0, yrail.count);
    }
    gl.bindVertexArray(null);
    return { eye, target, bedOff, headW, count };
  }

  const info = {
    total: tp.total, layers: tp.layers.length, palette, backdrop: backdrop.color, backdropAdjusted: backdrop.adjusted,
    plate: plateHex, printer: printer.name, kin: printer.kin, changes: tp.changes, seconds, fps, frames: map.frames,
  };
  const film = {
    canvas, map, info, tp,
    get frames() { return map.frames; },
    get camera() { return camera; },
    set camera(v) { camera = v === 'printer' ? 'printer' : 'orbit'; },
    state: stateAt,
    /** Paint frame i into a 2D context of W x H (GL render + HUD). */
    draw(i, ctx, W = ctx.canvas.width, H2 = ctx.canvas.height, { scale = 1 } = {}) {
      const st = stateAt(Math.min(map.frames - 1, Math.max(0, i)));
      const rw = Math.max(2, Math.round(W * scale)), rh = Math.max(2, Math.round(H2 * scale));
      const r = render(st, rw, rh);
      ctx.drawImage(canvas, 0, 0, rw, rh, 0, 0, W, H2);
      drawHud(ctx, W, H2, st, tp, info, opts);
      return { ...st, ...r };
    },
    dispose() { const ext = gl.getExtension('WEBGL_lose_context'); ext?.loseContext(); },
  };
  return film;
}

// ------------------------------------------------------------------------------ HUD
function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
const SANS = 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const fmtMm = v => (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1));

function drawHud(g, W, H, st, tp, info, opts) {
  const s = Math.min(W, H) / 1080, pad = Math.round(44 * s);
  const story = H / W > 1.5;
  g.save();
  // soft vignette keeps the corners calm on any backdrop
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  // title (top left) in a pill
  const title = opts.title || 'Print timelapse', sub = opts.subtitle || `${info.printer} · ${tp.filament?.name || 'PETG'}`;
  g.font = `600 ${Math.round(30 * s)}px ${SANS}`;
  const tw = Math.max(g.measureText(title).width, (g.font = `400 ${Math.round(22 * s)}px ${SANS}`, g.measureText(sub).width));
  const top = story ? Math.round(H * 0.06) : pad;
  g.fillStyle = 'rgba(18,18,20,0.58)'; rrect(g, pad, top, tw + 40 * s, 86 * s, 16 * s); g.fill();
  g.fillStyle = '#fff'; g.font = `600 ${Math.round(30 * s)}px ${SANS}`; g.textBaseline = 'alphabetic';
  g.fillText(title, pad + 20 * s, top + 38 * s);
  g.fillStyle = 'rgba(255,255,255,0.72)'; g.font = `400 ${Math.round(22 * s)}px ${SANS}`;
  g.fillText(sub, pad + 20 * s, top + 70 * s);

  // counter panel (bottom left; above the bottom fifth of a story, where apps put their UI)
  const pw = Math.min(W - 2 * pad, 620 * s), ph = 150 * s;
  const px = pad, py = story ? H * 0.78 - ph : H - pad - ph;
  g.fillStyle = 'rgba(18,18,20,0.66)'; rrect(g, px, py, pw, ph, 18 * s); g.fill();
  const L = tp.layers.length, li = Math.min(L - 1, st.layer);
  const z = st.phase === 'intro' ? 0 : (tp.layers[li]?.z ?? 0);
  const t = Math.min(tp.total, st.t);
  g.fillStyle = '#fff'; g.font = `600 ${Math.round(40 * s)}px ${SANS}`;
  const layerTxt = st.phase === 'intro' ? `Layer 0 / ${L}` : `Layer ${li + 1} / ${L}`;
  g.fillText(layerTxt, px + 24 * s, py + 54 * s);
  const lw = g.measureText(layerTxt).width;
  g.font = `500 ${Math.round(28 * s)}px ${SANS}`; g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillText(`Z ${z.toFixed(2)} mm`, px + 24 * s + lw + 24 * s, py + 54 * s);
  g.font = `500 ${Math.round(26 * s)}px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace`;
  g.fillStyle = '#fff';
  g.fillText(`${clock(t)}  of  ${clock(tp.total)}`, px + 24 * s, py + 96 * s);
  // progress bar
  const bx = px + 24 * s, by = py + 118 * s, bw = pw - 48 * s, bh = 8 * s;
  g.fillStyle = 'rgba(255,255,255,0.18)'; rrect(g, bx, by, bw, bh, bh / 2); g.fill();
  g.fillStyle = '#FF7A4D'; rrect(g, bx, by, Math.max(bh, bw * Math.min(1, t / tp.total)), bh, bh / 2); g.fill();
  // filament chips (top right of the panel)
  const chips = info.palette;
  const cur = st.phase === 'intro' ? 0 : tp.beads.c[Math.max(0, Math.min(tp.beads.n - 1, lastBead(tp, st.t)))] ?? 0;
  for (let k = 0; k < chips.length; k++) {
    const cx = px + pw - 36 * s - (chips.length - 1 - k) * 40 * s, cy = py + 42 * s, r = 13 * s;
    g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.fillStyle = chips[k]; g.fill();
    g.lineWidth = 2 * s; g.strokeStyle = k === cur ? '#fff' : 'rgba(255,255,255,0.35)'; g.stroke();
    if (k === cur) { g.beginPath(); g.arc(cx, cy, r + 5 * s, 0, 2 * Math.PI); g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1.5 * s; g.stroke(); }
  }

  // banners
  let banner = null, sub2 = null;
  if (st.phase === 'intro') { banner = `Heating · nozzle ${tp.filament?.nozzleC || 255} °C · bed ${tp.filament?.bedC || 70} °C`; }
  else if (st.phase === 'change' || (st.phase === 'print' && inChange(tp, st.t))) {
    const c = tp.changes.find(c => st.t >= c.t0 && st.t <= c.t1) || tp.changes[0];
    banner = { from: c.from, to: c.to, text: 'Filament change', note: `${formatDuration(c.t1 - c.t0, { seconds: true })} pause at Z ${c.z.toFixed(1)} mm` };
  } else if (st.phase === 'outro') {
    banner = `Done in ${formatDuration(tp.total)}`;
    const b = tp.box;
    sub2 = `X 0-${fmtMm(b.hi[0] - b.lo[0])} · Y 0-${fmtMm(b.hi[1] - b.lo[1])} · Z 0-${fmtMm(b.hi[2] - b.lo[2])} mm` + (tp.stats?.grams ? ` · ${tp.stats.grams.toFixed(0)} g` : '');
  }
  if (banner) {
    const by2 = story ? H * 0.16 : top + 110 * s;
    g.font = `600 ${Math.round(30 * s)}px ${SANS}`;
    const text = typeof banner === 'string' ? banner : banner.text;
    const noteTxt = typeof banner === 'string' ? sub2 : banner.note;
    let w = g.measureText(text).width + (typeof banner === 'string' ? 0 : 110 * s);
    g.font = `400 ${Math.round(22 * s)}px ${SANS}`;
    if (noteTxt) w = Math.max(w, g.measureText(noteTxt).width);
    const bw2 = w + 48 * s, bh2 = noteTxt ? 92 * s : 60 * s, bx2 = (W - bw2) / 2;
    g.fillStyle = 'rgba(18,18,20,0.7)'; rrect(g, bx2, by2, bw2, bh2, bh2 / 2.6); g.fill();
    g.fillStyle = '#fff'; g.font = `600 ${Math.round(30 * s)}px ${SANS}`; g.textAlign = 'center';
    if (typeof banner === 'string') g.fillText(text, W / 2, by2 + 40 * s);
    else {
      const tw2 = g.measureText(text).width, x0 = W / 2 - (tw2 + 110 * s) / 2;
      g.textAlign = 'left'; g.fillText(text, x0, by2 + 40 * s);
      const chip = (x, col) => { g.beginPath(); g.arc(x, by2 + 30 * s, 12 * s, 0, 2 * Math.PI); g.fillStyle = col; g.fill(); g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2 * s; g.stroke(); };
      chip(x0 + tw2 + 26 * s, banner.from); g.fillStyle = '#fff'; g.fillText('→', x0 + tw2 + 44 * s, by2 + 40 * s); chip(x0 + tw2 + 96 * s, banner.to);
      g.textAlign = 'center';
    }
    if (noteTxt) { g.fillStyle = 'rgba(255,255,255,0.78)'; g.font = `400 ${Math.round(22 * s)}px ${SANS}`; g.fillText(noteTxt, W / 2, by2 + 74 * s); }
    g.textAlign = 'left';
  }
  // credit
  g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = `500 ${Math.round(20 * s)}px ${SANS}`; g.textAlign = 'right';
  g.fillText('Spiralist', W - pad, story ? H * 0.78 : H - pad);
  g.restore();
}
function lastBead(tp, t) { const T = tp.beads.t; let lo = 0, hi = tp.beads.n - 1; if (hi < 0) return 0; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[2 * m] <= t) lo = m; else hi = m - 1; } return lo; }
const inChange = (tp, t) => tp.changes.some(c => t >= c.t0 && t <= c.t1);

// ------------------------------------------------------------------------------ export
/** Encode the whole film as MP4 (WebCodecs, or the MediaRecorder fallback) with js/encoder.js. */
export async function renderPrintFilm(film, { width, height, signal, onProgress, bitrate } = {}) {
  const { encodeVideo } = await import('../encoder.js');
  return encodeVideo({
    width, height, fps: film.map.fps, frames: film.frames, signal, onProgress, bitrate,
    keyFrames: [Math.round((film.map.D - film.map.outro) * film.map.fps)],
    drawFrame: (i, ctx) => { film.draw(i, ctx, width, height); },
  });
}

// ------------------------------------------------------------------------------ dialog
const CSS = `
.ptl{border:0;padding:0;max-width:min(1100px,calc(100vw - 24px));width:100%;max-height:calc(100dvh - 24px);border-radius:16px;
  background:var(--surface,#fff);color:var(--text,#1c1b19);box-shadow:0 20px 60px -10px rgba(0,0,0,.45);font:14px/1.45 var(--sans,system-ui,sans-serif)}
.ptl::backdrop{background:rgba(10,10,12,.55)}
.ptl-wrap{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:0;max-height:calc(100dvh - 24px)}
.ptl-stage{background:#141416;display:flex;align-items:center;justify-content:center;min-height:320px;position:relative;border-radius:16px 0 0 16px;overflow:hidden}
.ptl-stage canvas{display:block;max-width:100%;max-height:calc(100dvh - 120px);width:auto;height:auto}
.ptl-busy{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#eee;background:rgba(20,20,22,.72);font-weight:500}
.ptl-busy[hidden]{display:none}
.ptl-bar{width:220px;height:6px;border-radius:3px;background:rgba(255,255,255,.2);overflow:hidden}.ptl-bar i{display:block;height:100%;width:0;background:#ff7a4d}
.ptl-side{padding:18px 18px 16px;overflow:auto;display:flex;flex-direction:column;gap:14px}
.ptl-side h2{margin:0;font:600 18px/1.3 var(--sans,system-ui)}
.ptl-side p{margin:0;color:var(--text-muted,#6e6a63)}
.ptl-row{display:flex;flex-direction:column;gap:6px}
.ptl-row>span{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--text-muted,#6e6a63);text-transform:uppercase}
.ptl-seg{display:flex;flex-wrap:wrap;gap:6px}
.ptl-seg button,.ptl-btn{font:inherit;border:1px solid var(--border-strong,rgba(0,0,0,.18));background:var(--surface,#fff);color:inherit;border-radius:8px;padding:6px 10px;cursor:pointer}
.ptl-seg button[aria-pressed=true]{background:var(--text,#1c1b19);color:var(--surface,#fff);border-color:transparent}
.ptl-btn.primary{background:var(--accent,#c43d16);color:var(--accent-ink,#fff);border-color:transparent;font-weight:600}
.ptl-btn:disabled{opacity:.5;cursor:default}
.ptl-play{display:flex;gap:8px;align-items:center}
.ptl-play input{flex:1}
.ptl-printer{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--border-strong,rgba(0,0,0,.18));background:var(--surface,#fff);color:inherit}
.ptl-drop{border:1.5px dashed var(--border-strong,rgba(0,0,0,.2));border-radius:10px;padding:10px;text-align:center;color:var(--text-muted,#6e6a63);cursor:pointer}
.ptl-drop.over{border-color:var(--accent,#c43d16);color:var(--accent,#c43d16)}
.ptl-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:auto}
.ptl-note{font-size:12.5px}
.ptl-note.warn{color:#e8a33c;font-weight:600}
.ptl-close{position:absolute;top:10px;right:10px;z-index:2;background:rgba(20,20,22,.6);color:#fff;border:0;border-radius:50%;width:34px;height:34px;font-size:20px;line-height:34px;cursor:pointer}
@media (max-width:760px){.ptl{overflow:auto}.ptl-wrap{grid-template-columns:1fr;max-height:none}.ptl-stage{border-radius:16px 16px 0 0;min-height:240px}.ptl-stage canvas{max-height:52dvh}}
`;

/**
 * Open the print timelapse dialog. Contract used by the print dialog:
 *   openPrintTimelapse({ parts, colors, printer, product, art }) -> { close }
 */
export function openPrintTimelapse({ parts, colors = {}, printer, product, art, filament, camera = 'orbit', seconds = 15, fps = 30, format = 'square', changeMode, notes = [], onToolpath } = {}) {
  // reduced motion: start paused on the fixed printer cam; Play starts it
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) camera = 'printer';
  if (!document.getElementById('ptl-style')) {
    const st = document.createElement('style'); st.id = 'ptl-style'; st.textContent = CSS; document.head.appendChild(st);
  }
  const prod = typeof product === 'string' ? { id: product } : (product || {});
  const productName = prod.product?.name || prod.name || ({ plaque: 'Relief plaque', wire: 'Wire sculpture', litho: 'Lithophane', cutter: 'Cookie cutter + stamp' })[prod.id] || 'Your print';
  const artTitle = typeof art === 'string' ? art : art?.title || art?.label || '';
  let pr = resolvePrinter(printer);
  const fil = (filament || (/pla/i.test(prod.settings?.filament || '') ? 'pla' : 'petg')).toLowerCase();
  const S = { camera, seconds, fps, format, tp: null, film: null, gcode: null, playing: !still, frame: 0, result: null, abort: null, worker: null };

  const dlg = document.createElement('dialog');
  dlg.className = 'ptl';
  dlg.setAttribute('aria-label', 'Print timelapse');
  dlg.innerHTML = `
  <div class="ptl-wrap">
    <div class="ptl-stage">
      <button class="ptl-close" type="button" aria-label="Close">×</button>
      <canvas class="ptl-view" role="img" aria-label="Preview of the print timelapse"></canvas>
      <div class="ptl-busy"><span class="ptl-busy-txt">Slicing…</span><div class="ptl-bar"><i></i></div></div>
    </div>
    <div class="ptl-side">
      <div><h2>Print timelapse</h2><p class="ptl-sum">${productName}${artTitle ? ' · ' + artTitle : ''}</p></div>
      <div class="ptl-play"><button class="ptl-btn ptl-pp" type="button" aria-label="${still ? 'Play' : 'Pause'}">${still ? '▶' : '❚❚'}</button><input class="ptl-scrub" type="range" min="0" max="1000" value="0" aria-label="Scrub" style="--fill:0%"></div>
      <div class="ptl-row"><span>Printer</span><select class="ptl-printer" aria-label="Printer">${PRESETS.map(p => `<option value="${p.id}">${p.name} (${p.kinematics === 'corexy' ? 'CoreXY' : 'bed slinger'})</option>`).join('')}</select></div>
      <div class="ptl-row"><span>Camera</span><div class="ptl-seg" data-k="camera"><button data-v="orbit">Slow orbit</button><button data-v="printer">Printer cam</button></div></div>
      <div class="ptl-row"><span>Format</span><div class="ptl-seg" data-k="format"><button data-v="story">9:16</button><button data-v="square">1:1</button><button data-v="wide">16:9</button></div></div>
      <div class="ptl-row"><span>Length</span><div class="ptl-seg" data-k="seconds"><button data-v="10">10 s</button><button data-v="15">15 s</button><button data-v="30">30 s</button></div></div>
      <div class="ptl-row"><span>Frame rate</span><div class="ptl-seg" data-k="fps"><button data-v="30">30 fps</button><button data-v="60">60 fps</button></div></div>
      <p class="ptl-note ptl-info"></p>
      <label class="ptl-drop" tabindex="0">Replay your own sliced file: drop a .gcode or .gcode.3mf here<input type="file" accept=".gcode,.3mf,.gco,.g" hidden></label>
      <div class="ptl-actions">
        <button class="ptl-btn primary ptl-export" type="button">Export MP4</button>
        <button class="ptl-btn ptl-dl" type="button" hidden>Download</button>
        <button class="ptl-btn ptl-x" type="button" hidden>Post on X</button>
      </div>
      <p class="ptl-note ptl-status" role="status"></p>
    </div>
  </div>`;
  document.body.appendChild(dlg);
  const $ = sel => dlg.querySelector(sel);
  const view = $('.ptl-view'), vctx = view.getContext('2d');
  const busy = $('.ptl-busy'), busyTxt = $('.ptl-busy-txt'), busyBar = $('.ptl-bar i');
  const status = txt => { $('.ptl-status').textContent = txt || ''; };
  const glCanvas = document.createElement('canvas');
  let raf = 0, closed = false, lastT = 0, acc = 0;

  const syncSeg = () => dlg.querySelectorAll('.ptl-seg').forEach(seg => seg.querySelectorAll('button').forEach(b => {
    b.type = 'button'; b.setAttribute('aria-pressed', String(String(S[seg.dataset.k]) === b.dataset.v));
  }));
  syncSeg();
  const sel = $('.ptl-printer');
  if (!PRESETS.some(p => p.id === pr.id)) sel.insertAdjacentHTML('afterbegin', `<option value="${pr.id}">${pr.name} (${pr.kin === 'corexy' ? 'CoreXY' : 'bed slinger'})</option>`);
  const given = pr;
  sel.value = pr.id;
  sel.addEventListener('change', () => {
    if (S.abort) { sel.value = pr.id; return; }
    pr = sel.value === given.id ? given : resolvePrinter(PRESETS.find(p => p.id === sel.value) || sel.value); clearResult(); S.gcode = null; build();
  });

  function sizeView() {
    const f = FILM_FORMATS[S.format];
    const stage = $('.ptl-stage').getBoundingClientRect();
    const maxW = Math.max(200, stage.width - 24), maxH = Math.max(200, Math.min(window.innerHeight - 120, (window.innerWidth <= 760 ? window.innerHeight * 0.52 : 900)));
    const k = Math.min(maxW / f.w, maxH / f.h);
    const cw = Math.round(f.w * k), ch = Math.round(f.h * k), dpr = Math.min(2, window.devicePixelRatio || 1);
    view.style.width = cw + 'px'; view.style.height = ch + 'px';
    view.width = Math.round(cw * dpr) & ~1; view.height = Math.round(ch * dpr) & ~1;
  }
  function info() {
    const tp = S.tp; if (!tp) return;
    const b = tp.box, fi = S.film?.info;
    const lines = [`${tp.layers.length} layers · about ${formatDuration(tp.total)} on a ${pr.name}${S.gcode ? ` (from ${S.gcode})` : ''}.`,
      `Size X 0-${fmtMm(b.hi[0] - b.lo[0])}, Y 0-${fmtMm(b.hi[1] - b.lo[1])}, Z 0-${fmtMm(b.hi[2] - b.lo[2])} mm.`];
    if (tp.changes.length === 1) lines.push(`One filament change at Z ${tp.changes[0].z.toFixed(1)} mm.`);
    else if (tp.changes.length > 1) lines.push(`${tp.changes.length} filament changes (one per colour swap).`);
    else if (tp.palette.length === 1 && prod.id === 'litho') lines.push('Lithophanes print in one colour: white lets the light through.');
    if (fi?.backdropAdjusted) lines.push('The backdrop was changed so the part stays visible against it.');
    if (!S.gcode) for (const n of notes) lines.push(n);
    const bx = tp.printer?.bed || pr.bed;
    if (b.hi[0] - b.lo[0] > bx[0] || b.hi[1] - b.lo[1] > bx[1] || b.hi[2] - b.lo[2] > bx[2]) {
      lines.push(`It does not fit this printer's plate (X 0-${bx[0]}, Y 0-${bx[1]}, Z 0-${bx[2]} mm): pick a bigger printer or a smaller size.`);
    }
    $('.ptl-info').textContent = lines.join(' ');
    $('.ptl-info').classList.toggle('warn', !S.gcode && notes.some(n => /^Colour warning/.test(n)));
  }
  function makeFilm() {
    S.film?.dispose?.();
    S.film = null;
    if (!S.tp) return;
    const title = productName, sub = `${pr.name} · ${S.tp.filament?.name || FILAMENTS[fil]?.name || 'PETG'}${artTitle ? ' · ' + artTitle : ''}`;
    S.film = createPrintFilm(S.tp, { camera: S.camera, seconds: S.seconds, fps: S.fps, colors, title, subtitle: sub, canvas: glCanvas.cloneNode() });
    S.frame = Math.min(S.frame, S.film.frames - 1);
    info();
  }
  function paint() {
    if (!S.film) return;
    const f = S.film, a = performance.now();
    f.draw(S.frame, vctx, view.width, view.height);
    S.paints = (S.paints || 0) + 1; S.paintMs = (S.paintMs || 0) + performance.now() - a;   // preview cost (lab / tests)
    const v = Math.round(S.frame / Math.max(1, f.frames - 1) * 1000);
    $('.ptl-scrub').value = String(v); $('.ptl-scrub').style.setProperty('--fill', `${v / 10}%`);   // the app's range fill
  }
  function loop(now) {
    if (closed) return;
    raf = requestAnimationFrame(loop);
    if (!S.film || S.abort) return;
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0; lastT = now;
    if (S.playing) { acc += dt * S.film.map.fps; const step = Math.floor(acc); if (step) { acc -= step; S.frame = (S.frame + step) % S.film.frames; } }
    paint();
  }
  async function build() {
    busy.hidden = false; busyTxt.textContent = 'Slicing the print…'; busyBar.style.width = '0%';
    try {
      const onProgress = f => { busyBar.style.width = `${Math.round(f * 100)}%`; busyTxt.textContent = `Slicing layer by layer… ${Math.round(f * 100)}%`; };
      const opts = { printer: pr, filament: fil, settings: prod.settings, colors, ...(changeMode ? { changeMode } : {}) };
      const tp = await sliceOffThread(parts, opts, onProgress).catch(e => e?.code === 'noworker' ? buildToolpath(parts, { ...opts, onProgress }) : Promise.reject(e));
      if (closed || !tp) return;
      S.tp = tp;
      makeFilm();
      busy.hidden = true;
      try { onToolpath?.(tp); } catch { /* the caller's problem */ }
    } catch (e) {
      busyTxt.textContent = 'Could not slice this print: ' + (e.message || e);
    }
  }
  // one worker per slice; a new slice (another printer) or closing the film stops the old one
  function sliceOffThread(list, opts, onProgress) {
    S.worker?.terminate(); S.worker = null;
    let w;
    try { w = new Worker(new URL('./toolpath.worker.js', import.meta.url), { type: 'module' }); }
    catch { return Promise.reject(Object.assign(new Error('no worker'), { code: 'noworker' })); }
    S.worker = w;
    const slim = list.map(p => ({ name: p.name, color: p.color, mesh: { positions: p.mesh.positions, indices: p.mesh.indices } }));
    return new Promise((resolve, reject) => {
      w.onmessage = e => {
        const d = e.data || {};
        if (d.progress != null) { onProgress(d.progress); return; }
        w.terminate(); if (S.worker === w) S.worker = null;
        if (d.tp) resolve(d.tp); else reject(new Error(d.error || 'slicing failed'));
      };
      w.onerror = e => { e.preventDefault?.(); w.terminate(); if (S.worker === w) S.worker = null; reject(Object.assign(new Error(e.message || 'worker failed'), { code: 'noworker' })); };
      try { w.postMessage({ parts: slim, opts }); } catch (err) { w.terminate(); S.worker = null; reject(Object.assign(err, { code: 'noworker' })); }
    });
  }
  dlg.querySelectorAll('.ptl-seg').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || S.abort) return;
    const k = seg.dataset.k, v = b.dataset.v;
    S[k] = k === 'seconds' || k === 'fps' ? +v : v;
    syncSeg();
    clearResult();
    if (k === 'format') sizeView();
    if (k === 'camera' && S.film) S.film.camera = S.camera; else makeFilm();
    paint();
  }));
  $('.ptl-pp').addEventListener('click', () => {
    S.playing = !S.playing; $('.ptl-pp').textContent = S.playing ? '❚❚' : '▶'; $('.ptl-pp').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  });
  $('.ptl-scrub').addEventListener('input', e => {
    if (!S.film) return; S.playing = false; $('.ptl-pp').textContent = '▶';
    S.frame = Math.round(+e.target.value / 1000 * (S.film.frames - 1)); paint();
  });
  // G-code replay
  const drop = $('.ptl-drop'), fileIn = drop.querySelector('input');
  const takeFile = async file => {
    if (!file) return;
    busy.hidden = false; busyTxt.textContent = `Reading ${file.name}…`; busyBar.style.width = '30%';
    try {
      const [{ parseGcode, readGcodeFile }] = await Promise.all([import('./gcode.js')]);
      const { text } = await readGcodeFile(file);
      busyBar.style.width = '70%';
      await new Promise(r => setTimeout(r, 20));
      const tp = parseGcode(text, {});
      if (!tp.beads.n) throw new Error('no extrusion moves');
      S.tp = tp; S.gcode = file.name; clearResult(); makeFilm();
      busy.hidden = true;
      status(`Replaying ${file.name}: ${tp.layers.length} layers, ${tp.meta.slicer}${tp.meta.estimate ? `, slicer estimate ${formatDuration(tp.meta.estimate)}` : ''}.`);
    } catch (e) {
      busy.hidden = true; status(`That file could not be replayed: ${e.message || e}`);
    }
  };
  fileIn.addEventListener('change', () => takeFile(fileIn.files[0]));
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
  for (const ev of ['dragenter', 'dragover']) dlg.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); });
  dlg.addEventListener('dragleave', e => { if (e.target === dlg) drop.classList.remove('over'); });
  dlg.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer?.files?.[0]); });

  // export
  const fileName = () => `${art?.fileBase ? art.fileBase + '-' : 'spiralist-'}print-${prod.id || 'part'}-${FILM_FORMATS[S.format].name.replace(':', 'x')}-${S.seconds}s.mp4`;
  function clearResult() { S.result = null; $('.ptl-dl').hidden = true; $('.ptl-x').hidden = true; }
  $('.ptl-export').addEventListener('click', async () => {
    if (!S.film) return;
    if (S.abort) { S.abort.abort(); return; }
    const f = FILM_FORMATS[S.format];
    S.abort = new AbortController();
    $('.ptl-export').textContent = 'Stop';
    clearResult();
    const t0 = performance.now();
    try {
      const res = await renderPrintFilm(S.film, {
        width: f.w, height: f.h, signal: S.abort.signal,
        onProgress: (done, total, cv) => {
          status(`Filming… ${Math.round(done / total * 100)}% (frame ${done} of ${total})`);
          if (cv && done % 4 === 0) vctx.drawImage(cv, 0, 0, view.width, view.height);
        },
      });
      S.result = res;
      // load the share helpers now: Post on X must open X's tab synchronously inside its click
      S.mods = await Promise.all([import('../share.js'), import('../export.js')]).catch(() => null);
      status(`Your timelapse is ready: ${f.w} × ${f.h}, ${S.seconds} s at ${S.fps} fps, ${(res.blob.size / 1048576).toFixed(1)} MB (${((performance.now() - t0) / 1000).toFixed(0)} s to film).`);
      $('.ptl-dl').hidden = false; $('.ptl-x').hidden = false;
    } catch (e) {
      status(e.code === 'aborted' ? 'Filming stopped.' : `Filming failed: ${e.message || e}`);
    } finally {
      S.abort = null; $('.ptl-export').textContent = 'Export MP4'; lastT = 0;
    }
  });
  $('.ptl-dl').addEventListener('click', async () => {
    if (!S.result) return;
    const exp = S.mods?.[1] || await import('../export.js');
    exp.downloadBlob(S.result.blob, fileName());
  });
  $('.ptl-x').addEventListener('click', async () => {
    if (!S.result) return;
    const res = S.result;
    // shareToX opens X's tab synchronously inside this click, so nothing may be awaited before it
    const [share, exp] = S.mods || await Promise.all([import('../share.js'), import('../export.js')]);
    const out = await share.shareToX(() => res.blob, { filename: fileName(), kind: 'video', mime: res.mimeType, download: exp.downloadBlob, canShare: exp.canShareFiles });
    if (out === 'intent') status('Video saved. Attach it to your post on X.');
    else if (out === 'blocked' || out === 'saved') status('Video saved. Open X to post it.');
  });

  const close = () => {
    if (closed) return;
    closed = true; S.abort?.abort(); cancelAnimationFrame(raf); S.worker?.terminate(); S.worker = null;
    S.film?.dispose?.(); S.film = null; S.tp = null; if (dlg.open) dlg.close(); dlg.remove();   // (free the toolpath's arrays)
    window.removeEventListener('resize', onResize);
  };
  const onResize = () => { sizeView(); paint(); };
  window.addEventListener('resize', onResize);
  $('.ptl-close').addEventListener('click', close);
  dlg.addEventListener('cancel', e => { if (S.abort) { e.preventDefault(); S.abort.abort(); return; } e.preventDefault(); close(); });
  dlg.showModal();
  sizeView();
  raf = requestAnimationFrame(loop);
  build();
  return { close, get state() { return S; }, dialog: dlg };
}
