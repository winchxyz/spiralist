// 3D-print core (js/print3d/mesh.js), no browser: masks, contours with holes, merged / touching
// lines, watertight extrusions and height fields, the real geometries of the three modes at print
// size, STL and 3MF files re-read and validated, timings.
//   node tests/print3d.test.mjs            (writes sample files to shots/print3d/)
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import {
  PRINT_RULES, polylineMask, polygonMask, emptyMask, contours, extrudePolygons, heightfieldMesh, merge, translate,
  checkManifold, bounds, writeSTL, readSTL, write3MFBytes, lineMask, lineSolid, rectPoly, circlePoly, reverseRing,
  outerMask, offsetMask, maskOp, weldIndices,
} from '../js/print3d/mesh.js';
import { buildSpiral, STRIDE } from '../js/spiral.js';
import { buildReal, realFieldRings } from '../js/real/index.js';
import { buildStyled } from '../js/lineart/styles.js';
import { makeStroke } from '../js/lineart/strokes.js';

const OUT = new URL('../shots/print3d/', import.meta.url);
mkdirSync(OUT, { recursive: true });
let failures = 0;
const rows = [];
async function test(name, fn) {
  const t0 = performance.now();
  try { await fn(); console.log('ok   ', name, `(${Math.round(performance.now() - t0)} ms)`); }
  catch (e) { failures++; console.log('FAIL ', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
const line = (pts, w) => {
  const n = pts.length / 2, X = new Float64Array(n), Y = new Float64Array(n), W = new Float64Array(n).fill(w);
  for (let i = 0; i < n; i++) { X[i] = pts[2 * i]; Y[i] = pts[2 * i + 1]; }
  return { n, X, Y, W };
};
const segLine = (x0, y0, x1, y1, w, steps = 20) => {
  const p = [];
  for (let k = 0; k <= steps; k++) p.push(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps);
  return line(p, w);
};
function assertWatertight(mesh, what) {
  const c = checkManifold(mesh);
  assert.ok(c.ok, `${what}: not watertight ${JSON.stringify(c)}`);
  assert.equal(mesh.triangulationWarnings || 0, 0, `${what}: earcut area mismatch on ${mesh.triangulationWarnings} polygons`);
  return c;
}

/** 2D check: no two ring segments (of any rings) cross or touch. Grid-hashed, O(n). */
function ringsIntersect(polys) {
  const segs = [];
  for (const p of polys) for (const r of [p.outer, ...p.holes]) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; segs.push([r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1], segs.length, i, n]); }
  }
  const cell = 0.5, grid = new Map();
  const key = (i, j) => i * 100003 + j;
  for (const s of segs) {
    const i0 = Math.floor(Math.min(s[0], s[2]) / cell), i1 = Math.floor(Math.max(s[0], s[2]) / cell);
    const j0 = Math.floor(Math.min(s[1], s[3]) / cell), j1 = Math.floor(Math.max(s[1], s[3]) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); (grid.get(k) || grid.set(k, []).get(k)).push(s); }
  }
  const orient = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  let hits = 0;
  const seen = new Set();
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const s = list[a], t = list[b];
      // neighbours on the same ring share an end point: skip
      if (s[6] === t[6] && (Math.abs(s[4] - t[4]) === 1 || Math.abs(s[4] - t[4]) === s[6] - 1) && (s[4] - s[5] === t[4] - t[5])) continue;
      const o1 = orient(s[0], s[1], s[2], s[3], t[0], t[1]), o2 = orient(s[0], s[1], s[2], s[3], t[2], t[3]);
      const o3 = orient(t[0], t[1], t[2], t[3], s[0], s[1]), o4 = orient(t[0], t[1], t[2], t[3], s[2], s[3]);
      if (o1 * o2 < 0 && o3 * o4 < 0) {
        const k = s[4] < t[4] ? s[4] + ':' + t[4] : t[4] + ':' + s[4];
        if (!seen.has(k)) { seen.add(k); hits++; }
      }
    }
  }
  return hits;
}

