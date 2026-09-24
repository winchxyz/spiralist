// Headless driver for dev/print3d_mesh.html: loads the page, waits for window.__done, saves its
// JPEG shot to shots/print3d/<name>.jpg and prints the rest.
//   node tests/print3d_shot.mjs "kind=spiral;size=150" mesh_spiral [--port 8830]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core');

const args = process.argv.slice(2);
const query = (args[0] || '').replace(/;/g, '&');
const name = args[1] || 'mesh_shot';
const pi = args.indexOf('--port'), port = pi >= 0 ? +args[pi + 1] : 8830;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1520, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));
await page.goto(`http://localhost:${port}/dev/print3d_mesh.html?${query}`);
let done;
try { await page.waitForFunction(() => window.__done, null, { timeout: 120000, polling: 200 }); done = await page.evaluate(() => window.__done); }
catch (e) { done = { ok: false, error: 'timeout' }; }
await browser.close();
if (done.shot) {
  const dir = new URL('../shots/print3d/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${name}.jpg`, dir), Buffer.from(done.shot.split(',')[1], 'base64'));
  delete done.shot;
}
console.log(JSON.stringify({ name, ...done, errors }, null, 1));
process.exit(done.ok ? 0 : 1);
