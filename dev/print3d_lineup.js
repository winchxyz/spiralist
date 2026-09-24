// Lettered line-up of the print products for the user's pick: columns A-D, rows = three arts.
//   /dev/print3d_lineup.html?tile=440   (driver: node tests/print3d_lineup_shot.mjs)
// Rebuilds each product in the page with the same options as tests/print3d_lineup.mjs, renders it
// with js/print3d/view.js and labels it from shots/print3d/lineup_report.json (sizes, Bambu Studio
// slice time and grams, printability). window.__shots = [{ name, data }], window.__done = { ok, cells }.
import { PRODUCTS, buildProduct } from '../js/print3d/products.js';
import { createViewer } from '../js/print3d/view.js';

const q = new URLSearchParams(location.search);
const TW = +(q.get('tile') || 440), TH = Math.round(TW * 0.75), LAB = 100, GAP = 12, ROWH = 250, HEAD = 104;
const ARTS = [
  { key: 'spiral', sample: 'bust', kind: 'spiral', label: 'Artistic spiral', sub: 'plaster bust' },
  { key: 'lineart', sample: 'bust', kind: 'lineart', label: 'Line art (Matisse)', sub: 'plaster bust' },
  { key: 'catreal', sample: 'cat', kind: 'real', label: 'Realistic squiggle', sub: 'cat' },
].filter(a => !q.get('arts') || q.get('arts').split(',').includes(a.key));
const IDS = (q.get('products') || PRODUCTS.map(p => p.id).join(',')).split(',');
const LINEUP_OPTS = { wire: { stand: true }, ...JSON.parse(q.get('opts') || '{}') };
const $ = id => document.getElementById(id);
const status = s => { $('status').textContent = s; };
const FONT = 'system-ui, "Segoe UI", sans-serif';

