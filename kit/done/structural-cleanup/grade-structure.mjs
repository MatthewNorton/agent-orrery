#!/usr/bin/env node
// Kit 13 gate — structural cleanup (docs/PUBLIC-RELEASE-TASKS.md Phase 5).
// Fails cleanly until the kit is built. `--full` also runs the whole gate sweep
// (kit/run-gates.mjs); `--no-unit-tests` leaves npm test to that sweep. Exit 0 only when everything passes.
//
// Usage: node kit/done/structural-cleanup/grade-structure.mjs [--stage A|0|B|C|D|all] [--full]
// (run from kit/todo/grade-structure.mjs while the kit was executing)
//
// --stage names the last task of the contract that is expected to be complete.
// Checks that belong to later tasks are reported as SKIP instead of FAIL, so every
// incremental commit can be gated. Without --stage, everything is checked (= 'all').
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Works from kit/todo/ (pending) and kit/done/structural-cleanup/ (archived).
const ROOT = fs.existsSync(path.join(HERE, '..', '..', 'package.json'))
  ? path.resolve(HERE, '..', '..')
  : path.resolve(HERE, '..', '..', '..');
const FULL = process.argv.includes('--full');
const STAGES = ['A', '0', 'B', 'C', 'D', 'all'];
const STAGE = process.argv.includes('--stage') ? String(process.argv[process.argv.indexOf('--stage') + 1]) : 'all';
if (!STAGES.includes(STAGE)) { console.error(`--stage must be one of: ${STAGES.join(', ')}`); process.exit(2); }
const reached = (s) => STAGES.indexOf(STAGE) >= STAGES.indexOf(s);
const RENDERER = path.join(ROOT, 'src', 'renderer');

let failures = 0;
const ok = (id, msg) => console.log(`${id} PASS  ${msg}`);
const fail = (id, msg) => { failures++; console.log(`${id} FAIL  ${msg}`); };
const skip = (id, task) => console.log(`${id} SKIP  belongs to task ${task}; not expected at stage ${STAGE}`);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
// Line count with `wc -l` semantics: number of newline characters, plus one for an
// unterminated last line. (A naive split counts the empty string after the final newline.)
const lines = (rel) => {
  const s = read(rel);
  const n = (s.match(/\n/g) || []).length;
  return s.length === 0 || s.endsWith('\n') ? n : n + 1;
};

const rendererFiles = fs.readdirSync(RENDERER).filter((f) => f.endsWith('.js')).sort();
const modulesOnDisk = rendererFiles.filter((f) => /^app-[a-z0-9-]+\.js$/.test(f));

// ---- T1: renderer file sizes (task 0 for modules and frozen files; task B for app.js) ----
if (!reached('0')) skip('T1', '0');
else {
  const before = failures;
  for (const f of rendererFiles) {
    // Owner's rule (2026-10-13): every renderer file stays at 400 lines or fewer.
    const cap = f === 'app.js' && !reached('B') ? Infinity : 400;
    const n = lines('src/renderer/' + f);
    if (n > cap) fail('T1', `${f} is ${n} lines (cap ${cap})`);
  }
  if (modulesOnDisk.length === 0) fail('T1', 'no app-*.js modules exist yet');
  if (failures === before) ok('T1', `all ${rendererFiles.length} renderer files within caps${reached('B') ? '' : ' (app.js cap deferred to task B)'}`);
}

