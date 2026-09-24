// 3D-print core: a Spiralist drawing -> printable, watertight meshes -> STL / 3MF.
//
// Pipeline (all in millimetres, print axes: X right, Y up = away from you on the bed, Z up):
//   lineMask(geom, opts)        the line rasterised at real print size as a signed distance field
//                               (mm, > 0 inside): widths clamped up to the printable minimum, gaps
//                               narrower than the minimum closed (merged), with a printability report
//   contours(mask)              marching squares at 0 -> simplified rings -> polygons with holes
//                               { outer: Float64Array [x,y,..] CCW, holes: [Float64Array CW], area }
//   extrudePolygons(polys, z0, z1)  earcut caps + side walls -> closed Mesh
//   heightfieldMesh(field, w, h, mmPerPx, zOf)  closed solid: relief top, flat bottom, four walls
//   merge(meshes), translate(mesh, dx, dy, dz), checkManifold(mesh), bounds(mesh)
//   writeSTL(mesh, name) -> ArrayBuffer (binary)
//   write3MF(parts, meta) -> Promise<Blob> (3MF core zip; one object per part inside one assembly
//                               object, so parts stay aligned and each can get its own filament)
//   lineSolid(geom, { sizeMm, z0, z1, ...lineMask opts }) -> { mesh, polys, mask, report } in one call
// Mask helpers for products: polylineMask (mm polylines), polygonMask, maskOp (union / subtract /
// intersect), offsetMask (grow / shrink, exact EDT), fillHoles, outerMask (silhouette stand-in:
// close + fill, convex hull fallback), padMask, countIslands, coverageField (lithophane thickness
// source, anti-aliased), shape polygons circlePoly / rectPoly / reverseRing.
// Files: writeSTL / readSTL, write3MF / write3MFBytes (+ Bambu per-part slots via bambuConfigs), zip.
// Printability defaults: PRINT_RULES (0.8 mm lines, 0.5 mm gaps, 0.6 mm raise, 0.2 mm layers).
//
// Mesh = { positions: Float32Array xyz (mm), indices: Uint32Array (3 per triangle, CCW = outward) }.
// Geometry in (js/spiral.js): STRIDE floats per point (x, y, w, ...) in circle units, y down.

import earcut from '../../vendor/earcut.mjs';
import { STRIDE } from '../spiral.js';

export const PRINT_RULES = Object.freeze({
  nozzleMm: 0.4, layerMm: 0.2,
  minWidthMm: 0.8,     // two perimeters
  minGapMm: 0.5,
  minRaiseMm: 0.6,     // three layers
});

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Pixel density for a print of `sizeMm`: 0.1 mm pixels, coarser only for very large plates. */
export function autoPxPerMm(sizeMm) {
  return Math.max(4, Math.min(10, 3000 / Math.max(1, sizeMm)));
}

// ============================================================================ masks (SDF grids)
// A mask is { w, h, data: Float32Array (signed distance in mm, > 0 inside, valid within `band` mm
// of the boundary, clamped to -band / +big beyond), mmPerPx, x0, y0, band }.
// Pixel (i, j) has its centre at (x0 + (i + .5) * mmPerPx, y0 + (j + .5) * mmPerPx); rows go UP in Y.

export function emptyMask(x0, y0, widthMm, heightMm, mmPerPx, band) {
  const w = Math.max(3, Math.ceil(widthMm / mmPerPx)), h = Math.max(3, Math.ceil(heightMm / mmPerPx));
  const data = new Float32Array(w * h).fill(-band);
  return { w, h, data, mmPerPx, x0, y0, band };
}

/** A bigger grid with padMm of outside all round (same pixels). */
export function padMask(mask, padMm) {
  const p = Math.max(1, Math.ceil(padMm / mask.mmPerPx));
  const w = mask.w + 2 * p, h = mask.h + 2 * p;
  const data = new Float32Array(w * h).fill(-mask.band);
  for (let j = 0; j < mask.h; j++) data.set(mask.data.subarray(j * mask.w, (j + 1) * mask.w), (j + p) * w + p);
  return { ...mask, w, h, data, x0: mask.x0 - p * mask.mmPerPx, y0: mask.y0 - p * mask.mmPerPx };
}

/** True when some pixel on the grid's border is inside (contours need an outside frame). */
function touchesBorder(m) {
  const { w, h, data } = m;
  for (let i = 0; i < w; i++) if (data[i] > 0 || data[(h - 1) * w + i] > 0) return true;
  for (let j = 0; j < h; j++) if (data[j * w] > 0 || data[j * w + w - 1] > 0) return true;
  return false;
}

/** Same grid, new data. */
function likeMask(m, data) { return { w: m.w, h: m.h, data, mmPerPx: m.mmPerPx, x0: m.x0, y0: m.y0, band: m.band }; }

/**
 * Stamp tapered round capsules along a polyline into the mask (max = union). X, Y in mm,
 * R = half widths in mm. Zero-length segments stamp discs.
 */
export function stampPolyline(mask, X, Y, R, n) {
  const { w, h, data, mmPerPx: s, x0, y0, band } = mask;
  const inv = 1 / s;
  for (let k = 0; k < Math.max(1, n - 1); k++) {
    const k1 = Math.min(n - 1, k + 1);
    const ax = X[k], ay = Y[k], bx = X[k1], by = Y[k1], ra = R[k], rb = R[k1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const reach = Math.max(ra, rb) + band;
    let i0 = Math.floor((Math.min(ax, bx) - reach - x0) * inv - 0.5), i1 = Math.ceil((Math.max(ax, bx) + reach - x0) * inv - 0.5);
    let j0 = Math.floor((Math.min(ay, by) - reach - y0) * inv - 0.5), j1 = Math.ceil((Math.max(ay, by) + reach - y0) * inv - 0.5);
    if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0; if (i1 > w - 1) i1 = w - 1; if (j1 > h - 1) j1 = h - 1;
    const invL2 = L2 > 1e-18 ? 1 / L2 : 0, dr = rb - ra;
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * s - ay;
      let o = j * w + i0;
      for (let i = i0; i <= i1; i++, o++) {
        const px = x0 + (i + 0.5) * s - ax;
        let t = (px * dx + py * dy) * invL2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - t * dx, qy = py - t * dy;
        const v = ra + t * dr - Math.sqrt(qx * qx + qy * qy);
        if (v > data[o]) data[o] = v;
      }
    }
  }
  return mask;
}

/** Squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in pixels^2, in place. */
function edt2(f, w, h) {
  const n = Math.max(w, h);
  const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), g = new Float64Array(n);
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let r = v[k], s = ((g[q] + q * q) - (g[r] + r * r)) / (2 * q - 2 * r);
      while (s <= z[k]) { k--; r = v[k]; s = ((g[q] + q * q) - (g[r] + r * r)) / (2 * q - 2 * r); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + g[r]; }
  };
  for (let i = 0; i < w; i++) {            // columns
    for (let j = 0; j < h; j++) g[j] = f[j * w + i];
    pass(h);
    for (let j = 0; j < h; j++) f[j * w + i] = d[j];
  }
  for (let j = 0; j < h; j++) {            // rows
    const o = j * w;
    for (let i = 0; i < w; i++) g[i] = f[o + i];
    pass(w);
    for (let i = 0; i < w; i++) f[o + i] = d[i];
  }
  return f;
}
const BIG = 1e20;

/**
 * Exact (pixel-quantised) signed distance of the set { data > 0 }, in mm: distance to the nearest
 * outside pixel inside, minus distance to the nearest inside pixel outside. Half a pixel is taken
 * off each side so the zero level sits between pixel centres, as the marching squares expects.
 */
export function sdfOf(mask) {
  const { w, h, data, mmPerPx: s } = mask;
  const N = w * h;
  const inD = new Float64Array(N), outD = new Float64Array(N);
  for (let o = 0; o < N; o++) { const a = data[o] > 0; inD[o] = a ? BIG : 0; outD[o] = a ? 0 : BIG; }
  edt2(inD, w, h); edt2(outD, w, h);
  const out = new Float32Array(N);
  for (let o = 0; o < N; o++) {
    out[o] = data[o] > 0 ? (Math.sqrt(inD[o]) - 0.5) * s : -(Math.sqrt(outD[o]) - 0.5) * s;
  }
  return likeMask(mask, out);
}

