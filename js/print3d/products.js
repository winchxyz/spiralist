// Print products for a Spiralist drawing: A relief plaque, B wire sculpture, C lithophane,
// D cookie cutter + stamp. Each builder turns one geometry (js/spiral.js format, any mode) into
// watertight parts at real print size, with a printability report and slicer settings.
//
//   buildProduct(id, geom, opts) -> {
//     parts: [{ name, mesh, color }], sizeMm: { x: [0, X], y: [0, Y], z: [0, Z] },
//     printability: { ok, onePlate, notes[], issues[] (the notes that make it not printable as is) },
//     settings: { layer, nozzle, colorChangeAtMm?, supports: false, walls, infill, ... },
//     stats: { partsMm: [{ name, x, y, z }], triangles, manifold: [{ name, ok, volumeMm3 }], ms, ... },
//     extras: { backlit?: { w, h, data } (lithophane: light through the panel, 0..1) }, product }
// sizeMm is the whole bed layout (all parts as placed); stats.partsMm gives each part's own size.
//
// Print axes: X right, Y away from you (up in a top view), Z up; the bed is Z = 0. Every part
// lies flat or stands on a flat first layer, with no overhangs (a 4.4 mm bridge in the stamp's
// handle slot is the one exception and is said so).
//
// Geometry kit: ./pkit.js (raster masks, contour tracing, earcut, extrusion, sweeps,
// heightfields). ./mesh.js (MESH) writes the STL / 3MF.

import { STRIDE, buildSpiral } from '../spiral.js';
import * as K from './pkit.js';

export const PRINTER = Object.freeze({ name: 'Bambu Lab A2L', bed: { x: 330, y: 320, z: 325 }, nozzle: 0.4, layer: 0.2 });
export const RULES = Object.freeze({ minWidthMm: 0.8, minGapMm: 0.5, minRaiseMm: 0.6 });

export const PRODUCTS = [
  { id: 'plaque', letter: 'A', name: 'Relief plaque', suits: ['artistic', 'realistic', 'lineart'],
    blurb: 'The line raised 1.2 mm on a 2.4 mm plate inside a 5 mm frame. Two colours: swap filament at the top of the plate (Z 2.4 mm) or give the line part its own AMS slot. Stands in a printed foot or hangs on two nails.' },
  { id: 'wire', letter: 'B', name: 'Wire sculpture', suits: ['lineart', 'artistic'],
    blurb: 'The one continuous line itself, 1.6 mm wide and 2.4 mm tall, printed flat; crossings fuse into one piece. Hangs from a loop at the start of the line, or stands in a slotted base.' },
  { id: 'litho', letter: 'C', name: 'Lithophane', suits: ['artistic', 'realistic', 'lineart'],
    blurb: 'A 0.8 to 3.2 mm thick panel whose thickness follows the darkness of the drawing. Looks plain white until a light behind it reveals the picture. Printed standing on a foot (best detail) or flat.' },
  { id: 'cutter', letter: 'D', name: 'Cookie cutter + stamp', suits: ['lineart', 'artistic'],
    blurb: 'A cutter in the outline of the subject (12 mm wall, 0.8 mm edge, flange) plus a stamp that presses the drawing\'s lines into the dough (mirrored 2 mm relief) with a push-fit handle.' },
];

export const COLORS = { paper: '#F4F1EA', ink: '#1E1E24', white: '#F7F7F4', natural: '#EDE6D6', accent: '#C8553D' };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- the drawing in millimetres

/** Bounding box of the drawing in circle units (points, plus half the line width). */
function artBox(geom) {
  const d = geom.data, n = geom.n;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0, o = 0; i < n; i++, o += STRIDE) {
    const h = d[o + 2] / 2;
    if (d[o] - h < x0) x0 = d[o] - h; if (d[o] + h > x1) x1 = d[o] + h;
    if (d[o + 1] - h < y0) y0 = d[o + 1] - h; if (d[o + 1] + h > y1) y1 = d[o + 1] + h;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/**
 * Map the drawing into the rectangle [rx0, rx1] x [ry0, ry1] mm (Y up), keeping its aspect.
 * Returns { k (mm per circle unit), X(x), Y(y), mmW(w) }.
 */
function fitArt(geom, rx0, ry0, rx1, ry1, { mirror = false } = {}) {
  const b = artBox(geom);
  const k = Math.min((rx1 - rx0) / b.w, (ry1 - ry0) / b.h);
  const ox = rx0 + ((rx1 - rx0) - b.w * k) / 2, oy = ry0 + ((ry1 - ry0) - b.h * k) / 2;
  const cxm = (rx0 + rx1) / 2;
  return {
    k, box: b,
    X: x => { const v = ox + (x - b.x0) * k; return mirror ? 2 * cxm - v : v; },
    Y: y => oy + (b.y1 - y) * k,
    artW: b.w * k, artH: b.h * k,
  };
}

/** What kind of drawing: 'spiral' (Artistic spiral), 'real', 'lineart' or the free path name. */
function kindOf(geom) {
  if (geom.real) return 'real';
  if (geom.lineart || geom.path === 'lineart') return 'lineart';
  return geom.path || 'spiral';
}

/** Line widths along the drawing at scale k (mm): median and 10th percentile, over the drawn length. */
function widthStats(geom, k) {
  const d = geom.data, n = geom.n, ws = [];
  const step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += step) ws.push(d[i * STRIDE + 2] * k);
  ws.sort((a, b) => a - b);
  return { p10: ws[Math.floor(ws.length * 0.1)], med: ws[Math.floor(ws.length / 2)], max: ws[ws.length - 1] };
}

/**
 * Paint the drawing into mask m with capsules. width(wMm, i) -> printed width in mm.
 * Points closer than minStep mm to the last painted one are merged.
 */
function paintLine(m, geom, F, width, { minStep = 0.08, from = 0, to = geom.n } = {}) {
  const d = geom.data;
  let px = F.X(d[from * STRIDE]), py = F.Y(d[from * STRIDE + 1]), pr = width(d[from * STRIDE + 2] * F.k, from) / 2;
  K.paintCapsule(m, px, py, pr, px, py, pr);
  for (let i = from + 1; i < to; i++) {
    const o = i * STRIDE;
    const x = F.X(d[o]), y = F.Y(d[o + 1]);
    if (Math.hypot(x - px, y - py) < minStep && i < to - 1) continue;
    const r = width(d[o + 2] * F.k, i) / 2;
    K.paintCapsule(m, px, py, pr, x, y, r);
    px = x; py = y; pr = r;
  }
}

function coverage(m, x0, y0, x1, y1) {
  // fraction of set pixels inside a mm rectangle
  const s = 1 / m.mmPerPx;
  const a = Math.max(0, Math.floor(x0 * s)), b = Math.min(m.w, Math.ceil(x1 * s));
  const c = Math.max(0, Math.floor((m.hMm - y1) * s)), e = Math.min(m.h, Math.ceil((m.hMm - y0) * s));
  let on = 0, all = 0;
  for (let y = c; y < e; y++) for (let x = a; x < b; x++) { all++; on += m.data[y * m.w + x]; }
  return all ? on / all : 0;
}

