// Unit tests for js/print3d/presets.js (printers, filament swatches, contrast rules, estimates) and
// the dialog's availability table.   node tests/print3d_presets.test.mjs
import assert from 'node:assert/strict';
import * as P from '../js/print3d/presets.js';

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, '\n     ', e.message); } };

test('every printer has a bed with X, Y, Z and a nozzle; the A2L is the default', () => {
  for (const p of P.PRINTERS) { assert.ok(p.bed.x > 100 && p.bed.y > 100 && p.bed.z > 100, p.id); assert.equal(p.nozzle, 0.4); assert.ok(['bedslinger', 'corexy'].includes(p.kinematics)); }
  const d = P.printerById(P.DEFAULT_PRINTER);
  assert.deepEqual([d.name, d.bed.x, d.bed.y, d.bed.z], ['Bambu Lab A2L', 330, 320, 325]);
  assert.equal(P.printerById('nope').id, 'a2l');
  for (const id of ['a1mini', 'a1', 'a2l', 'p1s', 'x1c', 'mk4', 'mini', 'ender3', 'generic']) assert.ok(P.PRINTERS.find(p => p.id === id), id);
});

test('black on black and near-identical pairs are "bad"; black on dark gray and navy are "weak"', () => {
  assert.equal(P.pairVerdict('#000000', '#000000').level, 'bad');
  assert.equal(P.pairVerdict('#FFFFFF', '#F7E6DE').level, 'bad');         // white on beige
  assert.equal(P.pairVerdict('#000000', '#545454').level, 'weak');        // black on dark gray
  assert.equal(P.pairVerdict('#000000', '#0A2989').level, 'weak');        // black on navy blue
  assert.equal(P.pairVerdict('#FFFFFF', '#000000').level, 'good');
  assert.equal(P.pairVerdict('#C12E1F', '#00AE42').level, 'good');        // red on green: different lightness and hue
  assert.notEqual(P.pairVerdict('#FFFFFF', '#F4EE2A').level, 'good');     // yellow line on white: 1.2:1
  assert.equal(P.pairVerdict('#FF6A13', '#00AE42').level, 'bad');         // orange on Bambu Green: 1.03:1
  assert.notEqual(P.pairVerdict('#8E9089', '#00AE42').level, 'good');     // gray on Bambu Green: 1.1:1
});

test('every default colour pair and default backdrop contrasts (no warnings out of the box)', () => {
  for (const [id, c] of Object.entries(P.DEFAULT_COLORS)) {
    const bd = P.bestBackdrop(P.dominantColor(id, c));
    assert.deepEqual(P.colorWarnings(id, c, bd, 'petg'), [], id);
    assert.deepEqual(P.colorWarnings(id, c, bd, 'pla'), [], id);
  }
});

test('a black line on a black plate warns and offers two fixes that clear it (never a swap)', () => {
  const w = P.colorWarnings('plaque', { base: '#000000', line: '#000000' }, 'pei');
  const pair = w.find(x => x.kind === 'pair');
  assert.ok(pair && pair.level === 'bad');
  assert.equal(pair.fix.role, 'line'); assert.equal(pair.fix.value, '#FFFFFF'); assert.ok(!pair.swap);
  // every offered fix must clear the pair warning (a swap of a symmetric verdict never could)
  for (const c of [{ base: '#000000', line: '#000000' }, { base: '#000000', line: '#141414' }, { base: '#545454', line: '#000000' }, { base: '#0A2989', line: '#000000' }, { base: '#FFFFFF', line: '#D0D2D4' }, { base: '#FFFFFF', line: '#F4EE2A' }]) {
    const x = P.colorWarnings('plaque', c, 'pei').find(y => y.kind === 'pair');
    assert.ok(x, JSON.stringify(c));
    for (const f of [x.fix, x.fix2].filter(Boolean)) {
      const after = { ...c, [f.role]: f.value };
      assert.ok(!P.colorWarnings('plaque', after, 'pei').find(y => y.kind === 'pair'), `${JSON.stringify(c)} -> ${f.label}`);
    }
  }
  const w2 = P.colorWarnings('plaque', { base: '#FFFFFF', line: '#FFFFFF' }, 'pei');
  assert.equal(w2.find(x => x.kind === 'pair').fix.value, '#000000');
});

