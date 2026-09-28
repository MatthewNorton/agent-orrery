// Mechanical grader for kit/todo/01-attention/ADDENDUM-ATTENTION.md.
// Usage: node kit/todo/01-attention/grade-attention.mjs [--fixtures-only]
// A1: classifyAttention exported. A2: fixture table. A3: grade.mjs regression.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);

let mod;
try {
  mod = require(path.join(ROOT, 'src', 'main', 'tracker.js'));
} catch (e) {
  fail(`tracker.js failed to load: ${e.message}`);
}
const classify = mod.classifyAttention;
if (typeof classify !== 'function') {
  fail('A1: classifyAttention is not exported from src/main/tracker.js — not implemented yet (expected baseline failure)');
}
console.log('A1 PASS  classifyAttention exported');

// ---- A2: fixtures ----
const NOW = 1_800_000_000_000; // fixed clock — classifier must not call Date.now()
const mk = (over = {}) => ({
  kind: 'main', lastEvent: NOW - 3000, turnDone: false, pending: new Map(), ...over,
});
// pend([[tool, ageMs], ...]) -> Map<id, {tool, ts}>
const pend = (specs) => new Map(specs.map(([tool, age], i) => [`t${i}`, { tool, ts: NOW - age }]));

const CASES = [
  ['active ship, pending Edit 3s (< fast threshold)',
    mk({ pending: pend([['Edit', 3_000]]) }), null],
  ['pending Edit 15s → permission',
    mk({ pending: pend([['Edit', 15_000]]) }), 'permission'],
  ['pending AskUserQuestion 5s → question',
    mk({ pending: pend([['AskUserQuestion', 5_000]]) }), 'question'],
  ['pending ExitPlanMode 5s → question',
    mk({ pending: pend([['ExitPlanMode', 5_000]]) }), 'question'],
  ['pending AskUserQuestion 1s (< guard window)',
    mk({ pending: pend([['AskUserQuestion', 1_000]]) }), null],
  ['pending Bash 15s (long tool, executing)',
    mk({ pending: pend([['Bash', 15_000]]) }), null],
  ['pending Bash 200s → stalled',
    mk({ pending: pend([['Bash', 200_000]]) }), 'stalled'],
  ['unknown MCP tool pending 15s counts as fast → permission',
    mk({ pending: pend([['mcp__foo__bar', 15_000]]) }), 'permission'],
  ['turn done, quiet 15s → done',
    mk({ turnDone: true, lastEvent: NOW - 15_000 }), 'done'],
  ['turn done, quiet 5s (< quiet threshold)',
    mk({ turnDone: true, lastEvent: NOW - 5_000 }), null],
  ['turn NOT done, quiet 60s, no pending → null',
    mk({ lastEvent: NOW - 60_000 }), null],
  ['drone never pages: drone w/ pending AskUserQuestion 15s → null',
    mk({ kind: 'drone', pending: pend([['AskUserQuestion', 15_000]]) }), null],
  ['priority: Bash 15s + Edit 15s → permission (fast pending wins)',
    mk({ pending: pend([['Bash', 15_000], ['Edit', 15_000]]) }), 'permission'],
  ['priority: Edit 15s + AskUserQuestion 5s → question',
    mk({ pending: pend([['Edit', 15_000], ['AskUserQuestion', 5_000]]) }), 'question'],
  ['priority: Bash 200s + turnDone irrelevant while pending → stalled',
    mk({ turnDone: true, lastEvent: NOW - 300_000, pending: pend([['Bash', 200_000]]) }), 'stalled'],
];

let bad = 0;
for (const [name, ship, want] of CASES) {
  let got;
  try { got = classify(ship, NOW); } catch (e) { got = `THREW: ${e.message}`; }
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  (want ${fmt(want)}, got ${fmt(got)})`);
}
if (bad) fail(`A2: ${bad}/${CASES.length} fixture cases wrong`);
console.log(`A2 PASS  ${CASES.length}/${CASES.length} fixtures`);

// ---- A3: regression ----
if (process.argv.includes('--fixtures-only')) {
  console.log('A3 SKIPPED (--fixtures-only)');
  done(true);
}
console.log('A3 ...   running node kit/grade.mjs (launches Electron, ~1-2 min)');
const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'grade.mjs')], {
  cwd: ROOT, stdio: 'inherit',
});
if (r.status !== 0) fail(`A3: kit/grade.mjs regression FAILED (exit ${r.status})`);
console.log('A3 PASS  grade.mjs regression green');
done(true);

function fmt(v) { return v === null ? 'null' : `'${v}'`; }
function fail(msg) {
  console.error(`\n================ ATTENTION GRADE ================\nFAIL  ${msg}`);
  process.exit(1);
}
function done() {
  console.log('\n================ ATTENTION GRADE ================\nPASS  all mechanical checks green\nNow run the staged live check in ADDENDUM-ATTENTION.md §7.');
  process.exit(0);
}