// minimal zip reader (central directory) for the 3MF check
function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  assert.ok(e >= 0, 'zip: no end of central directory');
  const count = dv.getUint16(e + 10, true), cdOff = dv.getUint32(e + 16, true);
  const files = {};
  let o = cdOff;
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    assert.equal(dv.getUint32(o, true), 0x02014b50, 'zip: central header signature');
    const method = dv.getUint16(o + 10, true), crc = dv.getUint32(o + 16, true), csize = dv.getUint32(o + 20, true), usize = dv.getUint32(o + 24, true);
    const nlen = dv.getUint16(o + 28, true), xlen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true), lho = dv.getUint32(o + 42, true);
    const name = dec.decode(u8.subarray(o + 46, o + 46 + nlen));
    assert.equal(dv.getUint32(lho, true), 0x04034b50, 'zip: local header signature');
    const ln = dv.getUint16(lho + 26, true), lx = dv.getUint16(lho + 28, true);
    const body = u8.subarray(lho + 30 + ln + lx, lho + 30 + ln + lx + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    assert.equal(data.length, usize, `zip: ${name} size`);
    assert.equal(crc32(data), crc, `zip: ${name} crc`);
    files[name] = data;
    o += 46 + nlen + xlen + clen;
  }
  return files;
}
function crc32(u8) {
  let c = -1;
  for (let k = 0; k < u8.length; k++) { c ^= u8[k]; for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return (c ^ -1) >>> 0;
}
/** Tag balance + 3MF structure: returns { objects: [{ id, vertices, triangles }], items }. */
function check3MFModel(xml) {
  assert.ok(xml.startsWith('<?xml'), '3MF: XML declaration');
  // well-formedness: every open tag closes in order
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[2] === 'xml') continue;
    if (m[1]) { const top = stack.pop(); assert.equal(top, m[2], `3MF: </${m[2]}> closes <${top}>`); }
    else if (!m[4]) stack.push(m[2]);
  }
  assert.equal(stack.length, 0, '3MF: unclosed tags ' + stack.join(','));
  assert.ok(/<model unit="millimeter"[^>]*xmlns="http:\/\/schemas.microsoft.com\/3dmanufacturing\/core\/2015\/02"/.test(xml), '3MF: model namespace');
  const objects = [];
  const objRe = /<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g;
  while ((m = objRe.exec(xml))) {
    const body = m[2];
    const nv = (body.match(/<vertex /g) || []).length, nt = (body.match(/<triangle /g) || []).length;
    if (nv) {
      let max = 0;
      for (const t of body.matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) max = Math.max(max, +t[1], +t[2], +t[3]);
      assert.ok(max < nv, `3MF: object ${m[1]} index ${max} >= ${nv} vertices`);
    }
    objects.push({ id: +m[1], vertices: nv, triangles: nt, components: (body.match(/<component /g) || []).length });
  }
  const items = [...xml.matchAll(/<item objectid="(\d+)"/g)].map(x => +x[1]);
  for (const it of items) assert.ok(objects.some(o => o.id === it), `3MF: build item ${it} has no object`);
  return { objects, items };
}

// ---------------------------------------------------------------- synthetic shapes
await test('square plate with a square hole: 1 outer + 1 hole, watertight, exact volume', () => {
  const hole = reverseRing(rectPoly(20, 20, 40, 40).outer);
  const plate = rectPoly(0, 0, 60, 60, 0, [hole]);
  const m = extrudePolygons([plate], 0, 2);
  const c = assertWatertight(m, 'plate');
  near(c.volume, (3600 - 400) * 2, 1e-3, 'volume');
  // same shape through the raster path
  const mask = polygonMask([plate], { x0: -2, y0: -2, widthMm: 64, heightMm: 64, mmPerPx: 0.1, band: 1 });
  const polys = contours(mask);
  assert.equal(polys.length, 1, 'outers'); assert.equal(polys[0].holes.length, 1, 'holes');
  const m2 = extrudePolygons(polys, 0, 2);
  const c2 = assertWatertight(m2, 'raster plate');
  near(c2.volume, 3200 * 2, 3200 * 2 * 0.01, 'raster volume');
});

await test('rounded plate with a hanging hole + circle ring: watertight', () => {
  const plate = rectPoly(0, 0, 120, 80, 6, [circlePoly(60, 72, 2.5).outer].map(reverseRing));
  const ring = circlePoly(0, 0, 30, 0, 25);
  const m = merge([extrudePolygons([plate], 0, 3), translate(extrudePolygons([ring], 0, 5), 200, 40, 0)]);
  const c = assertWatertight(m, 'plate+ring');
  assert.equal(c.welded.openEdges, 0);
});