test('a black wire on the graphite backdrop warns and suggests a light backdrop', () => {
  const w = P.colorWarnings('wire', { line: '#000000' }, 'dark');
  const b = w.find(x => x.kind === 'backdrop');
  assert.ok(b);
  assert.notEqual(b.fix.backdrop, 'dark');
  assert.equal(P.pairVerdict('#000000', P.backdropById(b.fix.backdrop).tone).level, 'good');
  // and auto never picks a dark backdrop for a dark wire, or a light one for a white wire
  for (const s of P.SWATCHES.pla) assert.equal(P.pairVerdict(s.hex, P.backdropById(P.bestBackdrop(s.hex)).tone).level === 'bad', false, s.name);
});

test('a dark lithophane warns (light cannot pass) and suggests white', () => {
  const w = P.colorWarnings('litho', { panel: '#000000' }, 'pei');
  assert.equal(w[0].kind, 'litho'); assert.equal(w[0].fix.value, '#FFFFFF');
  assert.deepEqual(P.colorWarnings('litho', { panel: '#FFFFFF' }, 'pei'), []);
});

test('colorParts: plate and feet share the base slot, the line gets slot 2', () => {
  const parts = ['Plate', 'Line', 'Stand 1', 'Stand 2'].map(name => ({ name, color: '#123456' }));
  const c = P.colorParts('plaque', parts, { base: '#FFFFFF', line: '#000000' });
  assert.deepEqual(c.map(p => [p.name, p.color, p.slot]), [['Plate', '#FFFFFF', 1], ['Line', '#000000', 2], ['Stand 1', '#FFFFFF', 1], ['Stand 2', '#FFFFFF', 1]]);
  const same = P.colorParts('plaque', parts, { base: '#FFFFFF', line: '#FFFFFF' });
  assert.ok(same.every(p => p.slot === 1));
});

test('estimates land near the Bambu Studio slices of the prototype line-up (A2L, PETG)', () => {
  // [product, volume mm3, height mm, triangles, sliced minutes, sliced grams]
  const cases = [['plaque', 65804, 10, 24340, 86, 49.1], ['wire', 11755, 9, 24000, 47, 9.3], ['litho', 24918, 99.5, 323992, 125, 22.1], ['cutter', 15187, 12, 13000, 37, 14.0], ['plaque', 88626, 10, 205808, 184, 70.5]];
  for (const [product, volumeMm3, heightMm, triangles, min, g] of cases) {
    const e = P.estimate({ volumeMm3, heightMm, triangles, product, material: 'petg', printer: P.printerById('a2l') });
    assert.ok(Math.abs(e.minutes - min) / min < 0.35, `${product} ${e.minutes} vs ${min} min`);
    assert.ok(Math.abs(e.grams - g) / g < 0.5, `${product} ${e.grams} vs ${g} g`);
  }
  assert.equal(P.formatMinutes(86), '1 h 26 min'); assert.equal(P.formatMinutes(45), '45 min'); assert.equal(P.formatMinutes(120), '2 h');
});

test('fitsBed turns a part about Z but never tips it', () => {
  const a1mini = P.printerById('a1mini').bed;
  assert.ok(P.fitsBed({ x: 170, y: 100, z: 10 }, a1mini));
  assert.ok(!P.fitsBed({ x: 222, y: 150, z: 10 }, a1mini));
  assert.ok(P.fitsBed({ x: 150, y: 222, z: 10 }, P.printerById('a2l').bed));
  assert.ok(!P.fitsBed({ x: 100, y: 14, z: 200 }, a1mini));
});

// the dialog's availability table (pure function; dialog.js touches the DOM only inside createPrint3DDialog)
globalThis.matchMedia ??= () => ({ matches: false });
const { availability, artKind } = await import('../js/print3d/dialog.js');
test('availability: Line art and Contour offer all four; Realistic only C and D; spiral no wire', () => {
  const ids = a => Object.entries(a).filter(([, v]) => v.ok).map(([k]) => k).join(',');
  assert.equal(ids(availability('lineart')), 'plaque,wire,litho,cutter');
  assert.equal(ids(availability('contour')), 'plaque,wire,litho,cutter');
  assert.equal(ids(availability('real')), 'litho,cutter');
  assert.equal(ids(availability('spiral')), 'plaque,litho,cutter');
  for (const k of ['real', 'spiral', 'wander', 'maze', 'lineart', 'contour']) for (const [, v] of Object.entries(availability(k))) if (!v.ok) assert.ok(v.reason && v.suggest, k);
  assert.equal(artKind({ real: {} }), 'real'); assert.equal(artKind({ path: 'lineart', lineart: {} }), 'lineart'); assert.equal(artKind({ path: 'wander' }), 'wander');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
