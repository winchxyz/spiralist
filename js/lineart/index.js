// Line art mode: the one entry point the app uses.
//
//   import { LINE_STYLES, LineArtEngine } from './lineart/index.js';
//   const eng = new LineArtEngine();
//   await eng.prepare(p => ...);                                   // optional: download + warm up
//   const lines = await eng.lines(bitmap, crop, { detail }, p => ...);   // cached per photo+crop+detail
//   // silhouette first: { detail, silhouette: true } finds the subject's outer shape too, and
//   // { silhouette: { tap: [x, y] } } (frame fractions) takes the thing under the user's tap;
//   // describeSilhouette(lines.features.silhouette).label says what it found ("Subject: cat")
//   const geom = await eng.build('matisse', lines, { sheetMm, tool, toolMm, wobble, hatch, seed });
//
// geom is the app's geometry (STRIDE 7) with geom.path = 'lineart', geom.handT (hand seconds per
// point, also every pacing table) and geom.lineart = { style, lengthM, handSeconds, retracedM,
// bridgesM, engine, timings, ... }. Render with renderer.setLayout({ cx: .5, cy: .5, r: LAYOUT_R }).
import { extractLines, detectFace, warmLines, probeLines, frameCanvas, silhouetteOf } from './lines.js';
import { LINE_STYLES, lineStyleById, buildStyled } from './styles.js';
import { LAYOUT_R, PRESSURE_TOOLS, silhouetteScore, standinSilhouette, isScene } from './path.js';

export { LINE_STYLES, lineStyleById, LAYOUT_R, PRESSURE_TOOLS, silhouetteScore, standinSilhouette, isScene };

// the names deeplab gives its classes, as the app says them ("Subject: cat")
const SUBJECT_NAME = { aeroplane: 'plane', diningtable: 'table', pottedplant: 'plant', tv: 'screen', motorbike: 'motorbike' };
/** What the silhouette found, for the app: { label: 'Subject: cat' | 'Scene: landscape' | ...,
 *  scene, tapped, weak }. weak: the finder was unsure (a tap usually helps). */
export function describeSilhouette(sil) {
  if (!sil) return { label: 'Subject: not found', scene: false, tapped: false, weak: true };
  const tapped = !!sil.tapped, scene = !tapped && isScene(sil);
  // (a class is named only when the finder is quite sure: a lighthouse's house can read as a train)
  const name = sil.subject && (sil.confidence ?? 0) >= 0.8 ? SUBJECT_NAME[sil.subject] || sil.subject : null;
  let label;
  // (a scene never names its landmark: deeplab reads a lighthouse's house as a train)
  if (scene) label = sil.kind === 'landscape' ? 'Scene: landscape' : 'Scene: skyline and a landmark';
  else if (sil.kind === 'portrait') label = 'Subject: portrait';
  else if (sil.kind === 'person') label = 'Subject: person';
  // (a tap names no class: the class under a saucer is the table)
  else if (tapped && (sil.outlines || []).length) label = 'Subject: what you tapped';
  else if (name) label = `Subject: ${name}`;
  else if (sil.kind === 'animal') label = 'Subject: an animal';
  else if (sil.kind === 'object') label = 'Subject: an object';
  else label = 'Subject: not found';
  // (a scene is sure enough: its colour-flood skyline always reports a low confidence)
  return { label, scene, tapped, weak: !tapped && !scene && (!(sil.outlines && sil.outlines.length) || (sil.confidence ?? 1) < 0.5) };
}

const maskShare = m => { if (!m?.data) return 0; let s = 0; for (let i = 0; i < m.data.length; i++) s += m.data[i] > 127; return s / m.data.length; };
/** What a tap did to the drawn outline: 'closeup' when the subject fills the frame (a close-up
 *  face: the contour is its face and hair at the frame edge, whatever the tap; path.js
 *  closeUpSilhouette), 'same' when the tap picked the shape the finder had found, else null. */
export function tapOutcome(auto, tapped) {
  if (!auto || !tapped) return null;
  if (tapped.parts?.face && maskShare(tapped.mask) > 0.8) return 'closeup';
  const a = auto.mask?.data, b = tapped.mask?.data;
  if (a && b && a.length === b.length) {
    let both = 0, any = 0;
    for (let k = 0; k < a.length; k++) { const p = a[k] > 127, q = b[k] > 127; both += p && q; any += p || q; }
    if (any && both / any > 0.92) return 'same';
  }
  return null;
}

// deeplab classes whose outline is a thin frame (spokes, chair rails): a filled blob as a shape
const THIN_CLASSES = ['bicycle', 'chair', 'motorbike'];
/** Whether the silhouette makes a cookie cutter worth printing (js/print3d): only a subject the
 *  finder was sure of, or one the user tapped. -> { ok, reason, fix: 'tap' | null, label }
 *  (fix 'tap': choosing the subject in Line art helps). The cutter itself then checks that the
 *  subject's thin parts, such as ears, survive the wall's rounding at the chosen size. */
