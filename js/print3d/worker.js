// 3D print worker: builds a product's meshes (products.js) and writes the files (mesh.js) off the
// main thread, so the page never freezes on a 300k-triangle lithophane.
//   { id, cmd: 'build', product, geom, opts }  -> { id, ok, result }  (mesh arrays are copies, transferred)
//   { id, cmd: 'export', format: '3mf' | 'stl', parts: [{ name, color, slot }], meta } -> { id, ok, bytes, name, count }
// The worker keeps the last build so an export does not send the meshes back again.
import { buildProduct } from './products.js';
import { write3MFBytes, writeSTL, zip, checkManifold, bounds } from './mesh.js';
import { prepareMesh } from './view.js';

let last = null;   // { key, out }

const r1 = v => Math.round(v * 10) / 10;

function partSize(mesh) {
  const b = bounds(mesh);
  return { x: r1(b.x[1] - b.x[0]), y: r1(b.y[1] - b.y[0]), z: r1(b.z[1] - b.z[0]), z0: r1(b.z[0]) };
}

function layoutSize(parts) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of parts) {
    const b = bounds(p.mesh);
    x0 = Math.min(x0, b.x[0]); y0 = Math.min(y0, b.y[0]); z0 = Math.min(z0, b.z[0]);
    x1 = Math.max(x1, b.x[1]); y1 = Math.max(y1, b.y[1]); z1 = Math.max(z1, b.z[1]);
  }
  return { x: [0, r1(x1 - x0)], y: [0, r1(y1 - y0)], z: [0, r1(z1 - z0)] };
}

function volumeOf(mesh) {
  const P = mesh.positions, I = mesh.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return Math.abs(v / 6);
}

function build(product, geom, opts) {
  const out = buildProduct(product, geom, opts);
  // cookie cutter: the stamp and its handle are optional
  if (product === 'cutter') {
    const keep = p => (opts.stamp !== false || !/^Stamp/.test(p.name)) && (opts.handle !== false || p.name !== 'Stamp handle');
    if (out.parts.some(p => !keep(p))) {
      out.parts = out.parts.filter(keep);
      out.sizeMm = layoutSize(out.parts);
      out.stats.partsMm = (out.stats.partsMm || []).filter(p => keep(p));
      if (opts.stamp === false) {
        out.printability.issues = out.printability.issues.filter(t => !/stamp/i.test(t));
        out.printability.notes = out.printability.notes.filter(t => !/stamp/i.test(t));
      }
      out.printability.ok = !out.printability.issues.length;
    }
  }
  // a standing lithophane on a bed slinger: turn it 90 degrees about Z so its thin side runs along X
  // and the bed's Y moves shake it along its strong (wide) direction, not its weak one
  if (product === 'litho' && out.settings?.orientation === 'standing' && opts.bedslinger) {
    // (about the bounds of all the parts together, so a panel and its foot stay joined)
    const all = out.parts.map(p => bounds(p.mesh));
    const b = { x: [Math.min(...all.map(q => q.x[0])), Math.max(...all.map(q => q.x[1]))], y: [Math.min(...all.map(q => q.y[0])), Math.max(...all.map(q => q.y[1]))] };
    for (const p of out.parts) {
      const P = p.mesh.positions;
      const nP = new Float32Array(P.length);
      for (let v = 0; v < P.length; v += 3) { nP[v] = b.y[1] - P[v + 1]; nP[v + 1] = P[v] - b.x[0]; nP[v + 2] = P[v + 2]; }   // (x, y) -> (-y, x): a rotation, faces keep their winding
      p.mesh = { ...p.mesh, positions: nP };
    }
    out.sizeMm = layoutSize(out.parts);
    out.settings = { ...out.settings, turned: true };
    out.printability.notes = [...out.printability.notes, 'Turned 90 degrees on the plate: on a bed slinger the bed moves in Y, so the panel stands with its thin side along X and the bed shakes it along its strong side.'];
  }
  const parts = out.parts.map(p => {
    const volume = volumeOf(p.mesh);
    return { name: p.name, color: p.color, mesh: p.mesh, size: partSize(p.mesh), volume, triangles: p.mesh.indices.length / 3 };
  });
  const manifold = parts.map(p => { const m = checkManifold(p.mesh, { weld: true }); return { name: p.name, ok: m.ok && m.welded?.openEdges === 0 && m.welded?.nonManifold === 0, openEdges: m.welded?.openEdges ?? m.openEdges, nonManifold: m.welded?.nonManifold ?? m.nonManifold }; });
  return { out, parts, manifold };
}

self.onmessage = async ev => {
  const { id, cmd } = ev.data;
  try {
    if (cmd === 'build') {
      const t0 = performance.now();
      const { product, geom, opts } = ev.data;
      const { out, parts, manifold } = build(product, geom, opts || {});
      last = { product, out, parts };
      const transfer = [];
      const sendParts = parts.map(p => {
        const positions = p.mesh.positions.slice(), indices = p.mesh.indices.slice();
        // the viewer's GPU arrays (de-indexed positions + packed normals) are made here too, so
        // the main thread only uploads them
        const prepared = prepareMesh(p.mesh, 32);
        transfer.push(positions.buffer, indices.buffer, prepared.pos.buffer, prepared.nrm.buffer);
        return { name: p.name, color: p.color, mesh: { positions, indices }, prepared, size: p.size, volume: p.volume, triangles: p.triangles };
      });
      let backlit = null;
      if (out.extras?.backlit) { const b = out.extras.backlit; backlit = { w: b.w, h: b.h, data: b.data.slice() }; transfer.push(backlit.data.buffer); }
      const result = {
        product, parts: sendParts, sizeMm: out.sizeMm, printability: out.printability, settings: out.settings,
        stats: { ...out.stats, manifold, buildMs: Math.round(performance.now() - t0) }, extras: { backlit },
        meta: out.product ? { id: out.product.id, letter: out.product.letter, name: out.product.name } : null,
      };
      self.postMessage({ id, ok: true, result }, transfer);
    } else if (cmd === 'export') {
      if (!last) throw new Error('nothing built yet');
      const { format, parts: looks = [], meta = {} } = ev.data;
      const parts = last.parts.map(p => { const l = looks.find(x => x.name === p.name) || {}; return { name: p.name, mesh: p.mesh, color: l.color || p.color, slot: l.slot }; });
      let bytes, kind;
      if (format === '3mf') { bytes = await write3MFBytes(parts, meta); kind = '3mf'; }
      else if (parts.length === 1) { bytes = new Uint8Array(writeSTL(parts[0].mesh, parts[0].name)); kind = 'stl'; }
      else {
        const files = parts.map(p => ({ name: `${meta.fileBase || 'spiralist'}-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.stl`, data: new Uint8Array(writeSTL(p.mesh, p.name)) }));
        bytes = await zip(files); kind = 'zip';
      }
      self.postMessage({ id, ok: true, bytes, kind, count: parts.length }, [bytes.buffer]);
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e), stack: String(e && e.stack || '').split(String.fromCharCode(10)).slice(0, 6).join(' | ') });
  }
};
