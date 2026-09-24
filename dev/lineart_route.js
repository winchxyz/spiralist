// Line art ROUTE line-up: silhouette-first drawings, the four styles (A-D) x subjects, end to end
// through the app's engine (LineArtEngine.lines, then .build in its Worker) and the real renderer,
// with the silhouette score under each cell.
//   node tests/shoot.mjs "/dev/lineart_route.html?imgs=bust,cat;sil=auto;name=route_samples" --timeout 900000
//   vars   letters (ABCD); add M for a first column with the photo and its silhouette
//   imgs   comma list: bust, cat, moon, peaks, face (samples) or ts:<file> (shots/testset/<file>)
//   sil    auto (features.silhouette, else silhouette.js, else the stand-in) | seg | standin | off
//   base   1 = draw the old way (edges only), scored against the same silhouette
//   size   cell px (928)   name  output name (route_lineup)   seed  hand seed   tap x,y (frame fractions)
import { Renderer } from '../js/renderer.js';
import { CROP_DEFAULTS } from '../js/tone.js';
import { brushById, paperById } from '../js/materials.js';
import { LineArtEngine, LINE_STYLES, LAYOUT_R, standinSilhouette } from '../js/lineart/index.js';
import { frameCanvas } from '../js/lineart/lines.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? +q.get(k) : d);

const SUBJECTS = {
  bust: { sample: 'bust', crop: CROP_DEFAULTS },
  cat: { sample: 'cat', crop: CROP_DEFAULTS },
  moon: { sample: 'moon', crop: CROP_DEFAULTS },
  peaks: { sample: 'peaks', crop: CROP_DEFAULTS },
  face: { sample: 'bust', crop: { x: 0.5, y: 0.4, zoom: 1.55, rotation: 0 } },
};

