// Line art silhouettes: the subject's outer shape, so the one line can start from it the way a
// one-line artist does, then dip in for the few telling features.
//
//   const sil = await silhouette(frame, { tap: null | [x, y], kindHint, landmarks });
//   -> { mask: { w, h, data: Uint8Array 0/255 }, outlines: [Float32Array x0,y0,... closed, frame
//        fractions, largest first], kind: 'person'|'portrait'|'animal'|'object'|'landscape'|'unknown',
//        confidence 0..1, parts?: { hair, face, body } (masks, people with landmarks),
//        skyline?: Float32Array (open, left to right), head?: Float32Array (closed: face + hair, people
//        with landmarks), edge: share of the mask's boundary on the frame edge (1 = fills the frame),
//        keypoint, why, timings }
//
// frame is the art frame (the crop's square, as extractLines builds it): a canvas, OffscreenCanvas
// or ImageBitmap. Two small MediaPipe models (vendor/models, see vendor/LICENSES.md), both run by
// the MediaPipe runtime Line art already ships for the face landmarks:
//   deeplab_v3.tflite   2.8 MB  semantic classes (PASCAL VOC 21: person, cat, dog, bird, horse, car,
//                               bicycle, bottle, chair ...): what the subject is, and a coarse mask
//   magic_touch.tflite  6.2 MB  interactive "the object at this point" segmenter: crisp edges for any
//                               kind of thing, the user's tap override, and the sky for a skyline
// Policy: a confident deeplab subject gives the kind and the body of the mask; magic touch at its
// deepest point (the nose for a person with landmarks) gives the crisp edge: when the touch holds the
// whole subject its edge wins, else it is kept only within 4% of the deeplab mask, so a touch that
// picks just a shirt or grabs the floor cannot break the shape. A thin subject (bicycle, chair,
// motorbike) also joins clean touches inside its box. An unsure class (a moon read as a cow) lets a
// clean touch lead and names no animal. A dining table is never the subject (the cup on it is).
// No deeplab subject: magic touch at the centre, kept when it is one object (not a band from edge to
// edge; outdoors it must stand up into the sky and be fairly solid). Nothing: a landscape.
// Skyline (landscapes, and small subjects under a big sky): a colour flood from the top edge (magic
// touch on the sky when the flood fails), floating non-sky bits (clouds, the sun) lifted into the
// sky; per column, the first ground row; median + light blur keep peaks, towers and figures.
// The mask is cleaned (main component(s) at the subject, closing, holes filled, boundary smoothed at
// ~1% of the frame) and traced with marching squares.

const MP_URL = new URL('../../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href;
const MP_WASM_JS = new URL('../../vendor/mediapipe/wasm/vision_wasm_internal.js', import.meta.url).href;
const MP_WASM_BIN = new URL('../../vendor/mediapipe/wasm/vision_wasm_internal.wasm', import.meta.url).href;
const DEEPLAB = new URL('../../vendor/models/deeplab_v3.tflite', import.meta.url).href;
const TOUCH = new URL('../../vendor/models/magic_touch.tflite', import.meta.url).href;

export const SIL_GRID = 256;                 // working grid (mask resolution)
const S = SIL_GRID;
export const VOC = ['background', 'aeroplane', 'bicycle', 'bird', 'boat', 'bottle', 'bus', 'car', 'cat', 'chair', 'cow',
  'diningtable', 'dog', 'horse', 'motorbike', 'person', 'pottedplant', 'sheep', 'sofa', 'train', 'tv'];
const PERSON = 15, TABLE = 11;
const ANIMAL = new Set([3, 8, 10, 12, 13, 17]);
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149,
  150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

const now = () => performance.now();
const VENDOR_NOISE = /^INFO: |XNNPACK delegate|Unknown CPU vendor|Feedback manager|OpenGL error checking/;
function quiet(fn) {
  const err = console.error, warn = console.warn;
  const pass = f => (...a) => (VENDOR_NOISE.test(a.map(String).join(' ')) ? console.debug(...a) : f.apply(console, a));
  console.error = pass(err); console.warn = pass(warn);
  const done = () => { console.error = err; console.warn = warn; };
  let r;
  try { r = fn(); } catch (e) { done(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(done);
  done();
  return r;
}
const canvasOf = (w, h = w) => (typeof document !== 'undefined'
  ? Object.assign(document.createElement('canvas'), { width: w, height: h })
  : new OffscreenCanvas(w, h));

// In a module worker MediaPipe loads its wasm glue with import(), which leaves the script's global
// `var ModuleFactory` inside module scope ("ModuleFactory not set."). Evaluating the glue once as a
// classic script (indirect eval: global scope) sets it where MediaPipe looks.
let factoryText = null;
let workerQuiet = false;
async function ensureFactory() {
  if (typeof document !== 'undefined' || self.ModuleFactory) return;
  if (!workerQuiet) {
    // the wasm runtime keeps its own reference to console.warn / error, so quiet() cannot reach its
    // start-up notes; in a worker, filter those few lines for good (everything else passes)
    workerQuiet = true;
    for (const k of ['warn', 'error']) {
      const f = console[k];
      console[k] = (...a) => (VENDOR_NOISE.test(a.map(String).join(' ')) ? console.debug(...a) : f.apply(console, a));
    }
  }
  if (!factoryText) factoryText = await (await fetch(MP_WASM_JS)).text();
  (0, eval)(factoryText + '\n//# sourceURL=vision_wasm_internal.js');
}

let tasksPromise = null;
/** Loads both models (once). Resolves { seg, touch }. */
export function warmSilhouette() {
  if (!tasksPromise) {
    tasksPromise = (async () => {
      const mp = await import(MP_URL);
      const fileset = { wasmLoaderPath: MP_WASM_JS, wasmBinaryPath: MP_WASM_BIN };
      await ensureFactory();
      const seg = await quiet(() => mp.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: DEEPLAB, delegate: 'CPU' }, runningMode: 'IMAGE',
        outputCategoryMask: true, outputConfidenceMasks: true,
      }));
      await ensureFactory();
      const touch = await quiet(() => mp.InteractiveSegmenterLegacy.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: TOUCH, delegate: 'CPU' }, outputCategoryMask: true, outputConfidenceMasks: false,
      }));
      return { seg, touch };
    })();
    tasksPromise.catch(() => { tasksPromise = null; });
  }
  return tasksPromise;
}

