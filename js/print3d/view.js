// Product-photo viewer for 3D-print parts (WebGL2).
//
// Parts are { name, mesh: { positions: Float32Array xyz mm, indices?: Uint32Array }, color } in
// print coordinates: X and Y on the build plate, Z up, the part resting on Z = 0.
//
//   renderParts(canvas, parts, { yaw, pitch, light, bed: true })   one frame (viewer cached per canvas)
//   const v = createViewer(canvas, opts); v.setParts(parts); v.set({ yaw: 30 }); v.render();
//   attachOrbit(v)                    drag = orbit, wheel / pinch = zoom, double-click = reset
//   v.turntable(20)                   degrees per second (0 stops); any drag stops it
//   v.capture({ width, height })      -> canvas (2D) rendered off-screen, supersampled
//   v.captureTurntable({ frames: 8, width, height }) -> canvases around the piece
//   captureStill(parts, { width, height, ...opts }) -> Promise<Blob>, throwaway context
//
// Per part (besides name, mesh, color): material 'petg' | 'pla' | 'silk'; pose { rx, ry, rz, t }
// to display a part other than as printed (layer lines stay in print space); colorAbove
// { atMm, color } for a single-extruder filament change at a layer. Viewer option colorChange
// { atMm, color } applies that to every part (the "M600" version of a two-colour plaque).
//
// Look: soft key light with a penumbra-varying shadow (PCSS-lite), studio environment reflection,
// filament materials (petg: glossy, a little translucent; pla: matte; silk), 0.2 mm layer lines
// as bead-shaped normal ripples on walls and slopes plus 45 degree top-skin lines, contact
// occlusion from a top-down height map, and a bed: 'pei' (textured PEI plate with grid), 'desk'
// (oak), 'dark' (graphite studio), false (plain backdrop). backlit: true turns the bed into a dark
// room with a light panel under the part and shades parts by transmission through their
// thickness (lithophanes lying flat: thickness = z of the top surface).

const DEG = Math.PI / 180;

export const MATERIALS = {
  petg: { rough: 0.24, f0: 0.05, sss: 0.35, sheen: 0.0 },
  pla: { rough: 0.58, f0: 0.035, sss: 0.12, sheen: 0.0 },
  silk: { rough: 0.3, f0: 0.08, sss: 0.1, sheen: 0.6 },
};

export const BEDS = ['pei', 'desk', 'dark', false];

export const VIEW_DEFAULTS = Object.freeze({
  yaw: -28, pitch: 38, zoom: 1, fov: 30,
  light: { yaw: -55, pitch: 52, soft: 1, intensity: 1 },
  bed: 'pei', plate: [330, 320], material: 'petg', layer: 0.2, lines: 1,
  backlit: false, mu: 1.35, exposure: 1, background: null, target: null,
});

const DEFAULT_COLORS = ['#f1eee8', '#262629', '#c9462c', '#2f5d8a'];

// ---------------------------------------------------------------- small math

