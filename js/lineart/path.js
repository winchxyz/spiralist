// Line art: ONE continuous line through a few salient contours, ordered and paced the way a person
// draws a continuous-line portrait (Picasso's one-line animals, Matisse's pen portraits, blind
// contour). This module only plans and times the line; js/lineart/lines.js finds the strokes.
//
//   buildLineArt(strokes, features, opts) -> geom (spiral.js format, path 'lineart') with
//     geom.handT    Float32Array(n), cumulative seconds of hand drawing per point (also installed
//                   as every pacing table, as in Realistic mode)
//     geom.lineart  { strokes, dropped, lengthM, handSeconds, retracedM, bridgesM, drawnM, hatchM,
//                     order: [{ kind, sal, lenMm, closed, src }] in drawing order,
//                     seg: Uint8Array(n) 0 new line | 1 retrace | 2 bridge | 3 hatch,
//                     stroke: Int16Array(n) index into order (-1 on travel), buildMs, ms }
//   Render it like Realistic mode: layout { cx: .5, cy: .5, r: LAYOUT_R } and setSheetMm(sheetMm).
//
// Strokes (the LA-lines contract): { points: Float32Array [x,y,..] in fractions (0..1, y down) of
// the square art frame, closed, saliency 0..1, kind, dark 0..1 }. features = { face: { box,
// landmarks } | null, dark: { w, h, data } | null }.
//
// How a person does it, and so how this does:
//   1. Keep a few telling lines (budget scaled to the face), most of the paper stays empty.
//   2. Visit features one at a time from a natural start (the brow on the light side), sweeping
//      brow -> eye -> nose -> mouth -> jaw/outline -> ear -> hair, never hopping back and forth.
//   3. Travel by going back over lines already drawn (shortest paths on the drawn network, doubling
//      accepted); only where no drawn line leads there, a short new bridge that leaves in the pen's
//      heading and arrives along the next stroke. Strokes that would need a long bridge and matter
//      little are left out.
//   4. The hand: speed follows the 2/3 power law (slow in tight curves, quick on straights) with
//      limited acceleration (so it eases into corners and out of them), a short look at the model
//      before each new feature, gentle low-frequency drift (not noise), a small overshoot at sharp
//      corners and a little loop where the line turns back on itself. Brushes and nibs press harder
//      where the hand is slow and where the photo is dark; fineliners and wire keep one width.
//
// Coordinates: circle units (the art square is [-1,1]^2), laid out like Realistic mode, so one
// unit is LAYOUT_R x sheetMm millimetres.

import { STRIDE, finishGeometry } from '../spiral.js';

export const LAYOUT_R = 0.42;   // the Realistic mode sheet layout (js/real/index.js)

/** Media whose mark follows hand pressure (width and density); the rest draw one width. */
export const PRESSURE_TOOLS = new Set(['brush', 'watercolour', 'fountain', 'pencil', 'charcoal', 'crayon', 'chalk']);

export const LINEART_DEFAULTS = Object.freeze({
  sheetMm: 210,
  toolMm: 0.4,
  tool: 'fineliner',   // brush id
  pressure: null,      // null = by tool (PRESSURE_TOOLS)
  style: 'sparse',     // 'sparse' (a few lines) | 'rich' (more contours)
  wobble: 0.5,         // hand drift 0..1
  overshoot: 0.5,      // corner overshoot and turn-back loops 0..1
  hatch: 0,            // loose hatching in the darkest spots 0..1
  speedMm: 24,         // pen speed on a straight run, mm/s (a careful, confident contour)
  seed: 1,
});

// kind -> [order group, importance]. Groups give the sweep: brow, eyes, nose, mouth, jaw and
// outline, ear, hair (and the hatching that shades it), the rest.
const KINDS = {
  brow: [0, 0.8], eye: [1, 1], iris: [1, 0.95], nose: [2, 0.95], lips: [3, 0.95],
  jaw: [4, 0.9], outline: [4, 1], ear: [5, 0.7], hair: [6, 0.75], hatch: [6, 0.5],
  detail: [7, 0.5], other: [7, 0.65],
};
const SEG_DRAW = 0, SEG_RETRACE = 1, SEG_BRIDGE = 2, SEG_HATCH = 3;
/** Small features drawn plainly: no corner overshoot, no turn-back loop out of them. */
const NO_FLOURISH = new Set(['eye', 'iris', 'lips']);
/** Corners that belong to the subject (eye and mouth corners, ear tips): never rounded off. */
const KEEP_CORNERS = new Set(['eye', 'iris', 'lips', 'ear']);

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash1(i, seed) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Smooth 1D value noise in [-1, 1]. */
function noise1(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return (hash1(i, seed) * (1 - u) + hash1(i + 1, seed) * u) * 2 - 1;
}

/** Points [x,y,...] at even arc spacing (closed: the loop without repeating the first point). */
function resample(src, closed, step) {
  const n = src.length / 2;
  const out = [src[0], src[1]];
  if (n < 2) return out;
  const m = closed ? n : n - 1;
  let need = step;
  for (let k = 0; k < m; k++) {
    const a = 2 * k, b = 2 * ((k + 1) % n);
    const ax = src[a], ay = src[a + 1], bx = src[b], by = src[b + 1];
    const L = Math.hypot(bx - ax, by - ay);
    let t0 = 0;
    while (L - t0 >= need) {
      t0 += need;
      const t = t0 / L;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      need = step;
    }
    need -= L - t0;
  }
  const q = out.length;
  if (closed) {
    if (q >= 6 && Math.hypot(out[q - 2] - out[0], out[q - 1] - out[1]) < step * 0.5) out.length -= 2;
  } else {
    const lx = src[2 * n - 2], ly = src[2 * n - 1];
    if (Math.hypot(lx - out[q - 2], ly - out[q - 1]) > step * 0.3) out.push(lx, ly);
    else { out[q - 2] = lx; out[q - 1] = ly; }
  }
  return out;
}

function polyLen(p, closed) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  if (closed && p.length > 4) s += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
  return s;
}

// ------------------------------------------------------------------ the drawn network
// Nodes are the points of every stroke drawn so far; edges join neighbours along a stroke and
// points of different strokes that touch (junctions). Travel = shortest paths on it.
class Net {
  constructor(cell) { this.x = []; this.y = []; this.adj = []; this.cell = cell; this.grid = new Map(); }
  // integer cell keys (the frame spans a few hundred cells; string keys made planning slow)
  _key(x, y) { return (Math.floor(x / this.cell) + 4096) * 8192 + Math.floor(y / this.cell) + 4096; }
  add(x, y) {
    const id = this.x.length;
    this.x.push(x); this.y.push(y); this.adj.push([]);
    const k = this._key(x, y);
    const c = this.grid.get(k);
    if (c) c.push(id); else this.grid.set(k, [id]);
    return id;
  }
  link(a, b) {
    const d = Math.hypot(this.x[a] - this.x[b], this.y[a] - this.y[b]);
    this.adj[a].push(b, d); this.adj[b].push(a, d);
  }
  near(x, y, r, fn) {
    const c = this.cell, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((y - r) / c), j1 = Math.floor((y + r) / c);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const ids = this.grid.get((i + 4096) * 8192 + j + 4096);
      if (!ids) continue;
      for (const id of ids) {
        const d = Math.hypot(this.x[id] - x, this.y[id] - y);
        if (d <= r) fn(id, d);
      }
    }
  }
  /** Add a drawn stroke (its points in drawing order); returns the node ids. */
  addStroke(pts, closed, tolJ) {
    const first = this.x.length, ids = [];
    let lastX = -99;
    for (let i = 0; i < pts.length; i += 2) {
      // a junction where this stroke starts or ends on an earlier one (only there: linking every
      // point of two parallel lines would let travel zig-zag between them in little rungs)
      // Where it crosses one (closer than a third of that), it joins there too.
      const end = i === 0 || i === pts.length - 2, reach = end ? tolJ : tolJ * 0.33;
      let best = -1, bd = reach;
      if (end || i - lastX > 12) this.near(pts[i], pts[i + 1], reach, (id, d) => { if (id < first && d < bd) { bd = d; best = id; } });
      if (best >= 0 && !end) lastX = i;
      const id = this.add(pts[i], pts[i + 1]);
      if (best >= 0) this.link(id, best);
      if (ids.length) this.link(ids[ids.length - 1], id);
      ids.push(id);
    }
    if (closed && ids.length > 2) this.link(ids[ids.length - 1], ids[0]);
    return ids;
  }
  dijkstra(src) {
    const N = this.x.length;
    const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
    const hk = [], hv = [];
    const push = (k, v) => {
      let i = hk.length; hk.push(k); hv.push(v);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p]; hv[i] = hv[p]; i = p;
      }
      hk[i] = k; hv[i] = v;
    };
    const pop = () => {
      const v = hv[0], lk = hk.pop(), lv = hv.pop();
      if (hk.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= hk.length) break;
          if (c + 1 < hk.length && hk[c + 1] < hk[c]) c++;
          if (hk[c] >= lk) break;
          hk[i] = hk[c]; hv[i] = hv[c]; i = c;
        }
        hk[i] = lk; hv[i] = lv;
      }
      return v;
    };
    dist[src] = 0; push(0, src);
    while (hk.length) {
      const d0 = hk[0], u = pop();
      if (d0 > dist[u]) continue;
      const a = this.adj[u];
      for (let e = 0; e < a.length; e += 2) {
        const v = a[e], nd = d0 + a[e + 1];
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(nd, v); }
      }
    }
    return { dist, prev };
  }
}

// ------------------------------------------------------------------ hatching
/** Loose zig-zag patches inside the darkest spots of features.dark (frame fractions -> CU). */
function hatchStrokes(dark, amount, spacing, rand, nearDrawing) {
  if (!dark || !dark.data || !(amount > 0)) return [];
  const { w, h, data } = dark;
  // the darkest spots OF THE SUBJECT: rank only the cells near the drawn lines, so a dark
  // backdrop does not push every shadow on a pale subject (a plaster bust) under the threshold
  const near = new Uint8Array(w * h);
  const nearVals = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (nearDrawing((i + 0.5) / w * 2 - 1, (j + 0.5) / h * 2 - 1)) { near[j * w + i] = 1; nearVals.push(data[j * w + i]); }
  }
  const vals = (nearVals.length > 40 ? nearVals : Array.from(data)).sort((a, b) => a - b);
  // relative darks: the photo's own range around the subject decides (a pale plaster bust has
  // shadows too), with a floor so an evenly lit subject is not hatched all over
  const lo = vals[Math.floor(vals.length * 0.05)] || 0, hi = vals[Math.floor(vals.length * 0.985)] || 1;
  const thr = Math.max(lo + 0.5 * (hi - lo), 0.12, vals[Math.floor(vals.length * (0.93 - 0.2 * amount))] || 1);
  if (hi - lo < 0.08) return [];
  // a dark backdrop beside the outline (a night sky, a studio wall) forms long bands along it,
  // far bigger than a patch of shade, so the size cap below leaves it out; a subject that runs
  // off the frame (shoulders, a cat's body) keeps its own shadows
  const maxCells = (w * h) / 45;                   // a patch of shade, not a filled area
  const lab = new Int32Array(w * h).fill(-1);
  const comps = [];
  for (let s = 0; s < w * h; s++) {
    if (lab[s] >= 0 || data[s] < thr || !near[s]) continue;
    const cells = [s]; lab[s] = comps.length;
    let border = false;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k], i = c % w, j = (c / w) | 0;
      if (i === 0 || j === 0 || i === w - 1 || j === h - 1) border = true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const q = jj * w + ii;
        if (lab[q] < 0 && data[q] >= thr && near[q]) { lab[q] = comps.length; cells.push(q); }
      }
    }
    // a big dark area: a band hugging an outline (sparse in its box) is backdrop and goes; a
    // solid dark mass (a tabby's back, hair) is shaded only in its darkest core
    if (cells.length > maxCells) {
      let x0 = w, x1 = 0, y0 = h, y1 = 0;
      for (const c of cells) { const i = c % w, j = (c / w) | 0; if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
      const fill = cells.length / ((x1 - x0 + 1) * (y1 - y0 + 1));
      if (fill >= 0.35) {
        cells.sort((a, b) => data[b] - data[a]);
        for (const c of cells.splice(Math.floor(maxCells))) lab[c] = -2;
        // the core decides whether this is backdrop at the frame's edge
        border = cells.some(c => { const i = c % w, j = (c / w) | 0; return i <= 1 || j <= 1 || i >= w - 2 || j >= h - 2; });
      }
    }
    let sum = 0, cx = 0, cy = 0;
    for (const c of cells) { sum += data[c]; cx += ((c % w) + 0.5) / w * 2 - 1; cy += (((c / w) | 0) + 0.5) / h * 2 - 1; }
    // shade belongs to the subject: not the background at the frame's edge, not far from any line
    const ok = !border && cells.length <= maxCells && nearDrawing(cx / cells.length, cy / cells.length);
    comps.push({ cells, weight: ok ? sum : 0 });
  }
  const minCells = Math.max(3, (w * h) / 900);
  const keep = comps.filter(c => c.weight > 0 && c.cells.length >= minCells).sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(1, Math.round(1 + 5 * amount)));
  const inside = (x, y, id) => {
    const i = Math.floor((x + 1) / 2 * w), j = Math.floor((y + 1) / 2 * h);
    return i >= 0 && j >= 0 && i < w && j < h && lab[j * w + i] === id;
  };
  const out = [];
  for (const c of keep) {
    const id = lab[c.cells[0]];
    // strokes lean like a right hand's hatching (lower left to upper right), a little varied
    const ang = -Math.PI / 4 + (rand() - 0.5) * 0.35;
    const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const s of c.cells) {
      const x = ((s % w) + 0.5) / w * 2 - 1, y = (((s / w) | 0) + 0.5) / h * 2 - 1;
      const u = x * ux + y * uy, v = x * vx + y * vy;
      umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
    }
    const P = (u, v) => [u * ux + v * vx, u * uy + v * vy];
    const du = 2 / Math.max(w, h) * 0.5;
    const rows = [];
    for (let v = vmin + spacing * 0.5; v <= vmax; v += spacing * (0.8 + 0.4 * rand())) {
      let a = null, b = null;
      for (let u = umin - du; u <= umax + du; u += du) {
        const [x, y] = P(u, v);
        if (inside(x, y, id)) { if (a === null) a = u; b = u; }
      }
      if (a === null || b - a < spacing * 1.5) continue;
      rows.push([a, b, v]);
    }
    // a brush artist lays three to six strokes in one direction: the middle of the patch
    if (rows.length < 3) continue;
    const r0 = Math.max(0, Math.floor((rows.length - 6) / 2));
    // one zigzag: each stroke starts where the last one ended and runs across the patch at a
    // slight slant, so every turn is a sharp V (a flick back), never a square step or a loop
    const pts = [];
    let flip = false;
    // strokes of about one length, stacked on one centre line: a set of parallel hatches reads
    // as shading; strokes that each span their own row of an irregular patch read as a scribble
    const cap0 = 0.12;
    const use = rows.slice(r0, r0 + 6).filter(([a, b]) => b - a >= 0.5 * cap0).slice(0, 5);
    if (use.length < 3) continue;
    const mids = use.map(([a, b]) => (a + b) / 2).sort((p, q) => p - q), midC = mids[mids.length >> 1];
    use.forEach(([a, b, v], k) => {
      const L = Math.min(b - a, cap0 * (0.85 + 0.3 * rand()));
      const m = Math.max(a + L / 2, Math.min(b - L / 2, midC + (rand() - 0.5) * 0.2 * L));
      const ia = m - L / 2, ib = m + L / 2;
      const e0 = flip ? ib : ia, e1 = flip ? ia : ib;
      const vn = k + 1 < use.length ? use[k + 1][2] : v + spacing;
      const v0 = v - 0.25 * (vn - v), v1 = v + 0.25 * (vn - v), bow = (rand() - 0.3) * 0.06 * Math.abs(e1 - e0);
      for (let q = k ? 1 : 0; q <= 6; q++) {
        const t = q / 6, uu = e0 + (e1 - e0) * t, vv = v0 + (v1 - v0) * t + bow * 4 * t * (1 - t);
        const [x, y] = P(uu, vv);
        pts.push(x, y);
      }
      flip = !flip;
    });
    if (pts.length >= 24) out.push({ pts, closed: false, kind: 'hatch', sal: 0.3 + 0.3 * amount, dark: 1, hatch: true });
  }
  return out;
}