// ------------------------------------------------------------------ mask helpers (S x S, 0/1)
function downsample(src, sw, sh) {           // any size 0/1 -> S x S by area average
  const out = new Uint8Array(S * S);
  if (sw === S && sh === S) { out.set(src); return out; }
  const acc = new Float32Array(S * S), cnt = new Float32Array(S * S);
  for (let y = 0; y < sh; y++) {
    const ty = Math.min(S - 1, (y * S / sh) | 0);
    for (let x = 0; x < sw; x++) { const t = ty * S + Math.min(S - 1, (x * S / sw) | 0); acc[t] += src[y * sw + x]; cnt[t]++; }
  }
  for (let i = 0; i < S * S; i++) out[i] = cnt[i] && acc[i] / cnt[i] >= 0.5 ? 1 : 0;
  return out;
}
const areaOf = m => { let a = 0; for (let i = 0; i < m.length; i++) a += m[i]; return a; };
function iou(a, b) {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; }
  return u ? i / u : 0;
}
/** Chamfer distance (px) from each 1 pixel to the nearest 0 pixel; edge0: outside the frame counts as 0. */
function distIn(m, edge0 = true) {
  const D = new Float32Array(S * S), INF = 1e6, d1 = 1, d2 = 1.4142, e = edge0 ? d1 : INF;
  for (let i = 0; i < S * S; i++) D[i] = m[i] ? INF : 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x; if (!D[i]) continue;
    let v = D[i];
    if (x > 0) v = Math.min(v, D[i - 1] + d1); else v = Math.min(v, e);
    if (y > 0) { v = Math.min(v, D[i - S] + d1); if (x > 0) v = Math.min(v, D[i - S - 1] + d2); if (x < S - 1) v = Math.min(v, D[i - S + 1] + d2); } else v = Math.min(v, e);
    D[i] = v;
  }
  for (let y = S - 1; y >= 0; y--) for (let x = S - 1; x >= 0; x--) {
    const i = y * S + x; if (!D[i]) continue;
    let v = D[i];
    if (x < S - 1) v = Math.min(v, D[i + 1] + d1); else v = Math.min(v, e);
    if (y < S - 1) { v = Math.min(v, D[i + S] + d1); if (x < S - 1) v = Math.min(v, D[i + S + 1] + d2); if (x > 0) v = Math.min(v, D[i + S - 1] + d2); } else v = Math.min(v, e);
    D[i] = v;
  }
  return D;
}
function dilate(m, r) {                       // square-free: distance from the mask <= r
  const inv = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) inv[i] = m[i] ? 0 : 1;
  const D = distIn(inv, false);               // distance of each outside pixel to the mask
  const out = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) out[i] = m[i] || D[i] <= r ? 1 : 0;
  return out;
}
function erode(m, r) {                        // the frame edge does not erode (a shape cut by it stays cut)
  const inv = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) inv[i] = m[i] ? 0 : 1;
  const d = dilate(inv, r);
  const out = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) out[i] = d[i] ? 0 : 1;
  return out;
}
/** 4-connected components: { lab Int32Array, areas[] (index = label - 1) }. */
function components(m) {
  const lab = new Int32Array(S * S), areas = [], stack = [];
  let n = 0;
  for (let s = 0; s < S * S; s++) {
    if (!m[s] || lab[s]) continue;
    n++; let a = 0; lab[s] = n; stack.push(s);
    while (stack.length) {
      const i = stack.pop(); a++;
      const x = i % S, y = (i / S) | 0;
      if (x > 0 && m[i - 1] && !lab[i - 1]) { lab[i - 1] = n; stack.push(i - 1); }
      if (x < S - 1 && m[i + 1] && !lab[i + 1]) { lab[i + 1] = n; stack.push(i + 1); }
      if (y > 0 && m[i - S] && !lab[i - S]) { lab[i - S] = n; stack.push(i - S); }
      if (y < S - 1 && m[i + S] && !lab[i + S]) { lab[i + S] = n; stack.push(i + S); }
    }
    areas.push(a);
  }
  return { lab, areas };
}
/** Keep the component at the seed (or the largest) plus any at least `frac` of its area. */
function keepMain(m, seedIdx, frac = 0.25) {
  const { lab, areas } = components(m);
  if (!areas.length) return m;
  let main = seedIdx >= 0 && lab[seedIdx] ? lab[seedIdx] : 0;
  const big = areas.indexOf(Math.max(...areas)) + 1;
  if (!main || areas[main - 1] < 0.2 * areas[big - 1]) main = big;
  const keep = new Uint8Array(areas.length + 1);
  const ref = areas[main - 1];
  keep[main] = 1;
  areas.forEach((a, k) => { if (a >= frac * ref) keep[k + 1] = 1; });
  const out = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) out[i] = keep[lab[i]];
  return out;
}
/** Fill holes (background not reachable from the frame edge) smaller than maxFrac of the frame. */
function fillHoles(m, maxFrac = 0.04) {
  const inv = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) inv[i] = m[i] ? 0 : 1;
  const { lab, areas } = components(inv);
  const edge = new Uint8Array(areas.length + 1);
  for (let k = 0; k < S; k++) { edge[lab[k]] = 1; edge[lab[(S - 1) * S + k]] = 1; edge[lab[k * S]] = 1; edge[lab[k * S + S - 1]] = 1; }
  const out = m.slice();
  for (let i = 0; i < S * S; i++) { const l = lab[i]; if (l && !edge[l] && areas[l - 1] <= maxFrac * S * S) out[i] = 1; }
  return out;
}
/** Separable Gaussian of a 0/1 mask (edge-replicated) -> Float32 field. */
function blurField(m, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(S * S), out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= S ? S - 1 : x + i; a += m[y * S + xx] * k[i + r]; }
    tmp[y * S + x] = a;
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= S ? S - 1 : y + i; a += tmp[yy * S + x] * k[i + r]; }
    out[y * S + x] = a;
  }
  return out;
}

