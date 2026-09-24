// Line art: photo -> the few salient contours a continuous-line artist would draw.
//
//   const { strokes, features, timings } = await extractLines(imageBitmapOrCanvas, crop, { detail: 0.5 });
//
// crop is the app's crop ({ x, y, zoom, rotation }, see js/tone.js); the art frame is the crop
// circle's bounding square, and every coordinate that comes back is a 0..1 fraction of it.
// Everything heavy loads lazily, the first time Line art is used:
//   vendor/mediapipe  MediaPipe Face Landmarker (main thread, CPU delegate)
//   vendor/ort        onnxruntime-web, wasm, one thread (in the worker)
//   vendor/models     informative_drawings.onnx + face_landmarker.task
// If the model cannot load, the worker falls back to an XDoG line map (worse, but it works).
import { cropDiameter } from '../tone.js';
import { validateStrokes } from './strokes.js';

export const LINES_DEFAULTS = Object.freeze({ detail: 0.5, size: 512, engine: 'auto', backend: 'auto', face: true });

const MP_URL = new URL('../../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href;
const MP_WASM_JS = new URL('../../vendor/mediapipe/wasm/vision_wasm_internal.js', import.meta.url).href;
const MP_WASM_BIN = new URL('../../vendor/mediapipe/wasm/vision_wasm_internal.wasm', import.meta.url).href;
const FACE_TASK = new URL('../../vendor/models/face_landmarker.task', import.meta.url).href;

let landmarkerPromise = null;
let faceFailed = null;

// MediaPipe prints 'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.' through console.error
// on its first run; that is a note, not an error. Only lines matching VENDOR_NOISE are downgraded.
const VENDOR_NOISE = /^INFO: |XNNPACK delegate|Unknown CPU vendor/;
function quietVendor(fn) {
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

async function landmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const mp = await import(MP_URL);
      const fileset = { wasmLoaderPath: MP_WASM_JS, wasmBinaryPath: MP_WASM_BIN };
      return quietVendor(() => mp.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_TASK, delegate: 'CPU' },
        runningMode: 'IMAGE', numFaces: 1,
        minFaceDetectionConfidence: 0.35, minFacePresenceConfidence: 0.35,
      }));
    })();
    landmarkerPromise.catch(e => { faceFailed = String(e && e.message || e); landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

/** 478 landmarks as Float32Array(956) in frame fractions, or null. */
export async function detectFace(canvas) {
  const lmk = await landmarker();
  const res = quietVendor(() => lmk.detect(canvas));
  const f = res && res.faceLandmarks && res.faceLandmarks[0];
  if (!f || f.length < 478) return null;
  const out = new Float32Array(f.length * 2);
  f.forEach((p, i) => { out[i * 2] = p.x; out[i * 2 + 1] = p.y; });
  return out;
}

/** The crop's square frame at N x N (a 2D canvas; outside the photo is white). */
export function frameCanvas(source, crop, N) {
  const c = typeof document !== 'undefined'
    ? Object.assign(document.createElement('canvas'), { width: N, height: N })
    : new OffscreenCanvas(N, N);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, N, N);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const w = source.width, h = source.height;
  const scale = N / cropDiameter(w, h, crop);
  g.save();
  g.translate(N / 2, N / 2);
  g.rotate((crop.rotation || 0) * Math.PI / 180);
  g.scale(scale, scale);
  g.translate(-crop.x * w, -crop.y * h);
  g.drawImage(source, 0, 0, w, h);
  g.restore();
  return c;
}

// ------------------------------------------------------------------ worker
let worker = null, workerBroken = false, nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.out) : p.reject(new Error(e.data.error));
    };
    worker.onerror = e => {
      // a worker that cannot even start (no module workers): run in-thread from now on
      workerBroken = true; worker = null;
      for (const [, p] of pending) p.reject(Object.assign(new Error('worker failed: ' + (e.message || 'error')), { retryInThread: true }));
      pending.clear();
    };
  } catch { workerBroken = true; worker = null; }
  return worker;
}

async function runInThread(msg) {
  const { runLines } = await import('./worker.js');
  return runLines(msg);
}

/** Which runtime the line model will use on this device: { backend: 'webgpu'|'wasm', reason }.
 *  WebGPU only when a device really opens (checked in the worker, where the model runs). */
export async function probeLines(backend = 'auto') {
  const w = getWorker();
  if (!w) { const m = await import('./worker.js'); return m.probeBackend(backend); }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, probe: true, backend });
  });
}

/** Loads the line model in the worker (no inference). Resolves { backend } or throws. */
export async function warmLines(backend = 'auto') {
  const w = getWorker();
  if (!w) { const m = await import('./worker.js'); return m.warmModel(backend); }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, warm: true, backend });
  });
}

async function run(msg) {
  const w = getWorker();
  if (!w) return runInThread(msg);
  try {
    return await new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, msg: { ...msg, rgba: msg.rgba } }, [msg.rgba.buffer]);
    });
  } catch (e) {
    if (e.retryInThread) return runInThread(msg);
    throw e;
  }
}

