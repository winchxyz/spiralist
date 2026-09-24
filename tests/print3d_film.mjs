// Headless driver for dev/print3d_film.html: stills (and optionally the MP4) of a print timelapse.
//   node tests/print3d_film.mjs "product=wire;frames=0.05,0.5,0.98;mp4=1;tag=wire" [--port 8830] [--ui]
// Writes shots/print3d/film_<tag>_<pct>.jpg and shots/print3d/film_<tag>.mp4, then ffprobes the MP4.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const query = (args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || '').replace(/;/g, '&');
const port = +opt('port', 8830);
const params = new URLSearchParams(query);
const tag = params.get('tag') || `${params.get('product') || 'wire'}_${params.get('camera') || 'orbit'}`;
fs.mkdirSync('shots/print3d', { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(args.includes('--mobile') ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
const t0 = Date.now();
await page.goto(`http://localhost:${port}/dev/print3d_film.html?${query}`);
let done;
try {
  await page.waitForFunction(() => window.__done, null, { timeout: 600000, polling: 250 });
  done = await page.evaluate(() => window.__done);
} catch (e) { done = { ok: false, error: 'timeout ' + e.message }; }
if (args.includes('--ui')) {
  // --drop <file>: feed a .gcode / .gcode.3mf to the dialog's replay input
  if (opt('drop')) {
    await page.waitForTimeout(1500);
    await page.setInputFiles('.ptl-drop input', opt('drop'));
    await page.waitForFunction(() => /Replaying|could not/.test(document.querySelector('.ptl-status')?.textContent || ''), null, { timeout: 120000 });
    console.log('dialog status:', await page.evaluate(() => document.querySelector('.ptl-status').textContent));
  }
  await page.waitForTimeout(+opt('wait', 9000));
  const perf = await page.evaluate(async () => {
    const S = window.__dlg?.state; if (!S) return null;
    const p0 = S.paints || 0, m0 = S.paintMs || 0, t0 = performance.now();
    await new Promise(r => setTimeout(r, 2000));
    const n = (S.paints || 0) - p0;
    return { previewFps: +(n / ((performance.now() - t0) / 1000)).toFixed(1), msPerPaint: +(((S.paintMs || 0) - m0) / Math.max(1, n)).toFixed(2), canvas: document.querySelector('.ptl-view') && [document.querySelector('.ptl-view').width, document.querySelector('.ptl-view').height] };
  });
  console.log('preview:', JSON.stringify(perf));
  console.log('horizontal overflow:', await page.evaluate(() => { const d = document.querySelector('.ptl'); return d ? { dialog: d.scrollWidth - d.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth } : null; }));
  // --export: film through the dialog (10 s, 30 fps), then Download and Post on X (x.com is blocked
  // here: only the popup's URL is checked, nothing is posted)
  if (args.includes('--export')) {
    await page.click('.ptl-seg[data-k=seconds] button[data-v="10"]');
    const te = Date.now();
    await page.click('.ptl-export');
    await page.waitForSelector('.ptl-dl:not([hidden])', { timeout: 300000 });
    console.log('dialog export:', await page.evaluate(() => document.querySelector('.ptl-status').textContent), `(${((Date.now() - te) / 1000).toFixed(1)} s)`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.ptl-dl')]);
    const dfile = `shots/print3d/film_dialog_${tag}.mp4`;
    await dl.saveAs(dfile);
    console.log('download:', dl.suggestedFilename(), (fs.statSync(dfile).size / 1048576).toFixed(2) + ' MB');
    try {
      const pr = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,duration', '-of', 'csv=p=0', dfile], { encoding: 'utf8' });
      console.log('ffprobe (w,h,rate,duration,frames):', pr.trim());
    } catch (e) { console.log('ffprobe failed', e.message); }
    await page.context().route('https://x.com/**', r => r.abort());
    const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 15000 }).catch(() => null), page.click('.ptl-x')]);
    console.log('post on X popup:', popup ? popup.url().slice(0, 60) : 'none');
    await page.waitForTimeout(800);
    console.log('status after X:', await page.evaluate(() => document.querySelector('.ptl-status').textContent));
  }
  await page.screenshot({ path: `shots/print3d/film_ui_${tag}.png` });
  console.log('wrote', `shots/print3d/film_ui_${tag}.png`);
}
const shots = await page.evaluate(() => (window.__shots || []).map(s => ({ name: s.name, data: s.data, phase: s.phase, t: s.t, layer: s.layer, count: s.count })));
for (const s of shots) {
  const file = `shots/print3d/${s.name}.jpg`;
  fs.writeFileSync(file, Buffer.from(s.data.split(',')[1], 'base64'));
  console.log('wrote', file, `${s.phase} t=${(s.t / 60).toFixed(1)} min layer ${s.layer + 1} beads ${s.count}`);
}
const mp4 = await page.evaluate(() => window.__mp4 || null);
if (mp4) {
  const file = `shots/print3d/film_${tag}.mp4`;
  fs.writeFileSync(file, Buffer.from(mp4, 'base64'));
  let probe = '';
  try {
    probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,width,height,r_frame_rate,nb_read_frames,duration', '-of', 'json', file], { encoding: 'utf8' });
  } catch (e) { probe = 'ffprobe failed: ' + e.message; }
  console.log('wrote', file, (fs.statSync(file).size / 1048576).toFixed(2) + ' MB', probe.replace(/\s+/g, ' '));
}
const { info, ...rest } = done || {};
console.log(JSON.stringify({ secs: (Date.now() - t0) / 1000, ok: done?.ok, error: done?.error, timings: rest.timings, mp4: rest.mp4,
  info: info && { ...info, changes: info.changes?.length }, stats: rest.stats && { layers: rest.stats.layers, beads: rest.stats.beads, total: rest.stats.total, box: rest.stats.box, palette: rest.stats.palette, map: rest.stats.map } }));
if (errors.length) console.log('console:\n' + errors.slice(0, 30).join('\n'));
await browser.close();
process.exit(done && done.ok ? 0 : 1);