/** An open line whose last couple of millimetres turn sharply back (a thinning spur where the
 *  model's line met another: at a mouth corner it read as a fang) loses that hook. */
function trimHooks(pts, hook, arm) {
  const n = pts.length / 2;
  let a = 0, b = n - 1;
  const cut = (from, dir) => {
    let L = 0, i = from, A = -1;
    while (i + dir >= 0 && i + dir < n) {
      L += Math.hypot(pts[2 * (i + dir)] - pts[2 * i], pts[2 * (i + dir) + 1] - pts[2 * i + 1]);
      i += dir;
      if (A < 0 && L >= hook) A = i;
      if (L >= hook + arm) break;
    }
    if (A < 0 || L < hook + arm) return from;
    const d1x = pts[2 * from] - pts[2 * A], d1y = pts[2 * from + 1] - pts[2 * A + 1];
    const d0x = pts[2 * A] - pts[2 * i], d0y = pts[2 * A + 1] - pts[2 * i + 1];
    const c = (d0x * d1x + d0y * d1y) / ((Math.hypot(d0x, d0y) * Math.hypot(d1x, d1y)) || 1);
    return c < -0.2 ? A : from;
  };
  if (n > 12) { a = cut(0, 1); b = cut(n - 1, -1); }
  if (b - a < 0.6 * n) return pts;
  return a === 0 && b === n - 1 ? pts : pts.slice(2 * a, 2 * b + 2);
}

/** The head of an open stroke eased toward the pen (offset ox, oy at the entry, fading out over
 *  length L): the pen runs on into the next line the way a hand merges two nearby contours. */
function blendHead(s, j, dir, ox, oy, L) {
  const pts = Array.from(s.pts), n = pts.length / 2;
  let a = 0;
  for (let k = 0; k < n; k++) {
    const i = j + dir * k;
    if (i < 0 || i >= n) break;
    if (k) { const q = i - dir; a += Math.hypot(pts[2 * i] - pts[2 * q], pts[2 * i + 1] - pts[2 * q + 1]); }
    if (a >= L) break;
    const u = a / L, w = 1 - u * u * (3 - 2 * u);
    pts[2 * i] += ox * w; pts[2 * i + 1] += oy * w;
  }
  return { ...s, pts };
}

/** A tour over the whole drawing (nearest neighbour from the start, then 2-opt on the stroke
 *  centres; face strokes keep their kind groups in order): s.rank is each stroke's place in it. */
function planTour(list, first, kinds) {
  const n = list.length;
  if (!n) return;
  const key = s => (kinds ? kinds[s.kind][0] : 0);
  const D = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy) + (kinds ? 0.25 * Math.abs(key(a) - key(b)) : 0);
  const used = new Uint8Array(n), tour = [first];
  used[first] = 1;
  for (let k = 1; k < n; k++) {
    const a = list[tour[k - 1]];
    let bi = -1, bd = Infinity;
    for (let i = 0; i < n; i++) if (!used[i]) { const d = D(a, list[i]); if (d < bd) { bd = d; bi = i; } }
    used[bi] = 1; tour.push(bi);
  }
  // 2-opt (open path, the start fixed)
  for (let pass = 0, improved = true; improved && pass < 12; pass++) {
    improved = false;
    for (let i = 1; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const A = list[tour[i - 1]], B = list[tour[i]], C = list[tour[k]], E = k + 1 < n ? list[tour[k + 1]] : null;
      const before = D(A, B) + (E ? D(C, E) : 0), after = D(A, C) + (E ? D(B, E) : 0);
      if (after < before - 1e-9) { for (let x = i, y = k; x < y; x++, y--) { const t = tour[x]; tour[x] = tour[y]; tour[y] = t; } improved = true; }
    }
  }
  tour.forEach((si, r) => { list[si].rank = r; });
}

/** Corner-cutting smoothing of an open flat polyline. */
function chaikinFlat(p, iterations) {
  let q = p;
  for (let k = 0; k < iterations; k++) {
    const out = [q[0], q[1]];
    for (let i = 0; i + 3 < q.length; i += 2) {
      out.push(q[i] * 0.75 + q[i + 2] * 0.25, q[i + 1] * 0.75 + q[i + 3] * 0.25,
               q[i] * 0.25 + q[i + 2] * 0.75, q[i + 1] * 0.25 + q[i + 3] * 0.75);
    }
    out.push(q[q.length - 2], q[q.length - 1]);
    q = out;
  }
  return q;
}

/** A hand never draws a square corner by accident. Corners whose arms are both straight for 2 mm
 *  and turn 55-125 degrees (a jog where two lines were joined, a bridge's square drop) become a
 *  fillet; two opposite corners close together (a Z jog, like a step on the nose bridge) become
 *  one smooth diagonal. Feature corners (eyes, mouth, ears) and hatching stay as they are.
 *  Works in place on the route (same point count, so every per-point attribute still holds). */
function roundCorners(route, order, mmPerCU) {
  const x = route.x, y = route.y, n = x.length;
  if (n < 8) return 0;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) * mmPerCU;
  const ARM = 1.1, WIN = 2, kindAt = i => { const k = route.stroke[i]; return k >= 0 && order[k] ? order[k].kind : null; };
  const cand = [];
  let a = 0, b = 0;
  for (let i = 1; i < n - 1; i++) {
    while (a + 1 < i && s[i] - s[a + 1] >= ARM) a++;
    if (b < i) b = i;
    while (b < n - 1 && s[b] - s[i] < ARM) b++;
    if (s[i] - s[a] < ARM || s[b] - s[i] < ARM) continue;
    const ux = x[i] - x[a], uy = y[i] - y[a], vx = x[b] - x[i], vy = y[b] - y[i];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu * mmPerCU < 0.94 * (s[i] - s[a]) || lv * mmPerCU < 0.94 * (s[b] - s[i])) continue;
    const c = (ux * vx + uy * vy) / (lu * lv);
    if (c > 0.57 || c < -0.57) continue;                      // 55..125 degrees
    cand.push({ i, a, b, ang: Math.acos(c), sign: ux * vy - uy * vx > 0 ? 1 : -1 });
  }
  // one corner per run: the sharpest point
  const corners = [];
  for (const c of cand) {
    const last = corners[corners.length - 1];
    if (last && c.i - last.i <= 2 && c.sign === last.sign) { if (c.ang > last.ang) corners[corners.length - 1] = c; continue; }
    corners.push(c);
  }
  let done = 0, lastEnd = -1;
  for (let k = 0; k < corners.length; k++) {
    const c = corners[k];
    const kd = kindAt(c.i);
    if (kd && KEEP_CORNERS.has(kd)) continue;
    if (route.seg[c.i] === SEG_HATCH) continue;
    // the fillet spans about WIN mm each side (detected on shorter arms, rounded wider)
    const back = i => { let q = i; while (q > 0 && s[i] - s[q] < WIN) q--; return q; };
    const fwd = i => { let q = i; while (q < n - 1 && s[q] - s[i] < WIN) q++; return q; };
    let wa = back(c.i), wb = fwd(c.i), m = 1.0, e = c.i;
    const nx2 = corners[k + 1];
    // a Z: the next corner turns back the other way within 6 mm
    if (nx2 && nx2.sign !== c.sign && s[nx2.i] - s[c.i] < 6 && !(kindAt(nx2.i) && KEEP_CORNERS.has(kindAt(nx2.i)))) { wb = fwd(nx2.i); m = 0.8; e = nx2.i; k++; }
    if (wa <= lastEnd || wb - wa < 3) continue;
    const t0x = x[c.i] - x[wa], t0y = y[c.i] - y[wa], l0 = Math.hypot(t0x, t0y) || 1;
    const t1x = x[wb] - x[e], t1y = y[wb] - y[e], l1 = Math.hypot(t1x, t1y) || 1;
    const ax = x[wa], ay = y[wa], bx = x[wb], by = y[wb], D = Math.hypot(bx - ax, by - ay) * m;
    const span = s[wb] - s[wa] || 1;
    for (let q = wa + 1; q < wb; q++) {
      const t = (s[q] - s[wa]) / span, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      x[q] = h00 * ax + h10 * D * t0x / l0 + h01 * bx + h11 * D * t1x / l1;
      y[q] = h00 * ay + h10 * D * t0y / l0 + h01 * by + h11 * D * t1y / l1;
    }
    lastEnd = wb; done++;
  }
  return done;
}

/** The drawing of a photo with no contours: two coincident, invisible points and a flag, so the
 *  app can say 'No clear contours in this photo' instead of showing a made-up shape. */
export const EMPTY_NOTE = 'No clear contours in this photo: try one with a clear subject, like a face, an animal or an object.';
function emptyGeometry(o, toolCU, pressure, t0) {
  const n = 2, data = new Float32Array(n * STRIDE);
  for (let i = 0; i < n; i++) {
    const q = i * STRIDE;
    data[q] = i * 1e-4; data[q + 1] = 0; data[q + 2] = toolCU * 1e-3; data[q + 3] = i * 1e-4;
    data[q + 4] = 0; data[q + 5] = 0; data[q + 6] = 1;
  }
  const geom = finishGeometry({
    n, data, colors: null, rings: 0, spacing: toolCU * 4, technique: 'thickness',
    maxWidth: toolCU * 1e-3, minWidth: toolCU * 1e-3, penWidth: pressure ? null : toolCU,
    start: 'point', shape: 'square', startPoint: { x: 0, y: 0 },
    layout: { cx: 0.5, cy: 0.5, r: LAYOUT_R },
  });
  const handT = Float32Array.from([0, 0.001]);
  geom.path = 'lineart';
  geom.handT = handT;
  if (!(geom._pace instanceof Map)) geom._pace = new Map();
  for (const k of ['natural', 'steady', 'rings']) geom._pace.set(k, handT);
  geom.lineart = {
    empty: true, note: EMPTY_NOTE,
    strokes: 0, dropped: 0, order: [], seg: new Uint8Array(n), stroke: new Int16Array(n).fill(-1),
    lengthM: 0, drawnM: 0, retracedM: 0, bridgesM: 0, hatchM: 0, handSeconds: 0,
    tool: o.tool, toolMm: o.toolMm, sheetMm: o.sheetMm, pressure,
    style: o.style === 'rich' ? 'rich' : 'sparse', points: n, buildMs: Math.round(performance.now() - t0),
    ms: { select: 0, order: 0, hand: 0 },
  };
  return geom;
}

// ------------------------------------------------------------------ build
/**
 * @param strokes   LA-lines strokes (see the header)
 * @param features  { face: { box, landmarks } | null, dark: { w, h, data } | null }
 * @param opts      LINEART_DEFAULTS-shaped
 */
