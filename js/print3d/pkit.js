// Geometry kit of the print products (js/print3d/products.js), written alongside js/print3d/mesh.js
// (MESH): raster masks, contour tracing, extrusion, profile sweeps (the cookie cutter wall),
// heightfields, manifold checks, and simple binary STL / stored-zip 3MF writers (the tests prefer
// MESH's write3MFBytes, which keeps parts in one assembly). Pure JS, runs in node and the browser.
// Candidates to fold into MESH later: sweepClosed, openMask, cleanRing.
//
// Mesh = { positions: Float32Array (x, y, z mm), indices: Uint32Array (ccw seen from outside) }.
// 2D polygons are in print coordinates: X right, Y up (mm). Rings are arrays [x0, y0, x1, y1, ...]
// without a repeated end point; outer rings counter-clockwise, holes clockwise.
//
// Triangulation: mapbox/earcut from vendor/earcut.mjs.

// ---------------------------------------------------------------- triangulation
// mapbox/earcut, vendored by the MESH work (vendor/earcut.mjs, ISC; see vendor/LICENSES.md)
import earcutLib from '../../vendor/earcut.mjs';
export const earcut = (data, holeIndices, dim = 2) => earcutLib(data, holeIndices || undefined, dim);

// ---------------------------------------------------------------- 2D helpers
/** Signed area of a ring [x0,y0,...] (positive = counter-clockwise, Y up). */
export function ringArea(r) {
  let s = 0;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) s += (r[j] * r[i + 1] - r[i] * r[j + 1]);
  return s / 2;
}
export function pointInRing(r, x, y) {
  let inside = false;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
    const yi = r[i + 1], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < (r[j] - r[i]) * (y - yi) / (yj - yi) + r[i]) inside = !inside;
  }
  return inside;
}
/** Ramer-Douglas-Peucker on a closed ring. */
export function simplifyRing(r, eps) {
  const n = r.length / 2;
  if (n < 8) return r;
  // split at the point farthest from the first so the recursion has two anchors
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (r[2 * i] - r[0]) ** 2 + (r[2 * i + 1] - r[1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n); keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, n]];
  const e2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = r[2 * a], ay = r[2 * a + 1], bb = b % n, bx = r[2 * bb], by = r[2 * bb + 1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    let mi = -1, md = e2;
    for (let i = a + 1; i < b; i++) {
      const px = r[2 * i] - ax, py = r[2 * i + 1] - ay;
      const c = px * dy - py * dx, d = c * c / L2;
      if (d > md) { md = d; mi = i; }
    }
    if (mi >= 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i], r[2 * i + 1]);
  return out;
}
/** Rounded rectangle ring (ccw), corner radius rad, seg segments per corner. */
export function roundRect(x0, y0, x1, y1, rad, seg = 10) {
  rad = Math.max(0, Math.min(rad, (x1 - x0) / 2, (y1 - y0) / 2));
  const out = [];
  const corners = [[x1 - rad, y0 + rad, -Math.PI / 2], [x1 - rad, y1 - rad, 0], [x0 + rad, y1 - rad, Math.PI / 2], [x0 + rad, y0 + rad, Math.PI]];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= seg; k++) { const a = a0 + (k / seg) * Math.PI / 2; out.push(cx + rad * Math.cos(a), cy + rad * Math.sin(a)); }
  }
  return out;
}
export function circleRing(cx, cy, rad, seg = 32, cw = false) {
  const out = [];
  for (let k = 0; k < seg; k++) { const a = (cw ? -1 : 1) * k / seg * 2 * Math.PI; out.push(cx + rad * Math.cos(a), cy + rad * Math.sin(a)); }
  return out;
}
export const reverseRing = r => { const o = new Array(r.length); for (let i = 0, n = r.length / 2; i < n; i++) { o[2 * i] = r[2 * (n - 1 - i)]; o[2 * i + 1] = r[2 * (n - 1 - i) + 1]; } return o; };
export const ccw = r => ringArea(r) >= 0 ? r : reverseRing(r);
export const cw = r => ringArea(r) <= 0 ? r : reverseRing(r);