function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function ortho(l, r, b, t, n, f) {
  return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function lookAt(eye, at, up) {
  const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
function dirFrom(yawDeg, pitchDeg) {   // yaw 0 = from the front (-Y), positive turns to the right
  const y = yawDeg * DEG, p = pitchDeg * DEG;
  return [Math.sin(y) * Math.cos(p), -Math.cos(y) * Math.cos(p), Math.sin(p)];
}

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function xform(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
function boxCorners(min, max) {
  const c = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) c.push([x, y, z]);
  return c;
}
// A part's display pose: print space -> display space. pose = { rx, ry, rz (degrees, applied x
// then y then z), t: [x, y, z], drop: true } or a column-major 4x4 array. drop (default) lowers
// the rotated part so it rests on Z = 0, e.g. { rx: 90 } stands a flat-printed piece upright.
export function poseMatrix(pose, min = [0, 0, 0], max = [0, 0, 0]) {
  if (!pose) return IDENT;
  if (pose.length === 16) return Float32Array.from(pose);
  const { rx = 0, ry = 0, rz = 0, t = [0, 0, 0], drop = true } = pose;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx * DEG), Math.sin(rx * DEG), Math.cos(ry * DEG), Math.sin(ry * DEG), Math.cos(rz * DEG), Math.sin(rz * DEG)];
  const Rx = new Float32Array([1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]);
  const Ry = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
  const Rz = new Float32Array([cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const m = mat4Mul(Rz, mat4Mul(Ry, Rx));
  // rotate about the part's own footprint centre so it stays where it was on the plate
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, 0];
  const rc = xform(m, c);
  m[12] = c[0] - rc[0] + t[0]; m[13] = c[1] - rc[1] + t[1]; m[14] = (t[2] || 0);
  if (drop) m[14] -= Math.min(...boxCorners(min, max).map(p => xform(m, p)[2]));
  return m;
}

export function parseColor(c, i = 0) {
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return [c[0], c[1], c[2]].map(v => (v > 1 ? v / 255 : v));
  if (typeof c === 'number') return [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255];
  let s = typeof c === 'string' ? c.trim() : '';
  if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + s.slice(1).split('').map(h => h + h).join('');
  if (/^#[0-9a-f]{6}/i.test(s)) return [1, 3, 5].map(k => parseInt(s.slice(k, k + 2), 16) / 255);
  const m = /^rgba?\(([^)]+)\)/i.exec(s);
  if (m) return m[1].split(',').slice(0, 3).map(v => +v / 255);
  return parseColor(DEFAULT_COLORS[i % DEFAULT_COLORS.length]);
}
const toLinear = c => c.map(v => Math.pow(Math.max(0, v), 2.2));

// ---------------------------------------------------------------- mesh preparation

// De-indexes a mesh into GPU arrays with crease-angle normals: faces meeting at less than
// `creaseDeg` share a smoothed normal (lithophane slopes, round wire), sharper edges stay crisp.
export function prepareMesh(mesh, creaseDeg = 32) {
  const P = mesh.positions;
  const nv = (P.length / 3) | 0;
  let I = mesh.indices;
  if (!I) { I = new Uint32Array(nv); for (let i = 0; i < nv; i++) I[i] = i; }
  const nt = (I.length / 3) | 0;
  const fa = new Float32Array(nt * 3), fu = new Float32Array(nt * 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) {
    const x = P[v * 3 + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x;
  }
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1e-30;
    fa[t * 3] = nx; fa[t * 3 + 1] = ny; fa[t * 3 + 2] = nz;
    fu[t * 3] = nx / l; fu[t * 3 + 1] = ny / l; fu[t * 3 + 2] = nz / l;
  }
  // vertex -> faces (CSR)
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < nt * 3; i++) start[I[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const cur = start.slice(0, nv), vf = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) vf[cur[I[i]]++] = (i / 3) | 0;
  const cosT = Math.cos(creaseDeg * DEG);
  const pos = new Float32Array(nt * 9), nrm = new Int16Array(nt * 12);
  for (let t = 0; t < nt; t++) {
    const tx = fu[t * 3], ty = fu[t * 3 + 1], tz = fu[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k], o = t * 3 + k;
      pos[o * 3] = P[v * 3]; pos[o * 3 + 1] = P[v * 3 + 1]; pos[o * 3 + 2] = P[v * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (let j = start[v]; j < start[v + 1]; j++) {
        const f = vf[j];
        if (fu[f * 3] * tx + fu[f * 3 + 1] * ty + fu[f * 3 + 2] * tz >= cosT) { sx += fa[f * 3]; sy += fa[f * 3 + 1]; sz += fa[f * 3 + 2]; }
      }
      const l = Math.hypot(sx, sy, sz);
      if (l > 0) { sx /= l; sy /= l; sz /= l; } else { sx = tx; sy = ty; sz = tz; }
      nrm[o * 4] = Math.round(sx * 32767); nrm[o * 4 + 1] = Math.round(sy * 32767); nrm[o * 4 + 2] = Math.round(sz * 32767);
    }
  }
  return { pos, nrm, count: nt * 3, min, max };
}

// ---------------------------------------------------------------- shaders

const VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
uniform mat4 uVP;
uniform mat4 uModel;          // print space -> display space (part pose)
out vec3 vPos;                // display (world) position
out vec3 vPrint;              // print-space position: layer lines, thickness
out vec3 vNrm;                // print-space normal
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vPos = w.xyz;
  vPrint = aPos;
  vNrm = aNrm;
  gl_Position = uVP * w;
}`;

const DEPTH_FS = `#version 300 es
precision highp float;
out vec4 frag;
void main() { frag = vec4(1.0); }`;

const HEIGHT_FS = `#version 300 es
precision highp float;
in vec3 vPos;
uniform float uZmax;
out vec4 frag;
void main() { float h = clamp(vPos.z / uZmax, 0.0, 1.0); frag = vec4(h, h, h, 1.0); }`;

const MAIN_FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vPrint;
in vec3 vNrm;
out vec4 frag;

uniform mat4 uModel;
uniform int uKind;            // 0 part, 1 bed
uniform int uBed;             // 0 plain, 1 pei, 2 desk, 3 dark
uniform vec3 uCam;
uniform vec3 uKeyDir;
uniform vec3 uKeyCol;
uniform vec3 uFillDir;
uniform vec3 uColor;          // linear
uniform vec4 uColorAbove;     // rgb (linear), w = print Z of a filament change (< 0: none)
uniform float uRough, uF0, uSSS, uSheen;
uniform float uLayer, uLines;
uniform float uAA;            // supersampling factor: fade stripes finer than an OUTPUT pixel
uniform vec3 uBg;
uniform vec2 uPlate;          // plate size (mm)
uniform vec3 uCenter;         // scene centre
uniform float uRadius;        // scene radius
uniform float uBacklit, uMu, uExposure;
uniform vec2 uRes;

uniform highp sampler2D uShadow;
uniform mat4 uLightVP;
uniform float uLightDepth;    // light ortho depth range (mm)
uniform float uLightExtent;   // light ortho width (mm)
uniform float uSoft;

uniform highp sampler2D uFar;  // farthest part surface per pixel (backlit only)
uniform vec2 uNF;               // camera near, far
uniform vec3 uFwd;              // camera forward
uniform sampler2D uHeight;
uniform vec4 uHRect;          // x0, y0, 1/w, 1/h (mm)
uniform float uHZmax, uHTexel, uSelfAO;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

float shadowAt(vec3 p, vec3 n) {
  vec3 q = p + n * 0.08 + uKeyDir * 0.05;
  vec4 lp = uLightVP * vec4(q, 1.0);
  vec3 s = lp.xyz / lp.w * 0.5 + 0.5;
  if (s.x <= 0.0 || s.x >= 1.0 || s.y <= 0.0 || s.y >= 1.0 || s.z >= 1.0) return 1.0;
  float rot = hash12(gl_FragCoord.xy) * 6.2831853;
  float bias = 0.0006;
  // blocker search: how far above the receiver are the occluders?
  float search = 0.035 * uSoft * uRadius / uLightExtent + 1.5 / 2048.0;
  float blk = 0.0, nb = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 12.0) * search, a = fi * 2.39996 + rot;
    float d = texture(uShadow, s.xy + r * vec2(cos(a), sin(a))).r;
    if (d < s.z - bias) { blk += d; nb += 1.0; }
  }
  if (nb < 0.5) return 1.0;
  blk /= nb;
  float gap = (s.z - blk) * uLightDepth;                 // mm between occluder and receiver
  float pen = clamp(gap * 0.09 * uSoft / uLightExtent, 1.2 / 2048.0, search * 1.6);
  float lit = 0.0;
  for (int i = 0; i < 24; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 24.0) * pen, a = fi * 2.39996 + rot;
    float d = texture(uShadow, s.xy + r * vec2(cos(a), sin(a))).r;
    lit += d < s.z - bias ? 0.0 : 1.0;
  }
  return lit / 24.0;
}

// contact / cavity occlusion from the blurred top-down height map (mips = neighbourhood means)
float heightAO(vec3 p, float strength) {
  vec2 uv = (p.xy - uHRect.xy) * uHRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float occ = 0.0;
  float r = max(uHTexel * 1.5, 0.35);
  for (int k = 0; k < 7; k++) {
    float lod = log2(max(r / uHTexel, 1.0));
    float h = textureLod(uHeight, uv, lod).r * uHZmax;
    occ += clamp((h - p.z) / (r * 1.6), 0.0, 1.0) * (k < 2 ? 0.1 : 0.16);
    r *= 2.0;
  }
  return 1.0 - clamp(occ * strength, 0.0, 0.85);
}

vec3 envLight(vec3 r, vec3 bedCol) {
  // studio: a grey sweep, a big softbox where the key light is, a strip light behind
  float up = r.z;
  vec3 sky = mix(bedCol * 0.35, vec3(0.62, 0.64, 0.68), smoothstep(-0.25, 0.35, up));
  float box = smoothstep(0.78, 0.97, dot(r, uKeyDir));
  float strip = smoothstep(0.9, 0.99, dot(r, normalize(vec3(-uKeyDir.x, -uKeyDir.y, 0.55))));
  float top = smoothstep(0.86, 0.99, r.z);
  return sky * 0.75 + vec3(1.0, 0.97, 0.92) * box * 4.5 + vec3(0.9, 0.95, 1.0) * strip * 1.2 + vec3(1.0, 0.98, 0.95) * top * 0.7;
}

float ggx(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (3.14159 * d * d); }

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

void main() {
  vec3 p = vPos;
  vec3 V = normalize(uCam - p);
  vec3 N;
  vec3 base;
  float rough, f0, sss = 0.0, ao = 1.0, emit = 0.0;
  float edgeFade = 0.0;

  if (uKind == 1) {
    // ---------------- bed
    N = vec3(0.0, 0.0, 1.0);
    vec2 q = p.xy - uCenter.xy;
    vec2 pl = abs(q) - uPlate * 0.5 + 6.0;
    float plate = length(max(pl, 0.0)) + min(max(pl.x, pl.y), 0.0) - 6.0;   // rounded-rect SDF
    float fw = fwidth(p.x);
    if (uBed == 1) {
      // textured PEI: champagne powder coat, fine grit, sparkle, faint grid and edge markings
      float grit = vnoise(p.xy * 9.0) * 0.6 + vnoise(p.xy * 23.0) * 0.4;
      float mottled = fbm(p.xy * 0.05);
      base = mix(vec3(0.25, 0.205, 0.14), vec3(0.34, 0.285, 0.2), grit) * (0.88 + 0.24 * mottled);
      vec2 gx = abs(fract(q / 10.0 + 0.5) - 0.5) * 10.0;
      float g1 = 1.0 - smoothstep(0.0, 0.18 + fw, min(gx.x, gx.y));
      vec2 gy = abs(fract(q / 50.0 + 0.5) - 0.5) * 50.0;
      float g2 = 1.0 - smoothstep(0.0, 0.35 + fw, min(gy.x, gy.y));
      float gridFade = 1.0 - smoothstep(0.08, 0.5, fw);
      base *= 1.0 - (g1 * 0.05 + g2 * 0.12) * gridFade;
      rough = 0.62;
      f0 = 0.035;
      N = normalize(vec3((vnoise(p.xy * 31.0) - 0.5) * 0.5, (vnoise(p.xy * 31.0 + 9.0) - 0.5) * 0.5, 1.0));
      // outside the plate: the black heat bed
      float inPlate = 1.0 - smoothstep(-fw, fw, plate);
      base = mix(vec3(0.07, 0.07, 0.075), base, inPlate);
      rough = mix(0.45, rough, inPlate);
      N = normalize(mix(vec3(0, 0, 1), N, inPlate));
    } else if (uBed == 2) {
      // oak desk: warped growth rings along X, pores, slight satin finish
      vec2 w = p.xy * vec2(0.012, 0.09);
      float warp = fbm(w * vec2(1.0, 0.6) + 3.0) * 3.2;
      float ring = fract((p.y * 0.06 + warp) * 1.3);
      ring = smoothstep(0.0, 0.25, ring) * (1.0 - smoothstep(0.55, 1.0, ring));
      float pores = smoothstep(0.62, 0.9, vnoise(vec2(p.x * 0.35, p.y * 9.0)));
      base = mix(vec3(0.46, 0.29, 0.16), vec3(0.62, 0.43, 0.26), ring * 0.7 + fbm(p.xy * vec2(0.02, 0.3)) * 0.3);
      base *= 1.0 - pores * 0.18;
      rough = 0.42;
      f0 = 0.04;
    } else if (uBed == 3) {
      base = vec3(0.03, 0.03, 0.034) * (0.92 + 0.16 * fbm(p.xy * 0.4));   // graphite: dark, as BACKDROPS.dark.tone says
      rough = 0.5;
      f0 = 0.04;
    } else {
      base = uBg;
      rough = 0.9;
      f0 = 0.02;
    }
    ao = heightAO(p, 1.7);
    float d = length(p.xy - uCenter.xy);
    edgeFade = smoothstep(uRadius * 2.0, uRadius * 3.8, d);
    if (uBacklit > 0.5) { base *= 0.35; }
  } else {
    // ---------------- filament
    N = normalize(vNrm);                  // print space until the ripples are applied
    vec3 pp = vPrint;
    if (!gl_FrontFacing) N = -N;
    base = uColor;
    if (uColorAbove.w >= 0.0 && pp.z > uColorAbove.w + 1e-3) base = uColorAbove.rgb;   // filament swapped at that layer
    rough = uRough;
    f0 = uF0;
    sss = uSSS;
    // layer lines: each 0.2 mm bead is a rounded ridge -> tilt the normal up/down across it
    float lz = pp.z / uLayer;
    float fz = fwidth(lz) * uAA;
    float fade = (1.0 - smoothstep(0.25, 0.7, fz)) * uLines;
    float t = fract(lz);
    float wall = sqrt(max(1.0 - abs(N.z), 0.0));   // shallow slopes show terraces too
    float bead = (t - 0.5) * 2.0;
    N = normalize(N + vec3(0.0, 0.0, bead * 0.55 * fade * wall));
    float groove = pow(abs(bead), 6.0) * 0.28 * fade * wall;
    // top skin: monotonic lines at 45 degrees, direction alternates per layer
    float layerIdx = floor(lz + 0.5);
    vec2 dir = mod(layerIdx, 2.0) < 1.0 ? vec2(0.7071, 0.7071) : vec2(0.7071, -0.7071);
    float lt = dot(pp.xy, dir) / 0.42;
    float ft = fwidth(lt) * uAA;
    float top = smoothstep(0.85, 0.98, N.z) * (1.0 - smoothstep(0.3, 0.8, ft)) * uLines;
    float st = (fract(lt) - 0.5) * 2.0;
    N = normalize(N + vec3(dir * st * 0.12 * top, 0.0));
    N = normalize(mat3(uModel) * N);      // to display space
    base *= 1.0 - groove;
    ao = mix(1.0, heightAO(p, 1.0), uSelfAO);
    ao *= 1.0 - groove * 0.5;
  }

  // ---------------- lighting
  vec3 L = uKeyDir;
  vec3 H = normalize(L + V);
  float nl = dot(N, L);
  float nv = max(dot(N, V), 1e-3);
  float sh = nl > -0.2 ? shadowAt(p, N) : 0.0;
  float wrap = uKind == 0 ? 0.25 * (sss + 0.3) : 0.0;
  float diffK = clamp((nl + wrap) / (1.0 + wrap), 0.0, 1.0);
  float a = max(rough * rough, 0.02);
  float F = f0 + (1.0 - f0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float spec = ggx(max(dot(N, H), 0.0), a) * F * 0.25 / max(nv * max(nl, 1e-3), 0.05) * max(nl, 0.0);
  vec3 bedCol = uBed == 1 ? vec3(0.3, 0.25, 0.17) : uBed == 2 ? vec3(0.55, 0.36, 0.2) : vec3(0.1);
  vec3 hemi = mix(bedCol * 0.35, vec3(0.55, 0.58, 0.64), N.z * 0.5 + 0.5);
  float fill = max(dot(N, uFillDir), 0.0) * 0.28;
  float bl = uBacklit > 0.5 ? (uKind == 0 ? 0.018 : 0.12) : 1.0;
  float pool = 1.0 - 0.28 * smoothstep(0.2, 2.4, length(p.xy - uCenter.xy) / uRadius);
  vec3 col = base * (uKeyCol * pool * diffK * sh * bl + (hemi * 0.55 + vec3(fill)) * ao * bl);
  // subsurface: light colours glow a little on the shadow side and at thin edges (PETG)
  if (uKind == 0) col += base * base * sss * 0.18 * (1.0 - diffK) * ao * uKeyCol * bl;
  col += uKeyCol * spec * sh * bl;
  vec3 R = reflect(-V, N);
  float Fr = f0 + (1.0 - f0) * pow(1.0 - nv, 5.0) * (1.0 - rough * 0.8);
  vec3 env = envLight(R, bedCol);
  col += env * Fr * mix(1.0, 0.25, rough) * ao * bl * (uKind == 1 ? 0.35 : 1.0);
  if (uKind == 0 && uSheen > 0.0) col += base * pow(1.0 - nv, 2.0) * uSheen * 0.6;

  if (uBacklit > 0.5 && uKind == 0) {
    // light panel under the part: transmission through thickness z (Beer-Lambert), scattered tint
    // thickness along the view ray: farthest part surface minus this one (any orientation)
    float dFar = texelFetch(uFar, ivec2(gl_FragCoord.xy), 0).r;
    float n = uNF.x, f = uNF.y;
    float zn = 2.0 * n * f / (f + n - (2.0 * gl_FragCoord.z - 1.0) * (f - n));
    float zf = 2.0 * n * f / (f + n - (2.0 * dFar - 1.0) * (f - n));
    float thick = max(zf - zn, 0.0) / max(dot(normalize(p - uCam), uFwd), 0.2);
    // grazing rays (silhouettes, side walls seen edge-on) do not see the panel behind: opaque
    vec3 gN = normalize(cross(dFdx(vPos), dFdy(vPos)));
    float facing = smoothstep(0.25, 0.55, abs(dot(gN, V)));
    float T = exp(-uMu * thick) * smoothstep(0.15, 0.45, thick) * facing;
    col += vec3(1.0, 0.93, 0.82) * mix(vec3(1.0), uColor, 0.5) * T * 3.2;
  }

  col *= uExposure;
  if (uKind == 1) col = mix(col, uBg, edgeFade);
  vec3 outc = aces(col * 1.05);
  outc = pow(outc, vec3(1.0 / 2.2));
  // vignette + dither
  vec2 uv = gl_FragCoord.xy / uRes;
  outc *= mix(0.86, 1.0, smoothstep(1.05, 0.35, length(uv - 0.5) * 1.3));
  outc += (hash12(gl_FragCoord.xy + 7.0) - 0.5) / 255.0;
  frag = vec4(outc, 1.0);
}`;

