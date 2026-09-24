// Line art silhouettes: the subject masks behind the one line (js/lineart/silhouette.js).
//   node tests/shoot.mjs "/dev/lineart_sil.html?imgs=bust,cat,moon,peaks,face,testset:a.jpg" --timeout 600000
//   mode   'sheet' (default): photo | mask + outline (+ skyline) per subject, kind / confidence / ms
//          'lines': extractLines(..., { silhouette: true }) end to end (timings, no sheet)
//          'eval': the candidate models side by side (shots/_models/: u2netp, deeplab_v3,
//                  selfie_multiclass, magic_touch at the centre tap)
//   imgs   comma list: samples (bust, cat, moon, peaks, face) or testset:<file> (shots/testset/)
//   cols   subjects per row (4)       cell   px (300)       name   output (sil_masks)
//   tap    x,y frame fractions: pass to silhouette() for every subject
//   via    'worker' (default): lines.js silhouetteOf (the second worker, main-thread fallback);
//          'main': silhouette() directly on this thread
//   face   1 (default): MediaPipe face landmarks first (gives people their hair / face / body parts)
import { CROP_DEFAULTS } from '../js/tone.js';
import { frameCanvas, silhouetteOf, detectFace, extractLines } from '../js/lineart/lines.js';
import { silhouette } from '../js/lineart/silhouette.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? +q.get(k) : d);
const N = 512;

const FACE_CROP = { x: 0.5, y: 0.4, zoom: 1.55, rotation: 0 };
async function loadSubject(id) {
  if (id.startsWith('testset:')) {
    const img = new Image();
    img.src = '/shots/testset/' + id.slice(8);
    await img.decode();
    const bm = await createImageBitmap(img);
    return { src: bm, crop: CROP_DEFAULTS, label: id.slice(8).replace(/\.[a-z]+$/i, '') };
  }
  const { makeSample } = await import('../js/samples.js');
  const src = await makeSample(id === 'face' ? 'bust' : id, 1024);
  return { src, crop: id === 'face' ? FACE_CROP : CROP_DEFAULTS, label: id };
}

