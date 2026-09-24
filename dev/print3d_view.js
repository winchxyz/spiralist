// Print viewer lab: product-photo renders of 3D-print parts via js/print3d/view.js.
//   /dev/print3d_view.html                         interactive (orbit, turntable, bed, material)
//   /dev/print3d_view.html?scene=litho&backlit=1   pick a scene
//   /dev/print3d_view.html?shots=basic,plaque,...;w=1200;h=900   headless stills -> window.__shots
//   /dev/print3d_view.html?shots=lineup            2 x 2 contact sheet A..D (plaque, wire, litho, cutter)
//   /dev/print3d_view.html?src=products            use js/print3d/products.js (buildProduct) when it exists
// Stand-in meshes are built here (sweeps, tubes, height field) until the MESH engine lands.
import { createViewer, attachOrbit, prepareMesh, renderParts, captureStill, poseMatrix } from '../js/print3d/view.js';

const q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const info = [];
const log = s => { info.push(s); const el = $('info'); if (el) el.textContent = info.join('\n'); };

// ---------------------------------------------------------------- stand-in mesh builders

class Builder {
  constructor() { this.p = []; this.i = []; }
  v(x, y, z) { this.p.push(x, y, z); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  mesh() { return { positions: new Float32Array(this.p), indices: new Uint32Array(this.i) }; }
}

function box(B, x0, y0, z0, x1, y1, z1) {
  const v = [];
  for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) v.push(B.v(x, y, z));
  const f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  for (const [a, b, c, d] of f) B.quad(v[a], v[b], v[c], v[d]);
}

// rectangular section swept along a 2D polyline (width per point), from z0 to z1
function sweepRect(B, pts, widths, z0, z1, closed = false) {
  const n = pts.length;
  if (n < 2) return;
  const base = B.p.length / 3;
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const h = (typeof widths === 'number' ? widths : widths[i]) / 2;
    const [x, y] = pts[i];
    B.v(x - ty * h, y + tx * h, z0); B.v(x + ty * h, y - tx * h, z0);
    B.v(x + ty * h, y - tx * h, z1); B.v(x - ty * h, y + tx * h, z1);
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = base + 4 * i, b = base + 4 * ((i + 1) % n);
    for (let s = 0; s < 4; s++) B.quad(a + s, b + s, b + (s + 1) % 4, a + (s + 1) % 4);
  }
  if (!closed) { B.quad(base + 3, base + 2, base + 1, base); const e = base + 4 * (n - 1); B.quad(e, e + 1, e + 2, e + 3); }
}

// round tube along a 3D polyline (parallel-transport frames), capped
function tube(B, pts, r, sides = 12) {
  const n = pts.length;
  if (n < 2) return;
  const base = B.p.length / 3;
  let N = null;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let T = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...T) || 1; T = T.map(v => v / l);
    if (!N) N = Math.abs(T[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const d = N[0] * T[0] + N[1] * T[1] + N[2] * T[2];
    N = [N[0] - T[0] * d, N[1] - T[1] * d, N[2] - T[2] * d];
    const nl = Math.hypot(...N) || 1; N = N.map(v => v / nl);
    const Bn = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
    const [x, y, z] = pts[i];
    for (let s = 0; s < sides; s++) {
      const t = s / sides * Math.PI * 2, c = Math.cos(t) * r, si = Math.sin(t) * r;
      B.v(x + N[0] * c + Bn[0] * si, y + N[1] * c + Bn[1] * si, z + N[2] * c + Bn[2] * si);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let s = 0; s < sides; s++) {
    const a = base + i * sides, b = a + sides, s1 = (s + 1) % sides;
    B.quad(a + s, a + s1, b + s1, b + s);
  }
  const c0 = B.v(...pts[0]), c1 = B.v(...pts[n - 1]);
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    B.tri(c0, base + s1, base + s);
    B.tri(c1, base + (n - 1) * sides + s, base + (n - 1) * sides + s1);
  }
}

