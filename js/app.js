// Spiralist — app controller.
//
// Data flow (each layer cached by the inputs it depends on):
//   photo + crop ─ rasterize ─> raster ─ processTone(tone, flip) ─> tone ─ buildField(rings) ─> field
//   field + line ─ buildSpiral ─> geom ─ Renderer(paper, brush, ink) ─> the sheet
// "doc" is the undoable document (look, tool, ink, paper, line, tone, crop); "prefs" are sticky UI
// choices (theme, playback, film and download options). Both persist locally; the photo too.

import { Renderer, webgl2Available } from './renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS, cropDiameter } from './tone.js';
import { buildSpiral, LINE_DEFAULTS, indexAt, headAt, printedLength, previewStroke, STRIDE } from './spiral.js';
import { buildMaze } from './maze.js';
import { buildWander, buildContour, FREE_DEFAULTS } from './freeline.js';
import { BRUSHES, PAPERS, LOOKS, brushById, paperById, lookById, inkMode, hexToRgb, luminance, contrastRatio, SHEET_MM, REAL_TOOLS, realToolFor, LINE_TOOLS, lineToolFor } from './materials.js';
import { lightById } from './papers.js';
import { REAL_STYLES, SHEETS, realStyleById, autoSheet, sheetFit, fitManualSheet, realFieldRings, formatHand, formatMm, formatSheet, LAYOUT_R } from './real/index.js';
import { RealBuilder } from './real/builder.js';
import { decodeImage, fromDrawable, autoCrop, encodeForStorage, imageErrorMessage, makeCanvas } from './imageio.js';
import { loadSettings, saveSettings, clearSettings, savePhoto, loadPhoto, forgetPhoto } from './store.js';
import { History } from './history.js';
import { sliderRow, bindSeg, rovingGrid, setChecked, popover, toast, announce, fmtTime, reducedMotion, isTouch, paintRange } from './ui.js';
import { Thumbs } from './thumbs.js';
import { drawSeconds, drawProgress, signSeconds, warmFilm, filmLengthFor, filmDrawSeconds } from './film.js';
import { starCount } from './share.js';
import { Loupe } from './loupe.js';

const $ = id => document.getElementById(id);
const LAYOUT = Object.freeze({ cx: 0.5, cy: 0.5, r: 0.42 });
const CIRCLE_MM = SHEET_MM * 0.84;            // art circle diameter on the virtual sheet
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------------------------ state
const DEFAULT_DOC = {
  look: 'classic', brush: 'fineliner', ink: '#17171a', inkSource: 'swatch', paper: 'cream',
  line: { ...LINE_DEFAULTS, path: 'spiral' }, tone: { ...TONE_DEFAULTS }, crop: { ...CROP_DEFAULTS },
  free: { ...FREE_DEFAULTS },
  // Realistic mode ("a real pen on a real sheet"): one fixed-width tool at its real size, shading
  // only from line density. tool = a brush id (doc.brush follows it while the mode is on).
  mode: 'artistic',
  // paperChosen: the user picked a paper in Realistic mode, so a tool change keeps it (otherwise
  // each tool starts on its own real sheet: chalk on a board, charcoal on cold-press)
  real: { style: 'squiggle', preset: 'detailed', tool: 'fineliner', toolMm: 0.4, sheetMm: 210, sheetAuto: true, sheetPick: null, light: 'window', paperChosen: false },
  // Line art mode: one-line drawings the way continuous-line artists make them (js/lineart/):
  // a style A-D, how much of the photo it keeps (detail), hatching, the hand's wobble, a real tool
  // at its real width on an A4 sheet, the paper and the light. doc.brush / doc.paper follow it.
  lineart: { style: 'matisse', detail: 0.45, tool: 'fountain', toolMm: 0.55, paper: 'cream', light: 'window', hatch: 0, wobble: 0.3 },
  // Line art's subject, tapped by the user: [x, y] in fractions of the photo (so it survives a
  // reframe), or null for automatic. It belongs to the photo like crop: saved with it, undoable.
  subject: null,
  // the other mode's materials (tool, ink, paper, tone detail), restored when switching back
  stash: {},
};
const MODES = ['artistic', 'realistic', 'lineart'];
const LINE_STYLE_IDS = ['picasso', 'matisse', 'blind', 'brush'];
// Line art draws on a real A4 sheet (the square drawing on it), like the line-up it was tuned on
const LINE_SHEET_MM = 210;
const DEFAULT_PREFS = {
  theme: 'system', pacing: 'natural', speed: 1, showTool: true,
  film: { format: isTouch() ? 'story' : 'square', length: 15, showTool: true, polaroid: true, reveal: false, desk: 'nero', signature: '' },
  download: { format: 'png', size: 4096, background: 'paper', svgMode: 'stroke', svgPaper: false },
  visited: false,
};
applyLookTo(DEFAULT_DOC, lookById('classic'));

// the last hand-picked sheet that had to shrink for the tool (see syncAutoSheet; mergeDoc uses it)
let sheetSnap = null;
const saved = loadSettings();
let doc = mergeDoc(saved?.doc);
let prefs = mergePrefs(saved?.prefs);
let photo = null;          // { canvas, width, height, name, id, sample, alphaBox, small }
let photoSeq = 0;