/**
 * Rebuild an Artistic spiral with fewer rings so its line and gaps print: the darkness field comes
 * from opts.field when the app passes it, else it is recovered from the tone channel of the
 * geometry (every point carries the darkness it was drawn for).
 */
function printableSpiral(geom, artDiamMm, field, pitchMm = 2.2) {
  const Rmm = artDiamMm / 2;
  const rings = clamp(Math.round(Rmm / pitchMm), 8, 120);
  const pitch = Rmm / rings;
  const hairline = RULES.minWidthMm / pitch, weight = (pitch - RULES.minGapMm - 0.05) / pitch;
  const f = field || toneField(geom);
  const g = buildSpiral(f, { technique: 'thickness', rings, weight, hairline, wobble: 0.1, edgeFade: 1.5,
    direction: geom.direction || 'cw', start: 'center', seed: 1 });
  return { geom: g, rings, pitch };
}

/** Darkness field (G x G over the circle square) splatted from the tone channel of a geometry. */
export function toneField(geom, G = 192) {
  const sum = new Float32Array(G * G), cnt = new Float32Array(G * G);
  const d = geom.data;
  for (let i = 0, o = 0; i < geom.n; i++, o += STRIDE) {
    const gx = Math.floor((d[o] + 1) * 0.5 * G), gy = Math.floor((d[o + 1] + 1) * 0.5 * G);
    if (gx < 0 || gy < 0 || gx >= G || gy >= G) continue;
    sum[gy * G + gx] += d[o + 4]; cnt[gy * G + gx] += 1;
  }
  // normalised box blur, growing until every cell inside the circle has a sample
  const D = new Float32Array(G * G);
  for (let r = 1; r <= 8; r *= 2) {
    let missing = 0;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      let s = 0, c = 0;
      for (let v = Math.max(0, y - r); v <= Math.min(G - 1, y + r); v++) for (let u = Math.max(0, x - r); u <= Math.min(G - 1, x + r); u++) { s += sum[v * G + u]; c += cnt[v * G + u]; }
      if (c > 0) D[y * G + x] = s / c;
      else if (((x + 0.5) / G * 2 - 1) ** 2 + ((y + 0.5) / G * 2 - 1) ** 2 < 0.9) missing++;
    }
    if (!missing) break;
  }
  // stretch the levels (2nd..98th percentile of the drawn cells) so fewer, fatter rings keep the contrast
  const vals = [];
  for (let i = 0; i < G * G; i++) if (cnt[i] > 0) vals.push(D[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)] ?? 0, hi = vals[Math.floor(vals.length * 0.98)] ?? 1;
  if (hi - lo > 0.05) for (let i = 0; i < G * G; i++) D[i] = clamp((D[i] - lo) / (hi - lo), 0, 1);
  return { G, D, rgb: null, raster: null };
}

// ---------------------------------------------------------------- shared parts

/**
 * The stamp plate as ONE closed solid: `outer` prism Z 0..plateT with a pocket from below in the
 * shape of the convex `slot` ring (CW), slotD deep. Built from two prisms whose touching caps are
 * dropped, welded on exact positions, plus a downward-facing roof over the pocket.
 */
function stampPlateSolid(outer, slot, slotD, plateT) {
  if (!slot) return K.extrudePolygons([{ outer, holes: [] }], 0, plateT);
  const lo = K.extrudePolygons([{ outer, holes: [slot] }], 0, slotD);
  const hi = K.extrudePolygons([{ outer, holes: [] }], slotD, plateT);
  const P = [], T = [], key = new Map(), f = Math.fround;
  const vid = (x, y, z) => {
    const k = f(x) + ',' + f(y) + ',' + f(z);
    let i = key.get(k);
    if (i === undefined) { i = P.length / 3; P.push(x, y, z); key.set(k, i); }
    return i;
  };
  const zc = f(slotD);
  const add = m => {
    const p = m.positions, t = m.indices;
    for (let i = 0; i < t.length; i += 3) {
      const a = 3 * t[i], b = 3 * t[i + 1], c = 3 * t[i + 2];
      if (f(p[a + 2]) === zc && f(p[b + 2]) === zc && f(p[c + 2]) === zc) continue;   // the touching caps
      T.push(vid(p[a], p[a + 1], p[a + 2]), vid(p[b], p[b + 1], p[b + 2]), vid(p[c], p[c + 1], p[c + 2]));
    }
  };
  add(lo); add(hi);
  const n = slot.length / 2, ids = [];
  for (let k = 0; k < n; k++) ids.push(vid(slot[2 * k], slot[2 * k + 1], slotD));
  for (let k = 1; k < n - 1; k++) T.push(ids[0], ids[k], ids[k + 1]);   // CW from above = facing down
  return { positions: new Float32Array(P), indices: new Uint32Array(T) };
}

/** A slotted foot (printed lying flat: its side profile is the footprint, `thick` mm tall). */
function standFoot(x0, y0, slotW, { lean = 12, depth = 12, len = 64, height = 26, thick = 12 } = {}) {
  const a = lean * Math.PI / 180, hx = slotW / 2 / Math.cos(a);   // horizontal half width of the leaning slot
  const bx = 22, by = height - depth, tx = bx + depth * Math.tan(a), ty = height;
  const ring = [0, 0, len, 0, len, 5, tx + hx + 5, height, tx + hx, ty, bx + hx, by,
    bx - hx, by, tx - hx, ty, tx - hx - 4, height, 0, 9];
  const outer = K.ccw(ring.map((v, i) => i % 2 ? v + y0 : v + x0));
  return K.extrudePolygons([{ outer, holes: [] }], 0, thick);
}

function sizeOf(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const b = K.bounds(p.mesh);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.lo[k]); hi[k] = Math.max(hi[k], b.hi[k]); }
  }
  return { lo, hi };
}

/** Shift every part so the layout starts at X 0, Y 0, Z 0; report sizes as [0, extent]. */
function place(parts) {
  const { lo, hi } = sizeOf(parts);
  const out = parts.map(p => ({ ...p, mesh: K.transform(p.mesh, (x, y, z, o) => { o[0] = x - lo[0]; o[1] = y - lo[1]; o[2] = z - lo[2]; }) }));
  return { parts: out, sizeMm: { x: [0, r1(hi[0] - lo[0])], y: [0, r1(hi[1] - lo[1])], z: [0, r2(hi[2] - lo[2])] } };
}