// ---------------------------------------------------------------- raster masks
/** A blank mask covering X 0..wMm, Y 0..hMm at pxPerMm; data rows run top (Y = hMm) to bottom. */
export function blankMask(wMm, hMm, pxPerMm) {
  const w = Math.ceil(wMm * pxPerMm), h = Math.ceil(hMm * pxPerMm);
  return { w, h, mmPerPx: 1 / pxPerMm, data: new Uint8Array(w * h), hMm: h / pxPerMm, wMm: w / pxPerMm };
}
/** Paint a capsule (segment with round caps) from (x0,y0,r0) to (x1,y1,r1), mm, into the mask. */
export function paintCapsule(m, x0, y0, r0, x1, y1, r1, v = 1) {
  const s = 1 / m.mmPerPx, H = m.h;
  // to pixel space (row 0 = top)
  const ax = x0 * s, ay = (m.hMm - y0) * s, bx = x1 * s, by = (m.hMm - y1) * s, ra = r0 * s, rb = r1 * s;
  const rmax = Math.max(ra, rb);
  const xa = Math.max(0, Math.floor(Math.min(ax, bx) - rmax)), xb = Math.min(m.w - 1, Math.ceil(Math.max(ax, bx) + rmax));
  const ya = Math.max(0, Math.floor(Math.min(ay, by) - rmax)), yb = Math.min(H - 1, Math.ceil(Math.max(ay, by) + rmax));
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  for (let y = ya; y <= yb; y++) {
    const py = y + 0.5 - ay;
    for (let x = xa; x <= xb; x++) {
      const px = x + 0.5 - ax;
      let t = L2 > 1e-12 ? (px * dx + py * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - t * dx, qy = py - t * dy, r = ra + (rb - ra) * t;
      if (qx * qx + qy * qy <= r * r) m.data[y * m.w + x] = v;
    }
  }
}
/** Fill polygon rings (even-odd) into the mask with value v, mm coordinates. */
export function paintRings(m, rings, v = 1) {
  const s = 1 / m.mmPerPx;
  const edges = [];
  for (const r of rings) for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
    const x0 = r[j] * s, y0 = (m.hMm - r[j + 1]) * s, x1 = r[i] * s, y1 = (m.hMm - r[i + 1]) * s;
    if (y0 !== y1) edges.push(x0, y0, x1, y1);
  }
  const xs = [];
  for (let y = 0; y < m.h; y++) {
    const cy = y + 0.5; xs.length = 0;
    for (let k = 0; k < edges.length; k += 4) {
      const y0 = edges[k + 1], y1 = edges[k + 3];
      if ((y0 <= cy) !== (y1 <= cy)) xs.push(edges[k] + (cy - y0) * (edges[k + 2] - edges[k]) / (y1 - y0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(m.w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) m.data[y * m.w + x] = v;
    }
  }
}
/** Chamfer (3-4) distance, in pixels, from every pixel to the nearest pixel where data == target. */
export function distanceTo(m, target = 1) {
  const { w, h, data } = m, INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = data[i] === target ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i]; if (v === 0) continue;
    if (x > 0) v = Math.min(v, d[i - 1] + a);
    if (y > 0) { v = Math.min(v, d[i - w] + a); if (x > 0) v = Math.min(v, d[i - w - 1] + b); if (x < w - 1) v = Math.min(v, d[i - w + 1] + b); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i]; if (v === 0) continue;
    if (x < w - 1) v = Math.min(v, d[i + 1] + a);
    if (y < h - 1) { v = Math.min(v, d[i + w] + a); if (x < w - 1) v = Math.min(v, d[i + w + 1] + b); if (x > 0) v = Math.min(v, d[i + w - 1] + b); }
    d[i] = v;
  }
  return d;
}
/** Morphological closing (dilate then erode) by radius rMm: fills gaps narrower than 2 r. */
export function closeMask(m, rMm) {
  const r = rMm / m.mmPerPx;
  if (r < 0.5) return m;
  const dIn = distanceTo(m, 1);
  const dil = { ...m, data: new Uint8Array(m.w * m.h) };
  for (let i = 0; i < dIn.length; i++) dil.data[i] = dIn[i] <= r ? 1 : 0;
  const dOut = distanceTo(dil, 0);
  const out = { ...m, data: new Uint8Array(m.w * m.h) };
  for (let i = 0; i < dOut.length; i++) out.data[i] = dOut[i] > r ? 1 : 0;
  // never lose original pixels
  for (let i = 0; i < out.data.length; i++) if (m.data[i]) out.data[i] = 1;
  return out;
}
/** Morphological opening (erode then dilate) by radius rMm: rounds convex corners, drops thin spurs. */
export function openMask(m, rMm) {
  const r = rMm / m.mmPerPx;
  if (r < 0.5) return m;
  const dOut = distanceTo(m, 0);
  const ero = { ...m, data: new Uint8Array(m.w * m.h) };
  for (let i = 0; i < dOut.length; i++) ero.data[i] = dOut[i] > r ? 1 : 0;
  const dIn = distanceTo(ero, 1);
  const out = { ...m, data: new Uint8Array(m.w * m.h) };
  for (let i = 0; i < dIn.length; i++) out.data[i] = dIn[i] <= r ? 1 : 0;
  return out;
}
/** Fill enclosed background (holes) of the mask. */
export function fillHoles(m) {
  const { w, h, data } = m;
  const out = new Uint8Array(w * h).fill(1);
  const st = [];
  for (let x = 0; x < w; x++) { st.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { st.push(y * w, y * w + w - 1); }
  while (st.length) {
    const i = st.pop();
    if (out[i] === 0 || data[i]) continue;
    out[i] = 0;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) st.push(i - 1); if (x < w - 1) st.push(i + 1); if (y > 0) st.push(i - w); if (y < h - 1) st.push(i + w);
  }
  return { ...m, data: out };
}
/** Remove single-corner (diagonal-only) contacts so every contour is a simple ring. */
export function fixDiagonals(m) {
  const { w, h, data } = m;
  for (let pass = 0; pass < 8; pass++) {
    let changed = 0;
    for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
      const a = data[y * w + x], b = data[y * w + x + 1], c = data[(y + 1) * w + x], d = data[(y + 1) * w + x + 1];
      if (a && d && !b && !c) { data[y * w + x + 1] = 1; changed++; }
      else if (b && c && !a && !d) { data[y * w + x] = 1; changed++; }
    }
    if (!changed) break;
  }
  return m;
}

