// Prove a print file slices: runs the Bambu Studio CLI headless on an STL / 3MF with the user's
// A2L 0.4 + 0.20 mm Standard + Bambu PETG Basic presets (flattened from the installed system profiles).
//   node tests/print3d_slice.mjs shots/print3d/plaque_lineart.3mf [more files...]
// Prints the CLI's exit code, the result.json it writes, and the G-code size. Windows only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BS = 'C:/Program Files/Bambu Studio';
const EXE = `${BS}/bambu-studio.exe`;
const PROF = `${BS}/resources/profiles/BBL`;
const OUT = path.resolve('shots/print3d/slice');
fs.mkdirSync(OUT, { recursive: true });

function flatten(kind, name) {
  const file = `${PROF}/${kind}/${name}.json`;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parent = j.inherits ? flatten(kind, j.inherits) : {};
  const out = { ...parent, ...j };
  delete out.inherits;
  return out;
}
const machine = flatten('machine', 'Bambu Lab A2L 0.4 nozzle');
const process_ = flatten('process', '0.20mm Standard @BBL A2L');
const filament = flatten('filament', 'Bambu PETG Basic @BBL A2L 0.4 nozzle');
for (const [o, t] of [[machine, 'machine'], [process_, 'process'], [filament, 'filament']]) { o.from = 'User'; o.type = o.type || t; o.inherits = { machine: 'Bambu Lab A2L 0.4 nozzle', process: '0.20mm Standard @BBL A2L', filament: 'Bambu PETG Basic @BBL A2L 0.4 nozzle' }[t]; }
filament.filament_settings_id = [filament.name];
for (const o of [process_, filament]) { o.compatible_printers = [machine.name]; o.compatible_printers_condition = ''; }
process_.print_settings_id = process_.name;
process_.curr_bed_type = machine.curr_bed_type = 'Textured PEI Plate';
machine.printer_settings_id = machine.name;
const mf = path.join(OUT, 'machine.json'), pf = path.join(OUT, 'process.json'), ff = path.join(OUT, 'filament.json');
fs.writeFileSync(mf, JSON.stringify(machine, null, 1));
fs.writeFileSync(pf, JSON.stringify(process_, null, 1));
fs.writeFileSync(ff, JSON.stringify(filament, null, 1));

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const tag = path.basename(f).replace(/\.\w+$/, '');
  const dir = path.join(OUT, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const args = ['--arrange', '1', '--load-settings', `${mf};${pf}`, '--load-filaments', ff,
    '--slice', '0', '--debug', '1', '--outputdir', dir, '--export-3mf', 'sliced.3mf', path.resolve(f)];
  const t0 = Date.now();
  const r = spawnSync(EXE, args, { encoding: 'utf8', timeout: 600000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  let result = null;
  try { result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch { }
  const gcode = fs.readdirSync(dir).filter(n => /\.gcode$/.test(n));
  const sliced = fs.existsSync(path.join(dir, 'sliced.3mf')) ? fs.statSync(path.join(dir, 'sliced.3mf')).size : 0;
  const ok = r.status === 0 && (!result || result.return_code === 0);
  if (!ok) bad++;
  console.log(`${ok ? 'SLICED' : 'FAILED'} ${tag}: exit ${r.status} in ${secs} s, sliced.3mf ${(sliced / 1e6).toFixed(2)} MB, gcode ${gcode.join(',') || '-'}`);
  const pl = result?.sliced_plates?.[0];
  if (pl) console.log(`   ${pl.triangle_count} triangles, ${Math.round(pl.total_predication / 60)} min, ${pl.filaments.map(f => f.total_used_g.toFixed(1) + ' g').join(' + ')}, warnings: ${JSON.stringify(pl.warning_message || '')}`);
  else if (result) console.log('   result.json:', JSON.stringify(result).slice(0, 600));
  if (!ok) console.log('   stderr:', (r.stderr || '').slice(-1500), '\n   stdout:', (r.stdout || '').slice(-1500));
}
process.exit(bad ? 1 : 0);
