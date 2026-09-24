// Drive the app's real 3D print dialog headless: every mode x product, screenshots and exports.
//   node tests/print3d_dialog.mjs [--modes spiral,contour,real,lineart] [--products plaque,wire]
//        [--mobile] [--theme light|dark] [--export] [--port 8830] [--tag x]
// The app offers the relief plaque and the wire sculpture. Realistic mode does not open the dialog: it
// shows a toast that offers Line art, and the run checks that instead.
// Writes shots/p3_<tag?><mode>_<product>_<desk|mob>_<theme>.png, and with --export the dialog's own
// files to shots/print3d/dlg_<mode>_<product>.3mf / .stl|.zip, plus shots/print3d/dlg_report.json.
// Prints console errors (the run fails when there are any).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = k => args.includes('--' + k);
const port = +opt('port', 8830);
const modes = opt('modes', 'spiral,contour,real,lineart').split(',');
const products = opt('products', 'plaque,wire').split(',');
const mobile = has('mobile'), theme = opt('theme', 'light'), doExport = has('export'), tag = opt('tag', '');
const extra = opt('eval', '');   // JS run after each product is selected (e.g. colour tests)
fs.mkdirSync('shots/print3d', { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctxOpts = mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 };
const context = await browser.newContext({ ...ctxOpts, colorScheme: theme, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
const warns = [];
page.on('console', m => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); else if (m.type() === 'warning') warns.push(m.text()); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
await page.goto(`http://localhost:${port}/`);
const T = +opt('timeout', 90000);
const idle = async (fn, arg, timeout = T) => {
  try { return await page.waitForFunction(fn, arg, { timeout, polling: 250 }); }
  catch (e) {
    const st = await page.evaluate(() => ({ err: SP.print3d?.state.error, busy: SP.print3d?.debug.busy, product: SP.print3d?.state.product, result: SP.print3d?.debug.result?.product,
      report: document.getElementById('p3Report')?.textContent, busyText: document.getElementById('p3BusyText')?.textContent })).catch(x => String(x));
    console.log('TIMEOUT', JSON.stringify(st), '| warnings:', warns.slice(-8).join(' || '), '| errors:', errors.join(' || '));
    await page.screenshot({ path: 'shots/p3_timeout.png' });
    throw e;
  }
};
await idle(() => window.SP && window.SP.geom && !window.SP.building);

const report = [];
for (const mode of modes) {
  // set the mode
  await page.evaluate(() => SP.print3d?.close());
  if (mode === 'spiral' || mode === 'contour' || mode === 'wander' || mode === 'maze') {
    await page.evaluate(p => { SP.setMode('artistic'); SP.change(d => { d.line.path = p; }); }, mode);
    await idle(p => SP.geom?.path === p && !SP.geom.real && !SP.geom.lineart && !SP.building, mode);
  } else if (mode === 'real') {
    await page.evaluate(() => { SP.change(d => { d.line.path = 'spiral'; }); SP.setMode('realistic'); SP.setRealStyle('squiggle'); });
    await idle(() => SP.geom?.real?.style === 'squiggle' && !SP.building);
  } else if (mode === 'lineart') {
    await page.evaluate(() => { SP.setMode('lineart'); SP.setLineStyle('matisse'); });
    await idle(() => SP.geom?.path === 'lineart' && !SP.building);
  }
  if (mode === 'real') {
    // plotter styles are not printable: a toast offers Line art and the dialog stays shut
    await page.evaluate(() => SP.openPrint3d());
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({ open: !!document.getElementById('p3Dialog')?.open,
      toast: document.querySelector('#toasts .toast')?.textContent.trim().replace(/\s+/g, ' ') || '' }));
    const ok = !r.open && /Line art/.test(r.toast);
    if (!ok) errors.push(`[real] expected the Line art toast and no dialog, got ${JSON.stringify(r)}`);
    report.push({ mode, product: null, available: false, reason: r.toast });
    console.log(mode, ok ? 'toast, no dialog:' : 'WRONG:', r.toast);
    await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
    continue;
  }
  await page.evaluate(() => SP.openPrint3d());
  await idle(() => SP.print3d && document.getElementById('p3Dialog').open);
  const av = await page.evaluate(() => { const s = SP.print3d.state; return SP.print3d.debug.availability(s.kind); });
  for (const id of products) {
    const row = { mode, product: id, available: av[id].ok, reason: av[id].reason || '' };
    if (!av[id].ok) {
      // show the dialog on the product the app picked, with the disabled card and its reason
      await idle(() => !SP.print3d.debug.busy && SP.print3d.debug.result);
      await page.waitForTimeout(500);
      const shot = `shots/p3_${tag}${mode}_${id}-off_${mobile ? 'mob' : 'desk'}_${theme}.png`;
      await page.screenshot({ path: shot });
      row.shot = shot; report.push(row); console.log(mode, id, 'NOT OFFERED:', row.reason); continue;
    }
    const t0 = Date.now();
    // main-thread long tasks while the product builds (the meshes are built in the worker)
    await page.evaluate(() => { window.__lt = []; try { window.__ltObs?.disconnect(); window.__ltObs = new PerformanceObserver(l => window.__lt.push(...l.getEntries().map(e => Math.round(e.duration)))); window.__ltObs.observe({ type: 'longtask' }); } catch { } });
    await page.evaluate(id => SP.print3d.debug.selectProduct(id), id);
    await idle(id => !SP.print3d.debug.busy && SP.print3d.debug.result?.product === id, id);
    row.waitMs = Date.now() - t0;
    row.longTasks = await page.evaluate(() => (window.__lt || []).slice());
    if (extra) { await page.evaluate(extra); await idle(() => !SP.print3d.debug.busy && SP.print3d.debug.result); }
    await page.waitForTimeout(700);
    const info = await page.evaluate(() => {
      const r = SP.print3d.debug.result, s = SP.print3d.state;
      return { sizeMm: r.sizeMm, parts: r.parts.map(p => ({ name: p.name, size: p.size, tris: p.triangles, volume: Math.round(p.volume) })),
        ok: r.printability.ok, issues: r.printability.issues, manifold: r.stats.manifold, buildMs: r.stats.buildMs, wallMs: r.wallMs,
        estimate: s.estimate, warnings: [...document.querySelectorAll('#p3ColorWarn .hint-card')].map(e => e.textContent.trim().replace(/\s+/g, ' ')),
        colors: SP.print3d.debug.coloredParts().map(p => `${p.name}:${p.color}/slot${p.slot}`), backdrop: s.backdrop,
        fit: document.getElementById('p3Fit').textContent };
    });
    Object.assign(row, info);
    // a scroll of the dialog body to its report shows the whole thing in two shots on mobile
    const shot = `shots/p3_${tag}${mode}_${id}_${mobile ? 'mob' : 'desk'}_${theme}.png`;
    await page.evaluate(() => { document.querySelector('#p3Dialog .p3-body').scrollTop = 0; });
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot });
    row.shot = shot;
    if (mobile) {
      await page.evaluate(() => { const b = document.querySelector('#p3Dialog .p3-body'); b.scrollTop = b.scrollHeight; });
      await page.waitForTimeout(200);
      await page.screenshot({ path: shot.replace('.png', '_b.png') });
    }
    if (has('watch')) {
      // 'Watch it print' opens the print timelapse (js/print3d/printfilm.js) over this dialog
      await page.click('#p3Watch');
      await idle(() => document.querySelector('dialog.ptl[open]'), null, 60000);
      await page.waitForTimeout(+opt('watchMs', 5000));
      await page.screenshot({ path: `shots/p3_${tag}watch_${mode}_${id}_${mobile ? 'mob' : 'desk'}_${theme}.png` });
      await page.evaluate(() => document.querySelector('dialog.ptl[open]')?.querySelector('.ptl-close')?.click());
      await idle(() => !document.querySelector('dialog.ptl[open]') && document.getElementById('p3Dialog').open, null, 10000);
    }
    if (doExport) {
      for (const fmt of ['3mf', 'stl']) {
        const f = await page.evaluate(async fmt => {
          const f = await SP.print3d.debug.exportFile(fmt);
          const u8 = new Uint8Array(f.bytes);
          let bin = '';
          for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
          return { name: f.name, b64: btoa(bin), ms: SP.print3d.state.lastExport.ms };
        }, fmt);
        const ext = f.name.split('.').pop();
        const out = `shots/print3d/dlg_${tag}${mode}_${id}.${ext}`;
        fs.writeFileSync(out, Buffer.from(f.b64, 'base64'));
        row[fmt + 'File'] = out; row[fmt + 'Name'] = f.name; row[fmt + 'Ms'] = f.ms;
      }
    }
    report.push(row);
    console.log(mode, id, row.ok ? 'prints' : 'NEEDS CHANGES', `X 0-${row.sizeMm.x[1]} Y 0-${row.sizeMm.y[1]} Z 0-${row.sizeMm.z[1]} mm`,
      `build ${row.buildMs} ms (wall ${row.wallMs})`, row.estimate ? `${row.estimate.grams} g ${row.estimate.minutes} min` : '', row.warnings.length ? 'WARN: ' + row.warnings.join(' | ') : '',
      row.manifold.every(m => m.ok) ? 'watertight' : 'NOT WATERTIGHT', `longest main-thread task ${Math.max(0, ...row.longTasks)} ms`, doExport ? `3mf ${row['3mfMs']} ms, stl ${row.stlMs} ms` : '');
  }
}
fs.writeFileSync(`shots/print3d/dlg_report${tag ? '_' + tag : ''}${mobile ? '_mob' : ''}.json`, JSON.stringify(report, null, 1));
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'console errors: 0');
await browser.close();
process.exit(errors.length ? 1 : 0);