// ---------------------------------------------------------------- contours
/**
 * Boundary rings of a binary mask in mm (Y up), smoothed to pixel-edge midpoints (45 degree
 * corners) and simplified by eps mm. Returns [{ outer, holes: [ring] }] with outer ccw, holes cw.
 * Call fixDiagonals first; the mask border is treated as background.
 */
export function contours(m, eps = 0.03) {
  const { w, h, data } = m, s = m.mmPerPx;
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? data[y * w + x] : 0;
  // directed pixel edges with foreground on the left (image coords, y down): vertices on the
  // (w+1) x (h+1) corner grid. Each corner has at most one outgoing edge after fixDiagonals.
  const W1 = w + 1;
  const next = new Int32Array(W1 * (h + 1)).fill(-1);
  for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
    // horizontal edge from corner (x,y) to (x+1,y): pixel above (x,y-1), below (x,y)
    if (x < w) {
      const up = at(x, y - 1), dn = at(x, y);
      if (dn && !up) next[y * W1 + x + 1] = y * W1 + x;        // edge (x+1,y)->(x,y): fg below, moving left... fg on the left in y-down? see below
      else if (up && !dn) next[y * W1 + x] = y * W1 + x + 1;
    }
    if (y < h) {
      const lf = at(x - 1, y), rt = at(x, y);
      if (rt && !lf) next[y * W1 + x] = (y + 1) * W1 + x;
      else if (lf && !rt) next[(y + 1) * W1 + x] = y * W1 + x;
    }
  }
  const seen = new Uint8Array(W1 * (h + 1));
  const loops = [];
  for (let c0 = 0; c0 < next.length; c0++) {
    if (next[c0] < 0 || seen[c0]) continue;
    const pts = [];
    let c = c0, guard = 0;
    while (!seen[c] && next[c] >= 0 && guard++ < 1e8) {
      seen[c] = 1;
      const n = next[c];
      // midpoint of the edge c -> n, in mm, Y up
      const cx = c % W1, cy = (c / W1) | 0, nx = n % W1, ny = (n / W1) | 0;
      pts.push((cx + nx) / 2 * s, m.hMm - (cy + ny) / 2 * s);
      c = n;
    }
    if (pts.length >= 6) loops.push(simplifyRing(pts, eps));
  }
  // orientation: positive area = one kind; the kind that encloses the most area is "outer"
  const outers = [], holes = [];
  for (const r of loops) { const a = ringArea(r); if (Math.abs(a) < 1e-6) continue; (a > 0 ? outers : holes).push({ r, a: Math.abs(a) }); }
  // with foreground-on-the-right in a y-down image, outer loops come out ccw in Y-up coords;
  // if that assumption were wrong, the biggest loop would be a "hole": swap
  const maxO = outers.reduce((m, o) => Math.max(m, o.a), 0), maxH = holes.reduce((m, o) => Math.max(m, o.a), 0);
  let O = outers, Hs = holes;
  if (maxH > maxO) { O = holes.map(o => ({ r: reverseRing(o.r), a: o.a })); Hs = outers.map(o => ({ r: reverseRing(o.r), a: o.a })); }
  O.sort((a, b) => a.a - b.a);
  const polys = O.map(o => ({ outer: o.r, holes: [], area: o.a, bbox: bbox(o.r) }));
  for (const hh of Hs) {
    const x = hh.r[0], y = hh.r[1];
    for (const p of polys) {
      if (p.area < hh.a) continue;
      const b = p.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInRing(p.outer, x, y)) { p.holes.push(hh.r); break; }
    }
  }
  return polys.map(p => ({ outer: p.outer, holes: p.holes }));
}
function bbox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
  return [x0, y0, x1, y1];
}