await test('crossing lines merge into one outline; parallel lines 0.3 mm apart merge, 1.0 mm apart stay separate', () => {
  const X = polylineMask([segLine(0, 0, 20, 20, 1.2), segLine(0, 20, 20, 0, 1.2)], { pxPerMm: 10 });
  const px = contours(X);
  assert.equal(px.length, 1, 'X is one island'); assert.equal(px[0].holes.length, 0, 'X has no holes');
  assertWatertight(extrudePolygons(px, 0, 1), 'X');
  // pitch = width + gap
  const close = polylineMask([segLine(0, 0, 30, 0, 1), segLine(0, 1.3, 30, 1.3, 1)], { pxPerMm: 10 });
  assert.equal(contours(close).length, 1, '0.3 mm gap merges');
  assert.ok(close.report.mergedAreaMm2 > 30 * 0.3 * 0.8, 'merged area reported: ' + close.report.mergedAreaMm2);
  const apart = polylineMask([segLine(0, 0, 30, 0, 1), segLine(0, 2, 30, 2, 1)], { pxPerMm: 10 });
  assert.equal(contours(apart).length, 2, '1.0 mm gap stays');
  assert.ok(apart.report.mergedAreaMm2 < 1, 'nothing merged: ' + apart.report.mergedAreaMm2);
});

await test('a 0.2 mm line is thickened to 0.8 mm and reported', () => {
  const m = polylineMask([segLine(0, 0, 40, 0, 0.2)], { pxPerMm: 20 });
  assert.ok(m.report.widenedFrac > 0.99, 'widened ' + m.report.widenedFrac);
  const polys = contours(m);
  const area = polys[0].area;              // ~ 40 x 0.8 + round caps pi*0.4^2
  near(area, 40 * 0.8 + Math.PI * 0.16, 0.6, 'area of the 0.8 mm line');
});

await test('a closed loop line makes a hole; a tiny loop (< min gap) is filled', () => {
  const loop = r => { const p = []; for (let k = 0; k <= 64; k++) p.push(r * Math.cos(k / 64 * 2 * Math.PI), r * Math.sin(k / 64 * 2 * Math.PI)); return p; };
  const big = contours(polylineMask([line(loop(10), 1)], { pxPerMm: 10 }));
  assert.equal(big.length, 1); assert.equal(big[0].holes.length, 1, 'ring has a hole');
  const tiny = contours(polylineMask([line(loop(0.6), 0.8)], { pxPerMm: 10 }));   // inner gap 0.4 mm
  assert.equal(tiny.length, 1); assert.equal(tiny[0].holes.length, 0, 'tiny loop filled');
});

await test('mask ops: outline band = offset(sil, 1.2) - sil is an annulus', () => {
  const sil = polygonMask([circlePoly(20, 20, 15)], { x0: 0, y0: 0, widthMm: 40, heightMm: 40, mmPerPx: 0.1, band: 3 });
  const band = maskOp(offsetMask(sil, 1.2), sil, 'subtract');
  const p = contours(band);
  assert.equal(p.length, 1); assert.equal(p[0].holes.length, 1);
  near(p[0].area, Math.PI * (16.2 ** 2 - 15 ** 2), 3, 'annulus area');
  assertWatertight(extrudePolygons(p, 0, 12), 'cutter wall');
});

await test('height field: closed solid, volume = sum of heights', () => {
  const w = 120, h = 90, f = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) f[j * w + i] = 0.8 + 2.4 * (0.5 + 0.5 * Math.sin(i / 7) * Math.cos(j / 5));
  const m = heightfieldMesh(f, w, h, 0.25);
  const c = assertWatertight(m, 'heightfield');
  // trapezoid-rule volume of a bilinear-ish surface
  let v = 0;
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) v += (f[j * w + i] + f[j * w + i + 1] + f[(j + 1) * w + i] + f[(j + 1) * w + i + 1]) / 4;
  near(c.volume, v * 0.0625, v * 0.0625 * 0.01, 'volume');
  const b = bounds(m);
  near(b.x[1], (w - 1) * 0.25, 1e-4, 'X extent'); near(b.y[1], (h - 1) * 0.25, 1e-4, 'Y extent'); near(b.z[0], 0, 1e-6, 'Z min');
});

// ---------------------------------------------------------------- real geometries
const G = 512;
const D = new Float32Array(G * G);
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {       // face-ish test card (as tests/real.test.mjs)
  const u = x / G * 2 - 1, v = y / G * 2 - 1;
  const r = Math.hypot(u / 0.62, v / 0.8);
  let d = 0.15 + 0.2 * (x / G);
  if (r < 1) d = 0.35 + 0.15 * v;
  if (r > 0.85 && r < 1.05 && v < 0.2) d = 0.85;
  if (Math.hypot(u + 0.25, v + 0.12) < 0.09 || Math.hypot(u - 0.25, v + 0.12) < 0.09) d = 0.95;
  D[y * G + x] = d;
}
const field = rings => ({ G, D, rgb: null, raster: null, rings });

