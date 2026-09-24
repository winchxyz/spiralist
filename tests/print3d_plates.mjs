// The 3MF carries what the dialog promises: per-object print settings (infill, walls, brim),
// the feet or a two-colour stamp on plate 2, and a large plaque that slices at all. Builds the
// products in node the way the dialog exports them, writes 3MFs, and slices each one with the
// Bambu Studio CLI (A2L 0.4, 0.20 Standard, PETG Basic; profiles from tests/print3d_slice.mjs),
// WITHOUT --arrange, so the file's own plates and placement are what gets sliced.
//   node tests/print3d_plates.mjs [--no-slice]
// Writes shots/print3d/plates/*.3mf and prints, per file: plates, objects, settings, slice result.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProduct } from '../js/print3d/products.js';
import { write3MFBytes, bounds } from '../js/print3d/mesh.js';
import { inflateRawSync } from 'node:zlib';

function unzipSync(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip: no end record');
  const count = dv.getUint16(e + 10, true);
  let o = dv.getUint32(e + 16, true);
  const files = {}, dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    const method = dv.getUint16(o + 10, true), csize = dv.getUint32(o + 20, true);
    const nlen = dv.getUint16(o + 28, true), xlen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true), lho = dv.getUint32(o + 42, true);
    const name = dec.decode(u8.subarray(o + 46, o + 46 + nlen));
    const ln = dv.getUint16(lho + 26, true), lx = dv.getUint16(lho + 28, true);
    const body = u8.subarray(lho + 30 + ln + lx, lho + 30 + ln + lx + csize);
    files[name] = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    o += 46 + nlen + xlen + clen;
  }
  return files;
}

const OUT = path.resolve('shots/print3d/plates');
fs.mkdirSync(OUT, { recursive: true });
const geom = kind => {
  const j = JSON.parse(fs.readFileSync(`shots/print3d/geom_bust_${kind}.json`, 'utf8'));
  j.data = Float32Array.from(j.data);
  return j;
};
const A2L = { x: 330, y: 320 };
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const only = arg('--only')?.split(',');
const arachne = !process.argv.includes('--classic');   // --classic: the plaque without wall_generator=arachne
function headShoulders() {   // a features.silhouette outline (frame fractions), as in tests/print3d_options.mjs
  const pts = [];
  for (let k = 0; k < 200; k++) {
    const a = k / 200 * 2 * Math.PI, x = Math.cos(a), y = Math.sin(a);
    const r = y < 0.2 ? 0.28 : 0.28 + 0.14 * Math.pow((y - 0.2) / 0.8, 0.7) * Math.abs(x) * 1.8;
    pts.push(0.5 + r * x, 0.5 + r * y * 1.25);
  }
  return new Float32Array(pts);
}
const S = {
  plaque: { sparse_infill_density: '15%', ...(arachne ? { wall_generator: 'arachne' } : {}) },
  litho: { sparse_infill_density: '100%', brim_type: 'outer_only', brim_width: '5' },
  cutter: { wall_loops: '3', sparse_infill_density: '20%' },
};
// (the dialog's plateOf / objectPlan, for the cases tested here)
const cases = [
  { tag: 'plaque_300_feet_plate2', kind: 'lineart', product: 'plaque', opts: { sizeMm: 300, stand: true },
    objects: parts => [{ name: 'Plaque', parts: [0, 1], plate: 1, settings: S.plaque }, ...parts.slice(2).map((p, k) => ({ name: p.name, parts: [k + 2], plate: 2, settings: { sparse_infill_density: '15%' } }))],
    slots: [1, 2, 1, 1], colors: ['#FFFFFF', '#000000', '#FFFFFF', '#FFFFFF'] },
  { tag: 'litho_100_brim', kind: 'lineart', product: 'litho', opts: { sizeMm: 100 },
    objects: () => [{ name: 'Lithophane', parts: [0], plate: 1, settings: S.litho }], slots: [1], colors: ['#FFFFFF'] },
  { tag: 'cutter_twocolour_plate2', kind: 'lineart', product: 'cutter', opts: { sizeMm: 90, silhouette: { outlines: [headShoulders()] } },
    objects: parts => [{ name: 'Cutter', parts: [0], plate: 1, settings: S.cutter }, { name: 'Stamp', parts: [1, 2], plate: 2, settings: S.cutter }, ...(parts[3] ? [{ name: 'Stamp handle', parts: [3], plate: 2, settings: S.cutter }] : [])],
    slots: [1, 2, 2, 2], colors: ['#FF6A13', '#FFFFFF', '#FFFFFF', '#FFFFFF'] },
];

