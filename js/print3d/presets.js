// 3D print presets: printers, filament swatches, preview backdrops, and the colour-contrast rules
// that keep a line readable on its plate (never a black line on a black plate, never a dark wire on
// a dark backdrop). No DOM; runs in node for the tests.
//
// Swatch colours are the on-screen approximations of Bambu Lab's Basic filaments (the hex codes the
// Bambu store and Bambu Studio show); real plastic looks a little different, glossier for PETG.

export const PRINTERS = [
  { id: 'a1mini', name: 'Bambu Lab A1 mini', bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, kinematics: 'bedslinger', speed: 1.0, multi: 'ams' },
  { id: 'a1', name: 'Bambu Lab A1', bed: { x: 256, y: 256, z: 256 }, nozzle: 0.4, kinematics: 'bedslinger', speed: 1.0, multi: 'ams' },
  { id: 'a2l', name: 'Bambu Lab A2L', bed: { x: 330, y: 320, z: 325 }, nozzle: 0.4, kinematics: 'bedslinger', speed: 1.0, multi: 'ams' },
  { id: 'p1s', name: 'Bambu Lab P1S', bed: { x: 256, y: 256, z: 256 }, nozzle: 0.4, kinematics: 'corexy', speed: 0.85, multi: 'ams' },
  { id: 'x1c', name: 'Bambu Lab X1C', bed: { x: 256, y: 256, z: 256 }, nozzle: 0.4, kinematics: 'corexy', speed: 0.85, multi: 'ams' },
  { id: 'mk4', name: 'Prusa MK4', bed: { x: 250, y: 210, z: 220 }, nozzle: 0.4, kinematics: 'bedslinger', speed: 1.3, multi: 'swap' },
  { id: 'mini', name: 'Prusa MINI+', bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, kinematics: 'bedslinger', speed: 1.7, multi: 'swap' },
  { id: 'ender3', name: 'Creality Ender-3', bed: { x: 220, y: 220, z: 250 }, nozzle: 0.4, kinematics: 'bedslinger', speed: 2.4, multi: 'swap' },
  { id: 'generic', name: 'Generic 220 x 220', bed: { x: 220, y: 220, z: 250 }, nozzle: 0.4, kinematics: 'bedslinger', speed: 2.2, multi: 'swap' },
];
export const DEFAULT_PRINTER = 'a2l';
export const printerById = id => PRINTERS.find(p => p.id === id) || PRINTERS.find(p => p.id === DEFAULT_PRINTER);

// density g/cm3; view material for the preview
export const MATERIALS = {
  petg: { id: 'petg', name: 'PETG Basic', density: 1.27, view: 'petg' },
  pla: { id: 'pla', name: 'PLA Basic', density: 1.24, view: 'pla' },
};

const S = (name, hex) => ({ name, hex });
export const SWATCHES = {
  pla: [
    S('Jade White', '#FFFFFF'), S('Beige', '#F7E6DE'), S('Light Gray', '#D0D2D4'), S('Yellow', '#F4EE2A'),
    S('Sunflower Yellow', '#FEC600'), S('Pumpkin Orange', '#FF9016'), S('Orange', '#FF6A13'), S('Gold', '#E4BD68'),
    S('Bright Green', '#BECF00'), S('Bambu Green', '#00AE42'), S('Mistletoe Green', '#3F8E43'), S('Turquoise', '#00B1B7'),
    S('Cyan', '#0086D6'), S('Cobalt Blue', '#0056B8'), S('Blue', '#0A2989'), S('Purple', '#5E43B7'),
    S('Indigo Purple', '#482960'), S('Pink', '#F55A74'), S('Magenta', '#EC008C'), S('Red', '#C12E1F'),
    S('Maroon Red', '#9D2235'), S('Brown', '#9D432C'), S('Cocoa Brown', '#6F5034'), S('Bronze', '#847D48'),
    S('Silver', '#A6A9AA'), S('Gray', '#8E9089'), S('Blue Grey', '#5B6579'), S('Dark Gray', '#545454'), S('Black', '#000000'),
  ],
  petg: [
    S('White', '#FFFFFF'), S('Light Gray', '#D0D2D4'), S('Yellow', '#F4EE2A'), S('Orange', '#FF6A13'),
    S('Bambu Green', '#00AE42'), S('Cyan', '#0086D6'), S('Blue', '#0A2989'), S('Red', '#C12E1F'),
    S('Brown', '#9D432C'), S('Gray', '#8E9089'), S('Dark Gray', '#545454'), S('Black', '#000000'),
  ],
};