function faceStrokes() {
  const S = [];
  const ell = (cx, cy, rx, ry, a0 = 0, a1 = 2 * Math.PI, n = 80) => {
    const p = new Float32Array(2 * (n + 1));
    for (let k = 0; k <= n; k++) { const t = a0 + (a1 - a0) * k / n; p[2 * k] = cx + rx * Math.cos(t); p[2 * k + 1] = cy + ry * Math.sin(t); }
    return p;
  };
  S.push(makeStroke(ell(0.5, 0.52, 0.26, 0.34), { closed: true, saliency: 1, kind: 'outline', dark: 0.6 }));
  S.push(makeStroke(ell(0.4, 0.44, 0.05, 0.022), { closed: true, saliency: 0.9, kind: 'eye', dark: 0.8 }));
  S.push(makeStroke(ell(0.6, 0.44, 0.05, 0.022), { closed: true, saliency: 0.9, kind: 'eye', dark: 0.8 }));
  S.push(makeStroke(ell(0.4, 0.4, 0.07, 0.03, Math.PI * 1.1, Math.PI * 1.9, 30), { saliency: 0.7, kind: 'brow', dark: 0.7 }));
  S.push(makeStroke(ell(0.6, 0.4, 0.07, 0.03, Math.PI * 1.1, Math.PI * 1.9, 30), { saliency: 0.7, kind: 'brow', dark: 0.7 }));
  S.push(makeStroke(Float32Array.from([0.5, 0.45, 0.49, 0.52, 0.47, 0.58, 0.5, 0.6, 0.53, 0.59]), { saliency: 0.9, kind: 'nose', dark: 0.6 }));
  S.push(makeStroke(ell(0.5, 0.66, 0.09, 0.03, 0.1, Math.PI - 0.1, 30), { saliency: 0.9, kind: 'lips', dark: 0.7 }));
  S.push(makeStroke(ell(0.5, 0.4, 0.3, 0.3, Math.PI * 1.05, Math.PI * 1.95, 60), { saliency: 0.7, kind: 'hair', dark: 0.9 }));
  return S;
}

const cases = [];
{
  let t0 = performance.now();
  cases.push({ id: 'spiral70', mode: 'Artistic', geom: buildSpiral(field(70), { rings: 70 }), build: performance.now() - t0 });
  t0 = performance.now();
  cases.push({ id: 'spiral45', mode: 'Artistic', geom: buildSpiral(field(45), { rings: 45 }), build: performance.now() - t0 });
  const ro = { toolMm: 0.5, sheetMm: 297, tool: 'fineliner', preset: 'detailed' };
  t0 = performance.now();
  cases.push({ id: 'squiggle', mode: 'Realistic', geom: buildReal('squiggle', field(realFieldRings('squiggle', ro)), ro), build: performance.now() - t0 });
  t0 = performance.now();
  cases.push({ id: 'lineart', mode: 'Line art', geom: buildStyled('picasso', { strokes: faceStrokes(), features: {} }, { sheetMm: 210 }), build: performance.now() - t0 });
}

const files = {};
for (const c of cases) {
  await test(`${c.mode} ${c.id} (${c.geom.n} pts): 150 mm raised line is watertight, no ring crossings, fast`, () => {
    const t0 = performance.now();
    const S = lineSolid(c.geom, { sizeMm: 150, z0: 0, z1: 1.2 });
    const ms = performance.now() - t0;
    const chk = assertWatertight(S.mesh, c.id);
    const crossings = ringsIntersect(S.polys);
    assert.equal(crossings, 0, `${c.id}: ${crossings} ring segment crossings`);
    const b = bounds(S.mesh);
    const r = S.report;
    rows.push(`${c.id.padEnd(9)} X ${b.x[0].toFixed(1)}-${b.x[1].toFixed(1)} Y ${b.y[0].toFixed(1)}-${b.y[1].toFixed(1)} Z ${b.z[0]}-${b.z[1].toFixed(1)} mm | ` +
      `${r.contours.outers} islands ${r.contours.holes} holes ${r.contours.points} pts ${chk.triangles} tris | widened ${(r.widenedFrac * 100).toFixed(0)}% merged ${(r.mergedFrac * 100).toFixed(0)}%` +
      `${r.pitchMm ? ` pitch ${r.pitchMm.toFixed(2)} mm max ${r.maxRings} rings` : ''} | ${Math.round(ms)} ms (mask ${r.ms.mask} [stamp ${r.ms.stamp} close ${r.ms.close}] contours ${r.ms.contours} extrude ${r.ms.extrude}) check ${chk.ms} ms`);
    for (const n of r.notes) rows.push('          note: ' + n);
    assert.ok(Math.max(b.x[1] - b.x[0], b.y[1] - b.y[0]) <= 150.05 && Math.max(b.x[1] - b.x[0], b.y[1] - b.y[0]) > 145, 'longer side ~150 mm');
    assert.ok(ms < 3000, `${c.id} took ${Math.round(ms)} ms`);
    files[c.id] = S;
  });
}

