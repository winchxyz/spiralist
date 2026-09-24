// Line art styles A-D (the approved line-up, shots/lineart_lineup.jpg) and the one function that
// turns extracted lines into a drawing in a style. Pure: no DOM, so it runs in the build Worker
// (js/lineart/buildworker.js) and on the main thread alike.
//
//   buildStyled('matisse', { strokes, features, engine }, { sheetMm, tool, toolMm, wobble, hatch, seed })
//
// Each style differs in what it keeps (pick), how the hand moves (line) and what it draws with.
import { STRIDE } from '../spiral.js';
import { buildLineArt, LAYOUT_R, silhouetteStrokes, standinSilhouette, silhouetteScore } from './path.js';
import { strokeLength } from './strokes.js';

/** The four approved styles. defaults are what the UI starts each style with. */
export const LINE_STYLES = Object.freeze([
  {
    id: 'picasso', letter: 'A', name: 'Picasso: sparse',
    blurb: 'Fewest confident contours in one bold, even line, with a lot of white paper.',
    tool: 'marker', toolMm: 1.3, paper: 'sketch', ink: '#151515',
    defaults: { detail: 0.35, wobble: 0.15, hatch: 0, overshoot: 0.3, speedMm: 34, line: 'sparse', drift: 0, rhythm: 1.4 },
  },
  {
    id: 'matisse', letter: 'B', name: 'Matisse: portrait',
    blurb: 'The features and a few hair lines with a fine nib that swells where the hand slows.',
    tool: 'fountain', toolMm: 0.55, paper: 'cream', ink: '#16161c',
    defaults: { detail: 0.45, wobble: 0.3, hatch: 0, overshoot: 0.35, speedMm: 20, line: 'sparse', drift: 0, rhythm: 1 },
  },
  {
    id: 'blind', letter: 'C', name: 'Blind contour',
    blurb: 'A slow soft pencil with the eyes on the model: drift, loops and charming misfits.',
    tool: 'pencil', toolMm: 0.8, paper: 'sketch', ink: '#2a2a2e',
    defaults: { detail: 0.6, wobble: 1, hatch: 0, overshoot: 1, speedMm: 12, line: 'rich', drift: 1, rhythm: 0.5 },
  },
  {
    id: 'brush', letter: 'D', name: 'Brush pen + shading',
    blurb: 'A pressure-weighted sumi brush, with a few loose hatches where the subject is darkest, in the same line.',
    tool: 'brush', toolMm: 1.5, paper: 'coldpress', ink: '#0e0e0e',
    defaults: { detail: 0.7, wobble: 0.45, hatch: 1, overshoot: 0.5, speedMm: 22, line: 'rich', drift: 0, rhythm: 1.1 },
  },
]);

export function lineStyleById(id) {
  return LINE_STYLES.find(s => s.id === id || s.letter === id) || LINE_STYLES[1];
}

// ------------------------------------------------------------------ picks
const FACE_KINDS_A = new Set(['outline', 'jaw', 'eye', 'iris', 'nose', 'lips', 'ear', 'brow', 'hair']);

function pickPicasso(strokes, face) {
  if (!face) {
    // the extractor's own order, but only lines long enough to say something; an animal's eyes,
    // nose and mouth (found by the extractor) always stay: they are what makes it read
    const out = strokes.filter(s => s.silhouette || s.kind === 'eye' || s.kind === 'iris' || s.kind === 'nose' || s.kind === 'lips');
    let n = 0;
    for (const s of strokes) { if (n >= 8) break; if (out.includes(s)) continue; if (strokeLength(s) > 0.06 || s.kind === 'hair') { out.push(s); n++; } }
    return out.length >= 3 ? out : strokes.slice(0, 8);
  }
  // keep only the telling contours: outline, one brow, eyes, nose, mouth, two hair lines
  const cap = { brow: 1, hair: 2, ear: 0, outline: 2, jaw: 1, eye: 4, iris: 2, nose: 1, lips: 2 };
  const first = {};
  strokes.forEach((s, i) => { if (!(s.kind in first)) first[s.kind] = i; });
  // within a kind the longest line tells most (the mouth's whole meeting line, not a corner)
  const ranked = strokes.slice().sort((a, b) => (first[a.kind] - first[b.kind])
    || (a.kind === 'hair' ? b.saliency - a.saliency : 0) || (strokeLength(b) - strokeLength(a)));
  const out = [], count = {};
  for (const s of ranked) {
    // (the silhouette's contour always stays)
    if (s.silhouette) { out.push(s); continue; }
    if (!FACE_KINDS_A.has(s.kind)) continue;
    count[s.kind] = (count[s.kind] || 0) + 1;
    if (count[s.kind] <= (cap[s.kind] ?? 1)) out.push(s);
  }
  // sparse, not unfinished: the face's contour on BOTH sides of its midline (the far cheek or jaw
  // too), before the budget goes on more of the longest arcs
  const lm = face.landmarks;
  if (lm && lm.length >= 956) {
    const mid = lm[2];                         // nose tip x (landmark 1)
    const side = s => { let x = 0; for (let k = 0; k < s.points.length; k += 2) x += s.points[k]; return x / (s.points.length / 2) < mid ? -1 : 1; };
    const contour = s => s.kind === 'outline' || s.kind === 'jaw' || s.kind === 'ear';
    for (const sd of [-1, 1]) {
      if (out.some(s => contour(s) && side(s) === sd)) continue;
      const add = strokes.filter(s => contour(s) && !out.includes(s) && side(s) === sd).sort((a, b) => strokeLength(b) - strokeLength(a))[0];
      if (add) out.push(add);
    }
  }
  return out;
}