function mergeDoc(d) {
  const base = structuredClone(DEFAULT_DOC);
  if (!d) return base;
  const out = { ...base, ...d, line: { ...base.line, ...d.line }, tone: { ...base.tone, ...d.tone }, crop: { ...base.crop },
    free: { ...base.free, ...(d.free || d.maze) } };
  if (!['spiral', 'wander', 'contour', 'maze'].includes(out.line.path)) out.line.path = 'spiral';
  if (!BRUSHES.some(b => b.id === out.brush)) out.brush = base.brush;
  if (!PAPERS.some(p => p.id === out.paper)) out.paper = base.paper;
  if (!/^#[0-9a-f]{6}$/i.test(out.ink)) out.ink = base.ink;
  out.mode = MODES.includes(out.mode) ? out.mode : 'artistic';
  const r = out.real = { ...base.real, ...d.real };
  if (!REAL_STYLES.some(s => s.id === r.style)) r.style = base.real.style;
  if (!['quick', 'detailed', 'masterpiece'].includes(r.preset)) r.preset = 'detailed';
  if (!REAL_TOOLS.some(t => t.brush === r.tool)) r.tool = base.real.tool;
  if (!realToolFor(r.tool).sizes.includes(r.toolMm)) r.toolMm = realToolFor(r.tool).sizes[0];
  if (!SHEETS.some(s => s.mm === r.sheetMm)) r.sheetAuto = true;
  if (!['window', 'raking', 'overhead'].includes(r.light)) r.light = 'window';
  r.paperChosen = !!r.paperChosen;
  if (!SHEETS.some(s => s.mm === r.sheetPick)) r.sheetPick = null;
  out.stash = d.stash && typeof d.stash === 'object' ? d.stash : {};
  if (out.mode === 'realistic') { out.brush = r.tool; syncAutoSheet(out); }
  const la = out.lineart = { ...base.lineart, ...d.lineart };
  if (!LINE_STYLE_IDS.includes(la.style)) la.style = base.lineart.style;
  if (!LINE_TOOLS.some(t => t.brush === la.tool)) la.tool = base.lineart.tool;
  if (!(la.toolMm > 0.1 && la.toolMm < 6)) la.toolMm = lineToolFor(la.tool).sizes[0];
  if (!PAPERS.some(p => p.id === la.paper)) la.paper = base.lineart.paper;
  if (!['window', 'raking', 'overhead'].includes(la.light)) la.light = 'window';
  for (const k of ['detail', 'hatch', 'wobble']) la[k] = Number.isFinite(+la[k]) ? clamp(+la[k], 0, 1) : base.lineart[k];
  if (out.mode === 'lineart') { out.brush = la.tool; out.paper = la.paper; if (out.inkSource === 'photo') out.inkSource = 'swatch'; }
  out.subject = null;          // (it comes back with its photo, see setPhoto)
  return out;
}
/** A saved subject tap: [x, y] photo fractions, else null. */
const validSubject = s => (Array.isArray(s) && s.length === 2 && s.every(v => Number.isFinite(+v) && +v >= 0 && +v <= 1) ? [+s[0], +s[1]] : null);
/**
 * The auto sheet: the smallest standard size on which this tool can draw a face in this style. A
 * sheet picked by hand that the new tool or style cannot fill (a fine pen on a 150 cm sheet picked
 * for a stick: days of drawing, more line than a drawing holds) snaps to the largest that fits,
 * and the Paper panel says so (sheetSnap, declared before the saved doc is merged).
 */
function syncAutoSheet(d) {
  if (d.real.sheetAuto) { d.real.sheetMm = autoSheet(d.real.style, d.real.toolMm); return; }
  // sheetPick = the sheet picked by hand: it comes back when a tool that can fill it returns
  const want = d.real.sheetPick ?? d.real.sheetMm;
  const to = fitManualSheet(d.real.style, d.real.toolMm, want);
  if (to != null) sheetSnap = { from: want, to, toolMm: d.real.toolMm, tool: d.real.tool, style: d.real.style };
  d.real.sheetMm = to ?? want;
}
function mergePrefs(p) {
  const base = structuredClone(DEFAULT_PREFS);
  if (!p) return base;
  return { ...base, ...p, film: { ...base.film, ...p.film }, download: { ...base.download, ...p.download } };
}
function persist() {
  const { crop, subject, ...rest } = doc;   // framing (and Line art's subject tap) belong to the photo; saved with it
  saveSettings({ doc: rest, prefs });
}

function applyLookTo(d, look) {
  d.look = look.id;
  d.brush = look.brush;
  d.ink = look.ink;
  d.inkSource = 'swatch';
  d.paper = look.paper;
  // a look keeps the current path (spiral or maze) unless it is a maze look itself
  const path = look.line.path || d.line?.path || 'spiral';
  d.line = { ...LINE_DEFAULTS, ...look.line, path, direction: d.line?.direction ?? 'cw', start: d.line?.start ?? 'center', seed: d.line?.seed ?? 1 };
  if (look.free) d.free = { ...(d.free || FREE_DEFAULTS), ...look.free };
}

const brush = () => brushById(doc.brush);
const realistic = () => doc.mode === 'realistic';
const lineart = () => doc.mode === 'lineart';
/** The sheet's real width: the virtual sheet in Artistic mode, the chosen real sheet in Realistic, A4 in Line art. */
const sheetMm = () => (realistic() ? doc.real.sheetMm : lineart() ? LINE_SHEET_MM : null);
/** The outline of the drawing: the spiral and circle mazes are round, square mazes square. */
const artShape = () => (realistic() ? realStyleById(doc.real.style).shape : lineart() ? 'square'
  : doc.line.path !== 'spiral' && doc.free.shape === 'square' ? 'square' : 'circle');
/** The light the sheet is lit by: named in Realistic and Line art, the default window otherwise. */
const lightId = () => (realistic() ? doc.real.light : lineart() ? doc.lineart.light : '');
/** A drawing that carries a hand clock (Realistic or Line art): { handSeconds, lengthM, toolMm, ... }. */
const handInfo = (g = geom) => (realistic() && g?.real) || (lineart() && g?.lineart) || null;
function clipArt(ctx, cx, cy, R, shape = artShape()) {
  ctx.beginPath();
  if (shape === 'square') ctx.rect(cx - R, cy - R, 2 * R, 2 * R);
  else ctx.arc(cx, cy, R, 0, Math.PI * 2);
}
const paper = () => paperById(doc.paper);
const photoColor = () => doc.inkSource === 'photo' && doc.mode === 'artistic';
const mode = () => inkMode(brush(), doc.ink, paper(), photoColor());
const flip = () => mode().flip !== !!doc.tone.invert;

// ------------------------------------------------------------------------------------ pipeline
const cache = {};
let geom = null;

function keyOf(...parts) { return parts.map(p => (typeof p === 'object' ? JSON.stringify(p) : String(p))).join('|'); }

/** Build (or reuse) the geometry for the current doc. draft = lower-resolution field for live gestures. */
function computeGeometry(draft = false) {
  if (!photo) return null;
  if (realistic()) return computeRealGeometry(draft);
  if (lineart()) return computeLineGeometry();
  const G = draft ? 512 : 1024;
  const rk = keyOf(photo.id, doc.crop, G);
  if (cache.rk !== rk) { cache.raster = rasterize(photo.canvas, doc.crop, G); cache.rk = rk; }
  const fl = flip();
  const tk = keyOf(rk, doc.tone, fl);
  if (cache.tk !== tk) { cache.tone = processTone(cache.raster, doc.tone, { flip: fl }); cache.tk = tk; }
  const fk = keyOf(tk, doc.line.rings);
  if (cache.fk !== fk) { cache.field = buildField(cache.raster, cache.tone.L, { rings: doc.line.rings, flip: fl }); cache.fk = fk; }
  const path = doc.line.path;
  const gk = keyOf(fk, doc.line, path === 'spiral' ? '' : doc.free, photoColor(), path === 'wander' && draft);
  if (cache.gk !== gk) {
    cache.geom = buildPath(path, cache.field, doc.line, doc.free, { colorFromPhoto: photoColor(), draft });
    cache.gk = gk;
  }
  return cache.geom;
}

// Realistic builds run in a worker (js/real/builder.js): the stage keeps its last image and shows
// "Drawing the line…" until the new geometry arrives, then tick() swaps it in.
const realBuilder = new RealBuilder();
// dirty: the doc changed and the next frame has not asked for its drawing yet (SP.building);
// good: the doc of the last drawing that landed, restored if a newer build fails
const realState = { key: '', want: '', geom: null, startedAt: 0, dirty: false, failed: '', good: null, draft: false };
function realOpts(d = doc) {
  const r = d.real;
  return { toolMm: r.toolMm, sheetMm: r.sheetMm, preset: r.preset, tool: r.tool, seed: d.line.seed || 1 };
}
function computeRealGeometry(draft = false) {
  // while a slider drags, a half-resolution field keeps the main thread's share (tone + field) short
  // (384: tone + field then take ~25 ms a frame; the full build follows on release)
  const G = draft ? 384 : 1024;
  const rk = keyOf(photo.id, doc.crop, G);
  if (cache.rk !== rk) { cache.raster = rasterize(photo.canvas, doc.crop, G); cache.rk = rk; }
  const fl = flip();
  const tk = keyOf(rk, doc.tone, fl);
  if (cache.tk !== tk) { cache.tone = processTone(cache.raster, doc.tone, { flip: fl }); cache.tk = tk; }
  const style = doc.real.style, opts = realOpts();
  const rings = realFieldRings(style, opts);
  const fk = keyOf(tk, rings);
  if (cache.fk !== fk) { cache.field = buildField(cache.raster, cache.tone.L, { rings, flip: fl }); cache.fk = fk; }
  const key = keyOf('real', fk, style, opts);
  realState.dirty = false;
  realState.draft = draft;
  if (realState.key === key && realState.geom) return realState.geom;
  if (realState.want !== key) {
    realState.want = key;
    realState.startedAt = performance.now();
    const snap = { real: { ...doc.real }, brush: doc.brush, ink: doc.ink, inkSource: doc.inkSource, paper: doc.paper };
    setBuilding(true);
    realBuilder.build(style, cache.field, opts, { tag: 'stage', priority: true }).then(g => {
      if (realState.want !== key) return;   // a newer build is on its way
      setBuilding(false);
      if (!g) { realBuildFailed(key); return; }
      realState.key = key; realState.geom = g; realState.good = snap; realState.failed = '';
      // a draft (slider drag) lands as a draft: asking for 'geom' here would redo tone and field
      // at full size on the main thread for every landing, which is what made drags stutter
      invalidate(realState.draft ? 'draft' : 'geom');
    });
  }
  // meanwhile the stage keeps the last realistic drawing (never the other mode's)
  return geom?.real ? geom : null;
}
/**
 * A build that failed must not leave the stage showing the old drawing under the new tool's name:
 * go back to the doc of the last drawing that landed (one undo step) and say why.
 */
function realBuildFailed(key) {
  realState.failed = key;
  const good = realState.good;
  if (good && realistic()) {
    toast('That drawing needs more line than one drawing can hold. Back to the last drawing — try a bigger tool or a smaller sheet.', { error: true });
    change(d => { Object.assign(d, { brush: good.brush, ink: good.ink, inkSource: good.inkSource, paper: good.paper }); d.real = { ...good.real }; },
      { label: 'Back to the last drawing', thumbs: true });
  } else {
    toast('This drawing could not be made. Try a bigger tool, a smaller sheet or less detail.', { error: true });
    updateStat();
  }
}
function setBuilding(on, label = 'Drawing the line…') {
  const el = $('sheet');
  clearTimeout(setBuilding.t);
  if (!on) { el.classList.remove('building'); updateStat(); return; }
  // only a build that takes a moment shows a label (most land within a frame or two)
  setBuilding.t = setTimeout(() => {
    el.dataset.building = label;
    el.classList.add('building');
    updateStat();
  }, 160);
}

/** One entry point for every path shape. */
function buildPath(path, field, line, free, opts = {}) {
  if (path === 'maze') return buildMaze(field, line, free, opts);
  if (path === 'wander') return buildWander(field, line, free, opts);
  if (path === 'contour') return buildContour(field, line, free, opts);
  return buildSpiral(field, line, opts);
}

/** Everything export / film need to reproduce the current drawing. */
export function renderState(g = geom) {
  const m = mode();
  return {
    geom: g, brush: brush(), paper: paper(), ink: doc.ink, cover: m.cover, photoColor: photoColor(),
    layout: { ...LAYOUT }, seed: doc.line.seed || 1, shape: artShape(),
    // Realistic and Line art: the real sheet (paper texture keeps its millimetre size) and the chosen light
    mode: doc.mode, real: realistic() ? { ...doc.real } : null, lineart: lineart() ? { ...doc.lineart } : null,
    sheetMm: sheetMm(), light: lightId() ? lightById(lightId()) : null,
  };
}

// ------------------------------------------------------------------------------------ renderer
if (!webgl2Available()) {
  $('fatal').hidden = false;
  throw new Error('WebGL2 unavailable');
}
const art = $('art');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
let renderer;
try {
  // block: false = never freeze the page for a shader compile (the stage keeps its last image
  // until the new tool's programs are ready); warmup = compile the other tools in the background
  renderer = new Renderer(art, {
    block: false, warmup: true, lowMemory: isTouch(),
    onLost: () => toast('Graphics reset — redrawing…'),
    onRestored: () => { thumbs.invalidateAll(); refreshThumbs(); invalidate('geom'); },
  });
} catch (e) {
  console.error(e);
  $('fatal').hidden = false;
  throw e;
}
const thumbs = new Thumbs();

// The loupe: zoom into the sheet to see the medium at full density (js/loupe.js). Framing and
// choosing a start point work on the whole sheet, so they fit it first.
const loupe = new Loupe($('sheet'), {
  ui: {
    bar: $('loupeBar'), zoom: $('loupeZ'), rule: $('loupeRule'), mm: $('loupeMm'),
    btnIn: $('loupeIn'), btnOut: $('loupeOut'), btnFit: $('loupeFit'), btnToggle: $('btnLoupe'),
  },
  sheetMm: () => sheetMm() ?? SHEET_MM,
  canZoom: () => !!photo && !framing.active && !picking.active,
  onChange: () => invalidate('render'),
  onGesture: () => clearTimeout(lpTimer),
  announce: text => announce(text),
  reducedMotion,
});

// ------------------------------------------------------------------------------------ playback
const play = {
  f: 1,               // drawing progress 0..1 (transport position)
  playing: false,
  demo: false,        // the one-off reveal after a photo loads
  last: 0,
  lift: 1,            // tool lift 0 (drawing) .. 1 (gone)
  scrubbing: false,
  dryAt: 0,           // when playback reached the end: wet ink then dries on screen (DRY_MS)
};
// the drawing's share of the film: the transport previews exactly the film's pace
// (Realistic: the film that the dialog makes: its own length for long drawings, never a reveal)
// (Line art: a drawing shorter than the film at real speed is drawn at 1x: filmDrawSeconds)
const drawSec = () => (handInfo()
  ? filmDrawSeconds(prefs.film, geom, true)
  : drawSeconds(prefs.film.length, prefs.film.reveal, prefs.film.style, signSeconds(prefs.film.signature)));
/** Hand time reached at transport position f (Realistic drawings carry the hand clock). */
const handAtF = f => geom.handT[Math.min(geom.n - 1, Math.floor(pointIndexFinite(f)))];
// Wet ink dries over this long once the pen lifts, as in the film (a finished still is dry).
const DRY_MS = 1600;
function dryness(now) {
  if (!play.dryAt) return 1;
  const k = (now - play.dryAt) / DRY_MS;
  if (k >= 1) { play.dryAt = 0; return 1; }
  return Math.max(0, k);
}

function pointIndex(f) {
  if (!geom) return 0;
  if (f >= 1) return Infinity;
  return indexAt(geom, drawProgress(f, drawSec()), prefs.pacing);
}

const pointIndexFinite = f => { const fi = pointIndex(f); return Number.isFinite(fi) ? fi : (geom ? geom.n - 1 : 0); };

function setPlaying(on, { demo = false } = {}) {
  if (on && !photo) return;
  if (on && play.f >= 1) play.f = 0;
  if (on) play.dryAt = 0;
  play.playing = on;
  play.demo = on && demo;
  play.last = performance.now();
  const btn = $('btnPlay');
  btn.querySelector('use').setAttribute('href', on ? '#i-pause' : play.f >= 1 ? '#i-replay' : '#i-play');
  btn.setAttribute('aria-label', on ? 'Pause' : play.f >= 1 ? 'Replay the drawing' : 'Play the drawing');
  invalidate('render');
}

function finishDemo() {
  if (play.demo) { play.f = 1; setPlaying(false); }
}

// ------------------------------------------------------------------------------------ frame loop
const need = { geom: false, draft: false, render: false, thumbs: false, penSees: false };
let rafId = 0;

function invalidate(what = 'render') {
  if (what === 'geom') need.geom = true;
  if (what === 'draft') { need.geom = true; need.draft = true; }
  need.render = true;
  if (!rafId) rafId = requestAnimationFrame(tick);
}

let lastGeomMs = 0;
function tick(now) {
  rafId = 0;
  let busy = false;
  if (need.geom) {
    const t0 = performance.now();
    const draft = need.draft;
    need.geom = false; need.draft = false;
    const g = computeGeometry(draft);
    if (g !== geom && (g || !!photo)) { geom = g; if (g) renderer.setGeometry(geom); }
    lastGeomMs = performance.now() - t0;
    if (!draft) { need.penSees = true; scheduleIdleWork(); }
    updateStat();
  }
  applyRendererState();

  // The tool's programs may still be compiling (on the driver's own threads): keep the last image
  // and hold the clock rather than freeze the page for them, and look again next frame.
  const compiling = renderer.pending();
  $('sheet').classList.toggle('compiling', compiling);
  if (play.playing && compiling) play.last = now;
  else if (play.playing) {
    const dt = Math.min(0.1, (now - play.last) / 1000);
    play.last = now;
    const dur = play.demo ? 3 : drawSec() / prefs.speed;
    play.f = Math.min(1, play.f + dt / dur);
    if (play.f >= 1) { setPlaying(false); busy = false; if (!play.demo) play.dryAt = now; }
  }
  const drying = play.dryAt > 0 && brush().wetness > 0;
  if (!compiling) {
    const upTo = pointIndex(play.f);
    const opts = upTo === Infinity ? { settle: dryness(now) } : undefined;
    if (geom && loupe.active) loupe.draw(renderer, upTo, opts, now);
    else {
      loupe.release(renderer);
      if (geom) renderer.render(upTo, opts);
      else renderer.renderBlank();
    }
  }
  drawOverlay(now);
  updateTransport();
  const animating = play.playing || drying || (play.lift < 1 && play.f >= 1 && prefs.showTool) || loupe.busy(now);
  if (animating || busy || compiling) rafId = requestAnimationFrame(tick);
  need.render = false;
}

function applyRendererState() {
  const m = mode();
  renderer.setLayout(LAYOUT);
  renderer.setPaper(paper(), 1);
  renderer.setStyle({ brush: brush(), ink: doc.ink, cover: m.cover, photoColor: photoColor() });
  // wet ink spreads and dries with the pacing the transport plays
  renderer.setPacing(prefs.pacing);
  // Realistic: grain, fibres and grit keep their real millimetre size on a big sheet; named light
  const mm = sheetMm();
  if (typeof renderer.setSheetMm === 'function' && applyRendererState.mm !== mm) { renderer.setSheetMm(mm); applyRendererState.mm = mm; }
  const light = lightId();
  if (applyRendererState.light !== light) { renderer.setLight(light ? lightById(light) : undefined); applyRendererState.light = light; }
  $('sheet').style.background = paper().color;
}

// ------------------------------------------------------------------------------------ stage size
let sheetCss = 600;
function layoutStage() {
  const stage = $('stage');
  const w = stage.clientWidth, h = stage.clientHeight;
  const mobile = matchMedia('(max-width: 767px)').matches;
  let side;
  const welcome = !$('welcome').hidden;
  if (mobile) {
    side = Math.min(w - 32, window.innerHeight * 0.46);
  } else if (welcome) {
    // the welcome card sits below the sheet instead of covering the drawing
    const cardH = $('welcome').offsetHeight || 250;
    side = Math.min(w - 96, h - cardH - 22 - 20 - 20);
  } else {
    side = Math.min(w - 96, h - 150);
  }
  side = Math.floor(clamp(side, 220, 1100));
  sheetCss = side;
  document.documentElement.style.setProperty('--sheet', `${side}px`);
  loupe.resize();
  const px = Math.round(Math.min(side * DPR(), mobile ? 2048 : 2600));
  if (renderer.s.width !== px) {
    renderer.setSize(px, px);
    sizeOverlay();
  }
  invalidate('render');
}
// The overlay extends past the sheet so the drawing tool can overhang onto the desk.
const OVER = 0.35;
function sizeOverlay() {
  const px = Math.min(2600, Math.round(sheetCss * (1 + 2 * OVER) * DPR()));
  overlay.style.inset = `${-OVER * 100}%`;
  overlay.style.width = overlay.style.height = `${(1 + 2 * OVER) * 100}%`;
  if (overlay.width !== px) { overlay.width = px; overlay.height = px; }
}
const stageObserver = new ResizeObserver(() => {
  clearTimeout(layoutStage.t);
  layoutStage.t = setTimeout(layoutStage, 60);
});
stageObserver.observe($('stage'));
stageObserver.observe($('welcome'));

// ------------------------------------------------------------------------------------ overlay
let toolModule = null;
import('./tools.js').then(m => { toolModule = m; invalidate('render'); }).catch(() => { /* tools optional */ });
let lastToolBox = null;
const view = { compare: 0, penSees: false };

function sheetToOverlay(x, y) {
  // circle units -> overlay px
  const S = overlay.width / (1 + 2 * OVER);
  const o = OVER * S;
  return [o + (LAYOUT.cx + x * LAYOUT.r) * S, o + (LAYOUT.cy + y * LAYOUT.r) * S];
}

function drawOverlay(now) {
  const W = overlay.width, S = W / (1 + 2 * OVER), o = OVER * S;
  const zoomed = loupe.active;
  const full = framing.active || view.compare || view.penSees || zoomed;
  if (full || drawOverlay.wasFull) {
    octx.clearRect(0, 0, W, W);
    lastToolBox = null;
  } else if (lastToolBox) {
    octx.clearRect(...lastToolBox);
    lastToolBox = null;
  }
  drawOverlay.wasFull = full;
  const cx = o + LAYOUT.cx * S, cy = o + LAYOUT.cy * S, R = LAYOUT.r * S;

  if (framing.active && photo) {
    // the whole photo, faint, with the circle cut out so the live drawing shows through
    octx.save();
    octx.beginPath();
    octx.rect(0, 0, W, W);
    if (artShape() === 'square') octx.rect(cx - R, cy - R, 2 * R, 2 * R);
    else octx.arc(cx, cy, R, 0, Math.PI * 2, true);
    octx.clip('evenodd');
    octx.globalAlpha = 0.32;
    drawPhotoInCircle(octx, cx, cy, R);
    octx.restore();
    octx.save();
    octx.setLineDash([6 * DPR(), 5 * DPR()]);
    octx.lineWidth = 1.5 * DPR();
    octx.strokeStyle = 'rgba(196,61,22,.9)';
    clipArt(octx, cx, cy, R); octx.stroke();
    octx.restore();
    return;
  }
  if (zoomed) {
    // The loupe shows part of the sheet: the photo (compare / what the pen sees) is mapped the same
    // way and cut at the sheet's edge. The tool sprite hides: at 10x it would cover the view.
    play.lift = 1;
    if (!(view.compare || view.penSees) || !photo) return;
    const [vx, vy] = loupe.view(), z = loupe.z;
    octx.save();
    octx.beginPath(); octx.rect(o, o, S, S); octx.clip();
    octx.setTransform(z, 0, 0, z, o * (1 - z) - z * vx * S, o * (1 - z) - z * vy * S);
    clipArt(octx, cx, cy, R); octx.clip();
    if (view.penSees && cache.field) drawFieldInCircle(octx, cx, cy, R);
    else drawPhotoInCircle(octx, cx, cy, R);
    octx.restore();
    return;
  }
  if ((view.compare || view.penSees) && photo) {
    octx.save();
    clipArt(octx, cx, cy, R); octx.clip();
    if (view.penSees && cache.field) drawFieldInCircle(octx, cx, cy, R);
    else drawPhotoInCircle(octx, cx, cy, R);
    octx.restore();
    return;
  }

  // Line art: choosing the subject (the faint photo and the shape found so far), a pin after a tap
  if (lineart() && (subjectPick.active || subjectPick.flash > now)) { drawSubjectOverlay(now, S, o, cx, cy, R); return; }
  // maze start point: crosshair while choosing, a pin that fades after a pick
  if (!realistic() && doc.line.path !== 'spiral' && (picking.active || picking.flash > now)) {
    const px = picking.active && picking.hover ? picking.hover : [doc.free.x, doc.free.y];
    const [mx, my] = sheetToOverlay(px[0], px[1]);
    const a = picking.active ? 1 : Math.min(1, (picking.flash - now) / 600);
    const u = S / 100;
    octx.save();
    octx.globalAlpha = a;
    octx.lineWidth = 0.45 * u;
    octx.strokeStyle = '#c43d16';
    octx.fillStyle = 'rgba(196,61,22,.18)';
    octx.beginPath(); octx.arc(mx, my, 2.6 * u, 0, Math.PI * 2); octx.fill(); octx.stroke();
    octx.beginPath();
    octx.moveTo(mx - 4.2 * u, my); octx.lineTo(mx - 1.4 * u, my); octx.moveTo(mx + 1.4 * u, my); octx.lineTo(mx + 4.2 * u, my);
    octx.moveTo(mx, my - 4.2 * u); octx.lineTo(mx, my - 1.4 * u); octx.moveTo(mx, my + 1.4 * u); octx.lineTo(mx, my + 4.2 * u);
    octx.stroke();
    octx.fillStyle = '#c43d16';
    octx.beginPath(); octx.arc(mx, my, 0.6 * u, 0, Math.PI * 2); octx.fill();
    octx.restore();
    lastToolBox = null;
    drawOverlay.wasFull = true;   // clear the whole overlay next frame
    if (!picking.active) invalidate('render');
    return;
  }

  // drawing tool riding the head of the line
  if (!toolModule || !geom || !prefs.showTool) { play.lift = 1; return; }
  const drawing = play.f < 1 && (play.playing || play.scrubbing || play.f > 0);
  if (drawing) play.lift = 0;
  else if (play.lift < 1) play.lift = Math.min(1, play.lift + 1 / 24);
  if (!drawing && play.lift >= 1) return;
  const fi = pointIndex(Math.min(play.f, 0.99999));
  const h = headAt(geom, Number.isFinite(fi) ? fi : geom.n - 1);
  const [x, y] = sheetToOverlay(h.x, h.y);
  // Realistic: the tool at its real length on the real sheet (a 9 cm charcoal stick is small over a
  // 1.5 m sheet); never longer than the Artistic sprite, which is already short for an A4 sheet
  const realLen = { charcoal: 90, chalk: 80, crayon: 90, marker: 140, brush: 220, watercolour: 220 }[doc.brush] || 150;
  const size = S * (sheetMm() ? clamp(realLen / sheetMm(), 0.05, 0.28) : 0.28);
  const lift = play.lift;
  const opts = {
    color: photoColor() ? '#8a5a44' : doc.ink,
    lift, alpha: 1 - lift * lift, sway: (now / 1000) % 1000,
  };
  try {
    toolModule.drawTool(octx, brush().tool, x + lift * size * 0.25, y + lift * size * 0.2, size, opts);
  } catch (e) { console.warn(e); }
  // conservative dirty box (tool points to the lower right)
  const pad = size * 0.25;
  lastToolBox = [x - pad - size * 0.1, y - pad - size * 0.4, size * 1.5 + pad * 2, size * 1.5 + pad * 2].map(Math.round);
  lastToolBox[2] += 2; lastToolBox[3] += 2;
}

function drawPhotoInCircle(ctx, cx, cy, R) {
  const w = photo.width, h = photo.height;
  const diam = cropDiameter(w, h, doc.crop);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale((2 * R) / diam, (2 * R) / diam);
  ctx.rotate((doc.crop.rotation || 0) * Math.PI / 180);
  ctx.translate(-doc.crop.x * w, -doc.crop.y * h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.canvas, 0, 0);
  ctx.restore();
}

let fieldImg = null, fieldImgKey = '';
function fieldImage(size) {
  const f = cache.field;
  const key = cache.fk + size;
  if (fieldImg && fieldImgKey === key) return fieldImg;
  const c = fieldImg && fieldImg.width === size ? fieldImg : makeCanvas(size, size);
  const g = c.getContext('2d');
  const im = g.createImageData(size, size);
  const G = f.G, pap = hexToRgb(paper().color);
  const dark = luminance(pap) < 0.3;
  for (let y = 0; y < size; y++) {
    const gy = Math.min(G - 1, Math.floor((y + 0.5) / size * G));
    for (let x = 0; x < size; x++) {
      const gx = Math.min(G - 1, Math.floor((x + 0.5) / size * G));
      const D = f.D[gy * G + gx];
      const v = dark ? 20 + D * 225 : 250 - D * 235;
      const o = (y * size + x) * 4;
      im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0);
  fieldImg = c; fieldImgKey = key;
  return c;
}
function drawFieldInCircle(ctx, cx, cy, R) {
  ctx.drawImage(fieldImage(512), cx - R, cy - R, 2 * R, 2 * R);
}

function drawPenSees() {
  const c = $('penSees');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!cache.field) return;
  g.save();
  g.beginPath(); g.arc(c.width / 2, c.height / 2, c.width / 2, 0, Math.PI * 2); g.clip();
  g.drawImage(fieldImage(256), 0, 0, c.width, c.height);
  g.restore();
}

// ------------------------------------------------------------------------------------ transport UI
const scrub = $('scrub');
function updateTransport() {
  if (!play.scrubbing) scrub.value = Math.round(play.f * 1000);
  paintRange(scrub);
  const total = drawSec();
  // Realistic and Line art: the honest clock is the hand's ('13 min / 58 min'), not the film's 12 s
  const hi = handInfo(), hand = hi && geom.handT;
  $('time').textContent = hand ? `${formatHand(handAtF(play.f))} / ${formatHand(hi.handSeconds)}`
    : `${fmtTime(play.f * total)} / ${fmtTime(total)}`;
  $('time').classList.toggle('hand', !!hand);
  const ring = geom ? Math.round(headRing()) : 0;
  scrub.setAttribute('aria-valuetext', `${fmtTime(play.f * total)} of ${fmtTime(total)}${geom ? `, ring ${ring} of ${geom.rings}` : ''}`);
  const btn = $('btnPlay');
  if (!play.playing) {
    btn.querySelector('use').setAttribute('href', play.f >= 1 ? '#i-replay' : '#i-play');
    btn.setAttribute('aria-label', play.f >= 1 ? 'Replay the drawing' : 'Play the drawing');
  }
}
function headRing(f = play.f) {
  if (!geom) return 0;
  const fi = pointIndex(Math.min(f, 0.99999));
  const t = headAt(geom, Number.isFinite(fi) ? fi : geom.n - 1).turn;
  return geom.start === 'edge' ? geom.turns - t : t;
}

scrub.addEventListener('pointerdown', () => { play.scrubbing = true; finishDemo(); if (play.playing) setPlaying(false); });
scrub.addEventListener('input', () => {
  play.f = +scrub.value / 1000;
  play.scrubbing = true;
  invalidate('render');
  const tip = $('scrubTip');
  const total = drawSec();
  tip.hidden = false;
  tip.textContent = handInfo() && geom.handT
    ? `${formatHand(handAtF(play.f))} of ${formatHand(handInfo().handSeconds)} by hand`
    : geom && geom.path !== 'spiral'
    ? `${Math.round(play.f * 100)}% drawn · ${fmtTime(play.f * total)}`
    : `Ring ${Math.round(headRing())} of ${geom?.rings ?? 0} · ${fmtTime(play.f * total)}`;
  tip.style.left = `${play.f * 100}%`;
});
const endScrub = () => { play.scrubbing = false; $('scrubTip').hidden = true; invalidate('render'); };
scrub.addEventListener('change', endScrub);
scrub.addEventListener('pointerup', endScrub);
scrub.addEventListener('blur', endScrub);
$('btnPlay').addEventListener('click', () => {
  if (play.demo) finishDemo();
  setPlaying(!play.playing);
});

// ------------------------------------------------------------------------------------ history
const history = new History({
  onChange: h => {
    $('btnUndo').disabled = !h.canUndo;
    $('btnRedo').disabled = !h.canRedo;
    $('btnUndo').title = h.canUndo ? `Undo ${h.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    $('btnRedo').title = h.canRedo ? `Redo ${h.redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
  },
});
const snapshot = () => structuredClone(doc);
function commit(label) { history.commit(snapshot(), label); persist(); if (label === 'Framing') saveSession(); }
function restore(d) {
  if (!d) return;
  const cropChanged = JSON.stringify(d.crop) !== JSON.stringify(doc.crop);
  const subjectChanged = JSON.stringify(d.subject ?? null) !== JSON.stringify(doc.subject ?? null);
  doc = d;
  syncControls();
  invalidate('geom');
  refreshThumbs(cropChanged);
  persist();
  if (cropChanged || subjectChanged) saveSession();
}
$('btnUndo').addEventListener('click', () => { const l = history.undoLabel; restore(history.undo()); if (l) announce(`Undid ${l}`); });
$('btnRedo').addEventListener('click', () => { const l = history.redoLabel; restore(history.redo()); if (l) announce(`Redid ${l}`); });

// ------------------------------------------------------------------------------------ doc changes
/** Apply a change to the doc. level: 'geom' (needs new line) or 'render' (style only). */
function change(mutate, { label, level = 'geom', live = false, thumbs: th = false } = {}) {
  mutate(doc);
  if (realistic() && level === 'geom') realState.dirty = true;
  finishDemo();
  if (live) invalidate(lastGeomMs > 34 ? 'draft' : 'geom');
  else invalidate(level);
  if (label) commit(label);
  syncControls();
  if (th) refreshThumbs();
}

// ------------------------------------------------------------------------------------ inspector: looks
const looksEl = $('looks');
function buildLooks() {
  looksEl.replaceChildren(...LOOKS.map((look, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look';
    b.setAttribute('role', 'radio');
    b.dataset.id = look.id;
    b.title = `${look.name}${i < 9 ? ` (${i + 1})` : ''}`;
    b.innerHTML = `<span class="thumb"><canvas></canvas><span class="skeleton"></span></span><span class="name"></span>`;
    b.querySelector('.name').textContent = look.name;
    b.addEventListener('click', () => applyLook(look.id));
    return b;
  }));
  rovingGrid(looksEl);
}
function lookEdited() {
  const look = lookById(doc.look);
  if (!look) return false;
  if (doc.brush !== look.brush || doc.paper !== look.paper || doc.ink !== look.ink || doc.inkSource !== 'swatch') return true;
  return Object.entries(look.line).some(([k, v]) => doc.line[k] !== v);
}
function applyLook(id) {
  const look = lookById(id);
  const was = lookEdited() && doc.look === id;
  change(d => applyLookTo(d, look), { label: `Look: ${look.name}`, thumbs: true });
  announce(was ? `Reverted to ${look.name}` : `${look.name} look`);
}
$('lookRevert').addEventListener('click', () => applyLook(doc.look));

// ------------------------------------------------------------------------------------ inspector: tools + inks
const toolsEl = $('tools');
function buildTools() {
  toolsEl.replaceChildren(...BRUSHES.map(b => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip';
    el.setAttribute('role', 'radio');
    el.dataset.id = b.id;
    el.title = `${b.name} — ${b.blurb}`;
    el.innerHTML = `<span class="thumb"><canvas></canvas><span class="skeleton"></span></span><span class="name"></span>`;
    el.querySelector('.name').textContent = b.name;
    el.addEventListener('click', () => setBrush(b.id));
    return el;
  }));
  rovingGrid(toolsEl);
}
/** The ink a tool should use on the current paper: keep custom/photo/in-palette, else its default
 *  (or its first light ink on dark paper, so switching tools never makes the line vanish). */
function inkFor(b, p = paper()) {
  if (doc.inkSource !== 'swatch') return doc.ink;
  const reads = h => { const m = inkMode(b, h, p); return !m.lowContrast && (!p.dark || m.flip); };
  if (b.inks.some(([h]) => h === doc.ink) && reads(doc.ink)) return doc.ink;
  // the tool's own first ink whenever it reads on this sheet (gold stays gold on black, not silver)
  const pap = hexToRgb(p.color), first = b.inks[0][0];
  if (reads(first) && (!p.dark || contrastRatio(hexToRgb(first), pap) >= 2)) return first;
  // otherwise the palette ink that stands out most on this sheet
  return b.inks.reduce((best, [h]) => (contrastRatio(hexToRgb(h), pap) > contrastRatio(hexToRgb(best), pap) ? h : best), b.inks[0][0]);
}
/** The paper a tool chip is shown on: the current sheet if the tool has an ink that reads on it,
 *  otherwise a sheet that suits the tool (dark boards for chalk and light media, sketchbook else). */
function chipPaperFor(b, p) {
  if (b.prefersDark && !p.dark) return paperById(b.id === 'chalk' ? 'chalkboard' : 'black');
  const pap = hexToRgb(p.color);
  const best = Math.max(...b.inks.map(([h]) => contrastRatio(hexToRgb(h), pap)));
  return best >= 2.2 ? p : paperById(p.dark ? 'sketch' : 'black');
}
function setBrush(id) {
  const b = brushById(id);
  if (b.id === doc.brush) return;
  change(d => { d.brush = b.id; d.ink = inkFor(b); }, { label: `Tool: ${b.name}`, level: 'geom', thumbs: true });
  announce(`${b.name}`);
}
const inksEl = $('inks');
function buildInks() {
  const b = brush();
  const items = b.inks.map(([hex, name]) => {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch';
    s.setAttribute('role', 'radio');
    s.style.setProperty('--c', hex);
    s.dataset.hex = hex;
    s.title = name;
    s.setAttribute('aria-label', name);
    s.addEventListener('click', () => change(d => { d.ink = hex; d.inkSource = 'swatch'; }, { label: `Ink: ${name}`, thumbs: true }));
    return s;
  });
  const ph = document.createElement('button');
  ph.type = 'button';
  ph.className = 'swatch photo';
  ph.setAttribute('role', 'radio');
  ph.dataset.src = 'photo';
  ph.title = 'Colour from the photo';
  ph.setAttribute('aria-label', 'Colour from the photo');
  ph.addEventListener('click', () => change(d => { d.inkSource = 'photo'; }, { label: 'Ink: from photo', thumbs: true }));
  const cu = document.createElement('label');
  cu.className = 'swatch custom';
  cu.setAttribute('role', 'radio');
  cu.dataset.src = 'custom';
  cu.title = 'Custom colour';
  cu.innerHTML = '<input type="color" aria-label="Custom ink colour">';
  const input = cu.querySelector('input');
  input.value = doc.ink;
  input.addEventListener('input', () => change(d => { d.ink = input.value; d.inkSource = 'custom'; }, { level: 'geom' }));
  input.addEventListener('change', () => { commit('Ink: custom'); refreshThumbs(); });
  cu.addEventListener('click', e => { if (e.target === cu) input.click(); });
  inksEl.replaceChildren(...items, ph, cu);
  rovingGrid(inksEl);
}

// ------------------------------------------------------------------------------------ inspector: papers
const papersEl = $('papers');
function buildPapers() {
  papersEl.replaceChildren(...PAPERS.map(p => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip';
    el.setAttribute('role', 'radio');
    el.dataset.id = p.id;
    el.title = p.name;
    el.innerHTML = `<span class="thumb" style="background:${p.color}"><canvas></canvas></span><span class="name"></span>`;
    el.querySelector('.name').textContent = p.name;
    el.addEventListener('click', () => setPaper(p.id));
    return el;
  }));
  rovingGrid(papersEl);
}
function setPaper(id) {
  const p = paperById(id);
  if (p.id === doc.paper) return;
  change(d => { d.paper = p.id; if (realistic()) d.real.paperChosen = true; if (lineart()) d.lineart.paper = p.id; }, { label: `Paper: ${p.name}`, level: 'geom', thumbs: true });
  announce(p.name);
}

