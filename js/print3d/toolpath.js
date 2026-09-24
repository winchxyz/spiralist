// Toolpaths for the print timelapse: slices the product meshes into layers, lays perimeters, infill
// and skins like a slicer would, and times every move with a deterministic motion model.
//
// Our products are extrusions and height fields, so a layer is a plain 2D region: each layer's cross
// section is rasterised (even-odd scanlines of the mesh/plane intersection), turned into a signed
// distance field (mesh.js sdfOf) and the walls are its iso-lines at 0.21, 0.63, ... mm (mesh.js
// contours), which gives clean offset rings with no polygon clipping. Infill is rectilinear at
// +-45 degrees, solid (0.42 mm pitch) on the bottom/top skins and wherever the product asks for 100 %.
//
// Time model (per move, trapezoidal): feature speeds capped by the filament's volumetric flow,
// accelerations and a junction-deviation corner speed like Bambu/Klipper firmware, retraction and
// z-hop on travels, a layer-change cost, the minimum layer time for cooling, and the colour-change
// pause (AMS swap and purge, or an M600 the user answers). Numbers follow the Bambu Studio presets
// the prototype sliced with (0.20 mm Standard @BBL A2L, Bambu PETG Basic), see PRINTERS/FILAMENTS.
//
//   buildToolpath(parts, opts) -> Promise<Toolpath>
//   Toolpath = {
//     layers: [{ z, t0, t1, bead0, bead1, move0, move1, parts }],   // bead/move index ranges
//     beads:  { n, p: Float32Array(n*6) x0 y0 z0 x1 y1 z1, t: Float32Array(n*2) t0 t1 (s),
//               c: Uint8Array colour index, k: Uint8Array FEATURE index, l: Uint32Array layer },
//     track:  { n, x, y, z: Float32Array end point, t: Float64Array end time, k: Uint8Array },  // nozzle
//     palette: ['#hex'], changes: [{ layer, z, t0, t1, from, to }], total (s), printer, filament,
//     stats: { layers, beads, moves, extrudedMm, filamentMm, grams, ms, byFeature: { name: s } (at full
//              speed), coolingSlowdownS (extra time from the minimum layer time) }, box }
import { contours } from './mesh.js';

export const FEATURES = ['travel', 'outer', 'inner', 'sparse', 'solid', 'top', 'bottom', 'pause'];
const F = Object.fromEntries(FEATURES.map((n, i) => [n, i]));

// Kinematics: 'bedslinger' (bed moves Y, head X/Z) or 'corexy' (head X/Y, bed Z).
export const PRINTERS = {
  a2l: { id: 'a2l', name: 'Bambu Lab A2L', bed: [330, 320, 325], kin: 'bedslinger', accel: 6000, travelAccel: 8000, travel: 500, scv: 9, purge: [20, -4] },
  a1: { id: 'a1', name: 'Bambu Lab A1', bed: [256, 256, 256], kin: 'bedslinger', accel: 10000, travelAccel: 10000, travel: 500, scv: 9, purge: [-10, 250] },
  a1mini: { id: 'a1mini', name: 'Bambu Lab A1 mini', bed: [180, 180, 180], kin: 'bedslinger', accel: 10000, travelAccel: 10000, travel: 500, scv: 9, purge: [-10, 170] },
  p1s: { id: 'p1s', name: 'Bambu Lab P1S', bed: [256, 256, 256], kin: 'corexy', accel: 10000, travelAccel: 10000, travel: 500, scv: 9, purge: [-12, 245] },
  x1c: { id: 'x1c', name: 'Bambu Lab X1 Carbon', bed: [256, 256, 256], kin: 'corexy', accel: 10000, travelAccel: 10000, travel: 500, scv: 9, purge: [-12, 245] },
  mk4: { id: 'mk4', name: 'Prusa MK4S', bed: [250, 210, 220], kin: 'bedslinger', accel: 4000, travelAccel: 5000, travel: 300, scv: 8, purge: [5, -3] },
};
export const FILAMENTS = {
  petg: { id: 'petg', name: 'PETG', flow: 13, minLayerS: 12, minSpeed: 10, nozzleC: 255, bedC: 70, density: 1.25 },
  pla: { id: 'pla', name: 'PLA', flow: 21, minLayerS: 8, minSpeed: 20, nozzleC: 220, bedC: 55, density: 1.24 },
  silk: { id: 'silk', name: 'Silk PLA', flow: 15, minLayerS: 8, minSpeed: 20, nozzleC: 230, bedC: 55, density: 1.24 },
};
// Speeds (mm/s) and accelerations (mm/s^2) of Bambu's 0.20 mm Standard process.
const SPEED = { outer: 200, inner: 300, sparse: 270, solid: 250, top: 200, bottom: 250 };
const ACCEL = { outer: 5000, inner: 0, sparse: 0, solid: 0, top: 2000, bottom: 0 };   // 0 = printer default
const FIRST = { speed: 50, infill: 105, accel: 500 };
const LAYER_CHANGE_S = 0.35, RETRACT_S = 0.07, RETRACT_MIN_MM = 2;
export const CHANGE_S = { ams: 105, manual: 150 };   // AMS unload + load + flush + wipe; M600 (the user swaps)

