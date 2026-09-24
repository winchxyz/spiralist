// Dev line-up of the print products (js/print3d/products.js) on real app drawings.
//   /dev/print3d_products.html?geoms=lineart,spiral,real,contour;products=plaque,wire,litho,cutter;save=1;tile=520
// Drawings come from tests/print3d_capture.mjs (shots/print3d/geom_<sample>_<kind>.json).
// Renders each build with js/print3d/view.js (falls back to a flat top view), composes a lettered
// sheet (rows = drawings, columns = A..D) and, with save=1, posts it to /__shot as
// print3d_products_sheet. window.__done = { ok, builds: [{ tag, sizeMm, ok, notes }] }.
import { PRODUCTS, buildProduct } from '../js/print3d/products.js';

const q = new URLSearchParams(location.search);
const geoms = (q.get('geoms') || 'lineart,spiral,real,contour').split(',');
const ids = (q.get('products') || PRODUCTS.map(p => p.id).join(',')).split(',');
const sample = q.get('sample') || 'bust';
const TW = +(q.get('tile') || 520), TH = Math.round(TW * 0.72), LAB = 64;
const $ = id => document.getElementById(id);
const status = s => { $('status').textContent = s; };
const MODE0 = { lineart: 'Line art (Matisse)', spiral: 'Artistic spiral', real: 'Realistic squiggle', contour: 'Artistic contour', wander: 'Artistic wander' };
const MODE = new Proxy(MODE0, { get: (o, k) => { const [s, m] = String(k).includes('_') ? String(k).split('_') : [null, k]; return (o[m] || m) + (s ? ` (${s})` : ''); } });

async function loadGeom(kind) {
  // 'lineart' = the default sample's drawing; 'cat_lineart' = another captured sample
  const file = kind.includes('_') ? kind : `${sample}_${kind}`;
  const j = await (await fetch(`/shots/print3d/geom_${file}.json`)).json();
  const bin = atob(j.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { ...j.meta, data: new Float32Array(u8.buffer), n: j.meta.n };
}

let V = null, viewer = null;
try { V = await import('../js/print3d/view.js'); } catch (e) { console.warn('view.js unavailable:', e.message); }

function flatTop(parts, w, h) {
  // fallback: parts' triangles from above, painter's order by height
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#d6d9dc'; g.fillRect(0, 0, w, h);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) { const P = p.mesh.positions; for (let i = 0; i < P.length; i += 3) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]); } }
  const s = Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.92, ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
  for (const p of parts) {
    const P = p.mesh.positions, T = p.mesh.indices; g.fillStyle = p.color;
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], cc = 3 * T[t + 2];
      if (P[a + 2] < 0.01 && P[b + 2] < 0.01 && P[cc + 2] < 0.01) continue;
      g.beginPath();
      for (const v of [a, b, cc]) g.lineTo(ox + (P[v] - x0) * s, h - (oy + (P[v + 1] - y0) * s));
      g.fill();
    }
  }
  return c;
}

function render(parts, w, h, opts = {}) {
  if (V) {
    try {
      if (!viewer) { const c = document.createElement('canvas'); c.width = w; c.height = h; viewer = V.createViewer(c, {}); }
      viewer.setParts(parts);
      viewer.set({ yaw: -28, pitch: 42, bed: 'pei', backlit: false, zoom: 1, ...opts });
      return viewer.capture({ width: w, height: h });
    } catch (e) { console.warn('view render failed:', e.message); }
  }
  return flatTop(parts, w, h);
}