// convex polygon prism (fan triangulation)
function prism(B, poly, z0, z1) {
  const n = poly.length, base = B.p.length / 3;
  for (const [x, y] of poly) { B.v(x, y, z0); B.v(x, y, z1); }
  for (let i = 1; i < n - 1; i++) { B.tri(base, base + 2 * (i + 1), base + 2 * i); B.tri(base + 1, base + 2 * i + 1, base + 2 * (i + 1) + 1); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; B.quad(base + 2 * i, base + 2 * j, base + 2 * j + 1, base + 2 * i + 1); }
}

// closed height-field solid: top follows zOf(d), flat bottom, four walls
function heightfield(B, field, nx, ny, sx, sy, zOf) {
  const base = B.p.length / 3, dx = sx / (nx - 1), dy = sy / (ny - 1);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) B.v(i * dx, sy - j * dy, zOf(field[j * nx + i]));
  const bot = B.p.length / 3;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) B.v(i * dx, sy - j * dy, 0);
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = base + j * nx + i;
    B.quad(a, a + nx, a + nx + 1, a + 1);
    const b = bot + j * nx + i;
    B.quad(b, b + 1, b + nx + 1, b + nx);
  }
  const edge = (i0, j0, di, dj, cnt) => {
    for (let k = 0; k < cnt - 1; k++) {
      const u = (j0 + dj * k) * nx + i0 + di * k, w = (j0 + dj * (k + 1)) * nx + i0 + di * (k + 1);
      B.quad(base + u, base + w, bot + w, bot + u);
    }
  };
  edge(0, 0, 1, 0, nx); edge(nx - 1, 0, 0, 1, ny); edge(nx - 1, ny - 1, -1, 0, nx); edge(0, ny - 1, 0, -1, ny);
}

const decimate = (pts, step) => {
  const out = [pts[0]];
  for (const p of pts) { const l = out[out.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1], (p[2] || 0) - (l[2] || 0)) >= step) out.push(p); }
  return out;
};
function hull(pts) {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const chaikin = (poly, it) => {
  for (let k = 0; k < it; k++) {
    const o = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    poly = o;
  }
  return poly;
};

// ---------------------------------------------------------------- inputs

async function loadImageDarkness(src, n) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2 * 0.6, s, s, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data, f = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) f[i] = 1 - (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  return f;
}