export function cutterVerdict(sil) {
  const d = describeSilhouette(sil), top = sil?.classes?.[0]?.name;
  if (sil && d.scene) return { ok: false, fix: null, label: d.label, reason: 'A landscape has no single subject to cut round: the cutter would be a strip of skyline.' };
  if (!sil || !(sil.outlines || []).length) return { ok: false, fix: 'tap', label: d.label, reason: 'No subject was found in the photo, so there is no outline to cut round.' };
  if (sil.standin) return { ok: false, fix: 'tap', label: d.label, reason: 'The subject was not found; the drawing\'s outer edge would make a shapeless cutter.' };
  if (d.tapped) return { ok: true, fix: null, label: d.label, reason: '' };
  if (d.weak) return { ok: false, fix: 'tap', label: d.label, reason: 'The subject\'s outline is unclear, so the cutter would be a blob. Tap the subject in Line art first.' };
  if (sil.kind === 'object' && THIN_CLASSES.includes(top) && (sil.confidence ?? 0) < 0.8) return { ok: false, fix: 'tap', label: d.label, reason: `A ${top}'s shape is its thin frame; filled in as a cutter it reads as a blob.` };
  return { ok: true, fix: null, label: d.label, reason: '' };
}

const V = new URL('../../vendor/', import.meta.url).href;
const SHARED_ASSETS = [
  { url: V + 'models/informative_drawings.onnx', bytes: 17193338 },
  { url: V + 'mediapipe/wasm/vision_wasm_internal.wasm', bytes: 11756954 },
  // the subject's silhouette (js/lineart/silhouette.js): what it is, and its crisp outer shape
  { url: V + 'models/magic_touch.tflite', bytes: 6227884 },
  { url: V + 'models/face_landmarker.task', bytes: 3758596 },
  { url: V + 'models/deeplab_v3.tflite', bytes: 2780176 },
  { url: V + 'mediapipe/wasm/vision_wasm_internal.js', bytes: 323377 },
  { url: V + 'mediapipe/vision_bundle.mjs', bytes: 155439 },
];
/** What the first Line art use downloads on the wasm runtime (most devices). */
export const LINEART_ASSETS = Object.freeze([
  ...SHARED_ASSETS,
  { url: V + 'ort/ort-wasm-simd-threaded.wasm', bytes: 11905541 },
  { url: V + 'ort/ort.wasm.bundle.min.mjs', bytes: 68628 },
]);
/** ... and on the WebGPU runtime (only where a WebGPU device really opens). */
export const LINEART_ASSETS_WEBGPU = Object.freeze([
  ...SHARED_ASSETS,
  { url: V + 'ort/ort-wasm-simd-threaded.jsep.wasm', bytes: 23824254 },
  { url: V + 'ort/ort.min.mjs', bytes: 357488 },
  { url: V + 'ort/ort-wasm-simd-threaded.jsep.mjs', bytes: 49998 },
]);
/** The files the first use downloads for this runtime. */
export const lineartAssets = backend => (backend === 'webgpu' ? LINEART_ASSETS_WEBGPU : LINEART_ASSETS);

// a stable id per photo object, so the cache key never hashes pixels on the main thread
const srcIds = new WeakMap();
let srcSeq = 0;
let fpCanvas = null;
function srcId(source) {
  if (!source || typeof source !== 'object') return 'x';
  if (!srcIds.has(source)) srcIds.set(source, ++srcSeq);
  return srcIds.get(source) + ':' + (source.width | 0) + 'x' + (source.height | 0) + ':' + fingerprint(source);
}
/** A 16 x 16 thumbnail hash (about a millisecond): a canvas redrawn in place with another photo
 *  never hits the old photo's cached lines. */
function fingerprint(source) {
  try {
    if (!fpCanvas) fpCanvas = typeof document !== 'undefined'
      ? Object.assign(document.createElement('canvas'), { width: 16, height: 16 }) : new OffscreenCanvas(16, 16);
    const g = fpCanvas.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, 16, 16);
    g.drawImage(source, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619) >>> 0;
    return h.toString(36);
  } catch { return '-'; }
}
const cropKey = c => (c ? [c.x, c.y, c.zoom, c.rotation].map(v => (+v || 0).toFixed(4)).join(',') : '-');

