#!/usr/bin/env node
// Kit 13 gate — structural cleanup (docs/PUBLIC-RELEASE-TASKS.md Phase 5).
// Fails cleanly until the kit is built. `--full` additionally runs every archived
// gate and the renderer gate three times. Exit 0 only when everything passes.
//
// Usage: node kit/todo/grade-structure.mjs [--full]
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
const RENDERER = path.join(ROOT, 'src', 'renderer');

let failures = 0;
const ok = (id, msg) => console.log(`${id} PASS  ${msg}`);
const fail = (id, msg) => { failures++; console.log(`${id} FAIL  ${msg}`); };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const lines = (rel) => read(rel).split(/\r?\n/).length;

// ---- T1: renderer file sizes ----
const CAPS = { 'scene-universe.js': 971, 'scene-system.js': 618 }; // frozen at current size
const rendererFiles = fs.readdirSync(RENDERER).filter((f) => f.endsWith('.js')).sort();
for (const f of rendererFiles) {
  const cap = CAPS[f] ?? 600;
  const n = lines('src/renderer/' + f);
  if (n > cap) fail('T1', `${f} is ${n} lines (cap ${cap})`);
}
if (!rendererFiles.some((f) => f.startsWith('app-'))) fail('T1', 'no app-*.js modules exist yet');
if (failures === 0) ok('T1', `all ${rendererFiles.length} renderer files within caps`);

// ---- T2: index.html load order and no ES modules ----
const t2Before = failures;
const html = read('src/renderer/index.html');
const tags = [...html.matchAll(/<script\s+src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
const appTags = tags.filter((t) => /^app(-[a-z0-9-]+)?\.js$/.test(t));
const modulesOnDisk = rendererFiles.filter((f) => /^app-[a-z0-9-]+\.js$/.test(f));
if (/type="module"/.test(html)) fail('T2', 'index.html uses type="module"');
if (appTags[0] !== 'app-state.js') fail('T2', `first app script must be app-state.js, found ${appTags[0] ?? 'none'}`);
if (appTags[appTags.length - 1] !== 'app.js') fail('T2', 'app.js must be the last app script');
for (const m of modulesOnDisk) if (!appTags.includes(m)) fail('T2', `${m} exists but is not loaded by index.html`);
for (const t of appTags) if (t !== 'app.js' && !modulesOnDisk.includes(t)) fail('T2', `index.html loads ${t} which does not exist`);
const scenePlanetIdx = tags.indexOf('scene-planet.js');
if (tags.includes('app-state.js') && (scenePlanetIdx < 0 || tags.indexOf('app-state.js') < scenePlanetIdx)) fail('T2', 'app-state.js must load after scene-planet.js');
for (const f of rendererFiles) {
  const src = read('src/renderer/' + f);
  if (/^\s*(import\s.+from\s|export\s)/m.test(src)) fail('T2', `${f} uses ES module syntax`);
}
if (failures === t2Before) ok('T2', `index.html loads ${modulesOnDisk.length} modules between app-state.js and app.js`);

// ---- T3: single AUR.app owner; modules guard against missing namespace ----
const t3Before = failures;
let assignments = [];
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
if (failures === t3Before) ok('T3', 'AUR.app owned by app-state.js; every module guards its load order');

// ---- T4: shared path classifier ----
const t4Before = failures;
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
if (failures === t4Before) ok('T4', 'one path classifier in path-safety.js; launchers import it');

// ---- T5: scene dispose waits on the load observable ----
const t5Before = failures;
const appLayer = rendererFiles.filter((f) => /^app(-[a-z0-9-]+)?\.js$/.test(f)).map((f) => read('src/renderer/' + f)).join('\n');
const disposeMatch = appLayer.match(/function disposeSettled\([\s\S]*?\r?\n  \}\r?\n/);
if (!disposeMatch) fail('T5', 'disposeSettled not found in the app layer');
else {
  const body = disposeMatch[0];
  if (!/onLoadObservable/.test(body)) fail('T5', 'disposeSettled does not use onLoadObservable');
  if (/setTimeout\(tick,\s*50\)/.test(body) || /waited\s*\+=\s*50/.test(body)) fail('T5', 'disposeSettled still polls every 50 ms');
  if (!/4000/.test(body)) fail('T5', 'disposeSettled lacks the 4 s fallback');
}
if (failures === t5Before) ok('T5', 'disposeSettled is observable-driven with a single 4 s fallback');

// ---- T6: pins current ----
if (!exists('kit/repin.mjs')) fail('T6', 'kit/repin.mjs missing');
else {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'repin.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) fail('T6', `repin --check failed:\n${(r.stdout + r.stderr).trim()}`);
  else ok('T6', 'all frozen-file pins current');
}

// ---- T7: unit tests ----
{
  const r = spawnSync('npm test', { cwd: ROOT, encoding: 'utf8', shell: true });
  const summary = (r.stdout.match(/ℹ (pass|fail) \d+/g) || []).join(', ');
  if (r.status !== 0) fail('T7', `npm test failed (${summary || 'no summary'})`);
  else ok('T7', `npm test green (${summary})`);
}

// ---- --full: every archived gate + renderer gate x3 ----
if (FULL) {
  const doneDir = path.join(ROOT, 'kit', 'done');
  const gates = fs.readdirSync(doneDir).flatMap((d) =>
    fs.readdirSync(path.join(doneDir, d)).filter((f) => /^grade-.*\.mjs$/.test(f)).map((f) => path.join('kit', 'done', d, f)));
  for (const g of gates) {
    if (g.endsWith('grade-structure.mjs')) continue; // never recurse into ourselves
    const r = spawnSync(process.execPath, [path.join(ROOT, g)], { cwd: ROOT, encoding: 'utf8', timeout: 900_000 });
    if (r.status !== 0) fail('FULL', `${g} failed:\n${(r.stdout + r.stderr).split(/\r?\n/).filter((l) => /FAIL|Error/.test(l)).slice(0, 3).join('\n')}`);
    else ok('FULL', `${g} green`);
  }
  for (let i = 1; i <= 3; i++) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'grade.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 900_000 });
    if (r.status !== 0) fail('FULL', `kit/grade.mjs run ${i} failed`);
    else ok('FULL', `kit/grade.mjs run ${i} green`);
  }
}

console.log(`\n============= KIT 13 STRUCTURE GRADE =============`);
if (failures) { console.log(`FAIL  ${failures} check(s) red${FULL ? '' : ' (run with --full before committing)'}`); process.exit(1); }
console.log(`PASS  all structural checks green${FULL ? ' including every archived gate and 3x renderer gate' : ' (run with --full before committing)'}`);
