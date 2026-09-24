// Option paths of the print products that the default line-up does not take:
// wire + stand, plaque with hanging holes, flat lithophane, sizes. Every part must be watertight.
//   node tests/print3d_options.mjs
import fs from 'node:fs';
import { buildProduct, describe } from '../js/print3d/products.js';

function loadGeom(kind) {
  const j = JSON.parse(fs.readFileSync(`shots/print3d/geom_bust_${kind}.json`, 'utf8'));
  const buf = Buffer.from(j.data, 'base64');
  return { ...j.meta, data: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), n: j.meta.n };
}
const cases = [
  ['wire', 'lineart', { stand: true }],
  ['wire', 'lineart', { sizeMm: 120, loopAt: 'start' }],
  ['plaque', 'lineart', { hang: 'holes', sizeMm: 200 }],
  ['plaque', 'spiral', { sizeMm: 100 }],
  ['plaque', 'real', { sizeMm: 300 }],
  ['litho', 'real', { orient: 'flat', sizeMm: 120 }],
  ['cutter', 'lineart', { sizeMm: 70 }],
  ['cutter', 'lineart', { sizeMm: 400 }],
  // a features.silhouette as js/lineart/silhouette.js returns it (frame fractions): a head-and-shoulders
  ['cutter', 'lineart', { silhouette: { outlines: [headShoulders()] } }],
];
function headShoulders() {
  const pts = [];
  for (let k = 0; k < 200; k++) {
    const a = k / 200 * 2 * Math.PI;
    // head circle on top of a wide rounded body: union radius in polar form around (0.5, 0.55)
    const x = Math.cos(a), y = Math.sin(a);
    const r = y < 0.2 ? 0.28 : 0.28 + 0.14 * Math.pow((y - 0.2) / 0.8, 0.7) * Math.abs(x) * 1.8;
    pts.push(0.5 + r * x, 0.5 + r * y * 1.25);
  }
  return new Float32Array(pts);
}
let fails = 0;
for (const [id, kind, opts] of cases) {
  const out = buildProduct(id, loadGeom(kind), opts);
  const bad = out.stats.manifold.filter(m => !m.ok);
  if (bad.length) fails++;
  console.log(`${id} ${kind} ${JSON.stringify(opts, (k, v) => v instanceof Float32Array ? `[${v.length / 2} points]` : v)}\n   ${describe(out)}\n   parts: ${out.stats.partsMm.map(p => `${p.name} X 0-${p.x}, Y 0-${p.y}, Z 0-${p.z} mm`).join('; ')}` +
    (bad.length ? `\n   BAD: ${bad.map(b => b.name).join(', ')}` : '') + (out.printability.issues.length ? `\n   issues: ${out.printability.issues.join(' | ')}` : ''));
}
console.log(fails ? `${fails} FAILED` : 'all watertight');
process.exit(fails ? 1 : 0);