async function loadGeom(kind) {
  const r = await fetch(`../shots/print3d/geom_bust_${kind}.json`);
  if (!r.ok) throw new Error('no captured geometry ' + kind);
  const j = await r.json();
  const bin = atob(j.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { ...j.meta, data: new Float32Array(u8.buffer) };
}

// ---------------------------------------------------------------- scenes (stand-ins)

const SCENES = {};

SCENES.basic = async () => {
  // calibration: a stepped block (layer lines on walls), a slope (terraces), a round tube (smooth)
  const A = new Builder(), Bq = new Builder();
  box(A, 0, 0, 0, 40, 30, 12);
  box(A, 5, 5, 12, 35, 25, 18);
  const hf = new Builder();
  heightfield(hf, new Float32Array(48 * 48).map((_, k) => (k % 48) / 47), 48, 48, 30, 30, d => 1 + d * 14);
  const m = hf.mesh(); for (let i = 0; i < m.positions.length; i += 3) m.positions[i] += 50;
  const pts = [];
  for (let t = 0; t <= 1; t += 0.01) pts.push([20 + Math.cos(t * 5) * 12, -25 + Math.sin(t * 5) * 12, 1.5 + t * 20]);
  tube(Bq, pts, 1.5, 16);
  return {
    parts: [{ name: 'block', mesh: A.mesh(), color: '#f1eee8' }, { name: 'ramp', mesh: m, color: '#3d7fb8' }, { name: 'helix', mesh: Bq.mesh(), color: '#d4502e' }],
    note: 'block X 0-40 Y 0-30 Z 0-18, ramp X 50-80 Y 0-30 Z 0-15, helix tube r 1.5',
  };
};

SCENES.plaque = async () => {
  // A: two-colour relief plaque, the line raised 1.0 mm on a 2.4 mm plate with a frame
  const S = 120, R = 52, rings = 26, cx = S / 2, cy = S / 2;
  const n = 256, dark = await loadImageDarkness('../shots/testset/portrait_curly.jpg', n);
  const sample = (x, y) => {
    const i = Math.max(0, Math.min(n - 1, Math.round((x - (cx - R)) / (2 * R) * (n - 1))));
    const j = Math.max(0, Math.min(n - 1, Math.round((y - (cy - R)) / (2 * R) * (n - 1))));
    return dark[(n - 1 - j) * n + i];
  };
  const pitch = R / rings, pts = [], w = [];
  for (let th = 0; ; th += 0.02) {
    const r = pitch * th / (Math.PI * 2);
    if (r > R) break;
    const step = Math.max(0.02, 0.6 / Math.max(r, 1));
    th += step - 0.02;
    const x = cx + r * Math.cos(th), y = cy + r * Math.sin(th);
    pts.push([x, y]);
    w.push(Math.max(0.8, Math.min(pitch - 0.5, 0.8 + (pitch - 1.3) * Math.pow(sample(x, y), 1.2))));
  }
  const plate = new Builder(), line = new Builder();
  box(plate, 0, 0, 0, S, S, 2.4);
  sweepRect(plate, [[3, 3], [S - 3, 3], [S - 3, S - 3], [3, S - 3]], 4, 2.4, 4.0, true);
  sweepRect(line, pts, w, 2.4, 3.4);
  return {
    parts: [{ name: 'plate', mesh: plate.mesh(), color: '#f1eee8' }, { name: 'line', mesh: line.mesh(), color: '#232326' }],
    note: `plaque X 0-${S} Y 0-${S} Z 0-4.0; ${rings} rings, pitch ${pitch.toFixed(2)} mm, line 0.8-${(pitch - 0.5).toFixed(2)} mm, raised 1.0 mm`,
  };
};

SCENES.wire = async () => {
  // B: the Line art one-line drawing as a 1.8 mm wire, printed flat (layer lines follow the print),
  // displayed standing in a slotted plinth via pose { rx: 90 }
  const g = await loadGeom('lineart');
  const Rmm = 62, pts = [];
  let ymax = -Infinity;
  for (let i = 0; i < g.n; i++) ymax = Math.max(ymax, g.data[i * 7 + 1]);
  for (let i = 0; i < g.n; i++) pts.push([60 + g.data[i * 7] * Rmm, (ymax - g.data[i * 7 + 1]) * Rmm, 0.9]);
  const line = decimate(pts, 0.5);
  const W = new Builder(), P = new Builder();
  tube(W, line, 0.9, 10);
  const ys = line.map(p => p[1]), cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  box(P, 30, cy - 12.9, 0, 90, cy + 11.1, 8.4);
  return {
    parts: [{ name: 'wire', mesh: W.mesh(), color: '#1d1d20', pose: { rx: 90, t: [0, 0, 4] } }, { name: 'plinth', mesh: P.mesh(), color: '#e8e2d6' }],
    note: `wire ${line.length} pts, d 1.8 mm, printed flat X 30-90 Y 0-${Math.max(...ys).toFixed(0)} Z 0-1.8, shown standing (pose rx 90)`,
  };
};

SCENES.litho = async () => {
  // C: lithophane 100 x 100 mm, 0.8 mm (light) .. 3.2 mm (dark), 3 mm frame at full thickness
  const n = +(q.get('lithoN') || 300), S = 100;
  const d = await loadImageDarkness('../shots/testset/portrait_curly.jpg', n);
  const border = Math.round(3 / (S / (n - 1)));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (i < border || j < border || i >= n - border || j >= n - border) d[j * n + i] = 1.12;
  }
  const B = new Builder();
  heightfield(B, d, n, n, S, S, v => 0.8 + 2.4 * Math.min(1.12, v));
  return { parts: [{ name: 'litho', mesh: B.mesh(), color: '#f4f1ea' }], note: `litho X 0-${S} Y 0-${S} Z 0-3.5, ${n} x ${n} samples`, backlitHint: true };
};

