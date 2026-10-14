// Gate for kit 10, per-project GOALS.md tasks (T1–T4).
// Usage: node kit/done/project-tasks/grade-tasks.mjs [--fixtures-only]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const fail = (msg) => {
  console.error(`\n================ TASKS GRADE ================\nFAIL  ${msg}`);
  process.exit(1);
};

// ---- T1 ----
let mod;
try { mod = require(path.join(ROOT, 'src', 'main', 'goals.js')); }
catch (e) { fail(`T1: src/main/goals.js failed to load — not implemented yet (expected baseline failure). ${e.message}`); }
const { parseGoals, serializeGoals } = mod;
if (typeof parseGoals !== 'function' || typeof serializeGoals !== 'function') {
  fail('T1: parseGoals/serializeGoals not both exported — not implemented yet (expected baseline failure)');
}
console.log('T1 PASS  goals.js exports present');

// ---- T2 fixtures ----
const DOC = [
  '# Goals',
  '',
  'Some prose that must survive.',
  '- [ ] ship the tasks panel',
  '- [x] write the contract',
  '  * [X] indented star done item',
  '',
  'Trailing prose.',
].join('\n');

let bad = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `  (${detail})`}`);
  if (!cond) bad++;
};

const parsed = parseGoals(DOC);
check('parse finds 3 items', parsed.items.length === 3, `got ${parsed.items.length}`);
check('done flags correct', parsed.items.map((i) => i.done).join(',') === 'false,true,true',
  parsed.items.map((i) => i.done).join(','));
check('line numbers tracked', parsed.items[0].line === 3 && parsed.items[2].line === 5,
  parsed.items.map((i) => i.line).join(','));

const roundtrip = serializeGoals(DOC, parseGoals(DOC).items);
check('round-trip identity', roundtrip === DOC, 'text mutated');

const toggled = parseGoals(DOC).items.map((i, idx) => (idx === 0 ? { ...i, done: true } : i));
const toggledText = serializeGoals(DOC, toggled);
check('toggle rewrites in place', /- \[[xX]\] ship the tasks panel/.test(toggledText), 'mark not flipped');
check('toggle preserves prose', toggledText.includes('Some prose that must survive.')
  && toggledText.includes('Trailing prose.'), 'prose lost');
check('toggle preserves indent/star line', toggledText.includes('  * [X] indented star done item'), 'other items mutated');

const appended = serializeGoals(DOC, [...parseGoals(DOC).items, { text: 'brand new goal', done: false }]);
const lines = appended.split('\n');
const newIdx = lines.findIndex((l) => l.includes('brand new goal'));
check('append lands after last checkbox', newIdx === 6, `at line ${newIdx}`);
check('append keeps trailing prose', appended.includes('Trailing prose.'), 'prose lost');

const fresh = serializeGoals(null, [{ text: 'first task', done: false }]);
check('create-new writes Goals doc', /# Goals/.test(fresh) && /- \[ \] first task/.test(fresh), fresh.slice(0, 60));

if (bad) fail(`T2: ${bad} fixture case(s) wrong`);
console.log('T2 PASS  all fixtures');

// ---- T3 wiring greps ----
// Kit 14 (2026-10-01): main.js is split across src/main; grep the whole layer.
const mainSrc = (function readMainLayer(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => e.isDirectory() ? [readMainLayer(path.join(dir, e.name))]
      : e.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : [])
    .join('\n');
})(path.join(ROOT, 'src', 'main'));
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const rendererDir = path.join(ROOT, 'src', 'renderer');
const rendererSrc = fs.readdirSync(rendererDir).filter((f) => f.endsWith('.js') || f.endsWith('.html'))
  .map((f) => fs.readFileSync(path.join(rendererDir, f), 'utf8')).join('\n');
if (!mainSrc.includes('au:tasks-get') || !mainSrc.includes('au:task-add')) fail('T3: tasks IPC handlers missing in main.js');
if (!preloadSrc.includes('tasksGet') || !preloadSrc.includes('taskAdd')) fail('T3: tasksGet/taskAdd missing in preload.js');
// 2026-10-14: the panel title is sentence case in the source and uppercased by CSS.
if (!/TASKS/i.test(rendererSrc) || !/taskAdd|tasksGet/.test(rendererSrc)) fail('T3: TASKS panel not wired in renderer');
console.log('T3 PASS  IPC + preload + renderer wiring present');

// ---- T4 regression ----
if (process.argv.includes('--fixtures-only')) {
  console.log('T4 SKIPPED (--fixtures-only)');
} else {
  console.log('T4 ...   running node kit/grade.mjs (launches Electron, ~1-2 min)');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'grade.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail(`T4: kit/grade.mjs regression FAILED (exit ${r.status})`);
  console.log('T4 PASS  grade.mjs regression green');
}

console.log('\n================ TASKS GRADE ================\nPASS  all mechanical checks green\nNow check it live: UI <-> GOALS.md round-trip.');