// ------------------------------------------------------------------ marching squares
function rdp(pts, eps) {                      // pts: [[x,y],...] -> simplified (open)
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Closed iso-contours of field F (S x S) at thr, frame fractions, largest first. The field is
 *  padded with 0 so shapes cut by the frame close along its edge. */
export function traceContours(F, thr = 0.5, minFrac = 0.002) {
  const W = S + 2;
  const V = new Float32Array(W * W);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) V[(y + 1) * W + x + 1] = F[y * S + x];
  const H = (x, y) => 2 * (y * W + x), Vt = (x, y) => 2 * (y * W + x) + 1;
  const adj = new Map();
  const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  for (let y = 0; y < W - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a = V[y * W + x] > thr, b = V[y * W + x + 1] > thr, c = V[(y + 1) * W + x + 1] > thr, d = V[(y + 1) * W + x] > thr;
    const cs = (a << 3) | (b << 2) | (c << 1) | d;
    if (cs === 0 || cs === 15) continue;
    const T = H(x, y), R = Vt(x + 1, y), B = H(x, y + 1), L = Vt(x, y);
    const ctr = (V[y * W + x] + V[y * W + x + 1] + V[(y + 1) * W + x + 1] + V[(y + 1) * W + x]) / 4 > thr;
    switch (cs) {
      case 1: case 14: link(L, B); break;
      case 2: case 13: link(B, R); break;
      case 3: case 12: link(L, R); break;
      case 4: case 11: link(T, R); break;
      case 6: case 9: link(T, B); break;
      case 7: case 8: link(T, L); break;
      case 5: if (ctr) { link(T, L); link(R, B); } else { link(T, R); link(L, B); } break;
      case 10: if (ctr) { link(T, R); link(L, B); } else { link(T, L); link(R, B); } break;
    }
  }
  const pos = id => {
    const cell = id >> 1, x = cell % W, y = (cell / W) | 0;
    const v0 = V[y * W + x], v1 = id & 1 ? V[(y + 1) * W + x] : V[y * W + x + 1];
    const t = v1 === v0 ? 0.5 : Math.min(1, Math.max(0, (thr - v0) / (v1 - v0)));
    return id & 1 ? [x, y + t] : [x + t, y];
  };
  const seen = new Set(), loops = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const ids = [start]; seen.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const nb = adj.get(cur);
      const nxt = nb[0] !== prev ? nb[0] : nb[1];
      if (nxt === undefined || nxt === start || seen.has(nxt)) break;
      seen.add(nxt); ids.push(nxt); prev = cur; cur = nxt;
    }
    if (ids.length < 8) continue;
    const pts = ids.map(pos).map(([x, y]) => [Math.min(1, Math.max(0, (x - 0.5) / S)), Math.min(1, Math.max(0, (y - 0.5) / S))]);
    let ar = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) ar += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
    ar = ar / 2;
    if (Math.abs(ar) < minFrac) continue;
    loops.push({ pts, area: ar });
  }
  // outer boundaries only (positive orientation in this construction depends on the walk start, so
  // tell holes by containment: a loop inside a bigger loop is a hole of it)
  loops.sort((p, q) => Math.abs(q.area) - Math.abs(p.area));
  const inside = (p, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const outer = [];
  for (const L of loops) {
    let depth = 0;
    for (const O of loops) { if (O === L || Math.abs(O.area) <= Math.abs(L.area)) continue; if (inside(L.pts[0], O.pts)) depth++; }
    if (depth % 2 === 0) outer.push(L);
  }
  return outer.map(L => {
    // RDP on a closed loop: split at the point farthest from the start, simplify both halves
    const P = L.pts;
    let far = 0, fd = -1;
    for (let i = 1; i < P.length; i++) { const d = (P[i][0] - P[0][0]) ** 2 + (P[i][1] - P[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
    const h1 = rdp(P.slice(0, far + 1), 0.35 / S), h2 = rdp(P.slice(far).concat([P[0]]), 0.35 / S);
    const sp = h1.concat(h2.slice(1, -1));
    // clockwise in screen space (y down): positive shoelace with this sign convention
    let a = 0; for (let i = 0, j = sp.length - 1; i < sp.length; j = i++) a += (sp[j][0] - sp[i][0]) * (sp[j][1] + sp[i][1]);
    if (a < 0) sp.reverse();
    const f = new Float32Array(sp.length * 2);
    sp.forEach((p, i) => { f[i * 2] = p[0]; f[i * 2 + 1] = p[1]; });
    return f;
  });
}

// ------------------------------------------------------------------ skyline
/** Sky mask -> open polyline left to right (frame fractions): per column, the first non-sky row
 *  under the sky that reaches the top edge; median + light blur keep the peaks. */
function skylineOf(sky) {
  const ys = new Float32Array(S);
  let skyCols = 0;
  for (let x = 0; x < S; x++) {
    let y = 0;
    while (y < S && sky[y * S + x]) y++;
    ys[x] = y; if (y > 2) skyCols++;
  }
  if (skyCols < 0.6 * S) return null;
  const med = new Float32Array(S);
  for (let x = 0; x < S; x++) {
    const w = [];
    for (let k = -3; k <= 3; k++) w.push(ys[Math.min(S - 1, Math.max(0, x + k))]);
    w.sort((a, b) => a - b); med[x] = w[3];
  }
  const sm = new Float32Array(S);
  for (let x = 0; x < S; x++) {
    let a = 0, s = 0;
    for (let k = -2; k <= 2; k++) { const wt = Math.exp(-(k * k) / 2); a += wt * med[Math.min(S - 1, Math.max(0, x + k))]; s += wt; }
    sm[x] = a / s;
  }
  let mean = 0; for (const v of sm) mean += v; mean /= S;
  if (mean < 0.04 * S || mean > 0.96 * S) return null;
  const pts = [];
  for (let x = 0; x < S; x++) pts.push([(x + 0.5) / S, Math.min(1, sm[x] / S)]);
  pts[0][0] = 0; pts[S - 1][0] = 1;
  const sp = rdp(pts, 0.4 / S);
  const f = new Float32Array(sp.length * 2);
  sp.forEach((p, i) => { f[i * 2] = p[0]; f[i * 2 + 1] = p[1]; });
  return f;
}
/** Sky cleanup: whatever is not sky and does not reach the bottom edge floats (clouds the flood
 *  stopped at, the sun, birds): it joins the sky. Land and what stands on it reach the bottom. */
function floatFill(sky) {
  const inv = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) inv[i] = sky[i] ? 0 : 1;
  const { lab, areas } = components(inv);
  const ground = new Uint8Array(areas.length + 1);
  for (let x = 0; x < S; x++) ground[lab[(S - 1) * S + x]] = 1;
  const out = sky.slice();
  for (let i = 0; i < S * S; i++) if (lab[i] && !ground[lab[i]]) out[i] = 1;
  return out;
}
/** Fallback sky: flood from the top row through pixels close in colour to the top band. */
function colourSky(px) {
  const lab = new Float32Array(S * S * 3);
  for (let i = 0; i < S * S; i++) { lab[i * 3] = px[i * 4]; lab[i * 3 + 1] = px[i * 4 + 1]; lab[i * 3 + 2] = px[i * 4 + 2]; }
  const sky = new Uint8Array(S * S), stack = [];
  for (let x = 0; x < S; x++) { sky[x] = 1; stack.push(x); }
  while (stack.length) {
    const i = stack.pop(), x = i % S, y = (i / S) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
      const j = yy * S + xx;
      if (sky[j]) continue;
      const d = Math.abs(lab[j * 3] - lab[i * 3]) + Math.abs(lab[j * 3 + 1] - lab[i * 3 + 1]) + Math.abs(lab[j * 3 + 2] - lab[i * 3 + 2]);
      if (d < 14) { sky[j] = 1; stack.push(j); }
    }
  }
  return sky;
}

/** Area over convex-hull area (1 = convex). */
function solidity(m) {
  const pts = [];
  for (let y = 0; y < S; y++) {
    let a = -1, b = -1;
    for (let x = 0; x < S; x++) if (m[y * S + x]) { if (a < 0) a = x; b = x; }
    if (a >= 0) pts.push([a, y], [b + 1, y], [a, y + 1], [b + 1, y + 1]);
  }
  if (pts.length < 6) return 0;
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const hull = lo.slice(0, -1).concat(up.slice(0, -1));
  let a = 0; for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) a += (hull[j][0] + hull[i][0]) * (hull[j][1] - hull[i][1]);
  return Math.abs(a / 2) ? areaOf(m) / Math.abs(a / 2) : 0;
}

