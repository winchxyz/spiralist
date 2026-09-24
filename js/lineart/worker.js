// Line art: line map + vectoriser. Runs as a module Worker (lines.js), or in-thread when a worker
// cannot start (the same exports are imported directly).
//
// Input: an N x N RGBA raster of the crop (N ~ 512) and, when a face was found, its 478 landmarks.
//   1. line map: the Informative Drawings generator (Chan, Durand, Isola 2022; ONNX, wasm, one
//      thread: GitHub Pages cannot send COOP/COEP), or an XDoG map on the CPU when the model is
//      missing or fails.
//   2. vectorise: hysteresis threshold, Zhang-Suen thinning, direction-following trace, collinear
//      gap merge, drop short fragments, RDP + Catmull-Rom, saliency rank, landmark features forced
//      in where the model missed them, kinds from landmark groups.
// Output strokes follow js/lineart/strokes.js.
import { makeStroke } from './strokes.js';

const ORT_URL = new URL('../../vendor/ort/ort.wasm.bundle.min.mjs', import.meta.url).href;
const ORT_WASM = new URL('../../vendor/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href;
const ORT_GPU_URL = new URL('../../vendor/ort/ort.min.mjs', import.meta.url).href;            // JSEP build (WebGPU)
const ORT_GPU_MJS = new URL('../../vendor/ort/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href;
const ORT_GPU_WASM = new URL('../../vendor/ort/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href;
const MODEL_URL = new URL('../../vendor/models/informative_drawings.onnx', import.meta.url).href;

let sessionPromise = null;
let modelFailed = null;           // the last load failure (a message), cleared by a retry
let modelFailedAt = 0;
const RETRY_MS = 20000;           // a failed model load is tried again after this, or when the network returns
let inkCache = null;              // the last model output: moving the detail slider does not rerun the model

function checksum(rgba, N) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < rgba.length; i += 97) h = Math.imul(h ^ rgba[i], 16777619) >>> 0;
  return N + ':' + h;
}

/** May the model be tried (again)? A failure blocks it for RETRY_MS, or until the network is back. */
function modelAllowed() {
  if (!modelFailed) return true;
  if (Date.now() - modelFailedAt < RETRY_MS) return false;
  modelFailed = null;
  return true;
}
function markFailed(e) { modelFailed = String(e && e.message || e); modelFailedAt = Date.now(); sessionPromise = null; }
if (typeof self !== 'undefined' && self.addEventListener) {
  try { self.addEventListener('online', () => { modelFailed = null; }); } catch { /* no events here */ }
}

/** Which runtime the model will use here: 'webgpu' only when a device really opens (an adapter
 *  alone is not enough: Chromium can list an adapter whose device then fails), else 'wasm'.
 *  Resolves { backend, reason }. Probed once. */
let probePromise = null;
export function probeBackend(want = 'auto') {
  if (want === 'wasm') return Promise.resolve({ backend: 'wasm', reason: 'asked for wasm' });
  if (!probePromise) probePromise = (async () => {
    try {
      const gpu = self.navigator && navigator.gpu;
      if (!gpu) return { backend: 'wasm', reason: 'no WebGPU in this browser' };
      const adapter = await gpu.requestAdapter();
      if (!adapter) return { backend: 'wasm', reason: 'no WebGPU adapter' };
      const device = await adapter.requestDevice();
      if (!device) return { backend: 'wasm', reason: 'the WebGPU device did not open' };
      try { device.destroy(); } catch { /* fine */ }
      return { backend: 'webgpu', reason: 'WebGPU device opened' };
    } catch (e) { return { backend: 'wasm', reason: 'WebGPU device failed: ' + String(e && e.message || e) }; }
  })();
  return probePromise;
}

// the runtimes print CPU and delegate notes through console.error; they are not errors
const VENDOR_NOISE = /Unknown CPU vendor|CPU vendor|XNNPACK delegate/i;
function quietVendor(fn) {
  const err = console.error, warn = console.warn;
  const pass = f => (...a) => (VENDOR_NOISE.test(a.map(String).join(' ')) ? console.debug(...a) : f.apply(console, a));
  console.error = pass(err); console.warn = pass(warn);
  const done = () => { console.error = err; console.warn = warn; };
  return Promise.resolve().then(fn).finally(done);
}

async function sessionFor(kind, buf) {
  const ort = await import(kind === 'webgpu' ? ORT_GPU_URL : ORT_URL);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  ort.env.wasm.wasmPaths = kind === 'webgpu' ? { mjs: ORT_GPU_MJS, wasm: ORT_GPU_WASM } : { wasm: ORT_WASM };
  const session = await quietVendor(() => ort.InferenceSession.create(buf, { executionProviders: [kind], graphOptimizationLevel: 'all', logSeverityLevel: 3 }));
  return { ort, session, backend: kind };
}

// backend: 'auto' (WebGPU when a device opens, else wasm) | 'webgpu' | 'wasm'
async function loadSession(backend = 'auto') {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const probe = backend === 'wasm' ? { backend: 'wasm' } : await probeBackend(backend);
  if (probe.backend === 'webgpu') {
    try { return await sessionFor('webgpu', buf); } catch (e) {
      if (backend === 'webgpu') throw e;
      console.warn('lineart: the WebGPU line model failed, using wasm instead:', String(e && e.message || e));
    }
  }
  return sessionFor('wasm', buf);
}

/** Run the line model on an RGBA raster; returns ink (0..1, 1 = line) at N x N. */
async function modelInk(rgba, N, timings) {
  const t0 = performance.now();
  if (!sessionPromise) sessionPromise = loadSession(timings.backendWanted);
  const { ort, session, backend } = await sessionPromise;
  timings.backend = backend;
  const t1 = performance.now();
  timings.modelLoad = Math.round(t1 - t0);
  const M = N * N;
  const x = new Float32Array(3 * M);
  for (let i = 0; i < M; i++) {
    x[i] = rgba[i * 4] / 255; x[M + i] = rgba[i * 4 + 1] / 255; x[2 * M + i] = rgba[i * 4 + 2] / 255;
  }
  const out = await session.run({ input: new ort.Tensor('float32', x, [1, 3, N, N]) });
  const y = (out.output || out[session.outputNames[0]]).data;
  const ink = new Float32Array(M);
  for (let i = 0; i < M; i++) { const v = 1 - y[i]; ink[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  timings.inference = Math.round(performance.now() - t1);
  return ink;
}

/** Load (and keep) the model session without running it: the first-use warm-up. */
export async function warmModel(backend = 'auto') {
  if (!modelAllowed()) throw new Error(modelFailed);
  if (!sessionPromise) sessionPromise = loadSession(backend);
  try { const { backend: b } = await sessionPromise; return { backend: b }; }
  catch (e) { markFailed(e); throw e; }
}

// ------------------------------------------------------------------ image helpers
function lumaOf(rgba, M) {
  const L = new Float32Array(M);
  for (let i = 0; i < M; i++) L[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  return L;
}

function gauss(src, N, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(N * N), out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= N ? N - 1 : x + i; a += src[y * N + xx] * k[i + r]; }
    tmp[y * N + x] = a;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= N ? N - 1 : y + i; a += tmp[yy * N + x] * k[i + r]; }
    out[y * N + x] = a;
  }
  return out;
}

/** Fallback line map: XDoG on a pre-smoothed luma (clearly worse than the model, but it works). */
export function xdogInk(L, N) {
  const s = N / 512;
  const base = gauss(L, N, 1.2 * s);
  const g1 = gauss(base, N, 1.4 * s), g2 = gauss(base, N, 1.4 * 1.6 * s);
  const ink = new Float32Array(N * N);
  for (let i = 0; i < ink.length; i++) {
    const d = g2[i] - g1[i];                 // > 0 on the dark side of an edge and inside thin dark lines
    const t = (d - 0.006) / 0.02;
    ink[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  }
  return ink;
}

/** Sum of a 0/1 mask over a (2r+1)^2 box around every pixel. */
function boxSum(B, N, r) {
  const tmp = new Float32Array(N * N), out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    let a = 0;
    for (let x = -r; x <= r; x++) a += x >= 0 && x < N ? B[y * N + x] : 0;
    for (let x = 0; x < N; x++) {
      tmp[y * N + x] = a;
      const xo = x - r, xi = x + r + 1;
      if (xo >= 0) a -= B[y * N + xo];
      if (xi < N) a += B[y * N + xi];
    }
  }
  for (let x = 0; x < N; x++) {
    let a = 0;
    for (let y = -r; y <= r; y++) a += y >= 0 && y < N ? tmp[y * N + x] : 0;
    for (let y = 0; y < N; y++) {
      out[y * N + x] = a;
      const yo = y - r, yi = y + r + 1;
      if (yo >= 0) a -= tmp[yo * N + x];
      if (yi < N) a += tmp[yi * N + x];
    }
  }
  return out;
}

// ------------------------------------------------------------------ binarise + thin
function hysteresis(ink, N, hi, lo) {
  const B = new Uint8Array(N * N);
  const stack = [];
  for (let i = 0; i < B.length; i++) if (ink[i] >= hi) { B[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % N, y = (i / N) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
      const j = yy * N + xx;
      if (!B[j] && ink[j] >= lo) { B[j] = 1; stack.push(j); }
    }
  }
  for (let i = 0; i < N; i++) { B[i] = B[(N - 1) * N + i] = B[i * N] = B[i * N + N - 1] = 0; }
  return B;
}

function thin(B, N) {
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        if (!B[i]) continue;
        const p2 = B[i - N], p3 = B[i - N + 1], p4 = B[i + 1], p5 = B[i + N + 1];
        const p6 = B[i + N], p7 = B[i + N - 1], p8 = B[i - 1], p9 = B[i - N - 1];
        const n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (n < 2 || n > 6) continue;
        const a = (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0)
          + (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
        if (a !== 1) continue;
        if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
        del.push(i);
      }
      for (const i of del) B[i] = 0;
      if (del.length) changed = true;
    }
  }
  // drop staircase corners: a pixel with a 4-neighbour on two perpendicular sides whose diagonal is empty
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    if (!B[i]) continue;
    const n = B[i - N], e = B[i + 1], s = B[i + N], w = B[i - 1];
    const deg = n + e + s + w + B[i - N + 1] + B[i + N + 1] + B[i + N - 1] + B[i - N - 1];
    if (deg !== 2) continue;
    if ((n && e) || (e && s) || (s && w) || (w && n)) B[i] = 0;
  }
  return B;
}