export function buildLineArt(strokes, features = {}, opts = {}) {
  const t0 = performance.now();
  const o = { ...LINEART_DEFAULTS, ...opts };
  const rand = mulberry32((o.seed | 0) * 7919 + 13);
  const seed = o.seed | 0 || 1;
  const mmPerCU = LAYOUT_R * o.sheetMm;
  const mm = v => v / mmPerCU;                       // millimetres -> circle units
  const toolCU = mm(o.toolMm);
  const pressure = o.pressure ?? PRESSURE_TOOLS.has(o.tool);
  const rich = o.style === 'rich';
  const wobble = clamp01(o.wobble), overshoot = clamp01(o.overshoot);
  const face = features && features.face;

  // frame size of the subject: the face box when there is one, else the whole frame
  let unit = 1;   // ~ face half-height in CU
  let faceC = [0, 0];
  if (face && face.box) {
    const b = face.box;
    const bw = (b.w ?? (b[2] - b[0])) * 2, bh = (b.h ?? (b[3] - b[1])) * 2;
    const bx = (b.x ?? b[0]) * 2 - 1, by = (b.y ?? b[1]) * 2 - 1;
    if (bw > 0 && bh > 0) { unit = Math.max(0.2, Math.min(1.2, 0.5 * Math.max(bw, bh))); faceC = [bx + bw / 2, by + bh / 2]; }
  }
  const step = Math.max(mm(0.35), 0.004);           // planning resolution
  const tolJ = Math.max(mm(1.2), 0.011);            // touching lines join the network
  const U = 0.1 * unit;                             // cost unit for order penalties

  // ---- 1. strokes in circle units, evenly resampled
  let list = [];
  // the photo's border is not a line in the subject: a stroke is cut where it runs along the
  // frame edge (the model and the vectoriser trace ridges and mist bands out to the edge and
  // then along it, which reads as an edge filter, never as an artist's line)
  const EDGE = 0.03;
  const offEdge = (x, y) => x > EDGE && x < 1 - EDGE && y > EDGE && y < 1 - EDGE;
  const pieces = [];
  (strokes || []).forEach((s, i) => {
    const p = s && s.points;
    if (!p || p.length < 4) return;
    const m = p.length / 2, ok = new Uint8Array(m);
    let all = true;
    for (let k = 0; k < m; k++) { ok[k] = offEdge(p[2 * k], p[2 * k + 1]) ? 1 : 0; if (!ok[k]) all = false; }
    if (all) { pieces.push([s, i, p, !!s.closed]); return; }
    // only a run ALONG the border goes: a line that just touches it (the top of a head in a
    // close crop) keeps its curve, or two sides left behind would meet in a point like a mitre
    for (let k = 0; k < m;) {
      if (ok[k]) { k++; continue; }
      let e = k, L = 0;
      while (e + 1 < m && !ok[e + 1]) { L += Math.hypot(p[2 * e + 2] - p[2 * e], p[2 * e + 3] - p[2 * e + 1]); e++; }
      if (L < 0.06 && k > 0 && e < m - 1) for (let q = k; q <= e; q++) ok[q] = 1;
      k = e + 1;
    }
    let run = [];
    const flush = () => { if (run.length >= 8) pieces.push([s, i, run, false]); run = []; };
    for (let k = 0; k < m; k++) {
      if (ok[k]) run.push(p[2 * k], p[2 * k + 1]); else flush();
    }
    flush();
  });
  pieces.forEach(([s, i, p, isClosed]) => {
    const raw = new Array(p.length);
    for (let k = 0; k < p.length; k++) raw[k] = p[k] * 2 - 1;
    const closed = isClosed && p.length >= 8;
    let pts = resample(raw, closed, step);
    if (pts.length < 4) return;
    if (!closed) pts = trimHooks(pts, mm(2.5), mm(3));
    const len = polyLen(pts, closed);
    let cx = 0, cy = 0;
    for (let k = 0; k < pts.length; k += 2) { cx += pts[k]; cy += pts[k + 1]; }
    const kind = KINDS[s.kind] ? s.kind : 'other';
    list.push({ src: i, kind, closed, sal: clamp01(s.saliency ?? 0.5), dark: clamp01(s.dark ?? 0.5), pts, len, sil: !!s.silhouette,
      cx: cx / (pts.length / 2), cy: cy / (pts.length / 2) });
  });

  // ---- 2. keep the telling lines within a length budget (a few times the face outline)
  // (the extractor already chose; this only trims an over-full set)
  const budget = (rich ? 46 : 26) * unit;
  const minLen = 0.018 * unit;
  list = list.filter(s => s.len >= minLen || s.kind === 'iris' || s.kind === 'eye' || s.kind === 'nose');
  const score = s => s.sal * KINDS[s.kind][1] * (0.55 + 0.45 * Math.min(1, s.len / (0.25 * unit)));
  list.sort((a, b) => score(b) - score(a));
  let chosen = [];
  let acc = 0;
  for (const s of list) {
    // (the silhouette's contour always stays: it is what the drawing is read by)
    if (!s.sil && acc + s.len > budget && !(s.sal >= 0.9 && acc + s.len < budget * 1.3)) continue;
    chosen.push(s); acc += s.len;
  }
  // an open line that another line runs into is split there, so the pen can join it at the
  // junction and draw either way (the jaw meets the outline: go on up the outline from there)
  {
    const reach = 2.5 * tolJ, margin = 0.05 * unit;
    const cuts = chosen.map(() => []);
    chosen.forEach((a, ai) => {
      const ends = a.closed ? [] : [[a.pts[0], a.pts[1]], [a.pts[a.pts.length - 2], a.pts[a.pts.length - 1]]];
      for (const [ex, ey] of ends) chosen.forEach((b, bi) => {
        if (bi === ai || b.closed || b.len < 4 * margin) return;
        const n = b.pts.length / 2, m = Math.ceil(margin / step);
        let bk = -1, bd = reach;
        for (let k = m; k < n - m; k++) {
          const d = Math.hypot(b.pts[2 * k] - ex, b.pts[2 * k + 1] - ey);
          if (d < bd) { bd = d; bk = k; }
        }
        if (bk >= 0) cuts[bi].push(bk);
      });
    });
    const out = [];
    chosen.forEach((s, i) => {
      const gap = Math.ceil(margin / step);
      const ks = [...new Set(cuts[i])].sort((a, b) => a - b).filter((k, j, arr) => !j || k - arr[j - 1] > gap);
      if (!ks.length) { out.push(s); return; }
      let from = 0;
      for (const k of [...ks, s.pts.length / 2 - 1]) {
        const pts = s.pts.slice(2 * from, 2 * k + 2);
        if (pts.length >= 4) {
          let cx = 0, cy = 0;
          for (let q = 0; q < pts.length; q += 2) { cx += pts[q]; cy += pts[q + 1]; }
          out.push({ ...s, pts, len: polyLen(pts, false), cx: cx / (pts.length / 2), cy: cy / (pts.length / 2) });
        }
        from = k;
      }
    });
    chosen = out;
  }
  // hatching patches ride along as low-priority strokes in the dark spots
  // with a face, shade only the head and neck (the backdrop behind a pale bust is darker than it)
  const rims = face && face.box ? [] : chosen.filter(s => s.closed && s.len > 1.2);
  const inPoly = (p, x, y) => {
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // never hatch the hair (strands say it) or an eye (a bar through it reads as a 'no' sign)
  const lmk = face && face.landmarks && face.landmarks.length >= 956 ? face.landmarks : null;
  const L2 = i => [lmk[2 * i] * 2 - 1, lmk[2 * i + 1] * 2 - 1];
  // (nor the mouth: a zig-zag between the lips reads as teeth)
  const eyeBoxes = lmk ? [[33, 133, 159, 145, 1.4], [263, 362, 386, 374, 1.4], [61, 291, 2, 17, 0.65]].map(([a, b, c, d, ky]) => {
    const p = [a, b, c, d].map(L2), xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const rx = (Math.max(...xs) - Math.min(...xs)) * 0.75 + 0.01, ry = Math.max(0.03, (Math.max(...ys) - Math.min(...ys)) * ky);
    return [cx, cy, rx, ry];
  }) : [];
  const browY = lmk ? Math.min(L2(105)[1], L2(334)[1]) : -Infinity;
  // the face oval (MediaPipe's silhouette ring): above the mouth, shade only inside it (the hair
  // beside the cheeks is hair, not shadow)
  const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const ovalPoly = lmk ? OVAL.flatMap(i => L2(i)) : null, mouthY = lmk ? L2(13)[1] : 0;
  // (an animal's eyes, nose and mouth, and any small closed shape: its size, not its length,
  // decides; a round eye's outline is longer than it is wide)
  const loopBoxes = (face ? [] : chosen.filter(s => s.kind === 'eye' || s.kind === 'iris' || s.kind === 'lips' || s.kind === 'nose' || s.closed)).map(s => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < s.pts.length; k += 2) { x0 = Math.min(x0, s.pts[k]); x1 = Math.max(x1, s.pts[k]); y0 = Math.min(y0, s.pts[k + 1]); y1 = Math.max(y1, s.pts[k + 1]); }
    const sz = Math.max(x1 - x0, y1 - y0);
    if (sz > 0.45 * unit) return null;
    const m = 0.05 + 0.25 * sz;
    return [x0 - m, x1 + m, y0 - m, y1 + m];
  }).filter(Boolean);
  const noHatch = (x, y) => (lmk && (y < browY || (y < mouthY && !inPoly(ovalPoly, x, y))))
    || eyeBoxes.some(([cx, cy, rx, ry]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1)
    || loopBoxes.some(([x0, x1, y0, y1]) => x > x0 && x < x1 && y > y0 && y < y1);
  // with a silhouette, shade only inside the subject's own shape
  const silM = features && features.silhouette && features.silhouette.mask && features.silhouette.mask.data && !features.silhouette.standin
    ? maskTools(features.silhouette.mask) : null;
  const inSubject0 = silM ? (x, y) => silM.inside((x + 1) / 2, (y + 1) / 2) && silM.depth((x + 1) / 2, (y + 1) / 2) > 0.01 : face && face.box ? (x, y) => {
    const u = (x - faceC[0]) / (unit * 1.25), v = (y - faceC[1]) / (unit * (y < faceC[1] ? 1.5 : 1.9));
    return u * u + v * v < 1;
  } : rims.length ? (x, y) => rims.some(s => inPoly(s.pts, x, y)) : () => true;
  const inSubject = (x, y) => inSubject0(x, y) && !noHatch(x, y);
  const nearDrawing = (x, y) => inSubject(x, y) && chosen.some(s => {
    for (let k = 0; k < s.pts.length; k += 8) if (Math.hypot(s.pts[k] - x, s.pts[k + 1] - y) < 0.12 * unit) return true;
    return false;
  });
  const hatch = hatchStrokes(features && features.dark, clamp01(o.hatch), Math.max(mm(1.7), toolCU * 3), rand, nearDrawing);
  for (const h of hatch) {
    const pts = resample(h.pts, false, step);
    chosen.push({ ...h, pts, len: polyLen(pts, false), cx: pts[0], cy: pts[1], src: -1 });
  }
  // nothing to draw (a flat or blank photo): say so, never invent a shape
  if (!chosen.length) return emptyGeometry(o, toolCU, pressure, t0);

  const tSelect = performance.now();
  // light side: the half of the subject whose lines sit in lighter photo (artists start there)
  let lightSign = -1;
  {
    let l = 0, r = 0, nl = 0, nr = 0;
    for (const s of chosen) if (s.cx < faceC[0]) { l += s.dark; nl++; } else { r += s.dark; nr++; }
    if (nl && nr && r / nr < l / nl) lightSign = 1;
  }

  // ---- 3. order: start, then greedy sweep with travel on the drawn network
  const route = { x: [], y: [], seg: [], dark: [], stroke: [], entry: [], tlen: [] };
  const pushPt = (x, y, seg, dark, si, entry = 0, tlen = 0) => {
    route.x.push(Math.max(-0.995, Math.min(0.995, x))); route.y.push(Math.max(-0.995, Math.min(0.995, y)));
    route.seg.push(seg); route.dark.push(dark); route.stroke.push(si); route.entry.push(entry); route.tlen.push(tlen);
  };
  const net = new Net(Math.max(tolJ, 0.03));
  const order = [];
  let cur = -1, hx = 1, hy = 0;                     // current node and heading
  const heading = () => {
    const n = route.x.length;
    for (let k = n - 2; k >= Math.max(0, n - 6); k--) {
      const dx = route.x[n - 1] - route.x[k], dy = route.y[n - 1] - route.y[k], d = Math.hypot(dx, dy);
      if (d > step * 1.5) { hx = dx / d; hy = dy / d; return; }
    }
  };

  // the stroke as drawn from entry index j in direction dir (closed loops go all the way round
  // and overlap their start a little; sharp corners overshoot and come back)
  const traverse = (s, j, dir) => {
    const n = s.pts.length / 2, out = [];
    // (an eye or a mouth closes exactly: running on past the start at its corner left a tail)
    const count = s.closed ? n + (NO_FLOURISH.has(s.kind) ? 1 : Math.max(2, Math.round(mm(1.5 + 2.5 * overshoot) / step))) : n;
    for (let k = 0; k < count; k++) {
      const i = s.closed ? ((j + dir * k) % n + n) % n : j + dir * k;
      out.push(s.pts[2 * i], s.pts[2 * i + 1]);
    }
    // (no flourish on the small features: an overshoot at a mouth corner reads as a fang)
    if (overshoot <= 0 || s.hatch || NO_FLOURISH.has(s.kind)) return out;
    const W = 3, res = [];
    const m = out.length / 2;
    let lastCorner = -99;
    for (let k = 0; k < m; k++) {
      res.push(out[2 * k], out[2 * k + 1]);
      if (k < W || k >= m - W || k - lastCorner < 2 * W) continue;
      const ax = out[2 * k] - out[2 * (k - W)], ay = out[2 * k + 1] - out[2 * (k - W) + 1];
      const bx = out[2 * (k + W)] - out[2 * k], by = out[2 * (k + W) + 1] - out[2 * k + 1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) continue;
      const cos = (ax * bx + ay * by) / (la * lb);
      if (cos > 0.2) continue;                                        // > ~78 degrees
      // local maximum of the turn only
      const a2x = out[2 * (k + 1)] - out[2 * (k + 1 - W)], a2y = out[2 * (k + 1) + 1] - out[2 * (k + 1 - W) + 1];
      const b2x = out[2 * Math.min(m - 1, k + 1 + W)] - out[2 * (k + 1)], b2y = out[2 * Math.min(m - 1, k + 1 + W) + 1] - out[2 * (k + 1) + 1];
      const cos2 = (a2x * b2x + a2y * b2y) / (Math.hypot(a2x, a2y) * Math.hypot(b2x, b2y) || 1);
      if (cos2 < cos) continue;
      lastCorner = k;
      const ov = mm(0.5 + 1.1 * overshoot) * (0.7 + 0.6 * rand()) * (1 - cos) / 2;
      const tx = ax / la, ty = ay / la, ux = bx / lb, uy = by / lb;
      const cx = out[2 * k], cy = out[2 * k + 1];
      res.push(cx + tx * ov, cy + ty * ov);
      res.push(cx + tx * ov * 0.45 + ux * ov * 0.4, cy + ty * ov * 0.45 + uy * ov * 0.4);
    }
    return res;
  };

  const drawStroke = (s, j, dir, travel = Infinity) => {
    const si = order.length;
    order.push({ kind: s.kind, sal: +s.sal.toFixed(2), lenMm: +(s.len * mmPerCU).toFixed(1), closed: s.closed, src: s.src });
    const pts = traverse(s, j, dir);
    const seg = s.hatch ? SEG_HATCH : SEG_DRAW;
    // (a line that simply carries on from the last one gets no fresh start: no pause, no slowing)
    for (let k = 0; k < pts.length; k += 2) pushPt(pts[k], pts[k + 1], seg, s.dark, si, k === 0 && travel > tolJ ? 1 + KINDS[s.kind][0] : 0, k === 0 ? travel : 0);
    // the network holds the stroke as drawn; everything drawn is one connected line, so any
    // earlier point can be reached by going back over it
    const n = s.pts.length / 2, ordered = [];
    for (let k = 0; k < n; k++) {
      const i = s.closed ? ((j + dir * k) % n + n) % n : j + dir * k;
      ordered.push(s.pts[2 * i], s.pts[2 * i + 1]);
    }
    const ids = net.addStroke(ordered, s.closed, tolJ);
    cur = s.closed ? ids[0] : ids[ids.length - 1];
    // the pen really ends past the loop's start (the overlap): travel starts from the node there
    if (s.closed) {
      const lx = route.x[route.x.length - 1], ly = route.y[route.y.length - 1];
      let bd = Infinity;
      for (const id of ids) { const d = Math.hypot(net.x[id] - lx, net.y[id] - ly); if (d < bd) { bd = d; cur = id; } }
    }
    heading();
  };

  /** Route points from index k0 on (a bridge just drawn) join the network. */
  const netTail = k0 => {
    const pts = [];
    for (let k = Math.max(0, k0 - 1); k < route.x.length; k++) pts.push(route.x[k], route.y[k]);
    if (pts.length >= 4) net.addStroke(pts, false, tolJ);
  };

  // a little loop where the line turns back on itself (the pen swings round instead of stopping)
  const turnLoop = (tx, ty) => {
    // at most about one reversal in five, and never out of an eye, iris or mouth
    if (order.length && NO_FLOURISH.has(order[order.length - 1].kind)) return;
    if (rand() > 0.04 + 0.16 * overshoot) return;
    // varied: a narrow teardrop, a tight hairpin, or (a third of the time) just stop and go back
    const form = rand();
    if (form < 0.3) return;
    const hair = form < 0.6;
    const r = mm(0.35 + 0.45 * overshoot) * (0.6 + 0.8 * rand()) * (hair ? 0.6 : 1);
    const n = route.x.length, px = route.x[n - 1], py = route.y[n - 1];
    const side = (hx * ty - hy * tx) >= 0 ? 1 : -1;
    const nx = -hy * side, ny = hx * side;              // swing toward the side the new path lies
    const steps = Math.max(8, Math.ceil(5 * r / step));
    const run = hair ? 1.6 + 1.2 * rand() : 2.4, wide = hair ? 0.45 : 1;
    for (let k = 1; k <= steps; k++) {
      const th = (k / steps) * Math.PI * 1.15;
      const along = run * r * Math.sin(th) * (1 - 0.25 * k / steps), across = wide * r * (1 - Math.cos(th));
      pushPt(px + hx * along + nx * across, py + hy * along + ny * across, SEG_BRIDGE, 0.3, -1);
    }
    heading();
  };

  const bridge = (ax, ay, ex, ey, t1x, t1y) => {
    const dx = ex - ax, dy = ey - ay, d = Math.hypot(dx, dy);
    if (d < step * 0.6) return;
    const back = (hx * dx + hy * dy) / d < -0.2;
    // a sideways hop (the offset across both headings) with full tangents draws a flat S that
    // reads as a stair step; a hand cuts it as a short diagonal, so the tangents shrink with it
    // a long bridge is a hand's sweep: it leaves along the pen's heading and bows, never a ruled chord
    const perp0 = Math.abs(hx * dy - hy * dx) / d, perp1 = Math.abs(t1x * dy - t1y * dx) / d;
    const long = Math.min(1, Math.max(0, (d - mm(5)) / mm(10)));
    const m0 = d * (back ? 0.3 : (0.8 - 0.5 * perp0) * (1 - long) + 1.0 * long), m1 = d * ((0.8 - 0.5 * perp1) * (1 - long) + 1.0 * long);
    const side = (hx * dy - hy * dx) >= 0 ? 1 : -1, nx = -dy / d * side, ny = dx / d * side;
    const bow = d * 0.12 * long * (1 - 0.6 * Math.max(perp0, perp1));
    const n = Math.max(2, Math.ceil(d * 1.3 / step));
    for (let k = 1; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      const b = bow * Math.sin(Math.PI * t);
      pushPt(h00 * ax + h10 * m0 * hx + h01 * ex + h11 * m1 * t1x - nx * b,
             h00 * ay + h10 * m0 * hy + h01 * ey + h11 * m1 * t1y - ny * b, SEG_BRIDGE, 0.2, -1);
    }
  };

  const entryTangent = (s, j, dir) => {
    const n = s.pts.length / 2;
    const k = s.closed ? ((j + dir * 2) % n + n) % n : Math.max(0, Math.min(n - 1, j + dir * 2));
    const dx = s.pts[2 * k] - s.pts[2 * j], dy = s.pts[2 * k + 1] - s.pts[2 * j + 1], d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  };

  // start where an artist would: the brow (else an eye, else the hairline) on the light side,
  // near the top; without kinds, the most telling line high up on the light side
  const startBonus = { brow: 1, eye: 0.6, hair: 0.35, outline: 0.2 };
  // a portrait always starts at the brow or an eye (never the hair: the face comes first)
  const faceStart = face && chosen.some(s => s.kind === 'brow' || s.kind === 'eye');
  let first = 0, fb = -Infinity;
  chosen.forEach((s, i) => {
    if (s.hatch) return;
    if (faceStart && s.kind !== 'brow' && s.kind !== 'eye') return;
    const v = score(s) + (startBonus[s.kind] || 0) + 0.6 * Math.sign(s.cx - faceC[0]) * lightSign * Math.min(1, Math.abs(s.cx - faceC[0]) / (0.3 * unit))
      - 0.35 * (s.cy - faceC[1]) / unit;
    if (v > fb) { fb = v; first = i; }
  });
  // silhouette first: without a face, the line starts on the subject's outer shape (the longest
  // piece of it), at its top, the way a one-line artist opens with the whole form
  if (!faceStart) {
    let top = Infinity;
    chosen.forEach((s, i) => { if (s.sil) for (let k = 1; k < s.pts.length; k += 2) if (s.pts[k] < top) { top = s.pts[k]; first = i; } });
  }
  planTour(chosen, first, face ? KINDS : null);
  {
    const s = chosen.splice(first, 1)[0];
    const n = s.pts.length / 2;
    let j = 0, dir = 1;
    if (!s.closed) {
      // draw outward from the middle of the face (brow from the nose side, strands from the root)
      const d0 = Math.hypot(s.pts[0] - faceC[0], s.pts[1] - faceC[1]);
      const d1 = Math.hypot(s.pts[2 * n - 2] - faceC[0], s.pts[2 * n - 1] - faceC[1]);
      if (d1 < d0) { j = n - 1; dir = -1; }
    } else {
      let top = Infinity;
      for (let k = 0; k < n; k++) if (s.pts[2 * k + 1] < top) { top = s.pts[2 * k + 1]; j = k; }
    }
    drawStroke(s, j, dir);
  }

  const Rb = 0.35 * unit + mm(3);                   // how far a new bridge may reach from the network
  // (riding a silhouette the contour is already in pieces between the dips, so going back over
  // lines costs more: a short new dip reads better than a long doubled line)
  const silMode = chosen.some(s => s.sil);
  const cR = silMode ? 0.75 : 0.4, cB = 3.2, pB = 0.025 * unit;      // retrace is cheap (it hides), new line is dear
  const bLong = 0.06 * unit;                        // bridges past this grow dear fast (no long connectors)
  const bridgeCost = b => b * cB + (b > tolJ ? pB : 0) + (b > bLong ? 40 * (b - bLong) * (b - bLong) / unit : 0);
  // going back over a long way (a whole horizon band) doubles it into a pill: past 45 mm a short
  // new turn to the next line is the better move
  const rLong = mm(45);
  let dropped = 0;
  // the greedy cost follows the tour: jumping far ahead of the earliest stroke still waiting
  // means coming back a long way over the drawing later
  const wTour = U * (face ? 0.12 : 0.25);
  while (chosen.length) {
    const { dist, prev } = net.dijkstra(cur);
    const g0 = order.length ? KINDS[order[order.length - 1].kind][0] : 0;
    let minRank = Infinity, faceLeft = 0;
    for (const c of chosen) { if (c.rank < minRank) minRank = c.rank; if (face && !c.hatch && KINDS[c.kind][0] <= 3) faceLeft++; }
    const cx0 = net.x[cur], cy0 = net.y[cur];   // (cx0, cy0): where the pen is
    let best = null;
    for (let si = 0; si < chosen.length; si++) {
      const s = chosen[si], n = s.pts.length / 2;
      const g = KINDS[s.kind][0];
      // hair, ears and shading wait until the eyes, nose and mouth are down (portraitists work
      // from the features outward; a face that starts with a crescent of hair reads as nothing)
      const late = (faceLeft && g >= 5 ? 1.5 * unit : 0) + (s.hatch ? 0.5 * unit : 0);
      const orderPen = U * (1.6 * Math.max(0, g0 - g) + 0.5 * Math.max(0, g - g0 - 1)) - U * 0.6 * s.sal
        + wTour * Math.max(0, s.rank - minRank - 1) + late;
      const entries = [];
      if (s.closed) { const k = Math.max(1, Math.floor(n / 20), Math.round(mm(2) / step)); for (let j = 0; j < n; j += k) entries.push([j, 1], [j, -1]); }
      else entries.push([0, 1], [n - 1, -1]);
      for (const [j, dir] of entries) {
        const ex = s.pts[2 * j], ey = s.pts[2 * j + 1];
        let bc = Infinity, bv = -1, bb = 0;
        const consider = (v, b) => {
          if (!(dist[v] < Infinity)) return;
          const c = dist[v] * cR + (dist[v] > rLong ? 1.2 * (dist[v] - rLong) : 0) + bridgeCost(b);
          if (c < bc) { bc = c; bv = v; bb = b; }
        };
        // search outward: a node farther than (best cost / cB) can no longer win
        for (let r = 2 * tolJ; ; r = Math.min(Rb, r * 2.5)) {
          net.near(ex, ey, r, consider);
          if (r >= Rb || bc / cB <= r) break;
        }
        // nothing drawn near it yet: the nearest drawn point, however far
        if (bv < 0) for (let v = 0; v < net.x.length; v++) consider(v, Math.hypot(net.x[v] - ex, net.y[v] - ey));
        // arriving against the stroke's direction costs a turn
        const [tx, ty] = entryTangent(s, j, dir);
        const ax = bb > tolJ ? (ex - net.x[bv]) / bb : hx, ay = bb > tolJ ? (ey - net.y[bv]) / bb : hy;
        const turn = U * 0.25 * (1 - (ax * tx + ay * ty)) / 2;
        const total = bc + orderPen + turn;
        if (!best || total < best.total) best = { total, si, j, dir, v: bv, b: bb, tx, ty };
      }
    }
    const s = chosen[best.si];
    // a minor line that only a long new bridge could reach is left out, as an artist would
    if (best.b > 0.22 * unit && s.sal < (face ? 0.35 : 0.18) && !s.hatch && chosen.length > 1) { chosen.splice(best.si, 1); dropped++; continue; }
    // a new line across more than 25 mm of open paper reads as a construction line: only the
    // lines the drawing cannot do without are worth it
    // (a scene without a face has no features to fall back on: its inner shapes, a moon's maria,
    // are worth a longer way in)
    const sLo = face ? 0.5 : 0.2, sHi = face ? 0.8 : 0.6, bHi = face ? mm(40) : mm(60);
    if (KINDS[s.kind][0] > 3 && !s.hatch && ((best.b > mm(25) && s.sal < sLo) || (best.b > bHi && s.sal < sHi) || (best.b > mm(70) && s.sal < 0.95))) { chosen.splice(best.si, 1); dropped++; continue; }
    // shading is laid in beside lines already drawn, never at the end of a long new connector
    if (s.hatch && best.b > mm(18)) { chosen.splice(best.si, 1); dropped++; continue; }
    chosen.splice(best.si, 1);
    // travel: back along drawn lines to the anchor, then (if needed) a bridge into the stroke
    const path = [];
    for (let v = best.v; v >= 0 && v !== cur; v = prev[v]) path.push(v);
    path.reverse();
    if (path.length) {
      const v1 = path[Math.min(path.length - 1, 3)];
      const tx = net.x[v1] - cx0, ty = net.y[v1] - cy0, tl = Math.hypot(tx, ty) || 1;
      if ((tx * hx + ty * hy) / tl < -0.5) turnLoop(tx / tl, ty / tl);
      for (const v of path) pushPt(net.x[v], net.y[v], SEG_RETRACE, 0.4, -1);
      heading();
    } else if (best.b > step) {
      const tx = s.pts[2 * best.j] - cx0, ty = s.pts[2 * best.j + 1] - cy0, tl = Math.hypot(tx, ty) || 1;
      if ((tx * hx + ty * hy) / tl < -0.6) turnLoop(tx / tl, ty / tl);
    }
    const n = route.x.length;
    const px = route.x[n - 1], py = route.y[n - 1];
    const ex = s.pts[2 * best.j], ey = s.pts[2 * best.j + 1], dj = Math.hypot(ex - px, ey - py);
    // a short hop between lines that run the same way blends into the next line (no stair step)
    const along = hx * best.tx + hy * best.ty;
    // (an eye, a mouth or an ear keeps its own shape: bending its ends toward the next line put a
    // hook on the mouth corner that read as a fang)
    const lastKind = order.length ? order[order.length - 1].kind : null;
    const keepShape = KEEP_CORNERS.has(s.kind) || (lastKind && KEEP_CORNERS.has(lastKind));
    if (!keepShape && !s.closed && !s.hatch && dj > step * 0.6 && dj < mm(12) && along > 0.2 && s.len > 1.6 * dj) {
      drawStroke(blendHead(s, best.j, best.dir, px - ex, py - ey, Math.min(0.8 * s.len, Math.max(mm(4), 3 * dj))), best.j, best.dir, (path.length ? dist[best.v] : 0) + best.b);
      continue;
    }
    // the next line is too short to bend: the end of the line just drawn eases over to it instead
    if (!keepShape && !s.hatch && dj > step * 0.6 && dj < mm(12) && along > 0.2) {
      const L = Math.max(mm(4), 3 * dj);
      let a = 0, k = n - 1;
      while (k > 0 && (route.seg[k] === SEG_DRAW || route.seg[k] === SEG_RETRACE) && a < L) { a += Math.hypot(route.x[k] - route.x[k - 1], route.y[k] - route.y[k - 1]); k--; }
      if (a >= Math.min(L, 2.5 * dj)) {
        // arc lengths first (measured on the line as drawn, before anything moves)
        const acc = new Float64Array(n);
        for (let q = n - 2; q > k; q--) acc[q] = acc[q + 1] + Math.hypot(route.x[q + 1] - route.x[q], route.y[q + 1] - route.y[q]);
        for (let q = n - 1; q > k; q--) {
          const u = Math.min(1, acc[q] / a), w = 1 - u * u * (3 - 2 * u);
          route.x[q] = Math.max(-0.995, Math.min(0.995, route.x[q] + (ex - px) * w));
          route.y[q] = Math.max(-0.995, Math.min(0.995, route.y[q] + (ey - py) * w));
        }
        heading();
        drawStroke(s, best.j, best.dir, (path.length ? dist[best.v] : 0) + best.b);
        continue;
      }
    }
    bridge(px, py, ex, ey, best.tx, best.ty);
    netTail(n);
    drawStroke(s, best.j, best.dir, (path.length ? dist[best.v] : 0) + best.b);
  }

  const rounded = roundCorners(route, order, mmPerCU);
  const tOrder = performance.now();
  // ---- 4. the hand: drift, then even resampling
  let N0 = route.x.length;
  const RX = Float64Array.from(route.x), RY = Float64Array.from(route.y);
  // a slow warp of the whole plane (the arm drifts; doubled lines drift together)
  const warpA = mm(1.6) * wobble, warpK = [2 * Math.PI / mm(70), 2 * Math.PI / mm(38)];
  const ph = [0, 1, 2, 3, 4, 5, 6, 7].map(() => rand() * Math.PI * 2);
  for (let i = 0; i < N0; i++) {
    const x = RX[i], y = RY[i];
    RX[i] = x + warpA * (0.7 * Math.sin(warpK[0] * (0.8 * x + 0.6 * y) + ph[0]) + 0.3 * Math.sin(warpK[1] * (-0.5 * x + 0.87 * y) + ph[1]));
    RY[i] = y + warpA * (0.7 * Math.sin(warpK[0] * (-0.6 * x + 0.8 * y) + ph[2]) + 0.3 * Math.sin(warpK[1] * (0.9 * x + 0.44 * y) + ph[3]));
  }
  // lateral drift along the line: new lines drift a little; going back over a line never lands
  // exactly on it, so doubled passages show as two close strokes
  {
    const ox = new Float64Array(N0), oy = new Float64Array(N0);
    let s = 0, runSide = 1, runStart = 0;
    // a fine pen shows the doubling as two close lines; a brush's second pass mostly merges with the first
    // (never more than half the tool's width for a pressure tool; a brush's second pass lands on
    // the first and only fattens it)
    const tw = o.tool === 'brush' ? toolCU * 0.12 : pressure ? Math.min(toolCU * 0.3 + mm(0.08), toolCU * 0.5) : Math.max(mm(0.25), toolCU * 0.6);
    for (let i = 0; i < N0; i++) {
      if (i) s += Math.hypot(RX[i] - RX[i - 1], RY[i] - RY[i - 1]);
      const a = Math.max(0, i - 1), b = Math.min(N0 - 1, i + 1);
      const tx = RX[b] - RX[a], ty = RY[b] - RY[a], tl = Math.hypot(tx, ty) || 1;
      const nx = -ty / tl, ny = tx / tl;
      const sm = s * mmPerCU;
      let off = mm(0.35) * wobble * (0.7 * noise1(sm / 14, seed + 3) + 0.3 * noise1(sm / 5, seed + 9));
      if (route.seg[i] === SEG_RETRACE) {
        if (!i || route.seg[i - 1] !== SEG_RETRACE) { runSide = rand() < 0.5 ? -1 : 1; runStart = sm; }
        let runEnd = sm;   // ease in and out of the doubled run
        for (let k = i; k < N0 && route.seg[k] === SEG_RETRACE && k < i + 40; k++) runEnd = sm + (k - i) * step * mmPerCU;
        const ease = Math.min(1, (sm - runStart) / 2, (runEnd - sm) / 2 + 0.3);
        off += runSide * tw * (0.8 + 0.4 * noise1(sm / 9, seed + 17)) * Math.max(0, ease);
      }
      ox[i] = nx * off; oy[i] = ny * off;
    }
    for (let i = 0; i < N0; i++) { RX[i] += ox[i]; RY[i] += oy[i]; }
  }
  // even spacing for the renderer; attributes follow the segment start
  const ds = mm(Math.min(0.25, Math.max(0.1, o.toolMm * 0.3)));
  const P = [], A = [];      // P: x, y; A: route index
  P.push(RX[0], RY[0]); A.push(0);
  {
    let need = ds;
    for (let k = 0; k < N0 - 1; k++) {
      const ax = RX[k], ay = RY[k], bx = RX[k + 1], by = RY[k + 1];
      const L = Math.hypot(bx - ax, by - ay);
      let t0 = 0;
      while (L - t0 >= need) {
        t0 += need;
        const t = t0 / L;
        P.push(ax + (bx - ax) * t, ay + (by - ay) * t); A.push(t < 0.5 ? k : k + 1);
        need = ds;
      }
      need -= L - t0;
      if (!(need > 1e-6)) need = 1e-6;          // float dust must not stall the walk
      // keep every feature entry as its own point (the hand's pause lands exactly there)
      if (route.entry[k + 1] && A[A.length - 1] !== k + 1) { P.push(bx, by); A.push(k + 1); need = ds; }
    }
    if (A[A.length - 1] !== N0 - 1) { P.push(RX[N0 - 1], RY[N0 - 1]); A.push(N0 - 1); }
  }
  const n = A.length;

  // ---- 5. kinematics: 2/3 power law speed, limited acceleration, pauses at new features
  const X = new Float64Array(n), Y = new Float64Array(n), S = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = P[2 * i]; Y[i] = P[2 * i + 1]; if (i) S[i] = S[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]) * mmPerCU; }
  const kap = new Float64Array(n);                   // curvature, 1/mm, over ~0.8 mm
  const W = Math.max(1, Math.round(mm(0.8) / ds));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - W), b = Math.min(n - 1, i + W);
    if (b - a < 2) continue;
    const ax = X[i] - X[a], ay = Y[i] - Y[a], bx = X[b] - X[i], by = Y[b] - Y[i];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-12 || lb < 1e-12) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
    kap[i] = ang / Math.max(1e-6, S[b] - S[a]) * 2;
  }
  const vDraw = o.speedMm * (rich ? 1 : 0.9);
  const vmaxOf = seg => (seg === SEG_RETRACE ? 1.05 : seg === SEG_BRIDGE ? 1.3 : seg === SEG_HATCH ? 1.9 : 1) * vDraw;
  const Rs = 22;   // mm: curves wider than this are drawn at full speed
  const v = new Float64Array(n);
  const pause = new Float64Array(n);
  // movements: the hand draws in strokes of the arm, each with its own bell of speed whose peak
  // grows with its length (a long jaw sweep runs several times faster than an eye); a movement
  // ends at a new feature, a change of pen action or a sharp turn
  const rhythm = o.rhythm ?? 1;
  const peakOf = new Float64Array(n), uOf = new Float64Array(n);
  {
    const cut = new Uint8Array(n);
    cut[0] = 1;
    for (let i = 1; i < n; i++) {
      if (route.seg[A[i]] !== route.seg[A[i - 1]] || (route.entry[A[i]] && A[i] !== A[i - 1])) cut[i] = 1;
      else if (kap[i] > 0.45 && kap[i] >= kap[i - 1] && kap[i] >= (kap[i + 1] || 0)) cut[i] = 1;   // radius < ~2 mm
    }
    let a = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && !cut[i]) continue;
      const L = Math.max(1e-6, S[i - 1] - S[a]);
      const g = Math.min(3.2, Math.max(0.55, 0.55 + 0.45 * Math.sqrt(L / 15)));
      const gain = Math.max(0.4, 1 + rhythm * (g - 1));
      for (let k = a; k < i; k++) { peakOf[k] = gain; uOf[k] = (S[k] - S[a]) / L; }
      a = i;
    }
  }
  let lastGroup = -1;
  for (let i = 0; i < n; i++) {
    const seg = route.seg[A[i]];
    const vm = vmaxOf(seg);
    const peak = vm * peakOf[i];
    // the bell of the movement (never quite stopping inside it), under the 2/3 power law
    const bell = 0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, Math.max(0, uOf[i])));
    v[i] = Math.min(peak * bell, peak * Math.min(1, Math.cbrt(1 / Math.max(1e-6, kap[i] * Rs))));
    const e = route.entry[A[i]];
    if (e && (i === 0 || A[i - 1] !== A[i])) {
      const g = e - 1;
      // a look at the model before each new feature, a glance after a long way round, and
      // otherwise just a check of the hand as it turns into the next line
      const far = route.tlen[A[i]] > mm(8);
      pause[i] = (g !== lastGroup ? 0.4 + 0.6 * rand() : far ? 0.08 + 0.17 * rand() : 0) * (seg === SEG_HATCH ? 0.4 : 1);
      const ease = g !== lastGroup ? 0.15 : far ? 0.35 : 0.6;
      lastGroup = g;
      v[i] = Math.min(v[i], vm * ease);
    }
  }
  v[0] = 0; v[n - 1] = 0;
  // mm/s^2: a confident hand (A, B) snaps between movements, a searching one eases
  const accel = o.accel ?? (rich ? 700 : 1500);
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * accel * (S[i] - S[i - 1])));
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * accel * (S[i + 1] - S[i])));
  const handT = new Float32Array(n);
  let T = 0;
  for (let i = 1; i < n; i++) {
    const vm = 0.5 * (v[i] + v[i - 1]);
    T += (S[i] - S[i - 1]) / Math.max(1.5, vm) + pause[i];
    handT[i] = T + 1e-6 * i;
  }

  // pressure: heavier where the hand is slow and where the photo is dark; light on travel
  const press = new Float64Array(n);
  const isBrushTool = o.tool === 'brush' || o.tool === 'watercolour';
  for (let i = 0; i < n; i++) {
    const seg = route.seg[A[i]];
    const slow = 1 - Math.min(1, v[i] / vDraw);
    let p = 0.32 + 0.33 * slow + 0.4 * route.dark[A[i]];
    if (isBrushTool) {
      // a brush held upright presses into the pull toward the body (down and to the left) and
      // lifts on the push away from it
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3), dl = Math.hypot(X[b] - X[a], Y[b] - Y[a]) || 1;
      const pull = ((Y[b] - Y[a]) * 0.8 - (X[b] - X[a]) * 0.6) / dl;
      p += 0.14 * pull;
    }
    if (seg === SEG_RETRACE) p *= 0.85;
    else if (seg === SEG_BRIDGE) p *= 0.8;          // the same pen on the paper, only a little lighter
    else if (seg === SEG_HATCH) p *= 0.6;
    p *= 1 + 0.1 * noise1(S[i] / 30, seed + 21);
    press[i] = clamp01(p);
  }
  // the hand changes pressure smoothly (~2 mm), both directions
  {
    const k = Math.min(1, ds * mmPerCU / 2);
    for (let i = 1; i < n; i++) press[i] += (press[i - 1] - press[i]) * (1 - k);
    for (let i = n - 2; i >= 0; i--) press[i] += (press[i + 1] - press[i]) * (1 - k) * 0.5;
  }

  const data = new Float32Array(n * STRIDE);
  const seg = new Uint8Array(n), strokeOf = new Int16Array(n);
  let wMax = 0, wMin = Infinity;
  const taper = mm(2.5);
  const Stot = S[n - 1];
  // where a pause pools ink: a brush blots only on a real look (> 0.8 s), three times at most; a
  // nib or pencil barely darkens; other pens leave a small dot
  const blot = new Float64Array(n);
  {
    const isBrush = o.tool === 'brush' || o.tool === 'watercolour';
    if (isBrush) {
      const idx = [];
      for (let i = 0; i < n; i++) if (pause[i] > 0.8) idx.push(i);
      idx.sort((p, q) => pause[q] - pause[p]);
      for (const i of idx.slice(0, 3)) blot[i] = Math.min(0.6, (pause[i] - 0.5) * 0.8);
    } else {
      const cap = pressure ? 0.2 : 0.35;
      for (let i = 0; i < n; i++) if (pause[i] > 0) blot[i] = Math.min(cap, pause[i] * 0.5);
    }
  }
  let drawnMm = 0, retraceMm = 0, bridgeMm = 0, hatchMm = 0;
  for (let i = 0; i < n; i++) {
    const r = A[i];
    seg[i] = route.seg[r]; strokeOf[i] = route.stroke[r];
    if (i) {
      const d = S[i] - S[i - 1];
      if (seg[i] === SEG_DRAW) drawnMm += d; else if (seg[i] === SEG_RETRACE) retraceMm += d;
      else if (seg[i] === SEG_BRIDGE) bridgeMm += d; else hatchMm += d;
    }
    let w = toolCU, tone = 0.82;
    if (pressure) {
      const ends = Math.min(1, Math.min(S[i], Stot - S[i]) / (taper * mmPerCU) + 0.25);
      // a brush swells and thins far more than a nib (its hairs spread under pressure)
      w = isBrushTool ? toolCU * (0.26 + 1.35 * Math.pow(press[i], 1.5)) * ends : toolCU * (0.3 + 1.2 * press[i]) * ends;
      // (a loaded brush stays black when it lifts: a light pass is thin, never a grey ghost)
      tone = isBrushTool ? 0.62 + 0.38 * press[i] : press[i];
    }
    const slow = 1 - Math.min(1, v[i] / vDraw);
    const q = i * STRIDE;
    data[q] = X[i]; data[q + 1] = Y[i]; data[q + 2] = w;
    data[q + 3] = S[i] / mmPerCU;
    data[q + 4] = tone;
    data[q + 5] = Math.max(0, strokeOf[i]);
    data[q + 6] = 1 + 0.6 * slow * slow + blot[i];   // a pause leaves a small dot, not a pool
    if (w > wMax) wMax = w;
    if (w < wMin) wMin = w;
  }
  // the turn channel is the number of strokes drawn so far (monotone)
  for (let i = 1; i < n; i++) if (data[i * STRIDE + 5] < data[(i - 1) * STRIDE + 5]) data[i * STRIDE + 5] = data[(i - 1) * STRIDE + 5];

  const geom = finishGeometry({
    n, data, colors: null, rings: order.length, spacing: toolCU * 4, technique: 'thickness',
    maxWidth: wMax, minWidth: wMin, penWidth: pressure ? null : toolCU,
    start: 'point', shape: 'square', startPoint: { x: X[0], y: Y[0] },
    layout: { cx: 0.5, cy: 0.5, r: LAYOUT_R },
  });
  geom.path = 'lineart';
  geom.handT = handT;
  if (!(geom._pace instanceof Map)) geom._pace = new Map();
  for (const k of ['natural', 'steady', 'rings']) geom._pace.set(k, handT);
  const M = v2 => +(v2 / 1000).toFixed(3);
  geom.lineart = {
    strokes: order.length, dropped, rounded, order, seg, stroke: strokeOf,
    lengthM: M(Stot), drawnM: M(drawnMm), retracedM: M(retraceMm), bridgesM: M(bridgeMm), hatchM: M(hatchMm),
    handSeconds: +handT[n - 1].toFixed(1), tool: o.tool, toolMm: o.toolMm, sheetMm: o.sheetMm, pressure,
    style: rich ? 'rich' : 'sparse', points: n, buildMs: Math.round(performance.now() - t0),
    ms: { select: Math.round(tSelect - t0), order: Math.round(tOrder - tSelect), hand: Math.round(performance.now() - tOrder) },
  };
  return geom;
}