/** Preview backdrops: the view.js bed, and the colour the eye compares the print against. */
export const BACKDROPS = [
  { id: 'pei', name: 'Textured PEI plate', bed: 'pei', tone: '#B9AB8E' },
  { id: 'desk', name: 'Light wood desk', bed: 'desk', tone: '#C9A57A' },
  { id: 'studio', name: 'Studio white', bed: false, background: '#E4E4E7', tone: '#E4E4E7' },
  { id: 'dark', name: 'Graphite', bed: 'dark', tone: '#26262A' },
];
export const backdropById = id => BACKDROPS.find(b => b.id === id) || BACKDROPS[0];

// ---------------------------------------------------------------- colour maths

export function hexRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export function luminance(hex) { const [r, g, b] = hexRgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
export function contrastRatio(a, b) { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
export function lab(hex) {
  const [r, g, b] = hexRgb(hex).map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export function deltaE(a, b) { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
export const isDark = hex => lab(hex)[0] < 45;

/**
 * How well two colours read against each other: { level: 'good' | 'weak' | 'bad', ratio, dE, why }.
 * bad  = nearly the same colour (the line disappears);
 * weak = both dark, or close in lightness and hue (reads in real light, poorly in a photo).
 */
export function pairVerdict(a, b) {
  const ratio = contrastRatio(a, b), dE = deltaE(a, b);
  const La = lab(a)[0], Lb = lab(b)[0];
  let level = 'good', why = '';
  // brightness decides first: two colours of the same lightness blur together in photos, in the
  // film and for colour-blind eyes, however different their hues (yellow on white, orange on green)
  if (dE < 18 || ratio < 1.15) { level = 'bad'; why = dE < 18 ? 'The two colours are almost the same, so the line would disappear into the plate.' : 'The two colours are equally light, so the line all but disappears in a photo (and for colour-blind eyes).'; }
  else if (Math.max(La, Lb) < 45) { level = 'weak'; why = 'Both colours are dark, so the line is hard to see.'; }
  else if (ratio < 1.5) { level = 'weak'; why = 'The colours are close in lightness, so the line reads faintly (in photos and for colour-blind eyes too).'; }
  else if (ratio < 1.6 && dE < 40) { level = 'weak'; why = 'The colours are close in lightness and hue, so the line reads faintly.'; }
  return { level, ratio: +ratio.toFixed(2), dE: Math.round(dE), why };
}

/** The swatch that contrasts best with `hex` (white or black first, since they read best). */
export function contrastingSwatch(hex, material = 'petg') {
  const list = SWATCHES[material] || SWATCHES.petg;
  const white = list[0], black = list.find(s => s.hex === '#000000') || list[list.length - 1];
  return isDark(hex) || luminance(hex) < 0.18 ? white : black;
}

/** The backdrop that shows an object of colour `hex` best (the PEI plate unless it is too close). */
export function bestBackdrop(hex) {
  const order = isDark(hex) ? ['pei', 'studio', 'desk', 'dark'] : ['pei', 'dark', 'desk', 'studio'];
  for (const id of order) if (pairVerdict(hex, backdropById(id).tone).level === 'good') return id;
  return isDark(hex) ? 'studio' : 'dark';
}

// ---------------------------------------------------------------- colour roles per product

/**
 * The colours a product is printed in. roles: which pickers the dialog shows.
 *  plaque: base (plate + feet, the "background") and line (the raised line, the "ink")
 *  wire:   line (wire + stand); the backdrop is its background
 *  litho:  panel only (one colour: the picture is light through thicker and thinner plastic)
 *  cutter: cutter and stamp
 */
export const ROLES = {
  plaque: [{ id: 'base', label: 'Base (background)', parts: /^(Plate|Stand)/ }, { id: 'line', label: 'Line (ink)', parts: /^Line/ }],
  wire: [{ id: 'line', label: 'Wire (ink)', parts: /./ }],
  litho: [{ id: 'panel', label: 'Panel', parts: /./ }],
  cutter: [{ id: 'cutter', label: 'Cutter', parts: /^Cutter/ }, { id: 'stamp', label: 'Stamp', parts: /^Stamp/ }],
};

export const DEFAULT_COLORS = {
  plaque: { base: '#FFFFFF', line: '#000000' },
  wire: { line: '#000000' },
  litho: { panel: '#FFFFFF' },
  cutter: { cutter: '#FF6A13', stamp: '#FF6A13' },   // one filament: two colours on one plate cost an AMS swap per layer
};

/** The colour the whole object mostly reads as (for the backdrop check). */
export function dominantColor(product, colors) {
  const c = colors || DEFAULT_COLORS[product];
  return product === 'plaque' ? c.base : product === 'wire' ? c.line : product === 'litho' ? c.panel : c.cutter;
}

/** Give every part its colour; parts of one colour share one filament slot (1-based). */
export function colorParts(product, parts, colors) {
  const roles = ROLES[product] || [];
  const slots = [];
  return parts.map(p => {
    const role = roles.find(r => r.parts.test(p.name)) || roles[0];
    const color = (role && colors[role.id]) || p.color;
    let slot = slots.indexOf(color.toUpperCase()) + 1;
    if (!slot) { slots.push(color.toUpperCase()); slot = slots.length; }
    return { ...p, color, slot, role: role?.id };
  });
}

/** Every warning for a colour choice: [{ kind: 'pair' | 'backdrop' | 'litho', level, text, fix: { role | backdrop, value, label } }]. */
export function colorWarnings(product, colors, backdropId, material = 'petg') {
  const out = [];
  if (product === 'plaque') {
    const v = pairVerdict(colors.base, colors.line);
    if (v.level !== 'good') {
      // two real fixes, one per role (a swap would keep the same pair, so it is never offered)
      const s = contrastingSwatch(colors.base, material), t = contrastingSwatch(colors.line, material);
      const alt = t.hex.toUpperCase() !== String(colors.base).toUpperCase() ? { role: 'base', value: t.hex, label: `Use a ${t.name.toLowerCase()} plate` } : null;
      out.push({ kind: 'pair', level: v.level, text: v.why, fix: { role: 'line', value: s.hex, label: `Use a ${s.name.toLowerCase()} line` }, fix2: alt });
    }
  }
  if (product === 'cutter' && colors.stamp && String(colors.stamp).toUpperCase() !== String(colors.cutter).toUpperCase()) {
    out.push({ kind: 'plates', level: 'note', text: 'Two colours: the stamp goes on a second plate in the 3MF, so each plate prints in one filament with no swaps.',
      fix: { role: 'stamp', value: colors.cutter, label: 'Use one colour' } });
  }
  if (product === 'litho' && lab(colors.panel)[0] < 80) {
    out.push({ kind: 'litho', level: lab(colors.panel)[0] < 55 ? 'bad' : 'weak', text: 'A lithophane needs light to pass through: dark or strong colours block it and the picture stays hidden.',
      fix: { role: 'panel', value: '#FFFFFF', label: 'Use white' } });
  }
  const dom = dominantColor(product, colors), bd = backdropById(backdropId);
  const vb = pairVerdict(dom, bd.tone);
  if (vb.level !== 'good') {
    const best = backdropById(bestBackdrop(dom));
    out.push({ kind: 'backdrop', level: vb.level, text: `The ${product === 'wire' ? 'wire' : 'print'} is hard to see on the ${bd.name.toLowerCase()}.`,
      fix: { backdrop: best.id, label: `Show it on the ${best.name.replace(/^[A-Z][a-z]/, c => c.toLowerCase())}` } });
  }
  return out;
}

// ---------------------------------------------------------------- estimates

/**
 * Filament and time, estimated from the parts' volume (fitted to Bambu Studio slices of the four
 * products on the A2L: within about 20%). Returns { grams, minutes, layers }.
 */
export function estimate({ volumeMm3, heightMm, triangles = 0, product, material = 'petg', printer }) {
  const m = MATERIALS[material] || MATERIALS.petg;
  const cm3 = volumeMm3 / 1000;
  const grams = cm3 * m.density * 0.63;
  const layers = Math.max(1, Math.round(heightMm / 0.2));
  // the wire is almost all perimeter (slow, short moves): refitted on Bambu Studio slices at 180 mm
  // (38 min, 5.4 g) and 300 mm (63 min, 9.2 g), which the volume fit ran 30-40% under
  const wire = product === 'wire';
  const perimeters = product === 'litho' ? 0 : triangles * 0.00045 * (wire ? 2.27 : 1);
  const speed = printer?.speed || 1;
  const minutes = (0.9 * cm3 + 0.2 * layers + 8 + perimeters) * speed;
  return { grams: Math.max(1, Math.round(grams * (wire ? 1.4 : 1))), minutes: Math.max(5, Math.round(minutes)), layers };
}

export function formatMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** Does a part (x, y, z mm) fit the bed? It may turn 90 degrees about Z. */
export function fitsBed(part, bed) {
  return part.z <= bed.z && (part.x <= bed.x && part.y <= bed.y || part.y <= bed.x && part.x <= bed.y);
}