const slice = !process.argv.includes('--no-slice');
const SL = path.resolve('shots/print3d/slice');
let bad = 0;
for (const c0 of cases) {
  if (only && !only.includes(c0.tag)) continue;
  const c = { ...c0, tag: c0.tag + (arachne || c0.product !== 'plaque' ? '' : '_classic') };
  const out = buildProduct(c.product, geom(c.kind), c.opts);
  const parts = out.parts.map((p, k) => ({ name: p.name, mesh: p.mesh, color: c.colors[k] || '#FFFFFF', slot: c.slots[k] || 1 }));
  const objects = c.objects(parts);
  const bytes = await write3MFBytes(parts, { title: c.tag, objects, bed: A2L });
  const file = path.join(OUT, `${c.tag}.3mf`);
  fs.writeFileSync(file, bytes);
  const z = unzipSync(fs.readFileSync(file));
  const cfg = new TextDecoder().decode(z['Metadata/model_settings.config']);
  const plates = (cfg.match(/<plate>/g) || []).length, objs = (cfg.match(/<object id=/g) || []).length;
  const keys = [...cfg.matchAll(/key="(sparse_infill_density|wall_loops|brim_type|brim_width|wall_generator)" value="([^"]+)"/g)].map(m => `${m[1]}=${m[2]}`);
  console.log(`${c.tag}: ${parts.map(p => { const b = bounds(p.mesh); return `${p.name} X 0-${(b.x[1] - b.x[0]).toFixed(1)}, Y 0-${(b.y[1] - b.y[0]).toFixed(1)}, Z ${b.z[0].toFixed(1)}-${b.z[1].toFixed(1)} mm`; }).join('; ')}`);
  console.log(`   ${objs} objects on ${plates} plate(s); settings ${[...new Set(keys)].join(', ')}`);
  if (!slice) continue;
  const dir = path.join(OUT, c.tag);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const fil = path.join(SL, 'filament.json');
  const args = ['--load-settings', `${path.join(SL, 'machine.json')};${path.join(SL, 'process.json')}`, '--load-filaments', `${fil};${fil}`,
    '--slice', '0', '--debug', '1', '--outputdir', dir, '--export-3mf', 'sliced.3mf', file];
  const r = spawnSync('C:/Program Files/Bambu Studio/bambu-studio.exe', args, { encoding: 'utf8', timeout: 1500000 });
  let result = null; try { result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch { /* none */ }
  const sliced = fs.existsSync(path.join(dir, 'sliced.3mf'));
  const ok = r.status === 0 && sliced;
  if (!ok) bad++;
  let per = '';
  if (sliced) {
    const zz = unzipSync(fs.readFileSync(path.join(dir, 'sliced.3mf')));
    const gcodes = Object.keys(zz).filter(n => /^Metadata\/plate_\d+\.gcode$/.test(n)).sort();
    per = gcodes.map(n => {
      const g = new TextDecoder().decode(zz[n]);
      const t = (g.match(/total estimated time: ([^\n;]+)/) || g.match(/model printing time: ([^\n;]+)/) || [])[1];
      const w = (g.match(/total filament weight \[g\] : ([\d.,]+)/) || [])[1];
      const brim = /;\s*FEATURE: Brim/.test(g) || /TYPE:Brim/.test(g);
      const inf = (g.match(/; sparse_infill_density = ([^\n]+)/) || [])[1];
      const walls = (g.match(/; wall_loops = ([^\n]+)/) || [])[1];
      const gen = (g.match(/; wall_generator = ([^\n]+)/) || [])[1];
      return `${n.replace('Metadata/', '')}: ${t?.trim()}, ${w} g, brim ${brim ? 'yes' : 'no'}, header infill ${inf}, walls ${walls}, generator ${gen}`;
    }).join(' | ');
  }
  console.log(`   ${ok ? 'SLICED' : 'FAILED'} exit ${r.status}; ${per || (r.stdout || '').slice(-400)}`);
}
console.log(bad ? `${bad} failed` : 'all ok');
process.exitCode = bad ? 1 : 0;