/**
 * A printer for the motion model: an id, one of PRINTERS, or the print dialog's preset
 * ({ id, name, bed: { x, y, z }, kinematics, speed (time factor vs a Bambu A1) }). A preset we have
 * no motion numbers for gets a generic bed slinger slowed by its time factor.
 */
export function resolvePrinter(p) {
  if (!p) return PRINTERS.a2l;
  if (typeof p === 'string') return PRINTERS[p] || Object.values(PRINTERS).find(x => x.name === p) || PRINTERS.a2l;
  const known = PRINTERS[p.id];
  let base = known || PRINTERS.a2l;
  if (!known) {
    const k = Math.max(1, +p.speed || 1.5);
    base = { ...base, id: p.id || 'custom', accel: Math.round(6000 / (k * k)), travelAccel: Math.round(8000 / (k * k)), travel: Math.round(500 / k), speedScale: 1 / k };
  }
  const bed = Array.isArray(p.bed) ? p.bed : p.bed && typeof p.bed === 'object' ? [p.bed.x, p.bed.y, p.bed.z] : base.bed;
  const kin = p.kin || (p.kinematics === 'corexy' ? 'corexy' : p.kinematics ? 'bedslinger' : base.kin);
  return { ...base, ...p, bed, kin, purge: p.purge || base.purge };
}

const hexOf = c => {
  if (typeof c === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toUpperCase();
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const v = m[1].split(',').map(Number); return '#' + v.slice(0, 3).map(x => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase(); }
  }
  if (Array.isArray(c)) { const s = c.some(x => x > 1) ? 1 : 255; return '#' + c.slice(0, 3).map(x => Math.round(x * s).toString(16).padStart(2, '0')).join('').toUpperCase(); }
  return '#F2F0EA';
};
const pct = v => typeof v === 'number' ? (v > 1 ? v / 100 : v) : typeof v === 'string' ? parseFloat(v) / 100 : NaN;

// ------------------------------------------------------------------------------ growable arrays
class Grow {
  constructor(T, n = 4096) { this.T = T; this.a = new T(n); this.n = 0; }
  push(...v) { if (this.n + v.length > this.a.length) this.grow(this.n + v.length); for (const x of v) this.a[this.n++] = x; }
  grow(need) { const b = new this.T(Math.max(need, this.a.length * 2)); b.set(this.a.subarray(0, this.n)); this.a = b; }
  done() { return this.a.slice(0, this.n); }
}

// ------------------------------------------------------------------------------ yield (keeps UI alive)
let port = null, recv = null; const waiting = [];
function yieldNow() {
  if (typeof MessageChannel === 'undefined') return new Promise(r => setTimeout(r, 0));
  if (!port) {
    const ch = new MessageChannel(); recv = ch.port1; port = ch.port2;
    // node: the port holds the process open only while a yield is pending
    recv.onmessage = () => { waiting.shift()?.(); if (!waiting.length) recv.unref?.(); };
  }
  recv.ref?.();
  return new Promise(r => { waiting.push(r); port.postMessage(0); });
}

// ------------------------------------------------------------------------------ slicing
function meshBox(P) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  return { lo, hi };
}

/** Triangle indices per layer (CSR): layer k's plane at zc(k) cuts triangles with zmin <= zc < zmax. */
function bucketTriangles(P, I, nL, zc0, h) {
  const nT = I.length / 3, cnt = new Int32Array(nL + 1), span = new Int32Array(nT * 2);
  for (let t = 0; t < nT; t++) {
    const a = P[I[3 * t] * 3 + 2], b = P[I[3 * t + 1] * 3 + 2], c = P[I[3 * t + 2] * 3 + 2];
    const lo = Math.min(a, b, c), hi = Math.max(a, b, c);
    let k0 = Math.max(0, Math.ceil((lo - zc0) / h - 1e-9)), k1 = Math.min(nL - 1, Math.floor((hi - zc0) / h - 1e-9));
    // strict: plane must lie inside [lo, hi)
    while (k0 <= k1 && zc0 + k0 * h < lo) k0++;
    while (k1 >= k0 && zc0 + k1 * h >= hi) k1--;
    span[2 * t] = k0; span[2 * t + 1] = k1;
    for (let k = k0; k <= k1; k++) cnt[k + 1]++;
  }
  for (let k = 0; k < nL; k++) cnt[k + 1] += cnt[k];
  const list = new Int32Array(cnt[nL]), fill = cnt.slice(0, nL);
  for (let t = 0; t < nT; t++) for (let k = span[2 * t]; k <= span[2 * t + 1]; k++) list[fill[k]++] = t;
  return { start: cnt, list };
}

/** Cross-section of triangles `tris` at height z as segments [x1, y1, x2, y2, ...]. */
function sliceSegments(P, I, tris, t0, t1, z, out) {
  out.n = 0;
  for (let q = t0; q < t1; q++) {
    const t = tris[q], ia = I[3 * t] * 3, ib = I[3 * t + 1] * 3, ic = I[3 * t + 2] * 3;
    const za = P[ia + 2] - z, zb = P[ib + 2] - z, zc = P[ic + 2] - z;
    const pts = [];
    const edge = (i, j, zi, zj) => {
      if ((zi < 0) !== (zj < 0)) { const s = zi / (zi - zj); pts.push(P[i] + (P[j] - P[i]) * s, P[i + 1] + (P[j + 1] - P[i + 1]) * s); }
    };
    edge(ia, ib, za, zb); edge(ib, ic, zb, zc); edge(ic, ia, zc, za);
    if (pts.length === 4) out.push(pts[0], pts[1], pts[2], pts[3]);
  }
  return out;
}

