// Capture real geometries from the running app for the 3D-print prototypes (js/print3d/).
//   node tests/print3d_capture.mjs [--port 8830] [--sample bust] [--only spiral,contour,real,lineart]
// Drives the app headless (window.SP hooks), waits for each build and writes
// shots/print3d/geom_<sample>_<kind>.json: { meta, data: base64 Float32 (n * STRIDE) }.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8830);
const sample = opt('sample', 'bust');
const only = opt('only', 'spiral,contour,wander,real,lineart').split(',');
fs.mkdirSync('shots/print3d', { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const logs = [];
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.SP && window.SP.geom && !window.SP.building, null, { timeout: 90000 });
if (sample !== 'bust') {
  await page.evaluate(id => SP.openSample(id, { announceIt: false }), sample);
  await page.waitForTimeout(500);
  await page.waitForFunction(() => window.SP.geom && !window.SP.building, null, { timeout: 90000 });
}

async function grab(kind) {
  const out = await page.evaluate(() => {
    const g = SP.geom;
    const plain = o => {
      if (!o || typeof o !== 'object') return o ?? null;
      const r = {};
      for (const [k, v] of Object.entries(o)) {
        if (v == null || typeof v === 'function') continue;
        if (ArrayBuffer.isView(v)) continue;
        if (Array.isArray(v)) { if (v.length < 2000) r[k] = v; continue; }
        if (typeof v === 'object') { try { const s = JSON.stringify(v); if (s.length < 200000) r[k] = JSON.parse(s); } catch { } continue; }
        r[k] = v;
      }
      return r;
    };
    const d = g.data.subarray(0, g.n * 7);
    const u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    const meta = { path: g.path, n: g.n, rings: g.rings, turns: g.turns, length: g.length, technique: g.technique,
      minWidth: g.minWidth, penWidth: g.penWidth, shape: g.shape,
      real: plain(g.real), lineart: plain(g.lineart), features: plain(g.features),
      mode: SP.doc.mode, layout: { cx: 0.5, cy: 0.5, r: 0.42 } };
    return { meta, data: btoa(bin) };
  });
  const file = `shots/print3d/geom_${sample}_${kind}.json`;
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(kind, out.meta.path, out.meta.mode, 'n=' + out.meta.n, (fs.statSync(file).size / 1e6).toFixed(1) + ' MB',
    out.meta.real ? 'real ' + out.meta.real.style + ' ' + out.meta.real.toolMm + 'mm/' + out.meta.real.sheetMm : '',
    out.meta.lineart ? 'lineart ' + out.meta.lineart.style + ' ' + out.meta.lineart.toolMm + 'mm/' + out.meta.lineart.sheetMm : '');
}
const idle = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 240000, polling: 300 });

if (only.includes('spiral')) await grab('spiral');
for (const p of ['contour', 'wander']) {
  if (!only.includes(p)) continue;
  await page.evaluate(p => SP.change(d => { d.line.path = p; }), p);
  await idle(p => SP.geom?.path === p && !SP.building, p);
  await grab(p);
}
if (only.includes('real')) {
  await page.evaluate(() => { SP.change(d => { d.line.path = 'spiral'; }); SP.setMode('realistic'); SP.setRealStyle('squiggle'); });
  await idle(() => SP.geom?.real?.style === 'squiggle' && !SP.building);
  await grab('real');
}
if (only.includes('lineart')) {
  await page.evaluate(() => { SP.setMode('lineart'); SP.setLineStyle('matisse'); });
  await idle(() => SP.geom?.path === 'lineart' && SP.geom.lineart?.style === 'matisse' && !SP.building);
  await grab('lineart');
}
if (logs.length) console.log(logs.slice(0, 20).join('\n'));
await browser.close();