// ------------------------------------------------------------------ silhouette (js/lineart/silhouette.js)
// Runs in a second instance of worker.js, so it overlaps the line model; on the main thread when a
// worker cannot run it (MediaPipe not loading in a module worker, no OffscreenCanvas).
let silWorker = null, silWorkerBroken = false, silWorkerError = null;
const silPending = new Map();
function getSilWorker() {
  if (silWorker || silWorkerBroken) return silWorker;
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('no OffscreenCanvas');
    silWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    silWorker.onmessage = e => {
      const p = silPending.get(e.data.id);
      if (!p) return;
      silPending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.out) : p.reject(new Error(e.data.error));
    };
    silWorker.onerror = e => {
      silWorkerBroken = true; silWorker = null;
      for (const [, p] of silPending) p.reject(new Error('silhouette worker failed: ' + (e.message || 'error')));
      silPending.clear();
    };
  } catch { silWorkerBroken = true; silWorker = null; }
  return silWorker;
}
const silCache = new Map();
/** The subject's silhouette for a frame canvas (see silhouette.js). opts: { tap, kindHint, landmarks }. */
export async function silhouetteOf(canvas, opts = {}) {
  const N = canvas.width;
  const rgba = canvas.getContext('2d').getImageData(0, 0, N, N).data;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < rgba.length; i += 61) h = Math.imul(h ^ rgba[i], 16777619) >>> 0;
  const key = `${N}:${h}|${opts.tap ? opts.tap.map(v => (+v).toFixed(3)).join(',') : ''}|${opts.kindHint || ''}|${opts.landmarks ? 1 : 0}`;
  if (silCache.has(key)) return { ...silCache.get(key), cached: true };
  const o = { tap: opts.tap || null, kindHint: opts.kindHint || null, landmarks: opts.landmarks || null };
  let out = null;
  const w = getSilWorker();
  if (w) {
    try {
      out = await new Promise((resolve, reject) => {
        const id = nextId++;
        silPending.set(id, { resolve, reject });
        w.postMessage({ id, sil: { rgba, N, opts: o } }, [rgba.buffer]);
      });
      out.where = 'worker';
    } catch (e) {
      // MediaPipe would not start in the worker: the main thread from now on
      silWorkerBroken = true;
      try { silWorker && silWorker.terminate(); } catch { /* gone */ }
      silWorker = null;
      silWorkerError = String(e && e.message || e).split(/\r?\n/).slice(0, 2).join(' ');
      console.debug('lineart: silhouette worker failed, using the main thread:', silWorkerError);
    }
  }
  if (!out) {
    const { silhouette } = await import('./silhouette.js');
    out = await silhouette(canvas, o);
    out.where = 'main';
    if (silWorkerError) out.workerError = silWorkerError;
  }
  silCache.set(key, out);
  if (silCache.size > 4) silCache.delete(silCache.keys().next().value);
  return out;
}

/**
 * source: ImageBitmap | canvas | img; crop: { x, y, zoom, rotation }.
 * opts: { detail 0..1, size (model input, px, multiple of 4), engine 'auto'|'model'|'xdog',
 *         backend 'auto'|'webgpu'|'wasm' (the model's runtime), face bool,
 *         debugInk bool (also return the N x N line map),
 *         silhouette false | true | { tap: [x, y] frame fractions, kindHint }: also find the
 *           subject's outer shape (js/lineart/silhouette.js), returned as features.silhouette
 *           (null when it failed; silhouetteError says why). Runs alongside the line model. }
 * -> { strokes, features, timings, engine, stats }
 */
export async function extractLines(source, crop, opts = {}) {
  const o = { ...LINES_DEFAULTS, ...opts };
  const N = Math.max(128, Math.round(o.size / 4) * 4);
  const t0 = performance.now();
  const timings = {};
  const canvas = frameCanvas(source, crop, N);
  timings.frame = Math.round(performance.now() - t0);

  let landmarks = null;
  if (o.face) {
    const t1 = performance.now();
    try { landmarks = await detectFace(canvas); } catch (e) { faceFailed = String(e && e.message || e); }
    timings.face = Math.round(performance.now() - t1);
  }
  let silPromise = null;
  if (o.silhouette) {
    const so = typeof o.silhouette === 'object' ? o.silhouette : {};
    const ts = performance.now();
    silPromise = silhouetteOf(canvas, { tap: so.tap || null, kindHint: so.kindHint || null, landmarks })
      .then(r => { timings.silhouette = Math.round(performance.now() - ts); return { sil: r, err: null }; },
        e => ({ sil: null, err: String(e && e.message || e) }));
  }
  const rgba = canvas.getContext('2d').getImageData(0, 0, N, N).data;
  let out;
  try {
    out = await run({ rgba, N, detail: o.detail, engine: o.engine, backend: o.backend, landmarks, debugInk: !!o.debugInk, debugAll: !!o.debugAll, ink: o.ink || null });
  } catch (e) {
    // the model crashed inside the worker: one more go with the fallback line map
    const rgba2 = canvas.getContext('2d').getImageData(0, 0, N, N).data;
    out = await run({ rgba: rgba2, N, detail: o.detail, engine: 'xdog', landmarks, debugInk: !!o.debugInk });
    out.modelError = String(e && e.message || e);
  }
  let silhouetteError = null;
  if (silPromise) {
    const { sil, err } = await silPromise;
    out.features.silhouette = sil;
    silhouetteError = err;
    if (err) console.warn('lineart: silhouette failed:', err.split(/\r?\n/)[0]);
  }
  Object.assign(timings, out.timings, { total: Math.round(performance.now() - t0) });
  const check = validateStrokes(out.strokes);
  if (!check.ok) console.warn('lineart: invalid strokes', check.errors.slice(0, 5));
  return { strokes: out.strokes, features: out.features, timings, engine: out.engine, stats: out.stats,
    faceError: faceFailed, modelError: out.modelError || null, silhouetteError, ink: out.ink || null, all: out.all || null, N };
}