function finish(id, built, notes, settings, stats = {}, extras = {}) {
  const { parts, sizeMm } = place(built);
  const checks = parts.map(p => ({ name: p.name, ...K.checkManifold(p.mesh) }));
  const bad = checks.filter(c => !c.ok);
  if (bad.length) notes.push(`!Mesh check failed for ${bad.map(b => `${b.name} (${b.openEdges} open, ${b.nonManifold} non-manifold edges)`).join(', ')}.`);
  const fits = sizeMm.x[1] <= PRINTER.bed.x && sizeMm.y[1] <= PRINTER.bed.y && sizeMm.z[1] <= PRINTER.bed.z;
  const fitsBed = p => { const b = K.bounds(p.mesh); return b.hi[0] - b.lo[0] <= PRINTER.bed.x && b.hi[1] - b.lo[1] <= PRINTER.bed.y && b.hi[2] - b.lo[2] <= PRINTER.bed.z; };
  const tooBig = parts.filter(p => !fitsBed(p));
  if (!fits && !tooBig.length) notes.push(`The parts do not fit on one ${PRINTER.name} plate together (X 0-${PRINTER.bed.x}, Y 0-${PRINTER.bed.y} mm): print ${parts.slice(-1)[0].name.replace(/ \d+$/, '')} parts on a second plate.`);
  else if (!fits) notes.push(`!Too big for the ${PRINTER.name} bed (X 0-${PRINTER.bed.x}, Y 0-${PRINTER.bed.y}, Z 0-${PRINTER.bed.z} mm): ${tooBig.map(p => p.name).join(', ')}.`);
  const blocking = notes.filter(n => n.startsWith('!')).map(n => n.slice(1));
  return {
    id, parts, sizeMm,
    // notes: everything the user should know; issues: the ones that make it not printable as is
    printability: { ok: !bad.length && !tooBig.length && !blocking.length, onePlate: fits, notes: notes.map(n => n.replace(/^!/, '')), issues: blocking },
    settings: { layer: PRINTER.layer, nozzle: PRINTER.nozzle, supports: false, ...settings },
    extras,
    stats: { ...stats, partsMm: parts.map(p => { const b = K.bounds(p.mesh); return { name: p.name, x: r1(b.hi[0] - b.lo[0]), y: r1(b.hi[1] - b.lo[1]), z: r2(b.hi[2] - b.lo[2]) }; }), triangles: checks.reduce((s, c) => s + c.triangles, 0), manifold: checks.map(c => ({ name: c.name, ok: c.ok, volumeMm3: Math.round(c.volume) })) },
  };
}

function solidFromMask(m, z0, z1, eps = 0.03) {
  K.fixDiagonals(m);
  const polys = K.contours(m, eps);
  return { mesh: K.extrudePolygons(polys, z0, z1), polys };
}

// ---------------------------------------------------------------- A: relief plaque

function buildPlaque(geom, o) {
  const size = o.sizeMm ?? 150, base = o.baseMm ?? 2.4, raise = Math.max(RULES.minRaiseMm, o.raiseMm ?? 1.2);
  const frame = o.frameMm ?? 5, corner = o.cornerMm ?? 6, margin = o.marginMm ?? 4;
  const notes = [];
  const kind = kindOf(geom);
  const b = artBox(geom);
  // plate: square for the round Artistic drawings, else the drawing's aspect plus the border
  const inner = size - 2 * (frame + margin);
  const aspect = b.w / b.h;
  let W = size, H = size;
  if (kind === 'real' || kind === 'lineart' || geom.shape === 'square') {
    if (aspect > 1) H = r1(inner / aspect + 2 * (frame + margin)); else W = r1(inner * aspect + 2 * (frame + margin));
  }
  let g = geom, rebuilt = null;
  if (kind === 'spiral') {
    const k0 = inner / b.w;
    const pitch0 = (geom.rings ? 1 / geom.rings : 0.02) * k0 * (b.w / 2);
    rebuilt = printableSpiral(geom, inner, o.field, o.pitchMm ?? 2.2);
    g = rebuilt.geom;
    notes.push(`Spiral rebuilt with ${rebuilt.rings} rings (the drawing has ${Math.round(geom.rings || geom.turns || 0)}): at ${r1(inner)} mm its rings were ${r2(pitch0)} mm apart, too close for a ${RULES.minWidthMm} mm line and a ${RULES.minGapMm} mm gap. Now ${r2(rebuilt.pitch)} mm apart, line ${RULES.minWidthMm}-${r2(rebuilt.pitch - RULES.minGapMm - 0.05)} mm.`);
  }
  const F = fitArt(g, frame + margin, frame + margin, W - frame - margin, H - frame - margin);
  const ws = widthStats(g, F.k);
  const px = o.pxPerMm ?? (Math.max(W, H) > 200 ? 6 : 10);
  const m = K.blankMask(W, H, px);
  let thick = 0, total = 0;
  paintLine(m, g, F, (w) => { total++; if (w < RULES.minWidthMm) { thick++; return RULES.minWidthMm; } return w; });
  const artCov0 = coverage(m, frame + margin, frame + margin, W - frame - margin, H - frame - margin);
  const closed = K.closeMask(m, RULES.minGapMm / 2);
  const artCov = coverage(closed, frame + margin, frame + margin, W - frame - margin, H - frame - margin);
  // frame into the same mask so lines that touch it fuse
  K.paintRings(closed, [K.roundRect(0.2, 0.2, W - 0.2, H - 0.2, corner - 0.2), K.roundRect(frame, frame, W - frame, H - frame, Math.max(1, corner - frame))], 1);
  const relief = solidFromMask(closed, base, base + raise);
  // plate with two hanging holes (nail heads 4 mm) under the top frame, when asked
  const holes = [];
  if (o.hang === 'holes') for (const fx of [0.25, 0.75]) holes.push(K.circleRing(W * fx, H - frame / 2, 1.6, 20, true));
  const plate = K.extrudePolygons([{ outer: K.roundRect(0, 0, W, H, corner), holes }], 0, base);
  const parts = [
    { name: 'Plate', mesh: plate, color: o.plateColor || COLORS.paper },
    { name: 'Line', mesh: relief.mesh, color: o.lineColor || COLORS.ink },
  ];
  if ((o.stand ?? true) && o.hang !== 'holes') {
    const slot = base + raise + 0.4;
    // the feet grow with the plaque (a 300 mm plaque leaning back 12 degrees needs a longer tail)
    const footLen = Math.max(64, Math.round(0.3 * Math.max(W, H))), footDepth = Math.max(12, Math.round(0.06 * H));
    for (let k = 0; k < 2; k++) parts.push({ name: `Stand ${k + 1}`, mesh: standFoot(W + 8, k * 30, slot, { thick: 10, len: footLen, depth: footDepth, height: footDepth + 14 }), color: o.plateColor || COLORS.paper });
  }
  if (thick / Math.max(1, total) > 0.02) notes.push(`${Math.round(100 * thick / total)}% of the line was thinner than ${RULES.minWidthMm} mm at this size and was thickened to ${RULES.minWidthMm} mm.`);
  if (artCov - artCov0 > 0.01) notes.push(`Gaps under ${RULES.minGapMm} mm were closed: ${r1(100 * (artCov - artCov0))}% of the picture area merged.`);
  if (artCov > 0.62) {
    const grow = RULES.minWidthMm / Math.max(0.05, ws.med);
    notes.push(`!The line covers ${Math.round(artCov * 100)}% of the picture: at ${W} mm the detail fuses into a solid area. Print at least ${Math.min(PRINTER.bed.x, Math.round(size * Math.max(1.3, grow)))} mm wide, or choose the lithophane.`);
  }
  notes.push(`Swap filament after the plate: pause at Z ${base} mm (layer ${Math.round(base / PRINTER.layer)} done), or print the Line part with a second AMS slot.`);
  if (parts.length > 2) notes.push(`Two slotted feet (10 mm thick, printed flat, ${Math.max(64, Math.round(0.3 * Math.max(W, H)))} mm long) hold the plaque leaning back 12 degrees.`);
  if (o.hang === 'holes') notes.push('Two 3.2 mm holes under the top frame take small nails.');
  return finish('plaque', parts, notes, { colorChangeAtMm: base, walls: 2, infill: '15%', note: 'Plate and Line are one object with two parts: give Line the dark filament.' },
    { artCoverage: r2(artCov), lineMm: { p10: r2(ws.p10), median: r2(ws.med), max: r2(ws.max) }, rings: rebuilt?.rings ?? null, polygons: relief.polys.length });
}