// ------------------------------------------------------------------------------------ inspector: line
const TECH_HELP = {
  thickness: 'The line swells in dark areas.',
  wave: 'One pen width; the line wiggles in dark areas. Best for pen plotters.',
  both: 'The line swells and wiggles.',
};
const spacingMm = () => (CIRCLE_MM / 2) / doc.line.rings;
const lineSliders = {};
function buildLineSliders() {
  const host = $('lineSliders'), more = $('lineMoreSliders');
  const L = LINE_DEFAULTS;
  const mk = (key, o, parent = host) => {
    const s = sliderRow({
      ...o,
      value: o.get ? o.get() : doc.line[key],
      onInput: (v, dragging) => change(d => { o.set ? o.set(d, v) : (d.line[key] = v); }, { live: dragging }),
      onCommit: () => { commit(o.label); invalidate('geom'); refreshThumbs(); },
    });
    s.key = key;
    s.get = o.get || (() => doc.line[key]);
    lineSliders[key] = s;
    parent.append(s.el);
    return s;
  };
  mk('rings', { label: 'Rings', min: 20, max: 160, step: 1, def: 72, format: v => `${v}`, valuetext: v => `${v} rings`,
    hint: 'More rings = finer detail' });
  mk('weight', { label: 'Line weight', min: 0.3, max: 1, step: 0.01, def: L.weight, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'How thick the line gets in the darkest areas' });
  mk('penWidth', { label: 'Pen width', min: 0.06, max: 0.45, step: 0.005, def: L.penWidth,
    format: v => `${(v * spacingMm()).toFixed(2)} mm`, valuetext: v => `${(v * spacingMm()).toFixed(2)} millimetres`,
    toEdit: v => +(v * spacingMm()).toFixed(2), fromEdit: v => v / spacingMm() });
  mk('amplitude', { label: 'Wave height', min: 0.2, max: 1, step: 0.01, def: L.amplitude, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100 });
  mk('frequency', { label: 'Wave density', min: 0.5, max: 3, step: 0.05, def: L.frequency, format: v => `${v.toFixed(2)}×` });
  mk('wobble', { label: 'Hand wobble', min: 0, max: 1, step: 0.01, def: L.wobble, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'Makes the spiral look hand-drawn' });
  mk('hairline', { label: 'Thinnest line', min: 0.02, max: 0.3, step: 0.01, def: L.hairline, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'Keeps the single line visible in light areas' }, more);
  mk('edgeFade', { label: 'Edge fade', min: 0, max: 8, step: 0.5, def: L.edgeFade, format: v => v ? `${v} rings` : 'Off',
    hint: 'Fades the drawing into a hairline at the rim' }, more);
}
const PATH_HELP = {
  spiral: 'One line spirals out from the centre of the circle.',
  wander: 'One line wanders in unexpected directions from the point you choose, packing tighter where the photo is dark.',
  contour: 'A continuous-line drawing: one line traces the outlines, gliding from shape to shape.',
  maze: 'One line winds through a maze that grows from the point you choose.',
};
const DETAIL_LABEL = { spiral: 'Rings', wander: 'Density', contour: 'Detail', maze: 'Corridors' };
function showLineControls() {
  const t = doc.line.technique;
  const path = doc.line.path;
  const free = path !== 'spiral';
  const maze = path === 'maze';
  $('mazeCtl').hidden = !free;
  $('spinRow').hidden = free;
  for (const el of document.querySelectorAll('.maze-only')) el.hidden = !maze;
  $('pathHelp').textContent = PATH_HELP[path];
  lineSliders.rings.el.querySelector('label').textContent = DETAIL_LABEL[path];
  // wave squiggles only make sense on a regular path; free lines already wander
  for (const b of document.querySelectorAll('[data-bind="technique"] [role="radio"]')) b.disabled = (path === 'wander' || path === 'contour') && b.dataset.v !== 'thickness';
  lineSliders.edgeFade.el.querySelector('label').textContent = 'Edge fade';
  // the pen always starts at the chosen point in a maze; "draw from" only means something for spirals
  for (const b of document.querySelectorAll('[data-bind="start"] [role="radio"]')) b.disabled = free;
  for (const b of document.querySelectorAll('[data-film="start"] [role="radio"]')) b.disabled = free;
  const show = { rings: 1, weight: t !== 'wave', penWidth: t !== 'thickness', amplitude: t !== 'thickness', frequency: t !== 'thickness', wobble: 1 };
  for (const [k, s] of Object.entries(lineSliders)) {
    if (k in show) s.el.hidden = !show[k];
  }
  lineSliders.hairline.el.hidden = t === 'wave';
  $('techHelp').textContent = TECH_HELP[t];
}
const PATH_NAME = { spiral: 'Spiral', wander: 'Wander', contour: 'Contour', maze: 'Maze' };
const pathSeg = bindSeg(document.querySelector('[data-bind="path"]'), doc.line.path, v => {
  change(d => {
    d.line.path = v;
    // free lines need a solid stroke; the wave technique is kept for spirals and mazes
    if ((v === 'wander' || v === 'contour') && d.line.technique !== 'thickness') d.line.technique = 'thickness';
  }, { label: PATH_NAME[v], thumbs: true });
  announce(v === 'spiral' ? 'Spiral path' : `${PATH_NAME[v]} path. Choose a start point on the sheet.`);
  if (v !== 'spiral') picking.flash = performance.now() + 1800;
  if (!reducedMotion()) { play.f = 0; setPlaying(true, { demo: true }); }
});
const shapeSeg = bindSeg(document.querySelector('[data-bind="shape"]'), doc.free.shape, v =>
  change(d => { d.free.shape = v; }, { label: `Maze: ${v}`, thumbs: true }));
$('btnNewMaze').addEventListener('click', () => change(d => { d.free.seed = ((d.free.seed || 1) % 9973) + 1; }, { label: 'New layout', thumbs: true }));
const mazeSliders = {};
{
  const s = sliderRow({
    label: 'Follow the photo', min: 0, max: 1, step: 0.01, def: 0.8, value: doc.free.flow,
    format: v => `${Math.round(v * 100)}%`, toEdit: v => Math.round(v * 100), fromEdit: v => v / 100,
    hint: 'How strongly the corridors run along the shapes in the photo',
    onInput: (v, dragging) => change(d => { d.free.flow = v; }, { live: dragging }),
    onCommit: () => { commit('Maze flow'); invalidate('geom'); refreshThumbs(); },
  });
  mazeSliders.flow = s;
  $('mazeSliders').append(s.el);
}

// choosing the maze start point on the sheet
const picking = { active: false, hover: null, flash: 0 };
function setPicking(on) {
  if (on && (!photo || framing.active)) return;
  if (on) loupe.fit({ instant: true });
  picking.active = on;
  picking.hover = null;
  $('sheet').classList.toggle('picking', on);
  $('pickHint').hidden = !on;
  $('btnPickStart').setAttribute('aria-pressed', String(on));
  if (on) { finishDemo(); setPlaying(false); play.f = 1; announce('Click or tap the sheet where the line should start. Escape cancels.'); }
  invalidate('render');
}
function sheetPointToCircle(e) {
  const r = $('sheet').getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width - LAYOUT.cx) / LAYOUT.r;
  const y = ((e.clientY - r.top) / r.width - LAYOUT.cy) / LAYOUT.r;
  return [clamp(x, -1, 1), clamp(y, -1, 1)];
}
$('btnPickStart').addEventListener('click', () => setPicking(!picking.active));
$('sheet').addEventListener('pointermove', e => { if (picking.active) { picking.hover = sheetPointToCircle(e); invalidate('render'); } });
$('sheet').addEventListener('pointerleave', () => { if (picking.active) { picking.hover = null; invalidate('render'); } });
$('sheet').addEventListener('pointerdown', e => {
  if (!picking.active) return;
  e.preventDefault();
  e.stopPropagation();
  const [x, y] = sheetPointToCircle(e);
  setPicking(false);
  picking.flash = performance.now() + 1800;
  change(d => { d.free.x = +x.toFixed(4); d.free.y = +y.toFixed(4); }, { label: 'Start point', thumbs: true });
  // show the new maze growing from the chosen point
  if (!reducedMotion()) { play.f = 0; setPlaying(true, { demo: true }); }
}, true);
const techSeg = bindSeg(document.querySelector('[data-bind="technique"]'), doc.line.technique, v =>
  change(d => { d.line.technique = v; }, { label: `Technique: ${v}`, thumbs: true }));
