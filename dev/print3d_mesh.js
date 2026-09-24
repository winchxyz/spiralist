// Print mesh lab: one of the app's saved geometries (shots/print3d/geom_bust_<kind>.json) through the
// print core (js/print3d/mesh.js) -> a plaque (plate + raised line), drawn as: the 2D polygons with a
// 4x zoom inset, and a lit 3D render (own tiny WebGL2 renderer, flat shading). Sets window.__done
// = { ok, report, shot (JPEG data URL) }; tests/print3d_shot.mjs saves the shot to shots/print3d/.
//   /dev/print3d_mesh.html?kind=spiral;size=150;range=auto;z=1.2;yaw=-25;pitch=50;zoom=0.5,0.5
import { write3MF, writeSTL, lineSolid, lineMask, coverageField, heightfieldMesh, extrudePolygons, rectPoly, circlePoly, reverseRing, translate, checkManifold, bounds, merge } from '../js/print3d/mesh.js';
import { STRIDE } from '../js/spiral.js';

const q = new URLSearchParams(location.search);
const kind = q.get('kind') || 'lineart';
const sizeMm = +(q.get('size') || 150);
const range = q.get('range') || (kind === 'spiral' ? 'auto' : '');
const zLine = +(q.get('z') || 1.2), zPlate = 2.4;
const yaw = +(q.get('yaw') || -28) * Math.PI / 180, pitch = +(q.get('pitch') || 52) * Math.PI / 180;
const zoomAt = (q.get('zoom') || '0.5,0.55').split(',').map(Number);

const $ = id => document.getElementById(id);
const sheet = $('sheet'), ctx = sheet.getContext('2d');

async function loadGeom() {
  const j = await (await fetch(`../shots/print3d/geom_bust_${kind}.json`)).json();
  const bin = atob(j.data), u8 = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
  const data = new Float32Array(u8.buffer);
  if (data.length !== j.meta.n * STRIDE) throw new Error('bad geometry size');
  return { ...j.meta, data };
}

// ---------------------------------------------------------------- 2D polygons
function draw2D(polys, frame, x, y, S, zoom) {
  const W = frame.widthMm + 12, H = frame.heightMm + 12;
  const k = S / Math.max(W, H);
  const ox = x + (S - W * k) / 2 + 6 * k, oy = y + (S + H * k) / 2 - 6 * k;
  ctx.fillStyle = '#f7f4ee'; ctx.fillRect(x, y, S, S);
  ctx.fillStyle = '#e6e0d4'; ctx.fillRect(ox - 6 * k, oy - (frame.heightMm + 6) * k, W * k, H * k);
  const path = (P, kk, px, py) => {
    const p = new Path2D();
    for (const poly of P) for (const r of [poly.outer, ...poly.holes]) {
      p.moveTo(px + r[0] * kk, py - r[1] * kk);
      for (let i = 2; i < r.length; i += 2) p.lineTo(px + r[i] * kk, py - r[i + 1] * kk);
      p.closePath();
    }
    return p;
  };
  ctx.fillStyle = '#1b1b1b'; ctx.fill(path(polys, k, ox, oy), 'evenodd');
  // zoom inset: 24 mm square around zoomAt (fractions of the drawing)
  const zs = 24, cx = zoomAt[0] * frame.widthMm, cy = zoomAt[1] * frame.heightMm;
  const IS = S * 0.42, ix = x + S - IS - 10, iy = y + S - IS - 10, kk = IS / zs;
  ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2;
  ctx.strokeRect(ox + (cx - zs / 2) * k, oy - (cy + zs / 2) * k, zs * k, zs * k);
  ctx.save();
  ctx.beginPath(); ctx.rect(ix, iy, IS, IS); ctx.clip();
  ctx.fillStyle = '#f7f4ee'; ctx.fillRect(ix, iy, IS, IS);
  const p2 = path(polys, kk, ix - (cx - zs / 2) * kk, iy + (cy + zs / 2) * kk);
  ctx.fillStyle = '#1b1b1b'; ctx.fill(p2, 'evenodd');
  ctx.strokeStyle = '#2f80ed'; ctx.lineWidth = 1; ctx.stroke(p2);
  // 1 mm grid ticks
  ctx.fillStyle = 'rgba(192,57,43,.9)';
  ctx.fillRect(ix + 8, iy + IS - 14, kk * 5, 3);
  ctx.font = '12px system-ui'; ctx.fillText('5 mm', ix + 8, iy + IS - 18);
  ctx.restore();
  ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2; ctx.strokeRect(ix, iy, IS, IS);
}