SCENES.cutter = async () => {
  // D: cookie cutter (hull stand-in silhouette) + stamp with the inner lines
  const g = await loadGeom('lineart');
  const Rmm = 38, pts = [];
  for (let i = 0; i < g.n; i++) pts.push([45 + g.data[i * 7] * Rmm, 45 - g.data[i * 7 + 1] * Rmm]);
  const outline = chaikin(hull(pts), 3);
  const C = new Builder();
  sweepRect(C, outline, 1.2, 0, 14, true);
  sweepRect(C, outline, 6, 0, 2, true);
  const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length, cy = outline.reduce((s, p) => s + p[1], 0) / outline.length;
  const off = 88;
  const inset = outline.map(([x, y]) => [cx + (x - cx) * 0.93 + off, cy + (y - cy) * 0.93]);
  const S = new Builder(), L = new Builder();
  prism(S, inset.slice().reverse(), 0, 3);
  sweepRect(L, decimate(pts, 0.4).map(([x, y]) => [cx + (x - cx) * 0.86 + off, cy + (y - cy) * 0.86]), 1.0, 3, 5);
  return {
    parts: [{ name: 'cutter', mesh: C.mesh(), color: '#d9573a' }, { name: 'stamp', mesh: S.mesh(), color: '#efe9dd' }, { name: 'stamp-lines', mesh: L.mesh(), color: '#efe9dd' }],
    note: 'cutter wall 1.2 mm Z 0-14 with 6 mm flange Z 0-2; stamp plate Z 0-3 + lines 1.0 mm Z 3-5',
  };
};

// real products (MESH + PRODUCTS engineers) when their modules exist
async function productScenes() {
  const mod = await import('../js/print3d/products.js');
  const kinds = { plaque: q.get('plaqueGeom') || 'spiral', wire: 'lineart', litho: q.get('lithoGeom') || 'spiral', cutter: 'lineart' };
  const out = {};
  for (const p of mod.PRODUCTS) {
    out['product_' + p.id] = async () => {
      const g = await loadGeom(kinds[p.id] || 'spiral');
      const t0 = performance.now();
      const r = await mod.buildProduct(p.id, g, p.id === 'wire' && q.get('display') === '1' ? { stand: true } : {});
      if (p.id === 'wire' && q.get('display') === '1') {
        // shown on edge in its slotted stand: the wire stands up (pose), the stand stays as printed
        const bb = m => { const P = m.positions, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < P.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], P[i]); hi[k] = Math.max(hi[k], P[i]); } return { lo, hi }; };
        const stand = r.parts.find(x => /stand/i.test(x.name));
        for (const part of r.parts) if (/wire/i.test(part.name)) {
          const w = bb(part.mesh), cx = (w.lo[0] + w.hi[0]) / 2, cy = (w.lo[1] + w.hi[1]) / 2, th = w.hi[2] - w.lo[2];
          const sb = stand ? bb(stand.mesh) : null;
          // stand it on edge, into the stand's slot (the slot floor is taken as the stand's mid height)
          part.pose = sb ? { rx: 90, t: [(sb.lo[0] + sb.hi[0]) / 2 - cx, (sb.lo[1] + sb.hi[1]) / 2 - cy + th / 2, (sb.hi[2] - sb.lo[2]) * 0.35] } : { rx: 90 };
        }
      }
      if (p.id === 'plaque' && q.get('m600') === '1' && r.settings?.colorChangeAtMm != null) {
        // single-extruder version: every part in the plate colour, swap to ink at the change layer
        for (const part of r.parts) { part.color = r.parts[0].color; part.colorAbove = { atMm: r.settings.colorChangeAtMm, color: '#1E1E24' }; }
      }
      return { parts: r.parts, auto: true, note: `${p.letter} ${p.name}: ${JSON.stringify(r.sizeMm)} ok=${r.printability?.ok} build ${Math.round(performance.now() - t0)} ms`, backlitHint: p.id === 'litho' };
    };
  }
  return out;
}