const dirSeg = bindSeg(document.querySelector('[data-bind="direction"]'), doc.line.direction, v =>
  change(d => { d.line.direction = v; }, { label: 'Spin' }));
$('btnShuffle').addEventListener('click', () => change(d => { d.line.seed = ((d.line.seed || 1) % 997) + 1; }, { label: 'Shuffle wobble' }));
$('lineReset').addEventListener('click', () => {
  const look = lookById(doc.look);
  change(d => { d.line = { ...LINE_DEFAULTS, ...look.line, path: look.line.path || d.line.path, direction: d.line.direction, start: d.line.start, seed: d.line.seed }; },
    { label: 'Reset line', thumbs: true });
});

function updateStat() {
  updateRealInfo();
  updateLineInfo();
  const el = $('lineStat');
  if (!geom) { el.textContent = ''; return; }
  const m = printedLength(geom, CIRCLE_MM);
  const what = { spiral: `<b>${geom.rings}</b> rings · `, maze: `<b>${geom.rings}</b> corridors · `, contour: `<b>${geom.outlines}</b> strokes · ` }[geom.path] || '';
  el.innerHTML = `One line · ${what}<b>${m >= 10 ? m.toFixed(0) : m.toFixed(1)} m</b> long at ${(CIRCLE_MM / 10).toFixed(0)} cm`;
}

// ------------------------------------------------------------------------------------ inspector: photo
const photoSliders = {};
function buildPhotoSliders() {
  const host = $('photoSliders');
  const T = TONE_DEFAULTS;
  const mk = (key, o) => {
    const s = sliderRow({
      ...o, value: doc.tone[key],
      onInput: (v, dragging) => change(d => { d.tone[key] = v; }, { live: dragging }),
      onCommit: () => { commit(o.label); invalidate('geom'); refreshThumbs(); },
    });
    photoSliders[key] = s;
    host.append(s.el);
  };
  const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
  mk('darkness', { label: 'Darkness', min: -1, max: 1, step: 0.01, def: T.darkness, format: pct,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'How much ink the drawing uses overall' });
  mk('contrast', { label: 'Contrast', min: -1, max: 1, step: 0.01, def: T.contrast, format: pct,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100 });
  mk('detail', { label: 'Detail', min: 0, max: 1, step: 0.01, def: T.detail, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'Local contrast: brings out features like eyes' });
  mk('brightness', { label: 'Brightness', min: -1, max: 1, step: 0.01, def: T.brightness, format: pct,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100 });
}
const autoToggle = document.querySelector('[data-bind="auto"]');
const invertToggle = document.querySelector('[data-bind="invert"]');
autoToggle.addEventListener('change', () => change(d => { d.tone.auto = autoToggle.checked; }, { label: 'Auto tone', thumbs: true }));
invertToggle.addEventListener('change', () => change(d => { d.tone.invert = invertToggle.checked; }, { label: 'Invert tones', thumbs: true }));
// Realistic: back to the style's own tone defaults (the squiggle wants more local contrast)
$('photoReset').addEventListener('click', () => change(d => { d.tone = realistic() ? styleTone(d.real.style) : { ...TONE_DEFAULTS }; }, { label: 'Reset photo', thumbs: true }));

// ------------------------------------------------------------------------------------ realistic mode
// "A real pen on a real sheet": the Style picker (A-D with live thumbnails), the detail preset, real
// tools at their real width, the sheet size (auto = the smallest standard sheet on which this tool
// can draw a face in this style) and the light. Switching modes keeps the photo, the framing and
// the tone; each mode remembers its own tool, ink and paper.
const styleTone = id => ({ ...TONE_DEFAULTS, ...realStyleById(id).tone });
/** Carry the user's tone over, but move each untouched setting from one default to the next. */
function retone(d, from, to) {
  for (const k of Object.keys(to)) if (from[k] !== to[k] && d.tone[k] === from[k]) d.tone[k] = to[k];
}
const toolSizeLabel = (t, mm) => (t.label && mm === t.sizes[0] ? t.label : `${mm} mm`);

function setMode(v) {
  if (v === doc.mode || !MODES.includes(v)) return;
  // Line art's reads and builds go on in the background: their "building" label stays in Line art
  if (doc.mode === 'lineart') setBuilding(false);
  change(d => {
    d.stash = { ...d.stash, [d.mode]: { brush: d.brush, ink: d.ink, inkSource: d.inkSource, paper: d.paper } };
    // Realistic tunes the tone per style; the other modes start from the plain defaults
    if (d.mode === 'realistic') retone(d, styleTone(d.real.style), TONE_DEFAULTS);
    const back = d.stash[v];
    if (v === 'lineart') {
      // a line artist's own tool and paper (the style's, the first time); one ink, no photo colour
      const t = lineToolFor(d.lineart.tool);
      d.mode = 'lineart';
      d.brush = t.brush;
      if (back) Object.assign(d, { ink: back.ink, inkSource: back.inkSource, paper: back.paper });
      else Object.assign(d, { ink: lineStyle(d.lineart.style)?.ink || t.ink, inkSource: 'swatch', paper: d.lineart.paper });
      if (d.inkSource === 'photo') { d.inkSource = 'swatch'; d.ink = t.ink; }
      d.lineart.paper = d.paper;
    } else if (v === 'realistic') {
      // the first time, the current tool carries over when it is a real drawing tool
      const cand = back?.brush ?? d.brush;
      const real = REAL_TOOLS.some(t => t.brush === cand);
      const t = realToolFor(real ? cand : d.real.tool);
      d.mode = 'realistic';
      d.real.tool = d.brush = t.brush;
      if (!t.sizes.includes(d.real.toolMm)) d.real.toolMm = t.sizes[0];
      if (back) Object.assign(d, { ink: back.ink, inkSource: back.inkSource, paper: back.paper });
      else if (!real) Object.assign(d, { ink: t.ink, inkSource: 'swatch', paper: t.paper });
      // the real builders draw in one ink: colour from the photo is an Artistic effect
      if (d.inkSource === 'photo') { d.inkSource = 'swatch'; d.ink = t.ink; }
      retone(d, TONE_DEFAULTS, styleTone(d.real.style));
      syncAutoSheet(d);
    } else {
      d.mode = 'artistic';
      if (back) Object.assign(d, back);
    }
  }, { label: `${MODE_NAME[v]} mode`, thumbs: true });
  loupe.fit({ instant: true });
  if (v !== 'artistic' && tabs.find(t => t.getAttribute('aria-selected') === 'true')?.dataset.tab === 'line') selectTab('looks');
  play.f = 1; setPlaying(false);
  if (v === 'lineart') lineState.revealNext = true;
  announce(v === 'realistic'
    ? `Realistic mode: ${realStyleById(doc.real.style).name}, ${doc.real.toolMm} millimetre ${realToolFor(doc.real.tool).name.toLowerCase()} on a ${formatMm(doc.real.sheetMm)} sheet`
    : v === 'lineart' ? `Line art mode: ${lineStyle(doc.lineart.style)?.name || 'one-line drawing'}, ${doc.lineart.toolMm} millimetre ${lineToolFor(doc.lineart.tool).name.toLowerCase()}`
    : 'Artistic mode');
}
const MODE_NAME = { artistic: 'Artistic', realistic: 'Realistic', lineart: 'Line art' };
const modeSeg = bindSeg(document.querySelector('[data-bind="mode"]'), doc.mode, v => setMode(v));
// the Artistic looks "One-line portrait" and "Wandering line" are spiral-born: point to Line art
$('tryLineArt')?.addEventListener('click', () => setMode('lineart'));

const stylesEl = $('realStyles');
function buildStyles() {
  stylesEl.replaceChildren(...REAL_STYLES.map((st, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'style-card';
    b.setAttribute('role', 'radio');
    b.dataset.id = st.id;
    b.title = `${st.letter} · ${st.name} (${i + 1})`;
    b.innerHTML = '<span class="thumb"><canvas></canvas><span class="skeleton"></span><span class="letter" aria-hidden="true"></span></span><span class="name"></span><span class="blurb"></span><span class="lineage"></span>';
    b.querySelector('.letter').textContent = st.letter;
    b.querySelector('.name').textContent = st.name;
    b.querySelector('.blurb').textContent = st.blurb;
    b.querySelector('.lineage').textContent = st.lineage || '';
    if (st.lineage) b.title += ` · ${st.lineage}`;
    b.setAttribute('aria-label', `${st.letter}: ${st.name}. ${st.blurb}${st.lineage ? ` ${st.lineage}` : ''}`);
    b.addEventListener('click', () => setRealStyle(st.id));
    return b;
  }));
  rovingGrid(stylesEl);
}
function setRealStyle(id) {
  const st = realStyleById(id);
  if (st.id === doc.real.style) return;
  sheetSnap = null;
  change(d => { retone(d, styleTone(d.real.style), styleTone(st.id)); d.real.style = st.id; syncAutoSheet(d); },
    { label: `Style: ${st.name}`, thumbs: true });
  announce(`${st.letter}, ${st.name}`);
}
const PRESET_NAME = { quick: 'Quick sketch', detailed: 'Detailed', masterpiece: 'Masterpiece' };
const presetSeg = bindSeg(document.querySelector('[data-bind="realPreset"]'), doc.real.preset, v =>
  change(d => { d.real.preset = v; syncAutoSheet(d); }, { label: `Detail: ${PRESET_NAME[v]}` }));

const realToolsEl = $('realTools');
function buildRealTools() {
  realToolsEl.replaceChildren(...REAL_TOOLS.map(t => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip';
    el.setAttribute('role', 'radio');
    el.dataset.id = t.brush;
    const sizes = t.sizes.length > 1 ? `${Math.min(...t.sizes)}–${Math.max(...t.sizes)} mm` : toolSizeLabel(t, t.sizes[0]);
    el.title = `${t.name}, ${sizes}`;
    el.innerHTML = '<span class="thumb"><canvas></canvas><span class="skeleton"></span></span><span class="name"></span><span class="size"></span>';
    el.querySelector('.name').textContent = t.chip || t.name;
    el.querySelector('.size').textContent = sizes;
    el.addEventListener('click', () => setRealTool(t.brush));
    return el;
  }));
  rovingGrid(realToolsEl);
}
function setRealTool(id, mm) {
  const t = realToolFor(id);
  const size = mm ?? (t.brush === doc.real.tool ? doc.real.toolMm : t.sizes[0]);
  if (t.brush === doc.real.tool && size === doc.real.toolMm) return;
  const b = brushById(t.brush);
  const newTool = t.brush !== doc.real.tool;
  sheetSnap = null;
  change(d => {
    // a new instrument starts on its own real paper in its own ink (chalk on a board, charcoal on
    // cold-press), unless a paper was picked by hand; a new nib size of the same pen keeps both
    if (newTool && !d.real.paperChosen) Object.assign(d, { paper: t.paper, ink: t.ink, inkSource: 'swatch' });
    else if (newTool) d.ink = inkFor(b);
    d.real.tool = d.brush = t.brush; d.real.toolMm = size; syncAutoSheet(d);
  }, { label: `Tool: ${t.name} ${size} mm`, thumbs: true });
  announce(`${t.name}, ${size} millimetres${doc.real.sheetAuto || sheetSnap ? `, ${formatSheet(doc.real.sheetMm)} sheet` : ''}`);
}
function buildRealSizes() {
  const t = realToolFor(doc.real.tool);
  const host = $('realSizes');
  $('realSizeRow').hidden = t.sizes.length < 2;
  if (host.dataset.tool === t.brush) return;
  host.dataset.tool = t.brush;
  host.replaceChildren(...[...t.sizes].sort((a, b) => a - b).map(mm => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.v = String(mm);
    b.textContent = `${mm} mm`;
    return b;
  }));
  host.segCtl = bindSeg(host, String(doc.real.toolMm), v => setRealTool(t.brush, +v));
}

const sheetSel = $('realSheet');
// The drawing is square: an 'A4' sheet is the 21 x 21 cm square on A4 paper, and says so
const sheetName = mm => { const s = SHEETS.find(x => x.mm === mm); return s && /^A\d$/.test(s.name) ? `${formatSheet(mm)} (on ${s.name})` : formatSheet(mm); };
// How much of one drawing's line this photo needs at full detail on each sheet, from the last build
// in this style, tool and preset (real.load, the builder's own estimate at its sheet): the line
// grows with the sheet's area in tool widths, so a sheet over 1 will have its detail lowered.
function photoLoad(mm) {
  const g = geom?.real, r = doc.real;
  if (!g || !(g.load > 0) || g.style !== r.style || g.toolMm !== r.toolMm || g.preset !== r.preset) return null;
  return g.load * (mm / g.sheetMm) ** 2;
}
let sheetOptKey = '';
function buildSheetOptions() {
  const r = doc.real;
  const auto = autoSheet(r.style, r.toolMm);
  const labels = SHEETS.map(s => {
    const fit = sheetFit(r.style, r.toolMm, s.mm), load = photoLoad(s.mm);
    return `${sheetName(s.mm)}${fit.tooSmall ? ' · too small for this tool' : fit.tooBig ? ' · tool too fine for this size' : load > 1 ? ' · less detail with this photo' : ''}`;
  });
  const key = JSON.stringify([auto, r.style, r.toolMm, r.sheetMm, r.sheetAuto, labels]);
  if (key === sheetOptKey) return;          // rebuilt only when a label changes (an open list stays open)
  sheetOptKey = key;
  const opts = [new Option(`Auto · ${sheetName(auto)}`, 'auto')];
  SHEETS.forEach((s, i) => {
    const fit = sheetFit(r.style, r.toolMm, s.mm);
    const o = new Option(labels[i], String(s.mm));
    o.disabled = fit.tooBig && s.mm !== r.sheetMm;
    opts.push(o);
  });
  sheetSel.replaceChildren(...opts);
  sheetSel.value = r.sheetAuto ? 'auto' : String(r.sheetMm);
}
sheetSel.addEventListener('change', () => {
  const v = sheetSel.value;
  sheetSnap = null;
  change(d => {
    if (v === 'auto') { d.real.sheetAuto = true; d.real.sheetPick = null; syncAutoSheet(d); }
    else { d.real.sheetAuto = false; d.real.sheetMm = d.real.sheetPick = +v; }
  }, { label: 'Sheet size' });
  announce(`${sheetName(doc.real.sheetMm)} sheet`);
});
const LIGHT_NAME = { window: 'Window', raking: 'Raking', overhead: 'Overhead' };
const lightSeg = bindSeg(document.querySelector('[data-bind="realLight"]'), doc.real.light, v =>
  change(d => { d.real.light = v; }, { label: `Light: ${LIGHT_NAME[v]}`, level: 'render' }));

/** What a realistic build gave up to stay one whole drawing (geom.real.reduced), in plain words. */
function reducedNote(g) {
  const r = g.reduced;
  const what = { rings: `${r.to} rings instead of ${r.from}`, stipples: `${r.to.toLocaleString('en')} dots instead of ${r.from.toLocaleString('en')}`,
    bands: `${r.to} bands instead of ${r.from}`, 'loop size': `loops ${Math.round((r.to / r.from - 1) * 100)} % bigger` }[r.unit] || 'less detail';
  // a finer preset that cannot be honoured is drawn as the coarser one it would otherwise lose to;
  // spread dots are capped, so every preset that spreads them gives the same drawing
  const how = r.asPreset ? `, drawn as ${r.asPreset}` : r.unit === 'stipples' ? '; a finer preset adds nothing at this size' : '';
  return `Too much line for one drawing at this size with this photo: detail lowered to fit (${what}${how}; the time is for this drawing)`;
}

/** The sheet card also says it when the finished drawing had to lower its detail. */
function updateReducedWarn() {
  const warn = $('sheetWarn'), g = geom?.real, r = doc.real;
  if (!warn || !realistic()) return;
  const own = warn.dataset.reduced === '1';
  const current = g && g.style === r.style && g.toolMm === r.toolMm && g.sheetMm === r.sheetMm && g.preset === r.preset;
  if (current && g.reduced && (warn.hidden || own)) {
    warn.replaceChildren();
    const span = document.createElement('span');
    span.textContent = `${reducedNote(g)}. The whole photo is still drawn; a smaller sheet or a broader tool keeps every detail.`;
    warn.append(span);
    warn.dataset.reduced = '1';
    warn.hidden = false;
  } else if (own && !(current && g.reduced)) {
    warn.hidden = true;
    delete warn.dataset.reduced;
  }
}

/** The honest numbers: metres of line, time by hand, the tool and the sheet. */
function updateRealInfo() {
  if (!realistic()) { if (!lineart()) updateScaleCaption(null); return; }
  const r = doc.real, t = realToolFor(r.tool);
  const what = `${toolSizeLabel(t, r.toolMm)} ${t.name.toLowerCase()} on a ${formatSheet(r.sheetMm)} sheet`;
  const g = geom?.real;
  const current = g && g.style === r.style && g.toolMm === r.toolMm && g.sheetMm === r.sheetMm && g.preset === r.preset;
  const el = $('realInfo');
  if (current && !$('sheet').classList.contains('building')) {
    const m = g.lengthM;
    el.innerHTML = `<b>${m >= 10 ? m.toFixed(0) : m.toFixed(1)} m</b> of line · about <b>${formatHand(g.handSeconds)}</b> by hand · `;
    el.append(what);
    // the drawing is always whole; when it could not hold every detail at this size, say so
    if (g.reduced) el.append(` · ${reducedNote(g)}`);
    // a scribble only shades what is dark: on a near-white photo there is nothing to circle
    else if (g.style === 'scribble' && g.points < 100) el.append(' · Nothing dark enough to scribble: try Squiggle, or raise the contrast');
  } else if (realState.failed && realState.failed === realState.want) {
    el.textContent = `Could not draw this · ${what}`;
  } else {
    el.textContent = `Drawing the line… · ${what}`;
  }
  updateScaleCaption(current ? g : null);
  updateReducedWarn();
  if (current) buildSheetOptions();
}

/**
 * The stage's scale: a bar of a round real length and the sheet, tool and hand time, so a 1.5 m
 * sheet never passes for A4 (the stage always shows the whole sheet the same size).
 */