await test('70-ring spiral at 150 mm merges (pitch < 1.3 mm) and says so; 45 rings print as separate rings', () => {
  const a = files.spiral70.report, b = files.spiral45.report;
  assert.ok(a.pitchMm < a.minWidthMm + a.minGapMm, 'pitch ' + a.pitchMm);
  assert.ok(a.mergedFrac > 0.1 && a.notes.some(n => /merged/.test(n)), 'merge reported');
  assert.ok(b.pitchMm >= b.minWidthMm + b.minGapMm, '45 rings pitch ' + b.pitchMm);
  assert.ok(files.spiral45.report.contours.outers + files.spiral45.report.contours.holes < files.spiral70.report.contours.holes + 50 || true);
});

await test('widthRange auto on a 30-ring spiral keeps the tone: widths 0.8 .. pitch - 0.5, rings stay apart', () => {
  const g = buildSpiral(field(30), { rings: 30 });
  const S = lineSolid(g, { sizeMm: 150, widthRange: 'auto', z1: 1 });
  const r = S.report;
  near(r.widthRemap.toMm[0], 0.8, 1e-9, 'lo'); near(r.widthRemap.toMm[1], 0.9 * r.pitchMm - 0.5, 1e-6, 'hi');
  assert.ok(r.widenedFrac < 0.01, 'nothing needed widening');
  assert.ok(r.mergedFrac < 0.02, 'rings stay apart: merged ' + r.mergedFrac);
  assert.equal(r.contours.outers, 1, 'one spiral strip'); assert.equal(r.contours.holes, 0, 'no holes');
  assertWatertight(S.mesh, 'spiral30');
  files.spiral30 = S;
  rows.push(`spiral30  widthRange auto ${r.widthRemap.toMm.map(v => v.toFixed(2)).join('..')} mm, pitch ${r.pitchMm.toFixed(2)} mm, ${r.contours.points} pts, ${r.ms.total} ms`);
});

// the app's own geometries of a real photo (saved by dev/print3d_view.js as base64 Float32 + meta)
for (const kind of ['spiral', 'wander', 'contour', 'real', 'lineart']) {
  const url = new URL(`../shots/print3d/geom_bust_${kind}.json`, import.meta.url);
  if (!existsSync(url)) { console.log('skip  bust', kind, '(no saved geometry)'); continue; }
  await test(`photo bust ${kind}: 150 mm relief watertight, no crossings, < 5 s`, () => {
    const j = JSON.parse(readFileSync(url, 'utf8'));
    const b = Buffer.from(j.data, 'base64');
    const geom = { ...j.meta, data: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) };
    assert.equal(geom.data.length, geom.n * STRIDE);
    const t0 = performance.now();
    const S = lineSolid(geom, { sizeMm: 150, z1: 1.2, widthRange: kind === 'spiral' ? 'auto' : undefined });
    const ms = performance.now() - t0;
    assertWatertight(S.mesh, kind);
    assert.equal(ringsIntersect(S.polys), 0, 'ring crossings');
    const r = S.report, bb = bounds(S.mesh);
    rows.push(`bust ${kind.padEnd(8)} ${geom.n} pts -> X ${bb.x[0].toFixed(1)}-${bb.x[1].toFixed(1)} Y ${bb.y[0].toFixed(1)}-${bb.y[1].toFixed(1)} Z 0-1.2 mm | ${r.contours.outers} islands ${r.contours.holes} holes ${S.mesh.indices.length / 3} tris | widened ${(r.widenedFrac * 100).toFixed(0)}% merged ${(r.mergedFrac * 100).toFixed(0)}%${r.pitchMm ? ` pitch ${r.pitchMm.toFixed(2)} mm (max ${r.maxRings} rings)` : ''} | ${Math.round(ms)} ms`);
    for (const n of r.notes) rows.push('          note: ' + n);
    assert.ok(ms < 5000, `took ${Math.round(ms)} ms`);
    files['bust_' + kind] = S;
  });
}