/** Grow (d > 0) or shrink (d < 0) the inside by d mm. */
export function offsetMask(mask, d) {
  const sd = sdfOf(mask);
  const o = sd.data;
  for (let k = 0; k < o.length; k++) o[k] += d;
  sd.band = Math.max(mask.band, Math.abs(d) + 2 * mask.mmPerPx);
  return sd;
}

/** Boolean on two masks of the same grid: 'union' | 'subtract' (a - b) | 'intersect'. */
export function maskOp(a, b, op) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('maskOp: masks on different grids');
  const out = new Float32Array(a.data.length), A = a.data, B = b.data;
  for (let k = 0; k < out.length; k++) {
    out[k] = op === 'union' ? Math.max(A[k], B[k]) : op === 'intersect' ? Math.min(A[k], B[k]) : Math.min(A[k], -B[k]);
  }
  return likeMask(a, out);
}

/** Fill every hole (outside region not connected to the grid border). */
export function fillHoles(mask) {
  const { w, h, data } = mask;
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  const push = o => { if (!seen[o] && !(data[o] > 0)) { seen[o] = 1; stack[sp++] = o; } };
  for (let i = 0; i < w; i++) { push(i); push((h - 1) * w + i); }
  for (let j = 0; j < h; j++) { push(j * w); push(j * w + w - 1); }
  while (sp) {
    const o = stack[--sp], i = o % w, j = (o / w) | 0;
    if (i > 0) push(o - 1); if (i < w - 1) push(o + 1); if (j > 0) push(o - w); if (j < h - 1) push(o + w);
  }
  const out = new Float32Array(data);
  const fillV = mask.mmPerPx;          // filled pixels: inside by one pixel (boundary stays smooth)
  for (let o = 0; o < out.length; o++) if (!seen[o] && !(out[o] > 0)) out[o] = fillV;
  return likeMask(mask, out);
}

/**
 * The drawing's outer boundary: grow by closeMm (bridges the gaps between lines), fill the holes,
 * shrink back. A stand-in silhouette for cutters and backing plates.
 */
export function outerMask(mask, closeMm = 4, { single = true, tries = 4 } = {}) {
  let r = closeMm, out = null;
  const grid = mask;
  const p = Math.max(1, Math.ceil((closeMm * 1.7 ** (tries - 1) + 1) / mask.mmPerPx));
  mask = padMask(mask, p * mask.mmPerPx);
  // back on the caller's grid (the silhouette never reaches past the drawing), so maskOp works
  const crop = m => {
    const data = new Float32Array(grid.w * grid.h);
    for (let j = 0; j < grid.h; j++) data.set(m.data.subarray((j + p) * m.w + p, (j + p) * m.w + p + grid.w), j * grid.w);
    return { ...likeMask(grid, data), band: m.band, closeMm: m.closeMm, hull: m.hull };
  };
  for (let k = 0; k < tries; k++, r *= 1.7) {
    out = offsetMask(fillHoles(offsetMask(mask, r)), -r);
    out.closeMm = r;
    if (!single || countIslands(out) <= 1) return crop(out);
  }
  // still in pieces: the convex hull of everything drawn
  const hull = convexHullOfMask(mask);
  out = polygonMask([{ outer: hull, holes: [] }], mask);
  out.closeMm = Infinity; out.hull = true;
  return crop(out);
}

/** Number of 4-connected inside regions. */
export function countIslands(mask) {
  const { w, h, data } = mask;
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let n = 0;
  for (let s0 = 0; s0 < w * h; s0++) {
    if (seen[s0] || !(data[s0] > 0)) continue;
    n++;
    let sp = 0; stack[sp++] = s0; seen[s0] = 1;
    while (sp) {
      const o = stack[--sp], i = o % w;
      const nb = [i > 0 ? o - 1 : -1, i < w - 1 ? o + 1 : -1, o - w, o + w];
      for (const q of nb) if (q >= 0 && q < w * h && !seen[q] && data[q] > 0) { seen[q] = 1; stack[sp++] = q; }
    }
  }
  return n;
}

/** Convex hull (CCW ring, mm) of the inside pixel centres, grown by half a pixel. */
export function convexHullOfMask(mask) {
  const { w, h, data, mmPerPx: s, x0, y0 } = mask;
  const pts = [];
  for (let j = 0; j < h; j++) {           // leftmost and rightmost inside pixel per row is enough
    let a = -1, b = -1;
    for (let i = 0; i < w; i++) if (data[j * w + i] > 0) { if (a < 0) a = i; b = i; }
    if (a >= 0) { pts.push([x0 + a * s, y0 + (j + 0.5) * s], [x0 + (b + 1) * s, y0 + (j + 0.5) * s]); }
  }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let k = pts.length - 1; k >= 0; k--) { const p = pts[k]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const hull = lo.slice(0, -1).concat(up.slice(0, -1));
  return Float64Array.from(hull.flat());
}

/** Mask of polygons (even-odd over all rings), exact SDF within the band. */
export function polygonMask(polys, grid) {
  const m = grid.data ? likeMask(grid, new Float32Array(grid.w * grid.h)) : emptyMask(grid.x0, grid.y0, grid.widthMm, grid.heightMm, grid.mmPerPx, grid.band ?? 1);
  const { w, h, mmPerPx: s, x0, y0 } = m;
  const rings = [];
  for (const p of polys) { rings.push(p.outer); for (const q of p.holes || []) rings.push(q); }
  // scanline parity per pixel centre
  const inside = new Uint8Array(w * h);
  const xs = [];
  for (let j = 0; j < h; j++) {
    const y = y0 + (j + 0.5) * s;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ya = r[2 * a + 1], yb = r[2 * b + 1];
        if ((ya > y) !== (yb > y)) xs.push(r[2 * a] + (y - ya) / (yb - ya) * (r[2 * b] - r[2 * a]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / s - 0.5)), i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / s - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * w + i] = 1;
    }
  }
  for (let o = 0; o < w * h; o++) m.data[o] = inside[o] ? 1 : -1;
  const sd = sdfOf(m);
  sd.band = m.band;
  return sd;
}

// ============================================================================ geometry -> mm
/**
 * Where a Spiralist geometry lands on the print, in mm (Y up). fit 'content' scales the drawn
 * line's extent (including its width) to sizeMm on its longer side; 'frame' maps the art square
 * [-1, 1]^2 to [0, sizeMm]^2.
 */
export function geomFrame(geom, { sizeMm = 150, fit = 'content', minWidthMm = 0 } = {}) {
  const { n, data } = geom;
  let x0 = -1, x1 = 1, y0 = -1, y1 = 1;
  if (fit === 'content') {
    x0 = y0 = Infinity; x1 = y1 = -Infinity;
    for (let i = 0, o = 0; i < n; i++, o += STRIDE) {
      const r = Math.max(0, data[o + 2]) / 2;
      if (data[o] - r < x0) x0 = data[o] - r; if (data[o] + r > x1) x1 = data[o] + r;
      if (data[o + 1] - r < y0) y0 = data[o + 1] - r; if (data[o + 1] + r > y1) y1 = data[o + 1] + r;
    }
  }
  const span = Math.max(1e-9, x1 - x0, y1 - y0);
  // lines thinner than the printable minimum grow by up to minWidthMm / 2 on each side: leave room
  const pad = fit === 'content' ? minWidthMm / 2 : 0;
  const scale = (sizeMm - 2 * pad) / span;              // mm per circle unit
  const wMm = (x1 - x0) * scale + 2 * pad, hMm = (y1 - y0) * scale + 2 * pad;
  // x_mm = ox + x * scale ; y_mm = oy - y * scale   (circle units are y down, print is Y up)
  return { scale, ox: pad - x0 * scale, oy: pad + y1 * scale, widthMm: wMm, heightMm: hMm, fit };
}

