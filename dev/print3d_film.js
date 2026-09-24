// Print timelapse lab: builds a product from a captured geometry, slices it (toolpath.js) and films
// it (printfilm.js). Driver: node tests/print3d_film.mjs "product=wire;frames=0.05,0.3,1;mp4=1"
//   ?sample=bust&art=lineart&product=wire|plaque|litho|cutter&camera=orbit|printer&format=square|story|wide
//   &seconds=15&fps=30&frames=0.05,0.5,0.99 (film fractions to capture as JPEG)&mp4=1 (encode the film)
//   &gcode=/shots/print3d/slice/lineup_lineart_wire/plate_1.gcode (replay a sliced file instead)
//   &base=#hex&ink=#hex&backdrop=#hex&printer=a2l|p1s|...&ui=1 (open the dialog)
// window.__shots = [{ name, data }], window.__mp4 = base64, window.__done = { ok, info, stats, timings }.
import { buildProduct } from '../js/print3d/products.js';
import { buildToolpath, formatDuration } from '../js/print3d/toolpath.js';
import { parseGcode } from '../js/print3d/gcode.js';
import { createPrintFilm, renderPrintFilm, openPrintTimelapse, FILM_FORMATS } from '../js/print3d/printfilm.js';

const q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const status = s => { $('status').textContent = s; };
const sample = q.get('sample') || 'bust', art = q.get('art') || 'lineart', id = q.get('product') || 'wire';
const format = q.get('format') || 'square', seconds = +(q.get('seconds') || 15), fps = +(q.get('fps') || 30);
const colors = { base: q.get('base') || undefined, ink: q.get('ink') || undefined, backdrop: q.get('backdrop') || undefined };
const tag = q.get('tag') || `${id}_${q.get('camera') || 'orbit'}`;
window.__shots = [];

async function loadGeom() {
  const j = await (await fetch(`/shots/print3d/geom_${sample}_${art}.json`)).json();
  const bin = atob(j.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { ...j.meta, data: new Float32Array(u8.buffer), n: j.meta.n };
}
const artLabel = { lineart: 'Line art', spiral: 'Artistic spiral', real: 'Realistic', contour: 'Contour' }[art] || art;
function productOpts() {
  const o = id === 'wire' ? { stand: true } : {};
  if (id === 'plaque') { if (colors.base) o.plateColor = colors.base; if (colors.ink) o.lineColor = colors.ink; }
  if (id === 'wire' && colors.ink) o.color = colors.ink;
  if (id === 'litho' && colors.base) o.color = colors.base;
  return o;
}

try {
  const timings = {};
  let t0 = performance.now();
  let out = null, tp;
  if (q.get('gcode')) {
    const text = await (await fetch(q.get('gcode'))).text();
    tp = parseGcode(text, { printer: q.get('printer') || undefined });
    timings.parseMs = performance.now() - t0;
  } else {
    const geom = await loadGeom();
    out = buildProduct(id, geom, productOpts());
    timings.buildMs = performance.now() - t0; t0 = performance.now();
    status('slicing...');
    tp = await buildToolpath(out.parts, { settings: out.settings, colors, printer: q.get('printer') || 'a2l', onProgress: f => status(`slicing ${Math.round(f * 100)}%`) });
    timings.toolpathMs = performance.now() - t0;
  }
  $('open').onclick = () => openPrintTimelapse({ parts: out?.parts || [], colors, printer: q.get('printer') || 'a2l', product: out || id, art: `${artLabel} · ${sample}` });
  if (q.get('ui')) {
    window.__dlg = openPrintTimelapse({ parts: out.parts, colors, printer: q.get('printer') || 'a2l', product: out, art: `${artLabel} · ${sample}`, camera: q.get('camera') || 'orbit', format });
    status('dialog open');
    window.__done = { ok: true };
  } else {
    const F = FILM_FORMATS[format];
    const title = out ? out.product?.name || id : 'G-code replay';
    const film = createPrintFilm(tp, { camera: q.get('camera') || 'orbit', seconds, fps, colors, title, subtitle: `${tp.printer.name} · ${tp.filament?.name || 'PETG'} · ${out ? artLabel : q.get('gcode').split('/').slice(-2, -1)[0]}` });
    const still = $('still'); still.width = F.w; still.height = F.h;
    const g = still.getContext('2d');
    // 'c' = the middle of the colour-change slot
    const cmid = (() => { for (let i = 0; i < film.frames; i++) if (film.state(i).phase === 'change') { let j = i; while (j + 1 < film.frames && film.state(j + 1).phase === 'change') j++; return (i + j) / 2 / (film.frames - 1); } return 0.5; })();
    const fr = (q.get('frames') || '0.04,0.12,0.35,0.6,0.85,0.97').split(',').map(v => v === 'c' ? cmid : Number(v));
    t0 = performance.now();
    const perFrame = [];
    for (const f of fr) {
      const i = Math.min(film.frames - 1, Math.max(0, Math.round(f * (film.frames - 1))));
      const a = performance.now();
      const st = film.draw(i, g, F.w, F.h);
      perFrame.push(performance.now() - a);
      window.__shots.push({ name: `film_${tag}_${String(Math.round(f * 100)).padStart(3, '0')}`, data: still.toDataURL('image/jpeg', 0.88), phase: st.phase, t: st.t, layer: st.layer, count: st.count });
    }
    timings.stillsMs = performance.now() - t0; timings.perFrameMs = perFrame.map(x => +x.toFixed(1));
    let mp4 = null;
    if (q.get('mp4')) {
      t0 = performance.now();
      const res = await renderPrintFilm(film, { width: F.w, height: F.h, onProgress: (d, n) => { if (d % 30 === 0) status(`filming ${d}/${n}`); } });
      timings.encodeMs = performance.now() - t0;
      const buf = new Uint8Array(await res.blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      window.__mp4 = btoa(s);
      mp4 = { bytes: res.blob.size, frames: res.frames, fps: res.fps, engine: res.engine, width: res.width, height: res.height };
    }
    status(`${title}: ${tp.layers.length} layers, ${formatDuration(tp.total)}, ${tp.beads.n} beads; film ${film.frames} frames`);
    window.__done = {
      ok: true, info: film.info, mp4, timings,
      stats: { ...tp.stats, total: tp.total, layers: tp.layers.length, box: tp.box, changes: tp.changes, palette: tp.palette, map: { intro: film.map.intro, outro: film.map.outro, slot: film.map.slot, r0: film.map.r0, r1: film.map.r1 } },
    };
  }
} catch (e) {
  console.error(e);
  status('error: ' + (e.stack || e.message || e));
  window.__done = { ok: false, error: String(e.stack || e.message || e) };
}