function updateScaleCaption(g) {
  const cap = $('realScale');
  if (!cap) return;
  cap.hidden = !(realistic() || lineart()) || !photo;
  if (cap.hidden) return;
  const la = lineart();
  const r = la ? { sheetMm: LINE_SHEET_MM, toolMm: doc.lineart.toolMm } : doc.real, t = la ? lineToolFor(doc.lineart.tool) : realToolFor(r.tool);
  // the longest round length up to a quarter of the sheet width
  const cm = [1, 2, 5, 10, 20, 50].filter(c => c * 10 <= r.sheetMm * 0.25).pop() || 1;
  cap.style.setProperty('--bar', `${(cm * 10 / r.sheetMm) * 100}`);
  $('realScaleLen').textContent = cm >= 100 ? `${cm / 100} m` : `${cm} cm`;
  $('realScaleTxt').textContent = `${formatSheet(r.sheetMm)} · ${la ? `${r.toolMm} mm` : toolSizeLabel(t, r.toolMm)} ${t.name.toLowerCase()}${g ? ` · ~${formatHand(g.handSeconds)} by hand` : ''}`;
}

function syncReal() {
  const r = doc.real, st = realStyleById(r.style), t = realToolFor(r.tool);
  setChecked([...stylesEl.children], el => el.dataset.id === r.style);
  $('styleValue').textContent = `${st.letter} · ${st.name}`;
  presetSeg.set(r.preset);
  setChecked([...realToolsEl.children], el => el.dataset.id === r.tool);
  $('toolValue').textContent = `${t.name} · ${toolSizeLabel(t, r.toolMm)}`;
  buildRealSizes();
  $('realSizes').segCtl?.set(String(r.toolMm));
  buildSheetOptions();
  const fit = sheetFit(r.style, r.toolMm, r.sheetMm);
  const auto = autoSheet(r.style, r.toolMm);
  $('sheetHelp').textContent = r.sheetAuto
    ? `The smallest sheet on which a ${r.toolMm} mm ${t.name.toLowerCase()} can draw a face in this style.${r.sheetMm > 420 ? ' The line keeps its real width, so a broad tool needs a big sheet.' : ''}`
    : 'The line always keeps its real width: a bigger sheet means more line and more detail.';
  const warn = $('sheetWarn');
  delete warn.dataset.reduced;
  const snapped = sheetSnap && sheetSnap.to === r.sheetMm && !r.sheetAuto && sheetSnap.tool === r.tool && sheetSnap.toolMm === r.toolMm;
  warn.hidden = !fit.tooSmall && !snapped;
  if (snapped && !fit.tooSmall) {
    warn.replaceChildren();
    const span = document.createElement('span');
    span.textContent = `${formatSheet(sheetSnap.from)} is too big for a ${r.toolMm} mm ${t.name.toLowerCase()}: it would need more line than one drawing can hold, so the sheet moved to ${formatSheet(r.sheetMm)}.`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'text-btn'; btn.textContent = `Use Auto · ${sheetName(auto)}`;
    btn.addEventListener('click', () => { sheetSel.value = 'auto'; sheetSel.dispatchEvent(new Event('change')); });
    warn.append(span, btn);
  }
  if (fit.tooSmall) {
    warn.replaceChildren();
    const span = document.createElement('span');
    span.textContent = `A ${r.toolMm} mm ${t.name.toLowerCase()} is too broad to draw a face on ${formatSheet(r.sheetMm)} in this style: the drawing will read as shapes only.`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'text-btn'; btn.textContent = `Use ${sheetName(auto)}`;
    btn.addEventListener('click', () => { sheetSel.value = 'auto'; sheetSel.dispatchEvent(new Event('change')); });
    warn.append(span, btn);
  }
  lightSeg.set(r.light);
  updateRealInfo();
}

// Style cards: the user's photo drawn in each style (built in the worker, rendered by the shared
// thumbnail renderer). Each uses a tool just fine enough for a face on the card's small sheet.
const styleThumbGeoms = new Map();
function refreshStyleThumbs() {
  if (!photo || !realistic()) return;
  const dpr = DPR(), b = brush(), p = paper(), m = mode(), fl = flip();
  for (const el of stylesEl.children) {
    const st = realStyleById(el.dataset.id);
    const canvas = el.querySelector('canvas');
    const size = Math.round((canvas.clientWidth || 120) * dpr);
    // a line of about a card pixel or more (0.84 mm on a 250 px card of a 21 cm sheet) and still
    // fine enough for a face in this style
    const opts = { sheetMm: 210, toolMm: +(210 / Math.max(st.minSheetRatio * 1.15, 250)).toFixed(3), preset: 'detailed', tool: b.id, seed: 1 };
    const gk = keyOf('stylethumb', st.id, photo.id, doc.crop, doc.tone, fl, opts);
    const key = keyOf(gk, b.id, doc.ink, p.id, size, m.cover);
    if (canvas.dataset.key === key) continue;
    const show = g => thumbs.add({
      canvas, key, width: size, height: size, needs: { brush: b, paper: p },
      render: r => {
        r.setLayout(LAYOUT); r.setPaper(p, 1);
        r.setStyle({ brush: b, ink: doc.ink, cover: m.cover, photoColor: false });
        r.setGeometry(g); return r.render(Infinity);
      },
    }, st.id === doc.real.style);
    const have = styleThumbGeoms.get(gk);
    if (have) { show(have); continue; }
    // after the stage's own build has been queued (next frame), so the drawing never waits for a card
    setTimeout(() => {
      if (!photo || !realistic()) return;
      realBuilder.build(st.id, thumbField(fl, realFieldRings(st.id, opts)), opts, { tag: `thumb:${st.id}` }).then(g => {
        if (!g) return;
        styleThumbGeoms.set(gk, g);
        if (styleThumbGeoms.size > 12) styleThumbGeoms.delete(styleThumbGeoms.keys().next().value);
        if (realistic()) show(g);
      });
    }, 60);
  }
}

// ------------------------------------------------------------------------------------ line art mode
// One-line drawings the way continuous-line artists make them (js/lineart/index.js): a line model
// reads the photo's contours once per photo + framing + detail (cached), then a style A-D plans ONE
// line through them with a hand's pace and pressure (in a worker). The first use downloads the
// line model and the silhouette models (~54 MB, once; the service worker keeps them for offline
// use), with a card on the sheet. Silhouette first: the subject's outer shape is the main line, and
// "Tap the subject" (doc.subject) picks another thing to outline.
let LA = null;                      // the js/lineart/index.js module, once loaded
const lineState = {
  engine: null, linesKey: '', linesWant: '', lines: null, inflight: false, lastFrame: '',
  key: '', want: '', geom: null, failed: '', error: null, revealNext: false, prepared: false,
};
// "Tap the subject": a pick mode like the maze start point; the tap is kept as doc.subject
const subjectPick = { active: false, hover: null, flash: 0, at: null };
const lineStyle = id => (LA ? LA.lineStyleById?.(id) || LA.LINE_STYLES.find(s => s.id === id) : null);
const lineModP = import('./lineart/index.js').then(m => {
  if (!m.LineArtEngine || !Array.isArray(m.LINE_STYLES)) throw new Error('lineart: engine missing');
  LA = m;
  buildLineStyles();
  syncControls();
  if (lineart()) { invalidate('geom'); refreshThumbs(); }
  return m;
}).catch(e => {
  console.warn('Line art is unavailable:', e);
  lineState.error = 'Line art could not load in this browser.';
  if (lineart()) updateLineInfo();
  return null;
});
function lineOpts(d = doc) {
  const la = d.lineart;
  return { sheetMm: LINE_SHEET_MM, tool: la.tool, toolMm: la.toolMm, wobble: la.wobble, hatch: la.hatch, seed: d.line.seed || 1 };
}
const lineFrameKey = () => keyOf(photo.id, doc.crop);
const lineLinesKey = () => keyOf(lineFrameKey(), doc.lineart.detail.toFixed(2), subjectFrameTap() || 'auto');
/** Something is still on its way for the current Line art drawing (tests wait on SP.building). */
function lineBusy() {
  if (!LA || lineState.error) return !LA && !lineState.error;
  if (lineState.inflight || lineState.linesKey !== lineLinesKey()) return !lineState.failedLines;
  const key = keyOf(lineState.linesKey, doc.lineart.style, lineOpts());
  return lineState.key !== key && lineState.failed !== key;
}

function computeLineGeometry() {
  const keep = geom?.lineart ? geom : null;
  if (!LA) return keep;
  // framing drags would ask the model for every frame: read the photo once the framing is done
  if (framing.active) return keep;
  const lk = lineLinesKey();
  if (lineState.linesKey !== lk) {
    if (!lineState.inflight && lineState.failedLines !== lk) requestLines(lk);
    return keep;
  }
  const style = doc.lineart.style, opts = lineOpts();
  const key = keyOf(lk, style, opts);
  if (lineState.key === key && lineState.geom) return lineState.geom;
  if (lineState.want !== key) {
    lineState.want = key;
    setBuilding(true);
    Promise.resolve(lineState.engine.build(style, lineState.lines, opts, { tag: 'stage' })).then(g => {
      if (lineState.want !== key) return;            // a newer build is on its way
      setBuilding(false);
      if (!g) return;
      lineState.key = key; lineState.geom = g; lineState.failed = '';
      invalidate('geom');
      if (lineState.revealNext && lineart()) {
        lineState.revealNext = false;
        if (!reducedMotion()) requestAnimationFrame(() => { play.f = 0; setPlaying(true, { demo: true }); });
      }
    }, e => {
      console.warn('line art build failed', e);
      if (lineState.want !== key) return;
      setBuilding(false);
      lineState.failed = key;
      toast('This drawing could not be made. Try another style or more detail.', { error: true });
      updateLineInfo();
    });
  }
  return keep;
}

async function lineEngine() {
  if (!LA) await lineModP;
  if (!LA) return null;
  return (lineState.engine ||= new LA.LineArtEngine());
}

/** Read the photo's lines for this framing and detail (first use: download the model first). */
async function requestLines(lk) {
  lineState.inflight = true;
  lineState.linesWant = lk;
  const src = photo, crop = { ...doc.crop }, detail = doc.lineart.detail, frame = lineFrameKey();
  updateLineInfo();
  try {
    const eng = await lineEngine();
    if (!eng) throw new Error('no engine');
    if (!lineState.prepared) {
      try { await eng.prepare(p => gateProgress(p, 'prepare')); }
      catch (e) { console.warn('line model: prepare failed', e); }   // lines() falls back to the edge finder
      lineState.prepared = true;
    }
    // a new photo or framing runs the model (seconds): say so on the sheet; a new detail only
    // re-traces the cached line map (a moment): the small "building" label is enough
    const fresh = lineState.lastFrame !== frame;
    // silhouette first (js/lineart/silhouette.js): the subject's outer shape is the main line; a
    // tapped subject re-runs only the silhouette (under a second), never the line model
    const tap = subjectFrameTap(src, crop);
    const onlyTap = !fresh && lineState.lastDetail === detail;
    if (fresh) gateProgress({ stage: 'read', loaded: 0, total: 1 }, 'read');
    else setBuilding(true, onlyTap ? 'Finding the subject…' : 'Finding the lines…');
    const r = await eng.lines(src.canvas, crop, { detail, silhouette: tap ? { tap } : true }, p => { if (fresh) gateProgress(p, 'read'); });
    lineState.lastDetail = detail;
    lineState.lines = r;
    lineState.linesKey = lk;
    lineState.lastFrame = frame;
    lineState.failedLines = '';
  } catch (e) {
    console.warn('line art: reading the photo failed', e);
    lineState.failedLines = lk;
    toast('Line art could not read this photo. Try another photo or framing.', { error: true });
  } finally {
    lineState.inflight = false;
    hideGate();
    setBuilding(false);
    updateLineInfo();
    invalidate('geom');
    refreshLineThumbs();
  }
}

// ---- the subject (silhouette first): what was found, and "Tap the subject" to choose it
/** doc.subject (photo fractions) in frame fractions of this photo + crop; null when automatic or
 *  when the framing no longer holds the tapped point. */
function subjectFrameTap(src = photo, crop = doc.crop) {
  const s = doc.subject;
  if (!s || !src || !crop) return null;
  const cv = src.canvas || src, w = cv.width, h = cv.height, D = cropDiameter(w, h, crop);
  const a = (crop.rotation || 0) * Math.PI / 180, c = Math.cos(a), si = Math.sin(a);
  const dx = (s[0] - crop.x) * w, dy = (s[1] - crop.y) * h;
  const fx = 0.5 + (c * dx - si * dy) / D, fy = 0.5 + (si * dx + c * dy) / D;
  return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? [+fx.toFixed(4), +fy.toFixed(4)] : null;
}
/** A point of the art frame (fractions) -> photo fractions (the inverse of frameCanvas). */
function frameToPhoto(fx, fy, src = photo, crop = doc.crop) {
  const cv = src.canvas || src, w = cv.width, h = cv.height, D = cropDiameter(w, h, crop);
  const a = -(crop.rotation || 0) * Math.PI / 180, c = Math.cos(a), si = Math.sin(a);
  const vx = (fx - 0.5) * D, vy = (fy - 0.5) * D;
  return [clamp(crop.x + (c * vx - si * vy) / w, 0, 1), clamp(crop.y + (si * vx + c * vy) / h, 0, 1)];
}
function setSubjectPick(on) {
  if (on && (!photo || framing.active || !lineart())) return;
  if (on && picking.active) setPicking(false);
  if (on) loupe.fit({ instant: true });
  subjectPick.active = on;
  subjectPick.hover = null;
  $('sheet').classList.toggle('picking', on);
  $('subjectHint').hidden = !on;
  const b = $('btnPickSubject');
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('span').textContent = on ? 'Cancel' : 'Tap the subject';
  if (on) { finishDemo(); setPlaying(false); play.f = 1; announce('Tap the subject on the sheet. Escape cancels.'); }
  drawOverlay.wasFull = true;
  invalidate('render');
}
$('btnPickSubject').addEventListener('click', () => setSubjectPick(!subjectPick.active));
$('btnSubjectAuto').addEventListener('click', () => {
  if (subjectPick.active) setSubjectPick(false);
  if (!doc.subject) return;
  change(d => { d.subject = null; }, { label: 'Subject: automatic', thumbs: true });
  saveSession();
  announce('The subject is found automatically again');
});
$('sheet').addEventListener('pointermove', e => { if (subjectPick.active) { subjectPick.hover = sheetPointToCircle(e); invalidate('render'); } });
$('sheet').addEventListener('pointerleave', () => { if (subjectPick.active) { subjectPick.hover = null; invalidate('render'); } });
$('sheet').addEventListener('pointerdown', e => {
  if (!subjectPick.active) return;
  e.preventDefault();
  e.stopPropagation();
  const [x, y] = sheetPointToCircle(e);
  setSubjectPick(false);
  if (!photo || !lineart()) return;
  subjectPick.flash = performance.now() + 1800;
  subjectPick.at = [x, y];
  const p = frameToPhoto((x + 1) / 2, (y + 1) / 2);
  change(d => { d.subject = [+p[0].toFixed(4), +p[1].toFixed(4)]; }, { label: 'Subject', thumbs: true });
  saveSession();
  announce('Finding the subject you tapped');
  if (!reducedMotion()) lineState.revealNext = true;
}, true);

/** The row under the Line art numbers: what the silhouette found, and the tap control. */
function updateSubject() {
  const row = $('subjectRow');
  if (!row) return;
  row.hidden = !lineart() || !photo || !!lineState.error;
  if (row.hidden) return;
  const what = $('subjectWhat'), sub = $('subjectSub'), auto = $('btnSubjectAuto');
  const tapped = !!doc.subject, inFrame = !!subjectFrameTap();
  const lines = lineState.lines, have = lines && lineState.linesKey === lineLinesKey();
  auto.hidden = !tapped;
  $('btnPickSubject').disabled = !lines;
  row.classList.remove('weak');
  if (!have) {
    what.textContent = tapped && inFrame ? 'Subject: finding what you tapped…' : 'Subject: finding it…';
    sub.textContent = 'The outer shape of the subject is the main line; the features go inside it.';
    return;
  }
  const sil = lines.features?.silhouette || null;
  const d = LA?.describeSilhouette ? LA.describeSilhouette(sil) : { label: 'Subject', weak: false, scene: false };
  what.textContent = d.label;
  if (!sil) {
    row.classList.add('weak');
    sub.textContent = 'The shape finder could not run here, so the line follows the contours only.';
  } else if (tapped && !inFrame) sub.textContent = 'The point you tapped is outside this framing, so the subject is found automatically.';
  // (a tap cannot move a close-up's outline: the face fills the frame, so its edge is the outline)
  else if (tapped && lines.tapOutcome === 'closeup') sub.textContent = 'The face fills the frame, so the outline stays at the frame edge: a tap cannot change it. Frame the photo wider to give it a shape.';
  else if (tapped && lines.tapOutcome === 'same') sub.textContent = 'Your tap chose the same shape the finder had found.';
  else if (tapped) sub.textContent = 'Chosen by your tap: the outline follows the thing under it.';
  else if (d.weak) { row.classList.add('weak'); sub.textContent = 'Not sure what the subject is. Tap it on the sheet and the outline will follow it.'; }
  else if (d.scene) sub.textContent = 'Drawn as a skyline and a few landmarks. To draw one thing instead, tap it on the sheet.';
  else sub.textContent = 'Found automatically. Wrong shape? Tap the subject on the sheet.';
}

