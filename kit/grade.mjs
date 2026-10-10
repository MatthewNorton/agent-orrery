// Mechanical grader for the renderer build. Run from anywhere:
//   node kit/grade.mjs          against a synthetic profile (scripts/lib/synthetic-profile.mjs)
//   node kit/grade.mjs --real   against your own ~/.claude, ~/.codex and app state
// Exit 0 = PASS, 1 = FAIL. See kit/RUBRIC.md for what each check means.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createSyntheticProfile, isInside } from '../scripts/lib/synthetic-profile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shotsDir = path.join(root, '.shots');
const REAL = process.argv.includes('--real');
const TIMEOUT_MS = 150_000;
const MIN_PNG_BYTES = 30 * 1024;
const OWN_FILES = /^(shot-.*\.png|state\.json|ux-state\.json)$/; // what --shots writes; subfolders belong to other gates
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource/;
const NOISE_RE = /Autofill|GPU|gpu_|dxgi|vulkan|EGL|libva|SharedImageManager|CreatePlatformSocket/i;

for (const entry of fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir, { withFileTypes: true }) : []) {
  if (entry.isFile() && OWN_FILES.test(entry.name)) fs.rmSync(path.join(shotsDir, entry.name), { force: true });
}
const profile = REAL ? null : createSyntheticProfile({ prefix: 'agent-universe-grade-' });
const seededStateAt = profile && fs.statSync(profile.statePath).mtimeMs;
console.log(profile ? `profile: synthetic ${profile.root}` : 'profile: real (--real)');
const started = Date.now();

const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const child = spawn(bin, ['.', '--shots'], { cwd: root, shell: process.platform === 'win32', env: profile?.env });
profile?.streamActivity(12_000).catch(() => {});

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
    if (profile) {
      const foreign = (Array.isArray(state.projects) ? state.projects : []).filter((p) => !isInside(profile.root, p?.path));
      if (foreign.length) failures.push(`M3: ${foreign.length} project(s) did not come from the synthetic profile`);
      const saved = fs.statSync(profile.statePath, { throwIfNoEntry: false });
      if (!saved || saved.mtimeMs <= seededStateAt) failures.push('M3: the app did not save its state into the synthetic profile (userData not redirected)');
    }
    if (!Array.isArray(state.ships) || state.ships.length < 1) {
      warnings.push(profile
        ? 'M5 (soft): no live ships from the synthetic profile — its live sessions should always produce some'
        : 'M5 (soft): no live ships during grading — expected if no Claude session was active');
    }
  } catch (e) {
    failures.push(`M3: state.json unparseable: ${e.message}`);
  }
}

const errorLines = output.split('\n').filter((l) => ERROR_RE.test(l) && !NOISE_RE.test(l));
if (errorLines.length > 0) {
  failures.push(`M4: error output detected:\n  ${errorLines.slice(0, 8).join('\n  ')}`);
}

try { profile?.dispose(); } catch (e) { warnings.push(`could not delete ${profile.root}: ${e.code || e.message}`); }

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