// ------------------------------------------------------------------ silhouette first
// A one-line artist starts from the outer shape, then dips in for a few telling features. The
// silhouette (js/lineart/silhouette.js, features.silhouette: { mask {w,h,data 0/255}, outlines
// [closed Float32Array polylines, frame fractions, largest first], kind, confidence, parts?,
// skyline? }) gives that shape; silhouetteStrokes() turns it into the artist's contour plus the
// model's lines clipped to inside it, and buildLineArt() routes the one line along it.

/** Chamfer distance (cells) from every cell to the nearest cell where seed(k) is true. */
function chamfer(w, h, seed) {
  const INF = 1e9, d = new Float32Array(w * h), R2 = Math.SQRT2;
  for (let k = 0; k < w * h; k++) d[k] = seed(k) ? 0 : INF;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    let v = d[k];
    if (i > 0 && d[k - 1] + 1 < v) v = d[k - 1] + 1;
    if (j > 0) {
      if (d[k - w] + 1 < v) v = d[k - w] + 1;
      if (i > 0 && d[k - w - 1] + R2 < v) v = d[k - w - 1] + R2;
      if (i < w - 1 && d[k - w + 1] + R2 < v) v = d[k - w + 1] + R2;
    }
    d[k] = v;
  }
  for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) {
    const k = j * w + i;
    let v = d[k];
    if (i < w - 1 && d[k + 1] + 1 < v) v = d[k + 1] + 1;
    if (j < h - 1) {
      if (d[k + w] + 1 < v) v = d[k + w] + 1;
      if (i < w - 1 && d[k + w + 1] + R2 < v) v = d[k + w + 1] + R2;
      if (i > 0 && d[k + w - 1] + R2 < v) v = d[k + w - 1] + R2;
    }
    d[k] = v;
  }
  return d;
}

