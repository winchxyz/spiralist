// Cookie-cutter outlines from the subject silhouette (js/print3d/products.js buildCutter fed with
// js/lineart/silhouette.js), photo | silhouette | cutter footprint per subject, plus the verdict.
//   node tests/shoot.mjs "/dev/lineart_cutter.html?imgs=testset:cat_sitting.jpg,testset:bicycle.jpg;size=90" --port 8851
//   imgs   comma list of testset:<file> (shots/testset/)
//   size   cutter size in mm (90)      geom   print3d geom fixture: real | lineart | spiral (real)
//   cell   px (300)                    name   output (cutter_outlines)
import { CROP_DEFAULTS } from '../js/tone.js';
import { frameCanvas, silhouetteOf } from '../js/lineart/lines.js';
import { buildProduct } from '../js/print3d/products.js';
import { cutterVerdict } from '../js/lineart/index.js';

const q = new URLSearchParams(location.search);
const N = 512, C = +(q.get('cell') || 300), SIZE = +(q.get('size') || 90);

async function loadGeom(kind) {
  const j = await (await fetch(`/shots/print3d/geom_bust_${kind}.json`)).json();
  const bin = atob(j.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { ...j.meta, data: new Float32Array(u8.buffer), n: j.meta.n };
}

function drawRing(g, pts, x0, y0, s, color, w = 2) {
  g.strokeStyle = color; g.lineWidth = w; g.beginPath();
  for (let i = 0; i < pts.length; i += 2) { const X = x0 + pts[i] * s, Y = y0 + pts[i + 1] * s; i ? g.lineTo(X, Y) : g.moveTo(X, Y); }
  g.closePath(); g.stroke();
}

function drawMesh(g, mesh, x0, y0, S, color) {
  const p = mesh.positions, ix = mesh.indices;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < p.length; i += 3) { a = Math.min(a, p[i]); c = Math.max(c, p[i]); b = Math.min(b, p[i + 1]); d = Math.max(d, p[i + 1]); }
  const k = (S - 16) / Math.max(c - a, d - b), ox = x0 + (S - (c - a) * k) / 2, oy = y0 + (S - (d - b) * k) / 2;
  g.fillStyle = color;
  for (let t = 0; t < ix.length; t += 3) {
    g.beginPath();
    for (let v = 0; v < 3; v++) { const q2 = ix[t + v] * 3; const X = ox + (p[q2] - a) * k, Y = oy + (d - p[q2 + 1]) * k; v ? g.lineTo(X, Y) : g.moveTo(X, Y); }
    g.fill();
  }
  return { w: c - a, h: d - b };
}

async function main() {
  const ids = (q.get('imgs') || 'testset:cat_sitting.jpg').split(',');
  const geom = await loadGeom(q.get('geom') || 'real');
  const sheet = document.createElement('canvas');
  sheet.width = C * 3; sheet.height = (C + 70) * ids.length;
  document.body.appendChild(sheet);
  const g = sheet.getContext('2d');
  g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, sheet.width, sheet.height);
  const stats = [];
  for (let r = 0; r < ids.length; r++) {
    const id = ids[r], y0 = r * (C + 70);
    const img = new Image(); img.src = '/shots/testset/' + id.slice(8); await img.decode();
    const bm = await createImageBitmap(img);
    const fc = frameCanvas(bm, { ...CROP_DEFAULTS }, N);
    const sil = await silhouetteOf(fc);
    g.drawImage(fc, 0, y0, C, C);
    g.globalAlpha = 0.35; g.drawImage(fc, C, y0, C, C); g.globalAlpha = 1;
    if (sil?.outlines?.[0]) drawRing(g, sil.outlines[0], C, y0, C, '#0a7cff', 2);
    const v = cutterVerdict(sil);
    let out = null, err = null;
    try { out = buildProduct('cutter', geom, { sizeMm: SIZE, silhouette: sil, stamp: false }); } catch (e) { err = String(e.message || e); }
    let dims = null;
    if (out) { const cp = out.parts.find(p => p.name === 'Cutter'); dims = drawMesh(g, cp.mesh, 2 * C, y0, C, '#e8600f'); }
    g.fillStyle = '#111'; g.font = '13px system-ui';
    const lines = [
      `${id.slice(8)} · ${sil?.kind} c${sil?.confidence} ${sil?.subject || ''} · verdict ${v.ok ? 'OK' : 'OFF'}: ${v.reason || v.note || ''}`.slice(0, 150),
      out ? `${out.printability.notes.find(n => /^Outline/.test(n)) || ''}`.slice(0, 150) : 'error ' + err,
      out ? `cutter X 0-${dims.w.toFixed(1)}, Y 0-${dims.h.toFixed(1)} mm · round ${out.stats.outlineRound ?? '?'} mm · lost ${out.stats.outlineLost ?? '?'} · ${out.printability.ok ? 'prints as is' : 'needs changes: ' + out.printability.issues.join(' | ')}`.slice(0, 160) : '',
    ];
    lines.forEach((t, i) => g.fillText(t, 6, y0 + C + 18 + i * 17));
    stats.push({ id, kind: sil?.kind, conf: sil?.confidence, subject: sil?.subject, verdict: v, round: out?.stats.outlineRound, lost: out?.stats.outlineLost,
      issues: out?.printability.issues, notes: out?.printability.notes.filter(n => /Outline|outline|Flange|fine|ears/i.test(n)), dims, err });
  }
  const name = q.get('name') || 'cutter_outlines';
  const res = await (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: sheet.toDataURL('image/jpeg', 0.88) }) })).json();
  window.__done = { ok: true, file: res.file, stats };
}
main().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