// ---------------------------------------------------------------- meshes
class Builder {
  constructor() { this.p = []; this.t = []; }
  v(x, y, z) { this.p.push(x, y, z); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.t.push(a, b, c); }
  quad(a, b, c, d) { this.t.push(a, b, c, a, c, d); }
  mesh() { return { positions: new Float32Array(this.p), indices: new Uint32Array(this.t) }; }
}
/** Remove repeated and exactly collinear points of a ring (as earcut would). */
export function cleanRing(r) {
  let cur = r, changed = true;
  while (changed && cur.length >= 6) {
    changed = false;
    const n = cur.length / 2, out = [];
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const ax = cur[2 * a], ay = cur[2 * a + 1], px = cur[2 * i], py = cur[2 * i + 1], bx = cur[2 * b], by = cur[2 * b + 1];
      const same = px === bx && py === by;
      const col = (py - ay) * (bx - px) - (px - ax) * (by - py) === 0;
      if (same || col) { changed = true; continue; }
      out.push(px, py);
    }
    cur = out;
    if (changed) continue;
  }
  return cur;
}
/** Extrude polygons-with-holes [{ outer, holes }] between z0 and z1: caps + walls, watertight. */
export function extrudePolygons(polys, z0, z1) {
  const B = new Builder();
  for (const { outer, holes = [] } of polys) {
    // earcut drops repeated and exactly collinear points; drop them first so walls and caps share vertices
    const rings = [ccw(cleanRing(Array.from(outer))), ...holes.map(h => cw(cleanRing(Array.from(h))))].filter(r => r.length >= 6);
    if (!rings.length || ringArea(rings[0]) <= 0) continue;
    const flat = [], holeIdx = [];
    // (a loop, not push(...ring): a long ring would overflow the stack in a browser worker)
    for (let k = 0; k < rings.length; k++) { if (k) holeIdx.push(flat.length / 2); const r = rings[k]; for (let i = 0; i < r.length; i++) flat.push(r[i]); }
    const n = flat.length / 2;
    const base = B.p.length / 3;
    for (let i = 0; i < n; i++) B.p.push(flat[2 * i], flat[2 * i + 1], z0);
    for (let i = 0; i < n; i++) B.p.push(flat[2 * i], flat[2 * i + 1], z1);
    const tris = earcut(flat, holeIdx);
    for (let k = 0; k < tris.length; k += 3) {
      let a = tris[k], b = tris[k + 1], c = tris[k + 2];
      const ar = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
      if (ar < 0) { const t = b; b = c; c = t; }
      B.tri(base + n + a, base + n + b, base + n + c);    // top, ccw from above
      B.tri(base + a, base + c, base + b);                // bottom, cw from above
    }
    let off = 0;
    for (const r of rings) {
      const m = r.length / 2;
      for (let i = 0; i < m; i++) {
        const a = base + off + i, b = base + off + (i + 1) % m;
        B.quad(a, b, b + n, a + n);
      }
      off += m;
    }
  }
  return B.mesh();
}
/**
 * Sweep a closed 2D profile along a closed ring (ccw, mm). Profile points are
 * [offset (outward from the ring, mm), z] in ccw order seen with offset right and z up.
 */