/** Sampling helpers on a 0/255 mask, all in frame fractions. */
export function maskTools(mask) {
  const { w, h, data } = mask;
  const on = k => data[k] > 127;
  const toMask = chamfer(w, h, on), toBg = chamfer(w, h, k => !on(k));
  const cell = (x, y) => {
    const i = Math.max(0, Math.min(w - 1, Math.floor(x * w))), j = Math.max(0, Math.min(h - 1, Math.floor(y * h)));
    return j * w + i;
  };
  return {
    w, h,
    inside: (x, y) => on(cell(x, y)),
    /** 0 inside the mask, else the distance to it */
    out: (x, y) => toMask[cell(x, y)] / w,
    /** distance to the mask's boundary, either side */
    edge: (x, y) => { const k = cell(x, y); return (on(k) ? toBg[k] : toMask[k]) / w; },
    /** how deep inside (0 outside) */
    depth: (x, y) => { const k = cell(x, y); return on(k) ? toBg[k] / w : 0; },
  };
}

/** Outer boundaries of a 0/255 mask as closed polylines (pixel corners, frame fractions), by
 *  following the cracks between on and off cells; largest area first. */
export function traceMask(mask, minArea = 0.002) {
  const { w, h, data } = mask;
  const on = (i, j) => i >= 0 && j >= 0 && i < w && j < h && data[j * w + i] > 127;
  const W1 = w + 1, next = new Map();
  const add = (x0, y0, x1, y1) => {
    const a = y0 * W1 + x0, b = y1 * W1 + x1;
    const l = next.get(a);
    if (l) l.push(b); else next.set(a, [b]);
  };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!on(i, j)) continue;
    if (!on(i, j - 1)) add(i, j, i + 1, j);
    if (!on(i + 1, j)) add(i + 1, j, i + 1, j + 1);
    if (!on(i, j + 1)) add(i + 1, j + 1, i, j + 1);
    if (!on(i - 1, j)) add(i, j + 1, i, j);
  }
  const loops = [];
  for (const [start] of next) {
    let l = next.get(start);
    while (l && l.length) {
      const pts = [];
      let v = start;
      for (let guard = 0; guard < 4 * w * h; guard++) {
        pts.push((v % W1) / w, Math.floor(v / W1) / h);
        const ls = next.get(v);
        if (!ls || !ls.length) break;
        const nv = ls.pop();
        v = nv;
        if (v === start) break;
      }
      let A = 0;
      for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) A += pts[j] * pts[i + 1] - pts[i] * pts[j + 1];
      A /= 2;
      // outer boundaries run clockwise on screen (positive here); holes the other way
      if (A > minArea && pts.length >= 8) loops.push({ pts: Float32Array.from(pts), area: A });
      l = next.get(start);
    }
  }
  return loops.sort((a, b) => b.area - a.area).map(l => l.pts);
}