// ---------------------------------------------------------------- B: wire sculpture

function buildWire(geom, o) {
  const size = o.sizeMm ?? 180;
  // above 200 mm a thin strand sags and twists when it hangs: grow it to 1.5x wide, 1.25x tall at 300 mm
  const grow = Math.max(0, (size - 200) / 100);
  const lw = Math.max(RULES.minWidthMm, r1((o.lineMm ?? 1.6) * (1 + 0.5 * grow))), lh = Math.max(RULES.minRaiseMm, r1((o.heightMm ?? 2.4) * (1 + 0.25 * grow)));
  const notes = [];
  if (grow > 0) notes.push(`At ${size} mm the wire is ${lw} x ${lh} mm (thicker than at small sizes) so it holds its shape.`);
  const kind = kindOf(geom);
  const pad = 8;
  const b = artBox(geom);
  const W = b.w >= b.h ? size : size * b.w / b.h, H = b.h >= b.w ? size : size * b.h / b.w;
  const F = fitArt(geom, pad, pad, W + pad, H + pad);
  const m = K.blankMask(W + 2 * pad, H + 2 * pad, o.pxPerMm ?? 10);
  paintLine(m, geom, F, () => lw, { minStep: 0.15 });
  // hanging loop at the start of the line (or at the top when the start is deep inside)
  const d = geom.data;
  let sx = F.X(d[0]), sy = F.Y(d[1]);
  const edgeDist = Math.min(sx - pad, W + pad - sx, sy - pad, H + pad - sy);
  let where = 'start of the line';
  if (edgeDist > 0.12 * Math.max(W, H) && o.loopAt !== 'start') {
    let best = -Infinity, bi = 0;
    for (let i = 0; i < geom.n; i++) { const y = d[i * STRIDE + 1]; if (-y > best) { best = -y; bi = i; } }
    sx = F.X(d[bi * STRIDE]); sy = F.Y(d[bi * STRIDE + 1]); where = 'top of the drawing (the line starts inside the picture)';
  }
  const loopR = o.loopMm ?? 3.2, ring = 1.6;
  const lx = sx, ly = sy + loopR + ring * 0.6;
  K.paintCapsule(m, lx, ly, loopR + ring, lx, ly, loopR + ring, 1);
  K.paintCapsule(m, lx, ly, loopR, lx, ly, loopR, 0);
  // standing: a straight base line under the drawing, fused to its lowest points and reaching past
  // the centre of mass both ways, so the piece sits in the stand's slot instead of on one line end
  let bar = null;
  if (o.stand) {
    let yMin = Infinity, sumX = 0;
    const X = [], Y = [];
    for (let i = 0; i < geom.n; i++) { const x = F.X(d[i * STRIDE]), y = F.Y(d[i * STRIDE + 1]); X.push(x); Y.push(y); sumX += x; if (y < yMin) yMin = y; }
    const com = sumX / Math.max(1, X.length);
    let c0 = Infinity, c1 = -Infinity;
    for (let i = 0; i < X.length; i++) if (Y[i] < yMin + 2.5) { c0 = Math.min(c0, X[i]); c1 = Math.max(c1, X[i]); }
    const x0 = Math.max(pad, Math.min(c0, com - 0.25 * W)), x1 = Math.min(W + pad, Math.max(c1, com + 0.25 * W));
    const bw = Math.max(lw, 2), by = yMin - lw / 2 - bw / 2 + 0.3;
    K.paintCapsule(m, x0, by, bw / 2, x1, by, bw / 2, 1);
    bar = { x0: r1(x0 - pad), x1: r1(x1 - pad), len: x1 - x0, com: r1(com - pad) };
  }
  const closed = K.closeMask(m, RULES.minGapMm / 2);
  const solid = solidFromMask(closed, 0, lh, 0.04);
  const pieces = solid.polys.length;
  const parts = [{ name: 'Wire', mesh: solid.mesh, color: o.color || COLORS.ink }];
  if (pieces > 1) notes.push(`!The line prints as ${pieces} separate pieces (a glide thinner than the gap closed off); join them before printing.`);
  const holes = solid.polys.reduce((s, p) => s + p.holes.length, 0);
  notes.push(`One piece, ${lw} mm wide and ${lh} mm tall, lying flat; where the line crosses or runs within ${RULES.minGapMm} mm of itself it fuses (${holes} enclosed openings).`);
  notes.push(`Hanging loop (${r1(2 * loopR)} mm hole) at the ${where}.`);
  if (kind === 'spiral' || kind === 'real') notes.push('!Dense drawings fuse into a solid disc as wire: this product is meant for Line art and Contour drawings.');
  if (o.stand) {
    // U-channel base: profile in X-Z, extruded along Y, printed standing on its flat bottom
    const L = Math.round(bar.len + 10), sw = lh + 0.3, bw = 18, bh = 9, sd = 5;
    const prof = [0, 0, bw, 0, bw, bh, (bw + sw) / 2, bh, (bw + sw) / 2, bh - sd, (bw - sw) / 2, bh - sd, (bw - sw) / 2, bh, 0, bh];
    let base = K.extrudePolygons([{ outer: K.ccw(prof), holes: [] }], 0, L);
    base = K.transform(base, (x, y, z, out) => { out[0] = x + W + 2 * pad + 6; out[1] = z; out[2] = y; });
    base = K.flip(base);
    parts.push({ name: 'Stand', mesh: base, color: o.color || COLORS.ink });
    notes.push(`Standing: a straight base line (X ${bar.x0}-${bar.x1} mm of the drawing) joins its lowest points and runs past its centre of mass (X ${bar.com} mm), and sits in a ${L} mm stand with a ${r2(sw)} mm slot ${sd} mm deep.`);
  }
  return finish('wire', parts, notes, { walls: 2, infill: '100%', note: 'Solid infill: the wire is only two perimeters wide.' }, { pieces, openings: holes });
}

// ---------------------------------------------------------------- C: lithophane