// ------------------------------------------------------------------ eval: raw candidate outputs
const MP_URL = '/vendor/mediapipe/vision_bundle.mjs';
const FILESET = { wasmLoaderPath: '/vendor/mediapipe/wasm/vision_wasm_internal.js', wasmBinaryPath: '/vendor/mediapipe/wasm/vision_wasm_internal.wasm' };
const PALETTE = [[0, 0, 0], [230, 60, 60], [60, 160, 230], [240, 190, 40], [60, 200, 90], [200, 90, 220], [250, 130, 40], [40, 200, 200], [150, 150, 250], [250, 120, 170]];
let mp = null;
async function mpSeg(model, extra = {}) {
  mp = mp || await import(MP_URL);
  return mp.ImageSegmenter.createFromOptions(FILESET, { baseOptions: { modelAssetPath: '/shots/_models/' + model, delegate: 'CPU' }, runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false, ...extra });
}
let ortS = null;
async function u2net(canvas) {
  if (!ortS) {
    const ort = await import('/vendor/ort/ort.wasm.bundle.min.mjs');
    ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = { wasm: '/vendor/ort/ort-wasm-simd-threaded.wasm' };
    const buf = new Uint8Array(await (await fetch('/shots/_models/u2netp.onnx')).arrayBuffer());
    ortS = { ort, s: await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] }) };
  }
  const S = 320, c = Object.assign(document.createElement('canvas'), { width: S, height: S });
  c.getContext('2d').drawImage(canvas, 0, 0, S, S);
  const d = c.getContext('2d').getImageData(0, 0, S, S).data;
  let mx = 1; for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i + 1], d[i + 2]);
  const M = S * S, x = new Float32Array(3 * M), mean = [0.485, 0.456, 0.406], sd = [0.229, 0.224, 0.225];
  for (let i = 0; i < M; i++) for (let k = 0; k < 3; k++) x[k * M + i] = (d[i * 4 + k] / mx - mean[k]) / sd[k];
  const t = performance.now();
  const out = await ortS.s.run({ [ortS.s.inputNames[0]]: new ortS.ort.Tensor('float32', x, [1, 3, S, S]) });
  const y = out[ortS.s.outputNames[0]].data;
  let lo = 1e9, hi = -1e9; for (const v of y) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const m = new Uint8Array(M); for (let i = 0; i < M; i++) m[i] = Math.round(255 * (y[i] - lo) / (hi - lo || 1));
  return { w: S, h: S, gray: m, ms: Math.round(performance.now() - t) };
}
function paintGray(g, frame, r, x, y, cell) {
  g.drawImage(frame, x, y, cell, cell);
  const c = Object.assign(document.createElement('canvas'), { width: r.w, height: r.h });
  const id = c.getContext('2d').createImageData(r.w, r.h);
  for (let i = 0; i < r.w * r.h; i++) {
    if (r.cats) { const k = r.cats[i]; const p = k === 0 || k === 255 ? null : PALETTE[k % PALETTE.length]; if (p) { id.data.set(p, i * 4); id.data[i * 4 + 3] = 170; } }
    else { const v = r.gray[i]; id.data[i * 4] = 230; id.data[i * 4 + 1] = 40; id.data[i * 4 + 2] = 40; id.data[i * 4 + 3] = Math.round(v * 0.75); }
  }
  c.getContext('2d').putImageData(id, 0, 0);
  g.drawImage(c, x, y, cell, cell);
}
async function evalSheet(ids, cell) {
  const cols = ['photo', 'u2netp', 'deeplab_v3', 'selfie_multiclass', 'magic_touch @ centre'];
  const W = cols.length * (cell + 6) + 6, H = 30 + ids.length * (cell + 28);
  const sheet = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = sheet.getContext('2d');
  g.fillStyle = '#ddd'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#111'; g.font = 'bold 15px system-ui';
  cols.forEach((c, i) => g.fillText(c, 6 + i * (cell + 6), 20));
  const dl = await mpSeg('deeplab_v3.tflite'), sm = await mpSeg('selfie_multiclass_256x256.tflite');
  mp = mp || await import(MP_URL);
  const mt = await mp.InteractiveSegmenterLegacy.createFromOptions(FILESET, { baseOptions: { modelAssetPath: '/shots/_models/magic_touch.tflite', delegate: 'CPU' }, outputCategoryMask: true, outputConfidenceMasks: false });
  const labels = dl.getLabels();
  const stats = [];
  for (let ri = 0; ri < ids.length; ri++) {
    const S = await loadSubject(ids[ri]);
    const frame = frameCanvas(S.src, S.crop, N);
    const y = 30 + ri * (cell + 28);
    const run = seg => { const t = performance.now(); const r = seg.segment(frame); const m = r.categoryMask; const out = { w: m.width, h: m.height, cats: m.getAsUint8Array().slice(), ms: Math.round(performance.now() - t) }; r.close(); return out; };
    const a = await u2net(frame), b = run(dl), c = run(sm);
    const t3 = performance.now();
    const r3 = mt.segment(frame, { keypoint: { x: 0.5, y: 0.5 } });
    const m3 = r3.categoryMask; const d = { w: m3.width, h: m3.height, cats: m3.getAsUint8Array().map(v => (v ? 0 : 1)), ms: Math.round(performance.now() - t3) }; r3.close();
    const hist = {}; b.cats.forEach(k => { hist[k] = (hist[k] || 0) + 1; });
    const cls = Object.entries(hist).filter(([k, n]) => +k && n > 0.01 * b.cats.length).map(([k, n]) => `${labels[k]} ${Math.round(100 * n / b.cats.length)}%`).join(', ');
    g.drawImage(frame, 6, y, cell, cell);
    [a, b, c, d].forEach((r, i) => paintGray(g, frame, r, 6 + (i + 1) * (cell + 6), y, cell));
    g.fillStyle = '#111'; g.font = '12px system-ui';
    g.fillText(S.label, 6, y + cell + 15, cell);
    [a, b, c, d].forEach((r, i) => g.fillText(`${r.ms} ms${i === 1 ? ' · ' + cls : ''}`, 6 + (i + 1) * (cell + 6), y + cell + 15, cell));
    stats.push({ id: ids[ri], u2: a.ms, dl: b.ms, sm: c.ms, mt: d.ms, cls });
  }
  return { sheet, stats };
}