/** Even arc spacing of an open or closed polyline (plain arrays). */
function resampleFrac(p, closed, step) { return resample(Array.from(p), closed, step); }

/** Gaussian-ish smoothing (three box passes) of a polyline; open lines keep their ends. */
function smoothPoly(p, closed, r) {
  const n = p.length / 2;
  if (r < 1 || n < 5) return p.slice();
  let a = Float64Array.from(p);
  for (let pass = 0; pass < 3; pass++) {
    const b = new Float64Array(a.length);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        let q = i + k;
        if (closed) q = ((q % n) + n) % n; else q = Math.max(0, Math.min(n - 1, q));
        sx += a[2 * q]; sy += a[2 * q + 1]; c++;
      }
      b[2 * i] = sx / c; b[2 * i + 1] = sy / c;
    }
    if (!closed) { b[0] = a[0]; b[1] = a[1]; b[2 * n - 2] = a[2 * n - 2]; b[2 * n - 1] = a[2 * n - 1]; }
    a = b;
  }
  return Array.from(a);
}

/** Smoothing that keeps the telling corners: the curve is smoothed hard, then pulled back toward a
 *  lightly smoothed copy where that one turns sharply (an ear tip, a chin, a cup handle's corner). */
function contourOf(p, closed, rHard, rSoft, keep) {
  const hard = smoothPoly(p, closed, rHard), soft = smoothPoly(p, closed, rSoft);
  const n = p.length / 2, W = Math.max(2, rSoft * 2), out = hard.slice();
  if (keep <= 0) return out;
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - W + n) % n : Math.max(0, i - W), b = closed ? (i + W) % n : Math.min(n - 1, i + W);
    const ax = soft[2 * i] - soft[2 * a], ay = soft[2 * i + 1] - soft[2 * a + 1], bx = soft[2 * b] - soft[2 * i], by = soft[2 * b + 1] - soft[2 * i + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    turn[i] = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
  }
  // spread the corner weight a little along the line, so the blend has no kink
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = -W; k <= W; k++) {
      const q = closed ? ((i + k) % n + n) % n : Math.max(0, Math.min(n - 1, i + k));
      m = Math.max(m, turn[q] * (1 - Math.abs(k) / (W + 1)));
    }
    const t = keep * Math.min(1, Math.max(0, (m - 0.5) / 0.7));
    out[2 * i] = hard[2 * i] * (1 - t) + soft[2 * i] * t;
    out[2 * i + 1] = hard[2 * i + 1] * (1 - t) + soft[2 * i + 1] * t;
  }
  return out;
}

/** Split a closed outline where it runs along the frame border (the photo's edge is not the
 *  subject's): open runs, each with at least minLen of line. */
function offBorderRuns(p, b, minLen, open = false) {
  const n = p.length / 2, off = k => p[2 * k] > b && p[2 * k] < 1 - b && p[2 * k + 1] > b && p[2 * k + 1] < 1 - b;
  let s0 = -1;
  for (let k = 0; k < n; k++) if (!off(k)) { s0 = k; break; }
  if (s0 < 0) return [{ pts: Array.from(p), closed: !open }];
  if (open) s0 = -1;
  const runs = [];
  let run = [];
  for (let m = 1; m <= (open ? n : n); m++) {
    const k = open ? m - 1 : (s0 + m) % n;
    if (off(k)) run.push(p[2 * k], p[2 * k + 1]);
    else { if (run.length >= 8 && polyLen(run, false) >= minLen) runs.push({ pts: run, closed: false }); run = []; }
  }
  if (run.length >= 8 && polyLen(run, false) >= minLen) runs.push({ pts: run, closed: false });
  return runs;
}

// per style: contour smoothing (frame fractions: hard, soft), corner keeping, and how many inner
// lines of each sort survive
const SIL_STYLE = {
  picasso: { hard: 0.014, soft: 0.004, keep: 0.8, other: 2, hair: 2, contour: 2, ear: 1, land: 1 },
  matisse: { hard: 0.009, soft: 0.003, keep: 0.9, other: 5, hair: 4, contour: 3, ear: 2, land: 2 },
  blind: { hard: 0.006, soft: 0.003, keep: 0.6, other: 8, hair: 6, contour: 4, ear: 2, land: 3 },
  brush: { hard: 0.010, soft: 0.004, keep: 0.8, other: 6, hair: 5, contour: 3, ear: 2, land: 3 },
};
const FEATURE_KINDS = new Set(['eye', 'iris', 'brow', 'nose', 'lips']);

function stroke(points, kind, sal, closed, dark = 0.6, extra = {}) {
  return { points: Float32Array.from(points), closed, saliency: sal, kind, dark, ...extra };
}

/**
 * Silhouette-first strokes: the subject's outline as the artist's contour (kind 'outline',
 * silhouette: true, saliency 1), then the line model's strokes clipped to inside it, keeping
 * only the telling ones. Frame fractions in and out (the LA-lines contract).
 */
export function silhouetteStrokes(strokes, sil, styleId = 'matisse', face = null, dark = null) {
  sil = closeUpSilhouette(sil, face);
  const P = SIL_STYLE[styleId] || SIL_STYLE.matisse;
  const out = [];
  const step = 0.0025;
  // a scene: a landscape, or a small subject (a setting sun) standing on a skyline; the skyline is
  // the main line and the small subject one landmark on it
  const land = isScene(sil);
  // a thin subject the mask cannot hold (low confidence: a bicycle's blob): the line model's structure
  if (!land && sil.kind === 'object' && (sil.confidence ?? 1) < 0.55 && sil.mask && sil.mask.data) {
    const st = structureStrokes(strokes, sil, P);
    if (st) return st;
  }
  // ---- the contour
  const contourLines = [];
  let treeLines = [];
  if (land) {
    // (not where it runs down the photo's side: the frame's edge is not the horizon)
    const p = resampleFrac(sil.skyline, false, step);
    const runs = offBorderRuns(Float32Array.from(p), 0.035, 0.08, true).map(r => r.pts);
    const long = runs.sort((a, b) => polyLen(b, false) - polyLen(a, false)).slice(0, 2);
    for (const q of long) contourLines.push({ pts: contourOf(q, false, Math.round(P.hard * 0.7 / step), Math.round(P.soft / step), P.keep), closed: false });
    // the small subject on it (the sun, a lone tree), whole
    if (sil.kind !== 'landscape') for (const q of (sil.outlines || []).slice(0, 1)) {
      const r = resampleFrac(q, true, step);
      if (r.length >= 16) for (const run of offBorderRuns(Float32Array.from(r), 0.012, 0.04)) contourLines.push({ pts: contourOf(run.pts, run.closed, Math.round(P.soft * 2 / step), Math.round(P.soft / step), P.keep), closed: run.closed });
    }
    // the next line down: the tree line as a few trees (a landscape with a forest), else the
    // model's longest calm line under the skyline (a nearer ridge, a shoreline)
    if (sil.kind === 'landscape') {
      const skyR = resampleFrac(sil.skyline, false, 0.01);
      const tg = treeGlyphs(sil.treeline, Math.max(2, Math.min(4, P.land + 1)), skyR);
      if (tg) {
        for (const b of tg.base) contourLines.push({ pts: contourOf(resampleFrac(b, false, step), false, Math.round(0.04 / step), Math.round(P.soft / step), 0), closed: false });
        treeLines = tg.trees.map(t => resampleFrac(t.pts, false, step));
      } else {
        const r = secondLine(strokes, skyR);
        if (r) contourLines.push({ pts: contourOf(resampleFrac(r, false, step), false, Math.round(P.hard * 1.5 / step), Math.round(P.soft / step), P.keep), closed: false });
      }
    }
  } else {
    // (the silhouette's own outlines, frame fractions; traced from its mask when it has none)
    let outlines = (sil.outlines || []).filter(q => q && q.length >= 8 && q.every(v => v >= -0.01 && v <= 1.01));
    if (!outlines.length && sil.mask && sil.mask.data) outlines = traceMask(sil.mask);
    const areaOf = q => { let A = 0; for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) A += q[j] * q[i + 1] - q[i] * q[j + 1]; return Math.abs(A / 2); };
    const a0 = outlines.length ? areaOf(outlines[0]) : 0;
    // the subject, and a second part only when it is a real part of the picture (a second pet)
    const use = outlines.filter((q, i) => i === 0 || (i < 3 && areaOf(q) > 0.25 * a0));
    if (sil.oval) {
      // a face that fills the frame: its oval from the landmarks, cut by the frame (a close crop)
      const p = resampleFrac(sil.oval, true, step);
      for (const run of offBorderRuns(Float32Array.from(p), 0.012, 0.05)) contourLines.push({ pts: contourOf(run.pts, run.closed, Math.round(0.02 / step), Math.round(P.soft / step), 0), closed: run.closed });
    } else for (const q of use) {
      const p = resampleFrac(q, true, step);
      if (p.length < 16) continue;
      for (const run of offBorderRuns(p, 0.012, 0.05)) {
        contourLines.push({ pts: contourOf(run.pts, run.closed, Math.round(P.hard / step), Math.round(P.soft / step), P.keep), closed: run.closed });
      }
    }
  }
  for (const c of contourLines) out.push(stroke(c.pts, 'outline', 1, c.closed, 0.7, { silhouette: true }));
  if (!land && (!sil.mask || !sil.mask.data)) return out.concat(strokes);

  // ---- inner lines, clipped to the silhouette (plus a small margin)
  const M = sil.mask && sil.mask.data ? maskTools(sil.mask) : null;
  const hair = sil.parts && sil.parts.hair && sil.parts.hair.data ? maskTools(sil.parts.hair) : null;
  const margin = 0.012, dup = land ? 0.03 : 0.016;
  // (a landscape's lines are judged by their distance to the skyline, not by the ground mask)
  const sky = land ? resampleFrac(sil.skyline, false, 0.01) : null;
  const nearSky = (x, y) => { for (let k = 0; k < sky.length; k += 2) if (Math.hypot(sky[k] - x, sky[k + 1] - y) < dup) return true; return false; };
  // how far a landmark's top sits below the skyline over it (a landmark stands on the horizon)
  const belowSky = p => {
    let top = Infinity, tx = 0;
    for (let k = 0; k < p.length; k += 2) if (p[k + 1] < top) { top = p[k + 1]; tx = p[k]; }
    let best = Infinity, sy = top;
    for (let k = 0; k < sky.length; k += 2) { const d = Math.abs(sky[k] - tx); if (d < best) { best = d; sy = sky[k + 1]; } }
    return top - sy;
  };
  const cands = [], apps = [];
  for (const s of strokes || []) {
    const p = s.points;
    if (!p || p.length < 4) continue;
    const n = p.length / 2;
    let cx = 0, cy = 0;
    for (let k = 0; k < p.length; k += 2) { cx += p[k]; cy += p[k + 1]; }
    cx /= n; cy /= n;
    if (FEATURE_KINDS.has(s.kind) || (s.closed && strokeBox(p) < 0.08)) {
      // eyes, nose, mouth (and small closed shapes: a pupil, a button): whole, when on the subject
      if (land ? strokeBox(p) < 0.12 : M.out(cx, cy) <= margin) cands.push({ s, pts: Array.from(p), closed: !!s.closed, feat: FEATURE_KINDS.has(s.kind), cx, cy });
      continue;
    }
    // the rest: only the runs inside, and not the model's own copy of the outline
    let run = [];
    const flush = () => {
      if (run.length >= 8 && polyLen(run, false) >= 0.035) {
        let rx = 0, ry = 0;
        for (let k = 0; k < run.length; k += 2) { rx += run[k]; ry += run[k + 1]; }
        cands.push({ s, pts: run, closed: false, feat: false, cx: rx / (run.length / 2), cy: ry / (run.length / 2) });
      }
      run = [];
    };
    for (let k = 0; k < n; k++) {
      const x = p[2 * k], y = p[2 * k + 1];
      const keep = land ? !nearSky(x, y) : (M.out(x, y) <= margin && M.edge(x, y) > dup);
      if (keep) run.push(x, y); else flush();
    }
    flush();
    // a closed stroke that survived whole stays closed
    const last = cands[cands.length - 1];
    if (last && last.s === s && s.closed && last.pts.length === p.length) last.closed = true;
    // a loop that leaves the silhouette and comes back to it close by (a cup's handle, an ear or a
    // beak the mask missed) belongs to the outer shape: it joins the contour
    if (!land) {
      let a = -1;
      for (let k = 0; k <= n; k++) {
        const outside = k < n && M.out(p[2 * k], p[2 * k + 1]) > margin;
        if (outside && a < 0) a = k;
        else if (!outside && a >= 0) {
          if (a > 0 && k < n) {
            const q = Array.from(p.slice(2 * (a - 1), 2 * k + 2));
            let far = 0;
            for (let m = 0; m < q.length; m += 2) far = Math.max(far, M.out(q[m], q[m + 1]));
            const len = polyLen(q, false), chord = Math.hypot(q[0] - q[q.length - 2], q[1] - q[q.length - 1]);
            if (far > 0.02 && far < 0.09 && len > 0.05 && chord < 0.45 * len) apps.push({ pts: q, len });
          }
          a = -1;
        }
      }
    }
  }
  // ---- keep the telling ones
  // (a landscape has no features to keep whole: every landmark competes for the few places)
  const feats = land ? [] : cands.filter(c => c.feat);
  // long hair falling to the shoulders makes one hood around the face: the lines at the neck
  // (its sides, a neckline, the shoulder meeting the hair) are kept as features, so head and
  // shoulders read apart
  const hood = !land && (sil.kind === 'portrait' || sil.kind === 'person') && !sil.closeUp && face ? hoodInfo(M, face) : null;
  const neckKeep = [];
  if (hood) {
    const neck = cands.filter(c => !c.feat && c.cy > hood.chin - 0.01 && c.cy < hood.chin + 0.9 * hood.fh && Math.abs(c.cx - hood.cx) < 1.2 * hood.fw && M.depth(c.cx, c.cy) > 0.012)
      .map(c => ({ c, len: polyLen(c.pts, c.closed) })).filter(o => o.len > 0.05).sort((u, v) => v.len - u.len).slice(0, 3);
    for (const o of neck.slice(0, 2)) { o.c.keep = true; neckKeep.push(o.c); }   // (kept, but no stronger dip into the contour than any inner line)
  }
  // a pale animal's eyes and nose, when the model found none there
  if (!land && sil.kind === 'animal' && dark) feats.push(...animalSpots(M, sil, dark, cands.filter(c => c.feat || (c.closed && strokeBox(c.pts) < 0.08))));
  const rest = cands.filter(c => land || (!c.feat && !c.keep && !feats.includes(c))).map(c => {
    const len = polyLen(c.pts, c.closed);
    const depth = land ? 0 : M.depth(c.cx, c.cy);
    const kind = c.s.kind;
    const group = kind === 'hair' ? 'hair' : (kind === 'outline' || kind === 'jaw') ? 'contour' : kind === 'ear' ? 'ear' : 'other';
    // a landscape keeps compact landmarks (a sun, a tree, a house), never long bands
    const box = strokeBox(c.pts);
    const v = (c.s.saliency ?? 0.5) * Math.sqrt(len) * (1 + 4 * Math.min(0.08, depth)) * (land ? (box < 0.3 && box > 0.06 && len < 4 * box ? 1 : 0.1) : 1)
      * (hair && group === 'hair' ? (hair.inside(c.cx, c.cy) ? 1.4 : 0.5) : 1);
    return { ...c, len, group, v, box };
  }).sort((a, b) => b.v - a.v);
  const cap = land ? { hair: 0, contour: 0, ear: 0, other: P.land } : { hair: P.hair, contour: P.contour, ear: P.ear, other: P.other };
  if (face) cap.other = Math.max(1, Math.round(cap.other * 0.6));
  if (sil.tallest) cap.other = Math.min(cap.other, 2);   // (a building: a window or two, not every brick)
  const used = { hair: 0, contour: 0, ear: 0, other: 0 };
  const keepRest = [];
  for (const c of rest) {
    if (land && !(c.box < 0.3 && c.box > 0.06 && c.len < 4 * c.box && standsUp(c.pts, c.closed) && belowSky(c.pts) < 0.25)) continue;   // (no bands, no U's, nothing lost in the foreground)
    if (used[c.group] >= cap[c.group]) continue;
    used[c.group]++;
    keepRest.push(c);
  }
  const inner = [...feats, ...neckKeep, ...keepRest];
  // ---- the contour in pieces, cut where the line dips in for a feature: the pen leaves the
  // outline there, draws the feature and comes back out to go on along the outline (never back
  // over the outline it already drew)
  const pieces = [];
  for (const c of contourLines) {
    const p = c.pts, n = p.length / 2, minPts = Math.max(Math.round(0.07 / step), Math.round(n / 9));
    const ks = [];
    for (const f of inner) {
      let bk = -1, bd = land ? 0.35 : 0.3;
      for (let k = 0; k < n; k += 2) { const d = Math.hypot(p[2 * k] - f.cx, p[2 * k + 1] - f.cy); if (d < bd) { bd = d; bk = k; } }
      if (bk >= 0) ks.push({ k: bk, pri: (f.feat ? 2 : 1) - bd });
    }
    // the strongest dips first, each at least minPts from the others (and the open ends)
    ks.sort((a, b) => b.pri - a.pri);
    const cuts = [];
    const gap = (a, b) => { const d = Math.abs(a - b); return c.closed ? Math.min(d, n - d) : d; };
    for (const { k } of ks) {
      if (!c.closed && (k < minPts || k > n - 1 - minPts)) continue;
      if (cuts.every(q => gap(q, k) >= minPts)) cuts.push(k);
      if (cuts.length >= 9) break;
    }
    cuts.sort((a, b) => a - b);
    if (!cuts.length || (c.closed && cuts.length < 2)) { pieces.push(c); continue; }
    if (c.closed) {
      for (let i = 0; i < cuts.length; i++) {
        const a = cuts[i], b = cuts[(i + 1) % cuts.length], q = [];
        for (let k = a; ; k = (k + 1) % n) { q.push(p[2 * k], p[2 * k + 1]); if (k === b) break; }
        pieces.push({ pts: q, closed: false });
      }
    } else {
      let a = 0;
      for (const b of [...cuts, n - 1]) { pieces.push({ pts: p.slice(2 * a, 2 * b + 2), closed: false }); a = b; }
    }
  }
  out.length = 0;
  for (const c of pieces) out.push(stroke(c.pts, 'outline', 1, c.closed, 0.7, { silhouette: true }));
  // (the longest few appendages, not overlapping one another)
  const kept = [];
  for (const a of apps.sort((u, v) => v.len - u.len)) {
    if (kept.length >= (sil.tallest ? 0 : 3)) break;
    const cx = a.pts[a.pts.length >> 2 << 1], cy = a.pts[(a.pts.length >> 2 << 1) + 1];
    if (kept.some(b => { for (let m = 0; m < b.pts.length; m += 2) if (Math.hypot(b.pts[m] - cx, b.pts[m + 1] - cy) < 0.03) return true; return false; })) continue;
    kept.push(a);
    out.push(stroke(a.pts, 'outline', 1, false, 0.7, { silhouette: true, appendage: true }));
  }
  for (const t of treeLines) out.push(stroke(t, 'outline', 1, false, 0.7, { silhouette: true, tree: true }));
  for (const c of inner) out.push(stroke(c.pts, c.s.kind, c.s.saliency ?? 0.5, c.closed, c.s.dark ?? 0.5));
  return out;
}