function buildLitho(geom, o) {
  const size = o.sizeMm ?? 100, tMin = o.minMm ?? 0.8, tMax = o.maxMm ?? 3.2, frame = o.frameMm ?? 1.5;
  const px = o.cellMm ?? 0.25;           // lithophane cell: finer than the nozzle is pointless
  const stand = (o.orient ?? 'standing') === 'standing';
  const notes = [];
  const kind = kindOf(geom);
  const b = artBox(geom);
  let g = geom;
  const W = b.w >= b.h ? size : size * b.w / b.h, H = b.h >= b.w ? size : size * b.h / b.w;
  // render the art at 0.1 mm with its true widths (hairlines kept at 0.3 mm so they still read)
  const hi = K.blankMask(W, H, 10);
  const footMm = stand ? (o.footMm ?? 6) : 0;
  const footDepth = o.footDepthMm ?? Math.max(14, Math.round(0.15 * H));   // tall panels need a deeper foot
  const F = fitArt(g, frame + 1, frame + 1 + footMm, W - frame - 1, H - frame - 1);
  let fine = 0, tot = 0;
  paintLine(hi, g, F, w => { tot++; if (w < 0.3) { fine++; return 0.3; } return w; }, { minStep: 0.05 });
  // average down to lithophane cells, then a light blur (the nozzle cannot draw finer)
  const cw = Math.round(W / px) + 1, ch = Math.round(H / px) + 1;
  const dark = new Float32Array(cw * ch);
  const s = px * 10;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let on = 0, all = 0;
    const x0 = Math.floor((x - 0.5) * s), x1 = Math.ceil((x + 0.5) * s), y0 = Math.floor((y - 0.5) * s), y1 = Math.ceil((y + 0.5) * s);
    for (let v = Math.max(0, y0); v < Math.min(hi.h, y1); v++) for (let u = Math.max(0, x0); u < Math.min(hi.w, x1); u++) { all++; on += hi.data[v * hi.w + u]; }
    dark[y * cw + x] = all ? on / all : 0;
  }
  // dense drawings (spiral rings, plotter fills) are read as tone: average over about two line
  // spacings so the rings do not beat against the cells (moire); outline drawings keep sharp lines
  const dense = kind === 'spiral' || kind === 'real' || kind === 'wander' || kind === 'maze';
  const rad = dense ? Math.max(1, Math.round((o.toneMm ?? 0.9) / px)) : 1;
  const blurred = new Float32Array(dark.length);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let sum = 0, c = 0;
    for (let v = -rad; v <= rad; v++) for (let u = -rad; u <= rad; u++) {
      const yy = y + v, xx = x + u; if (yy < 0 || xx < 0 || yy >= ch || xx >= cw) continue;
      const d2 = (u * u + v * v) / (rad * rad);
      if (d2 > 1.3) continue;
      const wgt = Math.exp(-2 * d2); sum += dark[yy * cw + xx] * wgt; c += wgt;
    }
    blurred[y * cw + x] = sum / c;
  }
  if (kind === 'spiral' || kind === 'maze') {
    // regular rings beat against any raster (moire): take the darkness the rings encode instead,
    // from the tone channel of the line (what the width modulation draws)
    const tf = o.field || toneField(geom);
    const G = tf.G;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const Xmm = x * px, Ymm = (ch - 1 - y) * px;
      const cx = (Xmm - (F.X(0) )) / F.k, cy = -(Ymm - F.Y(0)) / F.k;     // circle units (y down)
      const inside = cx * cx + cy * cy <= 1;
      if (!inside) { blurred[y * cw + x] = 0; continue; }
      const gx = clamp((cx + 1) * 0.5 * G - 0.5, 0, G - 1), gy = clamp((cy + 1) * 0.5 * G - 0.5, 0, G - 1);
      const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(G - 1, x0 + 1), y1 = Math.min(G - 1, y0 + 1), fx = gx - x0, fy = gy - y0;
      const D = tf.D;
      blurred[y * cw + x] = (D[y0 * G + x0] * (1 - fx) + D[y0 * G + x1] * fx) * (1 - fy) + (D[y1 * G + x0] * (1 - fx) + D[y1 * G + x1] * fx) * fy;
    }
    notes.push('The spiral\'s rings are too fine to print one by one at this size, so the panel follows the darkness they draw (the photo\'s tone), not the rings.');
  }
  if (dense) {
    // stretch the tone (2nd..99th percentile inside the art) to the full thickness range
    const vals = Array.from(blurred).filter(v => v > 0.02).sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.02)] ?? 0, hi = vals[Math.floor(vals.length * 0.99)] ?? 1;
    if (hi - lo > 0.05) for (let i = 0; i < blurred.length; i++) blurred[i] = blurred[i] > 0.02 ? clamp((blurred[i] - lo) / (hi - lo), 0, 1) : 0;
  }
  // thickness: darker = thicker (it lets less light through); frame at full + 0.8 mm
  const fcells = Math.round(frame / px), foot = stand ? Math.round((o.footMm ?? 6) / px) : 0;
  const T = new Float32Array(cw * ch);
  const gamma = o.gamma ?? 0.8;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const inFrame = x < fcells || y < fcells || x >= cw - fcells || y >= ch - fcells;
    let t = inFrame ? tMax + 0.8 : tMin + (tMax - tMin) * Math.pow(clamp(blurred[y * cw + x], 0, 1), gamma);
    if (stand && y >= ch - foot) t = footDepth;                               // bottom rows: the foot
    T[y * cw + x] = t;
  }
  let mesh = K.heightfieldMesh(T, cw, ch, px, v => v);
  let fineFrac = fine / Math.max(1, tot);
  if (stand) {
    // stand the panel up: panel Y (up the picture) -> Z, thickness Z -> -Y (relief faces you)
    mesh = K.transform(mesh, (x, y, z, out) => { out[0] = x; out[1] = -z; out[2] = y; });
    notes.push(`Printed standing: best detail (the thickness steps are drawn by the nozzle sideways). A ${footDepth} mm deep foot along the bottom ${o.footMm ?? 6} mm keeps it upright (${r1(H / footDepth)}:1 tall to deep); the 3MF adds a 5 mm brim.`);
  } else notes.push('Printed flat, relief up: simplest, but the thickness steps are layers (0.2 mm), so tones are coarser than standing.');
  notes.push(`Thickness ${tMin}-${tMax} mm from the drawing\'s darkness in ${px} mm cells, ${frame} mm frame ${tMax + 0.8} mm thick. Print in white (or natural) at 100% infill so the light is even.`);
  if (kind === 'spiral' || kind === 'real' || kind === 'wander') {
    const k = F.k; const ws = widthStats(g, k);
    if (ws.med < 0.6) notes.push(`The line is ${r2(ws.med)} mm wide at this size: finer than the nozzle, so it reads as tone (like the photo), not as separate lines.`);
  }
  if (fineFrac > 0.05) notes.push(`${Math.round(fineFrac * 100)}% of the line was a hairline, drawn at 0.3 mm so it still shows.`);
  return finish('litho', [{ name: 'Lithophane', mesh, color: o.color || COLORS.white }], notes,
    { walls: 2, infill: '100%', orientation: stand ? 'standing' : 'flat', note: 'Wall loops high enough that the panel is solid; 0.12-0.16 mm layers give finer tones standing up.' },
    { cells: [cw, ch] }, { backlit: backlit(T, cw, ch, stand ? ch - foot : ch) });
}