// ---------------------------------------------------------------- GL helpers

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('print3d view shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('print3d view link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

function makeVAO(gl, pos, nrm) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const b0 = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b0);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  let b1 = null;
  if (nrm) {
    b1 = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b1);
    gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.SHORT, true, 8, 0);
  } else {
    gl.disableVertexAttribArray(1);
    gl.vertexAttrib3f(1, 0, 0, 1);
  }
  gl.bindVertexArray(null);
  return { vao, bufs: [b0, b1].filter(Boolean) };
}

// ---------------------------------------------------------------- viewer

export function createViewer(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: false, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 is not available');
  const progMain = compile(gl, VS, MAIN_FS);
  const progDepth = compile(gl, VS, DEPTH_FS);
  const progHeight = compile(gl, VS, HEIGHT_FS);

  const state = { ...VIEW_DEFAULTS, ...opts, light: { ...VIEW_DEFAULTS.light, ...(opts.light || {}) } };
  let parts = [];           // { name, vao, count, color, min, max, material }
  let bounds = null;
  let dirty = { shadow: true, height: true };
  let raf = 0, spin = 0, lastT = 0;
  let autoSize = opts.autoSize ?? false;
  const listeners = new Set();

  // shadow map
  const SHADOW = opts.shadowSize || 2048;
  const shadowTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, shadowTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, SHADOW, SHADOW);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const shadowFB = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
  const shadowColor = gl.createRenderbuffer();   // some drivers want a colour attachment
  gl.bindRenderbuffer(gl.RENDERBUFFER, shadowColor);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.R8, SHADOW, SHADOW);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, shadowColor);

  // height map (top-down max Z, normalised, mipmapped)
  const HMAP = opts.heightSize || 2048;
  const heightTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  const levels = Math.floor(Math.log2(HMAP)) + 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, HMAP, HMAP);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const heightFB = gl.createFramebuffer();
  const heightDepth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, heightDepth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, HMAP, HMAP);
  gl.bindFramebuffer(gl.FRAMEBUFFER, heightFB);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, heightTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, heightDepth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const bedGeo = makeVAO(gl, new Float32Array(18), null);
  let heightInfo = null, lightInfo = null;

  function setParts(list) {
    for (const p of parts) { gl.deleteVertexArray(p.vao); p.bufs.forEach(b => gl.deleteBuffer(b)); }
    parts = [];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    (list || []).forEach((part, i) => {
      if (!part || !part.mesh || !part.mesh.positions || !part.mesh.positions.length) return;
      const prep = part.prepared || prepareMesh(part.mesh, part.crease ?? state.crease ?? 32);
      const { vao, bufs } = makeVAO(gl, prep.pos, prep.nrm);
      const model = poseMatrix(part.pose, prep.min, prep.max);
      const cs = boxCorners(prep.min, prep.max).map(p => xform(model, p));
      const dmin = [0, 1, 2].map(k => Math.min(...cs.map(p => p[k]))), dmax = [0, 1, 2].map(k => Math.max(...cs.map(p => p[k])));
      parts.push({ name: part.name || 'part' + i, vao, bufs, count: prep.count, color: toLinear(parseColor(part.color, i)),
        material: part.material || null, colorAbove: part.colorAbove || null, min: dmin, max: dmax, printMin: prep.min, printMax: prep.max, model });
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], dmin[k]); max[k] = Math.max(max[k], dmax[k]); }
    });
    bounds = parts.length ? { min, max } : { min: [-50, -50, 0], max: [50, 50, 10] };
    dirty.shadow = dirty.height = true;
    requestRender();
    return api;
  }

  function set(o = {}) {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if (k === 'light') state.light = { ...state.light, ...v };
      else state[k] = v;
      if (k === 'light' || k === 'yaw') dirty.shadow = true;
    }
    return api;
  }

  function scene(W, H) {
    const b = bounds || { min: [-50, -50, 0], max: [50, 50, 10] };
    const c = state.target || [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const radius = Math.max(1, 0.5 * Math.hypot(ext[0], ext[1], ext[2]));
    const aspect = W / H;
    const fovy = state.fov * DEG;
    const fovx = 2 * Math.atan(Math.tan(fovy / 2) * aspect);
    const d = dirFrom(state.yaw, Math.min(89.5, Math.max(-10, state.pitch)));
    const upHint = Math.abs(state.pitch) > 89 ? [Math.sin(state.yaw * DEG), Math.cos(state.yaw * DEG), 0] : [0, 0, 1];
    const right = norm(cross(upHint, d)), upv = cross(d, right);
    const margin = state.margin ?? 0.88;
    const tx = Math.tan(fovx / 2) * margin, ty = Math.tan(fovy / 2) * margin;
    const corners = boxCorners(b.min, b.max);
    let dist = radius * 3;
    if (!state.target) {
      for (let it = 0; it < 3; it++) {
        let need = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const k of corners) {
          const r = sub(k, c), xc = dot(r, right), yc = dot(r, upv), zc = dot(r, d);
          need = Math.max(need, zc + Math.abs(xc) / tx, zc + Math.abs(yc) / ty);
          const dz = Math.max(1e-3, dist - zc);
          x0 = Math.min(x0, xc / dz); x1 = Math.max(x1, xc / dz); y0 = Math.min(y0, yc / dz); y1 = Math.max(y1, yc / dz);
        }
        if (it > 0) {   // re-centre the projected box
          const ox = (x0 + x1) / 2 * dist, oy = (y0 + y1) / 2 * dist;
          for (let k = 0; k < 3; k++) c[k] += right[k] * ox + upv[k] * oy;
        }
        dist = need;
      }
    } else dist = radius / Math.sin(Math.min(fovy, fovx) / 2);
    dist /= (state.zoom || 1);
    const eye = [c[0] + d[0] * dist, c[1] + d[1] * dist, c[2] + d[2] * dist];
    const view = lookAt(eye, c, upHint);
    const far = dist + radius * 8 + Math.max(...(state.plate || [330, 320]));
    const near = Math.max(0.5, dist - radius * 1.5) * 0.5;
    const proj = perspective(fovy, aspect, near, far);
    const lt = state.light;
    const keyDir = norm(dirFrom(lt.relative === false ? lt.yaw : state.yaw + lt.yaw, lt.pitch));   // key light turns with the camera (turntable look)
    const fillDir = norm(dirFrom(state.yaw + 70, 25));
    return { c, radius, eye, vp: mat4Mul(proj, view), keyDir, fillDir, b, near, far, fwd: [-d[0], -d[1], -d[2]] };
  }

  function renderShadow(sc) {
    const { c, radius, keyDir, b } = sc;
    const R = radius + (b.max[2] - b.min[2]) * 1.3 + 2;
    const eye = [c[0] + keyDir[0] * R * 3, c[1] + keyDir[1] * R * 3, c[2] + keyDir[2] * R * 3];
    const up = Math.abs(keyDir[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    const view = lookAt(eye, c, up);
    const proj = ortho(-R, R, -R, R, R * 1.0, R * 5);
    lightInfo = { vp: mat4Mul(proj, view), depth: R * 4, extent: 2 * R };
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
    gl.viewport(0, 0, SHADOW, SHADOW);
    gl.colorMask(false, false, false, false);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 2.0);
    gl.useProgram(progDepth.p);
    gl.uniformMatrix4fv(progDepth.u.uVP, false, lightInfo.vp);
    for (const p of parts) { gl.uniformMatrix4fv(progDepth.u.uModel, false, p.model); gl.bindVertexArray(p.vao); gl.drawArrays(gl.TRIANGLES, 0, p.count); }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    dirty.shadow = false;
  }

  function renderHeight(sc) {
    const { b } = sc;
    const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1];
    const zmax = Math.max(0.5, b.max[2]);
    const margin = Math.max(20, zmax * 3, Math.max(w, h) * 0.25);
    const size = Math.max(w, h) + 2 * margin;
    const x0 = (b.min[0] + b.max[0]) / 2 - size / 2, y0 = (b.min[1] + b.max[1]) / 2 - size / 2;
    heightInfo = { x0, y0, size, zmax, texel: size / HMAP };
    const view = lookAt([x0 + size / 2, y0 + size / 2, zmax + 10], [x0 + size / 2, y0 + size / 2, 0], [0, 1, 0]);
    const proj = ortho(-size / 2, size / 2, -size / 2, size / 2, 1, zmax + 20 - Math.min(0, b.min[2]));
    gl.bindFramebuffer(gl.FRAMEBUFFER, heightFB);
    gl.viewport(0, 0, HMAP, HMAP);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(progHeight.p);
    gl.uniformMatrix4fv(progHeight.u.uVP, false, mat4Mul(proj, view));
    gl.uniform1f(progHeight.u.uZmax, zmax);
    for (const p of parts) { gl.uniformMatrix4fv(progHeight.u.uModel, false, p.model); gl.bindVertexArray(p.vao); gl.drawArrays(gl.TRIANGLES, 0, p.count); }
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    dirty.height = false;
  }

  let farTex = null, farFB = null, farSize = [0, 0];
  function renderFar(sc, W, H) {
    if (!farTex || farSize[0] !== W || farSize[1] !== H) {
      if (farTex) { gl.deleteTexture(farTex); gl.deleteFramebuffer(farFB); }
      farTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, farTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, W, H);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      farFB = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, farFB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, farTex, 0);
      gl.drawBuffers([gl.NONE]);
      farSize = [W, H];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, farFB);
    gl.viewport(0, 0, W, H);
    gl.clearDepth(0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.GREATER);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(progDepth.p);
    gl.uniformMatrix4fv(progDepth.u.uVP, false, sc.vp);
    for (const p of parts) { gl.uniformMatrix4fv(progDepth.u.uModel, false, p.model); gl.bindVertexArray(p.vao); gl.drawArrays(gl.TRIANGLES, 0, p.count); }
    gl.clearDepth(1);
    gl.depthFunc(gl.LESS);
  }

  function bgColor() {
    if (state.background) return toLinear(parseColor(state.background));
    if (state.backlit) return [0.012, 0.012, 0.014];
    return state.bed === 'pei' ? [0.25, 0.24, 0.225] : state.bed === 'desk' ? [0.34, 0.25, 0.16] : state.bed === 'dark' ? [0.02, 0.02, 0.022] : [0.72, 0.72, 0.74];
  }

  function drawMain(fb, W, H, aa = 1) {
    const sc = scene(W, H);
    renderShadow(sc);   // cheap: one depth pass; the light follows the camera
    if (dirty.height || !heightInfo) renderHeight(sc);
    if (state.backlit) renderFar(sc, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, W, H);
    const bg = bgColor();
    const bgS = bg.map(v => Math.pow(v, 1 / 2.2));
    gl.clearColor(bgS[0], bgS[1], bgS[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    const P = progMain, u = P.u;
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(u.uVP, false, sc.vp);
    gl.uniform3fv(u.uCam, sc.eye);
    gl.uniform3fv(u.uKeyDir, sc.keyDir);
    const ki = 1.8 * (state.light.intensity ?? 1);
    gl.uniform3f(u.uKeyCol, ki, ki * 0.965, ki * 0.9);
    gl.uniform3fv(u.uFillDir, sc.fillDir);
    gl.uniform1f(u.uLayer, state.layer || 0.2);
    gl.uniform1f(u.uLines, state.lines ?? 1);
    gl.uniform1f(u.uAA, aa);
    gl.uniform3fv(u.uBg, bg);
    gl.uniform2fv(u.uPlate, state.plate || [330, 320]);
    gl.uniform3f(u.uCenter, (sc.b.min[0] + sc.b.max[0]) / 2, (sc.b.min[1] + sc.b.max[1]) / 2, 0);
    gl.uniform1f(u.uRadius, sc.radius);
    gl.uniform1f(u.uBacklit, state.backlit ? 1 : 0);
    gl.uniform1f(u.uMu, state.mu);
    gl.uniform1f(u.uExposure, state.exposure ?? 1);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uSoft, state.light.soft ?? 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.uniform1i(u.uShadow, 0);
    gl.uniformMatrix4fv(u.uLightVP, false, lightInfo.vp);
    gl.uniform1f(u.uLightDepth, lightInfo.depth);
    gl.uniform1f(u.uLightExtent, lightInfo.extent);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.uniform1i(u.uHeight, 1);
    gl.uniform4f(u.uHRect, heightInfo.x0, heightInfo.y0, 1 / heightInfo.size, 1 / heightInfo.size);
    gl.uniform1f(u.uHZmax, heightInfo.zmax);
    gl.uniform1f(u.uHTexel, heightInfo.texel);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, state.backlit && farTex ? farTex : shadowTex);
    gl.uniform1i(u.uFar, 2);
    gl.uniform2f(u.uNF, sc.near, sc.far);
    gl.uniform3fv(u.uFwd, sc.fwd);
    gl.activeTexture(gl.TEXTURE0);
    const ext = Math.max(sc.b.max[0] - sc.b.min[0], sc.b.max[1] - sc.b.min[1]);
    const flatness = heightInfo.zmax / Math.max(1, ext);
    const selfAO = 1 - Math.min(1, Math.max(0, (flatness - 0.25) / 0.35));
    gl.uniform1f(u.uSelfAO, selfAO);

    // bed: a big quad a hair under Z = 0
    const bedMode = { pei: 1, desk: 2, dark: 3 }[state.bed === true ? 'pei' : state.bed] || 0;
    const S = Math.max(sc.radius * 10, ...(state.plate || [330, 320]));
    const z = -0.02, cx = sc.c[0], cy = sc.c[1];
    const quad = new Float32Array([cx - S, cy - S, z, cx + S, cy - S, z, cx + S, cy + S, z, cx - S, cy - S, z, cx + S, cy + S, z, cx - S, cy + S, z]);
    gl.bindBuffer(gl.ARRAY_BUFFER, bedGeo.bufs[0]);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.DYNAMIC_DRAW);
    gl.uniform1i(u.uKind, 1);
    gl.uniform1i(u.uBed, bedMode);
    gl.uniformMatrix4fv(u.uModel, false, IDENT);
    gl.bindVertexArray(bedGeo.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.uniform1i(u.uKind, 0);
    for (const p of parts) {
      const m = MATERIALS[p.material || state.material] || MATERIALS.petg;
      gl.uniform3fv(u.uColor, p.color);
      const ca = p.colorAbove || state.colorChange;
      if (ca && isFinite(ca.atMm ?? ca.z)) { const c2 = toLinear(parseColor(ca.color, 1)); gl.uniform4f(u.uColorAbove, c2[0], c2[1], c2[2], ca.atMm ?? ca.z); }
      else gl.uniform4f(u.uColorAbove, 0, 0, 0, -1);
      gl.uniform1f(u.uRough, m.rough);
      gl.uniform1f(u.uF0, m.f0);
      gl.uniform1f(u.uSSS, m.sss);
      gl.uniform1f(u.uSheen, m.sheen);
      gl.uniformMatrix4fv(u.uModel, false, p.model);
      gl.bindVertexArray(p.vao);
      gl.drawArrays(gl.TRIANGLES, 0, p.count);
    }
    gl.bindVertexArray(null);
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function render() {
    if (autoSize && canvas.clientWidth) resize();
    drawMain(null, canvas.width, canvas.height);
    listeners.forEach(fn => fn(state));
    return api;
  }

  function requestRender() {
    if (raf || typeof requestAnimationFrame === 'undefined') return;
    raf = requestAnimationFrame(t => {
      raf = 0;
      if (spin) {
        const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
        lastT = t;
        state.yaw = (state.yaw + spin * dt) % 360;
        dirty.shadow = true;
        requestRender();
      }
      render();
    });
  }

  function turntable(degPerSec = 20) {
    spin = +degPerSec || 0;
    lastT = 0;
    if (spin) requestRender();
    return api;
  }

  // Off-screen still: MSAA render at width*ss x height*ss, resolved, read back, downsampled.
  function capture(o = {}) {
    const { width = 1200, height = 900, ss = 2, ...view } = o;
    const keep = { ...state, light: { ...state.light } };
    set(view);
    dirty.shadow = true;
    const maxRB = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    const k = Math.max(1, Math.min(ss, Math.floor(maxRB / Math.max(width, height))));
    const W = width * k, H = height * k;
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    const msFB = gl.createFramebuffer(), rbC = gl.createRenderbuffer(), rbD = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbC);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, W, H);
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbD);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msFB);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbC);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbD);
    drawMain(msFB, W, H, k);
    const rsFB = gl.createFramebuffer(), rbR = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbR);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rsFB);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, rsFB);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rsFB);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    [msFB, rsFB].forEach(f => gl.deleteFramebuffer(f));
    [rbC, rbD, rbR].forEach(r => gl.deleteRenderbuffer(r));
    // flip rows into a 2D canvas, then downsample
    const big = document.createElement('canvas');
    big.width = W; big.height = H;
    const bctx = big.getContext('2d');
    const img = bctx.createImageData(W, H);
    const row = W * 4;
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    bctx.putImageData(img, 0, 0);
    let out = big;
    if (k > 1) {
      out = document.createElement('canvas');
      out.width = width; out.height = height;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(big, 0, 0, width, height);
    }
    Object.assign(state, keep);
    dirty.shadow = true;
    return out;
  }

  // Stills around the piece (a turntable film or a contact strip): frames evenly spaced over 360 deg.
  function captureTurntable(o = {}) {
    const { frames = 8, ...rest } = o;
    const yaw0 = rest.yaw ?? state.yaw;
    const out = [];
    for (let i = 0; i < frames; i++) out.push(capture({ ...rest, yaw: yaw0 + 360 * i / frames }));
    return out;
  }

  function captureBlob(o = {}, type = 'image/jpeg', quality = 0.92) {
    const c = capture(o);
    return new Promise(res => c.toBlob(res, type, quality));
  }

  function dispose() {
    turntable(0);
    if (raf) cancelAnimationFrame(raf);
    setParts([]);
    [shadowTex, heightTex, farTex].forEach(t => t && gl.deleteTexture(t));
    if (farFB) gl.deleteFramebuffer(farFB);
    [shadowFB, heightFB].forEach(f => gl.deleteFramebuffer(f));
    [shadowColor, heightDepth].forEach(r => gl.deleteRenderbuffer(r));
    [progMain, progDepth, progHeight].forEach(p => gl.deleteProgram(p.p));
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }

  const api = {
    canvas, gl, state,
    setParts, set, render, requestRender, turntable, capture, captureBlob, captureTurntable, dispose,
    get parts() { return parts.map(p => ({ name: p.name, count: p.count, min: p.min, max: p.max })); },
    get bounds() { return bounds; },
    suggestView() { return suggestView(bounds); },
    get spinning() { return !!spin; },
    set autoSize(v) { autoSize = !!v; },
    onRender(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reset() { set({ yaw: opts.yaw ?? VIEW_DEFAULTS.yaw, pitch: opts.pitch ?? VIEW_DEFAULTS.pitch, zoom: opts.zoom ?? 1 }); requestRender(); return api; },
  };
  setParts([]);
  return api;
}