// ---------------------------------------------------------------- 3D (flat-shaded WebGL2)
function render3D(parts, w, h) {
  const cv = new OffscreenCanvas(w, h);
  const gl = cv.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
  const vs = `#version 300 es
  in vec3 p; in vec3 n; in vec3 c; uniform mat4 M; out vec3 vn; out vec3 vc; out vec3 vp;
  void main(){ vn = n; vc = c; vp = p; gl_Position = M * vec4(p, 1.); }`;
  const fs = `#version 300 es
  precision highp float; in vec3 vn; in vec3 vc; in vec3 vp; out vec4 o;
  void main(){ vec3 L = normalize(vec3(-0.55, 0.45, 0.62)); vec3 N = normalize(vn);
    float d = max(dot(N, L), 0.); float rim = pow(1. - abs(N.z), 2.) * .15;
    vec3 col = vc * (0.34 + 0.72 * d) + rim; o = vec4(pow(col, vec3(1./1.1)), 1.); }`;
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr);
  gl.useProgram(pr);
  // unindex with flat normals
  let T = 0; for (const p of parts) T += p.mesh.indices.length;
  const P = new Float32Array(T * 3), N = new Float32Array(T * 3), C = new Float32Array(T * 3);
  let o = 0;
  const all = merge(parts.map(p => p.mesh)), bb = bounds(all);
  for (const part of parts) {
    const { positions: V, indices: I } = part.mesh, col = part.rgb;
    for (let t = 0; t < I.length; t += 3) {
      const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2], vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { P.set([V[v], V[v + 1], V[v + 2]], o); N.set([nx, ny, nz], o); C.set(col, o); o += 3; }
    }
  }
  const buf = (name, data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); const l = gl.getAttribLocation(pr, name); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 3, gl.FLOAT, false, 0, 0); };
  buf('p', P); buf('n', N); buf('c', C);
  // camera: orbit around the plate centre
  const cx = (bb.x[0] + bb.x[1]) / 2, cy = (bb.y[0] + bb.y[1]) / 2, R = Math.max(bb.x[1] - bb.x[0], bb.y[1] - bb.y[0]);
  const dist = R * 2.05;
  const eye = [cx + dist * Math.cos(pitch) * Math.sin(yaw), cy - dist * Math.cos(pitch) * Math.cos(yaw), dist * Math.sin(pitch)];
  const M = mul(persp(38 * Math.PI / 180, w / h, dist * 0.3, dist * 3), lookAt(eye, [cx, cy, 0], [0, 0, 1]));
  gl.uniformMatrix4fv(gl.getUniformLocation(pr, 'M'), false, M);
  gl.viewport(0, 0, w, h); gl.clearColor(0.32, 0.33, 0.35, 1); gl.enable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, T);
  return cv;
}
function persp(f, a, n, fa) { const t = 1 / Math.tan(f / 2); return [t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0]; }
function lookAt(e, c, u) {
  const z = norm([e[0] - c[0], e[1] - c[1], e[2] - c[2]]), x = norm(cross(u, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1];
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
function mul(a, b) { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; }

// ---------------------------------------------------------------- run
// lithophane check: coverage of the unclamped line -> thickness 0.8..3.2 mm; left = backlit simulation
function litho(geom) {
  const t0 = performance.now();
  const m = lineMask(geom, { sizeMm, minWidthMm: 0, minGapMm: 0 });
  const cf = coverageField(m, +(q.get('cell') || 0.3), { blurCells: 1, blurMm: +(q.get('blur') ?? (m.report.pitchMm ? m.report.pitchMm * 0.5 : 0.2)) });
  const sorted = Float32Array.from(cf.field).sort(), p98 = sorted[Math.floor(sorted.length * 0.98)] || 1;
  const th = v => 0.8 + 2.4 * Math.min(1, v / p98);
  const mesh = heightfieldMesh(cf.field, cf.w, cf.h, cf.mmPerPx, th);
  const ms = performance.now() - t0;
  const chk = checkManifold(mesh, { weld: false });
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  // backlit: transmitted light ~ exp(-k t), k = 1.1 / mm (white PETG, rough)
  const img = new ImageData(cf.w, cf.h);
  for (let k = 0; k < cf.w * cf.h; k++) {
    const T = Math.exp(-1.1 * (th(cf.field[k]) - 0.8));
    img.data[4 * k] = 255 * T; img.data[4 * k + 1] = 236 * T; img.data[4 * k + 2] = 200 * T; img.data[4 * k + 3] = 255;
  }
  const c2 = new OffscreenCanvas(cf.w, cf.h); c2.getContext('2d').putImageData(img, 0, 0);
  const S2 = 700, kk = S2 / Math.max(cf.w, cf.h);
  ctx.fillStyle = '#222'; ctx.fillRect(10, 50, S2, S2);
  ctx.drawImage(c2, 10 + (S2 - cf.w * kk) / 2, 50 + (S2 - cf.h * kk) / 2, cf.w * kk, cf.h * kk);
  ctx.drawImage(render3D([{ mesh, rgb: [0.92, 0.91, 0.88] }], 770, 700), 720, 50);
  const b = bounds(mesh);
  ctx.fillStyle = '#1d1c1a'; ctx.font = '600 18px system-ui';
  ctx.fillText(`${kind} lithophane: X 0-${b.x[1].toFixed(1)} mm, Y 0-${b.y[1].toFixed(1)} mm, Z 0-${b.z[1].toFixed(2)} mm (backlit simulation left)`, 12, 28);
  ctx.font = '13px system-ui'; ctx.fillStyle = '#5b574f';
  ctx.fillText(`${cf.w} x ${cf.h} cells of ${cf.mmPerPx.toFixed(2)} mm | ${mesh.indices.length / 3} tris | watertight ${chk.ok} | ${Math.round(ms)} ms`, 12, 44 + 700 + 8);
  window.__done = { ok: chk.ok, ms: Math.round(ms), tris: mesh.indices.length / 3, shot: sheet.toDataURL('image/jpeg', 0.9) };
}

async function main() {
  const geom = await loadGeom();
  if (q.get('product') === 'litho') return litho(geom);
  const t0 = performance.now();
  const S = lineSolid(geom, { sizeMm, z0: 0, z1: zLine, widthRange: range || undefined });
  const f = S.mask.frame;
  const plate = extrudePolygons([rectPoly(-6, -6, f.widthMm + 6, f.heightMm + 6, 5, [reverseRing(circlePoly(f.widthMm / 2, f.heightMm + 2.5, 2.2).outer)])], 0, zPlate);
  const relief = translate(S.mesh, 0, 0, zPlate);
  const ms = performance.now() - t0;
  const chkP = checkManifold(plate), chkL = checkManifold(relief);
  const parts = [{ name: 'plate', mesh: plate, rgb: [0.93, 0.91, 0.87] }, { name: 'line', mesh: relief, rgb: [0.12, 0.12, 0.13] }];
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  draw2D(S.polys, f, 10, 50, 700, true);
  ctx.drawImage(render3D(parts, 770, 700), 720, 50);
  const r = S.report, b = bounds(merge([plate, relief]));
  ctx.fillStyle = '#1d1c1a'; ctx.font = '600 18px system-ui';
  ctx.fillText(`${kind} (${geom.path}, ${geom.n} pts) -> plaque X ${b.x[0].toFixed(0)}-${b.x[1].toFixed(1)} mm, Y ${b.y[0].toFixed(0)}-${b.y[1].toFixed(1)} mm, Z 0-${b.z[1].toFixed(1)} mm`, 12, 28);
  ctx.font = '13px system-ui'; ctx.fillStyle = '#5b574f';
  ctx.fillText(`${r.contours.outers} islands, ${r.contours.holes} holes, ${S.mesh.indices.length / 3} tris | widened ${(r.widenedFrac * 100).toFixed(0)}% merged ${(r.mergedFrac * 100).toFixed(0)}%` +
    `${r.widthRemap ? ` | widths ${r.widthRemap.toMm.map(v => v.toFixed(2)).join('-')} mm` : ''}${r.pitchMm ? ` | pitch ${r.pitchMm.toFixed(2)} mm` : ''} | watertight ${chkP.ok && chkL.ok} | ${Math.round(ms)} ms`, 12, 44 + 700 + 8);
  $('what').textContent = `${kind}, ${sizeMm} mm`;
  $('info').textContent = JSON.stringify({ report: r, plate: chkP, line: chkL }, null, 1);
  // the browser's own file writers (CompressionStream deflate)
  const t1 = performance.now();
  const blob = await write3MF(parts.map(p => ({ name: p.name, mesh: p.mesh, color: p.name === 'line' ? '#161616' : '#F4F1EA' })), { title: `Spiralist ${kind}` });
  const stl = writeSTL(relief, kind);
  const files = { threeMF: blob.size, type: blob.type, stl: stl.byteLength, ms: Math.round(performance.now() - t1) };
  window.__done = { ok: chkP.ok && chkL.ok, ms: Math.round(ms), notes: r.notes, contours: r.contours, files, shot: sheet.toDataURL('image/jpeg', 0.9) };
}
main().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