/** Pick mode on the sheet: the photo shows faintly with the shape found so far; after a tap, a pin. */
function drawSubjectOverlay(now, S, o, cx, cy, R) {
  const u = S / 100;
  if (subjectPick.active && photo) {
    octx.save();
    clipArt(octx, cx, cy, R); octx.clip();
    octx.globalAlpha = 0.35;
    drawPhotoInCircle(octx, cx, cy, R);
    octx.restore();
    const sil = lineState.lines?.features?.silhouette;
    if (sil) {
      octx.save();
      octx.setLineDash([1.2 * u, 0.9 * u]);
      octx.lineWidth = 0.4 * u;
      octx.strokeStyle = 'rgba(196,61,22,.95)';
      const path = (p, closed) => {
        octx.beginPath();
        for (let k = 0; k < p.length; k += 2) {
          const [px, py] = sheetToOverlay(p[k] * 2 - 1, p[k + 1] * 2 - 1);
          k ? octx.lineTo(px, py) : octx.moveTo(px, py);
        }
        if (closed) octx.closePath();
        octx.stroke();
      };
      for (const p of sil.outlines || []) path(p, true);
      if (sil.skyline && sil.skyline.length >= 8) path(sil.skyline, false);
      octx.restore();
    }
  }
  const px = subjectPick.active ? subjectPick.hover : subjectPick.at;
  if (px) {
    const [mx, my] = sheetToOverlay(px[0], px[1]);
    octx.save();
    octx.globalAlpha = subjectPick.active ? 1 : Math.min(1, (subjectPick.flash - now) / 600);
    octx.lineWidth = 0.45 * u;
    octx.strokeStyle = '#c43d16';
    octx.fillStyle = 'rgba(196,61,22,.18)';
    octx.beginPath(); octx.arc(mx, my, 2.6 * u, 0, Math.PI * 2); octx.fill(); octx.stroke();
    octx.fillStyle = '#c43d16';
    octx.beginPath(); octx.arc(mx, my, 0.6 * u, 0, Math.PI * 2); octx.fill();
    octx.restore();
  }
  lastToolBox = null;
  drawOverlay.wasFull = true;   // clear the whole overlay next frame
  if (!subjectPick.active) invalidate('render');
}

// The card on the sheet: the one-time download (real bytes), then reading the photo (the model
// gives no steps, so the bar follows the time a read usually takes and says the seconds). The card
// belongs to Line art only: in the other modes the download and the read go on unseen, and the card
// comes back at its current progress when the user returns to Line art.
const gate = { el: null, t0: 0, timer: 0, showAt: 0, stage: '', on: false };
function gateReveal() {
  gate.on = true;
  const el = $('lineGate');
  if (el) el.hidden = !lineart();
}
function syncGate() {
  const el = $('lineGate');
  if (el) el.hidden = !(gate.on && lineart());
  if (subjectPick.active && !lineart()) setSubjectPick(false);   // (the mode changed while choosing)
}
function gateProgress(p0, phase) {
  const el = $('lineGate');
  if (!el) return;
  // while reading the photo every stage the engine reports is part of that one read
  const p = phase === 'read' && p0.stage !== 'ready' ? { ...p0, stage: 'read' } : p0;
  if (p.stage === 'ready') { if (phase === 'read') hideGate(); return; }
  const now = performance.now();
  if (gate.stage === p.stage && p.stage === 'read') return;     // its own timer runs the bar
  if (gate.stage !== p.stage) { gate.stage = p.stage; gate.t0 = now; }
  const title = $('lineGateTitle'), sub = $('lineGateSub'), bar = $('lineGateBar');
  let frac = 0, indeterminate = false;
  if (p.stage === 'download') {
    frac = p.total ? p.loaded / p.total : 0;
    const MB = b => Math.round(b / 1e6);
    title.textContent = 'Getting the line model ready';
    sub.textContent = frac >= 0.999 ? `${MB(p.total)} MB, once, then it works offline`
      : `${MB(p.loaded)} of ${MB(p.total)} MB · once, then it works offline`;
    // a cached model streams in within a moment: no card for that
    if (!gate.showAt) gate.showAt = now + 350;
  } else if (p.stage === 'model' || p.stage === 'face') {
    title.textContent = 'Getting the line model ready';
    sub.textContent = p.stage === 'model' ? 'Starting the line model…' : 'Starting the face finder…';
    indeterminate = true;
    if (!gate.showAt) gate.showAt = now + 350;
  } else {
    title.textContent = 'Reading the photo…';
    el.classList.remove('indeterminate');
    if (!gate.showAt) gate.showAt = now + 250;
    clearInterval(gate.timer);
    const t0 = gate.t0;
    const tickRead = () => {
      const s = (performance.now() - t0) / 1000;
      // ~10 s is a typical read without WebGPU: approach the end, never claim it
      const f = 1 - Math.exp(-s / 7);
      bar.style.setProperty('--p', (f * 95).toFixed(1));
      bar.setAttribute('aria-valuenow', Math.round(f * 95));
      sub.textContent = s < 1.5 ? 'Finding the contours a line artist would draw' : `Finding the contours · ${Math.round(s)} s (a read takes about 10–30 s)`;
      if (gate.on || performance.now() >= gate.showAt) gateReveal();
    };
    tickRead();
    gate.timer = setInterval(tickRead, 250);
    return;
  }
  el.classList.toggle('indeterminate', indeterminate);
  bar.style.setProperty('--p', (frac * 100).toFixed(1));
  bar.setAttribute('aria-valuenow', Math.round(frac * 100));
  if (now >= gate.showAt || gate.on) gateReveal();
  else setTimeout(() => { if (gate.stage === p.stage && gate.showAt) gateReveal(); }, gate.showAt - now);
}
function hideGate() {
  clearInterval(gate.timer);
  gate.showAt = 0; gate.stage = ''; gate.on = false;
  const el = $('lineGate');
  if (el) { el.hidden = true; el.classList.remove('indeterminate'); }
}

const lineStylesEl = $('lineStyles');
function buildLineStyles() {
  if (!LA) return;
  lineStylesEl.replaceChildren(...LA.LINE_STYLES.map((st, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'style-card';
    b.setAttribute('role', 'radio');
    b.dataset.id = st.id;
    b.title = `${st.letter} · ${st.name} (${i + 1})`;
    b.innerHTML = '<span class="thumb"><canvas></canvas><span class="skeleton"></span><span class="letter" aria-hidden="true"></span></span><span class="name"></span><span class="blurb"></span>';
    b.querySelector('.letter').textContent = st.letter;
    b.querySelector('.name').textContent = st.name;
    b.querySelector('.blurb').textContent = st.blurb;
    b.setAttribute('aria-label', `${st.letter}: ${st.name}. ${st.blurb}`);
    b.addEventListener('click', () => setLineStyle(st.id));
    return b;
  }));
  rovingGrid(lineStylesEl);
}
/** A style brings its own tool, paper and ink, and its own detail, wobble and hatching. */
function setLineStyle(id) {
  const st = lineStyle(id);
  if (!st || st.id === doc.lineart.style) return;
  change(d => {
    const t = lineToolFor(st.tool);
    const dflt = st.defaults || {};
    d.lineart = { ...d.lineart, style: st.id, tool: t.brush, toolMm: st.toolMm || t.sizes[0], paper: st.paper || t.paper,
      detail: dflt.detail ?? d.lineart.detail, wobble: dflt.wobble ?? d.lineart.wobble, hatch: dflt.hatch ?? d.lineart.hatch };
    // the approved line-up's exact ink: a palette swatch when it is one, else shown as a custom ink
    const ink = st.ink || t.ink, inPalette = brushById(t.brush).inks.some(([h]) => h === ink);
    Object.assign(d, { brush: t.brush, paper: d.lineart.paper, ink, inkSource: inPalette ? 'swatch' : 'custom' });
  }, { label: `Style: ${st.name}`, thumbs: true });
  announce(`${st.letter}, ${st.name}`);
}

const lineToolsEl = $('lineTools');
function buildLineTools() {
  lineToolsEl.replaceChildren(...LINE_TOOLS.map(t => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip';
    el.setAttribute('role', 'radio');
    el.dataset.id = t.brush;
    const sizes = t.sizes.length > 1 ? `${Math.min(...t.sizes)}–${Math.max(...t.sizes)} mm` : `${t.sizes[0]} mm`;
    el.title = `${t.name}, ${sizes}${t.pressure ? ', follows pressure' : ', one even width'}`;
    el.innerHTML = '<span class="thumb"><canvas></canvas><span class="skeleton"></span></span><span class="name"></span><span class="size"></span>';
    el.querySelector('.name').textContent = t.chip || t.name;
    el.querySelector('.size').textContent = sizes;
    el.addEventListener('click', () => setLineTool(t.brush));
    return el;
  }));
  rovingGrid(lineToolsEl);
}
function setLineTool(id, mm) {
  const t = lineToolFor(id);
  const size = mm ?? (t.brush === doc.lineart.tool ? doc.lineart.toolMm : t.sizes[0]);
  if (t.brush === doc.lineart.tool && size === doc.lineart.toolMm) return;
  const b = brushById(t.brush);
  change(d => {
    // a new tool keeps an ink it has, else its own dark line-art ink (inkFor would pick its first,
    // a teal marker); a light ink on a dark sheet stays light
    if (t.brush !== d.lineart.tool) {
      const keep = b.inks.some(([h]) => h === d.ink) && !inkMode(b, d.ink, paperById(d.paper)).lowContrast;
      if (!keep) Object.assign(d, paperById(d.paper).dark ? { ink: inkFor(b), inkSource: 'swatch' } : { ink: t.ink, inkSource: 'swatch' });
    }
    d.lineart.tool = d.brush = t.brush; d.lineart.toolMm = size;
  }, { label: `Tool: ${t.name} ${size} mm`, thumbs: true });
  announce(`${t.name}, ${size} millimetres${t.pressure ? ', pressure-weighted' : ''}`);
}
function buildLineSizes() {
  const t = lineToolFor(doc.lineart.tool);
  const host = $('lineSizes');
  const sizes = [...new Set([...t.sizes, doc.lineart.toolMm])].sort((a, b) => a - b);
  $('lineSizeRow').hidden = sizes.length < 2;
  const key = `${t.brush}:${sizes.join(',')}`;
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren(...sizes.map(mm => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.v = String(mm);
    b.textContent = `${mm} mm`;
    return b;
  }));
  host.segCtl = bindSeg(host, String(doc.lineart.toolMm), v => setLineTool(t.brush, +v));
}

const lineArtSliders = {};
function buildLineSliders2() {
  const host = $('lineArtSliders');
  const mk = (key, o) => {
    const s = sliderRow({
      ...o, value: doc.lineart[key],
      format: v => `${Math.round(v * 100)}%`, toEdit: v => Math.round(v * 100), fromEdit: v => v / 100,
      onInput: (v, dragging) => change(d => { d.lineart[key] = v; }, { live: dragging }),
      onCommit: () => { commit(o.label); invalidate('geom'); refreshThumbs(); },
    });
    lineArtSliders[key] = s;
    host.append(s.el);
  };
  mk('detail', { label: 'Detail', min: 0, max: 1, step: 0.05, def: 0.45, hint: 'How many of the photo’s contours the line keeps' });
  mk('hatch', { label: 'Hatching', min: 0, max: 1, step: 0.05, def: 0, hint: 'Loose hatching in the darkest parts, drawn as part of the same line' });
  mk('wobble', { label: 'Wobble', min: 0, max: 1, step: 0.05, def: 0.3, hint: 'How much the hand drifts, overshoots and loops' });
}
const lineLightSeg = bindSeg(document.querySelector('[data-bind="lineLight"]'), doc.lineart.light, v =>
  change(d => { d.lineart.light = v; }, { label: `Light: ${LIGHT_NAME[v]}`, level: 'render' }));

/** The honest numbers: metres of line, time by hand, the tool; and which engine drew the lines. */
function updateLineInfo() {
  if (!lineart()) return;
  const el = $('lineInfo'), note = $('lineNote');
  const la = doc.lineart, t = lineToolFor(la.tool);
  const what = `${la.toolMm} mm ${t.name.toLowerCase()}`;
  const g = geom?.lineart;
  const current = g && lineState.key === keyOf(lineLinesKey(), la.style, lineOpts()) && geom === lineState.geom;
  if (lineState.error) el.textContent = lineState.error;
  else if (!photo) el.textContent = `Choose a photo · ${what}`;
  else if (current && !$('sheet').classList.contains('building')) {
    const m = +g.lengthM;
    el.innerHTML = `<b>${m.toFixed(1)} m</b> of line · about <b>${formatHand(g.handSeconds)}</b> by hand · `;
    el.append(what);
  } else if (lineState.failedLines && lineState.failedLines === lineLinesKey()) el.textContent = `Could not read this photo · ${what}`;
  else if (lineState.inflight && lineState.lastFrame !== lineFrameKey()) el.textContent = `Reading the photo… · ${what}`;
  else el.textContent = `Drawing the line… · ${what}`;
  // an honest note when the line model could not run here and the edge finder drew the lines
  const lines = lineState.lines, fallback = lines && lines.engine === 'xdog';
  // a photo with nothing to draw (feature-detected: the planner flags geom.lineart.empty)
  const empty = !!(current && g.empty);
  note.hidden = !fallback && !empty;
  if (empty) note.textContent = 'No clear contours in this photo, so there is little for a line artist to draw. Try a photo with a clear subject: a face, an animal or an object.';
  else if (fallback) note.textContent = 'The line model could not load here, so a simpler edge finder read the photo: the lines are rougher and follow shadows more. It is still one line.';
  updateScaleCaption(current ? g : null);
  updateSubject();
}

function syncLine() {
  const la = doc.lineart, st = lineStyle(la.style), t = lineToolFor(la.tool);
  setChecked([...lineStylesEl.children], el => el.dataset.id === la.style);
  $('lineStyleValue').textContent = st ? `${st.letter} · ${st.name}` : '';
  for (const [k, s] of Object.entries(lineArtSliders)) s.set(la[k]);
  setChecked([...lineToolsEl.children], el => el.dataset.id === la.tool);
  $('toolValue').textContent = `${t.name} · ${la.toolMm} mm`;
  buildLineSizes();
  $('lineSizes').segCtl?.set(String(la.toolMm));
  $('lineToolHelp').textContent = t.pressure
    ? `${t.name}: the width follows the hand, fuller where it slows or presses into the darks.`
    : `${t.name}: one even width, like the real pen.`;
  lineLightSeg.set(la.light);
  updateLineInfo();
}

// Style cards: the user's photo in each style, planned from the SAME cached lines (a build of a
// few hundred ms in the worker, no model run), each in its own tool, paper and ink.
const lineThumbGeoms = new Map();
function refreshLineThumbs() {
  if (!photo || !lineart() || !LA || !lineState.lines || lineState.linesKey !== lineLinesKey()) return;
  const dpr = DPR();
  for (const el of lineStylesEl.children) {
    const st = lineStyle(el.dataset.id);
    const canvas = el.querySelector('canvas');
    const size = Math.round((canvas.clientWidth || 120) * dpr);
    const t = lineToolFor(st.tool), b = brushById(t.brush), p = paperById(st.paper || t.paper), ink = st.ink || t.ink;
    const m = inkMode(b, ink, p);
    // at least ~1.1 card pixels wide, so a 0.55 mm nib still reads on a 250 px card
    const opts = { sheetMm: LINE_SHEET_MM, tool: t.brush, toolMm: +Math.max(st.toolMm, 1.1 * LINE_SHEET_MM / Math.max(size, 1)).toFixed(3),
      wobble: st.defaults?.wobble ?? 0.3, hatch: st.defaults?.hatch ?? 0, seed: 1 };
    const gk = keyOf('linethumb', st.id, lineState.linesKey, opts);
    const key = keyOf(gk, size, m.cover);
    if (canvas.dataset.key === key) continue;
    const show = g => thumbs.add({
      canvas, key, width: size, height: size, needs: { brush: b, paper: p },
      render: r => {
        r.setLayout(LAYOUT); r.setPaper(p, 1);
        r.setStyle({ brush: b, ink, cover: m.cover, photoColor: false });
        r.setGeometry(g); return r.render(Infinity);
      },
    }, st.id === doc.lineart.style);
    const have = lineThumbGeoms.get(gk);
    if (have) { show(have); continue; }
    const lines = lineState.lines;
    setTimeout(() => {
      if (!lineart() || lineState.lines !== lines) return;
      Promise.resolve(lineState.engine.build(st.id, lines, opts, { tag: `thumb:${st.id}` })).then(g => {
        if (!g) return;
        lineThumbGeoms.set(gk, g);
        if (lineThumbGeoms.size > 16) lineThumbGeoms.delete(lineThumbGeoms.keys().next().value);
        if (lineart()) show(g);
      }).catch(e => console.warn('line art thumb failed', e));
    }, 80);
  }
}

// ------------------------------------------------------------------------------------ sync UI from doc
function syncControls() {
  const b = brush(), p = paper();
  document.body.classList.toggle('realistic', realistic());
  document.body.classList.toggle('lineart', lineart());
  modeSeg.set(doc.mode);
  syncGate();
  syncWelcome();
  $('tabLooksName').textContent = doc.mode === 'artistic' ? 'Looks' : 'Style';
  setChecked([...looksEl.children], el => el.dataset.id === doc.look);
  const edited = lookEdited();
  for (const el of looksEl.children) {
    el.querySelector('.dot')?.remove();
    if (el.dataset.id === doc.look && edited) {
      const dot = document.createElement('span'); dot.className = 'dot'; dot.title = 'Edited';
      el.querySelector('.thumb').append(dot);
    }
  }
  $('lookValue').textContent = `${lookById(doc.look).name}${edited ? ' · Edited' : ''}`;
  $('lookRevert').hidden = !edited;
  setChecked([...toolsEl.children], el => el.dataset.id === doc.brush);
  $('toolValue').textContent = b.name;
  if (inksEl.dataset.brush !== b.id) { buildInks(); inksEl.dataset.brush = b.id; }
  setChecked([...inksEl.children], el => doc.inkSource === 'photo' ? el.dataset.src === 'photo'
    : doc.inkSource === 'custom' ? el.dataset.src === 'custom' : el.dataset.hex === doc.ink);
  const custom = inksEl.querySelector('.custom');
  if (custom) {
    custom.style.background = doc.inkSource === 'custom' ? doc.ink : '';
    const inp = custom.querySelector('input');
    if (inp.value !== doc.ink) inp.value = doc.ink;
  }
  setChecked([...papersEl.children], el => el.dataset.id === doc.paper);
  $('paperValue').textContent = p.name;

  pathSeg.set(doc.line.path);
  shapeSeg.set(doc.free.shape);
  mazeSliders.flow.set(doc.free.flow);
  techSeg.set(doc.line.technique);
  dirSeg.set(doc.line.direction);
  for (const s of Object.values(lineSliders)) s.set(s.get());
  showLineControls();
  const look = lookById(doc.look);
  $('lineReset').hidden = !Object.entries(look.line).some(([k, v]) => doc.line[k] !== v);

  autoToggle.checked = !!doc.tone.auto;
  invertToggle.checked = !!doc.tone.invert;
  for (const [k, s] of Object.entries(photoSliders)) s.set(doc.tone[k]);
  photoSliders.brightness.el.hidden = !!doc.tone.auto;
  $('photoReset').hidden = JSON.stringify(doc.tone) === JSON.stringify(realistic() ? styleTone(doc.real.style) : { ...TONE_DEFAULTS });
  $('flipNote').hidden = !mode().flip;
  startSeg.set(doc.line.start);
  pacingSeg.set(prefs.pacing);
  updateHints();
  updateArtLabel();
  if (realistic()) syncReal();
  if (lineart()) syncLine();
}