/** Even-odd scanline fill of closed segment loops into a Uint8 bitmap on the grid. */
function fillSegments(seg, n, g, bmp) {
  const { w, h, px, x0, y0 } = g;
  bmp.fill(0);
  const cnt = new Int32Array(h + 1);
  const rowsOf = (ya, yb) => {
    const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
    return [Math.max(0, Math.ceil((lo - y0) / px - 0.5)), Math.min(h - 1, Math.ceil((hi - y0) / px - 0.5) - 1)];
  };
  for (let s = 0; s < n; s += 4) {
    if (seg[s + 1] === seg[s + 3]) continue;
    const [j0, j1] = rowsOf(seg[s + 1], seg[s + 3]);
    for (let j = j0; j <= j1; j++) cnt[j + 1]++;
  }
  for (let j = 0; j < h; j++) cnt[j + 1] += cnt[j];
  const xs = new Float64Array(cnt[h]), at = cnt.slice(0, h);
  for (let s = 0; s < n; s += 4) {
    const xa = seg[s], ya = seg[s + 1], xb = seg[s + 2], yb = seg[s + 3];
    if (ya === yb) continue;
    const [j0, j1] = rowsOf(ya, yb);
    for (let j = j0; j <= j1; j++) { const yc = y0 + (j + 0.5) * px; xs[at[j]++] = xa + (yc - ya) * (xb - xa) / (yb - ya); }
  }
  for (let j = 0; j < h; j++) {
    const row = xs.subarray(cnt[j], cnt[j + 1]);
    if (row.length < 2) continue;
    row.sort();
    for (let q = 0; q + 1 < row.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((row[q] - x0) / px - 0.5)), i1 = Math.min(w - 1, Math.ceil((row[q + 1] - x0) / px - 0.5) - 1);
      if (i1 >= i0) bmp.fill(1, j * w + i0, j * w + i1 + 1);
    }
  }
  return bmp;
}

/**
 * Signed distance (mm) for the walls and infill: inside pixels get their distance to the nearest
 * outside pixel (exact Euclidean, Felzenszwalb-Huttenlocher, minus half a pixel as in mesh.js sdfOf),
 * outside pixels get -half a pixel. Only the inside matters here, so this is half of sdfOf's work.
 */
function insideDistance(bmp, w, h, px) {
  const BIG = 1e20, N = w * h, f = new Float32Array(N);
  for (let o = 0; o < N; o++) f[o] = bmp[o] ? BIG : 0;
  const n = Math.max(w, h), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), g = new Float64Array(n);
  const pass = len => {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let r = v[k], s = ((g[q] + q * q) - (g[r] + r * r)) / (2 * q - 2 * r);
      while (s <= z[k]) { k--; r = v[k]; s = ((g[q] + q * q) - (g[r] + r * r)) / (2 * q - 2 * r); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + g[r]; }
  };
  for (let i = 0; i < w; i++) {
    let any = false;
    for (let j = 0; j < h; j++) { g[j] = f[j * w + i]; if (g[j]) any = true; }
    if (!any) continue;                       // an empty column stays 0
    pass(h);
    for (let j = 0; j < h; j++) f[j * w + i] = d[j];
  }
  for (let j = 0; j < h; j++) {
    const o = j * w;
    let any = false;
    for (let i = 0; i < w; i++) { g[i] = f[o + i]; if (bmp[o + i]) any = true; }
    if (!any) { for (let i = 0; i < w; i++) f[o + i] = -0.5 * px; continue; }
    pass(w);
    for (let i = 0; i < w; i++) f[o + i] = bmp[o + i] ? (Math.sqrt(d[i]) - 0.5) * px : -0.5 * px;
  }
  return f;
}

function hashBitmap(b) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < b.length; i += 7) h = Math.imul(h ^ (b[i] + (i & 255)), 16777619) >>> 0;
  let ones = 0; for (let i = 0; i < b.length; i++) ones += b[i];
  return h + ':' + ones;
}

const ringsOf = polys => { const r = []; for (const p of polys) { r.push(p.outer); for (const hl of p.holes) r.push(hl); } return r; };

// ------------------------------------------------------------------------------ path planning
/** Walls: rings at lineW*(k + .5) inside. Returns [{ ring, k }] (k = 0 outer). */
function wallRings(sd, g, walls, lineW) {
  const out = [];
  for (let k = walls - 1; k >= 0; k--) {
    const d = lineW * (k + 0.5), data = new Float32Array(sd.length);
    for (let i = 0; i < sd.length; i++) data[i] = sd[i] - d;
    const polys = contours({ w: g.w, h: g.h, data, mmPerPx: g.px, x0: g.x0, y0: g.y0, band: 50 }, { simplifyMm: Math.max(0.02, g.px * 0.35), minAreaMm2: 0.03 });
    for (const r of ringsOf(polys)) out.push({ ring: r, k });
  }
  return out;
}

