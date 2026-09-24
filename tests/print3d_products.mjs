// Print products (js/print3d/products.js) on real app geometries, no browser.
//   node tests/print3d_products.mjs [--only plaque,wire,litho,cutter] [--geoms spiral,contour,real,lineart] [--no-files]
// Needs the captures from tests/print3d_capture.mjs in shots/print3d/geom_bust_<kind>.json.
// Writes per build: shots/print3d/<product>_<geom>.3mf and .stl (all parts merged), and a
// top-down hill-shaded preview <product>_<geom>_top.png; prints sizes, mesh checks and notes.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildProduct, describe, PRODUCTS } from '../js/print3d/products.js';
import * as K from '../js/print3d/pkit.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', 'plaque,wire,litho,cutter').split(',');
const kinds = opt('geoms', 'spiral,contour,real,lineart').split(',');
const sample = opt('sample', 'bust');
const files = !args.includes('--no-files');
const OUT = 'shots/print3d';

export function loadGeom(kind, smp = sample) {
  const j = JSON.parse(fs.readFileSync(`${OUT}/geom_${smp}_${kind}.json`, 'utf8'));
  const buf = Buffer.from(j.data, 'base64');
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { ...j.meta, data, n: j.meta.n };
}

// ---- tiny PNG writer + top-down hillshade of parts
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buf) { let c = -1; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ -1) >>> 0; }
const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** Orthographic render: view 'top' or 'iso' (yaw 30, pitch 35), z-buffered, lambert + ambient. */
export function renderPNG(parts, { px = 900, view = 'top' } = {}) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const yaw = view === 'iso' ? -0.5 : 0, pitch = view === 'iso' ? 0.95 : Math.PI / 2;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // camera: rotate about Z by yaw, then tilt: screen x = x', screen y = y' * sp + z * cp (up), depth = z*sp - y'*cp
  const proj = (x, y, z) => { const xr = x * cy - y * sy, yr = x * sy + y * cy; return [xr, yr * sp + z * cp, z * sp - yr * cp]; };
  const PP = parts.map(p => { const P = p.mesh.positions, Q = new Float32Array(P.length); for (let i = 0; i < P.length; i += 3) { const q = proj(P[i], P[i + 1], P[i + 2]); Q[i] = q[0]; Q[i + 1] = q[1]; Q[i + 2] = q[2]; for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); } } return Q; });
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]) * 1.04, s = px / span;
  const W = Math.ceil((hi[0] - lo[0]) * s * 1.04) + 8, H = Math.ceil((hi[1] - lo[1]) * s * 1.04) + 8;
  const img = new Uint8ClampedArray(W * H * 4), zb = new Float32Array(W * H).fill(-Infinity);
  for (let i = 0; i < W * H; i++) { img[4 * i] = 214; img[4 * i + 1] = 218; img[4 * i + 2] = 222; img[4 * i + 3] = 255; }
  const L = (() => { const v = [-0.45, 0.55, 0.7]; const l = Math.hypot(...v); return v.map(a => a / l); })();
  parts.forEach((p, pi) => {
    const Q = PP[pi], P = p.mesh.positions, T = p.mesh.indices, col = hex(p.color || '#888888');
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      // world normal for shading
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const X = [Q[a], Q[b], Q[c]].map(v => (v - lo[0]) * s + 4), Y = [Q[a + 1], Q[b + 1], Q[c + 1]].map(v => H - ((v - lo[1]) * s + 4)), Z = [Q[a + 2], Q[b + 2], Q[c + 2]];
      const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
      if (area >= 0) continue;          // back face (screen y is flipped)
      const lam = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const sh = 0.38 + 0.62 * lam;
      const x0 = Math.max(0, Math.floor(Math.min(...X))), x1 = Math.min(W - 1, Math.ceil(Math.max(...X)));
      const y0 = Math.max(0, Math.floor(Math.min(...Y))), y1 = Math.min(H - 1, Math.ceil(Math.max(...Y)));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px_ = x + 0.5, py_ = y + 0.5;
        const w0 = ((X[1] - px_) * (Y[2] - py_) - (X[2] - px_) * (Y[1] - py_)) / area;
        const w1 = ((X[2] - px_) * (Y[0] - py_) - (X[0] - px_) * (Y[2] - py_)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * Z[0] + w1 * Z[1] + w2 * Z[2];
        const i = y * W + x;
        if (z <= zb[i]) continue;
        zb[i] = z;
        img[4 * i] = col[0] * sh; img[4 * i + 1] = col[1] * sh; img[4 * i + 2] = col[2] * sh;
      }
    }
  });
  return png(W, H, img);
}

