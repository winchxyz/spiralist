// Probe: can two colours on ONE extruder be baked into the file? The Line art plaque with a filament change
// (M600) written into the 3MF (Metadata/custom_gcode_per_layer.xml), sliced by the Bambu Studio CLI,
// then the G-code is searched for the change and the layer it sits on.
//   node tests/print3d_lineup_m600.mjs (needs shots/print3d/geom_bust_lineart.json)
// Exit 1 = no change found in the G-code. Result 2026-09-24: the Bambu Studio CLI slices the file but
// ignores the per-layer change (18 layers, no M600 / M620 at Z 2.6), so two colours stay a manual step.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProduct } from '../js/print3d/products.js';
import { write3MFBytes } from '../js/print3d/mesh.js';

const j = JSON.parse(fs.readFileSync('shots/print3d/geom_bust_lineart.json', 'utf8'));
const buf = Buffer.from(j.data, 'base64');
const geom = { ...j.meta, data: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), n: j.meta.n };
// no feet: a filament change applies to everything on the plate, and the feet would come out two-tone
const out = buildProduct('plaque', geom, { stand: false });
const at = out.settings.colorChangeAtMm;
const line = out.parts.find(p => /line/i.test(p.name));
const tag = 'lineup_lineart_plaque_m600';
const file = `shots/print3d/${tag}.3mf`;
fs.writeFileSync(file, await write3MFBytes(out.parts, { title: 'Spiralist plaque (M600)', colorChanges: [{ atMm: at, color: line.color }] }));
console.log('wrote', file, 'colour change after Z', at, 'mm; parts', out.stats.partsMm.map(p => `${p.name} X 0-${p.x}, Y 0-${p.y}, Z 0-${p.z} mm`).join('; '));
const r = spawnSync(process.execPath, ['tests/print3d_slice.mjs', file], { encoding: 'utf8', timeout: 600000 });
console.log(r.stdout.trim());
const dir = path.join('shots/print3d/slice', tag);
const g = fs.readdirSync(dir).find(n => n.endsWith('.gcode'));
if (!g) { console.log('no G-code'); process.exit(1); }
const lines = fs.readFileSync(path.join(dir, g), 'utf8').split('\n');
let z = null, found = [];
const zs = new Set();
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^; Z_HEIGHT: ([\d.]+)/); if (m) { z = +m[1]; zs.add(z); }
  if (/^M600\b|; COLOR_CHANGE|;COLOR_CHANGE|; FILAMENT_CHANGE/.test(lines[i])) found.push({ line: i + 1, text: lines[i].trim(), afterZ: z });
}
console.log(`${zs.size} layers (Z ${Math.min(...zs)}-${Math.max(...zs)} mm); colour change markers: ${found.length}`);
for (const f of found.slice(0, 6)) console.log(`   line ${f.line}: "${f.text}" (last layer before it: Z ${f.afterZ})`);
process.exit(found.length ? 0 : 1);