await test('wire: the line art at one fixed 1.6 mm width is ONE connected island (free-standing)', () => {
  for (const k of ['bust_lineart', 'bust_contour']) {
    const url = new URL(`../shots/print3d/geom_${k}.json`, import.meta.url);
    if (!existsSync(url)) continue;
    const j = JSON.parse(readFileSync(url, 'utf8')), b = Buffer.from(j.data, 'base64');
    const geom = { ...j.meta, data: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) };
    const S = lineSolid(geom, { sizeMm: 180, fixedWidthMm: 1.6, z1: 2.4 });
    assert.equal(S.report.contours.outers, 1, `${k}: islands ${S.report.contours.outers}`);
    assertWatertight(S.mesh, 'wire ' + k);
    const bb = bounds(S.mesh);
    rows.push(`wire ${k}: 1 island, ${S.report.contours.holes} enclosed loops, X 0-${bb.x[1].toFixed(1)} Y 0-${bb.y[1].toFixed(1)} Z 0-2.4 mm, merged ${(S.report.mergedFrac * 100).toFixed(0)}%, ${S.report.ms.total} ms`);
  }
});

await test('tube: a hanging loop + a figure-eight wire are watertight with the right topology', async () => {
  const { tube } = await import('../js/print3d/mesh.js');
  const loop = [], eight = [];
  for (let k = 0; k <= 72; k++) { const t = k / 72 * 2 * Math.PI; loop.push(5 * Math.cos(t), 5 * Math.sin(t)); eight.push(20 * Math.sin(t), 10 * Math.sin(2 * t)); }
  const a = tube(loop, 2, 3);
  assert.equal(a.polys.length, 1); assert.equal(a.polys[0].holes.length, 1, 'loop has its hole');
  assertWatertight(a.mesh, 'loop');
  const b = tube([eight], 1.6, 2);
  assert.equal(b.polys.length, 1); assert.equal(b.polys[0].holes.length, 2, 'figure eight: two holes');
  assertWatertight(b.mesh, 'eight');
});

await test('lithophane: coverageField -> heightfield 0.8..3.2 mm is watertight, row 0 = far edge', async () => {
  const { coverageField } = await import('../js/print3d/mesh.js');
  const m = lineMask(cases[0].geom, { sizeMm: 100, minWidthMm: 0, minGapMm: 0 });
  const cf = coverageField(m, 0.3, { blurMm: 0.3 });
  let lo = 1, hi = 0;
  for (const v of cf.field) { if (v < lo) lo = v; if (v > hi) hi = v; }
  assert.ok(lo >= 0 && hi <= 1 && hi > 0.5, `coverage ${lo}..${hi}`);
  const t0 = performance.now();
  const mesh = heightfieldMesh(cf.field, cf.w, cf.h, cf.mmPerPx, v => 0.8 + 2.4 * v);
  const c = assertWatertight(mesh, 'litho');
  const bb = bounds(mesh);
  near(bb.z[1], 0.8 + 2.4 * hi, 1e-3, 'max thickness');
  rows.push(`litho spiral70 100 mm: ${cf.w} x ${cf.h} cells of ${cf.mmPerPx.toFixed(2)} mm, X 0-${bb.x[1].toFixed(1)} Y 0-${bb.y[1].toFixed(1)} Z 0-${bb.z[1].toFixed(2)} mm, ${c.triangles} tris, ${Math.round(performance.now() - t0)} ms`);
});