// ---- run
fs.mkdirSync(OUT, { recursive: true });
let mesh3mf = null;
try { mesh3mf = await import('../js/print3d/mesh.js'); } catch (e) { console.log('mesh.js not usable in node:', e.message); }
const results = [];
let fails = 0;
for (const kind of kinds) {
  let geom;
  try { geom = loadGeom(kind); } catch (e) { console.log('skip', kind, e.message); continue; }
  for (const id of only) {
    const tag = sample === 'bust' ? `prod_${id}_${kind}` : `prod_${sample}_${id}_${kind}`;
    let out;
    try { out = buildProduct(id, geom, {}); }
    catch (e) { fails++; console.log('FAIL', tag, e.stack); continue; }
    console.log('\n' + tag + ' | ' + describe(out) + ` | ${out.stats.ms} ms`);
    for (const m of out.stats.manifold) console.log(`   ${m.ok ? 'ok ' : 'BAD'} ${m.name} volume ${m.volumeMm3} mm3`);
    console.log('   parts: ' + out.stats.partsMm.map(p => `${p.name} X 0-${p.x}, Y 0-${p.y}, Z 0-${p.z} mm`).join('; '));
    for (const n of out.printability.notes) console.log('   - ' + n);
    const bad = out.stats.manifold.filter(m => !m.ok);
    if (bad.length) fails++;
    results.push({ tag, size: out.sizeMm, ok: out.printability.ok, notes: out.printability.notes, stats: out.stats, settings: out.settings });
    if (files) {
      fs.writeFileSync(`${OUT}/${tag}_top.png`, renderPNG(out.parts, { px: 900, view: 'top' }));
      fs.writeFileSync(`${OUT}/${tag}_iso.png`, renderPNG(out.parts, { px: 900, view: 'iso' }));
      if (out.extras?.backlit) { const b = out.extras.backlit, img = new Uint8ClampedArray(b.w * b.h * 4); for (let i = 0; i < b.w * b.h; i++) { const v = Math.min(255, 255 * b.data[i]); img[4 * i] = v; img[4 * i + 1] = v * 0.93; img[4 * i + 2] = v * 0.8; img[4 * i + 3] = 255; } fs.writeFileSync(`${OUT}/${tag}_backlit.png`, png(b.w, b.h, img)); }
      fs.writeFileSync(`${OUT}/${tag}.stl`, Buffer.from(K.writeSTL(K.merge(out.parts.map(p => p.mesh)), tag)));
      let bytes;
      if (mesh3mf?.write3MFBytes) {
        try { bytes = await mesh3mf.write3MFBytes(out.parts, { title: `Spiralist ${out.product.name}` }); } catch (e) { console.log('   mesh.js 3MF failed:', e.message); }
      }
      if (!bytes) bytes = K.write3MF(out.parts, { title: `Spiralist ${out.product.name}` });
      if (bytes instanceof Blob) bytes = new Uint8Array(await bytes.arrayBuffer());
      fs.writeFileSync(`${OUT}/${tag}.3mf`, bytes);
    }
  }
}
fs.writeFileSync(`${OUT}/products_report${sample === 'bust' ? '' : '_' + sample}.json`, JSON.stringify(results, null, 1));
console.log(`\n${results.length} builds, ${fails} failures`);
process.exit(fails ? 1 : 0);