// ---- T2: index.html load order and no ES modules (task 0) ----
if (!reached('0')) skip('T2', '0');
else {
  const before = failures;
  const html = read('src/renderer/index.html');
  const tags = [...html.matchAll(/<script\s+src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  const appTags = tags.filter((t) => /^app(-[a-z0-9-]+)?\.js$/.test(t));
  if (/type="module"/.test(html)) fail('T2', 'index.html uses type="module"');
  if (appTags[0] !== 'app-state.js') fail('T2', `first app script must be app-state.js, found ${appTags[0] ?? 'none'}`);
  if (appTags[appTags.length - 1] !== 'app.js') fail('T2', 'app.js must be the last app script');
  for (const m of modulesOnDisk) if (!appTags.includes(m)) fail('T2', `${m} exists but is not loaded by index.html`);
  for (const t of appTags) if (t !== 'app.js' && !modulesOnDisk.includes(t)) fail('T2', `index.html loads ${t} which does not exist`);
  const scenePlanetIdx = tags.indexOf('scene-planet.js');
  if (tags.includes('app-state.js') && (scenePlanetIdx < 0 || tags.indexOf('app-state.js') < scenePlanetIdx)) {
    fail('T2', 'app-state.js must load after scene-planet.js');
  }
  for (const f of rendererFiles) {
    if (/^\s*(import\s.+from\s|export\s)/m.test(read('src/renderer/' + f))) fail('T2', `${f} uses ES module syntax`);
  }
  if (failures === before) ok('T2', `index.html loads ${modulesOnDisk.length} module(s) between app-state.js and app.js`);
}

// ---- T3: single AUR.app owner; modules guard against missing namespace (task 0) ----
if (!reached('0')) skip('T3', '0');
else {
  const before = failures;
  const assignments = [];
  for (const f of rendererFiles) {
    const src = read('src/renderer/' + f);
    const count = (src.match(/\bAUR\.app\s*=[^=]/g) || []).length;
    if (count) assignments.push(`${f}:${count}`);
    if (/^app-[a-z0-9-]+\.js$/.test(f) && f !== 'app-state.js') {
      if (!/AUR\.app/.test(src)) fail('T3', `${f} does not use the AUR.app namespace`);
      if (!/throw new Error\(['"`]app-state\.js must load before/.test(src)) fail('T3', `${f} lacks the app-state.js load guard`);
      if (!/^'use strict';/m.test(src)) fail('T3', `${f} is not in strict mode`);
    }
  }
  if (assignments.length !== 1 || !assignments[0].startsWith('app-state.js:1')) {
    fail('T3', `AUR.app must be assigned exactly once, in app-state.js; found [${assignments.join(', ') || 'none'}]`);
  }
  if (failures === before) ok('T3', 'AUR.app owned by app-state.js; every module guards its load order');
}

// ---- T4: shared path classifier (task C) ----
if (!reached('C')) skip('T4', 'C');
else {
  const before = failures;
  const HELPERS = ['pathFlavor', 'validPathString', 'isCanonicalPath', 'isCanonicalPathFor', 'isInsidePath', 'isAbsolutePosixPath'];
  const EXPORTS = [...HELPERS, 'isLocalProjectPath', 'canonicalProjectPath'];
  if (!exists('src/main/path-safety.js')) fail('T4', 'src/main/path-safety.js missing');
  else {
    const ps = read('src/main/path-safety.js');
    for (const name of EXPORTS) if (!new RegExp(`\\b${name}\\b`).test(ps)) fail('T4', `path-safety.js does not mention export ${name}`);
    if (!/require\(['"]\.\/provider-adapters['"]\)/.test(ps)) fail('T4', 'path-safety.js must re-export from ./provider-adapters');
    if (/^\s*import\s/m.test(ps)) fail('T4', 'path-safety.js must be CommonJS');
  }
  for (const rel of ['src/main/agent-launcher.js', 'src/main/terminal-launcher.js']) {
    const src = read(rel);
    if (!/require\(['"]\.\/path-safety['"]\)/.test(src)) fail('T4', `${rel} does not require ./path-safety`);
    for (const name of HELPERS) {
      if (new RegExp(`^\\s*function\\s+${name}\\s*\\(`, 'm').test(src)) fail('T4', `${rel} still defines ${name} locally`);
    }
  }
  if (!exists('test/path-safety.test.js')) fail('T4', 'test/path-safety.test.js missing');
  if (failures === before) ok('T4', 'one path classifier in path-safety.js; launchers import it');
}

// ---- T5: scene dispose is a documented, bounded isReady() poll (task D; §2.6 reversed) ----
if (!reached('D')) skip('T5', 'D');
else {
  const before = failures;
  const appLayer = rendererFiles.filter((f) => /^app(-[a-z0-9-]+)?\.js$/.test(f)).map((f) => read('src/renderer/' + f)).join('\n');
  const disposeMatch = appLayer.match(/function disposeSettled\([\s\S]*?\r?\n  \}\r?\n/);
  if (!disposeMatch) fail('T5', 'disposeSettled not found in the app layer');
  else {
    const body = disposeMatch[0];
    if (!/isReady/.test(body)) fail('T5', 'disposeSettled does not poll isReady()');
    if (!/4000/.test(body)) fail('T5', 'disposeSettled lacks the 4 s bound');
    if (!/Kit 13/.test(body)) fail('T5', 'disposeSettled lacks the Kit 13 design comment');
    if (/onLoadObservable\.addOnce/.test(body)) fail('T5', 'disposeSettled uses onLoadObservable.addOnce (fires before the BRDF decode)');
  }
  if (failures === before) ok('T5', 'disposeSettled is a documented, bounded isReady() poll');
}

// ---- T7: unit tests (the sweep passes --no-unit-tests because it runs npm test once itself) ----
if (process.argv.includes('--no-unit-tests')) ok('T7', 'npm test left to the sweep (--no-unit-tests)');
else {
  const r = spawnSync('npm test', { cwd: ROOT, encoding: 'utf8', shell: true });
  const summary = (r.stdout.match(/ℹ (pass|fail) \d+/g) || []).join(', ');
  if (r.status !== 0) fail('T7', `npm test failed (${summary || 'no summary'})`);
  else ok('T7', `npm test green (${summary})`);
}

// ---- --full: the whole gate sweep, one line per gate (kit/run-gates.mjs) ----
if (FULL) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'run-gates.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 1_800_000 });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) fail('FULL', 'the gate sweep is red (see above)');
  else ok('FULL', 'every gate green');
}

console.log(`\n============= KIT 13 STRUCTURE GRADE (stage ${STAGE}${FULL ? ', full' : ''}) =============`);
if (failures) { console.log(`FAIL  ${failures} check(s) red`); process.exit(1); }
console.log(`PASS  every check expected at stage ${STAGE} is green${FULL ? ', including the whole gate sweep' : ' (add --full before committing)'}`);
