// End to end in the real app: Line art -> 3D print dialog -> "Watch it print" -> the print timelapse.
//   node tests/print3d_film.e2e.mjs [--products plaque,wire] [--port 8830] [--mobile]
// Writes shots/print3d/film_e2e_<product>.png; fails on console errors or when the film does not start.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8830), products = opt('products', 'plaque,wire').split(','), mobile = args.includes('--mobile');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 940 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
const wait = (fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });
await page.goto(`http://localhost:${port}/`);
await wait(() => window.SP && window.SP.geom && !window.SP.building);
await page.evaluate(() => { SP.setMode('lineart'); SP.setLineStyle('matisse'); });
await wait(() => SP.geom?.path === 'lineart' && !SP.building);
let fails = 0;
for (const id of products) {
  await page.evaluate(() => SP.print3d?.close());
  await page.evaluate(() => SP.openPrint3d());
  await wait(() => SP.print3d && document.getElementById('p3Dialog').open);
  await page.evaluate(id => SP.print3d.debug.selectProduct(id), id);
  await wait(id => !SP.print3d.debug.busy && SP.print3d.debug.result?.product === id, id);
  const t0 = Date.now();
  await page.click('#p3Watch');
  try {
    await wait(() => document.querySelector('dialog.ptl')?.open && document.querySelector('.ptl-busy')?.hidden, null, 180000);
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => ({ info: document.querySelector('.ptl-info')?.textContent, sum: document.querySelector('.ptl-sum')?.textContent, printer: document.querySelector('.ptl-printer')?.selectedOptions[0]?.textContent }));
    await page.screenshot({ path: `shots/print3d/film_e2e_${id}${mobile ? '_mob' : ''}.png` });
    console.log(`${id}: film ready in ${((Date.now() - t0) / 1000).toFixed(1)} s | ${st.sum} | ${st.printer} | ${st.info}`);
  } catch (e) {
    fails++;
    console.log(`${id}: FAIL`, e.message.split('\n')[0], await page.evaluate(() => document.querySelector('.ptl-busy-txt')?.textContent || document.getElementById('p3Saved')?.textContent));
  }
  // close the timelapse (Escape), back to the print dialog
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const left = await page.evaluate(() => !!document.querySelector('dialog.ptl'));
  if (left) { fails++; console.log(`${id}: FAIL the timelapse dialog did not close`); }
}
if (errors.length) { fails++; console.log('console errors:\n' + errors.slice(0, 20).join('\n')); }
console.log(fails ? `${fails} FAILED` : 'all ok');
await browser.close();
process.exit(fails ? 1 : 0);
