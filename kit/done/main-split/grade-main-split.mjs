#!/usr/bin/env node
// Kit 14 gate — split src/main/main.js and remove its global state.
// Fails cleanly until the kit is built. Stage-aware from the start (lesson from kit 13):
// checks that belong to later tasks are reported as SKIP, so every incremental commit
// can be gated. `--full` also runs the whole gate sweep (kit/run-gates.mjs);
// `--no-unit-tests` leaves npm test to that sweep.
//
// Usage: node kit/done/main-split/grade-main-split.mjs [--stage A|B|C|D|E|all] [--full]
// (run from kit/todo/grade-main-split.mjs while the kit was executing)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Works from kit/todo/ (pending) and kit/done/main-split/ (archived).
const ROOT = fs.existsSync(path.join(HERE, '..', '..', 'package.json'))
  ? path.resolve(HERE, '..', '..')
  : path.resolve(HERE, '..', '..', '..');
const FULL = process.argv.includes('--full');
const STAGES = ['A', 'B', 'C', 'D', 'E', 'all'];
const STAGE = process.argv.includes('--stage') ? String(process.argv[process.argv.indexOf('--stage') + 1]) : 'all';
if (!STAGES.includes(STAGE)) { console.error(`--stage must be one of: ${STAGES.join(', ')}`); process.exit(2); }
const reached = (s) => STAGES.indexOf(STAGE) >= STAGES.indexOf(s);
const MAIN = path.join(ROOT, 'src', 'main');

let failures = 0;
const ok = (id, msg) => console.log(`${id} PASS  ${msg}`);
const fail = (id, msg) => { failures++; console.log(`${id} FAIL  ${msg}`); };
const skip = (id, task) => console.log(`${id} SKIP  belongs to task ${task}; not expected at stage ${STAGE}`);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const exists = (r) => fs.existsSync(path.join(ROOT, r));
const read = (r) => (exists(r) ? fs.readFileSync(path.join(ROOT, r), 'utf8') : '');
const lines = (r) => { const s = read(r); const n = (s.match(/\n/g) || []).length; return s.length === 0 || s.endsWith('\n') ? n : n + 1; };
const defines = (src, name) => new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').test(src);
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}
// Owner's rule (2026-10-13): every module stays at 400 lines or fewer.
const MODULE_CAP = 400;
const mainSrc = read('src/main/main.js');

// ---- stage A: flags + fixtures ----
if (!reached('A')) skip('TA', '0');
else {
  const before = failures;
  for (const f of ['src/main/flags.js', 'src/main/harness/fixtures.js']) if (!exists(f)) fail('TA', `${f} missing`);
  for (const name of ['createProviderFixture', 'createHistoryFixture', 'createControlFixture', 'createRecordingTerminalLauncher']) {
    if (defines(mainSrc, name)) fail('TA', `main.js still defines ${name}`);
  }
  if (/^const (SHOT_MODE|POLISH_TEST|PROVIDER_TEST|HISTORY_TEST|CONTROL_TEST) = process\.argv/m.test(mainSrc)) fail('TA', 'main.js still parses test flags itself');
  if (failures === before) ok('TA', 'flags and harness fixtures extracted');
}

// ---- stage B: harness driver, metrics, modes ----
if (!reached('B')) skip('TB', 'B');
else {
  const before = failures;
  for (const f of ['harness/driver.js', 'harness/metrics.js', 'harness/modes/shots.js', 'harness/modes/control.js', 'harness/modes/history.js', 'harness/modes/provider.js', 'harness/modes/polish.js']) {
    if (!exists('src/main/' + f)) fail('TB', `src/main/${f} missing`);
  }
  for (const name of ['runShotMode', 'runControlMode', 'runHistoryMode', 'runProviderMode', 'runPolishMode', 'rendererEval', 'sendTestInput']) {
    if (defines(mainSrc, name)) fail('TB', `main.js still defines ${name}`);
  }
  if (failures === before) ok('TB', 'harness driver, metrics and five modes extracted');
}