async function loadGeom(sample, kind) {
  const j = await (await fetch(`/shots/print3d/geom_${sample}_${kind}.json`)).json();
  const bin = atob(j.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { ...j.meta, data: new Float32Array(u8.buffer), n: j.meta.n };
}
const report = await fetch('/shots/print3d/lineup_report.json').then(r => r.json()).catch(() => ({ cells: [] }));
const cellOf = (art, id) => report.cells.find(c => c.art === art && c.id === id);

// the drawing itself, small, for the row header
function drawArt(geom, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf7'; g.fillRect(0, 0, w, h);
  const d = geom.data, n = geom.n;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const x = d[i * 7], y = d[i * 7 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const s = Math.min((w - 12) / (x1 - x0), (h - 12) / (y1 - y0)), ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
  g.strokeStyle = '#1e1e24'; g.lineCap = 'round'; g.lineJoin = 'round';
  const step = Math.max(1, Math.floor(n / 60000));
  for (let i = step; i < n; i += step) {
    const a = (i - step) * 7, b = i * 7;
    g.lineWidth = Math.max(0.25, d[b + 2] * s);
    g.beginPath(); g.moveTo(ox + (d[a] - x0) * s, oy + (d[a + 1] - y0) * s); g.lineTo(ox + (d[b] - x0) * s, oy + (d[b + 1] - y0) * s); g.stroke();
  }
  return c;
}

const bb = m => { const P = m.positions, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < P.length; i++) { const k = i % 3; if (P[i] < lo[k]) lo[k] = P[i]; if (P[i] > hi[k]) hi[k] = P[i]; } return { lo, hi }; };
function displayPose(id, out) {
  // the wire is printed flat; the photo shows it standing in its slotted stand (same as dev/print3d_view.js)
  if (id !== 'wire') return;
  const stand = out.parts.find(x => /stand/i.test(x.name));
  for (const part of out.parts) if (/wire/i.test(part.name) && stand) {
    const w = bb(part.mesh), cx = (w.lo[0] + w.hi[0]) / 2, cy = (w.lo[1] + w.hi[1]) / 2, th = w.hi[2] - w.lo[2];
    const sb = bb(stand.mesh);
    part.pose = { rx: 90, t: [(sb.lo[0] + sb.hi[0]) / 2 - cx, (sb.lo[1] + sb.hi[1]) / 2 - cy + th / 2, (sb.hi[2] - sb.lo[2]) * 0.35] };
  }
}

const canvas = document.createElement('canvas'); canvas.width = TW; canvas.height = TH;
const viewer = createViewer(canvas, {});
function shot(parts, o) {
  viewer.setParts(parts);
  const base = viewer.suggestView();
  return viewer.capture({ width: TW, height: TH, bed: 'pei', backlit: false, zoom: 1, ...base, ...o });
}

const fmtMin = m => m == null ? null : m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
const range = p => `X 0-${p.x}, Y 0-${p.y}, Z 0-${p.z} mm`;

const tiles = [], rowArt = [], cells = [];
const t0 = performance.now();
for (const art of ARTS) {
  const geom = await loadGeom(art.sample, art.kind);
  rowArt.push(drawArt(geom, 200, 200));
  for (const id of IDS) {
    status(`building ${id} for ${art.key}...`);
    await new Promise(r => setTimeout(r, 0));
    const out = buildProduct(id, geom, LINEUP_OPTS[id] || {});
    displayPose(id, out);
    let img, inset = null;
    if (id === 'litho') {
      // the reveal is the product: backlit as the photo, front-lit ("by day") as the inset
      img = shot(out.parts, { backlit: true, yaw: -8, pitch: 12, bed: 'dark' });
      const small = shot(out.parts, { yaw: -30, pitch: 18 });
      inset = small;
    } else if (id === 'cutter') img = shot(out.parts, { pitch: 52, yaw: -24 });
    else if (id === 'wire') img = shot(out.parts, { yaw: -20, pitch: 14 });
    else img = shot(out.parts, id === 'plaque' ? { pitch: +(q.get('plaquePitch') || 60), yaw: -20 } : {});
    // copy (the viewer's capture canvas is reused)
    const keep = c => { const k = document.createElement('canvas'); k.width = c.width; k.height = c.height; k.getContext('2d').drawImage(c, 0, 0); return k; };
    tiles.push({ art, id, out, img: keep(img), inset: inset ? keep(inset) : null });
    cells.push({ art: art.key, id, ok: out.printability.ok, sizeMm: out.sizeMm });
  }
}

// ---- the sheet
const sheet = $('sheet');
const W = ROWH + IDS.length * (TW + GAP) + GAP, H = HEAD + ARTS.length * (TH + LAB + GAP) + 40;
sheet.width = W; sheet.height = H;
const g = sheet.getContext('2d');
g.fillStyle = '#e9e7e2'; g.fillRect(0, 0, W, H);
g.fillStyle = '#1d1d21'; g.font = `700 28px ${FONT}`;
g.fillText('Spiralist 3D prints: pick a product', 20, 40);
g.font = `15px ${FONT}`; g.fillStyle = '#55544f';
g.fillText(`Sliced headless in Bambu Studio for your Bambu Lab A2L (0.4 nozzle, 0.20 mm Standard, Bambu PETG Basic). No supports anywhere. Sizes are per part, print axes (X right, Y back, Z up).`, 20, 64);
IDS.forEach((id, c) => {
  const p = PRODUCTS.find(x => x.id === id), x = ROWH + GAP + c * (TW + GAP);
  g.fillStyle = '#1d1d21'; g.font = `800 30px ${FONT}`; g.fillText(p.letter, x, 96);
  g.font = `700 20px ${FONT}`; g.fillText(p.name, x + 30, 95);
});
ARTS.forEach((art, r) => {
  const y = HEAD + r * (TH + LAB + GAP);
  g.drawImage(rowArt[r], 20, y + 6, 200, 200);
  g.strokeStyle = '#cfccc4'; g.lineWidth = 1; g.strokeRect(20.5, y + 6.5, 199, 199);
  g.fillStyle = '#1d1d21'; g.font = `700 17px ${FONT}`; g.fillText(art.label, 20, y + 230);
  g.font = `14px ${FONT}`; g.fillStyle = '#55544f'; g.fillText(art.sub, 20, y + 249);
});
function wrap(text, maxW) {
  const words = text.split(' '), lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
}
for (const t of tiles) {
  const c = IDS.indexOf(t.id), r = ARTS.indexOf(t.art);
  const x = ROWH + GAP + c * (TW + GAP), y = HEAD + r * (TH + LAB + GAP);
  g.drawImage(t.img, x, y, TW, TH);
  if (t.inset) {
    const iw = Math.round(TW * 0.34), ih = Math.round(TH * 0.34);
    g.drawImage(t.inset, x + TW - iw - 8, y + 8, iw, ih);
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x + TW - iw - 8, y + 8, iw, ih);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `12px ${FONT}`; g.fillText('unlit', x + TW - iw - 4, y + ih + 4);
    g.fillStyle = 'rgba(255,255,255,.9)'; g.fillText('lit from behind', x + 10, y + TH - 10);
  }
  const rep = cellOf(t.art.key, t.id);
  g.fillStyle = '#fbfaf7'; g.fillRect(x, y + TH, TW, LAB);
  const parts = t.out.stats.partsMm;
  const main = parts[0];
  g.fillStyle = '#1d1d21'; g.font = `600 13px ${FONT}`;
  g.fillText(`${main.name}: ${range(main)}`, x + 10, y + TH + 18);
  g.font = `12px ${FONT}`; g.fillStyle = '#55544f';
  g.fillText(secondLine(t), x + 10, y + TH + 34);
  const sl = rep?.slice;
  g.font = `600 13px ${FONT}`; g.fillStyle = '#1d1d21';
  g.fillText(sl ? (sl.ok ? `Slicer: ${fmtMin(sl.minutes)} · ${sl.grams} g PETG${rep.manifoldOk ? ' · watertight' : ' · MESH NOT WATERTIGHT'}` : `Slicer FAILED: ${sl.error}`) : 'not sliced', x + 10, y + TH + 51);
  const ok = t.out.printability.ok && (!sl || sl.ok) && rep?.manifoldOk !== false;
  const v = verdictOf(t, ok);
  g.fillStyle = v.color; g.font = `600 12px ${FONT}`;
  wrap(v.text, TW - 20).slice(0, 3).forEach((l, i) => g.fillText(l, x + 10, y + TH + 68 + i * 15));
  // tag on the photo
  g.font = `800 13px ${FONT}`;
  const tw = g.measureText(v.tag).width + 18;
  g.fillStyle = v.color; g.fillRect(x + 8, y + 8, tw, 24);
  g.fillStyle = '#fff'; g.fillText(v.tag, x + 17, y + 25);
}

