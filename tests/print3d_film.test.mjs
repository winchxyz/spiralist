// Node tests for the print timelapse: toolpaths from real product builds, the time model against
// Bambu Studio's own estimates (shots/print3d/slice/lineup_*), and the G-code parser on a real file.
//   node tests/print3d_film.test.mjs [--only wire,plaque,litho,cutter] [--art lineart]
// Needs the captures shots/print3d/geom_bust_<kind>.json (tests/print3d_capture.mjs); skips if missing.
import fs from 'node:fs';
import { buildProduct } from '../js/print3d/products.js';
import { buildToolpath, polylineTimes, segTime, nozzleAt, layerAt, formatDuration, FEATURES, filmTimeMap } from '../js/print3d/toolpath.js';
import { parseGcode, readGcodeFile } from '../js/print3d/gcode.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', 'wire,plaque,litho,cutter').split(',');
const art = opt('art', 'lineart');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

// --- motion model basics
{
  const t = segTime(100, 0, 0, 100, 1000);          // accel 0.1 s over 5 mm each side, 90 mm cruise
  ok(Math.abs(t - 1.1) < 1e-9, `segTime trapezoid 100 mm @100 mm/s, 1000 mm/s2 = ${t.toFixed(4)} s (1.1)`);
  const tri = segTime(1, 0, 0, 100, 1000);          // never reaches 100: 2*sqrt(L/a)
  ok(Math.abs(tri - 2 * Math.sqrt(1 / 1000)) < 1e-9, `segTime triangle ${tri.toFixed(5)} s`);
  const straight = polylineTimes(Float64Array.of(0, 0, 50, 0, 100, 0), 100, 1000, 9);
  ok(Math.abs(straight[0] + straight[1] - 1.1) < 1e-6, 'collinear polyline keeps its speed through the joint');
  const corner = polylineTimes(Float64Array.of(0, 0, 50, 0, 50, 50), 100, 1000, 9);
  ok(corner[0] + corner[1] > 1.1, 'a 90 degree corner slows down');
}

// --- toolpaths from product builds
function loadGeom(sample, kind) {
  const j = JSON.parse(fs.readFileSync(`shots/print3d/geom_${sample}_${kind}.json`, 'utf8'));
  const buf = Buffer.from(j.data, 'base64');
  return { ...j.meta, data: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), n: j.meta.n };
}
const geomFile = `shots/print3d/geom_bust_${art}.json`;
if (!fs.existsSync(geomFile)) console.log('skip product toolpaths: no ' + geomFile);
else {
  const geom = loadGeom('bust', art);
  const slicer = id => {
    try { const r = JSON.parse(fs.readFileSync(`shots/print3d/slice/lineup_${art}_${id}/result.json`, 'utf8')); return r.sliced_plates?.[0]?.total_predication ?? r.sliced_plates?.[0]?.total_predication; } catch { return null; }
  };
  for (const id of only) {
    const out = buildProduct(id, geom, id === 'wire' ? { stand: true } : {});
    const t0 = performance.now();
    const tp = await buildToolpath(out.parts, { settings: out.settings, colors: id === 'plaque' ? { base: '#F2F0EA', ink: '#1E1E24' } : undefined });
    const ms = performance.now() - t0;
    const st = tp.stats;
    const sl = slicer(id);
    const dz = tp.box.hi[2] - tp.box.lo[2];
    console.log(`  ${id}: X ${tp.box.lo[0].toFixed(1)}-${tp.box.hi[0].toFixed(1)}, Y ${tp.box.lo[1].toFixed(1)}-${tp.box.hi[1].toFixed(1)}, Z ${tp.box.lo[2].toFixed(1)}-${tp.box.hi[2].toFixed(1)} mm; ` +
      `${st.layers} layers, ${st.beads} beads, ${st.moves} moves, ${(st.extrudedMm / 1000).toFixed(1)} m of bead, ${st.grams.toFixed(1)} g, ` +
      `est ${formatDuration(tp.total)}${sl ? ` (Bambu Studio ${formatDuration(sl)})` : ''}, built in ${ms.toFixed(0)} ms, changes ${tp.changes.length}`);
    console.log('     time by feature: ' + FEATURES.map(f => `${f} ${formatDuration(st.byFeature[f], { seconds: true })}`).join(', '));
    ok(st.layers === Math.round(dz / 0.2), `${id}: layer count matches the height (${st.layers})`);
    ok(st.beads > 100 && tp.total > 60, `${id}: has beads and a plausible time`);
    // every bead lies inside the part's box and on a layer plane
    let bad = 0;
    for (let i = 0; i < st.beads; i++) {
      const z = tp.beads.p[6 * i + 2];
      if (Math.abs((z - tp.zBase) / 0.2 - Math.round((z - tp.zBase) / 0.2)) > 1e-3) bad++;
      if (tp.beads.p[6 * i] < tp.box.lo[0] - 0.5 || tp.beads.p[6 * i] > tp.box.hi[0] + 0.5) bad++;
    }
    ok(bad === 0, `${id}: beads on layer planes and inside X range (bad ${bad})`);
    // times are monotonic
    let mono = true; for (let i = 1; i < tp.track.n; i++) if (tp.track.t[i] < tp.track.t[i - 1]) { mono = false; break; }
    ok(mono, `${id}: nozzle track times are monotonic`);
    const mid = nozzleAt(tp, tp.total / 2), L = layerAt(tp, tp.total / 2);
    ok(mid.every(Number.isFinite) && L >= 0 && L < st.layers, `${id}: nozzle at half time X ${mid[0].toFixed(1)} Y ${mid[1].toFixed(1)} Z ${mid[2].toFixed(2)}, layer ${L + 1}/${st.layers}`);
    // Bambu's line-up slices are single-filament: compare without our colour-change pauses
    const noPause = tp.total - tp.changes.reduce((a, c) => a + (c.t1 - c.t0), 0);
    if (sl) ok(noPause / sl > 0.5 && noPause / sl < 1.6, `${id}: estimate without filament swaps within 0.5-1.6x of Bambu Studio (${(noPause / sl).toFixed(2)}x)`);
    if (id === 'plaque') ok(tp.changes.length === 1 && Math.abs(tp.changes[0].z - 2.6) < 1e-6, `plaque: one colour change, at the first layer above Z 2.4 (Z ${tp.changes[0]?.z.toFixed(2)})`);
  }
}