const fmtT = s => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${Math.round(s)} s`);

let segMod;
async function segSilhouette(src, crop, face) {
  if (segMod === undefined) {
    try { segMod = await import('../js/lineart/silhouette.js'); } catch (e) { segMod = null; console.warn('no silhouette.js yet: ' + e.message); }
  }
  if (!segMod || !segMod.silhouette) return null;
  const tap = q.get('tap') ? q.get('tap').split(',').map(Number) : null;
  return segMod.silhouette(frameCanvas(src, crop, 512), { tap, kindHint: face ? 'portrait' : undefined, landmarks: face && face.landmarks ? face.landmarks : undefined });
}

async function loadSource(id) {
  if (id.startsWith('ts:')) {
    const r = await fetch('/shots/testset/' + id.slice(3));
    if (!r.ok) throw new Error('missing test photo ' + id);
    return createImageBitmap(await r.blob());
  }
  const { makeSample } = await import('../js/samples.js');
  return makeSample(SUBJECTS[id].sample, 1024);
}

/** The photo's frame with the silhouette's mask tinted and its outlines drawn. */
function maskCell(src, crop, sil, size) {
  const c = frameCanvas(src, crop, size), g = c.getContext('2d');
  if (!sil) return c;
  if (sil.mask) {
    const { w, h, data } = sil.mask, m = new OffscreenCanvas(w, h), mg = m.getContext('2d'), id = mg.createImageData(w, h);
    for (let k = 0; k < w * h; k++) { id.data[4 * k] = 255; id.data[4 * k + 1] = 40; id.data[4 * k + 2] = 90; id.data[4 * k + 3] = data[k] > 127 ? 90 : 0; }
    mg.putImageData(id, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(m, 0, 0, size, size);
  }
  g.lineWidth = 3; g.strokeStyle = '#00d0ff';
  for (const o of sil.outlines || []) {
    g.beginPath();
    for (let k = 0; k < o.length; k += 2) g[k ? 'lineTo' : 'moveTo'](o[k] * size, o[k + 1] * size);
    g.closePath(); g.stroke();
  }
  if (sil.skyline) {
    g.strokeStyle = '#ffd000'; g.beginPath();
    for (let k = 0; k < sil.skyline.length; k += 2) g[k ? 'lineTo' : 'moveTo'](sil.skyline[k] * size, sil.skyline[k + 1] * size);
    g.stroke();
  }
  g.fillStyle = '#fff'; g.font = 'bold 22px system-ui'; g.fillText(`${sil.kind || '?'} ${sil.standin ? '(stand-in)' : ''} ${sil.confidence != null ? (+sil.confidence).toFixed(2) : ''} · ${(sil.outlines || []).length} outlines${sil.why ? ' · ' + sil.why : ''}`, 10, 30, size - 20);
  return c;
}

async function run() {
  const letters = (q.get('vars') || 'ABCD').split('');
  const imgs = (q.get('imgs') || 'bust,cat,moon,face').split(',');
  const silMode = q.get('sil') || 'auto';
  const size = num('size', 928);
  const HEAD = 92, FOOT = 62, GAP = 10, cell = size;
  const sheet = document.createElement('canvas');
  sheet.width = letters.length * (cell + GAP) + GAP;
  sheet.height = HEAD + imgs.length * (cell + FOOT + GAP) + GAP;
  const g = sheet.getContext('2d');
  g.fillStyle = '#d9d6cf'; g.fillRect(0, 0, sheet.width, sheet.height);
  const r = new Renderer(document.createElement('canvas'));
  r.setSize(size, size);
  r.setLayout({ cx: 0.5, cy: 0.5, r: LAYOUT_R });
  const eng = new LineArtEngine();
  eng.keepInk = true;          // the model's own line map, for the stand-in silhouette
  const byLetter = Object.fromEntries(LINE_STYLES.map(s => [s.letter, s]));
  const stats = [];
  letters.forEach((L, ci) => {
    const x = GAP + ci * (cell + GAP);
    g.fillStyle = '#111'; g.font = 'bold 44px system-ui';
    if (L === 'M') { g.fillText('M', x + 6, 50); g.font = 'bold 28px system-ui'; g.fillText(`photo + silhouette (${silMode})`, x + 52, 46); return; }
    const V = byLetter[L];
    g.fillText(L, x + 6, 50);
    g.font = 'bold 28px system-ui'; g.fillText(V.name, x + 52, 46);
    g.font = `${cell < 700 ? 13 : 17}px system-ui`; g.fillStyle = '#333';
    g.fillText('silhouette first · ' + V.blurb, x + 8, 78, cell - 12);
  });
  for (let ri = 0; ri < imgs.length; ri++) {
    const id = imgs[ri];
    const S = SUBJECTS[id] || { crop: CROP_DEFAULTS };
    let src;
    try { src = await loadSource(id); } catch (e) { console.warn(String(e)); continue; }
    const silCache = new Map();
    for (let ci = 0; ci < letters.length; ci++) {
      const L = letters[ci];
      const x = GAP + ci * (cell + GAP), y = HEAD + GAP + ri * (cell + FOOT + GAP);
      const V = byLetter[L] || byLetter.B;
      const t0 = performance.now();
      const lines = await eng.lines(src, S.crop, { detail: V.defaults.detail, silhouette: silMode === 'auto' || silMode === 'seg' });
      const tEx = performance.now() - t0;
      const face = lines.features && lines.features.face;
      let sil = null;
      if (silMode !== 'off') {
        const key = V.defaults.detail;
        if (silCache.has(key)) sil = silCache.get(key);
        else {
          if (silMode !== 'standin') sil = (lines.features && lines.features.silhouette) || await segSilhouette(src, S.crop, face).catch(e => { console.warn('silhouette failed: ' + e.message); return null; });
          if (!sil && silMode !== 'seg') sil = standinSilhouette(lines.strokes, { face, ink: lines.ink, inkN: lines.N });
          silCache.set(key, sil);
        }
      }
      if (L === 'M') {
        g.drawImage(maskCell(src, S.crop, sil, cell), x, y, cell, cell);
        continue;
      }
      const sheetMm = 210;
      const lr = { ...lines, features: { ...lines.features, silhouette: sil || undefined } };
      // base=1: the old route (no silhouette), scored against the same silhouette
      const geom = await eng.build(V.id, lr, { sheetMm, seed: num('seed', 3), silhouette: sil && q.get('base') !== '1' ? true : 'off' }, { tag: null });
      r.setSheetMm(sheetMm);
      r.setPaper(paperById(V.paper), 1);
      r.setStyle({ brush: brushById(V.tool), ink: V.ink, cover: false, photoColor: false });
      r.setGeometry(geom, { pacing: 'natural' });
      r.render(Infinity);
      g.drawImage(r.canvas, x, y, cell, cell);
      const la = geom.lineart, sc = la.silScore;
      const fs = cell < 700 ? 15 : 19;
      g.fillStyle = '#111'; g.font = `bold ${fs + 1}px system-ui`;
      g.fillText(`${L} · ${id}  ·  ${la.lengthM} m  ·  ${fmtT(la.handSeconds)}  ·  sil ${sc ? `${sc.score} (IoU ${sc.iou}, edge ${sc.cover})` : '-'}`, x + 6, y + cell + fs + 8, cell - 12);
      g.font = `${fs - 1}px system-ui`; g.fillStyle = '#333';
      g.fillText(`new ${la.drawnM} · retraced ${la.retracedM} (${Math.round(100 * (la.retraceShare || 0))}%) · bridges ${la.bridgesM}${la.hatchM ? ' · hatch ' + la.hatchM : ''} m · ${la.strokes} lines · ${sil ? (sil.standin ? 'stand-in' : sil.kind) : 'no silhouette'}`, x + 6, y + cell + 2 * fs + 14, cell - 12);
      stats.push({ v: L, img: id, sil: sil ? (sil.standin ? 'standin' : sil.kind) : null, score: sc, lengthM: la.lengthM, drawnM: la.drawnM, retracedM: la.retracedM, retraceShare: la.retraceShare, bridgesM: la.bridgesM, hand: Math.round(la.handSeconds), used: la.strokes, dropped: la.dropped, face: !!face, linesMs: Math.round(tEx), buildMs: la.buildMs });
    }
  }
  const name = q.get('name') || 'route_lineup';
  const res = await (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: sheet.toDataURL('image/jpeg', 0.88) }) })).json();
  window.__done = { ok: true, file: res.file || name, w: sheet.width, h: sheet.height, stats };
}
run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