/** The drawing as mm polyline arrays (decimated; widths in mm before any clamping). */
export function geomToMm(geom, frame, { stepMm = 0.06 } = {}) {
  const { n, data } = geom;
  const X = new Float64Array(n), Y = new Float64Array(n), W = new Float64Array(n);
  let m = 0, lx = Infinity, ly = Infinity, lw = -1;
  for (let i = 0, o = 0; i < n; i++, o += STRIDE) {
    const x = frame.ox + data[o] * frame.scale, y = frame.oy - data[o + 1] * frame.scale;
    const w = Math.max(0, data[o + 2] * frame.scale);
    const far = (x - lx) ** 2 + (y - ly) ** 2 >= stepMm * stepMm;
    if (i === 0 || i === n - 1 || far || Math.abs(w - lw) > 0.04) {
      X[m] = x; Y[m] = y; W[m] = w; m++; lx = x; ly = y; lw = w;
    }
  }
  return { n: m, X: X.subarray(0, m), Y: Y.subarray(0, m), W: W.subarray(0, m) };
}

/**
 * Rasterise mm polylines [{ X, Y, W (full widths, mm), n }] into a mask, with the printability
 * rules: widths below minWidthMm are raised to it, gaps below minGapMm are closed.
 * opts: { pxPerMm, minWidthMm, minGapMm, marginMm, widthMm/heightMm/x0/y0 (grid extent, else auto),
 *         fixedWidthMm (one width for the whole line, e.g. a wire) }
 */
export function polylineMask(lines, opts = {}) {
  const t0 = now();
  const minW = opts.minWidthMm ?? PRINT_RULES.minWidthMm, minGap = opts.minGapMm ?? PRINT_RULES.minGapMm;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, wMax = 0;
  for (const L of lines) for (let i = 0; i < L.n; i++) {
    const r = Math.max(minW, opts.fixedWidthMm || L.W[i]) / 2;
    if (L.X[i] - r < bx0) bx0 = L.X[i] - r; if (L.X[i] + r > bx1) bx1 = L.X[i] + r;
    if (L.Y[i] - r < by0) by0 = L.Y[i] - r; if (L.Y[i] + r > by1) by1 = L.Y[i] + r;
    if (2 * r > wMax) wMax = 2 * r;
  }
  if (!isFinite(bx0)) throw new Error('polylineMask: no points');
  const size = Math.max(bx1 - bx0, by1 - by0);
  const pxPerMm = opts.pxPerMm || autoPxPerMm(size);
  const s = 1 / pxPerMm;
  const band = Math.max(minGap, 0) / 2 + 3 * s;          // the closing reads F > -minGap/2 only
  const margin = (opts.marginMm ?? 0) + band + 3 * s;
  const gx0 = opts.x0 ?? bx0 - margin, gy0 = opts.y0 ?? by0 - margin;
  const mask = emptyMask(gx0, gy0, opts.widthMm ?? (bx1 - bx0 + 2 * margin), opts.heightMm ?? (by1 - by0 + 2 * margin), s, band);

  // widths: clamp up to the printable minimum, measuring how much of the line needed it
  let lenAll = 0, lenThin = 0, thinnest = Infinity;
  for (const L of lines) {
    const R = new Float64Array(L.n);
    for (let i = 0; i < L.n; i++) {
      const w0 = opts.fixedWidthMm || L.W[i];
      if (w0 < thinnest) thinnest = w0;
      R[i] = Math.max(minW, w0) / 2;
      if (i) {
        const seg = Math.hypot(L.X[i] - L.X[i - 1], L.Y[i] - L.Y[i - 1]);
        lenAll += seg; if (Math.min(w0, opts.fixedWidthMm || L.W[i - 1]) < minW - 1e-6) lenThin += seg;
      }
    }
    stampPolyline(mask, L.X, L.Y, R, L.n);
  }
  const tStamp = now();

  // close gaps narrower than minGap: dilate by g, erode by g (exact distances via the EDT)
  const N = mask.w * mask.h, F = mask.data;
  let filled = 0, inked = 0;
  if (minGap > 0) {
    const g = minGap / 2;
    const dist = new Float64Array(N);
    for (let o = 0; o < N; o++) dist[o] = F[o] > -g ? BIG : 0;
    edt2(dist, mask.w, mask.h);
    for (let o = 0; o < N; o++) {
      if (F[o] > 0) { inked++; continue; }
      const c = (Math.sqrt(dist[o]) - 0.5) * s - g - 0.3 * s;   // SDF of the closed set, a hair inside
      if (c > 0) { F[o] = Math.max(F[o], c); if (c > s) filled++; }
    }
  } else for (let o = 0; o < N; o++) if (F[o] > 0) inked++;
  const px2 = s * s;
  const report = {
    pxPerMm, minWidthMm: minW, minGapMm: minGap,
    lineLengthMm: lenAll,
    thinnestMm: thinnest,
    widenedFrac: lenAll ? lenThin / lenAll : 0,      // share of the line raised to minWidthMm
    inkAreaMm2: inked * px2,
    mergedAreaMm2: filled * px2,                     // gaps closed because they were narrower than minGapMm
    mergedFrac: inked ? filled / inked : 0,
    maxWidthMm: wMax,
    ms: { stamp: Math.round(tStamp - t0), close: Math.round(now() - tStamp) },
  };
  mask.report = report;
  return mask;
}

/**
 * The drawing rasterised at real print size.
 * opts: { sizeMm (longer side of the drawing, default 150), fit 'content'|'frame', pxPerMm,
 *         minWidthMm, minGapMm, marginMm, fixedWidthMm, widthScale (multiply the drawn widths) }
 * Returns a mask with .frame (see geomFrame) and .report (printability, see polylineMask) plus
 * report.notes (plain-language warnings) and, for spirals, pitchMm / maxRings.
 */
export function lineMask(geom, opts = {}) {
  if (!geom || !(geom.n >= 1)) throw new Error('lineMask: empty geometry');
  const t0 = now();
  const sizeMm = opts.sizeMm ?? 150;
  const frame = geomFrame(geom, { sizeMm, fit: opts.fit || 'content', minWidthMm: opts.minWidthMm ?? PRINT_RULES.minWidthMm });
  const L = geomToMm(geom, frame, { stepMm: opts.stepMm ?? Math.max(0.08, 1 / (opts.pxPerMm || autoPxPerMm(sizeMm))) });
  if (opts.widthScale && opts.widthScale !== 1) for (let i = 0; i < L.n; i++) L.W[i] *= opts.widthScale;
  const minW = opts.minWidthMm ?? PRINT_RULES.minWidthMm, minGap = opts.minGapMm ?? PRINT_RULES.minGapMm;
  // the print size at which 90% of the line (by points) is drawn at least minWidth wide as it is
  const ws = Float64Array.from(L.W).sort();
  const w10 = ws[Math.floor(ws.length * 0.1)] || 0;
  const spacing = geom.path === 'spiral' ? (geom.spacing > 0 ? geom.spacing : geom.rings > 0 ? 1 / geom.rings : 0) : 0;
  const pitchMm = spacing * frame.scale;             // centre-to-centre ring distance (spirals)
  // widthRange: remap the drawing's own width range onto [lo, hi] mm, so the tone survives the
  // printable minimum instead of every hairline flattening to minWidth. 'auto' = [minWidth, pitch -
  // minGap] on a spiral (x0.9 for the wobble; rings never touch), else [minWidth, max(minWidth, widest line)].
  let remap = null;
  if (opts.widthRange) {
    let wLo = Infinity, wHi = 0;
    for (let i = 0; i < L.n; i++) { if (L.W[i] < wLo) wLo = L.W[i]; if (L.W[i] > wHi) wHi = L.W[i]; }
    let [lo, hi] = opts.widthRange === 'auto'
      // 0.9: the hand wobble squeezes neighbouring rings by a few % of the pitch (spiral.js)
      ? [minW, pitchMm > 0 ? 0.9 * pitchMm - minGap : Math.max(minW, wHi)] : opts.widthRange;
    hi = Math.max(lo, hi);
    const k = wHi - wLo > 1e-9 ? (hi - lo) / (wHi - wLo) : 0;
    for (let i = 0; i < L.n; i++) L.W[i] = lo + (L.W[i] - wLo) * k;
    remap = { fromMm: [wLo, wHi], toMm: [lo, hi] };
  }
  const mask = polylineMask([L], opts);
  mask.frame = frame;
  const r = mask.report;
  r.points = L.n;
  r.notes = [];
  if (remap) r.widthRemap = remap;
  r.sizeForWidthMm = w10 > 0 ? Math.round(sizeMm * minW / w10) : Infinity;
  if (pitchMm > 0) {
    r.pitchMm = pitchMm;
    // rings that fit with minWidth lines, minGap gaps and the 0.9 wobble allowance (art radius = 1 CU)
    r.maxRings = Math.floor(0.9 * frame.scale / (minW + minGap));
  }
  if (remap && remap.toMm[1] <= remap.toMm[0] + 1e-9 && pitchMm > 0) r.notes.push(`Ring pitch ${pitchMm.toFixed(2)} mm leaves no room for width modulation: every ring prints ${remap.toMm[0]} mm wide.`);
  if (r.widenedFrac > 0.02) r.notes.push(`${Math.round(r.widenedFrac * 100)}% of the line is thinner than ${r.minWidthMm} mm at this size and was thickened to ${r.minWidthMm} mm.` +
    (r.widenedFrac > 0.3 && isFinite(r.sizeForWidthMm) ? ` It would print as drawn from about ${r.sizeForWidthMm} mm.` : ''));
  if (r.mergedFrac > 0.02) r.notes.push(`Lines closer than ${r.minGapMm} mm were merged (${Math.round(r.mergedFrac * 100)}% more raised area).` +
    (r.pitchMm ? ` Ring pitch is ${r.pitchMm.toFixed(2)} mm; at most ${r.maxRings} rings print as separate lines here.` : ''));
  r.ms.total = Math.round(now() - t0);
  return mask;
}