// A flattering camera for a set of bounds: flat pieces from above at an angle, standing pieces
// from the front and low.
export function suggestView(bounds) {
  if (!bounds) return { yaw: VIEW_DEFAULTS.yaw, pitch: VIEW_DEFAULTS.pitch };
  const ex = bounds.max[0] - bounds.min[0], ey = bounds.max[1] - bounds.min[1], ez = bounds.max[2] - bounds.min[2];
  const tall = ez / Math.max(1, ex, ey);
  if (tall > 0.6) return { yaw: -22, pitch: 16 };
  if (tall > 0.2) return { yaw: -28, pitch: 34 };
  return { yaw: -24, pitch: 46 };
}

// ---------------------------------------------------------------- one-call helpers

const cache = new WeakMap();

// Renders one frame of `parts` on `canvas` and returns the (cached) viewer for further use.
export function renderParts(canvas, parts, opts = {}) {
  let entry = cache.get(canvas);
  if (!entry) { entry = { viewer: createViewer(canvas, opts), parts: null }; cache.set(canvas, entry); }
  const v = entry.viewer;
  if (entry.parts !== parts) { v.setParts(parts); entry.parts = parts; }
  const o = { ...opts };
  if (o.bed === true) o.bed = 'pei';
  v.set(o);
  return v.render();
}