function pickMatisse(strokes, face) {
  if (!face) return strokes;
  // drop the cheek-shadow clutter: 'detail'/'other' only when strongly salient
  return strokes.filter(s => !(s.kind === 'detail' || s.kind === 'other') || s.saliency > 0.7);
}

function pickBrush(strokes, face) {
  if (!face) return strokes;
  return strokes.filter(s => !(s.kind === 'other') || s.saliency > 0.5);
}

// value noise for the blind-contour drift
function noise1(x, seed) {
  const h = i => { let t = Math.imul((i | 0) ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b); t ^= t >>> 13; t = Math.imul(t, 0xc2b2ae35); t ^= t >>> 16; return (t >>> 0) / 4294967296 * 2 - 1; };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

/** Blind contour misfits, in drawing space (so a retrace lands on its own first pass): the
 *  whole drawing sits on a gentle warp, and each feature comes out a little too big, tilted
 *  and shifted, the way features drawn without looking never quite line up. */
function misfit(strokes, face, seed) {
  // (half the warp when the drawing rides a silhouette: the outer shape is what must read)
  const A = strokes.some(s => s.silhouette) ? 0.014 : 0.028, K = 2 * Math.PI * 1.1;
  const ph = [1, 2, 3, 4].map(k => (noise1(k * 1.7, seed) + 1) * Math.PI);
  const warp = (x, y) => [
    x + A * Math.sin(K * y + ph[0]) + 0.5 * A * Math.sin(1.7 * K * x + ph[1]),
    y + A * Math.sin(K * x + ph[2]) + 0.5 * A * Math.sin(1.9 * K * y + ph[3]),
  ];
  const small = new Set(['eye', 'iris', 'brow', 'nose', 'lips', 'ear']);
  return strokes.map((s, si) => {
    const p = s.points, n = p.length / 2;
    let cx = 0, cy = 0;
    for (let k = 0; k < p.length; k += 2) { cx += p[k]; cy += p[k + 1]; }
    cx /= n; cy /= n;
    // (the silhouette's contour drifts with the warp but keeps its size: the shape must still read)
    const f = s.silhouette ? 0.1 : face && small.has(s.kind) ? 1 : 0.35;
    const sc = 1 + f * (0.12 + 0.12 * noise1(si * 3.1 + 0.5, seed + 7));
    const rot = f * 0.12 * noise1(si * 2.3 + 0.2, seed + 8);
    const sh = [f * 0.012 * noise1(si * 1.9 + 0.7, seed + 9), f * 0.012 * noise1(si * 2.9 + 0.1, seed + 10)];
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const out = new Float32Array(p.length);
    for (let k = 0; k < p.length; k += 2) {
      const dx = (p[k] - cx) * sc, dy = (p[k + 1] - cy) * sc;
      const [x, y] = warp(cx + dx * cr - dy * sr + sh[0], cy + dx * sr + dy * cr + sh[1]);
      out[k] = Math.min(1, Math.max(0, x)); out[k + 1] = Math.min(1, Math.max(0, y));
    }
    return { ...s, points: out };
  });
}

/** Blind contour: the eye stays on the model, so the hand's position error accumulates along the
 *  line (a slow random walk, never reset). Retraced passages come back beside, not on, the first pass. */
function blindDrift(geom, amount, sheetMm, seed) {
  if (!amount) return;
  const mmPerCU = LAYOUT_R * sheetMm, d = geom.data;
  const A = 1.8 / mmPerCU * amount;            // up to ~1.8 mm of hand drift
  for (let i = 0; i < geom.n; i++) {
    const sMm = d[i * STRIDE + 3] * mmPerCU;
    const u = sMm / 90, v = sMm / 23;
    const dx = A * (0.75 * noise1(u, seed + 1) + 0.25 * noise1(v, seed + 2));
    const dy = A * (0.75 * noise1(u, seed + 3) + 0.25 * noise1(v, seed + 4));
    const g = Math.min(1, sMm / 40);           // grows in over the first 40 mm
    d[i * STRIDE] = Math.max(-1, Math.min(1, d[i * STRIDE] + dx * g));
    d[i * STRIDE + 1] = Math.max(-1, Math.min(1, d[i * STRIDE + 1] + dy * g));
  }
}

const PICKS = { picasso: pickPicasso, matisse: pickMatisse, blind: misfit, brush: pickBrush };

/**
 * lineResult: { strokes, features, engine } (LineArtEngine.lines / extractLines)
 * opts: { sheetMm, tool, toolMm, wobble, hatch, overshoot, speedMm, seed, pressure }
 */
export function buildStyled(styleId, lineResult, opts = {}) {
  const t0 = performance.now();
  const S = lineStyleById(styleId);
  const D = S.defaults;
  const seed = (opts.seed ?? 3) | 0;
  const features = (lineResult && lineResult.features) || {};
  const face = features.face || null;
  const strokes0 = (lineResult && lineResult.strokes) || [];
  // silhouette first: the subject's outer shape is the drawing's main line and the model's lines
  // are clipped to inside it (features.silhouette from js/lineart/silhouette.js; opts.silhouette:
  // 'standin' builds a stand-in from the lines themselves, false or 'off' draws the lines alone)
  const silOpt = opts.silhouette ?? true;
  let sil = silOpt === false || silOpt === 'off' ? null : features.silhouette || null;
  if (!sil && silOpt === 'standin' && strokes0.length) sil = standinSilhouette(strokes0, { face });
  const silOk = sil && ((sil.outlines && sil.outlines.length) || (sil.mask && sil.mask.data) || (sil.skyline && sil.skyline.length >= 8));
  const strokes = silOk ? silhouetteStrokes(strokes0, sil, S.id, face, features.dark) : strokes0;
  const picked = PICKS[S.id](strokes, face, seed);
  const sheetMm = opts.sheetMm || 210;
  const line = {
    sheetMm, seed,
    tool: opts.tool || S.tool, toolMm: opts.toolMm || S.toolMm,
    style: D.line,
    wobble: opts.wobble ?? D.wobble, overshoot: opts.overshoot ?? D.overshoot,
    hatch: opts.hatch ?? D.hatch, speedMm: opts.speedMm ?? D.speedMm, rhythm: opts.rhythm ?? D.rhythm ?? 1,
    pressure: opts.pressure ?? null,
    styleId: S.id,
  };
  const geom = buildLineArt(picked, silOk && sil !== features.silhouette ? { ...features, silhouette: sil } : features, line);
  blindDrift(geom, (opts.drift ?? D.drift) * (0.4 + 0.6 * (line.wobble ?? 1)), sheetMm, seed * 31 + 1);
  const la = geom.lineart;
  if (silOk) {
    la.silhouette = { kind: sil.kind || 'unknown', confidence: sil.confidence ?? null, standin: !!sil.standin };
    // how well the drawing gives the subject's outer shape (the line-up reports it)
    try { la.silScore = silhouetteScore(geom, sil); } catch { la.silScore = null; }
  }
  else if (features.silhouette && features.silhouette.mask) {
    // (drawn without it, but scored against it: the before of a before/after)
    try { la.silScore = silhouetteScore(geom, features.silhouette); } catch { la.silScore = null; }
  }
  if (la.lengthM) la.retraceShare = +(la.retracedM / la.lengthM).toFixed(3);
  la.lineStyle = la.style;
  la.style = S.id;
  la.letter = S.letter;
  la.engine = (lineResult && lineResult.engine) || 'model';
  la.picked = picked.length;
  la.buildMs = Math.round(performance.now() - t0);
  return geom;
}
