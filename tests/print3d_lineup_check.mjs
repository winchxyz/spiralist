// Re-checks the line-up files written by tests/print3d_lineup.mjs: every STL is re-read and must be
// watertight after welding; the Bambu slicer's triangle count must equal ours; the sliced 3MF must exist.
//   node tests/print3d_lineup_check.mjs
import fs from 'node:fs';
import { readSTL, checkManifold, bounds } from '../js/print3d/mesh.js';

const rep = JSON.parse(fs.readFileSync('shots/print3d/lineup_report.json', 'utf8'));
let bad = 0;
for (const c of rep.cells) {
  const buf = fs.readFileSync(`shots/print3d/${c.tag}.stl`);
  const m = readSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const k = checkManifold(m);
  const b = bounds(m);
  const stlOk = k.welded.openEdges === 0 && k.welded.nonManifold === 0 && k.volume > 0;
  const triOk = c.slice?.triangles === c.triangles;
  const sliced = fs.existsSync(`shots/print3d/slice/${c.tag}/sliced.3mf`);
  const ok = stlOk && triOk && sliced && c.manifoldOk && c.slice?.ok;
  if (!ok) bad++;
  const r = a => `${a[0].toFixed(1)}-${a[1].toFixed(1)}`, sz = `X ${r(b.x)}, Y ${r(b.y)}, Z ${r(b.z)} mm`;
  console.log(`${ok ? 'ok ' : 'BAD'} ${c.tag}: STL ${k.triangles} tris welded open ${k.welded.openEdges} nonmanifold ${k.welded.nonManifold} vol ${Math.round(k.volume)} mm3; slicer tris ${c.slice?.triangles} (${triOk ? 'match' : 'MISMATCH'}); ${c.slice?.minutes} min ${c.slice?.grams} g; bed layout ${sz}`);
}
console.log(`${rep.cells.length - bad}/${rep.cells.length} ok`);
process.exit(bad ? 1 : 0);