export function sweepClosed(ring, profile) {
  const B = new Builder();
  const n = ring.length / 2, m = profile.length;
  // vertex normals (outward for a ccw ring: right of the direction of travel), miter-limited
  const NX = new Float64Array(n), NY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    let e1x = ring[2 * i] - ring[2 * a], e1y = ring[2 * i + 1] - ring[2 * a + 1];
    let e2x = ring[2 * b] - ring[2 * i], e2y = ring[2 * b + 1] - ring[2 * i + 1];
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    let nx = (e1y + e2y), ny = -(e1x + e2x);
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const c = Math.max(0.5, nx * e1y - ny * e1x);   // cos of half the turn; miter limit 2
    NX[i] = nx / c; NY[i] = ny / c;
  }
  const base = B.p.length / 3;
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const [o, z] = profile[j];
    B.p.push(ring[2 * i] + NX[i] * o, ring[2 * i + 1] + NY[i] * o, z);
  }
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const a = base + i * m + j, b = base + i * m + j2, c = base + i2 * m + j2, d = base + i2 * m + j;
      B.quad(a, d, c, b);
    }
  }
  const mesh = B.mesh();
  return signedVolume(mesh) < 0 ? flip(mesh) : mesh;
}
/** Closed solid under a heightfield: grid of (w x h) samples (row 0 = top, Y = (h-1)*mm), zOf(v) mm. */
export function heightfieldMesh(field, w, h, mmPerPx, zOf = v => v) {
  const B = new Builder();
  const Hmm = (h - 1) * mmPerPx;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) B.p.push(x * mmPerPx, Hmm - y * mmPerPx, zOf(field[y * w + x]));
  const T = (x, y) => y * w + x;
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
    // image rows go down in Y: (x,y+1) is below (x,y); ccw from above = (x,y+1) -> (x+1,y+1) -> (x+1,y) -> (x,y)
    B.quad(T(x, y + 1), T(x + 1, y + 1), T(x + 1, y), T(x, y));
  }
  // bottom: the rectangle's boundary loop at z = 0, triangulated as strips to a spine
  const ringIdx = [];
  for (let x = 0; x < w; x++) ringIdx.push(T(x, h - 1));
  for (let y = h - 2; y >= 0; y--) ringIdx.push(T(w - 1, y));
  for (let x = w - 2; x >= 0; x--) ringIdx.push(T(x, 0));
  for (let y = 1; y < h - 1; y++) ringIdx.push(T(0, y));
  const nb = ringIdx.length, bb = B.p.length / 3;
  for (const i of ringIdx) B.p.push(B.p[3 * i], B.p[3 * i + 1], 0);
  for (let k = 0; k < nb; k++) {
    const a = ringIdx[k], b = ringIdx[(k + 1) % nb];
    B.quad(bb + k, bb + (k + 1) % nb, b, a);
  }
  const flat = []; for (let k = 0; k < nb; k++) flat.push(B.p[3 * (bb + k)], B.p[3 * (bb + k) + 1]);
  const tris = earcut(flat, null);
  for (let k = 0; k < tris.length; k += 3) {
    let a = tris[k], b = tris[k + 1], c = tris[k + 2];
    const ar = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
    if (ar > 0) { const t = b; b = c; c = t; }
    B.tri(bb + a, bb + b, bb + c);
  }
  return B.mesh();
}
/** Axis-aligned box as a mesh. */
export function box(x0, y0, z0, x1, y1, z1) { return extrudePolygons([{ outer: [x0, y0, x1, y0, x1, y1, x0, y1], holes: [] }], z0, z1); }
export function merge(meshes) {
  let np = 0, ni = 0;
  for (const m of meshes) { np += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(np), indices = new Uint32Array(ni);
  let op = 0, oi = 0;
  for (const m of meshes) {
    positions.set(m.positions, op);
    const off = op / 3;
    for (let k = 0; k < m.indices.length; k++) indices[oi + k] = m.indices[k] + off;
    op += m.positions.length; oi += m.indices.length;
  }
  return { positions, indices };
}
export function transform(mesh, fn) {
  const p = mesh.positions.slice();
  const o = [0, 0, 0];
  for (let i = 0; i < p.length; i += 3) { fn(p[i], p[i + 1], p[i + 2], o); p[i] = o[0]; p[i + 1] = o[1]; p[i + 2] = o[2]; }
  return { positions: p, indices: mesh.indices };
}
export function flip(mesh) {
  const t = mesh.indices.slice();
  for (let k = 0; k < t.length; k += 3) { const a = t[k + 1]; t[k + 1] = t[k + 2]; t[k + 2] = a; }
  return { positions: mesh.positions, indices: t };
}
export function signedVolume(mesh) {
  const P = mesh.positions, T = mesh.indices;
  let v = 0;
  for (let k = 0; k < T.length; k += 3) {
    const a = 3 * T[k], b = 3 * T[k + 1], c = 3 * T[k + 2];
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}
export function bounds(mesh) {
  const P = mesh.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < lo[k]) lo[k] = P[i + k]; if (P[i + k] > hi[k]) hi[k] = P[i + k]; }
  return { lo, hi };
}
/** Edge-manifold check by vertex position (welded at 1e-4 mm): every directed edge once, its reverse once. */
export function checkManifold(mesh) {
  const P = mesh.positions, T = mesh.indices;
  // weld identical positions so separately built pieces that share vertices count as joined
  const key = new Map(), id = new Uint32Array(P.length / 3);
  let nid = 0;
  for (let i = 0; i < id.length; i++) {
    const k = Math.round(P[3 * i] * 1e4) + ',' + Math.round(P[3 * i + 1] * 1e4) + ',' + Math.round(P[3 * i + 2] * 1e4);
    let v = key.get(k); if (v === undefined) { v = nid++; key.set(k, v); } id[i] = v;
  }
  const E = new Map();
  let degenerate = 0;
  for (let k = 0; k < T.length; k += 3) {
    const a = id[T[k]], b = id[T[k + 1]], c = id[T[k + 2]];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) { const kk = u * nid + v; E.set(kk, (E.get(kk) || 0) + 1); }
  }
  let openEdges = 0, nonManifold = 0;
  for (const [kk, cnt] of E) {
    const u = Math.floor(kk / nid), v = kk - u * nid;
    const r = E.get(v * nid + u) || 0;
    if (cnt > 1) nonManifold++;
    else if (r === 0) openEdges++;
    else if (r > 1) nonManifold++;
  }
  const volume = signedVolume(mesh);
  return { ok: openEdges === 0 && nonManifold === 0 && degenerate === 0 && volume > 0, openEdges, nonManifold, degenerate, volume, triangles: T.length / 3 };
}