// ============================================================================ contours
// Marching squares on the mask's 0 level. Corners in counter-clockwise order c0 (i,j), c1 (i+1,j),
// c2 (i+1,j+1), c3 (i,j+1); edge k runs c_k -> c_k+1. An edge from inside to outside is an exit;
// each segment runs exit -> entry, which keeps the inside on its left: outer rings CCW, holes CW.
// Saddles follow the cell centre: centre inside pairs each exit with the next entry, else the previous.
const MS = (() => {
  const t = [];
  for (let c = 0; c < 32; c++) {
    const inside = k => (c >> k) & 1, centre = (c >> 4) & 1;
    const exits = [], entries = [];
    for (let k = 0; k < 4; k++) {
      const a = inside(k), b = inside((k + 1) & 3);
      if (a && !b) exits.push(k); else if (!a && b) entries.push(k);
    }
    const segs = [];
    for (const e of exits) {
      for (let s = 1; s < 4; s++) {
        const k = centre ? (e + s) & 3 : (e - s + 4) & 3;
        if (entries.includes(k)) { segs.push(e, k); break; }
      }
    }
    t.push(segs);
  }
  return t;
})();

function signedArea(r) {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

/** Douglas-Peucker on a closed ring (flat [x,y,..]); returns a new Float64Array. */
export function simplifyRing(r, tol) {
  const n = r.length / 2;
  if (n < 5 || !(tol > 0)) return r;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (r[2 * i] - r[0]) ** 2 + (r[2 * i + 1] - r[1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n); keep[0] = keep[far] = 1;
  const tol2 = tol * tol;
  const stack = [0, far, far, n];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    if (b - a < 2) continue;
    const ax = r[2 * a], ay = r[2 * a + 1], bb = b % n, bx = r[2 * bb], by = r[2 * bb + 1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let best = -1, bd = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = r[2 * i] - ax, py = r[2 * i + 1] - ay;
      let d;
      if (L2 < 1e-18) d = px * px + py * py;
      else { const c = px * dy - py * dx; d = c * c / L2; }
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push(a, best, best, b); }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i];
  if (m < 3) return r;
  const out = new Float64Array(2 * m);
  for (let i = 0, k = 0; i < n; i++) if (keep[i]) { out[k++] = r[2 * i]; out[k++] = r[2 * i + 1]; }
  return out;
}

function pointInRing(r, x, y) {
  let c = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = r[2 * i + 1], yj = r[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < (r[2 * j] - r[2 * i]) * (y - yi) / (yj - yi) + r[2 * i]) c = !c;
  }
  return c;
}

function ringBox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i]; if (r[i] > x1) x1 = r[i];
    if (r[i + 1] < y0) y0 = r[i + 1]; if (r[i + 1] > y1) y1 = r[i + 1];
  }
  return [x0, y0, x1, y1];
}

/**
 * Polygons with holes (mm, Y up) of the mask's inside.
 * opts: { simplifyMm (default 0.025), minAreaMm2 (drop islands / close holes smaller, default 0.05) }
 */
export function contours(mask, opts = {}) {
  const t0 = now();
  if (touchesBorder(mask)) mask = padMask(mask, mask.mmPerPx);
  const { w, h, data, mmPerPx: s, x0, y0 } = mask;
  const tol = opts.simplifyMm ?? 0.025, minArea = opts.minAreaMm2 ?? 0.05;
  const next = new Int32Array(2 * w * h).fill(-1);
  const ins = o => data[o] > 0;
  // edge ids: H(i,j) = 2*(j*w+i) (pixel (i,j) -> (i+1,j)), V(i,j) = 2*(j*w+i)+1 ((i,j) -> (i,j+1))
  let segs = 0;
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const o = j * w + i;
      let c = (ins(o) ? 1 : 0) | (ins(o + 1) ? 2 : 0) | (ins(o + w + 1) ? 4 : 0) | (ins(o + w) ? 8 : 0);
      if (c === 0 || c === 15) continue;
      if (c === 5 || c === 10) {
        const centre = (data[o] + data[o + 1] + data[o + w] + data[o + w + 1]) > 0;
        if (centre) c |= 16;
      }
      const t = MS[c];
      for (let k = 0; k < t.length; k += 2) {
        next[edgeId(t[k], i, j, w)] = edgeId(t[k + 1], i, j, w);
        segs++;
      }
    }
  }
  // edge id -> point (linear interpolation of the SDF, kept off the pixel centres so vertices on
  // different edges never coincide)
  const pt = (e, out) => {
    const o = e >> 1, i = o % w, j = (o / w) | 0;
    const o2 = (e & 1) ? o + w : o + 1;
    const a = data[o], b = data[o2];
    let t = a / (a - b);
    t = t < 0.02 ? 0.02 : t > 0.98 ? 0.98 : t;
    out[0] = x0 + (i + 0.5 + ((e & 1) ? 0 : t)) * s;
    out[1] = y0 + (j + 0.5 + ((e & 1) ? t : 0)) * s;
  };
  const rings = [];
  const p = [0, 0];
  const buf = [];
  for (let e0 = 0; e0 < next.length; e0++) {
    if (next[e0] < 0) continue;
    buf.length = 0;
    let e = e0;
    while (e >= 0 && next[e] >= 0) {
      pt(e, p); buf.push(p[0], p[1]);
      const nx = next[e]; next[e] = -1; e = nx;
    }
    if (buf.length >= 6) rings.push(Float64Array.from(buf));
  }
  const tTrace = now();
  // simplify, classify, drop specks
  const outers = [], holes = [];
  let raw = 0, kept = 0;
  for (let r of rings) {
    raw += r.length / 2;
    r = simplifyRing(r, tol);
    const a = signedArea(r);
    if (Math.abs(a) < minArea || r.length < 6) continue;
    kept += r.length / 2;
    (a > 0 ? outers : holes).push({ ring: r, area: a, box: ringBox(r) });
  }
  outers.sort((p, q) => p.area - q.area);
  const polys = outers.map(o => ({ outer: o.ring, holes: [], area: o.area, box: o.box }));
  let orphan = 0;
  for (const hl of holes) {
    const [hx0, hy0, hx1, hy1] = hl.box;
    let home = null;
    for (const P of polys) {
      const b = P.box;
      if (P.area < -hl.area || b[0] > hx0 || b[1] > hy0 || b[2] < hx1 || b[3] < hy1) continue;
      if (pointInRing(P.outer, hl.ring[0], hl.ring[1])) { home = P; break; }
    }
    if (home) { home.holes.push(hl.ring); home.area += hl.area; } else orphan++;
  }
  const stats = { rings: rings.length, outers: polys.length, holes: holes.length - orphan, orphanHoles: orphan,
    rawPoints: raw, points: kept, segs, ms: { trace: Math.round(tTrace - t0), group: Math.round(now() - tTrace) } };
  polys.stats = stats;
  return polys;
}

