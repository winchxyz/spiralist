// Headless capture of dev/print3d_lineup.html into shots/print3d/lineup.jpg (+ per-tile stills).
//   node tests/print3d_lineup_shot.mjs ["tile=440"] [--port 8830]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const query = (args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || '').replace(/;/g, '&');
const port = +opt('port', 8830);
fs.mkdirSync('shots/print3d', { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
const t0 = Date.now();
await page.goto(`http://localhost:${port}/dev/print3d_lineup.html?${query}`);
let done;
try {
  await page.waitForFunction(() => window.__done, null, { timeout: 300000, polling: 250 });
  done = await page.evaluate(() => window.__done);
} catch (e) { done = { ok: false, error: 'timeout ' + e.message }; }
const shots = await page.evaluate(() => window.__shots || []);
for (const s of shots) {
  const file = `shots/print3d/${s.name}.jpg`;
  fs.writeFileSync(file, Buffer.from(s.data.split(',')[1], 'base64'));
  console.log('wrote', file, (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
}
console.log(JSON.stringify({ secs: (Date.now() - t0) / 1000, ok: done?.ok, error: done?.error, reportCells: done?.reportCells }));
if (errors.length) console.log('console:\n' + errors.slice(0, 30).join('\n'));
await browser.close();
process.exit(done && done.ok ? 0 : 1);
