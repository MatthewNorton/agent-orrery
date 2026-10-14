// Gate for kit 11, project search (P1–P4).
// Usage: node kit/done/project-search/grade-search.mjs [--fixtures-only]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const fail = (msg) => {
  console.error(`\n================ SEARCH GRADE ================\nFAIL  ${msg}`);
  process.exit(1);
};

// ---- P1 ----
let mod;
try { mod = require(path.join(ROOT, 'src', 'renderer', 'search-core.js')); }
catch (e) { fail(`P1: search-core.js failed to load — not implemented yet (expected baseline failure). ${e.message}`); }
const search = mod.searchProjects;
if (typeof search !== 'function') fail('P1: searchProjects not exported — not implemented yet (expected baseline failure)');
console.log('P1 PASS  searchProjects exported');

// ---- P2 fixtures ----
const P = (id, name, p, galaxy) => ({ id, name, path: p, galaxy });
const PROJECTS = [
  P('a', 'agent-universe-lite', 'C:\\projects\\experimental\\agent-universe-lite', 'experimental'),
  P('b', 'agent-universe', 'C:\\projects\\experimental\\agent-universe', 'experimental'),
  P('c', 'lyra-training', 'C:\\projects\\experimental\\lyra-training', 'experimental'),
  P('d', 'orion-site', 'C:\\projects\\personal\\orion-site', 'personal'),
  P('e', 'vega-charts', 'C:\\projects\\personal\\vega-charts', 'personal'),
  P('f', 'quasar-notes', 'C:\\projects\\personal\\quasar-notes', 'personal'),
  P('g', 'universe-map-tests', 'C:\\tests\\universe-map-tests', 'tests'),
  P('h', 'Desktop', 'C:\\home\\sam\\Desktop', 'home'),
  P('i', 'sam', 'C:\\home\\sam', 'home'),
  P('j', 'experimental', 'C:\\projects\\experimental', 'experimental'),
];

let bad = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `  (${detail})`}`);
  if (!cond) bad++;
};

check('empty query -> []', search(PROJECTS, '').length === 0 && search(PROJECTS, '   ').length === 0, 'nonempty');
check('non-string safe', Array.isArray(search(PROJECTS, null)) && search(PROJECTS, null).length === 0, 'threw or nonempty');
check('case-insensitive name match', search(PROJECTS, 'LYRA').some((r) => r.id === 'c'), 'lyra-training not found');

const uni = search(PROJECTS, 'universe');
check('prefix rank: universe-map-tests first', uni.length > 0 && uni[0].id === 'g',
  `first = ${uni[0] && uni[0].id}`);
check('substring name matches included', uni.some((r) => r.id === 'a') && uni.some((r) => r.id === 'b'), 'agent-universe* missing');

const pathOnly = search(PROJECTS, 'personal');
check('path fallback matches', pathOnly.some((r) => r.id === 'd') && pathOnly.some((r) => r.id === 'e'), 'personal-path projects missing');

const many = search(PROJECTS.concat(PROJECTS.map((p, i) => P(`x${i}`, `test-proj-${i}`, `C:\\t\\test-proj-${i}`))), 'test');
check('cap at 8', many.length <= 8, `got ${many.length}`);

if (bad) fail(`P2: ${bad} fixture case(s) wrong`);
console.log('P2 PASS  all fixtures');

// ---- P3 wiring ----
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const iCore = html.indexOf('search-core.js');
const iApp = html.indexOf('app.js');
if (iCore === -1) fail('P3: search-core.js script tag missing from index.html');
if (!(iCore < iApp)) fail('P3: search-core.js must load before app.js');
const rendererDir = path.join(ROOT, 'src', 'renderer');
const rendererSrc = fs.readdirSync(rendererDir).filter((f) => f.endsWith('.js') || f.endsWith('.html'))
  .map((f) => fs.readFileSync(path.join(rendererDir, f), 'utf8')).join('\n');
if (!/[Ss]earch/.test(rendererSrc) || !/searchProjects/.test(rendererSrc)) fail('P3: search UI not wired in renderer');
console.log('P3 PASS  script order + UI wiring present');

// ---- P4 regression ----
if (process.argv.includes('--fixtures-only')) {
  console.log('P4 SKIPPED (--fixtures-only)');
} else {
  console.log('P4 ...   running node kit/grade.mjs (launches Electron, ~1-2 min)');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'grade.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail(`P4: kit/grade.mjs regression FAILED (exit ${r.status})`);
  console.log('P4 PASS  grade.mjs regression green');
}

console.log('\n================ SEARCH GRADE ================\nPASS  all mechanical checks green\nNow check it live: type, navigate, Esc, dimming.');