/** Rectilinear infill lines over pixels where sel(i) is true: runs [x0, y0, x1, y1] along angle a. */
function infillRuns(g, sel, angle, spacing, phase) {
  const { w, h, px, x0, y0 } = g;
  const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
  const X1 = x0 + w * px, Y1 = y0 + h * px;
  const corners = [[x0, y0], [X1, y0], [x0, Y1], [X1, Y1]];
  let cLo = Infinity, cHi = -Infinity, tLo = Infinity, tHi = -Infinity;
  for (const [x, y] of corners) { const c = x * nx + y * ny, t = x * dx + y * dy; cLo = Math.min(cLo, c); cHi = Math.max(cHi, c); tLo = Math.min(tLo, t); tHi = Math.max(tHi, t); }
  const lines = [];
  const step = px * 0.9;
  for (let c = Math.ceil((cLo - phase) / spacing) * spacing + phase; c <= cHi; c += spacing) {
    const runs = [];
    let on = false, ts = 0;
    for (let t = tLo; t <= tHi + step; t += step) {
      const x = c * nx + t * dx, y = c * ny + t * dy;
      const i = Math.floor((x - x0) / px), j = Math.floor((y - y0) / px);
      const v = i >= 0 && j >= 0 && i < w && j < h && sel(j * w + i);
      if (v && !on) { on = true; ts = t; } else if (!v && on) { on = false; if (t - step - ts > spacing * 0.15 + 0.3) runs.push([ts, t - step]); }
    }
    if (runs.length) lines.push(runs.map(([a, b]) => [c * nx + a * dx, c * ny + a * dy, c * nx + b * dx, c * ny + b * dy]));
  }
  // boustrophedon: every other line reversed, runs in travel order
  const out = [];
  lines.forEach((runs, li) => {
    const seq = li % 2 ? runs.slice().reverse().map(r => [r[2], r[3], r[0], r[1]]) : runs;
    for (const r of seq) out.push(r);
  });
  return out;
}

// ------------------------------------------------------------------------------ motion model
/**
 * Time of a polyline (flat [x, y, ...]) at vmax with acceleration a, starting and ending at rest,
 * corners limited by junction deviation (square-corner velocity scv). Returns per-segment times.
 */
export function polylineTimes(pts, vmax, a, scv) {
  const m = pts.length / 2 - 1;
  const times = new Float64Array(Math.max(0, m));
  if (m <= 0) return times;
  const L = new Float64Array(m), vj = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) L[i] = Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
  const k = scv * scv * (Math.SQRT2 - 1);
  for (let i = 1; i < m; i++) {
    const ux = (pts[2 * i] - pts[2 * i - 2]) / (L[i - 1] || 1), uy = (pts[2 * i + 1] - pts[2 * i - 1]) / (L[i - 1] || 1);
    const wx = (pts[2 * i + 2] - pts[2 * i]) / (L[i] || 1), wy = (pts[2 * i + 3] - pts[2 * i + 1]) / (L[i] || 1);
    const cos = -(ux * wx + uy * wy);
    if (cos > 0.9999) { vj[i] = 0; continue; }
    if (cos < -0.9999) { vj[i] = vmax; continue; }
    const sh = Math.sqrt(0.5 * (1 - cos));
    vj[i] = Math.min(vmax, Math.sqrt(k * sh / (1 - sh)));
  }
  vj[0] = 0; vj[m] = 0;
  for (let i = m - 1; i >= 0; i--) vj[i] = Math.min(vj[i], Math.sqrt(vj[i + 1] * vj[i + 1] + 2 * a * L[i]));
  for (let i = 0; i < m; i++) vj[i + 1] = Math.min(vj[i + 1], Math.sqrt(vj[i] * vj[i] + 2 * a * L[i]));
  for (let i = 0; i < m; i++) times[i] = segTime(L[i], vj[i], vj[i + 1], vmax, a);
  return times;
}
export function segTime(L, ve, vx, vmax, a) {
  if (L <= 0) return 0;
  const vp = Math.min(vmax, Math.sqrt(Math.max(0, (2 * a * L + ve * ve + vx * vx) / 2)));
  const dAcc = (vp * vp - ve * ve) / (2 * a), dDec = (vp * vp - vx * vx) / (2 * a);
  return Math.max(0, (vp - ve) / a) + Math.max(0, (vp - vx) / a) + Math.max(0, L - dAcc - dDec) / vp;
}

// ------------------------------------------------------------------------------ main
/**
 * @param parts  [{ name, mesh: { positions, indices }, color }] in print coordinates (mm, Z up)
 * @param opts   { printer, filament: 'petg'|'pla', layerMm 0.2, lineMm 0.42, walls, infill (0..1 or '15%'),
 *                 top 5, bottom 3, settings (buildProduct's), colorChangeAtMm, colors: { base, ink },
 *                 changeMode: 'ams'|'manual', onProgress(f), signal, maxPx }
 */