// ---------------------------------------------------------------- writers
export function writeSTL(mesh, name = 'spiralist') {
  const P = mesh.positions, T = mesh.indices, n = T.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
  const head = ('Spiralist ' + name).slice(0, 79);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i) & 127);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let k = 0; k < T.length; k += 3) {
    const a = 3 * T[k], b = 3 * T[k + 1], c = 3 * T[k + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); o += 12;
    for (const q of [a, b, c]) { dv.setFloat32(o, P[q], true); dv.setFloat32(o + 4, P[q + 1], true); dv.setFloat32(o + 8, P[q + 2], true); o += 12; }
    o += 2;
  }
  return buf;
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = -1; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
/** Stored (uncompressed) zip of [{ name, data: Uint8Array }] -> Uint8Array. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + size;
  }
  let csize = 0; for (const c of central) csize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, off, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  let total = 0; for (const c of all) total += c.length;
  const out = new Uint8Array(total); let o = 0;
  for (const c of all) { out.set(c, o); o += c.length; }
  return out;
}
const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const f3 = v => { const r = Math.round(v * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };
/**
 * 3MF (core spec) with one object per part so a slicer can give each its own filament.
 * parts: [{ name, mesh, color: '#rrggbb' }]; meta: { title, designer, description }. Returns Uint8Array
 * (wrap in a Blob with type 'model/3mf' in the browser).
 */
