// Offline print timelapse: the service worker precaches the timelapse modules, so "Watch it print"
// works offline for a visitor who never opened it online; and when the module cannot load, the
// dialog says to connect once (not "not available in this version").
//   node tests/print3d_offline.e2e.mjs [--port 8913]
// Starts its OWN dev server on --port (never the shared one) and stops it to go offline.
// The app registers sw.js only on https or 127.0.0.1, so this test uses 127.0.0.1.
// Writes shots/p3_offline_msg.png and shots/p3_offline_film.png.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8913), base = `http://127.0.0.1:${port}/`;
const TL = ['/js/print3d/printfilm.js', '/js/print3d/toolpath.js', '/js/print3d/gcode.js'];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

const server = spawn(process.execPath, ['dev-server.js', String(port)], { cwd: root, stdio: 'ignore' });
const up = async () => { try { return (await fetch(base)).ok; } catch { return false; } };
for (let i = 0; i < 50 && !(await up()); i++) await new Promise(r => setTimeout(r, 200));
check(await up(), `own dev server on ${port} is up`);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const VIEW = { viewport: { width: 1440, height: 940 } };

async function openDialogAndPick(page) {
  const wait = (fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });
  await wait(() => window.SP && window.SP.geom && !window.SP.building);
  await page.evaluate(() => SP.openPrint3d());
  await wait(() => SP.print3d && document.getElementById('p3Dialog').open);
  const id = await page.evaluate(() => {
    const s = SP.print3d, av = s.debug.availability(s.state.kind);
    const id = av.plaque?.ok ? 'plaque' : 'wire';
    s.debug.selectProduct(id);
    return id;
  });
  await wait(id => !SP.print3d.debug.busy && SP.print3d.debug.result?.product === id, id);
  return { id, wait };
}

try {
  // ---- 1. the module cannot load (no service worker, request aborted): the "connect once" message
  {
    const ctx = await browser.newContext({ ...VIEW, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await ctx.route('**/js/print3d/printfilm.js*', r => r.abort('internetdisconnected'));
    await page.goto(base);
    const { id, wait } = await openDialogAndPick(page);
    await page.click('#p3Watch');
    await wait(() => /Connect once/.test(document.getElementById('p3Saved')?.textContent || ''), null, 30000).catch(() => {});
    const msg = await page.evaluate(() => document.getElementById('p3Saved')?.textContent);
    const filmOpen = await page.evaluate(() => !!document.querySelector('dialog.ptl')?.open);
    await page.screenshot({ path: path.join(root, 'shots/p3_offline_msg.png') });
    check(/^Connect once to load the print timelapse/.test(msg || ''), `module blocked (${id}): message "${msg}"`);
    check(!filmOpen, 'no timelapse dialog opened');
    check(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }

  // ---- 2. first visit online (never opens the timelapse), then really offline: it still works
  {
    const ctx = await browser.newContext(VIEW);
    const page = await ctx.newPage();
    const tlRequests = [];
    page.on('request', r => { const p = new URL(r.url()).pathname; if (TL.includes(p)) tlRequests.push(p); });
    await page.goto(base);
    await page.waitForFunction(() => window.SP && window.SP.geom && !window.SP.building, null, { timeout: 120000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    const cache = await page.evaluate(async () => {
      const name = (await caches.keys()).find(k => k.startsWith('spiralist-') && !k.startsWith('spiralist-models'));
      const reqs = name ? await (await caches.open(name)).keys() : [];
      return { name, files: reqs.map(r => new URL(r.url).pathname) };
    });
    console.log(`cache ${cache.name}: ${cache.files.length} files`);
    for (const f of TL) check(cache.files.includes(f), `precached before any use: ${f}`);
    check(tlRequests.length === 0, `the page itself never requested the timelapse modules online (${tlRequests.join(', ') || 'none'})`);

    // go offline for real: stop the server
    server.kill();
    for (let i = 0; i < 25 && (await up()); i++) await new Promise(r => setTimeout(r, 200));
    check(!(await up()), 'server stopped: offline');

    await page.reload();
    const { id, wait } = await openDialogAndPick(page);
    const t0 = Date.now();
    await page.click('#p3Watch');
    let ready = true;
    await wait(() => document.querySelector('dialog.ptl')?.open && document.querySelector('.ptl-busy')?.hidden, null, 180000).catch(() => { ready = false; });
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => ({ sum: document.querySelector('.ptl-sum')?.textContent, saved: document.getElementById('p3Saved')?.textContent }));
    await page.screenshot({ path: path.join(root, 'shots/p3_offline_film.png') });
    check(ready, `offline: timelapse for ${id} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s | ${st.sum || ''} | status "${st.saved || ''}"`);
    await page.keyboard.press('Escape');
    await ctx.close();
  }
} catch (e) {
  fails++;
  console.log('FAIL', e.message.split('\n')[0]);
} finally {
  server.kill();
  await browser.close();
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
