// Runs every gate, one line each, and exits 1 if any failed. Run from anywhere:
//   node kit/run-gates.mjs                   every gate (~6 min; launches Electron) and npm test once
//   node kit/run-gates.mjs --static          only the quick file-check gates (what CI runs)
//   node kit/run-gates.mjs --no-unit-tests   skip npm test (CI's test job already runs it)
// The renderer gate runs once, up front; the kits whose last check is that same gate run with it
// skipped. The packaging gate is Windows-only and refuses a dirty tree, so it is skipped elsewhere
// and on an uncommitted tree. Each gate's full output lands in .shots/gates/<name>.log. A gate
// archived under kit/done but missing from the table below is reported red, so the list cannot
// go stale quietly.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const logDir = path.join(root, '.shots', 'gates');
const STATIC = process.argv.includes('--static');
const NO_UNIT_TESTS = process.argv.includes('--no-unit-tests');

const GATES = [
  { name: 'renderer', script: 'kit/grade.mjs' },
  { name: 'galaxy-grouping', script: 'kit/done/galaxy-grouping/grade-galaxies.mjs' },
  { name: 'polish-pass', script: 'kit/done/polish-pass/grade-polish.mjs' },
  { name: 'multi-provider', script: 'kit/done/multi-provider/grade-providers.mjs' },
  { name: 'history-playback', script: 'kit/done/history-playback/grade-history.mjs' },
  { name: 'agent-control', script: 'kit/done/agent-control/grade-control.mjs' },
  { name: 'unit-tests', command: 'npm test', static: true },
  { name: 'attention', script: 'kit/done/attention/grade-attention.mjs', args: ['--fixtures-only'], static: true },
  { name: 'project-search', script: 'kit/done/project-search/grade-search.mjs', args: ['--fixtures-only'], static: true },
  { name: 'project-tasks', script: 'kit/done/project-tasks/grade-tasks.mjs', args: ['--fixtures-only'], static: true },
  { name: 'ship-assets-pack', script: 'kit/done/ship-assets-pack/grade-ships.mjs', args: ['--no-regression'], static: true },
  { name: 'structural-cleanup', script: 'kit/done/structural-cleanup/grade-structure.mjs', args: ['--no-unit-tests'], static: true },
  { name: 'main-split', script: 'kit/done/main-split/grade-main-split.mjs', args: ['--no-unit-tests'], static: true },
  { name: 'packaging', script: 'kit/done/packaging/grade-packaging.mjs', windows: true },
];

const line = (status, name, rest = '') => console.log(`${status.padEnd(4)}  ${name.padEnd(20)} ${rest}`.trimEnd());
const dirtyTree = () => spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim().length > 0;
const doneDir = path.join(root, 'kit', 'done');
const listed = new Set(GATES.map((gate) => gate.script));
const unlisted = fs.readdirSync(doneDir).flatMap((kit) => fs.readdirSync(path.join(doneDir, kit))
  .filter((file) => /^grade-.*\.mjs$/.test(file)).map((file) => `kit/done/${kit}/${file}`))
  .filter((script) => !listed.has(script));

fs.mkdirSync(logDir, { recursive: true });
let failed = 0;
for (const gate of GATES) {
  if (STATIC && !gate.static) continue;
  if (NO_UNIT_TESTS && gate.command) continue;
  if (gate.windows && process.platform !== 'win32') { line('SKIP', gate.name, 'Windows only'); continue; }
  if (gate.windows && dirtyTree()) { line('SKIP', gate.name, 'needs a clean tree; commit first'); continue; }
  const started = Date.now();
  const options = { cwd: root, encoding: 'utf8', timeout: 900_000 };
  const r = gate.command
    ? spawnSync(gate.command, { ...options, shell: true })
    : spawnSync(process.execPath, [path.join(root, gate.script), ...(gate.args || [])], options);
  const output = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(logDir, `${gate.name}.log`), output);
  const seconds = `${((Date.now() - started) / 1000).toFixed(0).padStart(3)}s`;
  if (r.status === 0) { line('PASS', gate.name, seconds); continue; }
  failed++;
  const reasons = output.split(/\r?\n/).filter((text) => /\bFAIL\b/.test(text)).slice(0, 3).map((text) => text.trim());
  line('FAIL', gate.name, `${seconds}  ${reasons.join(' | ') || `exit ${r.status ?? r.signal}`}`);
}
for (const script of unlisted) { failed++; line('FAIL', path.basename(script, '.mjs'), `${script} is not listed in kit/run-gates.mjs`); }
console.log(failed ? `\n${failed} red; logs in .shots/gates/` : `\nevery gate green${STATIC ? ' (static set)' : ''}`);
process.exit(failed ? 1 : 0);