export function write3MF(parts, meta = {}) {
  const enc = new TextEncoder();
  const model = [];
  model.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  model.push(`<metadata name="Title">${esc(meta.title || 'Spiralist print')}</metadata>\n<metadata name="Designer">${esc(meta.designer || 'Spiralist')}</metadata>\n`);
  if (meta.description) model.push(`<metadata name="Description">${esc(meta.description)}</metadata>\n`);
  model.push('<resources>\n<basematerials id="1">\n');
  for (const p of parts) model.push(`<base name="${esc(p.name)}" displaycolor="${esc((p.color || '#808080').toUpperCase())}FF"/>\n`);
  model.push('</basematerials>\n');
  parts.forEach((p, k) => {
    const P = p.mesh.positions, T = p.mesh.indices;
    model.push(`<object id="${k + 2}" name="${esc(p.name)}" type="model" pid="1" pindex="${k}">\n<mesh>\n<vertices>\n`);
    let s = [];
    for (let i = 0; i < P.length; i += 3) {
      s.push(`<vertex x="${f3(P[i])}" y="${f3(P[i + 1])}" z="${f3(P[i + 2])}"/>\n`);
      if (s.length > 20000) { model.push(s.join('')); s = []; }
    }
    model.push(s.join('')); s = [];
    model.push('</vertices>\n<triangles>\n');
    for (let i = 0; i < T.length; i += 3) {
      s.push(`<triangle v1="${T[i]}" v2="${T[i + 1]}" v3="${T[i + 2]}"/>\n`);
      if (s.length > 20000) { model.push(s.join('')); s = []; }
    }
    model.push(s.join(''));
    model.push('</triangles>\n</mesh>\n</object>\n');
  });
  model.push('</resources>\n<build>\n');
  parts.forEach((p, k) => model.push(`<item objectid="${k + 2}"/>\n`));
  model.push('</build>\n</model>\n');
  // encode chunk by chunk (a 100 MB string would not fit some engines)
  const bytes = model.map(s => enc.encode(s));
  let total = 0; for (const b of bytes) total += b.length;
  const modelU8 = new Uint8Array(total); let o = 0; for (const b of bytes) { modelU8.set(b, o); o += b.length; }
  const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n';
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: modelU8 },
  ]);
}
