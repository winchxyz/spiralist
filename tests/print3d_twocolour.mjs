// Two-colour plaque check: writes the lineart plaque without stands (hang: 'holes') as a 3MF via
// js/print3d/mesh.js, so a slice shows whether the Line part stays on top of the plate (max Z 3.6 mm)
// rather than being dropped to the bed.
//   node tests/print3d_twocolour.mjs && node tests/print3d_slice.mjs shots/print3d/prod_plaque2c_lineart.3mf
import fs from 'node:fs';
import { buildProduct } from '../js/print3d/products.js';
import { write3MFBytes } from '../js/print3d/mesh.js';

const j = JSON.parse(fs.readFileSync('shots/print3d/geom_bust_lineart.json', 'utf8'));
const buf = Buffer.from(j.data, 'base64');
const geom = { ...j.meta, data: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), n: j.meta.n };
const out = buildProduct('plaque', geom, { hang: 'holes' });
let bytes = await write3MFBytes(out.parts, { title: 'Spiralist relief plaque (two colours)' });
if (bytes instanceof Blob) bytes = new Uint8Array(await bytes.arrayBuffer());
fs.writeFileSync('shots/print3d/prod_plaque2c_lineart.3mf', bytes);
console.log(out.parts.map(p => p.name).join(' + '), JSON.stringify(out.sizeMm), 'colour change at', out.settings.colorChangeAtMm, 'mm');
