// Re-read the files the real 3D print dialog exported (tests/print3d_dialog.mjs --export):
// every 3MF is unzipped (CRC and size checked), its model XML balanced, its meshes counted and
// checked watertight, and its colours / Bambu filament slots listed; every STL (or zip of STLs)
// is re-read and checked watertight after welding.
//   node tests/print3d_dialog_check.mjs [shots/print3d/dlg_*.3mf ...]
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { readSTL, checkManifold } from '../js/print3d/mesh.js';

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = u8 => { let c = -1; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip: no end record');
  const count = dv.getUint16(e + 10, true);
  let o = dv.getUint32(e + 16, true);
  const files = {}, dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    const method = dv.getUint16(o + 10, true), crc = dv.getUint32(o + 16, true), csize = dv.getUint32(o + 20, true), usize = dv.getUint32(o + 24, true);
    const nlen = dv.getUint16(o + 28, true), xlen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true), lho = dv.getUint32(o + 42, true);
    const name = dec.decode(u8.subarray(o + 46, o + 46 + nlen));
    const ln = dv.getUint16(lho + 26, true), lx = dv.getUint16(lho + 28, true);
    const body = u8.subarray(lho + 30 + ln + lx, lho + 30 + ln + lx + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`zip: ${name} size/crc mismatch`);
    files[name] = data;
    o += 46 + nlen + xlen + clen;
  }
  return files;
}
function balanced(xml) {
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[0].startsWith('<?')) continue;
    if (m[3] === '/') continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0;
}
function meshesFrom3MF(xml) {
  const out = [];
  for (const om of xml.matchAll(/<object id="(\d+)"[^>]*?(?:name="([^"]*)")?[^>]*>([\s\S]*?)<\/object>/g)) {
    const body = om[3];
    if (!/<mesh>/.test(body)) continue;
    const V = [...body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap(m => [+m[1], +m[2], +m[3]]);
    const T = [...body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap(m => [+m[1], +m[2], +m[3]]);
    out.push({ id: om[1], name: om[2] || om[1], mesh: { positions: Float32Array.from(V), indices: Uint32Array.from(T) } });
  }
  return out;
}

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync('shots/print3d').filter(n => /^dlg_.*\.(3mf|stl|zip)$/.test(n)).map(n => path.join('shots/print3d', n));
let bad = 0;
for (const f of files) {
  const u8 = new Uint8Array(fs.readFileSync(f));
  try {
    if (f.endsWith('.3mf')) {
      const z = unzip(u8);
      const xml = new TextDecoder().decode(z['3D/3dmodel.model']);
      const ok = balanced(xml) && /xmlns="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/core\/2015\/02"/.test(xml);
      const colors = [...xml.matchAll(/displaycolor="(#[0-9A-Fa-f]+)"/g)].map(m => m[1]);
      const meshes = meshesFrom3MF(xml);
      const man = meshes.map(m => { const c = checkManifold(m.mesh); return `${m.name}:${c.welded.openEdges === 0 && c.welded.nonManifold === 0 && c.volume > 0 ? 'ok' : 'OPEN'}`; });
      const ms = z['Metadata/model_settings.config'] ? new TextDecoder().decode(z['Metadata/model_settings.config']) : '';
      const slots = [...ms.matchAll(/<part id="\d+"[^>]*>\s*<metadata key="name" value="([^"]+)"\/>\s*<metadata key="extruder" value="(\d+)"/g)].map(m => `${m[1]}=${m[2]}`);
      const proj = z['Metadata/project_settings.config'] ? JSON.parse(new TextDecoder().decode(z['Metadata/project_settings.config'])).filament_colour : [];
      const cc = z['Metadata/custom_gcode_per_layer.xml'] ? 'colour change: ' + (new TextDecoder().decode(z['Metadata/custom_gcode_per_layer.xml']).match(/top_z="([^"]+)"/)?.[1] + ' mm') : '';
      const allOk = ok && man.every(s => s.endsWith(':ok')) && meshes.length > 0;
      if (!allOk) bad++;
      console.log(`${allOk ? 'OK  ' : 'BAD '} ${path.basename(f)} ${(u8.length / 1024).toFixed(0)} KB: xml ${ok ? 'balanced, core ns' : 'BROKEN'}; ${meshes.length} meshes ${meshes.reduce((s, m) => s + m.mesh.indices.length / 3, 0)} tris [${man.join(' ')}]; colours ${colors.join(' ')}; slots ${slots.join(' ')}; filament_colour ${JSON.stringify(proj)} ${cc}`);
    } else {
      const stls = f.endsWith('.zip') ? Object.entries(unzip(u8)) : [[path.basename(f), u8]];
      const res = stls.map(([n, d]) => { const m = readSTL(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)); const c = checkManifold(m.mesh || m); return { n, ok: c.welded.openEdges === 0 && c.welded.nonManifold === 0 && c.volume > 0, tris: c.triangles }; });
      const allOk = res.every(r => r.ok);
      if (!allOk) bad++;
      console.log(`${allOk ? 'OK  ' : 'BAD '} ${path.basename(f)} ${(u8.length / 1024).toFixed(0)} KB: ${res.map(r => `${r.n} ${r.tris} tris ${r.ok ? 'watertight' : 'OPEN'}`).join('; ')}`);
    }
  } catch (e) { bad++; console.log('BAD ', f, e.message); }
}
console.log(bad ? `${bad} file(s) failed` : `all ${files.length} files ok`);
process.exit(bad ? 1 : 0);
