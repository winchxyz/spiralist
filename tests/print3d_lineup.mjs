// Line-up builds for the print products: products A-D x three arts, files + manifold checks + Bambu slices.
//   node tests/print3d_lineup.mjs [--no-slice] [--only plaque,wire,litho,cutter] [--arts spiral,lineart,catreal]
// Needs the captures in shots/print3d/geom_<sample>_<kind>.json (tests/print3d_capture.mjs).
// Writes shots/print3d/lineup_<art>_<product>.3mf / .stl, slices each 3MF with tests/print3d_slice.mjs
// (Bambu Studio CLI, A2L 0.4 + 0.20mm Standard + PETG Basic) and writes shots/print3d/lineup_report.json,
// which dev/print3d_lineup.html reads for the labels.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProduct, PRODUCTS } from '../js/print3d/products.js';
import * as M from '../js/print3d/mesh.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const OUT = 'shots/print3d';
export const ARTS = [
  { key: 'spiral', sample: 'bust', kind: 'spiral', label: 'Artistic spiral · plaster bust' },
  { key: 'lineart', sample: 'bust', kind: 'lineart', label: 'Line art (Matisse) · bust' },
  { key: 'catreal', sample: 'cat', kind: 'real', label: 'Realistic squiggle · cat' },
];
// options used for the line-up (also used by dev/print3d_lineup.js so the renders match the files)
export const LINEUP_OPTS = { wire: { stand: true } };
const only = opt('only', PRODUCTS.map(p => p.id).join(',')).split(',');
const arts = opt('arts', ARTS.map(a => a.key).join(',')).split(',');

function loadGeom(sample, kind) {
  const j = JSON.parse(fs.readFileSync(`${OUT}/geom_${sample}_${kind}.json`, 'utf8'));
  const buf = Buffer.from(j.data, 'base64');
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { ...j.meta, data, n: j.meta.n };
}

const report = { when: new Date().toISOString(), printer: 'Bambu Lab A2L 0.4 nozzle', process: '0.20mm Standard @BBL A2L', filament: 'Bambu PETG Basic @BBL A2L 0.4 nozzle', cells: [] };
let fails = 0;
for (const art of ARTS.filter(a => arts.includes(a.key))) {
  const geom = loadGeom(art.sample, art.kind);
  for (const id of only) {
    const tag = `lineup_${art.key}_${id}`;
    const t0 = Date.now();
    let out;
    try { out = buildProduct(id, geom, LINEUP_OPTS[id] || {}); }
    catch (e) { fails++; console.log('FAIL', tag, e.stack); report.cells.push({ tag, art: art.key, id, error: e.message }); continue; }
    const ms = Date.now() - t0;
    // independent manifold check with MESH (index + welded) per part
    const manifold = out.parts.map(p => {
      const c = M.checkManifold(p.mesh);
      return { name: p.name, ok: c.ok && c.welded.openEdges === 0 && c.welded.nonManifold === 0 && c.volume > 0, openEdges: c.openEdges, nonManifold: c.nonManifold, weldedOpen: c.welded.openEdges, weldedNonManifold: c.welded.nonManifold, volumeMm3: Math.round(c.volume), triangles: c.triangles };
    });
    const allOk = manifold.every(m => m.ok);
    if (!allOk) fails++;
    const merged = M.merge(out.parts.map(p => p.mesh));
    fs.writeFileSync(`${OUT}/${tag}.stl`, Buffer.from(M.writeSTL(merged, tag)));
    const bytes = await M.write3MFBytes(out.parts, { title: `Spiralist ${out.product.name} (${art.label})` });
    fs.writeFileSync(`${OUT}/${tag}.3mf`, bytes);
    const cell = {
      tag, art: art.key, artLabel: art.label, id, letter: out.product.letter, name: out.product.name,
      sizeMm: out.sizeMm, partsMm: out.stats.partsMm, triangles: out.stats.triangles, buildMs: ms,
      manifold, manifoldOk: allOk, printability: out.printability, settings: out.settings,
      files: [`${OUT}/${tag}.3mf`, `${OUT}/${tag}.stl`],
    };
    report.cells.push(cell);
    console.log(`${tag}: ${ms} ms, ${out.stats.triangles} tris, manifold ${allOk ? 'ok' : 'BAD'}, printable ${out.printability.ok}`);
    console.log('   parts: ' + out.stats.partsMm.map(p => `${p.name} X 0-${p.x}, Y 0-${p.y}, Z 0-${p.z} mm`).join('; '));
    for (const n of out.printability.issues || []) console.log('   ISSUE ' + n);
  }
}
fs.writeFileSync(`${OUT}/lineup_report.json`, JSON.stringify(report, null, 1));

if (!args.includes('--no-slice')) {
  const files = report.cells.filter(c => !c.error).map(c => `${OUT}/${c.tag}.3mf`);
  const r = spawnSync(process.execPath, ['tests/print3d_slice.mjs', ...files], { encoding: 'utf8', timeout: 1800000 });
  console.log(r.stdout.split('\n').filter(l => /SLICED|FAILED|triangles|stderr/.test(l)).join('\n'));
  for (const c of report.cells) {
    if (c.error) continue;
    const dir = path.join(OUT, 'slice', c.tag);
    let res = null;
    try { res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch { }
    const pl = res?.sliced_plates?.[0];
    const gcodeOk = fs.existsSync(path.join(dir, 'sliced.3mf'));
    c.slice = {
      ok: !!res && res.return_code === 0 && gcodeOk,
      returnCode: res?.return_code ?? null, error: res?.error_string ?? null,
      minutes: pl ? Math.round(pl.total_predication / 60) : null,
      grams: pl ? +pl.filaments.reduce((s, f) => s + f.total_used_g, 0).toFixed(1) : null,
      triangles: pl?.triangle_count ?? null, warnings: pl?.warning_message || null,
    };
    if (!c.slice.ok) fails++;
  }
  fs.writeFileSync(`${OUT}/lineup_report.json`, JSON.stringify(report, null, 1));
  for (const c of report.cells) if (c.slice) console.log(`${c.tag}: slice ${c.slice.ok ? 'ok' : 'FAIL ' + c.slice.error}, ${c.slice.minutes} min, ${c.slice.grams} g`);
}
console.log(`${report.cells.length} cells, ${fails} failures`);
process.exit(fails ? 1 : 0);
