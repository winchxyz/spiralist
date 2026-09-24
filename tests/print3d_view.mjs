// Headless stills from the print viewer lab (dev/print3d_view.html) into shots/print3d/.
//   node tests/print3d_view.mjs "shots=basic,plaque;w=1200;h=900" [--port 8830] [--prefix view_] [--ui]
//   --ui also saves a page screenshot (use with an interactive query such as "scene=plaque")
// Waits for window.__done, writes each window.__shots entry as shots/print3d/<prefix><name>.jpg
// and prints the per-scene stats plus console errors. Exit code 1 on failure.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const query = (args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || 'shots=basic').replace(/;/g, '&');
const port = +opt('port', 8830);
const prefix = opt('prefix', 'view_');
fs.mkdirSync('shots/print3d', { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
const t0 = Date.now();
await page.goto(`http://localhost:${port}/dev/print3d_view.html?${query}`);
let done;
try {
  await page.waitForFunction(() => window.__done, null, { timeout: 240000, polling: 250 });
  done = await page.evaluate(() => window.__done);
} catch (e) { done = { ok: false, error: 'timeout ' + e.message }; }
const shots = await page.evaluate(() => window.__shots || []);
if (args.includes('--ui')) { await page.screenshot({ path: `shots/print3d/${prefix}ui.png` }); console.log('wrote', `shots/print3d/${prefix}ui.png`); }
for (const s of shots) {
  const file = `shots/print3d/${prefix}${s.name}.jpg`;
  fs.writeFileSync(file, Buffer.from(s.data.split(',')[1], 'base64'));
  console.log('wrote', file, (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
}
console.log(JSON.stringify({ secs: (Date.now() - t0) / 1000, done }, null, 1));
if (errors.length) console.log('console:\n' + errors.slice(0, 30).join('\n'));
await browser.close();
process.exit(done && done.ok ? 0 : 1);