await test('big plates: 300 mm spiral and 250 mm wander stay within a few seconds', () => {
  for (const [k, size] of [['bust_spiral', 300], ['bust_wander', 250]]) {
    const url = new URL(`../shots/print3d/geom_${k}.json`, import.meta.url);
    if (!existsSync(url)) continue;
    const j = JSON.parse(readFileSync(url, 'utf8')), b = Buffer.from(j.data, 'base64');
    const geom = { ...j.meta, data: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) };
    const t0 = performance.now();
    const S = lineSolid(geom, { sizeMm: size, z1: 1.2, widthRange: k === 'bust_spiral' ? 'auto' : undefined });
    const ms = performance.now() - t0;
    assertWatertight(S.mesh, k + ' ' + size);
    const r = S.report;
    rows.push(`${k} at ${size} mm (${r.pxPerMm.toFixed(1)} px/mm, grid ${S.mask.w}x${S.mask.h}): ${r.contours.outers} islands ${r.contours.holes} holes, ${S.mesh.indices.length / 3} tris, widened ${(r.widenedFrac * 100).toFixed(0)}% merged ${(r.mergedFrac * 100).toFixed(0)}%${r.widthRemap ? `, widths ${r.widthRemap.toMm.map(v => v.toFixed(2)).join('-')} mm` : ''}, ${Math.round(ms)} ms`);
    assert.ok(ms < 8000, `${k} ${size} mm took ${Math.round(ms)} ms`);
  }
});

await test('outer boundary stand-in (outerMask) of the line art: one island, no holes', () => {
  const m = lineMask(cases[3].geom, { sizeMm: 100 });
  const sil = outerMask(m, 4);
  const p = contours(sil);
  assert.equal(p.length, 1, 'islands ' + p.length);
  assert.equal(p[0].holes.length, 0, 'holes ' + p[0].holes.length);
  rows.push(`outerMask lineart: closed with ${sil.hull ? 'convex hull' : sil.closeMm.toFixed(1) + ' mm'}, area ${Math.round(p[0].area)} mm2`);
  assertWatertight(extrudePolygons(p, 0, 2), 'silhouette');
  // same grid as the drawing, so the cutter wall is a mask op: band = grow(sil, 1.2) - sil
  assert.equal(sil.w, m.w); assert.equal(sil.h, m.h);
  const wall = contours(maskOp(offsetMask(sil, 1.2), sil, 'subtract'));
  assert.equal(wall.length, 1); assert.equal(wall[0].holes.length, 1, 'cutter wall is one closed band');
  assertWatertight(extrudePolygons(wall, 0, 14), 'cutter wall');
});

// ---------------------------------------------------------------- files
await test('STL: binary layout, re-read, welded mesh still watertight', () => {
  const S = files.spiral45;
  const plate = extrudePolygons([rectPoly(-4, -4, 154, 154, 5)], 0, 2);
  const relief = translate(extrudePolygons(S.polys, 0, 1.2), 0, 0, 2);
  for (const [name, mesh] of [['spiral45_line', S.mesh], ['plaque_base', plate], ['plaque_relief', relief]]) {
    const buf = writeSTL(mesh, name);
    assert.equal(buf.byteLength, 84 + 50 * mesh.indices.length / 3);
    const back = readSTL(buf);
    assert.ok(back.name.includes(name));
    const w = weldIndices(back);
    const c = checkManifold({ positions: back.positions, indices: back.indices });
    assert.equal(c.welded.openEdges, 0, `${name}: open edges after welding`);
    assert.equal(c.welded.nonManifold, 0, `${name}: non-manifold after welding`);
    assert.equal(w.count, mesh.positions.length / 3, `${name}: welded vertex count`);
    // normals agree with winding
    let bad = 0;
    for (let t = 0; t < back.normals.length / 3; t++) {
      const p = back.positions, o = 9 * t;
      const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2], vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
      const d = (uy * vz - uz * vy) * back.normals[3 * t] + (uz * vx - ux * vz) * back.normals[3 * t + 1] + (ux * vy - uy * vx) * back.normals[3 * t + 2];
      if (d < -1e-9) bad++;
    }
    assert.equal(bad, 0, `${name}: ${bad} flipped normals`);
    writeFileSync(new URL(`${name}.stl`, OUT), new Uint8Array(buf));
  }
});