// ------------------------------------------------------------------ trace
const OFF = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

function trace(B, N) {
  const vis = new Uint8Array(N * N);
  const deg = new Uint8Array(N * N);
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    if (!B[i]) continue;
    let d = 0;
    for (const [ox, oy] of OFF) d += B[i + oy * N + ox];
    deg[i] = d;
  }
  const lines = [];
  const walk = start => {
    const pts = [];
    // attach to an already traced neighbour (a junction) so branches stay connected
    const sx = start % N, sy = (start / N) | 0;
    for (const [ox, oy] of OFF) { const j = start + oy * N + ox; if (vis[j] && B[j]) { pts.push(sx + ox, sy + oy); break; } }
    pts.push(sx, sy);
    vis[start] = 1;
    let cur = start, dx = 0, dy = 0;
    for (;;) {
      const cx = cur % N, cy = (cur / N) | 0;
      let best = -1, bs = -1e9, bx = 0, by = 0;
      for (let k = 0; k < 8; k++) {
        const [ox, oy] = OFF[k];
        const j = cur + oy * N + ox;
        if (!B[j] || vis[j]) continue;
        const l = k < 4 ? 1 : Math.SQRT2;
        const sc = (dx || dy) ? (dx * ox + dy * oy) / l : (k < 4 ? 0.1 : 0);
        if (sc > bs) { bs = sc; best = j; bx = ox; by = oy; }
      }
      // at a junction, do not turn sharply into a crossing contour: stop and let that one be traced whole
      if (best >= 0 && (dx || dy) && deg[cur] >= 3 && bs < 0.6) best = -1;
      if (best < 0) {
        // end: touch a traced neighbour that is not where we came from (closes loops, joins T-junctions)
        const n = pts.length / 2;
        const px = n >= 2 ? pts[pts.length - 4] : -9, py = n >= 2 ? pts[pts.length - 3] : -9;
        for (const [ox, oy] of OFF) {
          const j = cur + oy * N + ox;
          const jx = cx + ox, jy = cy + oy;
          if (B[j] && vis[j] && !(jx === px && jy === py) && n > 3) { pts.push(jx, jy); break; }
        }
        break;
      }
      vis[best] = 1;
      pts.push(cx + bx, cy + by);
      cur = best;
      const n = pts.length / 2, b = Math.max(0, n - 5);
      dx = pts[(n - 1) * 2] - pts[b * 2]; dy = pts[(n - 1) * 2 + 1] - pts[b * 2 + 1];
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    }
    return pts;
  };
  for (let i = 0; i < B.length; i++) if (B[i] && deg[i] === 1 && !vis[i]) lines.push(walk(i));
  for (let i = 0; i < B.length; i++) if (B[i] && !vis[i]) {
    // mid-path start (loops, leftovers): walk one way, then the other way from the same pixel
    const a = walk(i);
    const b = walk2(i);
    lines.push(b.length > 2 ? joinRev(b, a) : a);
  }
  function walk2(i) {
    // the start pixel is visited now; look for another unvisited neighbour to continue the other way
    for (const [ox, oy] of OFF) {
      const j = i + oy * N + ox;
      if (B[j] && !vis[j]) { const p = walk(j); return p; }
    }
    return [];
  }
  return lines.filter(p => p.length >= 6).map(p => Float32Array.from(p));
}

function joinRev(b, a) {
  // b starts at a's start pixel (after its attach point); reverse b and prepend to a
  const out = [];
  for (let i = b.length - 2; i >= 0; i -= 2) out.push(b[i], b[i + 1]);
  // drop the duplicated start pixel
  const ax = a[0], ay = a[1];
  if (out.length >= 2 && out[out.length - 2] === ax && out[out.length - 1] === ay) out.length -= 2;
  return out.concat(a);
}

// ------------------------------------------------------------------ merge collinear gaps
function endTangent(p, atEnd) {
  const n = p.length / 2, k = Math.min(6, n - 1);
  if (atEnd) return norm(p[(n - 1) * 2] - p[(n - 1 - k) * 2], p[(n - 1) * 2 + 1] - p[(n - 1 - k) * 2 + 1]);
  return norm(p[0] - p[k * 2], p[1] - p[k * 2 + 1]);
}
function norm(x, y) { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; }