// ------------------------------------------------------------------ sheet: silhouette() results
const KIND_COL = { person: '#e0443c', portrait: '#e0443c', animal: '#2f8fd8', object: '#2aa55a', landscape: '#c98a14', unknown: '#888' };
async function silSheet(ids, cell, colsN) {
  const rows = Math.ceil(ids.length / colsN);
  const pw = 2 * cell + 8, ph = cell + 34;
  const W = colsN * (pw + 12) + 12, H = rows * (ph + 12) + 12;
  const sheet = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = sheet.getContext('2d');
  g.fillStyle = '#d9d6cf'; g.fillRect(0, 0, W, H);
  const tap = q.get('tap') ? q.get('tap').split(',').map(Number) : null;
  const stats = [];
  for (let i = 0; i < ids.length; i++) {
    const S = await loadSubject(ids[i]);
    const frame = frameCanvas(S.src, S.crop, N);
    const t0 = performance.now();
    const landmarks = q.get('face') === '0' ? null : await detectFace(frame).catch(() => null);
    const t1 = performance.now();
    const sil = q.get('via') === 'main' ? await silhouette(frame, { tap, landmarks }) : await silhouetteOf(frame, { tap, landmarks });
    const segMs = Math.round(performance.now() - t1);
    const ms = Math.round(performance.now() - t0);
    const x = 12 + (i % colsN) * (pw + 12), y = 12 + Math.floor(i / colsN) * (ph + 12);
    g.drawImage(frame, x, y, cell, cell);
    const x2 = x + cell + 8;
    g.drawImage(frame, x2, y, cell, cell);
    g.fillStyle = 'rgba(255,255,255,0.72)'; g.fillRect(x2, y, cell, cell);
    // mask tint
    const { w, h, data } = sil.mask;
    const mc = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const id = mc.getContext('2d').createImageData(w, h);
    const col = KIND_COL[sil.kind] || '#888';
    const rgb = [1, 3, 5].map(k => parseInt(col.slice(k, k + 2), 16));
    for (let p = 0; p < w * h; p++) if (data[p]) { id.data.set(rgb, p * 4); id.data[p * 4 + 3] = 70; }
    mc.getContext('2d').putImageData(id, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(mc, x2, y, cell, cell);
    if (sil.parts && sil.parts.hair) {
      const hp = sil.parts.hair, hc = Object.assign(document.createElement('canvas'), { width: hp.w, height: hp.h });
      const hd = hc.getContext('2d').createImageData(hp.w, hp.h);
      for (let p = 0; p < hp.w * hp.h; p++) if (hp.data[p]) { hd.data.set([120, 60, 20], p * 4); hd.data[p * 4 + 3] = 90; }
      hc.getContext('2d').putImageData(hd, 0, 0);
      g.drawImage(hc, x2, y, cell, cell);
    }
    const poly = (pts, closed, stroke, lw) => {
      g.beginPath();
      for (let k = 0; k < pts.length; k += 2) { const px = x2 + pts[k] * cell, py = y + pts[k + 1] * cell; k ? g.lineTo(px, py) : g.moveTo(px, py); }
      if (closed) g.closePath();
      g.strokeStyle = stroke; g.lineWidth = lw; g.lineJoin = 'round'; g.stroke();
    };
    sil.outlines.forEach((o, k) => poly(o, true, k ? '#555' : '#111', k ? 1.5 : 2.5));
    if (sil.skyline) poly(sil.skyline, false, '#c0392b', 2.5);
    if (sil.head) { g.setLineDash([6, 4]); poly(sil.head, true, '#7a3b10', 2); g.setLineDash([]); }
    if (tap) { g.fillStyle = '#e03'; g.beginPath(); g.arc(x2 + tap[0] * cell, y + tap[1] * cell, 5, 0, 7); g.fill(); }
    g.fillStyle = '#111'; g.font = 'bold 14px system-ui';
    g.fillText(S.label, x + 4, y + cell + 17, cell - 8);
    g.font = '13px system-ui'; g.fillStyle = col;
    const tm = sil.timings || {};
    g.fillText(`${sil.kind} · conf ${sil.confidence.toFixed(2)} · ${sil.outlines.length} outline${sil.outlines.length === 1 ? '' : 's'}${sil.skyline ? ' + skyline' : ''} · ${segMs} ms ${sil.where || ''}`, x2, y + cell + 17, cell);
    g.fillStyle = '#444'; g.font = '11px system-ui';
    g.fillText(sil.why || '', x2, y + cell + 31, cell);
    stats.push({ id: S.label, where: sil.where, werr: sil.workerError, segMs, edge: sil.edge, kind: sil.kind, conf: +sil.confidence.toFixed(2), outlines: sil.outlines.length, pts: sil.outlines.map(o => o.length / 2), skyline: !!sil.skyline, ms, timings: tm, why: sil.why });
  }
  return { sheet, stats };
}

async function linesRun(ids) {
  const stats = [];
  for (const id of ids) {
    const S = await loadSubject(id);
    const t0 = performance.now();
    const r = await extractLines(S.src, S.crop, { silhouette: true });
    const t1 = performance.now();
    const again = await extractLines(S.src, S.crop, { silhouette: true });
    const sil = r.features.silhouette;
    stats.push({ id: S.label, ms: Math.round(t1 - t0), msAgain: Math.round(performance.now() - t1), silMs: r.timings.silhouette, inference: r.timings.inference, face: r.timings.face,
      kind: sil && sil.kind, conf: sil && sil.confidence, outlines: sil && sil.outlines.length, skyline: !!(sil && sil.skyline), hair: !!(sil && sil.parts && sil.parts.hair),
      where: sil && sil.where, silTimings: sil && sil.timings, againCached: !!(again.features.silhouette && again.features.silhouette.cached), err: r.silhouetteError });
  }
  return stats;
}

async function main() {
  const ids = (q.get('imgs') || 'bust,cat,moon,peaks,face').split(',').filter(Boolean);
  if (q.get('mode') === 'lines') { window.__done = { ok: true, stats: await linesRun(ids) }; return; }
  const cell = num('cell', 300);
  const mode = q.get('mode') || 'sheet';
  const { sheet, stats } = mode === 'eval' ? await evalSheet(ids, cell) : await silSheet(ids, cell, num('cols', 4));
  const name = q.get('name') || (mode === 'eval' ? 'sil_eval' : 'sil_masks');
  const res = await (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: sheet.toDataURL('image/jpeg', 0.88) }) })).json();
  window.__done = { ok: true, file: res.file, w: sheet.width, h: sheet.height, stats };
}
main().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