/** Light through the panel (white PETG, about 1.1 per mm), 0..1, rows above the foot only. */
function backlit(T, w, h, rows) {
  const data = new Float32Array(w * rows);
  for (let i = 0; i < w * rows; i++) data[i] = Math.exp(-1.1 * (T[i] - 0.8));
  return { w, h: rows, data };
}

// ---------------------------------------------------------------- D: cookie cutter + stamp

/** Deepest cut (mm) the outline's rounding may take off the subject before the cutter says it lost
 *  a thin part: a sharp ear tip rounded at 1.5 mm loses about 2 mm, a whole ear 5 mm or more. */
const CUT_LOST_MM = 3;
const CUT_LOST_SHARE = 0.008;   // share of the subject's area that must go before the loss counts

/** The subject's outline in mm (ccw ring): features.silhouette when present, else the drawing's closed outer boundary. */
function silhouetteRing(geom, F, W, H, pad, closeMm, given, wallHalf = 1.2) {
  // Line art's features.silhouette: { outlines: [Float32Array closed polylines in frame fractions
  // 0..1, largest first], standin? } (js/lineart/silhouette.js); circle units = fraction * 2 - 1.
  // A plain array of circle-unit points is accepted too.
  const S = given || geom.features?.silhouette || geom.lineart?.silhouette;
  const pts = S?.outlines?.[0] ? Array.from(S.outlines[0], v => v * 2 - 1)
    : (S && S.length >= 6) ? (Array.isArray(S[0]) ? S.flat() : Array.from(S)) : null;
  if (pts && pts.length >= 6) {
    const ring = [];
    for (let i = 0; i < pts.length; i += 2) ring.push(F.X(pts[i]), F.Y(pts[i + 1]));
    const source = S?.standin ? 'the stand-in silhouette of the line art' : 'the subject silhouette';
    // round the outline's corners and necks (close, then open) so the wall can follow every turn
    // without folding into itself: the smallest radius whose wall offsets stay clean, 3 mm at most
    // (1.5 mm keeps a cat's ears at 90 mm; 3 mm shaved them off); the raw ring when that loses the shape
    const ex = 8, rm = K.blankMask(W + 2 * pad + 2 * ex, H + 2 * pad + 2 * ex, 4);
    K.paintRings(rm, [ring.map(v => v + ex)], 1);
    let raw = 0; for (let i = 0; i < rm.data.length; i++) raw += rm.data[i];
    let pick = null;
    for (const r of [1.5, 2, 3]) {
      const rc = K.openMask(K.closeMask(rm, r), r);
      K.fixDiagonals(rc);
      let best = null, ba = 0;
      for (const p of K.contours(rc, 0.15)) { const a = Math.abs(K.ringArea(p.outer)); if (a > ba) { ba = a; best = p.outer; } }
      if (!best || ba < 0.8 * Math.abs(K.ringArea(ring))) continue;
      const cand = K.ccw(best.map(v => v - ex)), sm = K.ccw(smoothRing(cand, 0.6, 3, 2));
      pick = { r, rc, ring: cand };
      if (!(selfCrossings(offsetRing(sm, -wallHalf)) + selfCrossings(offsetRing(sm, wallHalf)))) break;
    }
    if (pick) {
      // what the rounding cut off the subject: its share of the shape, and the deepest cut (an ear
      // or a tail narrower than twice the radius goes whole: a cut as deep as it is long)
      const dIn = K.distanceTo(pick.rc, 1);
      let lost = 0, depth = 0;
      for (let i = 0; i < rm.data.length; i++) if (rm.data[i] && !pick.rc.data[i]) { lost++; if (dIn[i] > depth) depth = dIn[i]; }
      return { ring: pick.ring, source: source + `, corners rounded to ${pick.r} mm`, roundMm: pick.r, lostShare: lost / Math.max(1, raw), cutMm: depth * rm.mmPerPx };
    }
    return { ring: K.ccw(ring), source, roundMm: 0, lostShare: 0, cutMm: 0 };
  }
  // the mask reaches closeMm past the drawing so the closing is not cut off at its border
  const extra = closeMm + 4;
  const m = K.blankMask(W + 2 * pad + 2 * extra, H + 2 * pad + 2 * extra, 4);
  const Fe = { ...F, X: x => F.X(x) + extra, Y: y => F.Y(y) + extra };
  paintLine(m, geom, Fe, () => 1.2, { minStep: 0.3 });
  // close the big gaps (a concave hull), fill it, then open by 3 mm so every convex corner is round
  const c = K.openMask(K.fillHoles(K.closeMask(m, closeMm)), 3);
  K.fixDiagonals(c);
  const back = r => r.map((v, i) => v - extra);
  const polys = K.contours(c, 0.15);
  let best = null, ba = 0;
  for (const p of polys) { const a = Math.abs(K.ringArea(p.outer)); if (a > ba) { ba = a; best = p.outer; } }
  return { ring: best && back(best), source: 'a stand-in outline (the drawing\'s outer boundary, closed over ' + closeMm + ' mm gaps)' };
}

/** Evenly resample a closed ring every `step` mm and smooth it (moving average, `win` each side). */
function smoothRing(r, step = 0.6, win = 3, passes = 2) {
  const n = r.length / 2, out = [];
  let acc = 0;
  out.push(r[0], r[1]);
  for (let i = 0; i < n; i++) {
    const ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * ((i + 1) % n)], by = r[2 * ((i + 1) % n) + 1];
    const L = Math.hypot(bx - ax, by - ay);
    let t = step - acc;
    while (t <= L) { out.push(ax + (bx - ax) * t / L, ay + (by - ay) * t / L); t += step; }
    acc = L - (t - step);
  }
  out.length -= 2;
  let cur = out;
  for (let p = 0; p < passes; p++) {
    const m = cur.length / 2, nx = new Array(cur.length);
    for (let i = 0; i < m; i++) {
      let sx = 0, sy = 0;
      for (let k = -win; k <= win; k++) { const j = (i + k + m) % m; sx += cur[2 * j]; sy += cur[2 * j + 1]; }
      nx[2 * i] = sx / (2 * win + 1); nx[2 * i + 1] = sy / (2 * win + 1);
    }
    cur = nx;
  }
  return cur;
}

/** Offset a ccw ring along its vertex normals by d mm (positive = outward). */
function offsetRing(r, d) {
  const n = r.length / 2, out = new Array(r.length);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    let tx = r[2 * b] - r[2 * a], ty = r[2 * b + 1] - r[2 * a + 1];
    const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    out[2 * i] = r[2 * i] + ty * d; out[2 * i + 1] = r[2 * i + 1] - tx * d;
  }
  return out;
}