function updateHints() {
  const b = brush(), p = paper(), m = mode();
  const th = $('toolHint'), ph = $('paperHint');
  th.hidden = ph.hidden = true;
  let hint = null;
  if (b.prefersDark && !p.dark) {
    const alt = paperById(b.id === 'chalk' ? 'chalkboard' : 'black');
    hint = { text: `${b.name} needs a dark sheet.`, label: `Use ${alt.name}`, run: () => setPaper(alt.id) };
  } else if (m.lowContrast) {
    const pap = hexToRgb(p.color);
    const [bestHex, bestName] = b.inks.reduce((a, c) => (contrastRatio(hexToRgb(c[0]), pap) > contrastRatio(hexToRgb(a[0]), pap) ? c : a));
    const what = doc.inkSource === 'custom' ? 'This' : inkName(b, doc.ink);
    if (contrastRatio(hexToRgb(bestHex), pap) >= 3) {
      hint = { text: `${what} ink won't show on ${p.name}.`, label: `Use ${bestName} ink`,
        run: () => change(d => { d.ink = bestHex; d.inkSource = 'swatch'; }, { label: `Ink: ${bestName}`, thumbs: true }) };
    } else {
      const alt = paperById(p.dark ? 'sketch' : 'black');
      hint = { text: `${b.name} won't show on ${p.name}.`, label: `Use ${alt.name}`, run: () => setPaper(alt.id) };
    }
  }
  if (!hint) return;
  // the same hint under the tools and under the papers (on phones only one tab is visible)
  for (const el of [th, ph]) {
    el.hidden = false;
    el.replaceChildren();
    const span = document.createElement('span'); span.textContent = hint.text;
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'text-btn'; btn.textContent = hint.label;
    btn.addEventListener('click', hint.run);
    el.append(span, btn);
  }
}
function inkName(b, hex) { return (b.inks.find(([h]) => h === hex) || [hex, 'This'])[1]; }

function updateArtLabel() {
  clearTimeout(updateArtLabel.t);
  updateArtLabel.t = setTimeout(() => {
    const what = photo ? (photo.sample ? `The ${photo.name} sample` : 'Your photo') : 'A blank sheet';
    const r = doc.real, la = doc.lineart;
    art.setAttribute('aria-label', photo && lineart()
      ? `${what} drawn as a one-line ${lineStyle(la.style)?.name || 'line art'} drawing with a ${la.toolMm} millimetre ${lineToolFor(la.tool).name.toLowerCase()} on ${paper().name} paper.`
      : photo && realistic()
      ? `${what} drawn in the ${realStyleById(r.style).name.toLowerCase()} style as one ${r.toolMm} millimetre line of a ${realToolFor(r.tool).name.toLowerCase()} on a ${formatMm(r.sheetMm)} sheet of ${paper().name} paper.`
      : photo
      ? `${what} drawn as one spiral line with a ${brush().name.toLowerCase()} in ${photoColor() ? 'colours from the photo' : inkName(brush(), doc.ink).toLowerCase() + ' ink'} on ${paper().name} paper, ${doc.line.rings} rings.`
      : 'A blank sheet of paper');
  }, 1000);
}

// ------------------------------------------------------------------------------------ thumbnails
const previewGeoms = {};
const thumbCache = {};
function thumbField(fl, rings) {
  const rk = keyOf(photo.id, doc.crop, 512);
  if (thumbCache.rk !== rk) { thumbCache.raster = rasterize(photo.canvas, doc.crop, 512); thumbCache.rk = rk; thumbCache.tones = new Map(); thumbCache.fields = new Map(); }
  const tk = keyOf(doc.tone, fl);
  if (!thumbCache.tones.has(tk)) thumbCache.tones.set(tk, processTone(thumbCache.raster, doc.tone, { flip: fl }));
  const fk = keyOf(tk, rings);
  if (!thumbCache.fields.has(fk)) thumbCache.fields.set(fk, buildField(thumbCache.raster, thumbCache.tones.get(tk).L, { rings, flip: fl }));
  return thumbCache.fields.get(fk);
}

function refreshThumbs(photoChanged = false) {
  if (photoChanged) delete thumbCache.rk;
  const dpr = DPR();
  // looks: rendered from the user's photo
  if (photo) {
    for (const el of looksEl.children) {
      const look = lookById(el.dataset.id);
      const canvas = el.querySelector('canvas');
      const size = Math.round((canvas.clientWidth || 96) * dpr);
      const b = brushById(look.brush), p = paperById(look.paper);
      const m = inkMode(b, look.ink, p);
      const fl = m.flip !== !!doc.tone.invert;
      thumbs.add({
        canvas, key: keyOf('look', look.id, photo.id, doc.crop, doc.tone, size, look.line.path || doc.line.path, doc.free), width: size, height: size,
        needs: { brush: b, paper: p },
        render: r => {
          const rings = Math.max(18, Math.min(look.line.rings, Math.round(size * LAYOUT.r / 2.6)));
          const lineSet = { ...LINE_DEFAULTS, ...look.line, rings, start: 'center' };
          const g = buildPath(look.line.path || doc.line.path, thumbField(fl, rings), lineSet, { ...doc.free, ...look.free }, { draft: true });
          r.setLayout(LAYOUT); r.setPaper(p, 1);
          r.setStyle({ brush: b, ink: look.ink, cover: m.cover, photoColor: false });
          r.setGeometry(g); return r.render(Infinity);
        },
      }, look.id === doc.look);
    }
  }
  refreshStyleThumbs();
  refreshLineThumbs();
  // tool chips: a spiral fragment in each tool, on the current paper (every mode's grid)
  const p = paper();
  for (const el of [...toolsEl.children, ...realToolsEl.children, ...lineToolsEl.children]) {
    const b = brushById(el.dataset.id);
    const canvas = el.querySelector('canvas');
    const w = Math.round((canvas.clientWidth || 70) * dpr), h = Math.round((canvas.clientHeight || 52) * dpr);
    const pp = chipPaperFor(b, p);
    // Line art's chips show each tool in its own dark line-art ink
    const lineChip = el.parentElement === lineToolsEl && !pp.dark;
    const ink = photoColor() ? b.inks[0][0] : lineChip ? lineToolFor(b.id).ink : inkFor(b, pp);
    const m = inkMode(b, ink, pp);
    const tech = doc.line.technique === 'wave' ? 'wave' : 'thickness';
    // wet media: the pen pauses once where the chip shows it, so it pools there and the ink's
    // shading and bleed read (otherwise fountain ink looks like the pen chip)
    const gk = b.wetness > 0 ? `${tech}:pause` : tech;
    thumbs.add({
      canvas, key: keyOf('tool', b.id, pp.id, ink, gk, w, h), width: w, height: h,
      needs: { brush: b, paper: pp },
      render: r => {
        const g = previewGeoms[gk] || (previewGeoms[gk] = previewStroke({ technique: tech, pauses: b.wetness > 0 ? [0.55] : [] }));
        // a close-up of the drawing: arcs of the outer rings sweeping across from a corner
        r.setLayout({ cx: -0.05, cy: 1.08 * h / w, r: 1.12 }); r.setPaper(pp, 1);
        r.setStyle({ brush: b, ink, cover: m.cover, photoColor: false });
        r.setGeometry(g); return r.render(Infinity);
      },
    });
  }
  // paper chips: the sheet itself with a short stroke of the current tool when it shows
  const b = brush();
  for (const el of papersEl.children) {
    const pp = paperById(el.dataset.id);
    const canvas = el.querySelector('canvas');
    const s = Math.round((canvas.clientWidth || 64) * dpr);
    const ink = photoColor() ? b.inks[0][0] : inkFor(b, pp);
    const m = inkMode(b, ink, pp);
    thumbs.add({
      canvas, key: keyOf('paper', pp.id, b.id, ink, s), width: s, height: s,
      needs: { brush: b, paper: pp },
      render: r => {
        const g = previewGeoms.fine || (previewGeoms.fine = previewStroke({ technique: 'thickness', ringsVisible: 9, turns: 2 }));
        r.setLayout({ cx: -0.1, cy: 1.1, r: 1.25 }); r.setPaper(pp, 1);
        r.setStyle({ brush: b, ink, cover: m.cover, photoColor: false });
        r.setGeometry(g);
        return m.lowContrast || (b.prefersDark && !pp.dark) ? r.renderBlank() : r.render(Infinity);
      },
    });
  }
}

let idleTimer = 0;
function scheduleIdleWork() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (need.penSees) { need.penSees = false; drawPenSees(); }
  }, 120);
}

// ------------------------------------------------------------------------------------ photos
async function setPhoto(img, { sample = false, crop = null, subject = null, demo = true, announceIt = true } = {}) {
  photo = { ...img, id: ++photoSeq, sample };
  lineState.revealNext = lineart();
  loupe.fit({ instant: true });
  if (subjectPick.active) setSubjectPick(false);
  doc.crop = crop ? { ...CROP_DEFAULTS, ...crop } : autoCrop(img);
  doc.subject = validSubject(subject);          // a new photo starts automatic; a saved one keeps its tap
  delete thumbCache.rk;
  $('fileName').textContent = sample ? `${img.name} (sample)` : img.name;
  geom = null;
  invalidate('geom');
  history.reset(snapshot());
  syncControls();
  refreshThumbs(true);
  if (demo && !reducedMotion()) { play.f = 0; setPlaying(true, { demo: true }); }
  else { play.f = 1; setPlaying(false); }
  if (announceIt) announce(sample ? `${img.name} sample loaded` : 'Photo loaded');
  if (img.small) toast('This photo is small, so the drawing may look soft.');
  if (!sample) saveSession();
}

async function saveSession() {
  if (!photo || photo.sample) return;
  clearTimeout(saveSession.t);
  saveSession.t = setTimeout(async () => {
    try {
      if (!photo.blob) photo.blob = await encodeForStorage(photo.canvas);
      await savePhoto({ blob: photo.blob, name: photo.name, crop: doc.crop, subject: doc.subject ?? null, savedAt: Date.now() });
    } catch { /* storage is best-effort */ }
  }, 500);
}

let loading = 0;
async function openFile(file) {
  const t = setTimeout(() => { $('busy').hidden = false; toast('Reading your photo…'); }, 300);
  const my = ++loading;
  try {
    const img = await decodeImage(file);
    if (my !== loading) return;
    hideWelcome();
    await setPhoto(img);
    // flat-photo check after the first tone pass
    requestAnimationFrame(() => { if (cache.tone?.stats?.flat) toast('This photo is very flat — one with a clear subject works best.'); });
  } catch (e) {
    console.warn(e);
    toast(imageErrorMessage(e), { error: true });
    announce(imageErrorMessage(e), true);
  } finally {
    clearTimeout(t);
    $('busy').hidden = true;
  }
}

async function openSample(id, opts = {}) {
  try {
    const { makeSample, SAMPLES } = await import('./samples.js');
    const meta = SAMPLES.find(s => s.id === id) || SAMPLES[0];
    const canvas = await makeSample(meta.id, 1024);
    const img = fromDrawable(canvas, meta.name);
    await setPhoto(img, { sample: true, ...opts });
    return true;
  } catch (e) {
    console.warn('sample failed', e);
    return false;
  }
}

const fileInput = $('fileInput');
function pickFile() { fileInput.value = ''; fileInput.click(); }
fileInput.addEventListener('change', () => { if (fileInput.files[0]) openFile(fileInput.files[0]); });
for (const id of ['btnOpen', 'btnChoose', 'mOpen']) $(id).addEventListener('click', pickFile);

// drag and drop anywhere
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropzone').hidden = false; });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropzone').hidden = true; });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  const files = [...e.dataTransfer.files];
  const img = files.find(f => f.type.startsWith('image/')) || files[0];
  if (files.length > 1) toast('Using the first photo.');
  if (img) openFile(img);
});
window.addEventListener('paste', e => {
  if (e.target.closest?.('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const f = item.getAsFile();
  if (f) openFile(new File([f], f.name || 'pasted image.png', { type: f.type }));
});

// ------------------------------------------------------------------------------------ welcome
/** The welcome card's sentence follows the mode (switching modes on the welcome screen too). */
function syncWelcome() {
  const w = $('welcome');
  if (!w || w.hidden || w.dataset.back) return;
  $('welcomeLede').textContent = realistic() ? 'Choose an image and watch it drawn as one real line, at the pace of a hand.'
    : lineart() ? 'Choose a photo and watch it drawn as one continuous line, feature by feature, the way a line artist would.'
    : 'Choose an image and watch it drawn as a single, unbroken spiral.';
}
function hideWelcome() {
  $('welcome').hidden = true;
  document.body.classList.remove('welcoming');
  layoutStage();
  if (!prefs.visited) { prefs.visited = true; persist(); }
}
async function buildSamples() {
  let mod;
  try { mod = await import('./samples.js'); } catch { return; }
  const host = $('samples');
  for (const s of mod.SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sample';
    b.innerHTML = '<canvas width="56" height="56" aria-hidden="true"></canvas><span></span>';
    b.querySelector('span').textContent = s.name;
    b.title = s.alt || s.name;
    b.addEventListener('click', async () => { hideWelcome(); await openSample(s.id); });
    host.append(b);
    mod.makeSample(s.id, 128).then(c => b.querySelector('canvas').getContext('2d').drawImage(c, 0, 0, 56, 56)).catch(() => {});
  }
}

// ------------------------------------------------------------------------------------ framing
const framing = { active: false, start: null, pointers: new Map(), gesture: null };
const sheet = $('sheet');
const frZoom = $('frZoom');
const ZMIN = 0.5, ZMAX = 6;
const zoomToSlider = z => Math.round(Math.log(z / ZMIN) / Math.log(ZMAX / ZMIN) * 1000);
const sliderToZoom = v => ZMIN * Math.pow(ZMAX / ZMIN, v / 1000);

function enterFraming() {
  if (!photo || framing.active) return;
  finishDemo();
  setPlaying(false);
  play.f = 1;
  loupe.fit({ instant: true });
  framing.active = true;
  framing.start = { ...doc.crop };
  sheet.classList.add('framing');
  $('btnFrame').setAttribute('aria-pressed', 'true');
  $('frameBar').hidden = false;
  $('transport').hidden = true;
  frZoom.value = zoomToSlider(doc.crop.zoom); paintRange(frZoom);
  invalidate('render');
  announce('Framing. Drag to move the photo, scroll or pinch to zoom. Enter to finish, Escape to cancel.');
  sheet.focus?.();
}
function exitFraming(apply) {
  if (!framing.active) return;
  framing.active = false;
  sheet.classList.remove('framing', 'dragging');
  $('btnFrame').setAttribute('aria-pressed', 'false');
  $('frameBar').hidden = true;
  $('transport').hidden = false;
  if (!apply) doc.crop = framing.start;
  invalidate('geom');
  if (apply && JSON.stringify(framing.start) !== JSON.stringify(doc.crop)) { commit('Framing'); refreshThumbs(true); }
  $('btnFrame').focus();
}
function cropPan(dxPx, dyPx) {
  // screen px on the sheet -> image normalised coords (inverse of the rasterize transform)
  const Rpx = LAYOUT.r * sheetCss;
  const diam = cropDiameter(photo.width, photo.height, doc.crop);
  const k = (diam / 2) / Rpx;
  const a = -(doc.crop.rotation || 0) * Math.PI / 180;
  const ix = (dxPx * Math.cos(a) - dyPx * Math.sin(a)) * k;
  const iy = (dxPx * Math.sin(a) + dyPx * Math.cos(a)) * k;
  doc.crop.x = clamp(doc.crop.x - ix / photo.width, -0.5, 1.5);
  doc.crop.y = clamp(doc.crop.y - iy / photo.height, -0.5, 1.5);
}
function cropZoom(factor, anchorPx = null) {
  const z0 = doc.crop.zoom, z1 = clamp(z0 * factor, ZMIN, ZMAX);
  if (anchorPx) {
    // keep the photo point under the pointer fixed
    const [ax, ay] = anchorPx;
    const s = 1 - z0 / z1;
    cropPan(-ax * s, -ay * s);
  }
  doc.crop.zoom = z1;
  frZoom.value = zoomToSlider(z1); paintRange(frZoom);
}
function relToCircle(e) {
  const r = sheet.getBoundingClientRect();
  return [e.clientX - (r.left + LAYOUT.cx * r.width), e.clientY - (r.top + LAYOUT.cy * r.width)];
}
sheet.addEventListener('pointerdown', e => {
  if (!framing.active) return;
  sheet.setPointerCapture(e.pointerId);
  framing.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  sheet.classList.add('dragging');
});
sheet.addEventListener('pointermove', e => {
  if (!framing.active || !framing.pointers.has(e.pointerId)) return;
  const prev = framing.pointers.get(e.pointerId);
  const pts = [...framing.pointers.values()];
  if (framing.pointers.size === 1) {
    cropPan(e.clientX - prev[0], e.clientY - prev[1]);
  } else if (framing.pointers.size === 2) {
    const other = pts.find(p => p !== prev);
    const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
    const d1 = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
    const a0 = Math.atan2(prev[1] - other[1], prev[0] - other[0]);
    const a1 = Math.atan2(e.clientY - other[1], e.clientX - other[0]);
    const r = sheet.getBoundingClientRect();
    const mid = [(e.clientX + other[0]) / 2 - (r.left + LAYOUT.cx * r.width), (e.clientY + other[1]) / 2 - (r.top + LAYOUT.cy * r.width)];
    if (d0 > 4) cropZoom(d1 / d0, mid);
    let rot = (doc.crop.rotation || 0) + (a1 - a0) * 180 / Math.PI;
    for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(rot - snap) < 4) rot = snap;
    doc.crop.rotation = ((rot + 540) % 360) - 180;
  }
  framing.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  invalidate('draft');
});
const endPointer = e => {
  if (!framing.pointers.delete(e.pointerId)) return;
  if (!framing.pointers.size) { sheet.classList.remove('dragging'); invalidate('geom'); }
};
sheet.addEventListener('pointerup', endPointer);
sheet.addEventListener('pointercancel', endPointer);
sheet.addEventListener('wheel', e => {
  if (!framing.active) return;
  e.preventDefault();
  cropZoom(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), relToCircle(e));
  invalidate('draft');
  clearTimeout(sheet.wheelT);
  sheet.wheelT = setTimeout(() => invalidate('geom'), 160);
}, { passive: false });
// (a double-click on the sheet zooms the loupe in now; F and the Frame button frame)
frZoom.addEventListener('input', () => { doc.crop.zoom = sliderToZoom(+frZoom.value); paintRange(frZoom); invalidate('draft'); });
frZoom.addEventListener('change', () => invalidate('geom'));
$('frRotate').addEventListener('click', () => { doc.crop.rotation = (((doc.crop.rotation || 0) + 90 + 180) % 360) - 180; invalidate('geom'); });
$('frFit').addEventListener('click', () => { doc.crop = autoCrop(photo); frZoom.value = zoomToSlider(doc.crop.zoom); paintRange(frZoom); invalidate('geom'); });
$('frCancel').addEventListener('click', () => exitFraming(false));
$('frDone').addEventListener('click', () => exitFraming(true));
$('btnFrame').addEventListener('click', () => (framing.active ? exitFraming(true) : enterFraming()));
$('btnFrame2').addEventListener('click', () => enterFraming());
$('btnFrame3').addEventListener('click', () => enterFraming());