/** A landscape's forest top under the skyline: per column, the strongest step from open ground,
 *  rock or haze above to foliage below (green to autumn orange: saturated, not bright, not blue).
 *  Float32Array [x, y, ...] in frame fractions, y = -1 where a column has none; null without a
 *  forest across the view. */
function treeLine(px, sk) {
  const M = S * S, veg = new Uint8Array(M);
  let vegA = 0, greenA = 0;
  for (let i = 0; i < M; i++) {
    if (sk[i]) continue;
    const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 8 || mx > 200 || (mx - mn) / mx < 0.2) continue;
    let hue = mx === r ? 60 * (((g - b) / (mx - mn)) % 6) : mx === g ? 60 * ((b - r) / (mx - mn) + 2) : 60 * ((r - g) / (mx - mn) + 4);
    if (hue < 0) hue += 360;
    if (hue >= 18 && hue <= 170) { veg[i] = 1; vegA++; if (hue >= 60) greenA++; }
  }
  // (a forest is green at least in good part: brick, crowds and autumn-only colours are not)
  if (vegA < 0.08 * M || greenA < 0.05 * M || greenA < 0.35 * vegA) return null;
  const col = new Int32Array(S + 1), out = new Float32Array(2 * S);
  const A = Math.round(0.05 * S), B = Math.round(0.1 * S), gap = Math.round(0.04 * S);
  let found = 0;
  for (let x = 0; x < S; x++) {
    let gtop = 0;
    while (gtop < S && sk[gtop * S + x]) gtop++;
    col[0] = 0;
    for (let y = 0; y < S; y++) col[y + 1] = col[y] + veg[y * S + x];
    let best = -1, bs = 0.5;
    for (let y = gtop + gap; y < S - B; y++) {
      const ya = Math.max(gtop, y - A);
      const above = (col[y] - col[ya]) / Math.max(1, y - ya), below = (col[y + B] - col[y]) / B;
      if (below - above > bs) { bs = below - above; best = y; }
    }
    out[2 * x] = (x + 0.5) / S;
    out[2 * x + 1] = best >= 0 ? best / S : -1;
    if (best >= 0) found++;
  }
  return found > 0.35 * S ? out : null;
}