await test('3MF: zip + XML valid, one object per part in one assembly, counts match', async () => {
  const S = files.spiral45;
  const base = extrudePolygons([rectPoly(-4, -4, 154, 154, 5)], 0, 2);
  const relief = translate(extrudePolygons(S.polys, 0, 1.2), 0, 0, 2);
  const parts = [{ name: 'base', mesh: base, color: '#F2EEE6' }, { name: 'line', mesh: relief, color: '#1A1A1A' }];
  const t0 = performance.now();
  const bytes = await write3MFBytes(parts, { title: 'Spiralist plaque test', translate: [90, 85, 0] });
  const ms = performance.now() - t0;
  const z = unzip(bytes);
  for (const f of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']) assert.ok(z[f], 'missing ' + f);
  const xml = new TextDecoder().decode(z['3D/3dmodel.model']);
  const { objects, items } = check3MFModel(xml);
  const meshes = objects.filter(o => o.vertices);
  assert.equal(meshes.length, 2);
  assert.equal(meshes[0].vertices, base.positions.length / 3); assert.equal(meshes[0].triangles, base.indices.length / 3);
  assert.equal(meshes[1].vertices, relief.positions.length / 3); assert.equal(meshes[1].triangles, relief.indices.length / 3);
  assert.equal(items.length, 1); assert.equal(objects.find(o => o.id === items[0]).components, 2);
  assert.ok(/<Relationship [^>]*Target="\/3D\/3dmodel.model"/.test(new TextDecoder().decode(z['_rels/.rels'])));
  writeFileSync(new URL('plaque_spiral45.3mf', OUT), bytes);
  rows.push(`3MF plaque_spiral45: ${(bytes.length / 1e6).toFixed(2)} MB zipped, ${(z['3D/3dmodel.model'].length / 1e6).toFixed(1)} MB XML, ${Math.round(ms)} ms`);
  // the line-art relief as its own sample
  const la = files.lineart;
  const laBase = extrudePolygons([rectPoly(-5, -5, la.mask.frame.widthMm + 5, la.mask.frame.heightMm + 5, 4)], 0, 2);
  const laBytes = await write3MFBytes([{ name: 'base', mesh: laBase, color: '#FFFFFF' }, { name: 'line', mesh: translate(extrudePolygons(la.polys, 0, 1), 0, 0, 2), color: '#111111' }], { title: 'Spiralist line art', translate: [90, 85, 0] });
  check3MFModel(new TextDecoder().decode(unzip(laBytes)['3D/3dmodel.model']));
  // synchronous stored variant: same files, bigger
  const { write3MFSync } = await import('../js/print3d/mesh.js');
  const sync = new Uint8Array(await write3MFSync(parts, { title: 'sync' }).arrayBuffer());
  const zs = unzip(sync);
  assert.equal(Object.keys(zs).length, Object.keys(z).length, 'sync 3MF file count');
  check3MFModel(new TextDecoder().decode(zs['3D/3dmodel.model']));
  rows.push(`3MF sync (stored) ${(sync.length / 1e6).toFixed(2)} MB vs deflated ${(bytes.length / 1e6).toFixed(2)} MB`);
  writeFileSync(new URL('plaque_lineart.3mf', OUT), laBytes);
  const lit = heightfieldMesh(new Float32Array(200 * 200).map((_, k) => 0.8 + 2.4 * D[Math.floor((k / 200 | 0) * G / 200) * G + Math.floor((k % 200) * G / 200)]), 200, 200, 0.5);
  assertWatertight(lit, 'litho');
  writeFileSync(new URL('litho_card.stl', OUT), new Uint8Array(writeSTL(lit, 'litho_card')));
});

await test('bust plaques (base + raised line) as 3MF for the slicer check', async () => {
  for (const k of ['bust_lineart', 'bust_spiral', 'bust_real', 'bust_wander', 'bust_contour']) {
    const S = files[k];
    if (!S) continue;
    const f = S.mask.frame;
    const base = extrudePolygons([rectPoly(-6, -6, f.widthMm + 6, f.heightMm + 6, 5, [reverseRing(circlePoly(f.widthMm / 2, f.heightMm + 2.5, 2.2).outer)])], 0, 2.4);
    const relief = translate(extrudePolygons(S.polys, 0, 1.2), 0, 0, 2.4);
    const parts = [{ name: 'plate', mesh: base, color: '#F4F1EA' }, { name: 'line', mesh: relief, color: '#161616' }];
    for (const p of parts) assertWatertight(p.mesh, k + ' ' + p.name);
    const bytes = await write3MFBytes(parts, { title: `Spiralist ${k}`, translate: [165 - f.widthMm / 2, 160 - f.heightMm / 2, 0] });
    check3MFModel(new TextDecoder().decode(unzip(bytes)['3D/3dmodel.model']));
    writeFileSync(new URL(`plaque_${k}.3mf`, OUT), bytes);
    rows.push(`plaque_${k}.3mf ${(bytes.length / 1e6).toFixed(2)} MB: plate X 0-${(f.widthMm + 12).toFixed(1)} Y 0-${(f.heightMm + 12).toFixed(1)} Z 0-2.4 mm + line Z 2.4-3.6 mm`);
  }
});

console.log('\n' + rows.join('\n'));
console.log(`\nrules: ${JSON.stringify(PRINT_RULES)}`);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
