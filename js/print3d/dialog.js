// The 3D print dialog: pick a product (A relief plaque, B wire sculpture, C lithophane, D cookie
// cutter + stamp), see it on the printer's bed in 3D, choose the filament colours, check that it
// prints, and save a 3MF (multi-part, coloured, Bambu/Orca filament slots) or STL files.
// Meshes are built in ./worker.js so the page never freezes. 'Watch it print' hands the parts to
// ./printfilm.js (the print timelapse) when that module is present.
//
//   createPrint3DDialog(ctx) -> { open(), close(), state, debug }
//   ctx: { geom, mode ('artistic' | 'realistic' | 'lineart'), photoName, field (Artistic darkness
//          field), silhouette(): Promise<features.silhouette | null> }

import { PRODUCTS } from './products.js';
// the products the app offers: the relief plaque and the wire sculpture (the lithophane and the
// cookie cutter builders stay in products.js for the lab, but they did not look good enough to offer)
const OFFERED = PRODUCTS.filter(p => p.id === 'plaque' || p.id === 'wire');
import { createViewer, attachOrbit, prepareMesh } from './view.js';
import * as P from './presets.js';
import { cutterVerdict } from '../lineart/index.js';

const $ = id => document.getElementById(id);
const r1 = v => Math.round(v * 10) / 10;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const slug = s => String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const SIZE = {   // mm: the longest side of the art (lithophane: of the panel)
  plaque: { min: 80, max: 300, step: 10, def: 150 },
  wire: { min: 100, max: 300, step: 10, def: 180 },
  litho: { min: 60, max: 200, step: 10, def: 100 },
  cutter: { min: 50, max: 160, step: 5, def: 90 },
};

const OPTIONS = {
  plaque: [
    { id: 'frame', label: 'Frame', seg: [['0', 'None'], ['3', 'Thin'], ['5', 'Standard']], def: '5' },
    { id: 'mount', label: 'Stand or hang', seg: [['feet', 'Two feet'], ['holes', 'Hanging holes'], ['none', 'Neither']], def: 'feet' },
    { id: 'twoColour', label: 'Two colours by', seg: [['ams', 'Two filaments (AMS)'], ['swap', 'Swap after Z 2.4 mm']], def: 'ams' },
  ],
  wire: [
    { id: 'lineMm', label: 'Wire thickness', seg: [['1.2', '1.2 mm'], ['1.6', '1.6 mm'], ['2', '2.0 mm']], def: '1.6' },
    { id: 'loop', label: 'Hanging loop', toggle: true, def: true },
    { id: 'stand', label: 'Slotted stand', toggle: true, def: false },
  ],
  litho: [
    { id: 'minMm', label: 'Thinnest (brightest)', seg: [['0.6', '0.6 mm'], ['0.8', '0.8 mm'], ['1', '1.0 mm']], def: '0.8' },
    { id: 'maxMm', label: 'Thickest (darkest)', seg: [['2.4', '2.4 mm'], ['3.2', '3.2 mm'], ['4', '4.0 mm']], def: '3.2' },
    { id: 'frameMm', label: 'Frame', seg: [['0', 'None'], ['1.5', 'Thin'], ['3', 'Wide']], def: '1.5' },
    { id: 'orient', label: 'Printed', seg: [['standing', 'Standing (finer)'], ['flat', 'Flat']], def: 'standing' },
  ],
  cutter: [
    { id: 'wallMm', label: 'Cutter height', seg: [['10', '10 mm'], ['12', '12 mm'], ['15', '15 mm']], def: '12' },
    { id: 'stamp', label: 'Stamp with the drawing', toggle: true, def: true },
    { id: 'handle', label: 'Push-fit handle', toggle: true, def: true },
  ],
};

/** What kind of drawing: 'real', 'lineart', or the Artistic path ('spiral', 'wander', 'contour', 'maze'). */
export function artKind(geom) {
  if (!geom) return null;
  if (geom.real) return 'real';
  if (geom.lineart || geom.path === 'lineart') return 'lineart';
  return geom.path || 'spiral';
}

const DENSE = { spiral: 1, wander: 1, maze: 1, real: 1 };

/**
 * Which products print well for this kind of drawing (from the prototype slices: Line art and
 * Contour print as all four; dense drawings fuse as a wire and, for Realistic, as a plaque).
 * -> { [id]: { ok, best, reason, suggest, note } }
 */
export function availability(kind, sil) {
  const dense = !!DENSE[kind];
  const a = {
    plaque: { ok: kind !== 'real', reason: kind === 'real' ? 'Realistic lines pack so tightly that, at any size that fits a bed, they fuse into one solid block.' : '',
      suggest: null,
      note: kind === 'spiral' ? 'The spiral is rebuilt with fewer, wider rings so they print apart; the face reads more faintly than on screen.'
        : kind === 'wander' || kind === 'maze' ? 'The tight turns of this path fuse into a textured relief at this size.' : '' },
    wire: { ok: !dense, reason: dense ? 'A dense line fuses into a solid disc when printed as one wire.' : '', suggest: dense && kind !== 'real' ? 'plaque' : null,
      note: dense ? '' : 'The one line itself, printed flat; crossings fuse so it holds together.' },
    litho: { ok: true, best: dense, reason: '', note: dense ? 'Best for this drawing: the tone shows when a light is behind it.' : 'Looks plain until a light is behind it.' },
    cutter: { ok: true, reason: '', note: dense ? 'The cutter is the outline of the photo’s subject, not of the drawing; the stamp is off because a dense drawing presses a flat block.' : 'The cutter is the outline of the photo’s subject; the stamp carries the line.' },
  };
  // the cutter wants one subject the finder was sure of (sil undefined: not looked for yet;
  // js/lineart/index.js cutterVerdict); a blob, a skyline or the drawing's edge is no cookie shape
  if (sil !== undefined) {
    const v = cutterVerdict(sil);
    if (!v.ok) Object.assign(a.cutter, { ok: false, reason: v.reason, note: '', tag: 'Not for this photo', suggest: dense ? 'litho' : 'plaque' });
  }
  a.plaque.best = kind === 'lineart' || kind === 'contour';
  a.wire.best = kind === 'lineart';
  return a;
}