function strokeBox(p) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < p.length; k += 2) { x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); y0 = Math.min(y0, p[k + 1]); y1 = Math.max(y1, p[k + 1]); }
  return Math.max(x1 - x0, y1 - y0);
}

/**
 * STAND-IN silhouette until js/lineart/silhouette.js lands: the line model's strokes rasterised,
 * thickened, flood-filled from the frame's top and sides and inverted, the largest part, thinned
 * back. Same shape as silhouette()'s result, with standin: true.
 */
export function standinSilhouette(strokes, { N = 160, face = null, ink = null, inkN = 0, inkThr = 0.4 } = {}) {
  const w = N, h = N, line = new Uint8Array(w * h);
  // the line model's whole map when there is one (ink 0..1, inkN x inkN), else the chosen strokes
  if (ink && inkN) for (let j = 0; j < inkN; j++) for (let i = 0; i < inkN; i++) {
    if (ink[j * inkN + i] > inkThr) line[Math.floor(j / inkN * h) * w + Math.floor(i / inkN * w)] = 1;
  }
  const r = Math.max(2, Math.round(0.022 * N));
  for (const s of strokes || []) {
    const p = s.points;
    if (!p) continue;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const L = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]) * N, m = Math.max(1, Math.ceil(L));
      for (let t = 0; t <= m; t++) {
        const x = Math.floor((p[k] + (p[k + 2] - p[k]) * t / m) * w), y = Math.floor((p[k + 1] + (p[k + 3] - p[k + 1]) * t / m) * h);
        if (x >= 0 && y >= 0 && x < w && y < h) line[y * w + x] = 1;
      }
    }
  }
  const dl = chamfer(w, h, k => line[k] === 1);
  const wall = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) wall[k] = dl[k] <= r ? 1 : 0;
  // the outside: flooded from the top and the upper sides (a bust, a portrait or a sitting cat
  // runs off the bottom of the frame; the bottom edge closes it)
  const outside = new Uint8Array(w * h), q = [];
  const seed = k => { if (!wall[k] && !outside[k]) { outside[k] = 1; q.push(k); } };
  for (let i = 0; i < w; i++) seed(i);
  for (let j = 0; j < h * 0.7; j++) { seed(j * w); seed(j * w + w - 1); }
  while (q.length) {
    const k = q.pop(), i = k % w, j = (k / w) | 0;
    if (i > 0) seed(k - 1); if (i < w - 1) seed(k + 1); if (j > 0) seed(k - w); if (j < h - 1) seed(k + w);
  }
  // thin back by the thickening
  const dOut = chamfer(w, h, k => outside[k] === 1);
  const inside = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) inside[k] = !outside[k] && dOut[k] > r * 0.8 ? 1 : 0;
  // the largest part
  const lab = new Int32Array(w * h).fill(-1);
  let best = -1, bestN = 0;
  for (let s0 = 0, id = 0; s0 < w * h; s0++) {
    if (!inside[s0] || lab[s0] >= 0) continue;
    const st = [s0]; lab[s0] = id;
    let cnt = 0;
    while (st.length) {
      const k = st.pop(); cnt++;
      const i = k % w, j = (k / w) | 0;
      for (const nk of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, j > 0 ? k - w : -1, j < h - 1 ? k + w : -1]) {
        if (nk >= 0 && inside[nk] && lab[nk] < 0) { lab[nk] = id; st.push(nk); }
      }
    }
    if (cnt > bestN) { bestN = cnt; best = id; }
    id++;
  }
  const data = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) data[k] = lab[k] === best && best >= 0 ? 255 : 0;
  const mask = { w, h, data };
  return { mask, outlines: traceMask(mask), kind: face ? 'portrait' : 'unknown', confidence: 0.3, standin: true, timings: {} };
}

/**
 * How well the drawing gives the subject's silhouette: { iou, cover, score } where iou compares
 * the region the drawn line encloses (rasterised; where the subject runs off the frame, the frame
 * closes it) with the mask, and cover is the share of the mask's boundary within 2% of the line.
 */
export function silhouetteScore(geom, sil, { N = 200 } = {}) {
  if (!geom || !sil) return null;
  sil = closeUpSilhouette(sil);   // (scored against the shape it was drawn from)
  // a landscape is scored against the land under its skyline
  if (isScene(sil)) sil = { mask: groundMask(sil.skyline, 128) };
  if (!sil.mask || !sil.mask.data) return null;
  const { w: mw, h: mh, data: md } = sil.mask;
  const w = N, h = N, mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) mask[j * w + i] = md[Math.floor((j + 0.5) / h * mh) * mw + Math.floor((i + 0.5) / w * mw)] > 127 ? 1 : 0;
  const line = new Uint8Array(w * h), d = geom.data, n = geom.n;
  let px = null, py = null;
  for (let t = 0; t < n; t++) {
    const x = (d[t * STRIDE] + 1) / 2 * w, y = (d[t * STRIDE + 1] + 1) / 2 * h;
    if (px !== null) {
      const m = Math.max(1, Math.ceil(Math.hypot(x - px, y - py)));
      for (let u = 1; u <= m; u++) {
        const xi = Math.floor(px + (x - px) * u / m), yi = Math.floor(py + (y - py) * u / m);
        if (xi >= 0 && yi >= 0 && xi < w && yi < h) line[yi * w + xi] = 1;
      }
    }
    px = x; py = y;
  }
  const dLine = chamfer(w, h, k => line[k] === 1);
  // the eye closes small gaps in an outline: the line is thickened by 2% of the frame for the
  // fill (a gap narrower than about 4% does not leak), and the region thinned back after
  const r = Math.max(1, 0.02 * N), e = Math.round(0.05 * N);
  const inFrame = k => { const i = k % w, j = (k / w) | 0; return i >= e && j >= e && i < w - e && j < h - e; };
  const wall = k => dLine[k] <= r || (!inFrame(k) && mask[k]);
  const outside = new Uint8Array(w * h), q = [];
  const seed = k => { if (!outside[k] && !wall(k)) { outside[k] = 1; q.push(k); } };
  for (let k = 0; k < w * h; k++) if (!inFrame(k) && !mask[k]) seed(k);
  while (q.length) {
    const k = q.pop(), i = k % w, j = (k / w) | 0;
    if (i > 0) seed(k - 1); if (i < w - 1) seed(k + 1); if (j > 0) seed(k - w); if (j < h - 1) seed(k + w);
  }
  const dOutside = chamfer(w, h, k => outside[k] === 1);
  let I = 0, U = 0, B = 0, Bc = 0;
  const near = 0.02 * N;
  for (let k = 0; k < w * h; k++) {
    if (!inFrame(k)) continue;
    const enc = !outside[k] && dOutside[k] > r - 0.006 * N, m = mask[k] === 1;
    if (enc && m) I++;
    if (enc || m) U++;
    if (m) {
      const i = k % w, j = (k / w) | 0;
      if (!mask[k - 1] || !mask[k + 1] || !mask[k - w] || !mask[k + w]) { B++; if (dLine[k] <= near) Bc++; }

    }
  }
  const iou = U ? I / U : 0, cover = B ? Bc / B : 0;
  return { iou: +iou.toFixed(3), cover: +cover.toFixed(3), score: +(0.5 * iou + 0.5 * cover).toFixed(3) };
}

/** Everything below an open skyline (left to right, frame fractions) as a 0/255 mask. */
function groundMask(sky, n) {
  const top = new Float32Array(n).fill(2);
  for (let k = 0; k + 3 < sky.length; k += 2) {
    const x0 = sky[k] * n, x1 = sky[k + 2] * n, y0 = sky[k + 1], y1 = sky[k + 3];
    const a = Math.max(0, Math.floor(Math.min(x0, x1))), b = Math.min(n - 1, Math.ceil(Math.max(x0, x1)));
    for (let i = a; i <= b; i++) { const t = x1 === x0 ? 0 : Math.max(0, Math.min(1, (i + 0.5 - x0) / (x1 - x0))); top[i] = Math.min(top[i], y0 + (y1 - y0) * t); }
  }
  const data = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) if (top[i] <= 1) for (let j = 0; j < n; j++) if ((j + 0.5) / n > top[i]) data[j * n + i] = 255;
  return { w: n, h: n, data };
}
function maskShare(m) {
  if (!m || !m.data) return 0;
  let c = 0;
  for (let k = 0; k < m.data.length; k++) if (m.data[k] > 127) c++;
  return c / m.data.length;
}

/** A scene, drawn as its skyline plus a landmark: a landscape, a small subject on a skyline (a
 *  setting sun, a far figure), or a thing that is not the whole picture standing in a view with a
 *  real skyline (a lighthouse whose house is the mask: the tower is in the skyline). */
export function isScene(sil) {
  if (!sil || !sil.skyline || sil.skyline.length < 8) return false;
  if (sil.kind === 'landscape') return true;
  const a = maskShare(sil.mask);
  return a < 0.1 || ((sil.kind === 'object' || sil.kind === 'unknown') && a < 0.3);
}

/** A landmark that stands up on the land (a tree, a roof, a peak, a closed shape), not a U or a
 *  hook hanging off the skyline: its top lies inside the stroke, both ends well below it. */
function standsUp(p, closed) {
  if (closed) return true;
  const n = p.length / 2;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < p.length; k += 2) { x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); y0 = Math.min(y0, p[k + 1]); y1 = Math.max(y1, p[k + 1]); }
  const h = y1 - y0;
  if (x0 < 0.04 || y0 < 0.04 || x1 > 0.96 || y1 > 0.96) return false;   // (a whole thing, not cut by the frame)
  return h > 0.02 && x1 - x0 > 0.02 && p[1] - y0 > 0.35 * h && p[2 * n - 1] - y0 > 0.35 * h;
}

/** An extreme close-up (the person fills the frame): the face is the shape to draw, so the face
 *  part (with the hair when that still leaves room) stands in for the whole silhouette. */
function closeUpSilhouette(sil, face = null) {
  if (sil && sil.mask && sil.parts && sil.parts.face && sil.parts.face.data && maskShare(sil.mask) > 0.8) {
    const f = sil.parts.face, h = sil.parts.hair;
    // the face itself runs off the frame (a very close crop): its oval from the landmarks, cut by
    // the frame, is the contour
    const oval = face && faceOval(face.landmarks);
    if (oval && outsideShare(oval) > 0.3) return { ...sil, mask: f, outlines: [], closeUp: true, oval };
    let m = f;
    if (h && h.data && h.w === f.w && h.h === f.h) {
      const u = new Uint8Array(f.data.length);
      for (let k = 0; k < u.length; k++) u[k] = f.data[k] > 127 || h.data[k] > 127 ? 255 : 0;
      if (maskShare({ data: u }) < 0.75) m = { w: f.w, h: f.h, data: u };
    }
    if (maskShare(m) > 0.05) return { ...sil, mask: m, outlines: traceMask(m), closeUp: true };
  }
  return sil;
}

// ------------------------------------------------------------------ hard cases
// (close crops, thin things, a portrait's neck, a pale animal's face, a landscape's second line and
// its trees)

