// Unit checks for the pure parts of js/print3d/view.js (no GL): mesh preparation, colours, poses,
// suggested views.   node tests/print3d_view.test.mjs
import assert from 'node:assert/strict';
import { prepareMesh, parseColor, poseMatrix, suggestView, MATERIALS, VIEW_DEFAULTS } from '../js/print3d/view.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok', name); };

function cube(s = 10) {
  const p = [], idx = [];
  for (const z of [0, s]) for (const y of [0, s]) for (const x of [0, s]) p.push(x, y, z);
  for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) idx.push(a, b, c, a, c, d);
  return { positions: new Float32Array(p), indices: new Uint32Array(idx) };
}
function cylinder(r = 5, h = 10, n = 48) {
  const p = [], idx = [];
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; p.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(a) * r, Math.sin(a) * r, h); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1); }
  return { positions: new Float32Array(p), indices: new Uint32Array(idx) };
}
const nrm = (prep, k) => [prep.nrm[k * 4] / 32767, prep.nrm[k * 4 + 1] / 32767, prep.nrm[k * 4 + 2] / 32767];

test('cube keeps crisp face normals across 90 degree edges', () => {
  const prep = prepareMesh(cube());
  assert.equal(prep.count, 36);
  assert.deepEqual(prep.min, [0, 0, 0]);
  assert.deepEqual(prep.max, [10, 10, 10]);
  for (let k = 0; k < prep.count; k++) {
    const n = nrm(prep, k);
    const big = n.map(Math.abs).sort((a, b) => b - a);
    assert.ok(big[0] > 0.999 && big[1] < 1e-3, 'axis aligned ' + n);
  }
});

test('fine cylinder gets smooth radial normals (area weighted: within 2 deg)', () => {
  const prep = prepareMesh(cylinder());
  for (let k = 0; k < prep.count; k++) {
    const x = prep.pos[k * 3], y = prep.pos[k * 3 + 1];
    const n = nrm(prep, k), l = Math.hypot(x, y);
    assert.ok(Math.abs(n[0] - x / l) < 0.03 && Math.abs(n[1] - y / l) < 0.03 && Math.abs(n[2]) < 0.01, `radial at ${x},${y}: ${n}`);
  }
});

test('non-indexed meshes are accepted', () => {
  const c = cube(), P = c.positions, I = c.indices;
  const flat = new Float32Array(I.length * 3);
  for (let i = 0; i < I.length; i++) flat.set(P.subarray(I[i] * 3, I[i] * 3 + 3), i * 3);
  const prep = prepareMesh({ positions: flat });
  assert.equal(prep.count, 36);
});

test('colours: hex, short hex, rgb(), arrays, 0..255 arrays, fallback', () => {
  assert.deepEqual(parseColor('#ff8000').map(v => +v.toFixed(3)), [1, 0.502, 0]);
  assert.deepEqual(parseColor('#fff'), [1, 1, 1]);
  assert.deepEqual(parseColor('rgb(255, 0, 51)').map(v => +v.toFixed(2)), [1, 0, 0.2]);
  assert.deepEqual(parseColor([0.5, 0.25, 1]), [0.5, 0.25, 1]);
  assert.deepEqual(parseColor([255, 0, 0]), [1, 0, 0]);
  assert.equal(parseColor(undefined, 1).length, 3);
});

test('pose rx 90 stands a flat 10 x 20 x 2 part on Z = 0, height 20', () => {
  const m = poseMatrix({ rx: 90 }, [0, 0, 0], [10, 20, 2]);
  const xf = p => [0, 1, 2].map(k => m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k]);
  const zs = [];
  for (const x of [0, 10]) for (const y of [0, 20]) for (const z of [0, 2]) zs.push(xf([x, y, z])[2]);
  assert.ok(Math.abs(Math.min(...zs)) < 1e-4);
  assert.ok(Math.abs(Math.max(...zs) - 20) < 1e-4);
  assert.equal(poseMatrix(null)[0], 1);
  assert.equal(poseMatrix(Array.from({ length: 16 }, (_, i) => i))[5], 5);
});

test('suggested views: flat pieces from above, standing pieces low and frontal', () => {
  const flat = suggestView({ min: [0, 0, 0], max: [150, 150, 4] });
  const tall = suggestView({ min: [0, 0, 0], max: [100, 14, 100] });
  assert.ok(flat.pitch > 40 && tall.pitch < 20);
});

test('defaults are sane', () => {
  assert.ok(MATERIALS.petg.rough < MATERIALS.pla.rough);
  assert.equal(VIEW_DEFAULTS.layer, 0.2);
  assert.deepEqual(VIEW_DEFAULTS.plate, [330, 320]);
});

console.log(`${passed} passed`);
