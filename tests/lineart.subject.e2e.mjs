// Line art silhouettes in the real app: load test-set photos through the file input, check what the
// silhouette found ("Subject: cat"), tap a subject on the stage, undo / redo the tap, keep it over a
// reload, and switch through all three modes. Fails on console errors.
//   node tests/lineart.subject.e2e.mjs [--imgs cat_sitting,lighthouse] [--taps "lighthouse:0.5,0.4;bicycle:0.5,0.6"]
//        [--mobile] [--theme dark] [--prefix si_] [--persist] [--modes] [--style matisse] [--port 8830]
// Photos come from shots/testset/<id>.jpg. Taps are art-frame fractions (0..1, x right, y down).
// Screenshots go to shots/<prefix><id>_auto.png, _pick.png, _tap.png. Prints one JSON line per photo
// and, at the end, the Line art files the first use fetched (unique URLs, bytes).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const mobile = flag('mobile');
const theme = opt('theme', 'light');
const prefix = opt('prefix', 'si_');
const port = opt('port', '8830');
const imgs = opt('imgs', 'cat_sitting').split(',').filter(Boolean);
const taps = Object.fromEntries(opt('taps', '').split(';').filter(Boolean).map(s => {
  const [id, xy] = s.split(':'); return [id, xy.split(',').map(Number)];
}));
const W = mobile ? 390 : 1440, H = mobile ? 844 : 900;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: mobile ? 3 : 1.5, colorScheme: theme,
  hasTouch: mobile, isMobile: mobile,
});
const page = await context.newPage();
const logs = [];
page.on('console', m => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
// (a model file whose duplicate fetch Chrome aborts, ERR_ABORTED, is a note: the other fetch serves it)
const aborted = [];
page.on('requestfailed', r => {
  if (/__shot/.test(r.url())) return;
  const t = `${r.url()} ${r.failure()?.errorText || ''}`;
  if (/\/vendor\//.test(r.url()) && /ERR_ABORTED/.test(t)) aborted.push(t); else logs.push('[requestfailed] ' + t);
});
page.on('response', r => { if (r.status() >= 400) logs.push(`[${r.status()}] ${r.url()}`); });
const fetched = new Map();
page.on('requestfinished', async q => {
  const u = new URL(q.url());
  if (!/\/vendor\/(ort|mediapipe|models)\//.test(u.pathname)) return;
  const len = (await q.sizes().catch(() => ({}))).responseBodySize || 0;
  fetched.set(u.pathname, Math.max(fetched.get(u.pathname) || 0, len));
});

// (a CDP capture: Playwright's screenshot waits on document.fonts.ready, which can stall for many
// seconds while the style cards render their wet media)
let cdp = null;
const shot = async name => {
  const file = path.join(root, 'shots', `${prefix}${name}.png`);
  cdp ||= await context.newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
};
const idle = async (ms = 180000) => {
  await page.waitForFunction(() => window.SP && window.SP.photo && !window.SP.building && window.SP.geom && window.SP.geom.lineart
    && !document.getElementById('sheet').classList.contains('building'), null, { timeout: ms, polling: 250 });
  // the reveal plays the drawing: let it finish before a screenshot
  await page.waitForFunction(() => !SP.play.playing, null, { timeout: 60000, polling: 250 }).catch(() => {});
  await page.waitForTimeout(700);
};
const state = () => page.evaluate(() => {
  const g = SP.geom && SP.geom.lineart;
  return { subject: SP.lineSubject, doc: SP.doc.subject, mode: SP.doc.mode,
    sil: g && g.silhouette, silScore: g && g.silScore && +(+g.silScore.score).toFixed(3),
    lengthM: g && +(+g.lengthM).toFixed(2), handS: g && Math.round(g.handSeconds),
    row: document.getElementById('subjectSub')?.textContent || '' };
});
/** Click (or tap on a phone) the stage at an art-frame point. */
async function tapFrame(fx, fy) {
  const r = await page.evaluate(() => { const b = document.getElementById('sheet').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width }; });
  const x = r.x + (0.5 + (2 * fx - 1) * 0.42) * r.w, y = r.y + (0.5 + (2 * fy - 1) * 0.42) * r.w;
  if (mobile) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
}
const clickUi = async sel => {
  const el = page.locator(sel).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  // (a trusted click when the page settles; the style cards' wet-media renders can keep Playwright's
  // "stable" check waiting, then a DOM click does the same thing)
  try { await el.click({ timeout: 8000 }); }
  catch { const t = Date.now(); await page.evaluate(q => document.querySelector(q).click(), sel); console.log(`(dom click ${sel}, page answered in ${Date.now() - t} ms)`); }
};

await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.SP && window.SP.geom, null, { timeout: 60000 });
await page.evaluate(() => SP.setMode('lineart'));
const t0 = Date.now();
const out = [];
let failed = false;
for (const id of imgs) {
  const file = path.join(root, 'shots', 'testset', id + '.jpg');
  if (!fs.existsSync(file)) { console.log(JSON.stringify({ id, error: 'missing ' + file })); failed = true; continue; }
  const ts = Date.now();
  await page.setInputFiles('#fileInput', file);
  await page.waitForFunction(n => window.SP && SP.photo && SP.photo.name && SP.photo.name.startsWith(n), id, { timeout: 30000 });
  if (mobile) await page.evaluate(() => document.querySelector('[data-tab="looks"]')?.click());
  await idle();
  const rec = { id, readMs: Date.now() - ts, auto: await state() };
  await shot(`${id}_auto`);
  const tap = taps[id];
  if (tap) {
    await clickUi('#btnPickSubject');
    await page.waitForTimeout(400);
    rec.pickHint = await page.evaluate(() => !document.getElementById('subjectHint').hidden);
    await shot(`${id}_pick`);
    const tt = Date.now();
    await tapFrame(tap[0], tap[1]);
    await page.waitForTimeout(300);
    await idle(60000);
    rec.tapMs = Date.now() - tt;
    rec.tapped = await state();
    await shot(`${id}_tap`);
    // undo and redo the tap
    await clickUi('#btnUndo'); await page.waitForTimeout(300); await idle(60000);
    rec.undo = (await state()).subject;
    await clickUi('#btnRedo'); await page.waitForTimeout(300); await idle(60000);
    rec.redo = (await state()).subject;
    if (rec.undo.tap !== null || !rec.redo.tap || !rec.tapped.subject.tapped) { rec.fail = 'undo/redo or tap did not take'; failed = true; }
  }
  out.push(rec);
  console.log(JSON.stringify(rec));
}

if (flag('persist') && out.length) {
  // the tap is saved with the photo: reload and continue
  await page.waitForTimeout(1200);
  const before = await page.evaluate(() => SP.doc.subject);
  await page.reload();
  await page.waitForFunction(() => window.SP && window.SP.geom, null, { timeout: 60000 });
  await page.evaluate(() => SP.setMode('lineart'));
  const last = out[out.length - 1].id;
  await clickUi('#btnContinue');
  await page.waitForFunction(n => SP.photo && SP.photo.name && SP.photo.name.startsWith(n), last, { timeout: 30000 });
  await idle();
  const after = await state();
  const ok = JSON.stringify(before) === JSON.stringify(after.doc);
  console.log(JSON.stringify({ persist: { before, after: after.doc, label: after.subject.label, ok } }));
  if (!ok) failed = true;
  await shot('persist');
}

if (flag('modes')) {
  const modes = {};
  for (const m of ['artistic', 'realistic', 'lineart']) {
    await page.evaluate(v => SP.setMode(v), m);
    await page.waitForFunction(() => window.SP && !SP.building && SP.geom, null, { timeout: 120000, polling: 250 });
    await page.waitForTimeout(600);
    modes[m] = await page.evaluate(() => ({ path: SP.geom.path || null, n: SP.geom.n, row: document.getElementById('subjectRow').checkVisibility() }));
    await shot(`mode_${m}`);
  }
  console.log(JSON.stringify({ modes }));
  if (modes.artistic.row || modes.realistic.row || !modes.lineart.row) failed = true;
}

const bytes = [...fetched.values()].reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ fetched: Object.fromEntries(fetched), uniqueBytes: bytes, MB: +(bytes / 1e6).toFixed(1), totalS: Math.round((Date.now() - t0) / 1000) }));
if (logs.length) { console.log(logs.slice(0, 30).join('\n')); failed = true; }
console.log(failed ? 'FAIL' : 'PASS');
await browser.close();
process.exit(failed ? 1 : 0);
