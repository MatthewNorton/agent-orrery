// Runs every gate, one line each, and exits 1 if any failed. Run from anywhere:
//   node kit/run-gates.mjs            the renderer gate plus every done-kit gate (~6 min; launches Electron)
//   node kit/run-gates.mjs --static   only the gates that never launch Electron (what CI runs)
// Each gate's full output lands in .shots/gates/<name>.log. The renderer gate runs once, up
// front; the kits whose last check is that same gate run with it skipped. The packaging gate is
// Windows-only and refuses a dirty tree, so run the sweep right after committing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const logDir = path.join(root, '.shots', 'gates');
const STATIC = process.argv.includes('--static');

const GATES = [
  { name: 'renderer', script: 'kit/grade.mjs', electron: true },
  { name: 'galaxy-grouping', script: 'kit/done/galaxy-grouping/grade-galaxies.mjs', electron: true },
  { name: 'polish-pass', script: 'kit/done/polish-pass/grade-polish.mjs', electron: true },
  { name: 'multi-provider', script: 'kit/done/multi-provider/grade-providers.mjs', electron: true },
  { name: 'history-playback', script: 'kit/done/history-playback/grade-history.mjs', electron: true },
  { name: 'agent-control', script: 'kit/done/agent-control/grade-control.mjs', electron: true },
  { name: 'attention', script: 'kit/done/attention/grade-attention.mjs', args: ['--fixtures-only'] },
  { name: 'project-search', script: 'kit/done/project-search/grade-search.mjs', args: ['--fixtures-only'] },
  { name: 'project-tasks', script: 'kit/done/project-tasks/grade-tasks.mjs', args: ['--fixtures-only'] },
  { name: 'ship-assets-pack', script: 'kit/done/ship-assets-pack/grade-ships.mjs', args: ['--no-regression'] },
  { name: 'structural-cleanup', script: 'kit/done/structural-cleanup/grade-structure.mjs' },
  { name: 'main-split', script: 'kit/done/main-split/grade-main-split.mjs' },
  { name: 'packaging', script: 'kit/done/packaging/grade-packaging.mjs', windows: true },
];

fs.mkdirSync(logDir, { recursive: true });
let failed = 0;
for (const gate of GATES) {
  if (STATIC && (gate.electron || gate.windows)) continue;
  if (gate.windows && process.platform !== 'win32') { console.log(`SKIP  ${gate.name.padEnd(20)} Windows only`); continue; }
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, gate.script), ...(gate.args || [])], {
    cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const output = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(logDir, `${gate.name}.log`), output);
  const seconds = ((Date.now() - started) / 1000).toFixed(0).padStart(3);
  if (r.status === 0) { console.log(`PASS  ${gate.name.padEnd(20)} ${seconds}s`); continue; }
  failed++;
  const reasons = output.split(/\r?\n/).filter((line) => /^FAIL\b/.test(line)).slice(0, 3);
  console.log(`FAIL  ${gate.name.padEnd(20)} ${seconds}s  ${reasons.join(' | ') || `exit ${r.status ?? r.signal}`}`);
}
console.log(failed ? `\n${failed} gate(s) red; logs in .shots/gates/` : `\nevery gate green${STATIC ? ' (static set)' : ''}`);
process.exit(failed ? 1 : 0);