// ---------------------------------------------------------------- page

const VIEW = {
  basic: { yaw: -30, pitch: 34 }, plaque: { yaw: -22, pitch: 48 }, wire: { yaw: -24, pitch: 14, fov: 28 },
  litho: { yaw: -18, pitch: 52 }, cutter: { yaw: -26, pitch: 44 },
};

// ?selftest=1 : the public API end to end (renderParts cache, captureStill, orbit, turntable, pose)
async function selftest() {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, detail });
  const sc = await SCENES.basic();
  const c1 = document.createElement('canvas');
  c1.width = 320; c1.height = 240;
  document.body.append(c1);
  const v1 = renderParts(c1, sc.parts, { yaw: 10, pitch: 30, bed: true });
  const px = new Uint8Array(4 * 320 * 240);
  v1.gl.readPixels(0, 0, 320, 240, v1.gl.RGBA, v1.gl.UNSIGNED_BYTE, px);
  let lo = 255, hi = 0;
  for (let i = 0; i < px.length; i += 4) { const l = px[i + 1]; lo = Math.min(lo, l); hi = Math.max(hi, l); }
  ok('renderParts draws a lit scene', hi - lo > 120, { lo, hi });
  const v2 = renderParts(c1, sc.parts, { yaw: 40 });
  ok('renderParts reuses the viewer per canvas', v2 === v1 && v1.state.yaw === 40 && v1.state.bed === 'pei', { yaw: v1.state.yaw, bed: v1.state.bed });
  const blob = await captureStill(sc.parts, { width: 640, height: 480, bed: 'desk' });
  const bmp = await createImageBitmap(blob);
  ok('captureStill gives a JPEG at the asked size', blob.type === 'image/jpeg' && blob.size > 10000 && bmp.width === 640 && bmp.height === 480, { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height });
  const detach = attachOrbit(v1);
  const fire = (type, x, y, extra = {}) => c1.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, bubbles: true, ...extra }));
  const yaw0 = v1.state.yaw, pitch0 = v1.state.pitch;
  fire('pointerdown', 100, 100); fire('pointermove', 140, 120); fire('pointerup', 140, 120);
  ok('drag orbits (yaw and pitch)', Math.abs(v1.state.yaw - (yaw0 - 40 * 0.35)) < 1e-6 && Math.abs(v1.state.pitch - (pitch0 + 20 * 0.3)) < 1e-6, { yaw: v1.state.yaw, pitch: v1.state.pitch });
  const z0 = v1.state.zoom;
  c1.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }));
  ok('wheel zooms in', v1.state.zoom > z0 * 1.3, { zoom: v1.state.zoom });
  c1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  ok('double-click resets', v1.state.zoom === 1 && v1.state.pitch === 30, { zoom: v1.state.zoom, pitch: v1.state.pitch });
  v1.turntable(90);
  const y1 = v1.state.yaw;
  await new Promise(r => setTimeout(r, 700));
  const turned = ((v1.state.yaw - y1) % 360 + 360) % 360;
  fire('pointerdown', 50, 50); fire('pointerup', 50, 50);
  ok('turntable spins, a touch stops it', turned > 20 && !v1.spinning, { turnedDeg: +turned.toFixed(1), spinning: v1.spinning });
  detach();
  const m = poseMatrix({ rx: 90 }, [0, 0, 0], [10, 20, 2]);
  const top = [m[0] * 10 + m[4] * 20 + m[8] * 2 + m[12], m[1] * 10 + m[5] * 20 + m[9] * 2 + m[13], m[2] * 10 + m[6] * 20 + m[10] * 2 + m[14]];
  const bot = [m[12], m[13], m[14]];
  ok('pose rx 90 stands a flat part up on Z = 0', Math.abs(Math.max(top[2], bot[2]) - 20) < 1e-4 && Math.abs(Math.min(top[2], bot[2])) < 1e-4, { top, bot });
  v1.dispose();
  const bad = checks.filter(c => !c.ok);
  checks.forEach(c => log((c.ok ? 'PASS ' : 'FAIL ') + c.name + ' ' + JSON.stringify(c.detail)));
  window.__done = { ok: bad.length === 0, passed: checks.length - bad.length, failed: bad };
}