export async function buildToolpath(parts, opts = {}) {
  const T0 = performance.now();
  const set = opts.settings || {};
  const printer = resolvePrinter(opts.printer);
  const fil = FILAMENTS[(opts.filament || 'petg').toLowerCase()] || FILAMENTS.petg;
  const H = opts.layerMm || set.layer || 0.2, W = opts.lineMm || 0.42;
  const walls = opts.walls ?? set.walls ?? 2;
  let dens = pct(opts.infill ?? set.infill ?? 0.15); if (!(dens >= 0)) dens = 0.15;
  const topN = opts.top ?? 5, botN = opts.bottom ?? 3;
  const vCap = fil.flow / (W * H);
  const changeAt = opts.colorChangeAtMm ?? set.colorChangeAtMm;
  const col = opts.colors || {};
  const baseHex = col.base || col.plate || col.background, inkHex = col.ink || col.line;

  // parts, bounds, global layers
  const P = parts.filter(p => p?.mesh?.positions?.length).map((p, i) => {
    const pos = p.mesh.positions, idx = p.mesh.indices || Uint32Array.from({ length: pos.length / 3 }, (_, k) => k);
    return { i, name: p.name || `Part ${i + 1}`, pos, idx, box: meshBox(pos), color: hexOf(p.color) };
  });
  if (!P.length) throw new Error('buildToolpath: no meshes');
  let box = { lo: [Infinity, Infinity, 0], hi: [-Infinity, -Infinity, 0] };
  const unionBox = () => {
    box = { lo: [Infinity, Infinity, 0], hi: [-Infinity, -Infinity, 0] };
    for (const p of P) for (let k = 0; k < 3; k++) { box.lo[k] = Math.min(box.lo[k], p.box.lo[k]); box.hi[k] = Math.max(box.hi[k], p.box.hi[k]); }
  };
  unionBox();
  // like a slicer, the layout goes to the middle of the plate (opts.center = false keeps it as is)
  if (opts.center !== false) {
    const dx = printer.bed[0] / 2 - (box.lo[0] + box.hi[0]) / 2, dy = printer.bed[1] / 2 - (box.lo[1] + box.hi[1]) / 2;
    for (const p of P) {
      const q = new Float32Array(p.pos.length);
      for (let i = 0; i < q.length; i += 3) { q[i] = p.pos[i] + dx; q[i + 1] = p.pos[i + 1] + dy; q[i + 2] = p.pos[i + 2]; }
      p.pos = q; p.box = meshBox(q);
    }
    unionBox();
  }
  const zBase = box.lo[2];
  const nL = Math.max(1, Math.round((box.hi[2] - zBase) / H));
  const zc0 = zBase + H / 2 + 1e-5;

  // colours: layer mode (single extruder, M600/AMS swap at a height) or by part
  const palette = [], pal = hex => { const hx = hexOf(hex); let i = palette.indexOf(hx); if (i < 0) { i = palette.length; palette.push(hx); } return i; };
  const layerMode = Number.isFinite(changeAt) && changeAt > zBase;
  const lower = layerMode ? pal(baseHex || P[0].color) : 0;
  const upper = layerMode ? pal(inkHex || (P.find(p => /line|ink|relief/i.test(p.name)) || P[P.length - 1]).color) : 0;
  const partCol = P.map(p => pal(p.color));
  const colourOf = (part, z) => layerMode ? (z > changeAt + 1e-6 ? upper : lower) : partCol[part.i];

  // per-part grids and triangle buckets
  const maxPx = opts.maxPx || 1.5e6;
  for (const p of P) {
    const wmm = p.box.hi[0] - p.box.lo[0] + 2, hmm = p.box.hi[1] - p.box.lo[1] + 2;
    const layers = Math.max(1, (p.box.hi[2] - p.box.lo[2]) / H);
    const budget = layers > 150 ? Math.min(maxPx, 1.1e5) : maxPx;
    const px = Math.min(0.2, Math.max(0.09, Math.sqrt(wmm * hmm / budget)));
    p.g = { px, x0: p.box.lo[0] - 1, y0: p.box.lo[1] - 1, w: Math.ceil(wmm / px), h: Math.ceil(hmm / px) };
    p.buckets = bucketTriangles(p.pos, p.idx, nL, zc0, H);
    p.solidAll = dens >= 0.99;
  }

  // pass 1 (parts with sparse infill): inside bitmaps of every layer, for the top/bottom skins
  const seg = new Grow(Float64Array, 1 << 14);
  const inside = new Map();   // part.i -> [Uint8Array | null per layer]
  for (const p of P) {
    if (p.solidAll) continue;
    const arr = new Array(nL).fill(null), hashes = new Array(nL).fill(null);
    for (let k = 0; k < nL; k++) {
      const s = p.buckets.start;
      if (s[k + 1] === s[k]) continue;
      sliceSegments(p.pos, p.idx, p.buckets.list, s[k], s[k + 1], zc0 + k * H, seg);
      arr[k] = fillSegments(seg.a, seg.n, p.g, new Uint8Array(p.g.w * p.g.h));
      // identical layers share one bitmap (2.5D parts): saves memory and marks uniform stacks
      const hs = hashBitmap(arr[k]);
      if (k && hashes[k - 1] === hs) arr[k] = arr[k - 1];
      hashes[k] = hs;
    }
    inside.set(p.i, arr);
  }

  // output buffers
  const B = { p: new Grow(Float32Array, 1 << 16), t: new Grow(Float32Array, 1 << 15), c: new Grow(Uint8Array, 1 << 14), k: new Grow(Uint8Array, 1 << 14), l: new Grow(Uint32Array, 1 << 14) };
  const M = { x: new Grow(Float32Array, 1 << 15), y: new Grow(Float32Array, 1 << 15), z: new Grow(Float32Array, 1 << 15), t: new Grow(Float64Array, 1 << 15), k: new Grow(Uint8Array, 1 << 15) };
  const byFeature = Object.fromEntries(FEATURES.map(f => [f, 0]));
  let clock = 0, nx = printer.bed[0] / 2, ny = printer.bed[1] / 2, nz = zBase + 5, extruded = 0, lastColour = -1;
  const layers = [], changes = [];
  const move = (x, y, z, dt, k) => { clock += dt; nx = x; ny = y; nz = z; M.x.push(x); M.y.push(y); M.z.push(z); M.t.push(clock); M.k.push(k); byFeature[FEATURES[k]] += dt; };
  const travel = (x, y, z) => {
    const L = Math.hypot(x - nx, y - ny);
    if (L < 1e-6 && Math.abs(z - nz) < 1e-6) return;
    const dt = segTime(L, 0, 0, printer.travel, printer.travelAccel) + (L > RETRACT_MIN_MM ? RETRACT_S : 0);
    move(x, y, z, dt, F.travel);
  };
  let layerIdx = 0, colourNow = 0, slowed = 0;
  // extrude a polyline (flat xy) at height z; time from the motion model, scaled later for cooling
  const extrude = (pts, z, feat, first) => {
    const n = pts.length / 2;
    if (n < 2) return;
    travel(pts[0], pts[1], z);
    const spd = Math.min(vCap, first ? (feat === F.sparse || feat === F.solid || feat === F.bottom ? FIRST.infill : FIRST.speed) : SPEED[FEATURES[feat]]) * (printer.speedScale || 1);
    const acc = first ? FIRST.accel : (ACCEL[FEATURES[feat]] || printer.accel);
    const times = polylineTimes(pts, spd, acc, printer.scv);
    for (let i = 0; i < n - 1; i++) {
      const x0 = pts[2 * i], y0 = pts[2 * i + 1], x1 = pts[2 * i + 2], y1 = pts[2 * i + 3];
      const t0 = clock;
      move(x1, y1, z, times[i], feat);
      B.p.push(x0, y0, z, x1, y1, z); B.t.push(t0, clock); B.c.push(colourNow); B.k.push(feat); B.l.push(layerIdx);
      extruded += Math.hypot(x1 - x0, y1 - y0);
    }
  };
  const closeRing = r => { const o = new Float64Array(r.length + 2); o.set(r); o[r.length] = r[0]; o[r.length + 1] = r[1]; return o; };
  // start the ring at the vertex nearest the nozzle (the seam)
  const rotateRing = r => {
    const n = r.length / 2; let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = (r[2 * i] - nx) ** 2 + (r[2 * i + 1] - ny) ** 2; if (d < bd) { bd = d; best = i; } }
    if (!best) return r;
    const o = new Float64Array(r.length); o.set(r.subarray(2 * best)); o.set(r.subarray(0, 2 * best), r.length - 2 * best); return o;
  };
  const nearestFirst = items => {
    const out = [], left = items.slice();
    while (left.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < left.length; i++) { const b = left[i].box; const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; const d = (cx - nx) ** 2 + (cy - ny) ** 2; if (d < bd) { bd = d; bi = i; } }
      out.push(left.splice(bi, 1)[0]);
    }
    return out;
  };
  const ringBox = r => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); c = Math.max(c, r[i]); b = Math.min(b, r[i + 1]); d = Math.max(d, r[i + 1]); } return [a, b, c, d]; };

  const cache = new Map();   // part.i -> { hash, sd, rings }
  const bmpScratch = new Map();
  let tYield = performance.now();
  for (let k = 0; k < nL; k++) {
    if (opts.signal?.aborted) throw Object.assign(new Error('Toolpath cancelled'), { code: 'aborted' });
    layerIdx = k;
    const z = zBase + (k + 1) * H, first = k === 0;
    const L0 = { z, t0: clock, bead0: B.t.n / 2, move0: M.t.n, parts: 0 };
    const mStart = M.t.n;
    // layer change (not before the first layer)
    if (k) { clock += LAYER_CHANGE_S; }
    const order = P.slice().sort((a, b) => (colourOf(a, z) === lastColour ? 0 : 1) - (colourOf(b, z) === lastColour ? 0 : 1));
    for (const p of order) {
      const s = p.buckets.start;
      if (s[k + 1] === s[k]) continue;
      const colour = colourOf(p, z);
      if (lastColour >= 0 && colour !== lastColour) {
        // filament change: to the purge chute, swap and purge, back
        const cz = z + 3, [px_, py_] = printer.purge;
        const c0 = clock;
        travel(nx, ny, cz); travel(px_, py_, cz);
        move(px_, py_, cz, CHANGE_S[opts.changeMode || 'ams'] || CHANGE_S.ams, F.pause);
        changes.push({ layer: k, z, t0: c0, t1: clock, from: palette[lastColour], to: palette[colour] });
      }
      lastColour = colourNow = colour;
      // cross section
      let bmp;
      if (p.solidAll) {
        sliceSegments(p.pos, p.idx, p.buckets.list, s[k], s[k + 1], zc0 + k * H, seg);
        bmp = bmpScratch.get(p.i) || new Uint8Array(p.g.w * p.g.h); bmpScratch.set(p.i, bmp);
        fillSegments(seg.a, seg.n, p.g, bmp);
      } else bmp = inside.get(p.i)[k];
      if (!bmp) continue;
      L0.parts++;
      const hsh = hashBitmap(bmp);
      let ent = cache.get(p.i);
      if (!ent || ent.hash !== hsh) {
        const sd = insideDistance(bmp, p.g.w, p.g.h, p.g.px);
        ent = { hash: hsh, sd, rings: wallRings(sd, p.g, walls, W) };
        cache.set(p.i, ent);
      }
      const sd = ent.sd;
      // walls: inner first, outer last (Bambu's inner/outer order), islands nearest first
      for (let wk = walls - 1; wk >= 0; wk--) {
        const items = ent.rings.filter(r => r.k === wk).map(r => ({ ring: r.ring, box: ringBox(r.ring) }));
        for (const it of nearestFirst(items)) extrude(closeRing(rotateRing(it.ring)), z, wk ? F.inner : F.outer, first);
      }
      // infill region: deeper than the walls (with 15 % overlap)
      const inset = W * walls - 0.15 * W;
      const angle = (k % 2 ? -1 : 1) * Math.PI / 4;
      let solidSel, sparseSel = null, solidFeat = F.solid;
      if (p.solidAll) {
        solidSel = o => sd[o] > inset;
        solidFeat = first ? F.bottom : F.solid;
      } else {
        const arr = inside.get(p.i);
        const isSolid = o => {
          for (let d = 1; d <= botN; d++) { const b = arr[k - d]; if (!b || !b[o]) return true; }
          for (let d = 1; d <= topN; d++) { const b = arr[k + d]; if (!b || !b[o]) return true; }
          return false;
        };
        const region = new Uint8Array(bmp.length);   // 0 none, 1 sparse, 2 solid, 3 top
        let nSolid = 0, nTop = 0;
        const same = d => arr[k + d] === bmp;
        let uniform = true;
        for (let d = -botN; d <= topN && uniform; d++) if (d && !same(d)) uniform = false;
        if (uniform) {   // inside a stack of identical layers: no skin anywhere
          for (let o = 0; o < bmp.length; o++) if (sd[o] > inset) region[o] = dens > 0 ? 1 : 0;
        } else {
          for (let o = 0; o < bmp.length; o++) {
            if (!(sd[o] > inset)) continue;
            if (isSolid(o)) { if (!arr[k + 1]?.[o]) { region[o] = 3; nTop++; } else { region[o] = 2; nSolid++; } } else region[o] = dens > 0 ? 1 : 0;
          }
        }
        solidSel = o => region[o] === 2;
        const topSel = o => region[o] === 3;
        sparseSel = o => region[o] === 1;
        if (nTop) for (const r of infillRuns(p.g, topSel, angle, W, 0)) extrude(Float64Array.of(...r), z, F.top, first);
        if (nSolid) for (const r of infillRuns(p.g, solidSel, angle, W, 0)) extrude(Float64Array.of(...r), z, first ? F.bottom : F.solid, first);
        solidSel = null;
      }
      if (solidSel) for (const r of infillRuns(p.g, solidSel, angle, W, 0)) extrude(Float64Array.of(...r), z, solidFeat, first);
      if (sparseSel && dens > 0) {
        // grid: both directions every layer, anchored to the bed so lines stack
        const sp = 2 * W / dens;
        for (const a of [Math.PI / 4, -Math.PI / 4]) for (const r of infillRuns(p.g, sparseSel, a, sp, 0)) extrude(Float64Array.of(...r), z, F.sparse, first);
      }
    }
    // cooling: a layer shorter than the minimum layer time is printed slower (not below minSpeed)
    const printed = clock - L0.t0 - (k ? LAYER_CHANGE_S : 0);
    const minS = fil.minLayerS;
    // (a layer with a filament change already takes minutes, so it is never slowed)
    if (printed > 0 && printed < minS && M.t.n > mStart) {
      const f = Math.min(minS / printed, vCap / fil.minSpeed);
      const base = L0.t0 + (k ? LAYER_CHANGE_S : 0);
      const fix = t => base + (t - base) * f;   // stretch the layer's moves and beads from its start
      for (let i = mStart; i < M.t.n; i++) M.t.a[i] = fix(M.t.a[i]);
      for (let i = L0.bead0 * 2; i < B.t.n; i++) B.t.a[i] = fix(B.t.a[i]);
      clock = fix(clock);
      slowed += clock - base - printed;
    }
    Object.assign(L0, { t1: clock, bead1: B.t.n / 2, move1: M.t.n });
    layers.push(L0);
    if (performance.now() - tYield > 30) { tYield = performance.now(); opts.onProgress?.((k + 1) / nL); await yieldNow(); }
  }
  // park: lift and move clear of the part like the end G-code
  travel(nx, ny, Math.min(printer.bed[2], nz + 10));
  travel(printer.bed[0] * 0.2, printer.bed[1] * 0.85, nz);

  const beads = { n: B.t.n / 2, p: B.p.done(), t: B.t.done(), c: B.c.done(), k: B.k.done(), l: B.l.done() };
  const track = { n: M.t.n, x: M.x.done(), y: M.y.done(), z: M.z.done(), t: M.t.done(), k: M.k.done() };
  const filamentMm = extruded * W * H / (Math.PI * 0.875 * 0.875);
  opts.onProgress?.(1);
  return {
    layers, beads, track, palette, changes, total: clock, printer, filament: fil,
    layerMm: H, lineMm: W, zBase, box: { lo: [box.lo[0], box.lo[1], zBase], hi: [box.hi[0], box.hi[1], zBase + nL * H] },
    parts: P.map(p => ({ name: p.name, color: p.color, px: p.g.px })),
    stats: {
      layers: nL, beads: beads.n, moves: track.n, extrudedMm: extruded, filamentMm,
      grams: filamentMm * Math.PI * 0.875 * 0.875 / 1000 * fil.density, ms: performance.now() - T0, byFeature,
      colourChanges: changes.length, walls, infill: dens, coolingSlowdownS: slowed,
    },
  };
}