/** Number of crossing edge pairs in a closed ring (a grid-bucketed check). */
function selfCrossings(r) {
  const n = r.length / 2, cell = 3, grid = new Map();
  const key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = Math.min(r[2 * i], r[2 * j]), x1 = Math.max(r[2 * i], r[2 * j]), y0 = Math.min(r[2 * i + 1], r[2 * j + 1]), y1 = Math.max(r[2 * i + 1], r[2 * j + 1]);
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
      const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
  }
  const seen = new Set(); let hits = 0;
  const cross = (i, j) => {
    const i2 = (i + 1) % n, j2 = (j + 1) % n;
    if (i === j || i2 === j || j2 === i) return false;
    const [ax, ay, bx, by, cx, cy, dx, dy] = [r[2 * i], r[2 * i + 1], r[2 * i2], r[2 * i2 + 1], r[2 * j], r[2 * j + 1], r[2 * j2], r[2 * j2 + 1]];
    const o = (px, py, qx, qy, sx, sy) => Math.sign((qx - px) * (sy - py) - (qy - py) * (sx - px));
    return o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by);
  };
  for (const list of grid.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    const i = Math.min(list[a], list[b]), j = Math.max(list[a], list[b]); const k = i * n + j;
    if (seen.has(k)) continue; seen.add(k);
    if (cross(i, j)) hits++;
  }
  return hits;
}

function buildCutter(geom, o) {
  const size = o.sizeMm ?? 90, wallH = o.wallMm ?? 12, edge = o.edgeMm ?? 0.8, baseW = o.wallBaseMm ?? 2.4;
  const flangeW = o.flangeMm ?? 4, flangeH = o.flangeHMm ?? 1.2, closeMm = o.closeMm ?? Math.max(8, r1(size * 0.14));
  const plateT = o.stampPlateMm ?? 4.5, reliefH = o.stampReliefMm ?? 2, clear = o.clearMm ?? 0.5;
  const notes = [];
  const pad = 12;
  const b = artBox(geom);
  const W = b.w >= b.h ? size : size * b.w / b.h, H = b.h >= b.w ? size : size * b.h / b.w;
  const F = fitArt(geom, pad, pad, W + pad, H + pad);
  const sil = silhouetteRing(geom, F, W, H, pad, closeMm, o.silhouette, baseW / 2);
  if (!sil.ring) throw new Error('cutter: no outline');
  const ring = K.ccw(smoothRing(sil.ring, 0.6, 3, 2));
  notes.push(`Outline from ${sil.source}.`);
  // a subject's thin parts (ears, a tail, legs) narrower than the rounding: gone from the cutter
  // (only when a real part goes, a share of the shape's area: a pointed tip, such as a bust's
  // shoulder cut by the frame, loses depth but next to no area, and a cutter without it is fine)
  if (sil.cutMm > CUT_LOST_MM && sil.lostShare > CUT_LOST_SHARE) notes.push(`!The outline loses its thin parts (ears, a tail, legs): the cutter wall cannot follow them at ${r1(o._fitMm ?? size)} mm, so up to ${r1(sil.cutMm)} mm of them was rounded off. Raise the size so they come through.`);
  else if (sil.cutMm > CUT_LOST_MM) notes.push(`Pointed tips of the outline were rounded by up to ${r1(sil.cutMm)} mm so the wall can follow them.`);
  // cutter: one profile swept round the outline (inner base edge .. flange .. crest), ccw in (offset, z)
  const hb = baseW / 2, he = edge / 2;
  const slopeAt = z => hb - (hb - he) * z / wallH;
  // the flange narrows where the outline turns too tightly for it (it would overlap itself)
  let fw = flangeW, xOut = 0;
  for (; fw >= 1.5; fw -= 0.5) { xOut = selfCrossings(offsetRing(ring, hb + fw)); if (!xOut) break; }
  if (fw < 1.5) fw = 1.5;
  if (fw < flangeW) notes.push(`Flange narrowed to ${fw} mm (a tight turn in the outline).`);
  const xIn = selfCrossings(offsetRing(ring, -hb)) + selfCrossings(offsetRing(ring, hb));
  if (xIn) notes.push(`!The outline turns tighter than the ${baseW} mm wall in ${xIn} places; raise the size.`);
  if (xOut) notes.push(`The flange still overlaps itself in ${xOut} places (slicers merge it; harmless).`);
  const profile = [[-hb, 0], [hb + fw, 0], [hb + fw, flangeH], [slopeAt(flangeH), flangeH], [he, wallH], [-he, wallH]];
  const cutter = K.sweepClosed(ring, profile);
  {
    // the size is the cutter's longest side, not the drawing's frame: rescale until it is
    const cb = K.bounds(cutter), target = o._fitMm ?? size, ext = Math.max(cb.hi[0] - cb.lo[0], cb.hi[1] - cb.lo[1]);
    if ((o._fitPass ?? 0) < 3 && Math.abs(ext - target) > 0.6 && ext > 5) return buildCutter(geom, { ...o, sizeMm: size * (target - 2 * (hb + fw)) / Math.max(1, ext - 2 * (hb + fw)), closeMm, _fitMm: target, _fitPass: (o._fitPass ?? 0) + 1 });
  }
  // stamp: the outline inset by the wall and a clearance, the lines inside mirrored (they read right in the dough)
  const inset = hb + clear;
  const sb = K.bounds({ positions: new Float32Array(ring.flatMap((v, i) => i % 2 ? [v, 0] : [v])), indices: new Uint32Array(0) });
  const shiftX = (sb.hi[0] - sb.lo[0]) + 2 * fw + 16;
  // stamp outline and relief clip from the outline's mask (a raster inset never self-intersects);
  // everything on the stamp is mirrored about the drawing's centre line
  const cx = pad + W / 2;
  const mir = r => { const o2 = []; for (let i = 0; i < r.length; i += 2) o2.push(2 * cx - r[i], r[i + 1]); return K.ccw(o2); };
  const silM = K.blankMask(W + 2 * pad, H + 2 * pad, 10);
  K.paintRings(silM, [mir(ring)], 1);
  const dOut = K.distanceTo(silM, 0);
  const insetMask = (d) => { const mm = { ...silM, data: new Uint8Array(silM.data.length) }; const t = d / silM.mmPerPx; for (let i = 0; i < dOut.length; i++) mm.data[i] = dOut[i] > t ? 1 : 0; return mm; };
  const plateMask = insetMask(inset);
  K.fixDiagonals(plateMask);
  let stampOuter = null, sa = 0;
  for (const p of K.contours(plateMask, 0.05)) { const a = Math.abs(K.ringArea(p.outer)); if (a > sa) { sa = a; stampOuter = p.outer; } }
  const clip = insetMask(inset + 1.0);
  const Fm = fitArt(geom, pad, pad, W + pad, H + pad, { mirror: true });
  const m = K.blankMask(W + 2 * pad, H + 2 * pad, 10);
  const lineW = Math.max(1.0, o.stampLineMm ?? 1.0);
  paintLine(m, geom, Fm, w => Math.max(lineW, Math.min(2.5, w)), { minStep: 0.1 });
  for (let i = 0; i < m.data.length; i++) m.data[i] = m.data[i] && clip.data[i] ? 1 : 0;
  const closed = K.closeMask(m, RULES.minGapMm / 2);
  // handle slot: a 4.3 mm pocket from underneath, 3.5 mm deep, on the stamp's longest horizontal chord
  const slotW = 4.3, slotD = 3.5;
  const sbb = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (let i = 0; i < stampOuter.length; i += 2) { sbb.x0 = Math.min(sbb.x0, stampOuter[i]); sbb.x1 = Math.max(sbb.x1, stampOuter[i]); sbb.y0 = Math.min(sbb.y0, stampOuter[i + 1]); sbb.y1 = Math.max(sbb.y1, stampOuter[i + 1]); }
  let best = { len: 0 };
  for (let f = 0.3; f <= 0.7; f += 0.02) {
    const y = sbb.y0 + (sbb.y1 - sbb.y0) * f;
    // the chord must hold at y - slotW/2 - 1.5 and y + slotW/2 + 1.5 too: intersect the three runs
    const runs = [y - slotW / 2 - 1.5, y, y + slotW / 2 + 1.5].map(yy => {
      const xs = [];
      for (let i = 0, n = stampOuter.length, j = n - 2; i < n; j = i, i += 2) {
        const y0 = stampOuter[j + 1], y1 = stampOuter[i + 1];
        if ((y0 <= yy) !== (y1 <= yy)) xs.push(stampOuter[j] + (yy - y0) * (stampOuter[i] - stampOuter[j]) / (y1 - y0));
      }
      xs.sort((a, b) => a - b);
      const out = []; for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k], xs[k + 1]]);
      return out;
    });
    for (const [a, b] of runs[1]) {
      let lo = a, hi = b;
      for (const other of [runs[0], runs[2]]) {
        const hit = other.find(([c, d]) => c < (lo + hi) / 2 && d > (lo + hi) / 2);
        if (!hit) { lo = hi; break; }
        lo = Math.max(lo, hit[0]); hi = Math.min(hi, hit[1]);
      }
      if (hi - lo > best.len) best = { len: hi - lo, cx: (lo + hi) / 2, y };
    }
  }
  const slotL = Math.min(50, (best.len - 3) * 0.8);
  const inside = slotL >= 16;
  const scx = best.cx, scy = best.y;
  const slot = K.cw([scx - slotL / 2, scy - slotW / 2, scx + slotL / 2, scy - slotW / 2, scx + slotL / 2, scy + slotW / 2, scx - slotL / 2, scy + slotW / 2]);
  // one solid plate with the slot as a pocket from below (two stacked prisms would share their rim
  // edges, which is non-manifold once the parts are merged into one STL)
  const plate = stampPlateSolid(stampOuter, inside ? slot : null, slotD, plateT);
  const relief = solidFromMask(closed, plateT, plateT + reliefH, 0.03);
  let onRelief = 0, onPlate = 0;
  for (let i = 0; i < closed.data.length; i++) { onRelief += closed.data[i]; onPlate += clip.data[i]; }
  const stampCov = onRelief / Math.max(1, onPlate);
  if (stampCov > 0.55) notes.push(`!The drawing is too dense to stamp: its lines cover ${Math.round(stampCov * 100)}% of the stamp and fuse into a flat plate. The cutter works; for the stamp choose a Line art or Contour drawing.`);
  const move = (mesh, dx, dy = 0) => K.transform(mesh, (x, y, z, out) => { out[0] = x + dx; out[1] = y + dy; out[2] = z; });
  // handle: a 4 mm fin, printed lying flat, pushed into the slot; two crush bumps at its ends (in
  // the slot's depth, lead-in chamfered) press 0.15 mm into the slot's end walls so it stays put
  const finL = slotL - 0.4, finH = 16, finT = 4, bump = 0.35;
  const finRing = K.ccw([0, 0, finL, 0, finL + bump, 0.8, finL + bump, slotD - 0.6, finL, slotD, finL, finH - 2, finL - 2, finH, 2, finH, 0, finH - 2, 0, slotD, -bump, slotD - 0.6, -bump, 0.8]);
  const fin = K.extrudePolygons([{ outer: finRing, holes: [] }], 0, finT);
  const finX = shiftX + scx - finL / 2, finY = sbb.y0 - finH - 8;
  const parts = [
    { name: 'Cutter', mesh: cutter, color: o.cutterColor || COLORS.accent },
    { name: 'Stamp plate', mesh: move(plate, shiftX), color: o.stampColor || COLORS.natural },
    { name: 'Stamp relief', mesh: move(relief.mesh, shiftX), color: o.stampColor || COLORS.natural },
  ];
  if (inside) parts.push({ name: 'Stamp handle', mesh: move(fin, finX, finY), color: o.stampColor || COLORS.natural });
  else notes.push('!The outline is too narrow for the handle slot; the stamp has no handle.');
  notes.push(`Cutter wall ${wallH} mm tall, ${edge} mm at the cutting edge tapering to ${baseW} mm at the base, ${fw} mm flange ${flangeH} mm thick.`);
  notes.push(`Stamp: the drawing mirrored as a ${reliefH} mm relief on a ${plateT} mm plate, ${r1(inset)} mm inside the cutter wall; lines at least ${lineW} mm so they press cleanly.`);
  if (inside) notes.push(`Handle: a ${finT} mm fin (printed flat) pushed ${slotD} mm deep into a ${slotW} mm slot under the stamp; crush bumps at its ends grip the slot. If it is too tight, sand the bumps; a drop of glue makes it permanent. The slot roof is a short ${slotW} mm bridge, no supports.`);
  notes.push('Food use: PETG prints are hard to clean fully; use the cutter on dough that is baked, and wash by hand.');
  return finish('cutter', parts, notes, { walls: 3, infill: '20%', note: 'Cutter in one colour; stamp plate and relief are one object.' },
    { outlinePoints: ring.length / 2, outlineCrossings: xOut + xIn, outlineRound: sil.roundMm ?? null, outlineLost: sil.cutMm != null ? r1(sil.cutMm) : null });
}