// --- G-code replay
const gfile = `shots/print3d/slice/lineup_${art}_wire/plate_1.gcode`;
if (!fs.existsSync(gfile)) console.log('skip gcode: no ' + gfile);
else {
  const text = fs.readFileSync(gfile, 'utf8');
  const t0 = performance.now();
  const g = parseGcode(text);
  const ms = performance.now() - t0;
  console.log(`  gcode: ${g.layers.length} layers, ${g.beads.n} beads, est ${formatDuration(g.total)} (header ${g.meta.estimate ? formatDuration(g.meta.estimate) : '?'}), ${g.meta.slicer}, parsed in ${ms.toFixed(0)} ms`);
  ok(g.layers.length === 45, `gcode: 45 layers like the header (${g.layers.length})`);
  ok(g.beads.n > 1000, 'gcode: extrusion beads found');
  if (g.meta.estimate) ok(g.total / g.meta.estimate > 0.6 && g.total / g.meta.estimate < 1.5, `gcode: our clock within 0.6-1.5x of the slicer's (${(g.total / g.meta.estimate).toFixed(2)}x)`);
  const m = filmTimeMap(g, { seconds: 15, fps: 30 });
  ok(m.frames === 450, 'film map: 15 s at 30 fps = 450 frames');
}
// a PrusaSlicer-style file with an M600 and an arc (synthetic, always runs)
{
  const L = ['; generated by PrusaSlicer 2.8.0', '; estimated printing time (normal mode) = 1m 30s', 'G90', 'M83', 'G1 Z0.2 F600'];
  for (let l = 0; l < 6; l++) {
    L.push(';LAYER_CHANGE', `;Z:${(0.2 * (l + 1)).toFixed(1)}`, `G1 Z${(0.2 * (l + 1)).toFixed(1)}`);
    if (l === 3) L.push('M600');
    L.push(';TYPE:External perimeter', 'G1 X10 Y10 F3000', 'G1 X50 Y10 E2', 'G1 X50 Y50 E2', 'G1 X10 Y50 E2', 'G1 X10 Y10 E2', ';TYPE:Solid infill', 'G2 X30 Y30 I10 J10 E1');
  }
  const g = parseGcode(L.join(String.fromCharCode(10)));
  ok(g.layers.length === 6 && g.meta.slicer.startsWith('PrusaSlicer') && g.printer.id === 'mk4', `prusa gcode: 6 layers, ${g.meta.slicer}, ${g.printer.name}`);
  ok(g.changes.length === 1 && Math.abs(g.changes[0].z - 0.8) < 1e-6 && g.changes[0].from !== g.changes[0].to, `prusa gcode: M600 at Z ${g.changes[0]?.z} from ${g.changes[0]?.from} to ${g.changes[0]?.to}`);
  ok(Math.abs(g.total - 90) < 1e-6, `prusa gcode: clock scaled to the header estimate (${g.total.toFixed(1)} s)`);
  const bz = new Set(); for (let i = 0; i < g.beads.n; i++) bz.add(g.beads.c[i]);
  ok(bz.size === 2, 'prusa gcode: beads in two colours');
}
// a Bambu .gcode.3mf (zip with Metadata/plate_1.gcode)
const g3 = `shots/print3d/slice/lineup_${art}_wire/sliced.3mf`;
if (fs.existsSync(g3)) {
  const u8 = new Uint8Array(fs.readFileSync(g3));
  const { text, name } = await readGcodeFile(u8);
  const plain = fs.existsSync(gfile) ? fs.readFileSync(gfile, 'utf8') : null;
  ok(name === 'Metadata/plate_1.gcode' && (!plain || text === plain), `.gcode.3mf: read ${name}, ${text.length} chars${plain ? ', identical to plate_1.gcode' : ''}`);
}
const m6 = `shots/print3d/slice/lineup_${art}_plaque_m600/plate_1.gcode`;
if (fs.existsSync(m6)) {
  const g = parseGcode(fs.readFileSync(m6, 'utf8'));
  console.log(`  m600 gcode: ${g.layers.length} layers, changes ${g.changes.length}, palette ${g.palette.join(' ')}`);
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