function edgeId(k, i, j, w) {
  // k: 0 bottom (c0->c1) = H(i,j); 1 right (c1->c2) = V(i+1,j); 2 top (c2->c3) = H(i,j+1); 3 left = V(i,j)
  switch (k) {
    case 0: return 2 * (j * w + i);
    case 1: return 2 * (j * w + i + 1) + 1;
    case 2: return 2 * ((j + 1) * w + i);
    default: return 2 * (j * w + i) + 1;
  }
}

// ============================================================================ shapes
/** Circle polygon (CCW), optionally with a circular hole. */
export function circlePoly(cx, cy, r, segs = 0, holeR = 0) {
  const n = segs || Math.max(24, Math.min(360, Math.ceil(2 * Math.PI * r / 0.4)));
  const ring = (rad, ccw) => {
    const a = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) { const t = (ccw ? k : -k) / n * 2 * Math.PI; a[2 * k] = cx + rad * Math.cos(t); a[2 * k + 1] = cy + rad * Math.sin(t); }
    return a;
  };
  return { outer: ring(r, true), holes: holeR > 0 ? [ring(holeR, false)] : [] };
}

/** Rounded rectangle polygon (CCW), corner radius rad, optional holes (CW rings). */
export function rectPoly(x0, y0, x1, y1, rad = 0, holes = []) {
  const pts = [];
  const r = Math.max(0, Math.min(rad, (x1 - x0) / 2 - 1e-6, (y1 - y0) / 2 - 1e-6));
  if (r <= 0) pts.push(x0, y0, x1, y0, x1, y1, x0, y1);
  else {
    const seg = Math.max(4, Math.ceil(Math.PI / 2 * r / 0.4));
    const corner = (cx, cy, a0) => { for (let k = 0; k <= seg; k++) { const t = a0 + k / seg * Math.PI / 2; pts.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); } };
    corner(x1 - r, y0 + r, -Math.PI / 2); corner(x1 - r, y1 - r, 0); corner(x0 + r, y1 - r, Math.PI / 2); corner(x0 + r, y0 + r, Math.PI);
  }
  return { outer: Float64Array.from(pts), holes };
}

/** Reverse a ring (turn an outer into a hole ring or back). */
export function reverseRing(r) {
  const n = r.length / 2, o = new Float64Array(r.length);
  for (let i = 0; i < n; i++) { o[2 * i] = r[2 * (n - 1 - i)]; o[2 * i + 1] = r[2 * (n - 1 - i) + 1]; }
  return o;
}

// ============================================================================ meshes
/**
 * Prisms from polygons with holes: bottom at z0, top at z1 (numbers, or functions (poly) -> z).
 * Watertight by construction: caps use exactly the ring vertices, walls join the same edges.
 */
export function extrudePolygons(polys, z0 = 0, z1 = 1) {
  let nv = 0;
  for (const p of polys) { nv += p.outer.length / 2; for (const hl of p.holes || []) nv += hl.length / 2; }
  const pos = new Float32Array(nv * 2 * 3);
  const idx = [];
  let base = 0, failed = 0;
  for (const p of polys) {
    const za = typeof z0 === 'function' ? z0(p) : z0, zb = typeof z1 === 'function' ? z1(p) : z1;
    const rings = [p.outer, ...(p.holes || [])];
    let m = 0;
    for (const r of rings) m += r.length / 2;
    const flat = new Float64Array(2 * m), holeIdx = [];
    let k = 0;
    for (let ri = 0; ri < rings.length; ri++) {
      if (ri) holeIdx.push(k / 2);
      flat.set(rings[ri], k); k += rings[ri].length;
    }
    // vertices: bottom block [base, base+m), top block [base+m, base+2m)
    for (let v = 0; v < m; v++) {
      const x = flat[2 * v], y = flat[2 * v + 1], a = 3 * (base + v), b = 3 * (base + m + v);
      pos[a] = x; pos[a + 1] = y; pos[a + 2] = za;
      pos[b] = x; pos[b + 1] = y; pos[b + 2] = zb;
    }
    const tri = earcut(flat, holeIdx, 2);
    let area2 = 0;
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t], b = tri[t + 1], c = tri[t + 2];
      area2 += (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
    }
    const flip = area2 < 0;
    if (Math.abs(Math.abs(area2 / 2) - Math.abs(p.area ?? polyArea(p))) > 1e-3 * Math.abs(area2 / 2) + 1e-6) failed++;
    for (let t = 0; t < tri.length; t += 3) {
      let a = tri[t], b = tri[t + 1], c = tri[t + 2];
      if (flip) { const q = b; b = c; c = q; }
      idx.push(base + m + a, base + m + b, base + m + c);   // top, CCW from above
      idx.push(base + a, base + c, base + b);               // bottom, CW from above
    }
    // walls: every ring edge a -> b (inside on the left) -> quad facing right (outward)
    let off = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let v = 0; v < n; v++) {
        const a = base + off + v, b = base + off + (v + 1) % n;
        idx.push(a, b, b + m, a, b + m, a + m);
      }
      off += n;
    }
    base += 2 * m;
  }
  const mesh = { positions: pos, indices: Uint32Array.from(idx) };
  if (failed) mesh.triangulationWarnings = failed;
  return mesh;
}

function polyArea(p) {
  let a = signedArea(p.outer);
  for (const hl of p.holes || []) a += signedArea(hl);
  return a;
}

/**
 * Closed solid from a height field: top surface z = zOf(value, i, j) (or the values themselves),
 * flat bottom at z = 0, four side walls. Row 0 of the field is the far edge (max Y), so the image
 * reads upright and unmirrored from above. Vertex (i, j) sits at X = i * mmPerPx, Y = (h-1-j) * mmPerPx.
 */
export function heightfieldMesh(field, w, h, mmPerPx, zOf = null) {
  if (w < 2 || h < 2) throw new Error('heightfieldMesh: field too small');
  const nTop = w * h, nB = 2 * (w - 1) + 2 * (h - 1);
  const pos = new Float32Array((nTop + nB + 1) * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = j * w + i;
    const z = Math.max(0.01, zOf ? zOf(field[o], i, j) : field[o]);
    pos[3 * o] = i * mmPerPx; pos[3 * o + 1] = (h - 1 - j) * mmPerPx; pos[3 * o + 2] = z;
  }
  const tris = new Uint32Array(((w - 1) * (h - 1) * 2 + nB * 3) * 3);
  let t = 0;
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
    const v00 = j * w + i, v10 = v00 + 1, v01 = v00 + w, v11 = v01 + 1;
    // split along the diagonal with the smaller height difference (follows ridges)
    if (Math.abs(pos[3 * v00 + 2] - pos[3 * v11 + 2]) <= Math.abs(pos[3 * v10 + 2] - pos[3 * v01 + 2])) {
      tris[t++] = v00; tris[t++] = v01; tris[t++] = v11;
      tris[t++] = v00; tris[t++] = v11; tris[t++] = v10;
    } else {
      tris[t++] = v00; tris[t++] = v01; tris[t++] = v10;
      tris[t++] = v10; tris[t++] = v01; tris[t++] = v11;
    }
  }
  // border loop, CCW seen from above: near edge (row h-1) left->right, right edge up, far edge
  // right->left, left edge down
  const loop = [];
  for (let i = 0; i < w - 1; i++) loop.push((h - 1) * w + i);
  for (let j = h - 1; j > 0; j--) loop.push(j * w + w - 1);
  for (let i = w - 1; i > 0; i--) loop.push(i);
  for (let j = 0; j < h - 1; j++) loop.push(j * w);
  const bot0 = nTop, centre = nTop + nB;
  for (let k = 0; k < nB; k++) {
    const v = loop[k];
    pos[3 * (bot0 + k)] = pos[3 * v]; pos[3 * (bot0 + k) + 1] = pos[3 * v + 1]; pos[3 * (bot0 + k) + 2] = 0;
  }
  pos[3 * centre] = (w - 1) * mmPerPx / 2; pos[3 * centre + 1] = (h - 1) * mmPerPx / 2; pos[3 * centre + 2] = 0;
  for (let k = 0; k < nB; k++) {
    const k1 = (k + 1) % nB;
    const a1 = loop[k], b1 = loop[k1], a0 = bot0 + k, b0 = bot0 + k1;
    tris[t++] = a0; tris[t++] = b0; tris[t++] = b1;
    tris[t++] = a0; tris[t++] = b1; tris[t++] = a1;
    tris[t++] = centre; tris[t++] = b0; tris[t++] = a0;
  }
  return { positions: pos, indices: tris };
}