/** Index of the last track move ending at or before time t (binary search). */
export function moveAt(track, t) {
  let lo = 0, hi = track.n - 1;
  if (hi < 0 || t < track.t[0]) return -1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (track.t[m] <= t) lo = m; else hi = m - 1; }
  return lo;
}

/** Nozzle position at print time t: [x, y, z, featureIndex]. */
export function nozzleAt(tp, t, start) {
  const tr = tp.track, i = moveAt(tr, t);
  const s = start || [tp.printer.bed[0] / 2, tp.printer.bed[1] / 2, tp.zBase + 5];
  if (i >= tr.n - 1) return [tr.x[tr.n - 1], tr.y[tr.n - 1], tr.z[tr.n - 1], 0];
  const ax = i < 0 ? s[0] : tr.x[i], ay = i < 0 ? s[1] : tr.y[i], az = i < 0 ? s[2] : tr.z[i], ta = i < 0 ? 0 : tr.t[i];
  const j = i + 1, tb = tr.t[j];
  const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 1;
  return [ax + (tr.x[j] - ax) * f, ay + (tr.y[j] - ay) * f, az + (tr.z[j] - az) * f, tr.k[j]];
}

/** Layer index being printed at time t (0-based), clamped. */
export function layerAt(tp, t) {
  const L = tp.layers;
  let lo = 0, hi = L.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L[m].t0 <= t) lo = m; else hi = m - 1; }
  return lo;
}