// ---- stage C: app context + window ----
if (!reached('C')) skip('TC', 'C');
else {
  const before = failures;
  for (const f of ['src/main/app-context.js', 'src/main/window.js']) if (!exists(f)) fail('TC', `${f} missing`);
  if (/new BrowserWindow\(/.test(mainSrc)) fail('TC', 'main.js still constructs the BrowserWindow');
  if (/new Tracker\(/.test(mainSrc)) fail('TC', 'main.js still constructs the Tracker');
  if (failures === before) ok('TC', 'app-context and window extracted');
}

// ---- stage D: replay control + ipc ----
if (!reached('D')) skip('TD', 'D');
else {
  const before = failures;
  for (const f of ['replay-control.js', 'ipc/guards.js', 'ipc/terminal.js', 'ipc/tasks.js', 'ipc/root-tasks.js', 'ipc/project-paths.js', 'ipc/register.js']) {
    if (!exists('src/main/' + f)) fail('TD', `src/main/${f} missing`);
  }
  if (/ipcMain\.handle\(/.test(mainSrc)) fail('TD', 'main.js still registers IPC handlers directly');
  if (defines(mainSrc, 'handleReplayCommand')) fail('TD', 'main.js still defines handleReplayCommand');
  if (failures === before) ok('TD', 'replay control and ipc modules extracted');
}

// ---- stage E: main.js is a bootstrap; docs updated ----
if (!reached('E')) skip('TE', 'E');
else {
  const before = failures;
  const n = lines('src/main/main.js');
  if (n > 150) fail('TE', `main.js is ${n} lines (cap 150)`);
  if (/^let /m.test(mainSrc)) fail('TE', 'main.js still has module-level let');
  if (/^const \w+ = (new (Map|Set)\(|\[\])/m.test(mainSrc)) fail('TE', 'main.js still has a file-scope mutable collection');
  // 2026-10-18: the agent instructions moved from CLAUDE.md to AGENTS.md.
  const agents = read('AGENTS.md');
  const frozenBullet = (agents.match(/\*\*Frozen files\*\*[^\n]*/) || [''])[0];
  if (!frozenBullet) fail('TE', 'AGENTS.md has no frozen-files bullet');
  if (/src\/main\/main\.js/.test(frozenBullet)) fail('TE', 'AGENTS.md frozen-files bullet still lists main.js');
  const spec = read('kit/SPEC.md');
  const specFrozen = spec.slice(spec.indexOf('Frozen files'), spec.indexOf('Frozen files') + 1500);
  if (/`src\/main\/main\.js`/.test(specFrozen)) fail('TE', 'kit/SPEC.md frozen list still includes main.js');
  if (failures === before) ok('TE', `main.js is a ${n}-line bootstrap; frozen lists updated`);
}

// ---- T6: line caps (always) ----
{
  const before = failures;
  for (const file of walk(MAIN)) {
    const r = rel(file);
    const n = lines(r);
    if (r === 'src/main/main.js') continue; // capped at stage E
    if (n > MODULE_CAP) fail('T6', `${r} is ${n} lines (cap ${MODULE_CAP})`);
  }
  if (failures === before) ok('T6', `every src/main module is ${MODULE_CAP} lines or fewer`);
}

// ---- T7: no module-level let (always, main.js from stage E) ----
{
  const before = failures;
  for (const file of walk(MAIN)) {
    const r = rel(file);
    if (r === 'src/main/main.js' && !reached('E')) continue;
    const count = (read(r).match(/^let /gm) || []).length;
    if (count) fail('T7', `${r} has ${count} module-level let(s)`);
  }
  if (failures === before) ok('T7', `no module-level let in src/main${reached('E') ? '' : ' (main.js checked from stage E)'}`);
}

// ---- T9: unit tests (the sweep passes --no-unit-tests because it runs npm test once itself) ----
if (process.argv.includes('--no-unit-tests')) ok('T9', 'npm test left to the sweep (--no-unit-tests)');
else {
  const r = spawnSync('npm test', { cwd: ROOT, encoding: 'utf8', shell: true });
  const summary = (r.stdout.match(/ℹ (pass|fail) \d+/g) || []).join(', ');
  if (r.status !== 0) fail('T9', `npm test failed (${summary || 'no summary'})`);
  else ok('T9', `npm test green (${summary})`);
}

// ---- --full: the whole gate sweep, one line per gate (kit/run-gates.mjs) ----
if (FULL) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'run-gates.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 1_800_000 });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) fail('FULL', 'the gate sweep is red (see above)');
  else ok('FULL', 'every gate green');
}

console.log(`\n============= KIT 14 MAIN-SPLIT GRADE (stage ${STAGE}${FULL ? ', full' : ''}) =============`);
if (failures) { console.log(`FAIL  ${failures} check(s) red`); process.exit(1); }
console.log(`PASS  every check expected at stage ${STAGE} is green${FULL ? ', including the whole gate sweep' : ' (add --full before committing)'}`);