// ------------------------------------------------------------------ face parts
function polyMask(poly) {
  const m = new Uint8Array(S * S);
  let y0 = S, y1 = 0; for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(S - 1, Math.ceil(y1)); y++) {
    const xs = [], yc = y + 0.5;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > yc) !== (yj > yc)) xs.push(xi + (yc - yi) * (xj - xi) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(S - 1, Math.floor(xs[k + 1] - 0.5)); x++) m[y * S + x] = 1;
  }
  return m;
}
function faceParts(mask, lm) {
  const oval = OVAL.map(i => [lm[i * 2] * S, lm[i * 2 + 1] * S]);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [x, y] of oval) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const fw = x1 - x0, cx = (x0 + x1) / 2, chin = y1;
  const faceM = polyMask(oval);
  const face = new Uint8Array(S * S), hair = new Uint8Array(S * S), body = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) {
    if (!mask[i]) continue;
    const x = i % S, y = (i / S) | 0;
    if (faceM[i]) face[i] = 255;
    else if (y < chin - 0.05 * fw && Math.abs(x - cx) < 1.1 * fw) hair[i] = 255;
    else body[i] = 255;
  }
  const pack = d => ({ w: S, h: S, data: d });
  return { face: pack(face), hair: pack(hair), body: pack(body) };
}

// ------------------------------------------------------------------ main
const cache = new Map();
function checksum(px) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < px.length; i += 29) h = Math.imul(h ^ px[i], 16777619) >>> 0;
  return h.toString(36);
}

/**
 * frame: canvas | OffscreenCanvas | ImageBitmap (the art frame). opts: { tap: null | [x, y] frame
 * fractions (the user's "this is my subject"), kindHint: a kind to prefer when unsure,
 * landmarks: Float32Array(956) face landmarks in frame fractions (adds parts for people) }.
 */