// A still for a line-up, from a throwaway context; resolves to a Blob (JPEG by default).
export async function captureStill(parts, opts = {}) {
  const { type = 'image/jpeg', quality = 0.92, ...o } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = 4; canvas.height = 4;
  const v = createViewer(canvas, o);
  try {
    v.setParts(parts);
    return await v.captureBlob(o, type, quality);
  } finally { v.dispose(); }
}

// Pointer orbit for a viewer: drag to orbit, wheel or pinch to zoom, double-click to reset.
// Stops the turntable on touch. Returns detach().
export function attachOrbit(viewer, el = viewer.canvas, { minPitch = 4, maxPitch = 89, onChange } = {}) {
  const pts = new Map();
  let pinch0 = 0, zoom0 = 1;
  el.style.touchAction = 'none';
  const changed = () => { viewer.requestRender(); onChange && onChange(viewer.state); };
  const down = e => {
    try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (viewer.spinning) viewer.turntable(0);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = viewer.state.zoom;
    }
  };
  const move = e => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 1) {
      const s = viewer.state;
      viewer.set({ yaw: s.yaw - dx * 0.35, pitch: Math.max(minPitch, Math.min(maxPitch, s.pitch + dy * 0.3)) });
    } else if (pts.size === 2 && pinch0) {
      const [a, b] = [...pts.values()];
      viewer.set({ zoom: Math.max(0.4, Math.min(8, zoom0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch0)) });
    }
    changed();
  };
  const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; };
  const wheel = e => {
    e.preventDefault();
    viewer.set({ zoom: Math.max(0.4, Math.min(8, viewer.state.zoom * Math.exp(-e.deltaY * 0.0012))) });
    changed();
  };
  const dbl = () => { viewer.reset(); changed(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('dblclick', dbl);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('wheel', wheel);
    el.removeEventListener('dblclick', dbl);
  };
}