function mergeGaps(lines, gap) {
  const ends = [];
  lines.forEach((p, i) => {
    const n = p.length / 2;
    ends.push({ li: i, end: 0, x: p[0], y: p[1], t: endTangent(p, false) });
    ends.push({ li: i, end: 1, x: p[(n - 1) * 2], y: p[(n - 1) * 2 + 1], t: endTangent(p, true) });
  });
  const cand = [];
  const cell = Math.max(4, gap), G = new Map();
  ends.forEach((e, k) => { const key = ((e.x / cell) | 0) + ',' + ((e.y / cell) | 0); (G.get(key) || G.set(key, []).get(key)).push(k); });
  ends.forEach((a, ka) => {
    const cx = (a.x / cell) | 0, cy = (a.y / cell) | 0;
    for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (const kb of G.get(gx + ',' + gy) || []) {
        if (kb <= ka) continue;
        const b = ends[kb];
        if (b.li === a.li) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        if (d > gap) continue;
        const align = -(a.t[0] * b.t[0] + a.t[1] * b.t[1]);   // 1 when the two ends face each other
        if (align < 0.55) continue;
        if (d > 1.5) {
          const vx = dx / d, vy = dy / d;
          if (a.t[0] * vx + a.t[1] * vy < 0.6 || -(b.t[0] * vx + b.t[1] * vy) < 0.6) continue;
        }
        cand.push({ ka, kb, s: d + 6 * (1 - align) });
      }
    }
  });
  cand.sort((u, v) => u.s - v.s);
  const link = new Int32Array(ends.length).fill(-1);
  const parent = lines.map((_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const c of cand) {
    if (link[c.ka] >= 0 || link[c.kb] >= 0) continue;
    const ra = find(ends[c.ka].li), rb = find(ends[c.kb].li);
    if (ra === rb) continue;
    parent[ra] = rb;
    link[c.ka] = c.kb; link[c.kb] = c.ka;
  }
  // assemble chains
  const used = new Uint8Array(lines.length);
  const out = [];
  const startOf = li => {
    // walk to a free end of this chain
    let cur = li, fromEnd = 0, guard = 0;
    for (;;) {
      const k = cur * 2 + fromEnd;          // the end we would leave through going "backwards"
      const o = link[k];
      if (o < 0 || guard++ > lines.length) return { li: cur, entry: fromEnd };
      cur = ends[o].li; fromEnd = 1 - ends[o].end;
    }
  };
  for (let li = 0; li < lines.length; li++) {
    if (used[li]) continue;
    const s = startOf(li);
    let cur = s.li, entry = s.entry;
    const pts = [];
    for (let guard = 0; guard <= lines.length; guard++) {
      if (used[cur]) break;
      used[cur] = 1;
      const p = lines[cur], n = p.length / 2;
      if (entry === 0) for (let i = 0; i < n; i++) pts.push(p[i * 2], p[i * 2 + 1]);
      else for (let i = n - 1; i >= 0; i--) pts.push(p[i * 2], p[i * 2 + 1]);
      const exitEnd = 1 - entry;
      const o = link[cur * 2 + exitEnd];
      if (o < 0) break;
      cur = ends[o].li; entry = ends[o].end;
    }
    out.push(Float32Array.from(pts));
  }
  return out;
}

// ------------------------------------------------------------------ simplify + smooth
function rdp(p, eps) {
  const n = p.length / 2;
  if (n < 3) return p;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const st = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      // a closed loop has coincident ends: measure from the end point, not from a zero-length chord
      const d = l < 1e-6 ? Math.hypot(p[i * 2] - ax, p[i * 2 + 1] - ay) : Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / l;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return Float32Array.from(out);
}

/** Centripetal Catmull-Rom through the points, resampled about every `step` units. */
export function catmull(p, step, closed = false) {
  const n = p.length / 2;
  if (n < 3) return p;
  const P = i => {
    if (closed) { const k = ((i % n) + n) % n; return [p[k * 2], p[k * 2 + 1]]; }
    if (i < 0) return [2 * p[0] - p[2], 2 * p[1] - p[3]];
    if (i >= n) return [2 * p[(n - 1) * 2] - p[(n - 2) * 2], 2 * p[(n - 1) * 2 + 1] - p[(n - 2) * 2 + 1]];
    return [p[i * 2], p[i * 2 + 1]];
  };
  const out = [p[0], p[1]];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const d1 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(1, Math.ceil(d1 / step));
    const t01 = Math.pow(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1e-4, 0.5);
    const t12 = Math.pow(d1 || 1e-4, 0.5);
    const t23 = Math.pow(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]) || 1e-4, 0.5);
    for (let j = 1; j <= m; j++) {
      const t = j / m;
      const out2 = [0, 0];
      for (let c = 0; c < 2; c++) {
        const m1 = (p2[c] - p1[c] + t12 * ((p1[c] - p0[c]) / t01 - (p2[c] - p0[c]) / (t01 + t12)));
        const m2 = (p2[c] - p1[c] + t12 * ((p3[c] - p2[c]) / t23 - (p3[c] - p1[c]) / (t12 + t23)));
        const a = 2 * p1[c] - 2 * p2[c] + m1 + m2, b = -3 * p1[c] + 3 * p2[c] - 2 * m1 - m2;
        out2[c] = ((a * t + b) * t + m1) * t + p1[c];
      }
      out.push(out2[0], out2[1]);
    }
  }
  return Float32Array.from(out);
}

function polyLen(p) {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
}

// ------------------------------------------------------------------ face landmark features
// MediaPipe Face Mesh indices (478-point model). Right/left are the subject's.
const IDX = {
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  eyeRUp: [33, 246, 161, 160, 159, 158, 157, 173, 133], eyeRLo: [33, 7, 163, 144, 145, 153, 154, 155, 133],
  eyeLUp: [263, 466, 388, 387, 386, 385, 384, 398, 362], eyeLLo: [263, 249, 390, 373, 374, 380, 381, 382, 362],
  browRUp: [70, 63, 105, 66, 107], browRLo: [46, 53, 52, 65, 55],
  browLUp: [300, 293, 334, 296, 336], browLLo: [276, 283, 282, 295, 285],
  lipInUp: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308], lipInLo: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
  lipOutUp: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291], lipOutLo: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
  noseBridge: [168, 6, 197, 195, 5, 4], noseBase: [98, 97, 2, 326, 327], noseTip: [4, 1, 19, 94, 2],
  alarR: [48, 64, 98], alarL: [278, 294, 327],
  irisR: [469, 470, 471, 472], irisL: [474, 475, 476, 477],
};

function lmPts(lm, idx, N) { return idx.map(i => [lm[i * 2] * N, lm[i * 2 + 1] * N]); }
function avgCurves(a, b) { return a.map((p, i) => [(p[0] + b[i][0]) / 2, (p[1] + b[i][1]) / 2]); }
const flat = pts => { const f = new Float32Array(pts.length * 2); pts.forEach((p, i) => { f[i * 2] = p[0]; f[i * 2 + 1] = p[1]; }); return f; };