/**
 * Ink coverage (0..1) of a mask on a coarser grid (box average of cellMm cells, then blurCells
 * box-blur passes), laid out for heightfieldMesh: row 0 is the far edge (max Y). Returns
 * { field, w, h, mmPerPx, x0, y0 } where (x0, y0) is the mm position of heightfield vertex (0, h-1).
 * For lithophanes: thickness = zMin + (zMax - zMin) * coverage.
 */
export function coverageField(mask, cellMm = 0.25, { blurCells = 1, blurMm = 0 } = {}) {
  const f = Math.max(1, Math.round(cellMm / mask.mmPerPx));
  const W = Math.floor(mask.w / f), H = Math.floor(mask.h / f);
  let out = new Float32Array(W * H);
  const inv = 1 / (f * f), ipx = 1 / mask.mmPerPx;
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    let c = 0;
    // anti-aliased pixel coverage from the signed distance (binary pixels beat against fine
    // line patterns that run along the grid and print as moire bands)
    for (let dj = 0; dj < f; dj++) {
      const o = (J * f + dj) * mask.w + I * f;
      for (let di = 0; di < f; di++) { const v = 0.5 + mask.data[o + di] * ipx; c += v <= 0 ? 0 : v >= 1 ? 1 : v; }
    }
    out[(H - 1 - J) * W + I] = c * inv;
  }
  // blurMm: a Gaussian-like blur of that sigma (n 3x3 box passes have variance 2n/3 cells^2); use
  // about half the line pitch so dense line patterns (spiral rings) do not alias into moire
  if (blurMm > 0) blurCells = Math.max(blurCells, Math.ceil(1.5 * (blurMm / (f * mask.mmPerPx)) ** 2));
  for (let pass = 0; pass < blurCells; pass++) {        // 3x3 box blur, edges clamped
    const b = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = i + di, y = j + dj;
        if (x >= 0 && y >= 0 && x < W && y < H) { s += out[y * W + x]; n++; }
      }
      b[j * W + i] = s / n;
    }
    out = b;
  }
  const s = f * mask.mmPerPx;
  return { field: out, w: W, h: H, mmPerPx: s, x0: mask.x0 + s / 2, y0: mask.y0 + s / 2 };
}

/** Concatenate meshes (no welding). */
export function merge(meshes) {
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let pv = 0, pi = 0;
  for (const m of meshes) {
    positions.set(m.positions, pv);
    const off = pv / 3;
    for (let k = 0; k < m.indices.length; k++) indices[pi + k] = m.indices[k] + off;
    pv += m.positions.length; pi += m.indices.length;
  }
  return { positions, indices };
}

export function translate(mesh, dx = 0, dy = 0, dz = 0) {
  const p = mesh.positions;
  for (let k = 0; k < p.length; k += 3) { p[k] += dx; p[k + 1] += dy; p[k + 2] += dz; }
  return mesh;
}

export function bounds(mesh) {
  const p = mesh.positions;
  const b = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  for (let k = 0; k < p.length; k += 3) {
    if (p[k] < b.x[0]) b.x[0] = p[k]; if (p[k] > b.x[1]) b.x[1] = p[k];
    if (p[k + 1] < b.y[0]) b.y[0] = p[k + 1]; if (p[k + 1] > b.y[1]) b.y[1] = p[k + 1];
    if (p[k + 2] < b.z[0]) b.z[0] = p[k + 2]; if (p[k + 2] > b.z[1]) b.z[1] = p[k + 2];
  }
  return b;
}

/**
 * Watertightness: every directed edge must appear once and its reverse once (closed, 2-manifold,
 * consistently wound). Also welds by position (as STL readers do) and checks again, and returns the
 * enclosed volume (mm^3, > 0 when the normals point out).
 */
export function checkManifold(mesh, { weld = true } = {}) {
  const t0 = now();
  const res = edgeCheck(mesh.indices, mesh.positions.length / 3);
  let vol = 0, degenerate = 0;
  const p = mesh.positions, I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b], by = p[b + 1], bz = p[b + 2], cx = p[c], cy = p[c + 1], cz = p[c + 2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) degenerate++;
  }
  const out = { ok: res.open === 0 && res.nonManifold === 0 && vol > 0, openEdges: res.open, nonManifold: res.nonManifold,
    volume: vol / 6, triangles: I.length / 3, vertices: p.length / 3, degenerate };
  if (weld) {
    const w = weldIndices(mesh);
    const r2 = edgeCheck(w.indices, w.count);
    out.welded = { vertices: w.count, openEdges: r2.open, nonManifold: r2.nonManifold };
    out.ok = out.ok && r2.open === 0 && r2.nonManifold === 0;
  }
  out.ms = Math.round(now() - t0);
  return out;
}

function edgeCheck(I, nv) {
  const E = I.length;
  const keys = new Float64Array(E);
  for (let t = 0; t < E; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    keys[t] = a * nv + b; keys[t + 1] = b * nv + c; keys[t + 2] = c * nv + a;
  }
  keys.sort();
  let open = 0, nonManifold = 0;
  for (let k = 0; k < E; k++) {
    if (k && keys[k] === keys[k - 1]) { nonManifold++; continue; }
    const a = Math.floor(keys[k] / nv), b = keys[k] - a * nv;
    const rev = b * nv + a;
    let lo = 0, hi = E - 1, found = false;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (keys[mid] < rev) lo = mid + 1; else if (keys[mid] > rev) hi = mid - 1; else { found = true; break; } }
    if (!found) open++;
  }
  return { open, nonManifold };
}

/** Merge vertices with identical float32 positions (what an STL reader sees). */
export function weldIndices(mesh) {
  const p = mesh.positions, n = p.length / 3;
  const map = new Map(), remap = new Uint32Array(n);
  const f = new Float32Array(3), u = new Uint32Array(f.buffer);
  let count = 0;
  for (let v = 0; v < n; v++) {
    f[0] = p[3 * v]; f[1] = p[3 * v + 1]; f[2] = p[3 * v + 2];
    const key = u[0] + ',' + u[1] + ',' + u[2];
    let id = map.get(key);
    if (id === undefined) { id = count++; map.set(key, id); }
    remap[v] = id;
  }
  const indices = new Uint32Array(mesh.indices.length);
  for (let k = 0; k < indices.length; k++) indices[k] = remap[mesh.indices[k]];
  return { indices, count };
}

// ============================================================================ writers
/** Binary STL (little endian): 80-byte header, count, 50 bytes per triangle. */
export function writeSTL(mesh, name = 'Spiralist') {
  const I = mesh.indices, p = mesh.positions, T = I.length / 3;
  const buf = new ArrayBuffer(84 + 50 * T), dv = new DataView(buf);
  const head = `Spiralist print: ${name}`.slice(0, 79);
  for (let k = 0; k < head.length; k++) dv.setUint8(k, head.charCodeAt(k) & 0x7f);
  dv.setUint32(80, T, true);
  let o = 84;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    for (const v of [a, b, c]) {
      o += 12;
      dv.setFloat32(o, p[v], true); dv.setFloat32(o + 4, p[v + 1], true); dv.setFloat32(o + 8, p[v + 2], true);
    }
    o += 12;
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}