/**
 * Film clock -> print clock. The film opens on the empty plate (intro), prints with a speed that
 * ramps from about 8x real time (the first perimeters are readable) to whatever fits, gives the
 * first colour change its own slot (the pause is shown, not skipped), and holds the finished part
 * (outro). Deterministic: frame i always maps to the same print time.
 *   filmTimeMap(tp, { seconds, fps }) -> { frames, fps, D, intro, outro, slot, at(i) -> { t, phase, u } }
 */
export function filmTimeMap(tp, { seconds = 15, fps = 30 } = {}) {
  const frames = Math.max(1, Math.round(seconds * fps)), D = frames / fps;
  const intro = Math.min(1.0, D * 0.06), outro = Math.max(1.6, D * 0.16);
  const featured = tp.changes?.[0] || null;
  const slot = featured ? Math.min(1.4, D * 0.08) : 0;
  const P = Math.max(0.5, D - intro - outro - slot);
  const pauseDur = featured ? featured.t1 - featured.t0 : 0;
  const active = Math.max(1e-3, tp.total - pauseDur);
  const ramp = 0.3 * P;
  const r0 = Math.min(8, active / P);
  let r1 = (active - r0 * ramp / 2) / (P - ramp / 2);
  if (!(r1 >= r0)) r1 = r0;
  const warp = s => {
    if (s <= 0) return 0;
    if (s <= ramp) { const x = s / ramp; return r0 * s + (r1 - r0) * ramp * (x * x * x - x * x * x * x / 2); }
    return Math.min(active, r0 * s + (r1 - r0) * (s - ramp / 2));
  };
  let sc = P;
  if (featured) {   // film second (inside the print phase) where the pause starts
    let lo = 0, hi = P;
    for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (warp(m) < featured.t0) lo = m; else hi = m; }
    sc = hi;
  }
  const at = i => {
    const s = (i + 0.5) / fps;
    if (s < intro) return { t: 0, phase: 'intro', u: s / intro };
    const q = s - intro;
    if (q >= P + slot) return { t: tp.total, phase: 'outro', u: Math.min(1, (q - P - slot) / outro) };
    if (!featured || q < sc) return { t: warp(q), phase: 'print', u: q / (P + slot) };
    if (q < sc + slot) { const u = (q - sc) / slot; return { t: featured.t0 + u * pauseDur, phase: 'change', u }; }
    return { t: Math.min(tp.total, warp(q - slot) + pauseDur), phase: 'print', u: q / (P + slot) };
  };
  return { frames, fps, D, intro, outro, slot, P, r0, r1, at };
}

export function formatDuration(s, { seconds = false } = {}) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return seconds ? `${m} min ${String(ss).padStart(2, '0')} s` : `${m} min`;
  return `${ss} s`;
}
export function clock(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