/** Feature curves (px) a line artist would draw for this face, with their kinds. */
function faceFeatures(lm, N, darkAt) {
  const P = idx => lmPts(lm, idx, N);
  const feats = [];
  const add = (kind, pts, closed = false, name = kind) => feats.push({ kind, name, pts, closed });
  add('eye', P(IDX.eyeRUp), false, 'eyeRUp'); add('eye', P(IDX.eyeLUp), false, 'eyeLUp');
  add('eye', P(IDX.eyeRLo), false, 'eyeRLo'); add('eye', P(IDX.eyeLLo), false, 'eyeLLo');
  add('brow', avgCurves(P(IDX.browRUp), P(IDX.browRLo)), false, 'browR');
  add('brow', avgCurves(P(IDX.browLUp), P(IDX.browLLo)), false, 'browL');
  // the lips' meeting line
  add('lips', avgCurves(P(IDX.lipInUp), P(IDX.lipInLo)).map((p, i, a) => (i === 0 ? P([61])[0] : i === a.length - 1 ? P([291])[0] : p)), false, 'lipsMeet');
  add('lips', P(IDX.lipOutLo).slice(2, 9), false, 'lipLower');
  // irises: a small ring
  for (const [name, ring, c] of [['irisR', IDX.irisR, 468], ['irisL', IDX.irisL, 473]]) {
    const cx = lm[c * 2] * N, cy = lm[c * 2 + 1] * N;
    const r = P(ring).reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / 4 * 0.8;
    const pts = [];
    for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    add('iris', pts, true, name);
  }
  // the nose: one side (the darker one) down from the bridge to the nostril wing, plus the base
  const bridge = P(IDX.noseBridge), base = P(IDX.noseBase);
  const sideR = darkAt(P([64])[0]) >= darkAt(P([294])[0]);
  const wing = sideR ? P(IDX.alarR) : P(IDX.alarL);
  const off = (sideR ? -1 : 1) * Math.hypot(base[4][0] - base[0][0], base[4][1] - base[0][1]) * 0.18;
  const side = bridge.slice(1, 5).map((p, i) => [p[0] + off * (0.5 + i * 0.25), p[1]]);
  add('nose', side.concat(wing.slice(1)), false, 'noseSide');
  add('nose', sideR ? base.slice(0, 3) : base.slice(2).reverse(), false, 'nostril');
  // the jaw: the lower half of the oval, ear to ear through the chin
  const oval = P(IDX.oval);
  add('jaw', oval.slice(13, 24), false, 'jaw');
  add('jaw', oval.slice(6, 31), false, 'jawFull');       // for kinds only, never forced
  return feats;
}

// ------------------------------------------------------------------ main
/**
 * msg: { rgba: Uint8ClampedArray (N*N*4), N, detail, engine: 'auto'|'model'|'xdog', landmarks?: Float32Array(478*2) }
 * returns { strokes, features, timings, engine, debug? }
 */