// the face oval's landmark ring (MediaPipe face mesh), as in silhouette.js
const OVAL_IDX = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149,
  150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
function faceOval(lm) {
  if (!lm || lm.length < 956) return null;
  const o = [];
  for (const i of OVAL_IDX) o.push(lm[2 * i], lm[2 * i + 1]);
  return o;
}
/** Share of a closed polyline's length that lies outside the frame. */
function outsideShare(p) {
  let a = 0, b = 0;
  for (let k = 0, n = p.length / 2; k < n; k++) {
    const j = (k + 1) % n, L = Math.hypot(p[2 * j] - p[2 * k], p[2 * j + 1] - p[2 * k + 1]);
    const mx = (p[2 * j] + p[2 * k]) / 2, my = (p[2 * j + 1] + p[2 * k + 1]) / 2;
    b += L; if (mx < 0 || mx > 1 || my < 0 || my > 1) a += L;
  }
  return b ? a / b : 0;
}

/** Circle through a polyline's points (algebraic fit): centre, radius, rms misfit and how many
 *  degrees of the circle the points cover. */
function fitCircle(p) {
  const n = p.length / 2;
  let mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mx += p[2 * k]; my += p[2 * k + 1]; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let k = 0; k < n; k++) {
    const u = p[2 * k] - mx, v = p[2 * k + 1] - my;
    suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const e = 0.5 * (suuu + suvv), f = 0.5 * (svvv + svuu), det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-14) return null;
  const uc = (svv * e - suv * f) / det, vc = (suu * f - suv * e) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n), cx = uc + mx, cy = vc + my;
  let rms = 0;
  const bins = new Uint8Array(24);
  for (let k = 0; k < n; k++) {
    const dx = p[2 * k] - cx, dy = p[2 * k + 1] - cy;
    rms += (Math.hypot(dx, dy) - r) ** 2;
    bins[Math.min(23, Math.floor((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * 24))] = 1;
  }
  let cover = 0;
  for (const b of bins) cover += b;
  return { cx, cy, r, rms: Math.sqrt(rms / n), cover: cover * 15 };
}

/**
 * A thin subject the mask cannot hold (a bicycle: the touch finds a blob of frame and part of a
 * wheel): the line model's structure instead, round rims as circles plus the frame's longer lines,
 * all around the subject's box. Null when no rim is found (then the mask route goes on).
 */
function structureStrokes(strokes, sil, P) {
  const { w, h, data } = sil.mask;
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (data[j * w + i] > 127) {
    x0 = Math.min(x0, i / w); x1 = Math.max(x1, (i + 1) / w); y0 = Math.min(y0, j / h); y1 = Math.max(y1, (j + 1) / h);
  }
  if (x1 <= x0) return null;
  const pad = 0.08;
  const inBox = (x, y) => x > x0 - pad && x < x1 + pad && y > y0 - pad && y < y1 + pad;
  const circles = [];
  for (const s of strokes || []) {
    const p = s.points;
    if (!p || p.length < 24 || polyLen(p, !!s.closed) < 0.1) continue;
    let inb = 0;
    for (let k = 0; k < p.length; k += 2) if (inBox(p[k], p[k + 1])) inb++;
    if (inb < 0.8 * p.length / 2) continue;
    const c = fitCircle(p);
    if (!c || c.r < 0.06 || c.r > 0.3 || c.rms > 0.12 * c.r || c.cover < 90 || !inBox(c.cx, c.cy)) continue;
    circles.push(c);
  }
  circles.sort((a, b) => b.cover - a.cover || b.r - a.r);
  const wheels = [];
  for (const c of circles) {
    if (wheels.some(q => Math.hypot(q.cx - c.cx, q.cy - c.cy) < 0.7 * Math.max(q.r, c.r))) continue;
    if (!wheels.length && (c.cover < 120 || c.rms > 0.08 * c.r)) continue;         // (the first rim shows most of itself)
    if (wheels.length && Math.abs(Math.log(c.r / wheels[0].r)) > 0.5) continue;   // (two wheels, one size)
    wheels.push(c);
    if (wheels.length >= 2) break;
  }
  if (!wheels.length) return null;
  const out = [];
  for (const q of wheels) {
    const pts = [];
    for (let k = 0; k < 160; k++) { const a = -Math.PI / 2 + 2 * Math.PI * k / 160; pts.push(q.cx + q.r * Math.cos(a), q.cy + q.r * Math.sin(a)); }
    for (const run of offBorderRuns(Float32Array.from(pts), 0.006, 0.05)) out.push(stroke(run.pts, 'outline', 1, run.closed, 0.7, { silhouette: true, structure: 'wheel' }));
  }
  // the frame and the rest: the model's longer lines in the box, off the rims
  const onRim = (x, y) => wheels.some(q => Math.abs(Math.hypot(x - q.cx, y - q.cy) - q.r) < 0.025);
  const cands = [];
  for (const s of strokes || []) {
    const p = s.points;
    if (!p || p.length < 8) continue;
    let run = [];
    const flush = () => {
      if (run.length >= 8) { const len = polyLen(run, false); if (len >= 0.05) cands.push({ s, pts: run, len, v: (s.saliency ?? 0.5) * Math.sqrt(len) }); }
      run = [];
    };
    for (let k = 0; k < p.length; k += 2) {
      if (inBox(p[k], p[k + 1]) && !onRim(p[k], p[k + 1])) run.push(p[k], p[k + 1]); else flush();
    }
    flush();
  }
  cands.sort((a, b) => b.v - a.v);
  for (const c of cands.slice(0, P.other + 2)) out.push(stroke(c.pts, c.s.kind || 'other', c.s.saliency ?? 0.5, false, c.s.dark ?? 0.5, { silhouette: true, structure: 'frame' }));
  return out;
}

/** Face size and chin from the landmarks when the shape is wider than the face at the chin (long
 *  hair falling past it: the hood look), else null. */
function hoodInfo(M, face) {
  const ov = faceOval(face && face.landmarks);
  if (!ov) return null;
  let fx0 = 1, fx1 = 0, fy0 = 1, fy1 = 0;
  for (let k = 0; k < ov.length; k += 2) { fx0 = Math.min(fx0, ov[k]); fx1 = Math.max(fx1, ov[k]); fy0 = Math.min(fy0, ov[k + 1]); fy1 = Math.max(fy1, ov[k + 1]); }
  const fw = fx1 - fx0, fh = fy1 - fy0;
  if (fw < 0.05 || fy1 > 0.9) return null;
  // (wide at the chin and already beside the eyes: hair framing the face, not shoulders alone)
  const width = y => { let a = 1, b = 0; for (let i = 0; i < 200; i++) { const x = i / 200; if (M.inside(x, y)) { a = Math.min(a, x); b = Math.max(b, x); } } return b - a; };
  return width(fy1 + 0.02) > 1.5 * fw && width(fy0 + 0.5 * fh) > 1.4 * fw ? { chin: fy1, fw, fh, cx: (fx0 + fx1) / 2 } : null;
}

/**
 * A pale animal's face (a white dog: the line model finds almost nothing there): the darkest
 * compact spots in the head's part of the shape, eyes and nose, as small closed marks, where no
 * feature is drawn yet.
 */
function animalSpots(M, sil, dark, have) {
  if (!dark || !dark.data) return [];
  const { w, h, data } = sil.mask;
  let y0 = 1, y1 = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (data[j * w + i] > 127) { y0 = Math.min(y0, j / h); y1 = Math.max(y1, (j + 1) / h); }
  if (y1 <= y0) return [];
  const headY = y0 + 0.4 * (y1 - y0);
  const G = dark.w, D = dark.data;
  const at = (i, j) => D[Math.max(0, Math.min(G - 1, j)) * G + Math.max(0, Math.min(G - 1, i))];
  let sum = 0, cnt = 0;
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const x = (i + 0.5) / G, y = (j + 0.5) / G;
    if (y < headY && M.inside(x, y)) { sum += at(i, j); cnt++; }
  }
  if (cnt < 20) return [];
  const mean = sum / cnt, thr = Math.max(0.5, mean + 0.28);
  if (mean > 0.42) return [];   // (a pale coat: on a dark bird or a dark horse every spot is a guess)
  const spots = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const x = (i + 0.5) / G, y = (j + 0.5) / G, v = at(i, j);
    if (y >= headY || v < thr || M.depth(x, y) < 0.05) continue;   // (well inside: not an ear's dark lining)
    let ring = 0;
    for (let q = -3; q <= 3; q++) ring += at(i + q, j - 3) + at(i + q, j + 3) + at(i - 3, j + q) + at(i + 3, j + q);
    if (v - ring / 28 < 0.25) continue;   // (a spot, not a shadow along a side)
    // (round: lighter a little way off in all four directions, so a tabby's stripe is no spot)
    if (Math.max(at(i - 3, j), at(i + 3, j), at(i, j - 3), at(i, j + 3)) > v - 0.12) continue;
    let peak = true;
    for (let dj = -1; dj <= 1 && peak; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && at(i + di, j + dj) > v) { peak = false; break; }
    if (peak) spots.push({ x, y, v });
  }
  spots.sort((a, b) => b.v - a.v);
  const keep = [];
  for (const s of spots) {
    if (keep.length >= 3) break;
    if (keep.some(q => Math.hypot(q.x - s.x, q.y - s.y) < 0.05)) continue;
    if (have.some(q => Math.hypot(q.cx - s.x, q.cy - s.y) < 0.035)) continue;
    keep.push(s);
  }
  // the lowest of three is the nose; a spot's mark follows its dark patch's size
  keep.sort((a, b) => a.y - b.y);
  return keep.map((s, i) => {
    let r = 0.008;
    for (let q = 1; q <= 4; q++) if (at(Math.floor(s.x * G) + q, Math.floor(s.y * G)) > 0.8 * s.v || at(Math.floor(s.x * G) - q, Math.floor(s.y * G)) > 0.8 * s.v) r = 0.008 + 0.5 * q / G;
    r = Math.min(0.022, r);
    const pts = [];
    for (let k = 0; k < 20; k++) { const a = 2 * Math.PI * k / 20; pts.push(s.x + r * Math.cos(a), s.y + 0.8 * r * Math.sin(a)); }
    const kind = keep.length === 3 && i === 2 ? 'nose' : 'eye';
    return { s: { kind, saliency: 1, dark: 0.8 }, pts, closed: true, feat: true, cx: s.x, cy: s.y };
  });
}

/** The skyline's height at x (frame fractions; sky resampled, left to right). */
function skyAt(sky, x) {
  let best = Infinity, y = 0;
  for (let k = 0; k < sky.length; k += 2) { const d = Math.abs(sky[k] - x); if (d < best) { best = d; y = sky[k + 1]; } }
  return y;
}

/** A landscape's second line: the longest calm line of the model's under the skyline (a nearer
 *  ridge, a shoreline, the top of a forest). Open polyline or null. */
function secondLine(strokes, sky) {
  let best = null, bv = 0;
  for (const s of strokes || []) {
    const p = s.points;
    if (!p || p.length < 20) continue;
    let run = [];
    const flush = () => {
      if (run.length >= 12) {
        let a = 1, b = 0;
        for (let k = 0; k < run.length; k += 2) { a = Math.min(a, run[k]); b = Math.max(b, run[k]); }
        const ext = b - a, len = polyLen(run, false), rise = Math.abs(run[run.length - 1] - run[1]);
        if (ext > 0.25 && len < 1.8 * ext && rise < 0.6 * ext) {
          const v = ext * (0.5 + (s.saliency ?? 0.5));
          if (v > bv) { bv = v; best = run; }
        }
      }
      run = [];
    };
    for (let k = 0; k < p.length; k += 2) {
      const x = p[k], y = p[k + 1];
      if (x > 0.02 && x < 0.98 && y < 0.93 && y > skyAt(sky, x) + 0.06) run.push(x, y); else flush();
    }
    flush();
  }
  if (!best) return null;
  // left to right
  if (best[0] > best[best.length - 2]) { const r = []; for (let k = best.length - 2; k >= 0; k -= 2) r.push(best[k], best[k + 1]); best = r; }
  return best;
}

/**
 * The tree line as a few trees, not a comb: the forest's top (sil.treeline, one height per
 * column, -1 where there is none) calmed to a line, and a small spruce drawn at each of its most
 * telling tips (the tallest over their neighbours, spread out). Returns { base, trees } or null.
 */
function treeGlyphs(tl, count, sky) {
  if (!tl || tl.length < 40 || count < 1) return null;
  const n = tl.length / 2, xs = [], ys = [];
  for (let k = 0; k < n; k++) if (tl[2 * k + 1] >= 0) { xs.push(tl[2 * k]); ys.push(tl[2 * k + 1]); }
  if (xs.length < 0.3 * n) return null;
  const m = xs.length;
  // (a column can pick a step lower down: a running median calms the profile first)
  { const R = 1, c = ys.slice(); for (let i = 0; i < m; i++) { const w = c.slice(Math.max(0, i - R), Math.min(m, i + R + 1)).sort((a, b) => a - b); ys[i] = w[w.length >> 1]; } }
  // the forest's body: the lower envelope over a window, smoothed
  const Wn = Math.max(3, Math.round(m * 0.04));
  const env = ys.map((_, i) => { let v = -1; for (let q = Math.max(0, i - Wn); q <= Math.min(m - 1, i + Wn); q++) v = Math.max(v, ys[q]); return v; });
  const sm = env.map((_, i) => { let s = 0, c = 0; for (let q = Math.max(0, i - Wn); q <= Math.min(m - 1, i + Wn); q++) { s += env[q]; c++; } return s / c; });
  const tips = [];
  for (let i = 1; i < m - 1; i++) {
    const prom = sm[i] - ys[i];
    if (prom < 0.02 || ys[i] > ys[i - 1] || ys[i] > ys[i + 1]) continue;
    if (xs[i] < 0.05 || xs[i] > 0.95 || ys[i] - skyAt(sky, xs[i]) < 0.02) continue;
    tips.push({ x: xs[i], y: ys[i], base: sm[i], prom });
  }
  tips.sort((a, b) => b.prom - a.prom);
  const pick = [];
  for (const t of tips) {
    if (pick.length >= count) break;
    if (pick.some(q => Math.abs(q.x - t.x) < 0.14)) continue;
    pick.push(t);
  }
  if (!pick.length) return null;
  // the base line, left to right, broken where a tree stands (the tree's own outline carries on)
  const trees = pick.map(t => {
    const hgt = Math.min(0.15, Math.max(0.08, t.base - t.y + 0.03)), wd = 0.42 * hgt, x = t.x, b = t.y + hgt;
    const L = [[-0.5, 0], [-0.18, -0.3], [-0.36, -0.3], [-0.12, -0.62], [-0.26, -0.62], [0, -1]];
    const pts = [];
    for (const [u, v] of L) pts.push(x + u * wd, b + v * hgt);
    for (let k = L.length - 2; k >= 0; k--) pts.push(x - L[k][0] * wd, b + L[k][1] * hgt);
    return { pts, x0: x - 0.5 * wd, x1: x + 0.5 * wd, b };
  });
  const base = [];
  let cur = [];
  for (let i = 0; i < m; i += 2) {
    const x = xs[i];
    if (x < 0.07 || x > 0.91 || trees.some(t => x > t.x0 - 0.01 && x < t.x1 + 0.01)) { if (cur.length >= 8) base.push(cur); cur = []; continue; }
    cur.push(x, sm[i]);
  }
  if (cur.length >= 8) base.push(cur);
  return { base: base.filter(b => polyLen(b, false) > 0.06), trees };
}