/** Read a binary STL back (for tests and checks): { positions (unwelded), indices, name }. */
export function readSTL(buf) {
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const T = dv.getUint32(80, true);
  if (84 + 50 * T !== dv.byteLength) throw new Error(`readSTL: size ${dv.byteLength} != 84 + 50 x ${T}`);
  const positions = new Float32Array(T * 9), normals = new Float32Array(T * 3);
  let o = 84;
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) normals[3 * t + k] = dv.getFloat32(o + 4 * k, true);
    o += 12;
    for (let k = 0; k < 9; k++) positions[9 * t + k] = dv.getFloat32(o + 4 * k, true);
    o += 38;
  }
  let name = '';
  for (let k = 0; k < 80; k++) { const c = dv.getUint8(k); if (!c) break; name += String.fromCharCode(c); }
  return { positions, indices: Uint32Array.from({ length: T * 3 }, (_, k) => k), normals, name };
}

// CRC-32 (zip)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crcUpdate(c, u8) { for (let k = 0; k < u8.length; k++) c = CRC_TABLE[(c ^ u8[k]) & 0xff] ^ (c >>> 8); return c; }

async function deflateRaw(chunks) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob(chunks).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

/**
 * Zip archive from [{ name, data: string | Uint8Array | Uint8Array[] }] (deflate when the platform
 * has CompressionStream, else stored). Returns Promise<Uint8Array>.
 */
export async function zip(files, { compress = true } = {}) {
  const norm = zipEntries(files), bodies = [];
  for (const f of norm) {
    let size = 0;
    for (const c of f.chunks) size += c.length;
    bodies.push(compress && size > 256 ? await deflateRaw(f.chunks) : null);
  }
  return buildZip(norm, bodies);
}

/** Same archive, stored (no compression), synchronous. */
export function zipStored(files) {
  const norm = zipEntries(files);
  return buildZip(norm, norm.map(() => null));
}

function zipEntries(files) {
  const enc = new TextEncoder();
  return files.map(f => ({ name: f.name, chunks: typeof f.data === 'string' ? [enc.encode(f.data)] : Array.isArray(f.data) ? f.data : [f.data] }));
}