const builds = [];
const tiles = [];
let t0 = performance.now();
for (const kind of geoms) {
  let geom;
  try { geom = await loadGeom(kind); } catch (e) { console.warn('no drawing', kind, e.message); continue; }
  for (const id of ids) {
    status(`building ${id} from ${kind}...`);
    await new Promise(r => setTimeout(r, 0));
    let out;
    try { out = buildProduct(id, geom, {}); } catch (e) { console.error(id, kind, e); builds.push({ tag: `${id}_${kind}`, ok: false, error: e.message }); continue; }
    const img = render(out.parts, TW, TH, id === 'litho' ? { yaw: -35, pitch: 18 } : id === 'cutter' ? { pitch: 50 } : {});
    let inset = null;
    if (id === 'litho') {
      // the same panel lying flat, lit from behind: what it looks like on a window
      try {
        const flat = buildProduct('litho', geom, { orient: 'flat' });
        inset = render(flat.parts, Math.round(TW * 0.42), Math.round(TW * 0.42), { yaw: 0, pitch: 89, backlit: true, bed: false });
      } catch (e) { console.warn('backlit', e.message); }
    }
    builds.push({ tag: `${id}_${kind}`, sizeMm: out.sizeMm, parts: out.stats.partsMm, ok: out.printability.ok, notes: out.printability.notes, triangles: out.stats.triangles, ms: out.stats.ms });
    tiles.push({ kind, id, out, img, inset });
    // card
    const card = document.createElement('div'); card.className = 'card';
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; cv.getContext('2d').drawImage(img, 0, 0);
    if (inset) cv.getContext('2d').drawImage(inset, cv.width - inset.width - 8, 8);
    const s = out.sizeMm;
    card.append(cv);
    card.insertAdjacentHTML('beforeend', `<h2>${out.product.letter} ${out.product.name} <span class="size">${MODE[kind] || kind}</span></h2>
      <div class="size">bed X 0-${s.x[1]} mm, Y 0-${s.y[1]} mm, Z 0-${s.z[1]} mm, ${out.parts.length} part(s), ${out.stats.triangles} triangles,
      <b class="${out.printability.ok ? 'ok' : 'bad'}">${out.printability.ok ? 'printable' : 'not printable as is'}</b></div>
      <ul>${out.printability.notes.map(n => `<li>${n}</li>`).join('')}</ul>`);
    $('grid').append(card);
  }
}

// lettered sheet: rows = drawings, columns = products
const rows = [...new Set(tiles.map(t => t.kind))], cols = ids;
const sheet = $('sheet');
const pad = 14, head = 46;
sheet.width = pad + cols.length * (TW + pad);
sheet.height = head + rows.length * (TH + LAB + pad) + pad;
const g = sheet.getContext('2d');
g.fillStyle = '#ecebe7'; g.fillRect(0, 0, sheet.width, sheet.height);
g.fillStyle = '#1d1d21'; g.font = '600 22px system-ui, sans-serif';
g.fillText('Spiralist 3D-print products (Bambu A2L, 0.4 nozzle, 0.2 mm layers, PETG)', pad, 30);
for (const t of tiles) {
  const c = cols.indexOf(t.id), r = rows.indexOf(t.kind);
  const x = pad + c * (TW + pad), y = head + r * (TH + LAB + pad);
  g.drawImage(t.img, x, y, TW, TH);
  if (t.inset) { g.drawImage(t.inset, x + TW - t.inset.width - 8, y + 8); g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x + TW - t.inset.width - 8, y + 8, t.inset.width, t.inset.height); }
  g.fillStyle = '#fbfaf7'; g.fillRect(x, y + TH, TW, LAB);
  g.fillStyle = '#1d1d21'; g.font = '700 20px system-ui, sans-serif';
  g.fillText(`${t.out.product.letter}  ${t.out.product.name}`, x + 10, y + TH + 24);
  g.font = '13px system-ui, sans-serif'; g.fillStyle = '#55544f';
  const s = t.out.sizeMm, main = t.out.stats.partsMm[0];
  g.fillText(`${MODE[t.kind] || t.kind} · ${main.name} X 0-${main.x}, Y 0-${main.y}, Z 0-${main.z} mm · ${t.out.parts.length} part(s)`, x + 10, y + TH + 43);
  g.fillStyle = t.out.printability.ok ? '#2e6b3a' : '#b3261e';
  const first = t.out.printability.ok ? 'printable, no supports' : (t.out.printability.issues?.[0] || 'not printable as is');
  g.fillText(first.length > 78 ? first.slice(0, 76) + '...' : first, x + 10, y + TH + 59);
}
status(`${builds.length} builds in ${((performance.now() - t0) / 1000).toFixed(1)} s${V ? '' : ' (flat previews: view.js missing)'}`);
let saved = null;
if (q.get('save')) {
  const data = sheet.toDataURL('image/jpeg', 0.9);
  saved = await (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: q.get('name') || 'print3d_products_sheet', data }) })).json().catch(e => ({ error: e.message }));
}
window.__done = { ok: builds.length > 0 && builds.every(b => !b.error), view: !!V, saved, builds };