// ------------------------------------------------------------------------------------ compare
function setCompare(on) {
  if (!photo || framing.active) return;
  view.compare = on ? 1 : 0;
  $('btnCompare').classList.toggle('on', on);
  invalidate('render');
}
const cmp = $('btnCompare');
cmp.addEventListener('pointerdown', e => { e.preventDefault(); setCompare(true); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, () => setCompare(false));
cmp.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompare(true); } });
cmp.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') setCompare(false); });
// long-press on the sheet compares on touch
let lpTimer = 0;
sheet.addEventListener('pointerdown', e => {
  if (framing.active || e.pointerType !== 'touch') return;
  lpTimer = setTimeout(() => setCompare(true), 450);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) sheet.addEventListener(ev, () => { clearTimeout(lpTimer); if (view.compare) setCompare(false); });
sheet.addEventListener('contextmenu', e => { if (isTouch()) e.preventDefault(); });
// tapping the sheet finishes the reveal
sheet.addEventListener('click', () => { if (play.demo) finishDemo(); });

const pen = $('penSees');
pen.addEventListener('pointerdown', e => { e.preventDefault(); view.penSees = true; invalidate('render'); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) pen.addEventListener(ev, () => { view.penSees = false; invalidate('render'); });

// ------------------------------------------------------------------------------------ playback menu
popover($('btnPlayMenu'), $('playMenu'));
const pacingSeg = bindSeg(document.querySelector('[data-bind="pacing"]'), prefs.pacing, v => { prefs.pacing = v; persist(); invalidate('render'); });
const startSeg = bindSeg(document.querySelector('[data-bind="start"]'), doc.line.start, v => change(d => { d.line.start = v; }, { label: 'Draw from' }));
bindSeg(document.querySelector('[data-bind="speed"]'), String(prefs.speed), v => { prefs.speed = +v; persist(); });
const showToolEl = document.querySelector('[data-bind="showTool"]');
showToolEl.checked = prefs.showTool;
showToolEl.addEventListener('change', () => { prefs.showTool = showToolEl.checked; persist(); invalidate('render'); });

// ------------------------------------------------------------------------------------ top menu, theme
const topMenu = popover($('btnMenu'), $('menu'));
function applyTheme() {
  const t = prefs.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
bindSeg($('themeSeg'), prefs.theme, v => { prefs.theme = v; applyTheme(); persist(); });
applyTheme();
$('menu').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  topMenu.close();
  if (act === 'open') pickFile();
  if (act === 'shortcuts') $('keysDialog').showModal();
  if (act === 'print3d') openPrint3d();
  if (act === 'forget') { await forgetPhoto(); toast('Your saved photo was removed from this browser.'); $('btnContinue').hidden = true; }
  if (act === 'reset') {
    if (!confirm('Reset every setting and forget the saved photo?')) return;
    clearSettings(); await forgetPhoto(); location.reload();
  }
});

// ------------------------------------------------------------------------------------ mobile tabs
const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
function selectTab(name) {
  for (const t of tabs) { const on = t.dataset.tab === name; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; }
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === name);
  refreshThumbs();
}
for (const t of tabs) t.addEventListener('click', () => selectTab(t.dataset.tab));
$('tabs').addEventListener('keydown', e => {
  const i = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
  const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
  if (j >= 0) { e.preventDefault(); tabs[j].focus(); selectTab(tabs[j].dataset.tab); }
});

// ------------------------------------------------------------------------------------ dialogs
let dialogs = null;
async function loadDialogs() {
  if (!dialogs) {
    const [film, dl] = await Promise.all([import('./film.js'), import('./download.js')]);
    const ctx = {
      get doc() { return doc; }, get prefs() { return prefs; }, get photo() { return photo; },
      get geom() { return geom; }, renderState, persist, layout: LAYOUT,
      geometryWith(overrides) {
        const saveLine = doc.line;
        doc.line = { ...doc.line, ...overrides };
        try { return computeGeometry(false); } finally { doc.line = saveLine; }
      },
      drawPhotoInCircle(ctx2, cx, cy, R) { if (photo) drawPhotoInCircle(ctx2, cx, cy, R); },
      pause() { finishDemo(); setPlaying(false); },
      refreshTransport() { invalidate('render'); },
      lookName: () => lookById(doc.look).name,
      inkName: () => (photoColor() ? 'photo colours' : inkName(brush(), doc.ink)),
    };
    dialogs = { film: film.createFilmDialog(ctx), download: dl.createDownloadDialog(ctx) };
  }
  return dialogs;
}
async function openFilm() {
  if (!geom) return toast('Choose a photo first.');
  (await loadDialogs()).film.open();
}
async function openDownload(quick = false) {
  if (!geom) return toast('Choose a photo first.');
  const d = (await loadDialogs()).download;
  // Realistic: the files are real-size (the SVG is a plotter file of the real sheet and pen)
  const note = $('dlRealNote');
  note.hidden = !geom?.real && !geom?.lineart;
  if (geom?.lineart) {
    const L = geom.lineart, t = lineToolFor(L.tool || doc.lineart.tool);
    note.textContent = `Line art: ${(+L.lengthM).toFixed(1)} m of one line with a ${L.toolMm} mm ${t.name.toLowerCase()}, on a ${formatMm(L.sheetMm || LINE_SHEET_MM)} square sheet. The PNG is that sheet rendered; the SVG is it at real size.`;
  } else if (geom?.real) {
    const r = geom.real;
    note.textContent = `Realistic: the SVG is a real-size plotter file — one path, ${r.toolMm} mm stroke, ${formatMm(r.sheetMm)} × ${formatMm(r.sheetMm)} sheet, ${r.lengthM.toFixed(1)} m of line. The PNG is the rendered sheet.`;
  }
  quick ? d.quick() : d.open();
}
$('btnFilm').addEventListener('click', openFilm);
$('mFilm').addEventListener('click', openFilm);
// Get the film ready while the pointer or focus is on its button: the scene's compile and the
// desk's bake start then, so the dialog's preview shows sooner (freed again if it is not opened).
for (const id of ['btnFilm', 'mFilm']) {
  for (const ev of ['pointerenter', 'focus']) $(id).addEventListener(ev, () => warmFilm(prefs.film.desk));
}
$('btnDownload').addEventListener('click', () => openDownload());
$('mSave').addEventListener('click', () => openDownload());

// 3D print (js/print3d/dialog.js): loaded on first use; meshes are built in its worker
let print3d = null;
async function openPrint3d() {
  if (!geom) return toast('Choose a photo first.');
  if (!print3d) {
    const m = await import('./print3d/dialog.js');
    print3d = m.createPrint3DDialog({
      get geom() { return geom; }, get mode() { return doc.mode; }, get photoName() { return photo?.name || ''; },
      get field() { return !lineart() && !realistic() ? cache.field || null : null; },
      async silhouette() {
        // Line art already has the subject's outline; the other modes find it on demand
        const own = lineState.lines?.features?.silhouette;
        if (own?.outlines?.length) return own;
        if (!photo) return null;
        const { frameCanvas, silhouetteOf } = await import('./lineart/lines.js');
        // (a subject tapped in Line art is the subject here too)
        const tap = subjectFrameTap();
        return silhouetteOf(frameCanvas(photo.canvas, { ...doc.crop }, 512), tap ? { tap } : {});
      },
    });
  }
  finishDemo(); setPlaying(false);
  print3d.open();
}
$('btnPrint3d').addEventListener('click', openPrint3d);

// ------------------------------------------------------------------------------------ keyboard
const typing = t => t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName) && !['range', 'checkbox', 'radio', 'button'].includes(t.type));
const onBody = t => !t || t === document.body || t === sheet || t.closest?.('.stage') && !t.closest('button, input');
window.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (mod && (k === 'z' || k === 'Z')) { if (typing(e.target)) return; e.preventDefault(); (e.shiftKey ? $('btnRedo') : $('btnUndo')).click(); return; }
  if (mod && (k === 'y' || k === 'Y')) { if (typing(e.target)) return; e.preventDefault(); $('btnRedo').click(); return; }
  if (mod && (k === 'o' || k === 'O')) { e.preventDefault(); pickFile(); return; }
  if (mod && (k === 's' || k === 'S')) { e.preventDefault(); openDownload(true); return; }
  if (mod || e.altKey || typing(e.target)) return;
  if (picking.active && k === 'Escape') { e.preventDefault(); setPicking(false); return; }
  if (subjectPick.active && k === 'Escape') { e.preventDefault(); setSubjectPick(false); return; }
  if (framing.active) {
    if (k === 'Enter') { e.preventDefault(); exitFraming(true); }
    else if (k === 'Escape') { e.preventDefault(); exitFraming(false); }
    else if (k.startsWith('Arrow')) {
      e.preventDefault();
      const step = (e.shiftKey ? 0.1 : 0.01) * LAYOUT.r * sheetCss * 2;
      cropPan(k === 'ArrowLeft' ? step : k === 'ArrowRight' ? -step : 0, k === 'ArrowUp' ? step : k === 'ArrowDown' ? -step : 0);
      invalidate('geom');
    } else if (k === '+' || k === '=') { cropZoom(1.1); invalidate('geom'); }
    else if (k === '-') { cropZoom(1 / 1.1); invalidate('geom'); }
    return;
  }
  if (k === ' ' && onBody(e.target)) { e.preventDefault(); $('btnPlay').click(); return; }
  if ((k === 'ArrowLeft' || k === 'ArrowRight') && onBody(e.target) && geom) {
    e.preventDefault(); finishDemo(); setPlaying(false);
    play.f = clamp(play.f + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1) / drawSec(), 0, 1);
    invalidate('render'); return;
  }
  if ((k === 'Home' || k === 'End') && onBody(e.target) && geom) { e.preventDefault(); finishDemo(); setPlaying(false); play.f = k === 'Home' ? 0 : 1; invalidate('render'); return; }
  if (k === '\\') { e.preventDefault(); if (!e.repeat) setCompare(true); return; }
  if (k === 'f' || k === 'F') { e.preventDefault(); enterFraming(); return; }
  if (k === 'r' || k === 'R') { e.preventDefault(); openFilm(); return; }
  if (k === 'p' || k === 'P') { e.preventDefault(); openPrint3d(); return; }
  if (k === '?') { e.preventDefault(); $('keysDialog').showModal(); return; }
  // loupe: + / - zoom around the middle of the view, 0 fits the whole sheet
  if ((k === '+' || k === '=') && photo) { e.preventDefault(); loupe.zoomBy(2); return; }
  if ((k === '-' || k === '_') && photo) { e.preventDefault(); loupe.zT / 2 <= 1.05 ? loupe.fit() : loupe.zoomBy(0.5); return; }
  if (k === '0' && photo) { e.preventDefault(); loupe.fit(); return; }
  if (k === 'm' || k === 'M') { e.preventDefault(); setMode(MODES[(MODES.indexOf(doc.mode) + 1) % MODES.length]); return; }
  if (lineart()) {
    // 1-4 pick the style (A-D), [ and ] take less or more of the photo
    if (/^[1-4]$/.test(k)) { e.preventDefault(); setLineStyle(LINE_STYLE_IDS[+k - 1]); return; }
    if (k === '[' || k === ']') {
      e.preventDefault();
      const v = +clamp(doc.lineart.detail + (k === ']' ? 0.1 : -0.1), 0, 1).toFixed(2);
      if (v !== doc.lineart.detail) { change(d => { d.lineart.detail = v; }, { label: 'Detail', thumbs: true }); announce(`Detail ${Math.round(v * 100)}%`); }
    }
    return;
  }
  if (realistic()) {
    // 1-4 pick the style (A-D), [ and ] step the detail preset
    if (/^[1-4]$/.test(k)) { e.preventDefault(); setRealStyle(REAL_STYLES[+k - 1].id); return; }
    if (k === '[' || k === ']') {
      e.preventDefault();
      const ids = ['quick', 'detailed', 'masterpiece'];
      const i = clamp(ids.indexOf(doc.real.preset) + (k === ']' ? 1 : -1), 0, 2);
      if (ids[i] !== doc.real.preset) { change(d => { d.real.preset = ids[i]; }, { label: `Detail: ${PRESET_NAME[ids[i]]}` }); announce(PRESET_NAME[ids[i]]); }
    }
    return;
  }
  if (/^[1-9]$/.test(k) && LOOKS[+k - 1]) { e.preventDefault(); applyLook(LOOKS[+k - 1].id); return; }
  if (k === '[' || k === ']') {
    e.preventDefault();
    const r = clamp(doc.line.rings + (k === ']' ? 10 : -10), 20, 160);
    change(d => { d.line.rings = r; }, { label: 'Rings', thumbs: true });
    announce(`${r} rings`);
  }
});
window.addEventListener('keyup', e => { if (e.key === '\\') setCompare(false); });

// ------------------------------------------------------------------------------------ boot
async function boot() {
  buildLooks();
  buildStyles();
  buildTools();
  buildRealTools();
  buildLineTools();
  buildLineSliders2();
  buildInks();
  inksEl.dataset.brush = doc.brush;
  buildPapers();
  buildLineSliders();
  buildPhotoSliders();
  selectTab('looks');
  layoutStage();
  history.reset(snapshot());
  syncControls();
  refreshThumbs();
  renderer.setLayout(LAYOUT);
  applyRendererState();
  renderer.renderBlank();

  const session = await loadPhoto();
  const welcome = $('welcome');
  welcome.hidden = false;
  syncWelcome();
  document.body.classList.add('welcoming');
  buildSamples();
  layoutStage();
  if (session?.blob) {
    welcome.dataset.back = '1';
    $('welcomeTitle').innerHTML = 'Welcome <em>back.</em>';
    $('welcomeLede').textContent = 'Your last style is ready. Continue with your photo or choose a new one.';
    const cont = $('btnContinue');
    cont.hidden = false;
    cont.addEventListener('click', async () => {
      try {
        const img = await decodeImage(session.blob, session.name);
        hideWelcome();
        await setPhoto(img, { crop: session.crop, subject: session.subject });
      } catch (e) { toast(imageErrorMessage(e), { error: true }); }
    }, { once: true });
  }
  starCount().then(n => {
    if (n == null) return;
    const el = $('starCount');
    el.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    el.hidden = false;
  });
  // the first thing a visitor sees: a sample drawing itself behind the welcome card
  const ok = await openSample('bust', { announceIt: false });
  if (!ok) { renderer.renderBlank(); }
}
boot();

// Offline support after the first visit (skipped on localhost so development never serves stale files).
if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === '127.0.0.1') {
  navigator.serviceWorker?.register('sw.js').catch(() => { /* sandboxed or unsupported: fine */ });
}

// debug / test hooks
window.SP = {
  get doc() { return doc; }, get prefs() { return prefs; }, get geom() { return geom; }, get photo() { return photo; },
  get toneStats() { return cache.tone?.stats; },
  play, renderer, loupe, change, applyLook, setBrush, setPaper, openSample, enterFraming, exitFraming,
  setMode, setRealStyle, setRealTool, realBuilder, setLineStyle, setLineTool, lineState, setSubjectPick, subjectFrameTap,
  get lineSubject() { const s = lineState.lines?.features?.silhouette; return { tap: doc.subject, frameTap: subjectFrameTap(), label: $('subjectWhat')?.textContent || '', kind: s?.kind ?? null, subject: s?.subject ?? null, tapped: !!s?.tapped, tapOutcome: lineState.lines?.tapOutcome ?? null, hint: $('subjectSub')?.textContent || '' }; },
  get building() {
    return $('sheet').classList.contains('building') || realBuilder.busy
      || (realistic() && !!photo && (realState.dirty || (realState.want !== realState.key && realState.want !== realState.failed)))
      || (lineart() && !!photo && lineBusy());
  },
  openFilm, openDownload, invalidate, renderState, history, openPrint3d, get print3d() { return print3d; },
  async shot(name = 'app') {
    const data = art.toDataURL('image/png');
    return (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) })).json();
  },
};