// ---------------------------------------------------------------- entry

const BUILDERS = { plaque: buildPlaque, wire: buildWire, litho: buildLitho, cutter: buildCutter };

/**
 * Build a print product from a drawing.
 * @param id    'plaque' | 'wire' | 'litho' | 'cutter'
 * @param geom  a Spiralist geometry ({ n, data, path, rings?, real?, lineart? })
 * @param opts  product options (sizeMm first; see each builder), plus field (the app's darkness
 *              field, to rebuild spirals exactly)
 */
export function buildProduct(id, geom, opts = {}) {
  const fn = BUILDERS[id];
  if (!fn) throw new Error('buildProduct: unknown product ' + id);
  if (!geom || geom.n < 2) throw new Error('buildProduct: no drawing');
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const out = fn(geom, opts);
  out.stats.ms = Math.round((typeof performance !== 'undefined' ? performance : Date).now() - t0);
  out.product = PRODUCTS.find(p => p.id === id);
  return out;
}

/** Plain-text summary of a build (for the dev page and the tests). */
export function describe(out) {
  const s = out.sizeMm;
  return `${out.product.letter} ${out.product.name}: X 0-${s.x[1]} mm, Y 0-${s.y[1]} mm, Z 0-${s.z[1]} mm; ` +
    `${out.parts.length} part(s), ${out.stats.triangles} triangles, ${out.printability.ok ? 'printable' : 'NOT printable'}`;
}