// The other parts, sized from the meshes as placed on the bed (axes with ranges).
function secondLine(t) {
  const f = v => Math.round(v * 10) / 10;
  const box = re => { const ps = t.out.parts.filter(p => re.test(p.name)); if (!ps.length) return null; const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (const p of ps) { const b = bb(p.mesh); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.lo[k]); hi[k] = Math.max(hi[k], b.hi[k]); } } return { lo, hi, n: ps.length }; };
  const sz = b => `X 0-${f(b.hi[0] - b.lo[0])}, Y 0-${f(b.hi[1] - b.lo[1])}, Z 0-${f(b.hi[2] - b.lo[2])} mm`;
  if (t.id === 'plaque') { const l = box(/^line/i), s = box(/stand/i), s1 = t.out.parts.find(p => /stand/i.test(p.name)); return `+ Line raised Z ${f(l.lo[2])}-${f(l.hi[2])} mm; ${s ? `${s.n} feet, each ${sz(bb(s1.mesh))}` : ''}`; }
  if (t.id === 'wire') { const s = box(/stand/i); return s ? `+ Stand ${sz(s)}` : ''; }
  if (t.id === 'cutter') { const s = box(/stamp (base|plate|relief)/i), h = box(/handle/i); return `+ Stamp ${sz(s)}${h ? `; handle ${sz(h)}` : ''}`; }
  if (t.id === 'litho') return 'Panel 0.8-3.2 mm thick by darkness; foot 6 mm tall, 14 mm deep (Y 0-14)';
  return '';
}

// Short verdict per tile: what the user must know. Tag = look + printability (green / amber / red).
function verdictOf(t, ok) {
  const id = t.id, art = t.art.key, out = t.out;
  const G = '#2e6b3a', A = '#a4600c', R = '#b3261e';
  if (!ok) {
    if (id === 'wire') return { tag: 'NOT AS IS', color: R, text: 'Fuses into a solid disc: a wire needs an open drawing (Line art or Contour).' };
    if (id === 'cutter') return { tag: 'NOT AS IS', color: R, text: 'Cutter is only a circle (stand-in outline = the drawing\'s disc) and the stamp fuses flat.' };
    if (id === 'plaque') return { tag: 'NOT AS IS', color: R, text: `Line covers ${out.printability.issues[0].match(/\d+%/)?.[0] || 'most'} of the picture and fuses solid at 150 mm; needs 330 mm+ (bed is 330). Choose C.` };
    return { tag: 'NOT AS IS', color: R, text: out.printability.issues?.[0] || 'see notes' };
  }
  if (id === 'plaque') {
    const faint = art === 'spiral';
    return { tag: faint ? 'PRINTS · FAINT' : 'PRINTS AS IS', color: faint ? A : G,
      text: (faint ? 'Rebuilt 72 → 30 rings so they print; the face only reads faintly. ' : '') + `2 colours: pause at Z ${out.settings.colorChangeAtMm} mm (feet then two-tone: print them apart) or AMS slot for Line.` };
  }
  if (id === 'litho') return { tag: 'PRINTS AS IS', color: G, text: 'Prints standing on its foot, brim on. White PETG, 100% infill. Plain white until lit from behind.' };
  if (id === 'wire') return { tag: 'PRINTS AS IS', color: G, text: 'Prints flat as one piece, 100% infill; hangs from its loop or stands in the separate slotted stand.' };
  if (id === 'cutter') return { tag: 'PRINTS AS IS', color: G, text: 'Stand-in head outline until the silhouette lands. Handle press-fit untested. Hand wash; baked dough only.' };
  return { tag: 'PRINTS AS IS', color: G, text: 'Printable as is.' };
}
g.font = `12px ${FONT}`; g.fillStyle = '#6b6a66';
g.fillText('Renders: js/print3d/view.js (PETG material, textured PEI plate 330 x 320 mm). Wire shown standing in its printed stand; it prints flat. Lithophane: large = light behind it, inset = room light.', 20, H - 14);

status(`${tiles.length} tiles in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
window.__shots = [{ name: 'lineup', data: sheet.toDataURL('image/jpeg', 0.9) }];
for (const t of tiles) window.__shots.push({ name: `lineup_tile_${t.art.key}_${t.id}`, data: t.img.toDataURL('image/jpeg', 0.9) });
window.__done = { ok: tiles.length === ARTS.length * IDS.length, reportCells: report.cells.length, cells };