export async function runLines(msg) {
  const { rgba, N } = msg;
  const detail = Math.min(1, Math.max(0, msg.detail ?? 0.5));
  const timings = { backendWanted: msg.backend || 'auto' };
  const M = N * N;
  const L = lumaOf(rgba, M);
  let ink = null, engine = 'xdog';
  const key = checksum(rgba, N);
  if (msg.ink && msg.ink.length === M) { ink = msg.ink; engine = 'model'; timings.cached = true; inkCache = { key, ink }; }   // dev: a saved line map
  if (!ink && msg.engine !== 'xdog' && inkCache && inkCache.key === key) { ink = inkCache.ink; engine = 'model'; timings.cached = true; }
  if (!ink && msg.engine !== 'xdog' && modelAllowed()) {
    try { ink = await modelInk(rgba, N, timings); engine = 'model'; inkCache = { key, ink }; }
    catch (e) { markFailed(e); }
  }
  const tv = performance.now();
  if (!ink) ink = xdogInk(L, N);
  if (engine === 'xdog') timings.xdog = Math.round(performance.now() - tv);
  const t0 = performance.now();

  const Ls = gauss(L, N, 2 * N / 512);
  const darkAtPx = (x, y) => { const xi = Math.min(N - 1, Math.max(0, x | 0)), yi = Math.min(N - 1, Math.max(0, y | 0)); return 1 - Ls[yi * N + xi]; };
  const darkAt = p => darkAtPx(p[0], p[1]);

  // face geometry (px)
  const lm = msg.landmarks || null;
  let face = null;
  if (lm) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < 468; i++) { const x = lm[i * 2] * N, y = lm[i * 2 + 1] * N; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    face = { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) };
    face.feats = faceFeatures(lm, N, darkAt);
    const noseTip = lm[1 * 2 + 1] * N;
    face.noseY = noseTip;
    face.browY = (lm[105 * 2 + 1] + lm[334 * 2 + 1]) / 2 * N;
    face.eyeY = (lm[159 * 2 + 1] + lm[386 * 2 + 1]) / 2 * N;
    face.mouthY = lm[13 * 2 + 1] * N;
  }

  // binarise, thin, trace
  const B = hysteresis(ink, N, engine === 'model' ? 0.4 : 0.5, engine === 'model' ? 0.15 : 0.22);
  thin(B, N);
  // texture: how much skeleton surrounds each pixel (a lone contour ~1, fur stripes / hatching 3+)
  const Rd = Math.round(16 * N / 512);
  const dens = boxSum(B, N, Rd);
  const densNorm = 2 * Rd + 1;
  const densAt = (x, y) => { const xi = x | 0, yi = y | 0; return xi < 0 || yi < 0 || xi >= N || yi >= N ? 0 : dens[yi * N + xi]; };
  // the face oval shrunk toward its centre: the cheeks and forehead, where a stroke is modelling, not contour
  let insideOval = () => false;
  if (face) {
    const ov = IDX.oval.map(i => [lm[i * 2] * N, lm[i * 2 + 1] * N]);
    const cx = ov.reduce((a, p) => a + p[0], 0) / ov.length, cy = ov.reduce((a, p) => a + p[1], 0) / ov.length;
    const poly = ov.map(p => [cx + (p[0] - cx) * 0.86, cy + (p[1] - cy) * 0.86]);
    insideOval = (x, y) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
  }
  let lines = trace(B, N);
  lines = mergeGaps(lines, 10 * N / 512);

  // classify + score
  const s512 = N / 512;
  const minLen = (34 - 24 * detail) * s512;
  const featPts = face ? face.feats.flatMap(f => f.pts.map(p => ({ x: p[0], y: p[1], kind: f.kind }))) : [];
  const nearR = face ? face.size * 0.045 : 0;
  const roi = (x, y) => {
    if (face) {
      // head + hair + neck: generous box around the face; background clutter is penalised outside it
      const ex = face.w * 0.95, eyTop = face.h * 0.9, eyBot = face.h * 0.7;
      const inX = x > face.x0 - ex && x < face.x1 + ex, inY = y > face.y0 - eyTop && y < face.y1 + eyBot;
      return inX && inY ? 1 : 0.3;
    }
    const d = Math.hypot(x / N - 0.5, y / N - 0.5);
    return d < 0.47 ? 1 : Math.max(0.5, 1 - (d - 0.47) * 3);
  };
  const cands = [], smalls = [];      // smalls: short lines kept aside for an animal's nose and mouth
  for (const raw of lines) {
    const len = polyLen(raw);
    if (len < (face ? minLen * 0.6 : Math.min(minLen * 0.6, 10 * N / 512))) continue;
    const n = raw.length / 2;
    let str = 0, rsum = 0, dk = 0, near = 0, tex = 0, interior = 0;
    const votes = {};
    for (let i = 0; i < n; i++) {
      const x = raw[i * 2], y = raw[i * 2 + 1];
      str += ink[(y | 0) * N + (x | 0)];
      {
        const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
        let tx = raw[b * 2] - raw[a * 2], ty = raw[b * 2 + 1] - raw[a * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const o = Rd * 0.9;
        const dA = densAt(x - ty * o, y + tx * o), dB = densAt(x + ty * o, y - tx * o);
        tex += Math.min(dA, dB) / densNorm;
        if (face && insideOval(x, y)) interior++;
      }
      rsum += roi(x, y);
      dk += darkAtPx(x, y);
      if (face) {
        let bd = nearR, bk = null;
        for (const f of featPts) { const d = Math.abs(f.x - x) + Math.abs(f.y - y); if (d < bd) { bd = d; bk = f.kind; } }
        if (bk) { near++; votes[bk] = (votes[bk] || 0) + 1; }
      }
    }
    str /= n; rsum /= n; dk /= n; tex /= n; interior /= n;
    const prox = face ? near / n : 0;
    // skin texture: short, weak marks inside the face that do not sit on a feature
    let inFace = false;
    if (face) {
      const mx = raw[(n >> 1) * 2], my = raw[(n >> 1) * 2 + 1];
      inFace = mx > face.x0 + face.w * 0.12 && mx < face.x1 - face.w * 0.12 && my > face.y0 + face.h * 0.12 && my < face.y1 - face.h * 0.1;
    }
    if (inFace && prox < 0.3 && len < face.size * 0.35) continue;
    const small = len < minLen;
    if (small && face) continue;
    let kind = 'detail';
    if (face) {
      let bk = null, bv = 0;
      for (const k in votes) if (votes[k] > bv) { bv = votes[k]; bk = k; }
      const mx = raw.reduce((s, v, i) => (i % 2 ? s : s + v), 0) / n;
      const my = raw.reduce((s, v, i) => (i % 2 ? s + v : s), 0) / n;
      if (bk && bv / n > 0.35) kind = bk === 'jaw' ? (my > face.noseY ? 'jaw' : 'outline') : bk;
      else if (len > face.size * 0.8) kind = 'outline';
      else if (my < face.browY && mx > face.x0 - face.w * 0.5 && mx < face.x1 + face.w * 0.5) kind = 'hair';
      else if (len < face.size * 0.6 && my > face.browY && my < face.mouthY && (mx < face.x0 + face.w * 0.08 || mx > face.x1 - face.w * 0.08) && (mx > face.x0 - face.w * 0.4 && mx < face.x1 + face.w * 0.4)) kind = 'ear';
      else kind = rsum > 0.6 ? 'detail' : 'other';
    }
    // surround suppression: contours inside dense texture (fur, stripes, foliage) matter less
    // compact curved shapes (eyes, pupils, nostrils, curls) read as features even inside texture
    let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
    for (let i = 0; i < n; i++) { const x = raw[i * 2], y = raw[i * 2 + 1]; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    const compact = Math.hypot(bx1 - bx0, by1 - by0) / Math.max(1e-6, len) < 0.6 && len < N * 0.5;
    const inhibit = compact ? 1.3 : 1 / (1 + 1.2 * Math.max(0, tex - 1.25));
    const n0 = raw.length / 2;
    const loop = n0 > 8 && len > 40 * s512 && Math.hypot(raw[0] - raw[(n0 - 1) * 2], raw[1] - raw[(n0 - 1) * 2 + 1]) < 10 * s512 ? 1.6 : 1;
    // inside the face, away from the features: shadow edges and modelling, which line artists leave out
    const cheek = face ? 1 - 0.75 * Math.max(0, interior - prox) : 1;
    const score = Math.pow(len / N, 0.6) * Math.pow(0.25 + str, 1.2) * (1 + 4 * prox) * rsum * inhibit * loop * cheek;
    // a short wiggle inside fur or foliage is texture, not a contour: a line artist never draws it
    if (small || (!face && !compact && len < 0.07 * N && tex > 1.1)) { if (!face) smalls.push({ raw, len, str, dark: dk, kind, score, prox, tex }); continue; }
    cands.push({ raw, len, str, dark: dk, kind, score, prox, tex });
  }
  // outline for faceless images: the longest strong strokes
  cands.sort((a, b) => b.score - a.score);
  // an animal's face: two compact, near-equal shapes side by side (its eyes), with the nose and
  // mouth in the triangle below them. They are the lines that make it read, at any detail.
  // (fur all over: many of the lines sit in dense texture; a moon's maria or a logo never do)
  const all0 = cands.concat(smalls), furFrac = all0.length ? all0.filter(c => c.tex > 1.0).length / all0.length : 0;
  const animal = face || furFrac < 0.3 ? null : animalFace(cands, N, s512, smalls);
  if (!face) cands.forEach((c, i) => { if (!c.feature && (i < 3 || c.len > N * 0.6)) c.kind = 'outline'; });

  const keepN = Math.round(6 + 34 * Math.pow(detail, 1.3));
  const budget = (3.5 + 10 * detail) * N;          // total line length a quick drawing allows
  const kept = [];
  let total = 0;
  if (animal) for (const c of animal.feats) { kept.push(c); total += c.len; }
  for (const c of cands) {
    if (kept.length >= keepN) break;
    if (c.feature) continue;
    if (total + c.len > budget && kept.length >= 4) continue;
    kept.push(c); total += c.len;
  }

  // a few hair strands: line artists give the hair two to six lines, and the texture
  // suppression above would otherwise leave every head bald
  if (face) {
    const want = Math.round(2 + 4 * detail);
    let have = kept.filter(c => c.kind === 'hair').length;
    for (const c of cands) {
      if (have >= want) break;
      if (c.kind !== 'hair' || kept.includes(c) || c.len < face.size * 0.15) continue;
      kept.push(c); have++;
    }
  }

  // landmark features the model missed: add them as clean curves
  const forced = [];
  if (face) {
    const R = Math.max(2, face.size * 0.03);
    const cover = new Uint8Array(M);
    const stamp = (x, y) => {
      const r = Math.ceil(R);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = (x | 0) + dx, yy = (y | 0) + dy;
        if (xx >= 0 && yy >= 0 && xx < N && yy < N && dx * dx + dy * dy <= R * R) cover[yy * N + xx] = 1;
      }
    };
    for (const c of kept) for (let i = 0; i < c.raw.length; i += 2) stamp(c.raw[i], c.raw[i + 1]);
    const want = detail < 0.35 ? ['eyeRUp', 'eyeLUp', 'browR', 'browL', 'lipsMeet', 'noseSide', 'jaw', 'irisR', 'irisL']
      : detail < 0.7 ? ['eyeRUp', 'eyeLUp', 'eyeRLo', 'eyeLLo', 'browR', 'browL', 'lipsMeet', 'noseSide', 'nostril', 'jaw', 'irisR', 'irisL']
        : ['eyeRUp', 'eyeLUp', 'eyeRLo', 'eyeLLo', 'browR', 'browL', 'lipsMeet', 'lipLower', 'noseSide', 'nostril', 'jaw', 'irisR', 'irisL'];
    for (const f of face.feats) {
      if (!want.includes(f.name)) continue;
      // sample the curve densely
      const sm = catmull(flat(f.pts), 2 * s512, f.closed);
      let hit = 0, n = sm.length / 2;
      for (let i = 0; i < n; i++) { const x = sm[i * 2] | 0, y = sm[i * 2 + 1] | 0; if (x >= 0 && y >= 0 && x < N && y < N && cover[y * N + x]) hit++; }
      if (hit / n < 0.5) {
        let dk = 0; for (let i = 0; i < n; i++) dk += darkAtPx(sm[i * 2], sm[i * 2 + 1]);
        forced.push({ raw: sm, len: polyLen(sm), str: 1, dark: dk / n, kind: f.kind, score: 0, prox: 1, closed: f.closed, forced: true, name: f.name });
      }
    }
  }

  if (face) {
    const t = performance.now();
    const hair = hairStrands(lm, N, Ls, face, detail, s512, darkAtPx);
    // the synthetic strands replace most of the model's hair fragments (keep its two longest)
    if (hair.length) {
      const mh = kept.filter(c => c.kind === 'hair').sort((a, b) => b.len - a.len);
      // (a long one is the skull's own outline, classed as hair because it runs above the brow: kept)
      for (const c of mh.slice(2)) if (c.len < 0.5 * face.size) kept.splice(kept.indexOf(c), 1);
      forced.push(...hair);
    }
    timings.hair = Math.round(performance.now() - t);
  }

  // fur and manes without a face: a few of the longest texture lines the ranking passed over,
  // calmed into strands (drawn as 'hair': a few confident flicks, never jaggies). Only on an
  // animal (its eyes were found): on a landscape the same texture is trees and grass, not fur.
  if (!face && animal) {
    const want = Math.round(1 + 3 * detail);
    const fur = cands.filter(c => !kept.includes(c) && c.tex > 1.0 && c.len > 0.09 * N && c.str > 0.35)
      .sort((a, b) => b.len * b.str - a.len * a.str);
    let got = 0;
    for (const c of fur) {
      if (got >= want) break;
      // not on top of a line already kept
      const mx = c.raw[(c.raw.length >> 2) << 1], my = c.raw[((c.raw.length >> 2) << 1) + 1];
      if (kept.some(k => { for (let i = 0; i < k.raw.length; i += 8) if (Math.abs(k.raw[i] - mx) + Math.abs(k.raw[i + 1] - my) < 6 * s512) return true; return false; })) continue;
      const sm = catmull(rdp(smoothPts(c.raw, 5 * s512), 1.6 * s512), 2.5 * s512, false);
      forced.push({ raw: sm, len: polyLen(sm), str: c.str, dark: c.dark, kind: 'hair', score: 0, prox: 0, closed: false, forced: true, name: 'fur', sal: 0.5 });
      got++;
    }
  }

  // simplify, smooth, normalise
  const all = kept.concat(forced);
  const maxScore = Math.max(1e-9, ...kept.map(c => c.score));
  // a scene (no face, no animal: a landscape, a moon, a still life) has no features to organise
  // it; its character is in the silhouettes, so they keep their corners
  const scene = !face && !animal;
  const strokes = all.map((c, ci) => {
    const featureKind = c.kind === 'eye' || c.kind === 'iris' || c.kind === 'lips' || c.kind === 'nose' || c.kind === 'brow';
    const texF = featureKind ? 0 : Math.min(1, Math.max(0, ((c.tex || 0) - 0.8) / 1.0));
    const sig = (featureKind ? 0.8 : face ? 1.4 + 2 * texF : 1.8 + 3.2 * texF) * s512;
    let p;
    if (c.forced) p = c.raw;
    else if (!face && !featureKind && (texF < 0.35 || (scene && texF < 0.9))) {
      // a clean contour without a face (a ridge, a rim, a horizon, a tree line): corner-keeping
      // simplification. The tremor under ~2.5 px goes, the peaks stay as vertices the smooth
      // curve passes through
      let q0 = scene ? staggerEnds(c.raw, N, ci) : c.raw;
      q0 = smoothPts(q0, (1.0 + 0.8 * texF) * s512);
      if (scene) q0 = relief(q0, N, s512);
      p = rdp(q0, 2.5 * s512);
    } else p = rdp(smoothPts(c.raw, sig), (0.9 + 1.4 * texF) * s512);
    let closed = !!c.closed;
    const n = p.length / 2;
    if (!c.forced && n > 4 && Math.hypot(p[0] - p[(n - 1) * 2], p[1] - p[(n - 1) * 2 + 1]) < 10 * s512 && c.len > 40 * s512) closed = true;
    if (!c.forced) p = catmull(p, 2.5 * s512, false);
    const q = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) q[i] = Math.min(1, Math.max(0, p[i] / N));
    const sal = c.forced || c.feature ? (c.sal ?? 0.85) : Math.min(1, 0.15 + 0.85 * Math.sqrt(c.score / maxScore));
    return makeStroke(q, { closed, saliency: sal, kind: c.kind, dark: Math.min(1, Math.max(0, c.dark)) });
  });

  // darkness grid for optional hatching
  const DG = 64, dark = new Float32Array(DG * DG), cellPx = N / DG;
  for (let y = 0; y < DG; y++) for (let x = 0; x < DG; x++) {
    let s = 0, c = 0;
    for (let yy = Math.floor(y * cellPx); yy < Math.floor((y + 1) * cellPx); yy++)
      for (let xx = Math.floor(x * cellPx); xx < Math.floor((x + 1) * cellPx); xx++) { s += 1 - L[yy * N + xx]; c++; }
    dark[y * DG + x] = s / Math.max(1, c);
  }
  timings.vectorise = Math.round(performance.now() - t0);

  const features = {
    face: face ? { box: { x: face.x0 / N, y: face.y0 / N, w: face.w / N, h: face.h / N }, landmarks: lm } : null,
    dark: { w: DG, h: DG, data: dark },
  };
  const out = { strokes, features, timings, engine, modelError: modelFailed, stats: { raw: lines.length, candidates: cands.length, kept: kept.length, forced: forced.map(f => f.name), furFrac: +furFrac.toFixed(3), animal: !!animal } };
  if (msg.debugInk) out.ink = ink.slice();
  if (msg.debugAll) out.all = lines.map(p => { const q = new Float32Array(p.length); for (let i = 0; i < p.length; i++) q[i] = p[i] / N; return q; });
  return out;
}