export async function silhouette(frame, opts = {}) {
  const t0 = now();
  const timings = {};
  const small = canvasOf(S);
  const sg = small.getContext('2d', { willReadFrequently: true });
  sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
  sg.drawImage(frame, 0, 0, S, S);
  const px = sg.getImageData(0, 0, S, S).data;
  const tap = opts.tap && opts.tap.length === 2 ? [Math.min(1, Math.max(0, +opts.tap[0])), Math.min(1, Math.max(0, +opts.tap[1]))] : null;
  const key = checksum(px) + '|' + (tap ? tap.map(v => v.toFixed(3)).join(',') : '') + '|' + (opts.kindHint || '') + '|' + (opts.landmarks ? 'lm' : '');
  if (cache.has(key)) { const c = cache.get(key); return { ...c, timings: { ...c.timings, cached: true } }; }

  const { seg, touch } = await warmSilhouette();
  timings.load = Math.round(now() - t0);

  // 1. classes (deeplab)
  const t1 = now();
  const r = quiet(() => seg.segment(small));
  const cm = r.categoryMask;
  const cats = new Uint8Array(S * S);
  { // downsample() thresholds 0/1 masks; categories need the nearest value instead
    const src = cm.getAsUint8Array(), w = cm.width, h = cm.height;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) cats[y * S + x] = src[Math.min(h - 1, (y * h / S) | 0) * w + Math.min(w - 1, (x * w / S) | 0)];
  }
  const area = new Float64Array(VOC.length), confSum = new Float64Array(VOC.length);
  if (r.confidenceMasks && r.confidenceMasks.length === VOC.length) {
    const conf = r.confidenceMasks.map(m => m.getAsFloat32Array());
    const w = cm.width, h = cm.height;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = cats[y * S + x];
      area[k]++; confSum[k] += conf[k][Math.min(h - 1, (y * h / S) | 0) * w + Math.min(w - 1, (x * w / S) | 0)];
    }
  } else for (let i = 0; i < S * S; i++) { area[cats[i]]++; confSum[cats[i]] += 0.7; }
  r.close();
  timings.classes = Math.round(now() - t1);
  const M = S * S;
  const classes = [];
  for (let k = 1; k < VOC.length; k++) if (area[k] > 0.004 * M) classes.push({ k, name: VOC[k], frac: area[k] / M, conf: confSum[k] / area[k] });
  classes.sort((a, b) => b.frac * b.conf - a.frac * a.conf);
  const hintPerson = opts.kindHint === 'person' || opts.kindHint === 'portrait' || !!opts.landmarks;
  // a dining table is the surface under the subject (a cup, a plate), never the subject itself
  let subj = classes.find(c => c.k !== TABLE && c.frac >= 0.015 && c.conf >= 0.62) || null;
  if (hintPerson) { const p = classes.find(c => c.k === PERSON && c.frac >= 0.01); if (p) subj = p; }
  const tapIdx = tap ? Math.min(S - 1, (tap[1] * S) | 0) * S + Math.min(S - 1, (tap[0] * S) | 0) : -1;
  if (tap) { const k = cats[tapIdx]; subj = k ? classes.find(c => c.k === k) || { k, name: VOC[k], frac: area[k] / M, conf: confSum[k] / (area[k] || 1) } : null; }
  if (opts.kindHint === 'landscape' && !tap && subj && subj.frac < 0.12) subj = null;

  // the deeplab subject mask: its class, plus other confident classes touching it (a rider and horse)
  let dl = null;
  if (subj) {
    dl = new Uint8Array(M);
    for (let i = 0; i < M; i++) dl[i] = cats[i] === subj.k ? 1 : 0;
    const near = dilate(dl, 0.02 * S);
    for (const c of classes) {
      if (c.k === subj.k || c.conf < 0.6 || c.frac < 0.25 * subj.frac) continue;
      let touches = false;
      for (let i = 0; i < M && !touches; i++) touches = cats[i] === c.k && near[i] === 1;
      if (touches) for (let i = 0; i < M; i++) if (cats[i] === c.k) dl[i] = 1;
    }
    dl = keepMain(dl, tapIdx, 0.2);
  }

  // 2. the key point for magic touch: the tap, the subject's deepest point, or the centre
  let kp;
  if (tap) kp = tap;
  else if (dl) {
    const D = distIn(dl);
    let bi = 0; for (let i = 0; i < M; i++) if (D[i] > D[bi]) bi = i;
    if (subj.k === PERSON && opts.landmarks) kp = [opts.landmarks[4 * 2], opts.landmarks[4 * 2 + 1]]; // the nose: the head, not the shirt
    else kp = [((bi % S) + 0.5) / S, (((bi / S) | 0) + 0.5) / S];
  } else kp = [0.5, 0.5];
  const runTouch = p => {
    const tt = now();
    const res = quiet(() => touch.segment(frame, { keypoint: { x: p[0], y: p[1] } }));
    const m = res.categoryMask;
    const raw = m.getAsUint8Array(), bin = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bin[i] = raw[i] === 0 ? 1 : 0;   // the touched object is category 0
    const out = downsample(bin, m.width, m.height);
    res.close();
    timings.touch = (timings.touch || 0) + Math.round(now() - tt);
    return out;
  };
  let mt = runTouch(kp);
  // border contact: the share of the frame edge a mask covers
  const edgeShare = m => { let e = 0; for (let k = 0; k < S; k++) e += m[k] + m[(S - 1) * S + k] + m[k * S] + m[k * S + S - 1]; return e / (4 * S); };
  const inter = (a, b) => { let n = 0; for (let i = 0; i < M; i++) n += a[i] & b[i]; return n; };

  // the sky (for landscapes, and to tell a lone object in a scene from a patch of it)
  let sky = null, skySrc = '';
  const findSky = () => {
    if (sky) return sky;
    const ts = now();
    // the colour flood from the top edge follows ridges and roofs best; one magic-touch tap on the
    // sky when the flood leaks (a hazy horizon) or finds nothing
    let s = colourSky(px), f = areaOf(s) / M;
    skySrc = 'colour';
    if (f < 0.06 || f > 0.85) {
      const t = runTouch([0.5, 0.03]);
      let top = 0; for (let k = 0; k < S; k++) top += t[k];
      const ft = areaOf(t) / M;
      if (top > 0.6 * S && ft > 0.06 && ft < 0.85) { s = t; f = ft; skySrc = 'touch'; }
    }
    sky = floatFill(s);
    timings.sky = Math.round(now() - ts);
    return sky;
  };
  // how much of a mask's boundary borders the sky
  const skyContact = (m, sk) => {
    let b = 0, c = 0;
    for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      if (!m[i] || (m[i - 1] && m[i + 1] && m[i - S] && m[i + S])) continue;
      b++;
      if (sk[i - 1] | sk[i + 1] | sk[i - S] | sk[i + S] | sk[i - 2 * S + (y > 1 ? 0 : S)]) c++;
    }
    return b ? c / b : 0;
  };

  // does a mask stand up into the sky? share of its top rows with sky just left and right of it
  const pokes = (m, sk) => {
    let y0 = S, y1 = -1;
    for (let i = 0; i < M; i++) if (m[i]) { const y = (i / S) | 0; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (y1 < 0) return 0;
    const rows = Math.max(3, Math.round(0.12 * (y1 - y0 + 1)));
    let n = 0, ok = 0;
    for (let y = y0; y < Math.min(S, y0 + rows); y++) {
      let xa = -1, xb = -1;
      for (let x = 0; x < S; x++) if (m[y * S + x]) { if (xa < 0) xa = x; xb = x; }
      if (xa < 0) continue;
      n++;
      const l = xa - 3 < 0 || sk[y * S + xa - 3], r = xb + 3 >= S || sk[y * S + xb + 3];
      if (l && r) ok++;
    }
    return n ? ok / n : 0;
  };

  // 3. choose / merge
  let mask = null, kind = 'unknown', confidence = 0, why = '', altWhy = '';
  let named = null;                         // the deeplab class, when it is sure (the app says "Subject: cat")
  if (dl) {
    const dlA = areaOf(dl);
    let agree = iou(mt, dl), cov = inter(mt, dl) / dlA;
    // a touch that missed (a thin subject: a bicycle, a chair back): try the frame centre and the
    // subject's box centre, keep the one that covers the deeplab subject best without flooding
    // thin subjects (a bicycle, a chair, a motorbike): deeplab finds them in pieces; every clean touch
    // that stays inside the subject's box joins them
    const thinK = [2, 9, 14].includes(subj.k);
    const joins = [];
    let bb = null;
    if (thinK) {
      let x0 = S, x1 = 0, y0 = S, y1 = 0;
      for (let i = 0; i < M; i++) if (dl[i]) { const x = i % S, y = (i / S) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const pad = 0.03 * S; bb = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    }
    const joinable = m => {
      if (!bb) return false;
      let a = 0, inb = 0;
      for (let i = 0; i < M; i++) if (m[i]) { a++; const x = i % S, y = (i / S) | 0; if (x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3]) inb++; }
      return a > 0.01 * M && a <= 2.5 * dlA && edgeShare(m) < 0.3 && inb >= 0.85 * a;
    };
    if (joinable(mt)) joins.push(mt);
    if (!tap && agree < 0.5) {
      let bx0 = S, bx1 = 0, by0 = S, by1 = 0;
      for (let i = 0; i < M; i++) if (dl[i]) { const x = i % S, y = (i / S) | 0; bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
      const alts = [[0.5, 0.5], [(bx0 + bx1 + 1) / 2 / S, (by0 + by1 + 1) / 2 / S]].filter(p => Math.hypot(p[0] - kp[0], p[1] - kp[1]) > 0.06);
      for (const p of alts) {
        const m2 = runTouch(p), a2 = areaOf(m2);
        const cov2 = inter(m2, dl) / dlA, agree2 = iou(m2, dl);
        altWhy += ` alt(${p.map(v => v.toFixed(2))}) cov ${cov2.toFixed(2)} x${(a2 / dlA).toFixed(1)} e${edgeShare(m2).toFixed(2)}`;
        if (joinable(m2)) joins.push(m2);
        if (a2 <= 4 * dlA && edgeShare(m2) < 0.5 && cov2 > cov + 0.1 && agree2 > 0.2) { mt = m2; cov = cov2; agree = agree2; kp = p; }
      }
    }
    if (joins.length) {
      const dj = dl.slice();
      for (const m of joins) for (let i = 0; i < M; i++) dj[i] |= m[i];
      dl = dj;
      altWhy += ` · joined ${joins.length}`;
    }
    const mtA = areaOf(mt);
    if (cov >= 0.8 && mtA <= 2.5 * dlA && edgeShare(mt) < 0.6) {
      mask = new Uint8Array(M);                 // the touch holds the whole subject: its edge wins
      for (let i = 0; i < M; i++) mask[i] = dl[i] | mt[i];
    } else if (agree > 0.25) {
      const zone = dilate(dl, 0.04 * S);
      mask = new Uint8Array(M);
      for (let i = 0; i < M; i++) mask[i] = dl[i] | (mt[i] & zone[i]);
    } else mask = tap ? mt : dl;
    // the class names the kind only when deeplab is sure or the touch agrees (a moon is not a cow)
    const sure = subj.conf >= 0.8 || agree >= 0.5;
    if (!sure && !tap && mtA > 0.015 * M && mtA < 0.8 * M && edgeShare(mt) < 0.3 && cov >= 0.5) mask = mt;
    kind = !sure ? 'object' : subj.k === PERSON ? 'person' : ANIMAL.has(subj.k) ? 'animal' : 'object';
    if (sure) named = subj.name;
    confidence = Math.min(1, subj.conf * (0.55 + 0.45 * Math.min(1, Math.max(agree, cov * 0.8) / 0.7)));
    why = `${subj.name} ${Math.round(100 * subj.frac)}% c${subj.conf.toFixed(2)} · touch iou ${agree.toFixed(2)} cov ${cov.toFixed(2)}${altWhy}`;
  } else {
    const mtArea = areaOf(mt) / M;
    const es = edgeShare(mt);
    // a band from the left edge to the right one is a stretch of scenery, not an object
    let left = 0, right = 0; for (let y = 0; y < S; y++) { left += mt[y * S]; right += mt[y * S + S - 1]; }
    const band = left > 0.1 * S && right > 0.1 * S && mtArea > 0.3 && es > 0.28;
    let plausible = tap || (mtArea > 0.015 && mtArea < 0.8 && es < 0.45 && !band);
    why = `touch ${Math.round(100 * mtArea)}% edge ${es.toFixed(2)}${band ? ' band' : ''}${classes.length ? ' · dl ' + classes.slice(0, 2).map(c => `${c.name} ${Math.round(100 * c.frac)}% c${c.conf.toFixed(2)}`).join(', ') : ''}`;
    const indoor = classes.some(c => [5, 9, 11, 16, 18, 20].includes(c.k) && c.frac > 0.05);
    if (plausible && !tap && mtArea < 0.25 && !indoor) {
      // in a scene with a sky, a small touched region counts only when it stands against the sky
      const sk = findSky(), sf = areaOf(sk) / M;
      if (sf > 0.2 && sf < 0.85) {
        const sc = skyContact(mt, sk), pk = pokes(mt, sk);
        why += ` · sky contact ${sc.toFixed(2)} poke ${pk.toFixed(2)}`;
        const so = solidity(mt);
        why += ` solid ${so.toFixed(2)}`;
        if (sc < 0.15 || pk < 0.5 || so < 0.72) plausible = false;
      }
    }
    if (plausible && opts.kindHint !== 'landscape') {
      mask = mt; kind = 'object';
      confidence = tap ? 0.7 : Math.max(0.2, 0.75 - 0.8 * es - 0.4 * Math.max(0, mtArea - 0.5));
    }
  }

  // 3b. a standing structure taller than the chosen object and touching it (a lighthouse behind
  //     its keeper's house, read as a 'train'): the tallest thing standing into the sky is the subject
  let tallest = false;
  if (mask && dl && !tap && kind === 'object' && subj.conf < 0.8) {
    const sk = findSky(), sf = areaOf(sk) / M;
    if (sf > 0.2 && sf < 0.85) {
      const gy = new Int32Array(S);
      for (let x = 0; x < S; x++) { let y = 0; while (y < S && sk[y * S + x]) y++; gy[x] = y; }
      const hz = Array.from(gy).sort((a, b) => a - b)[S >> 1];
      let mTop = S;
      for (let i = 0; i < M; i++) if (mask[i]) { mTop = (i / S) | 0; break; }
      let run = null;
      for (let x = 0; x < S;) {
        if (!(gy[x] < hz - 0.2 * S && gy[x] < mTop - 0.08 * S)) { x++; continue; }
        let x1 = x, top = gy[x];
        while (x1 + 1 < S && gy[x1 + 1] < hz - 0.2 * S && gy[x1 + 1] < mTop - 0.08 * S) { x1++; top = Math.min(top, gy[x1]); }
        if (x1 - x + 1 >= 0.02 * S && x1 - x + 1 <= 0.4 * S && (!run || top < run.top)) run = { x0: x, x1, top };
        x = x1 + 1;
      }
      if (run) {
        const tp = [(run.x0 + run.x1 + 1) / 2 / S, (run.top + 0.6 * (hz - run.top)) / S];
        const m2 = runTouch(tp), a2 = areaOf(m2);
        let t2 = S, b2 = -1;
        for (let i = 0; i < M; i++) if (m2[i]) { const y = (i / S) | 0; t2 = Math.min(t2, y); b2 = Math.max(b2, y); }
        const touches = inter(dilate(m2, 0.02 * S), mask) > 0;
        if (a2 > 0.01 * M && a2 < 0.45 * M && t2 < mTop - 0.08 * S && b2 - t2 > 0.25 * S && touches) {
          for (let i = 0; i < M; i++) mask[i] |= m2[i];
          kp = tp; tallest = true;
          why += ` · taller structure at ${tp.map(v => v.toFixed(2))}`;
        } else why += ` · taller? ${tp.map(v => v.toFixed(2))} a${(a2 / M).toFixed(2)} h${((b2 - t2) / S).toFixed(2)}${touches ? '' : ' apart'}`;
      }
    }
  }

  // 4. clean: main component(s) at the subject, gaps closed and small holes filled, boundary
  //    smoothed at ~1% of the frame
  let outlines = [], F = null, clean = null, edgeFrac = 0;
  const out = new Uint8Array(M);
  if (mask) {
    const seedIdx = Math.min(S - 1, (kp[1] * S) | 0) * S + Math.min(S - 1, (kp[0] * S) | 0);
    let m = keepMain(mask, seedIdx, 0.25);
    const thin = dl && [2, 9, 14].includes(subj.k);
    const rc = Math.max(2, Math.round((thin ? 0.04 : 0.015) * S));
    m = erode(dilate(m, rc), rc);               // closing: bridges thin gaps (spokes, chair rails)
    m = keepMain(m, seedIdx, 0.25);
    m = fillHoles(m, 0.04);
    clean = m;
    F = blurField(m, 0.01 * S);
    outlines = traceContours(F, 0.5, 0.002);
    for (let i = 0; i < M; i++) out[i] = F[i] > 0.5 ? 255 : 0;
    const fa = areaOf(m) / M;
    { let b = 0, e = 0; for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = y * S + x; if (!m[i]) continue; const onE = x === 0 || y === 0 || x === S - 1 || y === S - 1; if (onE) { b++; e++; } else if (!(m[i - 1] && m[i + 1] && m[i - S] && m[i + S])) b++; } edgeFrac = b ? e / b : 0; }
    if (kind === 'person') {
      // a bust / close-up: the person is cut by the bottom edge across a good width, or the face is big
      let bottom = 0; for (let x = 0; x < S; x++) bottom += m[(S - 1) * S + x];
      let faceH = 0;
      if (opts.landmarks) { let a = 1, b = 0; for (let i = 0; i < 468; i++) { a = Math.min(a, opts.landmarks[i * 2 + 1]); b = Math.max(b, opts.landmarks[i * 2 + 1]); } faceH = b - a; }
      if (faceH > 0.2 || bottom > 0.25 * S || fa > 0.4) kind = 'portrait';
    }
    if (!outlines.length) { kind = 'unknown'; confidence = Math.min(confidence, 0.1); }
  }

  // 5. landscape / scene: a skyline when there is no subject, or only a small one
  let skyline = null, treeline = null;
  const subjFrac = areaOf(out) / 255 / M;
  const fromTouch = !dl;
  if (!mask || (!tap && ((fromTouch && kind === 'object' && subjFrac < 0.2) ||
      (dl && subjFrac < 0.1 && areaOf(findSky()) > 0.25 * M)))) {
    let sk = findSky();
    const skyFrac = areaOf(sk) / M;
    if (clean && skyFrac > 0.05 && opts.skyMerge) {
      // (off by default: floatFill already lifts floating things such as the sun; a standing object
      // such as a lighthouse or a figure stays part of the land's edge, which is how it reads)
      sk = sk.slice();
      for (let i = 0; i < M; i++) if (clean[i]) sk[i] = 1;
      sk = fillHoles(sk, 0.08);
    }
    skyline = skylineOf(sk);
    if (skyline) {
      if (!mask) { kind = 'landscape'; confidence = skySrc === 'touch' ? 0.6 : 0.45; treeline = treeLine(px, sk); }
      why += ` · sky ${skySrc} ${Math.round(100 * skyFrac)}%`;
    } else if (!mask) { kind = 'unknown'; confidence = 0.1; why += ' · no sky'; }
  }
  if (opts.kindHint && kind === 'unknown') kind = opts.kindHint;

  const result = {
    mask: { w: S, h: S, data: out },
    outlines, kind, confidence: +confidence.toFixed(3), edge: +edgeFrac.toFixed(3),
    subject: mask && kind !== 'landscape' && kind !== 'unknown' ? named : null, tapped: !!tap,
    keypoint: kp, why,
    classes: classes.slice(0, 4).map(c => ({ name: c.name, frac: +c.frac.toFixed(3), conf: +c.conf.toFixed(2) })),
    timings: { ...timings, total: Math.round(now() - t0) },
  };
  if (skyline) result.skyline = skyline;
  if (treeline) result.treeline = treeline;
  if (tallest) result.tallest = true;   // (a building: its outline carries it, few inner lines)
  if ((kind === 'person' || kind === 'portrait') && opts.landmarks && mask) {
    result.parts = faceParts(out, opts.landmarks);
    // the head alone (face + hair), for close-ups whose body runs off the frame: its outline is the
    // round crown a one-line portrait starts from
    const hm = new Uint8Array(M);
    for (let i = 0; i < M; i++) hm[i] = result.parts.face.data[i] || result.parts.hair.data[i] ? 1 : 0;
    const hc = fillHoles(keepMain(hm, -1, 0.5), 0.04);
    if (areaOf(hc) > 0.01 * M) {
      const ho = traceContours(blurField(hc, 0.012 * S), 0.5, 0.002);
      if (ho.length) result.head = ho[0];
    }
  }
  cache.set(key, result);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return result;
}