function buildZip(files, bodies) {
  const enc = new TextEncoder();
  const out = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (let k = 0; k < files.length; k++) {
    const f = files[k], chunks = f.chunks;
    let crc = -1, size = 0;
    for (const c of chunks) { crc = crcUpdate(crc, c); size += c.length; }
    crc = (crc ^ -1) >>> 0;
    let body = bodies[k];
    const method = body ? 8 : 0;
    if (!body) { body = new Uint8Array(size); let o = 0; for (const c of chunks) { body.set(c, o); o += c.length; } }
    const name = enc.encode(f.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    out.push(new Uint8Array(lh.buffer), name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  const all = [...out, ...central, new Uint8Array(eocd.buffer)];
  let total = 0;
  for (const c of all) total += c.length;
  const res = new Uint8Array(total);
  let o = 0;
  for (const c of all) { res.set(c, o); o += c.length; }
  return res;
}

const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = v => { const r = Math.round(v * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };
function colorHex(c) {
  const s = String(c || '#ffffff').trim();
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  return m ? `#${m[1].toUpperCase()}${(m[2] || 'FF').toUpperCase()}` : '#FFFFFFFF';
}

/** The 3MF model XML as string chunks. */
export function model3MF(parts, meta = {}) {
  const chunks = [];
  let cur = '';
  const put = s => { cur += s; if (cur.length > 1 << 16) { chunks.push(cur); cur = ''; } };
  put('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  const md = { Title: meta.title || 'Spiralist print', Designer: meta.designer || 'Spiralist', Application: 'Spiralist', Description: meta.description || '', CreationDate: new Date().toISOString().slice(0, 10) };
  for (const [k, v] of Object.entries(md)) if (v) put(` <metadata name="${k}">${xmlEsc(v)}</metadata>\n`);
  put(' <resources>\n  <basematerials id="1">\n');
  parts.forEach((p, k) => put(`   <base name="${xmlEsc(p.name || `part ${k + 1}`)}" displaycolor="${colorHex(p.color)}"/>\n`));
  put('  </basematerials>\n');
  parts.forEach((p, k) => {
    put(`  <object id="${k + 2}" type="model" name="${xmlEsc(p.name || `part ${k + 1}`)}" pid="1" pindex="${k}">\n   <mesh>\n    <vertices>\n`);
    const P = p.mesh.positions;
    for (let v = 0; v < P.length; v += 3) put(`     <vertex x="${num(P[v])}" y="${num(P[v + 1])}" z="${num(P[v + 2])}"/>\n`);
    put('    </vertices>\n    <triangles>\n');
    const I = p.mesh.indices;
    for (let t = 0; t < I.length; t += 3) put(`     <triangle v1="${I[t]}" v2="${I[t + 1]}" v3="${I[t + 2]}"/>\n`);
    put('    </triangles>\n   </mesh>\n  </object>\n');
  });
  const groups = objectGroups(parts, meta);
  if (groups) {
    // one object per group (its parts as components), each placed on its plate
    groups.forEach(g => {
      put(`  <object id="${g.id}" type="model" name="${xmlEsc(g.name)}">\n   <components>\n`);
      for (const k of g.parts) put(`    <component objectid="${k + 2}"/>\n`);
      put('   </components>\n  </object>\n');
    });
    put(' </resources>\n <build>\n');
    for (const g of groups) { const t = g.offset; put(`  <item objectid="${g.id}" transform="1 0 0 0 1 0 0 0 1 ${num(t[0])} ${num(t[1])} ${num(t[2])}"/>\n`); }
  } else {
    const asm = parts.length + 2;
    const tr = meta.translate ? ` transform="1 0 0 0 1 0 0 0 1 ${num(meta.translate[0] || 0)} ${num(meta.translate[1] || 0)} ${num(meta.translate[2] || 0)}"` : '';
    if (parts.length > 1 && meta.assembly !== false) {
      put(`  <object id="${asm}" type="model" name="${xmlEsc(meta.title || 'Spiralist print')}">\n   <components>\n`);
      parts.forEach((p, k) => put(`    <component objectid="${k + 2}"/>\n`));
      put('   </components>\n  </object>\n </resources>\n <build>\n');
      put(`  <item objectid="${asm}"${tr}/>\n`);
    } else {
      put(' </resources>\n <build>\n');
      parts.forEach((p, k) => put(`  <item objectid="${k + 2}"${tr}/>\n`));
    }
  }
  put(' </build>\n</model>\n');
  chunks.push(cur);
  return chunks;
}

/**
 * Bambu Studio / OrcaSlicer project metadata: which filament slot each part prints with (part.slot,
 * else its index + 1) and the slot colours. Other slicers ignore these files.
 */
export function bambuConfigs(parts, meta = {}) {
  const groups = objectGroups(parts, meta) || [{ name: meta.title || 'Spiralist print', parts: parts.map((_, k) => k), plate: 1, settings: meta.settings || {},
    id: parts.length > 1 && meta.assembly !== false ? parts.length + 2 : 2, offset: meta.translate || [0, 0, 0] }];
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  const slots = [];
  for (const g of groups) {
    L.push(`  <object id="${g.id}">`, `    <metadata key="name" value="${xmlEsc(g.name)}"/>`, '    <metadata key="extruder" value="1"/>');
    // per-object print settings: Bambu Studio / Orca apply them over the process profile
    for (const [k, v] of Object.entries(g.settings || {})) L.push(`    <metadata key="${xmlEsc(k)}" value="${xmlEsc(v)}"/>`);
    for (const k of g.parts) {
      const p = parts[k], slot = p.slot || k + 1;
      slots[slot - 1] = colorHex(p.color).slice(0, 7);
      L.push(`    <part id="${k + 2}" subtype="normal_part">`, `      <metadata key="name" value="${xmlEsc(p.name || `part ${k + 1}`)}"/>`,
        `      <metadata key="extruder" value="${slot}"/>`, `      <metadata key="source_object_id" value="0"/>`, `      <metadata key="source_volume_id" value="${k}"/>`,
        `      <mesh_stat face_count="${p.mesh.indices.length / 3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>`, '    </part>');
    }
    L.push('  </object>');
  }
  const plates = [...new Set(groups.map(g => g.plate))].sort((a, b) => a - b);
  let ident = 1;
  for (const pl of plates) {
    L.push('  <plate>', `    <metadata key="plater_id" value="${pl}"/>`, '    <metadata key="plater_name" value=""/>', '    <metadata key="locked" value="false"/>');
    for (const g of groups.filter(x => x.plate === pl)) L.push('    <model_instance>', `      <metadata key="object_id" value="${g.id}"/>`, '      <metadata key="instance_id" value="0"/>', `      <metadata key="identify_id" value="${ident++}"/>`, '    </model_instance>');
    L.push('  </plate>');
  }
  L.push('  <assemble>');
  for (const g of groups) L.push(`    <assemble_item object_id="${g.id}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 ${num(g.offset[0] || 0)} ${num(g.offset[1] || 0)} ${num(g.offset[2] || 0)}" offset="0 0 0"/>`);
  L.push('  </assemble>', '</config>');
  for (let k = 0; k < slots.length; k++) slots[k] = slots[k] || '#FFFFFF';
  return {
    model: L.join('\n') + '\n',
    project: JSON.stringify({ filament_colour: slots, version: '01.00.00.00', generated_by: 'Spiralist' }, null, 2),
  };
}

/**
 * meta.objects: [{ name, parts: [part indices], plate (1-based), settings: { Bambu key: value } }]
 * -> the same plus id (the 3MF object id) and offset (the build item's translation). Objects on
 * plate 2+ move onto that plate the way Bambu Studio lays plates out (columns = ceil(sqrt(n)), a
 * fifth of a bed apart); meta.bed: { x, y } (default 256). null when meta.objects is not given.
 */
function objectGroups(parts, meta) {
  if (!Array.isArray(meta.objects) || !meta.objects.length) return null;
  const bed = meta.bed || { x: 256, y: 256 };
  const n = Math.max(...meta.objects.map(o => o.plate || 1));
  const cols = Math.max(1, Math.ceil(Math.sqrt(n) - 1e-9));
  return meta.objects.map((o, j) => {
    const plate = o.plate || 1, col = (plate - 1) % cols, row = Math.floor((plate - 1) / cols);
    let off = [0, 0, 0];
    if (plate > 1) {
      let x0 = Infinity, y0 = Infinity;
      for (const k of o.parts) { const P = parts[k].mesh.positions; for (let v = 0; v < P.length; v += 3) { if (P[v] < x0) x0 = P[v]; if (P[v + 1] < y0) y0 = P[v + 1]; } }
      off = [col * bed.x * 1.2 + 10 - x0, -row * bed.y * 1.2 + 10 - y0, 0];
    } else if (meta.translate) off = [meta.translate[0] || 0, meta.translate[1] || 0, meta.translate[2] || 0];
    return { name: o.name || `Object ${j + 1}`, parts: o.parts, plate, settings: o.settings || {}, id: parts.length + 2 + j, offset: off };
  });
}

/**
 * 3MF (core spec) of parts [{ name, mesh, color, slot? }]. meta: { title, designer, description,
 * translate: [x, y, z] (place on the bed), assembly (default true: parts inside one object),
 * bambu (default true: also write Bambu/Orca per-part filament slots) }.
 * Returns Promise<Blob> ('model/3mf').
 */
export async function write3MF(parts, meta = {}) {
  const bytes = await write3MFBytes(parts, meta);
  return new Blob([bytes], { type: 'model/3mf' });
}

export async function write3MFBytes(parts, meta = {}) {
  return zip(threeMFFiles(parts, meta), meta);
}

/** Synchronous 3MF Blob (stored zip, ~5x bigger than write3MF's deflated one). */
export function write3MFSync(parts, meta = {}) {
  return new Blob([zipStored(threeMFFiles(parts, meta))], { type: 'model/3mf' });
}

function threeMFFiles(parts, meta) {
  if (!parts || !parts.length) throw new Error('write3MF: no parts');
  const enc = new TextEncoder();
  const model = model3MF(parts, meta).map(s => enc.encode(s));
  return ([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>\n' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n' },
    { name: '3D/3dmodel.model', data: model },
    ...(meta.bambu === false ? [] : (() => {
      const b = bambuConfigs(parts, meta);
      return [{ name: 'Metadata/model_settings.config', data: b.model }, { name: 'Metadata/project_settings.config', data: b.project }];
    })()),
    ...(meta.colorChanges?.length ? [{ name: 'Metadata/custom_gcode_per_layer.xml', data: colorChangesXML(meta.colorChanges, meta.layerMm ?? PRINT_RULES.layerMm) }] : []),
  ]);
}

/**
 * Bambu Studio / Orca per-layer custom G-code: a filament change (M600) so a single-extruder printer
 * prints the parts above `atMm` in `color`. changes: [{ atMm, color }]; the change happens before the
 * first layer above atMm (top_z = atMm + one layer), which is how the slicer's layer slider stores it.
 * UNPROVEN: the Bambu Studio 02.x CLI ignores this file in our (non-project) 3MF, so the sliced G-code
 * has no change (tests/print3d_lineup_m600.mjs); the GUI and Orca are untested. Opt-in via meta.colorChanges.
 */
export function colorChangesXML(changes, layerMm = 0.2) {
  const L = ['<?xml version="1.0" encoding="utf-8"?>', '<custom_gcodes_per_layer>', '<plate>', '<plate_info id="1"/>'];
  for (const c of changes) {
    const z = Math.round((c.atMm + layerMm) * 1000) / 1000;
    L.push(`<layer top_z="${z}" type="0" extruder="1" color="${colorHex(c.color || '#1E1E24').slice(0, 7)}" extra="" gcode="M600"/>`);
  }
  L.push('<mode value="SingleExtruder"/>', '</plate>', '</custom_gcodes_per_layer>');
  return L.join('\n') + '\n';
}

/**
 * A flat "wire" of constant width along mm polylines (flat [x,y,..] arrays, or one array), from z0
 * to z0 + heightMm: round caps and joins, self-overlaps unioned, gaps under minGapMm closed.
 * Returns { mesh, polys, mask, report }.
 */
export function tube(polylines, widthMm, heightMm, { z0 = 0, ...opts } = {}) {
  const list = (Array.isArray(polylines) && typeof polylines[0] !== 'number') ? polylines : [polylines];
  const lines = list.map(p => {
    const n = p.length / 2, X = new Float64Array(n), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) { X[i] = p[2 * i]; Y[i] = p[2 * i + 1]; }
    return { n, X, Y, W: new Float64Array(n).fill(widthMm) };
  });
  const mask = polylineMask(lines, { ...opts, minWidthMm: Math.min(opts.minWidthMm ?? PRINT_RULES.minWidthMm, widthMm) });
  const polys = contours(mask, opts);
  return { mesh: extrudePolygons(polys, z0, z0 + heightMm), polys, mask, report: { ...mask.report, contours: polys.stats } };
}

// ============================================================================ one-call helper
/**
 * The line as a raised solid: lineMask -> contours -> extrude from z0 to z1.
 * Returns { mesh, polys, mask, report } (report = mask.report + contour stats + timings).
 */
export function lineSolid(geom, { z0 = 0, z1 = 1, ...opts } = {}) {
  const t0 = now();
  const mask = lineMask(geom, opts);
  const t1 = now();
  const polys = contours(mask, opts);
  const t2 = now();
  const mesh = extrudePolygons(polys, z0, z1);
  const t3 = now();
  const report = { ...mask.report, contours: polys.stats, triangles: mesh.indices.length / 3,
    ms: { ...mask.report.ms, mask: Math.round(t1 - t0), contours: Math.round(t2 - t1), extrude: Math.round(t3 - t2), total: Math.round(t3 - t0) } };
  return { mesh, polys, mask, report };
}
