// Mechanical grader for the renderer build. Run from anywhere:
//   node kit/grade.mjs
// Exit 0 = PASS, 1 = FAIL. See kit/RUBRIC.md for what each check means.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shotsDir = path.join(root, '.shots');
const TIMEOUT_MS = 150_000;
const MIN_PNG_BYTES = 30 * 1024;
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource/;
const NOISE_RE = /Autofill|GPU|gpu_|dxgi|vulkan|EGL|libva|SharedImageManager|CreatePlatformSocket/i;

fs.rmSync(shotsDir, { recursive: true, force: true });
const started = Date.now();

const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const child = spawn(bin, ['.', '--shots'], { cwd: root, shell: process.platform === 'win32' });

let output = '';
child.stdout.on('data', (d) => { output += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { output += d; });

const exitCode = await new Promise((resolve) => {
  const t = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, TIMEOUT_MS);
  child.on('exit', (code) => { clearTimeout(t); resolve(code); });
  child.on('error', () => { clearTimeout(t); resolve('spawn-error'); });
});

const failures = [];
const warnings = [];

if (exitCode !== 0) failures.push(`M1: electron --shots exited with ${exitCode}`);

for (const view of ['universe', 'system', 'planet']) {
  const p = path.join(shotsDir, `shot-${view}.png`);
  if (!fs.existsSync(p)) { failures.push(`M2: missing shot-${view}.png`); continue; }
  const st = fs.statSync(p);
  if (st.mtimeMs < started) failures.push(`M2: shot-${view}.png is stale (not from this run)`);
  if (st.size < MIN_PNG_BYTES) failures.push(`M2: shot-${view}.png only ${Math.round(st.size / 1024)}KB — likely a blank frame`);
}

const statePath = path.join(shotsDir, 'state.json');
if (!fs.existsSync(statePath)) {
  failures.push('M3: state.json not written');
} else {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!Array.isArray(state.projects) || state.projects.length < 1) {
      failures.push('M3: tracker snapshot has no projects');
    }
    if (!Array.isArray(state.ships) || state.ships.length < 1) {
      warnings.push('M5 (soft): no live ships during grading — expected if no Claude session was active');
    }
  } catch (e) {
    failures.push(`M3: state.json unparseable: ${e.message}`);
  }
}

const errorLines = output.split('\n').filter((l) => ERROR_RE.test(l) && !NOISE_RE.test(l));
if (errorLines.length > 0) {
  failures.push(`M4: error output detected:\n  ${errorLines.slice(0, 8).join('\n  ')}`);
}

console.log('\n================ GRADE ================');
for (const w of warnings) console.log(`WARN  ${w}`);
if (failures.length === 0) {
  console.log('PASS  all mechanical checks green');
  console.log(`Shots in ${shotsDir} — now grade them visually per kit/RUBRIC.md`);
  process.exit(0);
} else {
  for (const f of failures) console.log(`FAIL  ${f}`);
  process.exit(1);
}