export function createPrint3DDialog(ctx) {
  const dlg = $('p3Dialog');
  const saved = (() => { try { return JSON.parse(localStorage.getItem('spiralist.print3d') || '{}'); } catch { return {}; } })();
  const st = {
    product: null, size: {}, opts: {}, colors: JSON.parse(JSON.stringify(P.DEFAULT_COLORS)),
    printer: saved.printer || P.DEFAULT_PRINTER, material: saved.material || 'petg', backdrop: saved.backdrop || 'auto',
    result: null, building: false, seq: 0, spin: !reduced(), backlit: false, sil: null, silFor: null, error: null, kind: null,
  };
  for (const [id, list] of Object.entries(OPTIONS)) st.opts[id] = Object.fromEntries(list.map(o => [o.id, o.def]));
  for (const id of Object.keys(SIZE)) st.size[id] = SIZE[id].def;
  st.sizeSet = {};   // products whose size the user chose; the others may grow to print well
  if (saved.colors) for (const [id, c] of Object.entries(saved.colors)) Object.assign(st.colors[id] || {}, c);
  const persist = () => { try { localStorage.setItem('spiralist.print3d', JSON.stringify({ printer: st.printer, material: st.material, backdrop: st.backdrop, colors: st.colors })); } catch { /* private mode */ } };

  // ---------------------------------------------------------------- worker
  let worker = null, nextId = 1;
  const pending = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.resolve(e.data) : p.reject(Object.assign(new Error(e.data.error), { workerStack: e.data.stack })); };
    worker.onerror = e => { for (const [, p] of pending) p.reject(new Error(e.message || 'worker failed')); pending.clear(); worker = null; };
    return worker;
  }
  function call(msg, transfer) {
    const id = nextId++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); getWorker().postMessage({ id, ...msg }, transfer || []); });
  }

  // ---------------------------------------------------------------- viewer
  let viewer = null, detachOrbit = null;
  function ensureViewer() {
    if (viewer) return viewer;
    const cv = $('p3Canvas');
    viewer = createViewer(cv, { autoSize: true, bed: 'pei', material: st.material });
    viewer.autoSize = true;
    detachOrbit = attachOrbit(viewer, cv, { onChange: () => { if (st.spin) { st.spin = false; syncSpin(); } } });
    return viewer;
  }

  // ---------------------------------------------------------------- helpers
  const printer = () => P.printerById(st.printer);
  const product = () => PRODUCTS.find(p => p.id === st.product);
  const colors = () => st.colors[st.product];
  const backdropId = () => st.backdrop === 'auto' ? P.bestBackdrop(P.dominantColor(st.product, colors())) : st.backdrop;
  const swatches = () => P.SWATCHES[st.material] || P.SWATCHES.petg;
  const swatchName = hex => (swatches().find(s => s.hex.toUpperCase() === String(hex).toUpperCase()) || P.SWATCHES.pla.find(s => s.hex.toUpperCase() === String(hex).toUpperCase()))?.name || String(hex).toUpperCase();
  const artName = () => slug(ctx.photoName) || 'drawing';
  const fileBase = () => `spiralist-${artName()}-${st.product}`;

  function slimGeom(g, sil) {
    const pick = o => {
      if (!o || typeof o !== 'object') return o ? true : null;
      const r = {};
      for (const [k, v] of Object.entries(o)) { const t = typeof v; if (t === 'number' || t === 'string' || t === 'boolean') r[k] = v; }
      return r;
    };
    const s = sil && sil.outlines && sil.outlines.length ? { outlines: sil.outlines.map(a => Float32Array.from(a)), standin: !!sil.standin, kind: sil.kind || null } : null;
    return { n: g.n, data: g.data, path: g.path, direction: g.direction, rings: g.rings, real: g.real ? pick(g.real) : null,
      lineart: g.lineart ? { ...pick(g.lineart), ...(s ? { silhouette: s } : {}) } : null, features: s ? { silhouette: s } : null };
  }

  function buildOpts() {
    const o = st.opts[st.product], c = colors();
    const out = { sizeMm: st.size[st.product] };
    if (st.product === 'plaque') {
      out.frameMm = +o.frame; out.cornerMm = +o.frame ? 6 : 2;
      out.hang = o.mount === 'holes' ? 'holes' : undefined; out.stand = o.mount === 'feet';
      out.plateColor = c.base; out.lineColor = c.line;
    } else if (st.product === 'wire') {
      out.lineMm = +o.lineMm; out.stand = !!o.stand; out.color = c.line;
      if (!o.loop) out.loopMm = 0;
    } else if (st.product === 'litho') {
      out.minMm = +o.minMm; out.maxMm = Math.max(+o.maxMm, +o.minMm + 1); out.frameMm = +o.frameMm; out.orient = o.orient; out.color = c.panel;
      out.bedslinger = printer().kinematics === 'bedslinger';   // the worker turns a standing panel so the bed shakes it along its wide side
    } else if (st.product === 'cutter') {
      out.wallMm = +o.wallMm; out.stamp = !!o.stamp; out.handle = !!o.handle && !!o.stamp; out.cutterColor = c.cutter; out.stampColor = c.stamp;
    }
    return out;
  }

  // ---------------------------------------------------------------- build
  let buildTimer = 0;
  function scheduleBuild(delay = 220) { clearTimeout(buildTimer); buildTimer = setTimeout(build, delay); setBusy(true, 'Building the print…'); }

  async function silhouetteFor(quiet = false) {
    const g = ctx.geom;
    const own = g?.features?.silhouette || g?.lineart?.silhouette;
    if (own?.outlines?.length) return own;
    // one search per drawing: a build that starts while it runs (a size change) waits for the same
    // answer instead of taking the drawing's edge
    if (st.silFor !== g || !st.silP) {
      st.silFor = g; st.sil = null; st.silDone = false;
      if (!ctx.silhouette) return null;
      st.silP = ctx.silhouette().catch(e => { console.warn('print3d: silhouette failed', e); return null; })
        .then(s => { if (st.silFor === g) { st.sil = s; st.silDone = true; } return s; });
    }
    if (!st.silDone && !quiet) setBusy(true, 'Finding the subject’s outline…');
    return st.silP;
  }
  /** Re-rate the cutter once its subject is known. When the subject is unclear (a blob, a skyline)
   *  the card says why and the dialog moves on to the suggested product: false. */
  function refreshCutterCard(sil) {
    renderCards();
    for (const b of $('p3Cards').querySelectorAll('[data-v]')) b.tabIndex = b.dataset.v === st.product ? 0 : -1;
    const cv = availability(st.kind, sil).cutter;
    if (st.product !== 'cutter' || cv.ok) return true;
    selectProduct(cv.suggest);
    $('p3CardNote').querySelector('.p3-off')?.classList.add('flash');
    return false;
  }
  /** The silhouette the cutter would use, once known; undefined while not looked for yet. */
  function silKnown() {
    const g = ctx.geom, own = g?.features?.silhouette;
    if (own?.outlines) return own;
    if (st.silFor === g && st.silDone) return st.sil;
    // (geom.lineart.silhouette is only a summary: { kind, confidence, standin })
    return g?.lineart?.silhouette?.standin ? { standin: true, outlines: [] } : undefined;
  }

  async function build() {
    const g = ctx.geom;
    if (!g || !st.product) return;
    const seq = ++st.seq;
    st.building = true; st.error = null;
    setBusy(true, 'Building the print…');
    const t0 = performance.now();
    try {
      const sil = st.product === 'cutter' ? await silhouetteFor() : null;
      if (seq !== st.seq) return;
      if (st.product === 'cutter' && !refreshCutterCard(sil)) return;
      st.silNote = st.product === 'cutter' ? (sil?.outlines?.length ? (sil.standin ? 'Outline: the stand-in silhouette of the line art.' : 'Outline: the subject’s silhouette.') : 'Outline: the drawing’s outer edge (the subject could not be found in the photo).') : '';
      const geom = slimGeom(g, sil);
      const opts = buildOpts();
      if (st.kind === 'spiral' && ctx.field) opts.field = ctx.field;
      if (pending.size && worker) { worker.terminate(); worker = null; for (const [, p] of pending) p.reject(new Error('superseded')); pending.clear(); }
      let r;
      try { r = await call({ cmd: 'build', product: st.product, geom, opts }); }
      catch (e) { if (/clone/i.test(e.message) && opts.field) { delete opts.field; r = await call({ cmd: 'build', product: st.product, geom, opts }); } else throw e; }
      if (seq !== st.seq) return;
      // a cutter whose size the user has not chosen grows (up to the slider's end) until the
      // subject's thin parts come through: an ear rounded off at 90 mm is a worse default than 120 mm
      if (st.product === 'cutter' && !st.sizeSet.cutter && thinLoss(r.result) && st.size.cutter < SIZE.cutter.max) {
        st.size.cutter = Math.min(SIZE.cutter.max, st.size.cutter + 15);
        st.grewFrom = st.grewFrom ?? SIZE.cutter.def;
        renderSize();
        if (seq === st.seq) { st.building = false; return build(); }
        return;
      }
      if (st.product === 'cutter' && st.grewFrom && !st.sizeSet.cutter && st.size.cutter > st.grewFrom) {
        (r.result.printability.notes ||= []).unshift(`Size raised from ${st.grewFrom} to ${st.size.cutter} mm so the outline's thin parts (ears, a tail, legs) come through.`);
      }
      st.result = r.result;
      st.result.wallMs = Math.round(performance.now() - t0);
      for (const p of st.result.parts) p.prepared = p.prepared || prepareMesh(p.mesh, 32);   // made in the worker
      showResult();
    } catch (e) {
      if (seq !== st.seq) return;
      console.warn('print3d: build failed', String(e.stack || e), e.workerStack || '');
      st.error = e.message; st.result = null;
      $('p3Report').innerHTML = `<p class="p3-issue">This print could not be built: ${esc(e.message)}</p>`;
    } finally {
      if (seq === st.seq) { st.building = false; setBusy(false); syncFoot(); }
    }
  }

  /** Did the cutter round off the subject's thin parts (the build's own blocking note)? */
  function thinLoss(result) {
    const pa = result?.printability;
    return !!pa && [...(pa.issues || []), ...(pa.notes || [])].some(t => /loses its thin parts/.test(t));
  }

  function setBusy(on, text) {
    $('p3Busy').hidden = !on;
    if (text) $('p3BusyText').textContent = text;
    dlg.classList.toggle('p3-building', !!on);
    syncFoot();
  }

  /** A standing lithophane whose foot has its own colour (one filament change at the foot's top). */
  function lithoTwo() {
    const c = colors();
    return st.product === 'litho' && st.result?.settings?.orientation === 'standing' && !!c.stand && !same(c.stand, c.panel);
  }
  /** A two-colour lithophane on a printer without an AMS: one pause at the foot's top, all from slot 1. */
  const lithoSwap = () => lithoTwo() && printer().multi !== 'ams';

  // ---------------------------------------------------------------- coloured parts for the view, the files and the film
  function coloredParts() {
    if (!st.result) return [];
    const parts = P.colorParts(st.product, st.result.parts, colors());
    const swap = st.product === 'plaque' && st.opts.plaque.twoColour === 'swap';
    const zc = st.result.settings?.colorChangeAtMm;
    return parts.map(p => ({ ...p, material: P.MATERIALS[st.material].view,
      ...(swap && zc && /^Stand/.test(p.name) ? { colorAbove: { atMm: zc, color: colors().line } } : {}) }));
  }

  function showView() {
    if (!st.result) return;
    const v = ensureViewer();
    const bd = P.backdropById(backdropId());
    const parts = coloredParts();
    v.setParts(parts);
    v.set({ bed: bd.bed, background: bd.background || null, material: P.MATERIALS[st.material].view, plate: [printer().bed.x, printer().bed.y],
      backlit: st.product === 'litho' && st.backlit, ...(st.viewSet ? {} : v.suggestView()) });
    st.viewSet = true;
    v.turntable(st.spin && !reduced() ? 10 : 0);
    v.requestRender();
  }

  // ---------------------------------------------------------------- UI: product cards
  function renderCards() {
    const av = availability(st.kind, silKnown());
    $('p3Cards').innerHTML = OFFERED.map(p => {
      const a = av[p.id];
      const tag = !a.ok ? a.tag || 'Not for this drawing' : a.best ? 'Prints well · best pick' : 'Prints well';
      return `<button type="button" role="radio" class="p3-card${a.ok ? '' : ' off'}" data-v="${p.id}" aria-checked="${st.product === p.id}" ${a.ok ? '' : 'aria-disabled="true"'}
        aria-describedby="p3c-${p.id}"><span class="p3-letter">${p.letter}</span><span class="p3-name">${esc(p.name)}</span>
        <span class="p3-tag${a.ok ? (a.best ? ' best' : '') : ' no'}" id="p3c-${p.id}">${tag}</span></button>`;
    }).join('');
    syncCardNote();
  }
  function syncCardNote() {
    const av = availability(st.kind, silKnown()), el = $('p3CardNote');
    const off = OFFERED.filter(p => !av[p.id].ok);
    const cur = av[st.product];
    let html = cur?.note ? `<span>${esc(cur.note)}</span>` : '';
    for (const p of off) {
      const s = OFFERED.find(q => q.id === av[p.id].suggest);
      html += `<span class="p3-off"><b>${p.letter} ${esc(p.name)}:</b> ${esc(av[p.id].reason)}${s ? ` <button type="button" class="text-btn" data-try="${s.id}">Try ${s.letter} ${esc(s.name)}</button>` : ''}</span>`;
    }
    el.innerHTML = html;
  }
  $('p3Cards').addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    const av = availability(st.kind, silKnown())[b.dataset.v];
    if (!av.ok) { syncCardNote(); $('p3CardNote').querySelector('.p3-off')?.classList.add('flash'); return; }
    selectProduct(b.dataset.v);
  });
  $('p3Cards').addEventListener('keydown', e => {
    if (!/^Arrow/.test(e.key)) return;
    e.preventDefault();
    const av = availability(st.kind, silKnown()), ids = OFFERED.map(p => p.id).filter(id => av[id].ok);
    const i = ids.indexOf(st.product), d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    selectProduct(ids[(i + d + ids.length) % ids.length]);
    $('p3Cards').querySelector(`[data-v="${st.product}"]`)?.focus();
  });
  $('p3CardNote').addEventListener('click', e => { const t = e.target.closest('[data-try]'); if (t) selectProduct(t.dataset.try); });

  function selectProduct(id) {
    if (st.product === id) return;
    st.product = id; st.result = null; st.viewSet = false; st.backlit = false;
    for (const b of $('p3Cards').querySelectorAll('[data-v]')) { const on = b.dataset.v === id; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; }
    syncCardNote(); renderSize(); renderOptions(); renderColors(); syncBacklit();
    $('p3Report').innerHTML = ''; $('p3Estimate').textContent = ''; $('p3Size').textContent = '';
    scheduleBuild(0);
  }

  // ---------------------------------------------------------------- size + printer
  function renderSize() {
    const s = SIZE[st.product], r = $('p3SizeR');
    r.min = s.min; r.max = s.max; r.step = s.step; r.value = st.size[st.product];
    $('p3SizeOut').textContent = `${st.size[st.product]} mm`;
    r.setAttribute('aria-valuetext', `${st.size[st.product]} millimetres`);
    r.style.setProperty('--fill', `${((st.size[st.product] - s.min) / Math.max(1, s.max - s.min) * 100).toFixed(1)}%`);   // the app's range fill
  }
  $('p3SizeR').addEventListener('input', e => { st.size[st.product] = +e.target.value; st.sizeSet[st.product] = true; renderSize(); scheduleBuild(350); });

  $('p3Printer').innerHTML = P.PRINTERS.map(p => `<option value="${p.id}">${esc(p.name)} · X 0-${p.bed.x}, Y 0-${p.bed.y}, Z 0-${p.bed.z} mm</option>`).join('');
  $('p3Printer').addEventListener('change', e => {
    const was = printer().kinematics;
    st.printer = e.target.value; persist();
    // a standing lithophane turns with the printer's kinematics: rebuild it
    if (st.product === 'litho' && st.opts.litho.orient === 'standing' && was !== printer().kinematics) { scheduleBuild(0); return; }
    showFit(); showEstimate(); showView(); showReport(); syncFoot();
  });
  for (const b of $('p3Material').querySelectorAll('[data-v]')) b.addEventListener('click', () => {
    if (st.material === b.dataset.v) return;
    st.material = b.dataset.v; persist(); syncMaterial(); renderColors(); showEstimate(); showView();
  });
  function syncMaterial() { for (const b of $('p3Material').querySelectorAll('[data-v]')) b.setAttribute('aria-checked', b.dataset.v === st.material); }

  // ---------------------------------------------------------------- options
  function renderOptions() {
    const list = OPTIONS[st.product], o = st.opts[st.product];
    $('p3OptsBody').innerHTML = list.map(d => d.toggle
      ? `<label class="switch-row"><span>${esc(d.label)}</span><input type="checkbox" class="switch" data-opt="${d.id}" ${o[d.id] ? 'checked' : ''}></label>`
      : `<div class="field-label" id="p3o-${d.id}">${esc(d.label)}</div><div class="seg seg-sm" role="radiogroup" aria-labelledby="p3o-${d.id}" data-opt="${d.id}">${d.seg.map(([v, t]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${String(o[d.id]) === v}">${esc(t)}</button>`).join('')}</div>`).join('');
    if (st.product === 'cutter') { const h = $('p3OptsBody').querySelector('[data-opt="handle"]'); if (h) h.disabled = !o.stamp; }
    if (st.product === 'plaque') { const s = $('p3OptsBody').querySelector('[data-opt="twoColour"] [data-v="ams"]'); if (s) s.textContent = printer().multi === 'ams' ? 'Two filaments (AMS)' : 'Two filaments'; }
  }
  $('p3OptsBody').addEventListener('click', e => {
    const b = e.target.closest('[role="radio"]'), g = b?.closest('[data-opt]');
    if (!b || !g) return;
    const o = st.opts[st.product];
    if (o[g.dataset.opt] === b.dataset.v) return;
    o[g.dataset.opt] = b.dataset.v;
    for (const x of g.querySelectorAll('[role="radio"]')) x.setAttribute('aria-checked', x === b);
    if (g.dataset.opt === 'twoColour') { showReport(); showView(); return; }   // no rebuild: the view and the file change
    if (g.dataset.opt === 'mount' || g.dataset.opt === 'orient') renderColors();   // the stand's colour row comes and goes
    scheduleBuild();
  });
  $('p3OptsBody').addEventListener('change', e => {
    const i = e.target.closest('[data-opt]');
    if (!i || i.type !== 'checkbox') return;
    st.opts[st.product][i.dataset.opt] = i.checked;
    if (st.product === 'cutter') { renderOptions(); renderColors(); }
    else if (i.dataset.opt === 'stand') renderColors();   // the stand's colour row comes and goes
    scheduleBuild();
  });

  // ---------------------------------------------------------------- colours
  /** Does the product being built have a stand (feet, a slotted stand, a lithophane's foot)? */
  function hasStand() {
    const o = st.opts[st.product];
    return st.product === 'plaque' ? o.mount === 'feet' : st.product === 'wire' ? !!o.stand : st.product === 'litho' ? o.orient === 'standing' : false;
  }
  function renderColors() {
    const roles = P.ROLES[st.product].filter(r => !(st.product === 'cutter' && r.id === 'stamp' && !st.opts.cutter.stamp) && !(r.id === 'stand' && !hasStand())), c = colors();
    const sw = swatches();
    let html = '';
    for (const r of roles) {
      // a stand follows the main colour until the user picks one ("Same as the panel")
      const own = c[r.id], follow = !!r.follows && !own;
      const cur = String(own || c[r.follows] || '#FFFFFF').toUpperCase();
      const inList = sw.some(s => s.hex.toUpperCase() === cur);
      const same = r.follows ? `<button type="button" class="swatch match" role="radio" style="--c:${cur}" data-hex="" aria-label="Same as the ${esc(r.followName)}" title="Same as the ${esc(r.followName)}" aria-checked="${follow}"></button>` : '';
      html += `<div class="p3-color"><div class="field-label" id="p3r-${r.id}">${esc(r.label)} <span class="p3-cname">${esc(follow ? `Same as the ${r.followName}` : swatchName(cur))}</span></div>
        <div class="swatches" role="radiogroup" aria-labelledby="p3r-${r.id}" data-role="${r.id}">` + same +
        sw.map(s => `<button type="button" class="swatch" role="radio" style="--c:${s.hex}" data-hex="${s.hex}" aria-label="${esc(s.name)}" title="${esc(s.name)}" aria-checked="${!follow && s.hex.toUpperCase() === cur}"></button>`).join('') +
        `<span class="swatch custom" role="radio" aria-checked="${!follow && !inList}" title="Custom colour" ${!follow && !inList ? `style="--c:${cur};background:${cur}"` : ''}><input type="color" value="${cur.toLowerCase()}" aria-label="Custom ${esc(r.label.toLowerCase())} colour" data-role="${r.id}"></span></div></div>`;
    }
    if (st.product === 'litho') html += `<p class="helper">The panel stays one light colour: its picture is light shining through thicker and thinner plastic, and white shows it best.${hasStand() ? ' The stand can be any colour: it prints below the panel, so a second colour costs one filament change.' : ''}</p>`;
    if (st.product === 'wire' && hasStand()) html += '<p class="helper">A stand in its own colour prints on a second plate, so neither plate needs a filament change.</p>';
    $('p3Colors').innerHTML = html;
    const bdSel = $('p3Backdrop');
    for (const b of bdSel.querySelectorAll('[data-v]')) b.setAttribute('aria-checked', b.dataset.v === st.backdrop);
    showColorWarnings();
  }
  function setColor(role, hex, { rerender = true } = {}) {
    colors()[role] = hex ? hex.toUpperCase() : null;   // null: a stand follows the main colour again
    persist();
    if (rerender) renderColors(); else showColorWarnings();
    if (st.result) { showView(); showReport(); }
  }
  $('p3Colors').addEventListener('click', e => {
    const b = e.target.closest('.swatch[data-hex]');
    if (b) setColor(b.closest('[data-role]').dataset.role, b.dataset.hex);
  });
  $('p3Colors').addEventListener('input', e => {
    if (e.target.type !== 'color') return;
    const role = e.target.dataset.role, sp = e.target.parentElement;
    sp.style.background = e.target.value; sp.setAttribute('aria-checked', 'true');
    for (const s of sp.parentElement.querySelectorAll('.swatch[data-hex]')) s.setAttribute('aria-checked', 'false');
    setColor(role, e.target.value, { rerender: false });
  });
  $('p3Colors').addEventListener('change', e => { if (e.target.type === 'color') renderColors(); });
  $('p3Backdrop').addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    st.backdrop = b.dataset.v; persist();
    for (const x of $('p3Backdrop').querySelectorAll('[data-v]')) x.setAttribute('aria-checked', x === b);
    showColorWarnings(); showView();
  });

  function showColorWarnings() {
    const w = P.colorWarnings(st.product, colors(), backdropId(), st.material);
    const el = $('p3ColorWarn');
    const bd = P.backdropById(backdropId());
    $('p3BackdropNote').textContent = st.backdrop === 'auto' ? `Auto: ${bd.name}, picked to contrast with the print.` : '';
    el.hidden = !w.length;
    el.innerHTML = w.map((x, i) => `<div class="hint-card p3-warn ${x.level}" role="status"><span>${esc(x.text)}</span>
      <span class="p3-fix"><button type="button" class="text-btn" data-fix="${i}">${esc(x.fix.label)}</button>${x.fix2 ? `<button type="button" class="text-btn" data-fix="${i}" data-alt="1">${esc(x.fix2.label)}</button>` : ''}</span></div>`).join('');
    el._w = w;
  }
  // (each fix clears its warning: a new line colour, or a new plate colour; never a swap, which
  // keeps the same too-similar pair)
  $('p3ColorWarn').addEventListener('click', e => {
    const f = e.target.closest('[data-fix]');
    if (!f) return;
    const w = $('p3ColorWarn')._w[+f.dataset.fix], x = f.dataset.alt ? w.fix2 : w.fix;
    if (x.backdrop) { st.backdrop = x.backdrop; persist(); renderColors(); showView(); }
    else setColor(x.role, x.value);
    if (st.result) showEstimate();
  });

  // ---------------------------------------------------------------- backlit + spin
  function syncBacklit() {
    const b = $('p3Backlit');
    b.hidden = st.product !== 'litho';
    b.setAttribute('aria-pressed', st.backlit);
  }
  $('p3Backlit').addEventListener('click', () => { st.backlit = !st.backlit; syncBacklit(); showView(); });
  function syncSpin() { $('p3Spin').setAttribute('aria-pressed', st.spin); viewer?.turntable(st.spin && !reduced() ? 10 : 0); }
  $('p3Spin').addEventListener('click', () => { st.spin = !st.spin; syncSpin(); });

  // ---------------------------------------------------------------- report
  const partLine = p => {
    const z0 = p.size.z0 || 0;
    return `<li><b>${esc(p.name)}</b> X 0-${p.size.x}, Y 0-${p.size.y}, Z ${z0 ? `${z0}-${r1(z0 + p.size.z)}` : `0-${p.size.z}`} mm</li>`;
  };
  function showResult() {
    const r = st.result;
    const s = r.sizeMm;
    $('p3Size').innerHTML = `On the bed: X ${s.x[0]}-${s.x[1]}, Y ${s.y[0]}-${s.y[1]}, Z ${s.z[0]}-${s.z[1]} mm`;
    showView(); showFit(); showReport(); showEstimate(); showColorWarnings();
    renderCardBadges();
  }
  function renderCardBadges() {
    const b = $('p3Cards').querySelector(`[data-v="${st.product}"] .p3-tag`);
    if (b && st.result && !st.result.printability.ok) { b.textContent = 'Needs changes'; b.className = 'p3-tag no'; }
  }
  function fitInfo() {
    const r = st.result, bed = printer().bed;
    if (!r) return null;
    const tooBig = r.parts.filter(p => !P.fitsBed({ x: p.size.x, y: p.size.y, z: p.size.z0 + p.size.z }, bed));
    const layout = P.fitsBed({ x: r.sizeMm.x[1], y: r.sizeMm.y[1], z: r.sizeMm.z[1] }, bed);
    return { tooBig, layout, bed };
  }
  function showFit() {
    const f = fitInfo(), el = $('p3Fit'), pr = printer();
    el.className = 'helper';
    if (!f) { el.textContent = `Bed X 0-${pr.bed.x}, Y 0-${pr.bed.y}, Z 0-${pr.bed.z} mm, ${pr.nozzle} mm nozzle.`; return; }
    if (f.tooBig.length) {
      el.className = 'helper p3-issue';
      el.textContent = `${f.tooBig.map(p => p.name).join(', ')} ${f.tooBig.length > 1 ? 'do' : 'does'} not fit the ${pr.name} (bed X 0-${pr.bed.x}, Y 0-${pr.bed.y}, Z 0-${pr.bed.z} mm). Make it smaller.`;
    } else if (!f.layout && platePlan().plates === 1) {
      el.className = 'helper p3-warn-t';
      el.textContent = `Every part fits the ${pr.name}, but not all on one plate: print them as separate plates (bed X 0-${pr.bed.x}, Y 0-${pr.bed.y} mm).`;
    } else if (platePlan().plates > 1) {
      el.className = 'helper p3-warn-t';
      el.textContent = `Fits the ${pr.name} on two plates (bed X 0-${pr.bed.x}, Y 0-${pr.bed.y} mm): ${platePlan().why} The 3MF has both plates ready.`;
    } else el.textContent = `Fits the ${pr.name} on one plate (bed X 0-${pr.bed.x}, Y 0-${pr.bed.y}, Z 0-${pr.bed.z} mm, ${pr.nozzle} mm nozzle).`;
  }

  // ---------------------------------------------------------------- plates: which part prints where
  const same = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
  /** Plate 1 holds the main piece; the feet or the stamp move to plate 2 when they would not fit
   *  beside it, or when their colour differs (two colours on shared layers cost an AMS swap per
   *  layer and a purge each time, so each plate prints in one filament instead). */
  function plateOf(p) {
    const c = colors(), f = fitInfo();
    if (st.product === 'plaque' && /^Stand/.test(p.name) && (!f?.layout || !same(c.base, c.line) || !same(c.base, c.stand || c.base))) return 2;
    if (st.product === 'cutter' && /^Stamp/.test(p.name) && (!f?.layout || !same(c.cutter, c.stamp))) return 2;
    if (st.product === 'wire' && /^Stand/.test(p.name) && (!f?.layout || !same(c.line, c.stand || c.line))) return 2;
    return 1;
  }
  function platePlan() {
    const parts = st.result ? st.result.parts : [], two = parts.filter(p => plateOf(p) === 2);
    const f = fitInfo(), c = colors();
    let why = '';
    if (two.length) {
      const what = st.product === 'cutter' ? 'the stamp' : st.product === 'wire' ? 'the stand' : 'the feet';
      const col = st.product === 'cutter' ? c.stamp : P.roleColor(st.product, c, 'stand');
      why = !f?.layout ? `${what} ${st.product === 'plaque' ? 'do' : 'does'} not fit beside the main piece, so ${st.product === 'plaque' ? 'they print' : 'it prints'} on plate 2.`
        : `${what} ${st.product === 'plaque' ? 'print' : 'prints'} on plate 2 in ${swatchName(col).toLowerCase()}, so each plate needs one filament change at most.`;
      why = why[0].toUpperCase() + why.slice(1);
    }
    return { plates: two.length ? 2 : 1, why };
  }
  /** Filament changes on one plate: per layer, the parts of other slots (AMS keeps the last one). */
  function swapCount(parts) {
    if (new Set(parts.map(p => p.slot)).size < 2) return 0;
    const top = Math.max(...parts.map(p => (p.size.z0 || 0) + p.size.z));
    let cur = null, n = 0;
    for (let z = 0.1; z < top; z += 0.2) {
      const here = [...new Set(parts.filter(p => z >= (p.size.z0 || 0) && z <= (p.size.z0 || 0) + p.size.z).map(p => p.slot))];
      if (!here.length) continue;
      if (cur == null) cur = here.includes(1) ? 1 : here[0];
      const others = here.filter(s => s !== cur);
      n += others.length;
      if (others.length) cur = others[others.length - 1];
    }
    return n;
  }
  /** Per-object print settings written into the 3MF (Bambu Studio / OrcaSlicer read them). */
  function objectPlan(parts) {
    const idx = re => parts.map((p, k) => re.test(p.name) ? k : -1).filter(k => k >= 0);
    const standing = st.result?.settings?.orientation === 'standing';
    const S = {
      plaque: { sparse_infill_density: '15%', wall_generator: 'arachne' },
      wire: { sparse_infill_density: '100%', wall_generator: 'arachne' },
      litho: { sparse_infill_density: '100%', ...(standing ? { brim_type: 'outer_only', brim_width: '5' } : {}) },
      cutter: { wall_loops: '3', sparse_infill_density: '20%' },
    }[st.product];
    const base = st.product === 'plaque' ? [{ name: 'Plaque', re: /^(Plate|Line)$/ }] : st.product === 'wire' ? [{ name: 'Wire', re: /^Wire$/ }]
      : st.product === 'litho' ? [{ name: 'Lithophane', re: /./ }] : [{ name: 'Cutter', re: /^Cutter$/ }, { name: 'Stamp', re: /^Stamp (plate|relief)$/ }];
    const objs = base.map(b => ({ name: b.name, parts: idx(b.re), settings: S }));
    parts.forEach((p, k) => { if (!objs.some(o => o.parts.includes(k))) objs.push({ name: p.name, parts: [k], settings: /^Stand/.test(p.name) ? { sparse_infill_density: '15%' } : S }); });
    return objs.filter(o => o.parts.length).map(o => ({ ...o, plate: plateOf(parts[o.parts[0]]) }));
  }
  const SETTING_TEXT = { sparse_infill_density: v => `${v} infill`, wall_loops: v => `${v} walls`, brim_type: () => '', brim_width: v => `${v} mm brim`, wall_generator: v => `${v === 'arachne' ? 'Arachne' : v} walls (thin lines kept)` };

  function showReport() {
    const r = st.result;
    if (!r) return;
    const pa = r.printability, set = r.settings || {};
    const issues = new Set(pa.issues || []);
    const notes = (pa.notes || []).map(t => t.replace(/^!/, '')).filter(t => ![...issues].some(i => i.replace(/^!/, '') === t));
    const man = r.stats.manifold || [];
    const bad = man.filter(m => !m.ok);
    const know = [];
    know.push(`Layer ${set.layer || 0.2} mm, ${set.nozzle || 0.4} mm nozzle, ${set.walls || 2} walls, ${set.infill || '100%'} infill.`);
    // what the 3MF itself carries (Bambu Studio and OrcaSlicer apply it; other slicers: set it by hand)
    const carried = [...new Set(objectPlan(r.parts).flatMap(o => Object.entries(o.settings).map(([k, v]) => SETTING_TEXT[k]?.(v)).filter(Boolean)))];
    if (carried.length) know.push(`Set in the 3MF for Bambu Studio and OrcaSlicer: ${carried.join(', ')}. In other slicers set these by hand.`);
    know.push('Supports: none needed.');
    if (st.product === 'litho') know.push(set.orientation === 'flat' ? 'Printed flat: no brim needed.' : 'Brim: 5 mm, set in the 3MF (it stands on a narrow foot).');
    if (lithoTwo()) {
      const c = colors(), zc = set.colorChangeAtMm, layer = Math.round(zc / (set.layer || 0.2)) + 1;
      know.push(printer().multi === 'ams'
        ? `Two filaments: the foot is filament 2 (${swatchName(P.roleColor('litho', c, 'stand')).toLowerCase()}), the panel filament 1 (${swatchName(c.panel).toLowerCase()}), set per part in the 3MF. The foot lies wholly below the panel, so the AMS changes once, after Z ${zc} mm.`
        : `Colour change after Z ${zc} mm (the panel from layer ${layer}): start with the ${swatchName(P.roleColor('litho', c, 'stand')).toLowerCase()} filament for the foot, then swap to ${swatchName(c.panel).toLowerCase()}. The 3MF marks the pause for Bambu Studio and OrcaSlicer; in other slicers add it on the layer slider.`);
    }
    else know.push(st.product === 'wire' ? 'Brim: none needed on a textured PEI plate. If a line end lifts, add small mouse ears at the ends in the slicer.' : 'Brim: not needed.');
    if (st.product === 'plaque') {
      const zc = set.colorChangeAtMm || 2.4, layer = Math.round(zc / (set.layer || 0.2)) + 1;
      know.push(st.opts.plaque.twoColour === 'swap'
        ? `Colour change after Z ${zc} mm (the new colour from Z ${r1(zc + (set.layer || 0.2))} mm, layer ${layer}): the 3MF marks a pause there; swap to the ${swatchName(colors().line).toLowerCase()} filament. If your slicer does not show the mark, add it on the layer slider.`
        : `Two filaments: the plate is filament 1 (${swatchName(colors().base).toLowerCase()}), the line filament 2 (${swatchName(colors().line).toLowerCase()}), set per part in the 3MF. Check in the slicer that the Line part shows filament 2 before you print: the Bambu Studio command line printed everything with filament 1 in our tests.`);
    }
    if (st.material === 'petg' && (st.product === 'plaque' || st.product === 'wire')) know.push('PETG strings across small gaps: use a dry spool (dry it at 65 °C for 4-6 h if it has been open for weeks).');
    const plan = platePlan();
    if (plan.plates > 1) know.push(plan.why);
    if (st.product === 'cutter' && st.silNote) know.push(st.silNote);
    const f = fitInfo(), twoPlates = pa.ok && plan.plates > 1 && !f?.layout;
    const html = [
      `<div class="p3-verdict ${pa.ok ? (twoPlates ? 'two' : 'ok') : 'no'}">${pa.ok ? (twoPlates ? 'Prints on two plates' : 'Prints as is') : 'Needs changes before printing'}${bad.length ? '' : ' · watertight'}</div>`,
      issues.size ? `<ul class="p3-issues">${[...issues].map(t => `<li>${esc(t.replace(/^!/, ''))}</li>`).join('')}</ul>` : '',
      `<div class="p3-sub">Parts</div><ul class="p3-parts">${r.parts.map(p => partLine(p).replace('</li>', plan.plates > 1 ? ` · plate ${plateOf(p)}</li>` : '</li>')).join('')}</ul>`,
      notes.length ? `<div class="p3-sub">What we changed</div><ul>${notes.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '',
      `<div class="p3-sub">What to know</div><ul>${know.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`,
      bad.length ? `<p class="p3-issue">Not watertight: ${bad.map(m => esc(m.name)).join(', ')}.</p>` : '',
    ].join('');
    $('p3Report').innerHTML = html;
  }

  function showEstimate() {
    const r = st.result;
    if (!r) { $('p3Estimate').textContent = ''; return; }
    const vol = r.parts.reduce((s, p) => s + p.volume, 0), tri = r.parts.reduce((s, p) => s + p.triangles, 0);
    const e = P.estimate({ volumeMm3: vol, heightMm: r.sizeMm.z[1], triangles: tri, product: st.product, material: st.material, printer: printer() });
    // filament changes: AMS swaps where two colours share a plate's layers (about 105 s and 0.5 g of
    // purge each), or the one manual swap of 'Swap at Z 2.4 mm'
    const parts = coloredParts(), swapMode = st.product === 'plaque' && st.opts.plaque.twoColour === 'swap';
    let swaps = 0;
    if (swapMode) swaps = new Set(parts.map(p => p.slot)).size > 1 ? 1 : 0;
    else for (const pl of [1, 2]) swaps += swapCount(parts.filter(p => plateOf(p) === pl));
    const swapMin = swaps * (swapMode ? 150 : 105) / 60, purge = swapMode ? 0 : swaps * 0.5;
    e.minutes = Math.round(e.minutes + swapMin); e.grams = Math.round(e.grams + purge); e.swaps = swaps;
    st.estimate = e;
    const plan = platePlan();
    const fe = st.filmEst && st.filmEst.result === st.result && st.filmEst.printer === st.printer && st.filmEst.material === st.material ? st.filmEst : null;
    const swapTxt = swaps ? ` Includes ${swaps} filament ${swaps > 1 ? 'changes' : 'change'} (${Math.round(swapMin)} min${purge ? `, ${Math.round(purge)} g purge` : ''}).` : '';
    $('p3Estimate').innerHTML = fe
      ? `Estimate: about <b>${fe.grams} g</b> of ${P.MATERIALS[st.material].name} and <b>${P.formatMinutes(fe.minutes)}</b> on the ${esc(printer().name)}, ${fe.layers} layers${plan.plates > 1 ? ' (plate 1)' : ''}. <span class="p3-est-note">From the timelapse's layer-by-layer slice; your slicer gives the exact numbers.</span>`
      : `Estimate: about <b>${e.grams} g</b> of ${P.MATERIALS[st.material].name} and <b>${P.formatMinutes(e.minutes)}</b> on the ${esc(printer().name)}, ${e.layers} layers${plan.plates > 1 ? ', both plates' : ''}.${swapTxt} <span class="p3-est-note">From the volume; your slicer gives the exact numbers.</span>`;
  }

  // ---------------------------------------------------------------- exports
  function syncFoot() {
    const ready = !!st.result && !st.building;
    for (const id of ['p3Go', 'p3Stl']) $(id).disabled = !ready;
    // the timelapse only films a print that fits the chosen printer, and one at a time
    const noFit = ready && fitInfo()?.tooBig.length > 0;
    const w = $('p3Watch');
    w.disabled = !ready || noFit || !!film || filmOpening;
    w.title = noFit ? `Does not fit the ${printer().name}: make it smaller to watch it print` : 'A timelapse of your piece being printed, layer by layer';
  }
  function download(bytes, name, type) {
    const blob = new Blob([bytes], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return blob;
  }
  async function exportFile(format) {
    if (!st.result) return null;
    const parts = coloredParts().map(p => ({ name: p.name, color: p.color, slot: p.slot }));
    const swap = (st.product === 'plaque' && st.opts.plaque.twoColour === 'swap') || lithoSwap();
    const zc = st.result.settings?.colorChangeAtMm;
    const meta = { title: `Spiralist ${product().name}: ${artName()}`, designer: 'Spiralist', fileBase: fileBase(), layerMm: 0.2,
      // one object per piece with its print settings, on plate 1 or 2 of the chosen printer
      objects: objectPlan(parts), bed: { x: printer().bed.x, y: printer().bed.y },
      ...(swap && zc ? { colorChanges: [{ atMm: zc, color: st.product === 'litho' ? colors().panel : colors().line }] } : {}) };
    // one filament per colour: with a swap, everything prints from slot 1
    if (swap) for (const p of parts) p.slot = 1;
    const t0 = performance.now();
    const r = await call({ cmd: 'export', format, parts, meta });
    const ext = r.kind === '3mf' ? '3mf' : r.kind;
    const name = `${fileBase()}.${ext}`;
    const type = ext === '3mf' ? 'model/3mf' : ext === 'zip' ? 'application/zip' : 'model/stl';
    st.lastExport = { name, bytes: r.bytes.byteLength, ms: Math.round(performance.now() - t0), kind: r.kind, count: r.count };
    return { bytes: r.bytes, name, type };
  }
  async function save(format) {
    const btn = format === '3mf' ? $('p3Go') : $('p3Stl');
    btn.disabled = true;
    try {
      const f = await exportFile(format);
      if (f) { download(f.bytes, f.name, f.type); $('p3Saved').textContent = `Saved ${f.name} (${(f.bytes.byteLength / 1024).toFixed(0)} KB).`; }
    } catch (e) { console.warn('print3d: export failed', e); $('p3Saved').textContent = `Could not save: ${e.message}`; }
    finally { btn.disabled = false; }
  }
  $('p3Go').addEventListener('click', () => save('3mf'));
  $('p3Stl').addEventListener('click', () => save('stl'));

  // ---------------------------------------------------------------- the print timelapse (js/print3d/printfilm.js)
  let film = null, filmOpening = false;
  async function watch() {
    // one timelapse at a time (a double click during the first, slow import opened two)
    if (!st.result || film || filmOpening || fitInfo()?.tooBig.length) return;
    filmOpening = true; syncFoot();
    try { await openFilm(); } finally { filmOpening = false; syncFoot(); }
  }
  async function openFilm() {
    let mod = null, loadErr = null;
    try { mod = await import('./printfilm.js'); } catch (e) { loadErr = e; }
    if (!mod?.openPrintTimelapse) {
      // a failed import is the network (offline before sw.js had cached the timelapse), not a missing feature
      if (loadErr) console.warn('print3d: timelapse module did not load', loadErr);
      $('p3Saved').textContent = loadErr ? 'Connect once to load the print timelapse; after that it works offline too.'
        : 'The print timelapse is not available in this version.';
      return;
    }
    viewer?.turntable(0);
    // the timelapse opens its own dialog on top of this one; the colours are the ones chosen here:
    // base = the plate or main part (background), ink = the line (or the stamp), backdrop = a colour
    const c = colors(), main = P.dominantColor(st.product, c);
    const ink = st.product === 'plaque' ? c.line : st.product === 'cutter' ? c.stamp : main;
    const modeName = ctx.mode === 'lineart' ? 'Line art' : ctx.mode === 'realistic' ? 'Realistic' : 'Artistic';
    // the film shows what the 3MF prints: plate 1 (the feet or a two-colour stamp are on plate 2),
    // with an M600-style change at Z only for 'Swap at Z 2.4 mm'; otherwise every part keeps its
    // own filament slot and the AMS swaps are counted where colours share layers
    const all = coloredParts(), parts = all.filter(p => plateOf(p) === 1);
    const swapMode = st.product === 'plaque' && st.opts.plaque.twoColour === 'swap';
    const { colorChangeAtMm, ...rest } = st.result.settings || {};
    const settings = swapMode ? { ...rest, colorChangeAtMm } : rest;
    const plan = platePlan();
    const warn = P.colorWarnings(st.product, c, backdropId(), st.material).find(w => w.kind === 'pair' && w.level !== 'good');
    const result = st.result, key = { printer: st.printer, material: st.material };
    try {
      film = await mod.openPrintTimelapse({
        parts, colors: { ...c, base: main, ink, backdrop: P.backdropById(backdropId()).tone },
        printer: printer(), filament: st.material, changeMode: swapMode || lithoSwap() ? 'manual' : 'ams',
        product: { id: st.product, product: product(), settings, sizeMm: st.result.sizeMm, estimate: st.estimate },
        art: { title: `${modeName} · ${ctx.photoName || 'drawing'}`, fileBase: `spiralist-${artName()}` },
        notes: [plan.plates > 1 ? `Plate 1 of 2: ${plan.why}` : '', warn ? `Colour warning: ${warn.text}` : ''].filter(Boolean),
        // the film's own layer-by-layer time becomes the dialog's single estimate
        onToolpath: tp => {
          if (st.result !== result || !tp?.stats) return;
          st.filmEst = { result, ...key, minutes: Math.max(1, Math.round(tp.total / 60)), grams: Math.max(1, Math.round(tp.stats.grams)), layers: tp.layers.length };
          if (st.printer === key.printer && st.material === key.material) showEstimate();
        },
      });
      film?.dialog?.addEventListener('close', () => { film = null; syncSpin(); syncFoot(); }, { once: true });
    } catch (e) { console.warn('print3d: timelapse failed', e); closeFilm(); $('p3Saved').textContent = `The timelapse could not start: ${e.message}`; }
  }
  function closeFilm() {
    const f = film; film = null;
    try { f?.close?.(); } catch { /* already closed */ }
    syncSpin();
  }
  $('p3Watch').addEventListener('click', watch);

  // ---------------------------------------------------------------- open / close
  function open() {
    const g = ctx.geom;
    if (!g) return;
    const kind = artKind(g);
    if (kind !== st.kind) st.opts.cutter.stamp = !DENSE[kind];   // a dense drawing stamps a flat block
    st.kind = kind;
    const av = availability(st.kind, silKnown());
    const keep = st.product && av[st.product].ok && st.geom === g;
    // a new drawing: a cutter size the dialog grew for the last subject starts over at the default
    if (st.geom !== g && !st.sizeSet.cutter) { st.size.cutter = SIZE.cutter.def; st.grewFrom = null; }
    st.geom = g;
    $('p3Printer').value = st.printer;
    syncMaterial(); syncSpin();
    $('p3Art').textContent = `${ctx.mode === 'lineart' ? 'Line art' : ctx.mode === 'realistic' ? 'Realistic' : 'Artistic'}${st.kind && st.kind !== 'lineart' && st.kind !== 'real' ? ` · ${st.kind}` : ''} · ${ctx.photoName || 'drawing'}`;
    renderCards();
    if (!dlg.open) { dlg.showModal(); dlg.querySelector('.p3-body').scrollTop = 0; }
    // compile the viewer's shaders (a one-off second or so) while the worker builds the first mesh
    if (!viewer) requestAnimationFrame(() => setTimeout(ensureViewer, 0));
    if (!keep) {
      const first = OFFERED.find(p => av[p.id].ok && av[p.id].best) || OFFERED.find(p => av[p.id].ok) || OFFERED[0];
      st.product = null; selectProduct(first.id);
    } else { selectProductUI(); showResult(); }
    $('p3Saved').textContent = '';
  }
  function selectProductUI() {
    for (const b of $('p3Cards').querySelectorAll('[data-v]')) { const on = b.dataset.v === st.product; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; }
    renderSize(); renderOptions(); renderColors(); syncBacklit(); syncCardNote();
  }
  function close() { if (dlg.open) dlg.close(); }
  dlg.addEventListener('close', () => { closeFilm(); viewer?.turntable(0); });
  $('p3Close').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });

  return {
    open, close, state: st,
    debug: { build, exportFile, availability, coloredParts, get viewer() { return viewer; }, get result() { return st.result; }, selectProduct, setColor,
      setOpt(k, v) { st.opts[st.product][k] = v; renderOptions(); scheduleBuild(0); }, setSize(v) { st.size[st.product] = v; st.sizeSet[st.product] = true; renderSize(); scheduleBuild(0); },
      setPrinter(id) { st.printer = id; $('p3Printer').value = id; showFit(); showEstimate(); showView(); },
      setBackdrop(id) { st.backdrop = id; renderColors(); showView(); }, get busy() { return st.building || !$('p3Busy').hidden; } },
  };
}