/** An animal's eyes (two compact, near-equal contours side by side in the upper part of the frame)
 *  and the nose and mouth in the triangle below them. Marks the chosen candidates (kind 'eye',
 *  'nose', 'lips', feature = true) and returns { feats } or null. Eyes drawn as an open C whose
 *  gap is small are closed, so both eyes get the same construction. */
function animalFace(cands, N, s512, smalls = []) {
  const info = cands.concat(smalls).map(c => {
    const p = c.raw, n = p.length / 2;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, mx = 0, my = 0;
    for (let i = 0; i < n; i++) { const x = p[2 * i], y = p[2 * i + 1]; mx += x; my += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const size = Math.max(x1 - x0, y1 - y0), diag = Math.hypot(x1 - x0, y1 - y0);
    const gap = Math.hypot(p[0] - p[2 * n - 2], p[1] - p[2 * n - 1]);
    return { c, cx: mx / n, cy: my / n, size, round: diag / Math.max(1e-6, c.len), gap, aspect: (x1 - x0) / Math.max(1, y1 - y0) };
  });
  const eyeish = info.filter(e => e.size > 0.025 * N && e.size < 0.16 * N && e.round < 0.75 && e.cy < 0.72 * N
    && e.aspect > 0.5 && e.aspect < 2.6 && e.c.len < 0.5 * N);
  let best = null;
  for (let i = 0; i < eyeish.length; i++) for (let j = i + 1; j < eyeish.length; j++) {
    const a = eyeish[i], b = eyeish[j];
    const s = (a.size + b.size) / 2, r = Math.max(a.size, b.size) / Math.min(a.size, b.size);
    const dx = Math.abs(a.cx - b.cx), dy = Math.abs(a.cy - b.cy);
    if (r > 1.8 || dy > 0.6 * s || dx < 1.3 * s || dx > 6 * s) continue;
    const sc = (a.c.str + b.c.str) * (1 / r) * (1 - dy / s * 0.5);
    if (!best || sc > best.sc) best = { a, b, sc, s, dx };
  }
  if (!best) return null;
  const [L, R] = best.a.cx < best.b.cx ? [best.a, best.b] : [best.b, best.a];
  const feats = [];
  for (const e of [L, R]) {
    e.c.kind = 'eye'; e.c.feature = true; e.c.sal = 0.9;
    // one construction for both eyes: a C with a small gap is drawn closed
    if (e.gap < 0.3 * e.c.len && e.gap < 0.6 * e.size) e.c.closed = true;
    feats.push(e.c);
  }
  // the muzzle: the triangle from just under each eye down to the chin point below their middle
  const mx = (L.cx + R.cx) / 2, my = (L.cy + R.cy) / 2, d = R.cx - L.cx;
  const T = [[L.cx, my + 0.15 * d], [R.cx, my + 0.15 * d], [mx, my + 1.25 * d]];
  const inTri = (x, y) => {
    const s = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
    const d1 = s(T[0], T[1]), d2 = s(T[1], T[2]), d3 = s(T[2], T[0]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const muzzle = info.filter(e => !e.c.feature && inTri(e.cx, e.cy) && e.c.len > 0.02 * N && e.c.len < 0.6 * d * 3 && e.size < 1.2 * d)
    .sort((a, b) => b.c.str * b.c.len - a.c.str * a.c.len).slice(0, 3)
    .sort((a, b) => a.cy - b.cy);
  muzzle.forEach((e, k) => { e.c.kind = k === 0 ? 'nose' : 'lips'; e.c.feature = true; e.c.sal = 0.85; feats.push(e.c); });
  return { feats, eyes: [[L.cx, L.cy], [R.cx, R.cy]] };
}

/** A long, low line across a scene (a ridge, a horizon, a shore): the way a landscape artist draws
 *  it, with its peaks and dips told a little bigger than the photo has them (the model's line
 *  map flattens a far ridge into a gentle wave; ruled parallel waves read as lined paper). */
function relief(p, N, s512) {
  const n = p.length / 2;
  if (n < 30) return p;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < n; i++) { const x = p[2 * i], y = p[2 * i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const w = x1 - x0, h = y1 - y0;
  if (w < 0.25 * N || h > 0.3 * w) return p;
  // the mountain's own shape (the peaks and saddles, 40-150 px) grows; the even ripple of the
  // model's ridge texture (under ~15 px) is calmed, so it reads as a range, not as waves
  const base = smoothPts(p, 40 * s512), mid = smoothPts(p, 5 * s512);
  const out = new Float32Array(p.length);
  for (let i = 0; i < n; i++) {
    // fade the gain in from the ends (they stay where the photo has them)
    const e = Math.min(1, Math.min(i, n - 1 - i) / (30 * s512));
    const y = base[2 * i + 1] + (mid[2 * i + 1] - base[2 * i + 1]) * (1 + 1.6 * e) + (p[2 * i + 1] - mid[2 * i + 1]) * (1 - 0.5 * e);
    out[2 * i] = p[2 * i];
    out[2 * i + 1] = Math.min(N - 1, Math.max(0, y));
  }
  return out;
}

/** A scene's lines that run out of the photo all end on its border, one under the other like a
 *  ruled margin; an artist stops each a different distance short of the edge. */
function staggerEnds(p, N, seed) {
  const n = p.length / 2;
  if (n < 40) return p;
  const edge = (x, y) => x < 0.03 * N || x > 0.97 * N || y < 0.03 * N || y > 0.97 * N;
  let a = 0, b = n - 1;
  const cut = (from, dir, k) => {
    const h = ((Math.imul(seed * 2 + k + 1, 0x9e3779b1) >>> 0) % 1000) / 1000;
    const want = (0.03 + 0.11 * h) * N;
    let L = 0, i = from;
    while (L < want && i + dir >= 0 && i + dir < n) { L += Math.hypot(p[2 * (i + dir)] - p[2 * i], p[2 * (i + dir) + 1] - p[2 * i + 1]); i += dir; }
    return i;
  };
  if (edge(p[0], p[1])) a = cut(0, 1, 0);
  if (edge(p[2 * n - 2], p[2 * n - 1])) b = cut(n - 1, -1, 1);
  if (b - a < 0.55 * n) return p;
  return p.slice(2 * a, 2 * b + 2);
}

/** Gaussian smoothing along a pixel polyline (ends held), sigma in px of arc (points ~1 px apart). */
function smoothPts(p, sigma) {
  const n = p.length / 2;
  if (n < 5 || sigma < 0.5) return p;
  const R = Math.min(Math.ceil(2.5 * sigma), (n >> 1) - 1), w = [];
  for (let k = -R; k <= R; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out = new Float32Array(p.length);
  const closed = n > 12 && Math.hypot(p[0] - p[2 * n - 2], p[1] - p[2 * n - 1]) < 3;
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sw = 0;
    // near an open end the window shrinks symmetrically, so the end stays put
    const r = closed ? R : Math.min(R, i, n - 1 - i);
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (closed) j = (j + n) % n;
      const ww = w[k + R];
      sx += p[2 * j] * ww; sy += p[2 * j + 1] * ww; sw += ww;
    }
    out[2 * i] = sx / sw; out[2 * i + 1] = sy / sw;
  }
  return out;
}

/** A few confident hair lines, the way a line artist gives a head its hair: 1-5 long strands that
 *  follow the hair's own flow (the structure tensor of the photo) from the crown down over the
 *  head. All in px; returned as forced 'hair' candidates. */
function hairStrands(lm, N, Ls, face, detail, s512, darkAtPx) {
  const P = i => [lm[i * 2] * N, lm[i * 2 + 1] * N];
  const top = [21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251].map(P);
  const fw = face.w, fh = face.h, cx = face.cx;
  // skull: an ellipse over the face box, a little wider than the temples and above the brow
  const ecx = cx, ecy = face.y0 + 0.18 * fh, erx = 0.6 * fw, ery = 0.62 * fh;
  const inHead = (x, y) => ((x - ecx) / erx) ** 2 + ((y - ecy) / ery) ** 2 < 1 && y < face.eyeY && x > 1 && y > 1 && x < N - 2 && y < N - 2;
  // flow of the hair: the structure tensor's minor direction
  const gx = new Float32Array(N * N), gy = new Float32Array(N * N);
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    gx[i] = Ls[i + 1] - Ls[i - 1]; gy[i] = Ls[i + N] - Ls[i - N];
  }
  const jxx = new Float32Array(N * N), jxy = new Float32Array(N * N), jyy = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) { jxx[i] = gx[i] * gx[i]; jxy[i] = gx[i] * gy[i]; jyy[i] = gy[i] * gy[i]; }
  const sg = 6 * s512;
  const Jxx = gauss(jxx, N, sg), Jxy = gauss(jxy, N, sg), Jyy = gauss(jyy, N, sg);
  const flowAt = (x, y) => {
    const i = Math.min(N - 1, Math.max(0, y | 0)) * N + Math.min(N - 1, Math.max(0, x | 0));
    const th = 0.5 * Math.atan2(2 * Jxy[i], Jxx[i] - Jyy[i]) + Math.PI / 2;
    const coh = Math.hypot(Jxx[i] - Jyy[i], 2 * Jxy[i]) / (Jxx[i] + Jyy[i] + 1e-9);
    return [Math.cos(th), Math.sin(th), coh];
  };
  // no synthetic hairline or parting (they read as a cap): the model's own hair/forehead edge is
  // kept by the caller. The strands are streamlines of the hair's own flow, seeded along the crown
  // and followed while the flow is clear, evenly spaced so they never bunch or cross; they may
  // leave the skull on the fringe side (bangs over the brow) but stop short of the eyes.
  const browY = face.browY, eyeY = face.eyeY;
  const inHair = (x, y) => x > 2 && y > 2 && x < N - 3 && y < N - 3
    && ((x - ecx) / (1.22 * erx)) ** 2 + ((y - ecy) / (1.1 * ery)) ** 2 < 1
    && y < (x > face.x0 && x < face.x1 ? browY - 0.02 * fh : eyeY);
  // a close-up (the face over half the frame wide, or the crown cut off) shows only the fringe:
  // strands grown from the frame's top edge all meet up there and read as a mitre, so fewer
  const crownOut = fw > 0.5 * N || ecy - ery < 0.03 * N;
  const nStr = Math.max(1, Math.min(5, Math.round(0.5 + 5 * detail)) - (crownOut ? 2 : 0));
  const dsep = 0.075 * fw, stepPx = 1.5 * s512;
  const G = Math.max(4, Math.round(dsep / 2)), GW = Math.ceil(N / G);
  const grid = new Map();                           // occupied cells of strands already grown
  const nearOther = (x, y, own) => {
    const gi = Math.floor(x / G), gj = Math.floor(y / G);
    for (let j = gj - 2; j <= gj + 2; j++) for (let i = gi - 2; i <= gi + 2; i++) {
      const c = grid.get(j * GW + i);
      if (c) for (const [px, py, id] of c) if (id !== own && Math.hypot(px - x, py - y) < dsep) return true;
    }
    return false;
  };
  const mark = (pts, id) => { for (let k = 0; k < pts.length; k += 2) { const key = Math.floor(pts[k + 1] / G) * GW + Math.floor(pts[k] / G); (grid.get(key) || grid.set(key, []).get(key)).push([pts[k], pts[k + 1], id]); } };
  const grow = (sx, sy, id) => {
    // start heading down the skull, to the seed's side of the crown
    let [fx, fy] = flowAt(sx, sy);
    const want = [(sx - ecx) / erx * 0.8, 0.6];
    if (fx * want[0] + fy * want[1] < 0) { fx = -fx; fy = -fy; }
    const pts = [sx, sy];
    let x = sx, y = sy, dx = fx, dy = fy, len = 0, weak = 0, turn = 0;
    for (let k = 0; k < 900; k++) {
      let [ux, uy, coh] = flowAt(x, y);
      if (ux * dx + uy * dy < 0) { ux = -ux; uy = -uy; }
      // a strand bends gently: the flow steers it, it never snaps round
      const nx = 0.75 * dx + 0.25 * ux, ny = 0.75 * dy + 0.25 * uy, nl = Math.hypot(nx, ny) || 1;
      const tx = nx / nl, ty = ny / nl;
      turn = 0.9 * turn + Math.acos(Math.max(-1, Math.min(1, tx * dx + ty * dy)));
      dx = tx; dy = ty;
      x += dx * stepPx; y += dy * stepPx; len += stepPx;
      weak = coh < 0.18 ? weak + 1 : 0;
      if (weak > 5 || turn > 1.1 || !inHair(x, y) || len > 1.4 * fh) break;
      if (len > 3 * stepPx && nearOther(x, y, id)) break;
      pts.push(x, y);
    }
    return { pts, len };
  };
  const out = [];
  const mk = (pts, sal, name) => {
    const sm = catmull(rdp(smoothPts(pts, 3 * s512), 1.2 * s512), 2 * s512, false);
    const n = sm.length / 2;
    if (n < 6) return;
    let dk = 0; for (let i = 0; i < n; i++) dk += darkAtPx(sm[i * 2], sm[i * 2 + 1]);
    out.push({ raw: sm, len: polyLen(sm), str: 1, dark: Math.min(0.6, dk / n), kind: 'hair', score: 0, prox: 1, closed: false, forced: true, name, sal });
  };
  // seeds along the crown, middle out (the parting side first: the darker, hair-heavier half)
  let dl = 0, dr = 0;
  for (let k = 0; k < 9; k++) { const t = -1 + k / 4; const d = darkAtPx(ecx + t * 0.5 * erx, ecy - 0.8 * ery); if (t < 0) dl += d; else if (t > 0) dr += d; }
  const heavy = dl > dr ? -1 : 1;
  const seeds = [];
  for (const phi of [0.15, -0.2, 0.45, -0.5, 0.75, -0.8, 1.0, -1.05, 0.3, -0.35]) {
    const a = phi * heavy, r = 0.86;
    seeds.push([ecx + r * erx * Math.sin(a), ecy - r * ery * Math.cos(a)]);
  }
  const grown = [];
  let id = 0;
  for (const [sx, sy] of seeds) {
    if (!inHair(sx, sy) || nearOther(sx, sy, -1)) continue;
    const g = grow(sx, sy, ++id);
    if (g.len < 0.28 * fh) continue;
    mark(g.pts, id);
    grown.push(g);
    if (grown.length >= nStr) break;
  }
  grown.forEach((g, i) => mk(Float32Array.from(g.pts), 0.62 - 0.03 * i, 'strand'));
  return out;
}

// ------------------------------------------------------------------ worker glue
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async e => {
    const { id, msg } = e.data;
    if (e.data.probe) {
      self.postMessage({ id, ok: true, out: await probeBackend(e.data.backend) });
      return;
    }
    if (e.data.sil) {
      // silhouette (js/lineart/silhouette.js): lines.js runs it in a second instance of this worker,
      // so it overlaps the line model instead of queueing behind it
      try {
        const { silhouette } = await import('./silhouette.js');
        const { rgba, N, opts } = e.data.sil;
        const c = new OffscreenCanvas(N, N);
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), N, N), 0, 0);
        const out = await silhouette(c, opts || {});
        self.postMessage({ id, ok: true, out });
      } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.stack || err) }); }
      return;
    }
    if (e.data.warm) {
      try { self.postMessage({ id, ok: true, out: await warmModel(e.data.backend) }); }
      catch (err) { self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
      return;
    }
    try {
      const out = await runLines(msg);
      const transfer = [out.features.dark.data.buffer, ...out.strokes.map(s => s.points.buffer)];
      
      self.postMessage({ id, ok: true, out }, transfer);
    } catch (err) {
      self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
    }
  };
}