async function main() {
  if (q.get('selftest')) return selftest();
  const W = +(q.get('w') || 1200), H = +(q.get('h') || 900);
  let scenes = { ...SCENES };
  if (q.get('src') === 'products' || /product_|plineup/.test(q.get('shots') || '')) {
    try { Object.assign(scenes, await productScenes()); log('products.js loaded'); } catch (e) { log('products.js unavailable: ' + e.message); }
  }
  const sel = $('scene');
  for (const k of Object.keys(scenes)) sel.add(new Option(k, k));
  const canvas = $('stage');
  const viewer = createViewer(canvas, { autoSize: true });
  viewer.autoSize = true;

  const shots = q.get('shots');
  if (shots) {
    const list = shots === 'lineup' ? ['plaque', 'wire', 'litho', 'cutter'] : shots === 'plineup' ? ['product_plaque', 'product_wire', 'product_litho', 'product_cutter'] : shots === 'all' ? Object.keys(scenes) : shots.split(',');
    const out = [], stats = [];
    const bed = q.get('bed') || 'pei';
    for (const name of list) {
      const t0 = performance.now();
      const sc = await scenes[name]();
      const tris = sc.parts.reduce((s, p) => s + (p.mesh.indices ? p.mesh.indices.length / 3 : p.mesh.positions.length / 9), 0);
      const t1 = performance.now();
      viewer.setParts(sc.parts);
      const t2 = performance.now();
      const base = { ...(sc.auto ? viewer.suggestView() : VIEW[name] || {}), bed: bed === 'none' ? false : bed, material: q.get('material') || 'petg' };
      if (q.get('yaw')) base.yaw = +q.get('yaw');
      if (q.get('pitch')) base.pitch = +q.get('pitch');
      if (q.get('zoom')) base.zoom = +q.get('zoom');
      const c = viewer.capture({ width: W, height: H, ...base, backlit: q.get('backlit') === '1' });
      const t3 = performance.now();
      out.push({ name, data: c.toDataURL('image/jpeg', 0.92) });
      if (sc.backlitHint && q.get('backlit') !== '0') {
        const b = viewer.capture({ width: W, height: H, ...base, backlit: true, ...(sc.auto ? { yaw: -8 } : { pitch: 62 }) });
        out.push({ name: name + '_backlit', data: b.toDataURL('image/jpeg', 0.92) });
      }
      if (q.get('spin')) {
        // turntable contact strip: N frames in one row
        const n = +q.get('spin'), fw = Math.round(W / 2), fh = Math.round(H / 2);
        const frames = viewer.captureTurntable({ frames: n, width: fw, height: fh, ...base });
        const strip = document.createElement('canvas');
        strip.width = fw * n; strip.height = fh;
        frames.forEach((f, k) => strip.getContext('2d').drawImage(f, k * fw, 0));
        out.push({ name: name + '_spin', data: strip.toDataURL('image/jpeg', 0.9) });
      }
      if (q.get('extra') === '1') {
        for (const [tag, o] of [['desk', { bed: 'desk' }], ['top', { pitch: 89.9, yaw: 0 }], ['pla', { material: 'pla', bed: 'dark' }]]) {
          const e = viewer.capture({ width: W, height: H, ...base, ...o });
          out.push({ name: name + '_' + tag, data: e.toDataURL('image/jpeg', 0.92) });
        }
      }
      stats.push({ name, tris, buildMs: Math.round(t1 - t0), uploadMs: Math.round(t2 - t1), captureMs: Math.round(t3 - t2), note: sc.note });
      log(`${name}: ${tris} tris, build ${Math.round(t1 - t0)} ms, upload ${Math.round(t2 - t1)} ms, capture ${Math.round(t3 - t2)} ms  ${sc.note}`);
    }
    if (shots === 'lineup' || shots === 'plineup') out.push({ name: 'lineup', data: await sheet(list.map(n => out.find(o => o.name === n + '_backlit') || out.find(o => o.name === n)), ['A relief plaque', 'B wire sculpture', 'C lithophane (backlit)', 'D cookie cutter + stamp'], W, H) });
    window.__shots = out;
    window.__done = { ok: true, stats };
    return;
  }

  // interactive
  attachOrbit(viewer);
  let current = null;
  const load = async name => {
    const t0 = performance.now();
    const sc = await scenes[name]();
    viewer.setParts(sc.parts);
    viewer.set({ ...(sc.auto ? viewer.suggestView() : VIEW[name] || {}) });
    current = name;
    viewer.requestRender();
    log(`${name}: ${sc.note} (${Math.round(performance.now() - t0)} ms)`);
  };
  sel.value = q.get('scene') || 'plaque';
  sel.onchange = () => load(sel.value);
  $('bed').value = q.get('bed') || 'pei';
  $('bed').onchange = () => { viewer.set({ bed: $('bed').value === 'none' ? false : $('bed').value }); viewer.requestRender(); };
  $('mat').onchange = () => { viewer.set({ material: $('mat').value }); viewer.requestRender(); };
  $('backlit').checked = q.get('backlit') === '1';
  $('backlit').onchange = () => { viewer.set({ backlit: $('backlit').checked }); viewer.requestRender(); };
  $('spin').onchange = () => viewer.turntable($('spin').checked ? 24 : 0);
  $('snap').onclick = async () => {
    const c = viewer.capture({ width: 1600, height: 1200 });
    const a = document.createElement('a');
    a.href = c.toDataURL('image/jpeg', 0.92);
    a.download = `print3d_${current}.jpg`;
    a.click();
  };
  viewer.set({ bed: $('bed').value === 'none' ? false : $('bed').value, backlit: $('backlit').checked });
  addEventListener('resize', () => viewer.requestRender());
  await load(sel.value);
  window.__viewer = viewer;
  window.__done = { ok: true };
}

async function sheet(shots, labels, W, H) {
  const c = document.createElement('canvas');
  const cw = W / 2, ch = H / 2, pad = 6;
  c.width = W + pad * 3; c.height = H + pad * 3;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111114';
  ctx.fillRect(0, 0, c.width, c.height);
  for (let k = 0; k < shots.length; k++) {
    const img = new Image();
    img.src = shots[k].data;
    await img.decode();
    const x = pad + (k % 2) * (cw + pad), y = pad + Math.floor(k / 2) * (ch + pad);
    ctx.drawImage(img, x, y, cw, ch);
    ctx.fillStyle = 'rgba(10,10,12,0.72)';
    ctx.fillRect(x + 10, y + 10, 250, 30);
    ctx.fillStyle = '#f2efe8';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText(labels[k] || shots[k].name, x + 20, y + 31);
  }
  return c.toDataURL('image/jpeg', 0.92);
}

main().catch(e => { console.error(e); log('ERROR ' + e.stack); window.__done = { ok: false, error: String(e && e.stack || e) }; });
export { prepareMesh };