export class LineArtEngine {
  constructor({ cacheSize = 6 } = {}) {
    this.cache = new Map();          // key -> Promise<lineResult>
    this.cacheSize = cacheSize;
    this.ready = false;
    this._prep = null;
    this._worker = null;
    this._workerBroken = typeof Worker === 'undefined';
    this._jobs = new Map();
    this._seq = 0;
    // the network is back: edge-finder lines read while offline may be read again with the model
    try { self.addEventListener('online', () => { for (const p of this.cache.values()) if (p.xdogAt) p.xdogAt = 1; }); } catch { /* no events */ }
  }

  /** Downloads the models (with progress) and warms them up. Safe to call more than once. */
  prepare(onProgress = () => {}) {
    if (this._prep) { this._prep.then(() => onProgress({ stage: 'ready', loaded: 1, total: 1 })).catch(() => {}); return this._prep; }
    this._prep = (async () => {
      // decide the runtime first (a WebGPU device must really open), then fetch only its files
      let probe = { backend: 'wasm', reason: 'probe failed' };
      try { probe = await probeLines(this.backend || 'auto'); } catch { /* wasm */ }
      this.backend = probe.backend;
      const assets = lineartAssets(probe.backend);
      const total = assets.reduce((a, f) => a + f.bytes, 0);
      let loaded = 0;
      onProgress({ stage: 'download', loaded, total, backend: probe.backend });
      // fetch every file once so the HTTP cache (and the service worker) holds it; the model
      // and face loaders then read it from there
      await Promise.all(assets.map(async f => {
        let got = 0;
        try {
          const res = await fetch(f.url);
          if (!res.ok || !res.body) { loaded += f.bytes; onProgress({ stage: 'download', loaded, total }); return; }
          const rd = res.body.getReader();
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            got += value.length; loaded += value.length;
            onProgress({ stage: 'download', loaded: Math.min(loaded, total), total });
          }
        } catch { /* the loaders will report it */ }
        if (got < f.bytes) { loaded += f.bytes - got; onProgress({ stage: 'download', loaded: Math.min(loaded, total), total }); }
      }));
      onProgress({ stage: 'model', loaded: 0, total: 1 });
      const t0 = performance.now();
      let backend = null, modelError = null;
      try { backend = (await warmLines(probe.backend)).backend; } catch (e) { modelError = String(e && e.message || e); }
      onProgress({ stage: 'model', loaded: 1, total: 1 });
      onProgress({ stage: 'face', loaded: 0, total: 1 });
      const t1 = performance.now();
      try {
        const c = typeof document !== 'undefined'
          ? Object.assign(document.createElement('canvas'), { width: 64, height: 64 }) : new OffscreenCanvas(64, 64);
        c.getContext('2d').fillRect(0, 0, 1, 1);
        await detectFace(c);
      } catch { /* faceless drawings still work */ }
      onProgress({ stage: 'face', loaded: 1, total: 1 });
      this.ready = true;
      this.warm = { backend, probe: probe.reason, downloadBytes: total, modelError, modelMs: Math.round(t1 - t0), faceMs: Math.round(performance.now() - t1) };
      onProgress({ stage: 'ready', loaded: 1, total: 1 });
      return this.warm;
    })();
    this._prep.catch(() => { this._prep = null; });
    return this._prep;
  }

  /** The drawable lines of this photo + crop at this detail: { strokes, features, engine, timings, stats }.
   *  Cached; the same photo and crop at another detail reuses the model's line map (vectoriser only). */
  lines(source, crop, { detail = 0.5, engine = 'auto', ink = null, silhouette = false } = {}, onProgress = () => {}) {
    // (silhouette: also find the subject's outer shape, features.silhouette; see silhouette.js.
    //  { tap: [x, y] } in frame fractions: the subject is the thing under the tap)
    const tap = silhouette && typeof silhouette === 'object' && Array.isArray(silhouette.tap) && silhouette.tap.length === 2
      && silhouette.tap.every(v => Number.isFinite(+v)) ? silhouette.tap.map(v => Math.min(1, Math.max(0, +v))) : null;
    if (tap) return this._tapped(source, crop, { detail, engine, ink }, tap, onProgress);
    const key = srcId(source) + '|' + cropKey(crop) + '|' + (+detail).toFixed(3) + '|' + engine + (silhouette ? '|sil' : '');
    let hit = this.cache.get(key);
    // lines the edge finder drew because the model failed are not kept for good: once the
    // worker may try the model again (20 s later, or when the network is back), read again
    if (hit && hit.xdogAt && engine === 'auto' && Date.now() - hit.xdogAt > 20000) { this.cache.delete(key); hit = null; }
    if (hit) {
      this.cache.delete(key); this.cache.set(key, hit);          // LRU
      return hit.then(r => { onProgress({ stage: 'ready', loaded: 1, total: 1 }); return { ...r, cached: true }; });
    }
    const p = (async () => {
      onProgress({ stage: 'model', loaded: 0, total: 1 });
      const t0 = performance.now();
      const r = await extractLines(source, crop, { detail, engine, ink, debugInk: !ink && !!this.keepInk, ...(silhouette ? { silhouette: true } : {}) });
      onProgress({ stage: 'ready', loaded: 1, total: 1 });
      r.timings = { ...r.timings, wall: Math.round(performance.now() - t0) };
      r.key = key;
      return r;
    })();
    this.cache.set(key, p);
    p.then(r => { if (r && r.engine === 'xdog' && engine === 'auto') p.xdogAt = Date.now(); }, () => this.cache.delete(key));
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return p;
  }

  /** The lines with the silhouette of the thing under a tap: the photo's lines (cached, no new
   *  model run) plus one silhouette run with the tap (MagicTouch, well under a second). */
  _tapped(source, crop, o, tap, onProgress) {
    const key = srcId(source) + '|' + cropKey(crop) + '|' + (+o.detail).toFixed(3) + '|' + o.engine + '|tap:' + tap.map(v => v.toFixed(3)).join(',');
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); this.cache.set(key, hit);
      return hit.then(r => { onProgress({ stage: 'ready', loaded: 1, total: 1 }); return { ...r, cached: true }; });
    }
    const p = (async () => {
      const base = await this.lines(source, crop, { ...o, silhouette: true }, onProgress);
      const t0 = performance.now();
      let sil = null, err = null;
      try {
        const canvas = frameCanvas(source, crop, base.N || 512);
        sil = await silhouetteOf(canvas, { tap, landmarks: base.features?.face?.landmarks || null });
      } catch (e) { err = String(e && e.message || e); console.warn('lineart: tapped silhouette failed:', err.split(/\r?\n/)[0]); }
      onProgress({ stage: 'ready', loaded: 1, total: 1 });
      return { ...base, cached: false, key, tap, tapOutcome: tapOutcome(base.features?.silhouette, sil),
        features: { ...base.features, silhouette: sil || base.features.silhouette },
        silhouetteError: err || base.silhouetteError || null,
        timings: { ...base.timings, tap: Math.round(performance.now() - t0) } };
    })();
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return p;
  }

  /** One continuous line in a style. Runs in a Worker (main thread where workers fail).
   *  Resolves to the geometry; a newer build() with the same tag makes an older one resolve null. */
  build(styleId, lineResult, opts = {}, { tag = 'stage' } = {}) {
    const t0 = performance.now();
    const lines = { strokes: lineResult.strokes, features: lineResult.features, engine: lineResult.engine };
    const finish = g => {
      if (!g) return g;
      if (!(g._pace instanceof Map)) g._pace = new Map();
      for (const k of ['natural', 'steady', 'rings']) g._pace.set(k, g.handT);
      g.lineart.timings = { lines: lineResult.timings || null, buildMs: g.lineart.buildMs, waitMs: Math.round(performance.now() - t0) };
      return g;
    };
    const w = this._ensureWorker();
    if (!w) return new Promise(res => setTimeout(() => res(finish(buildStyled(styleId, lines, opts))), 0));
    return new Promise((resolve, reject) => {
      const id = ++this._seq;
      if (tag) for (const [jid, j] of this._jobs) if (j.tag === tag) { j.stale = true; this._jobs.set(jid, j); }
      this._jobs.set(id, { tag, stale: false, resolve: g => resolve(finish(g)), reject, styleId, lines, opts });
      // strokes are copied (not transferred): the cached line result stays usable
      w.postMessage({ id, styleId, lines, opts });
    });
  }

  _ensureWorker() {
    if (this._worker || this._workerBroken) return this._worker;
    try {
      const w = new Worker(new URL('./buildworker.js', import.meta.url), { type: 'module' });
      w.onmessage = e => {
        const j = this._jobs.get(e.data.id);
        if (!j) return;
        this._jobs.delete(e.data.id);
        if (j.stale) { j.resolve(null); return; }
        if (e.data.ok) j.resolve(e.data.geom); else j.reject(new Error(e.data.error));
      };
      w.onerror = e => {
        e.preventDefault?.();
        console.warn('lineart: build worker failed, building on the main thread');
        this._workerBroken = true; this._worker = null;
        const jobs = [...this._jobs.values()];
        this._jobs.clear();
        for (const j of jobs) {
          try { j.resolve(j.stale ? null : buildStyled(j.styleId, j.lines, j.opts)); } catch (err) { j.reject(err); }
        }
      };
      this._worker = w;
    } catch { this._workerBroken = true; this._worker = null; }
    return this._worker;
  }

  dispose() {
    try { this._worker && this._worker.terminate(); } catch { /* gone */ }
    this._worker = null;
    this.cache.clear();
  }
}
