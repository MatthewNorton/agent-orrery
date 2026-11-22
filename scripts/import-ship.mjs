#!/usr/bin/env node
// Brings a ship model into the renderer. A model is written elsewhere as ES modules against
// @babylonjs/core; the renderer runs classic scripts against the BABYLON global. This converts one
// to the other mechanically and proves the result builds the same ship:
//
//   node scripts/import-ship.mjs <ship> <folder holding the ship's source> [--check]
//
// Each source module becomes one file under src/renderer/ships/<ship>/source/ that registers a
// factory with AUR.shipModule. source.json beside them records the last source commit that touched
// the ship, a hash of every source file and of the file generated from it, and a fingerprint of the
// built geometry, and of each variant's; test/ships-source.test.js holds the committed files to the
// last two. --check writes nothing and reports whether the files on disk are current.
// Nothing here edits a model: a change to a ship is made at its source, then this runs again.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { lf, sha256, fingerprintOf, loadShipModules, rootOf } = require('./lib/ship-fingerprint.js');
const BABYLON = require('babylonjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(ROOT, 'src', 'renderer', 'ships', 'modules.js');
const BABYLON_PACKAGE = '@babylonjs/core/';

// Per ship: the modules the app starts from (their imports are followed), the function that
// builds one ship, as [module, function] (it takes a scene and returns { root }), and its
// variants, each the call made on what the build returns, as [method, ...arguments].
const SHIPS = {
  petrel: {
    entries: ['spacecraft.js', 'exhaust.js', 'light-probe.js'],
    build: ['spacecraft', 'createPetrel'],
    variants: { ring: ['setRing', true] },
  },
};

const IMPORT = /^import\s*(?:\{([^}]*)\}\s*from\s*)?(['"])([^'"\n]+)\2[ \t]*;?[ \t]*$/gm;
const EXPORT = /^export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b)/gm;
const LEFTOVER = /^[ \t]*(?:import|export)\b.*$|\bimport\s*\(|\bimport\.meta\b/m;

const fail = (message) => { throw new Error(message); };
const stemOf = (file) => path.basename(file).replace(/\.m?js$/, '');

/** `a, b as c` to [['a', 'a'], ['b', 'c']]. */
function namesOf(list) {
  return list.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, alias] = part.split(/\s+as\s+/);
    return [name, alias || name];
  });
}

const destructure = (names) => names.map(([name, alias]) => (name === alias ? name : name + ': ' + alias)).join(', ');

/** Where a @babylonjs/core export lives on the UMD global. */
function babylonPath(name) {
  if (BABYLON[name] !== undefined) return 'BABYLON';
  if (BABYLON.MeshBuilder[name] !== undefined) return 'BABYLON.MeshBuilder';
  return fail('The BABYLON global has no ' + name + '.');
}

/** Reads the entry modules and every module they import, in dependency order. */
function readModules(sourceDir, entries) {
  const modules = new Map();
  const visiting = new Set();
  function visit(file) {
    if (modules.has(file)) return;
    if (visiting.has(file)) fail('Circular import through ' + file + '.');
    visiting.add(file);
    const text = lf(fs.readFileSync(path.join(sourceDir, file), 'utf8'));
    const imports = [...text.matchAll(IMPORT)].map((match) => ({ names: namesOf(match[1] || ''), from: match[3] }));
    for (const { from } of imports) {
      if (from.startsWith('./') && !from.slice(2).includes('/')) visit(from.slice(2));
      else if (!from.startsWith(BABYLON_PACKAGE)) fail(file + ' imports ' + from + ': only modules in the ship\'s own folder and ' + BABYLON_PACKAGE + ' are supported.');
    }
    visiting.delete(file);
    modules.set(file, { file, stem: stemOf(file), text, imports });
  }
  entries.forEach(visit);
  const stems = new Set();
  for (const { stem, file } of modules.values()) {
    if (stems.has(stem)) fail('Two modules are named ' + stem + ' (' + file + ').');
    stems.add(stem);
  }
  return [...modules.values()];
}

/**
 * The source as real ES modules, with Babylon coming from the UMD build: what each module
 * exports, straight from the module loader, and the reference the converted files must match.
 */
async function loadOriginal(modules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-import-'));
  try {
    const names = new Set(modules.flatMap((module) => module.imports)
      .filter(({ from }) => from.startsWith(BABYLON_PACKAGE)).flatMap(({ names: list }) => list.map(([name]) => name)));
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
    fs.writeFileSync(path.join(dir, '__babylon.mjs'), [...names]
      .map((name) => 'export const ' + name + ' = globalThis.' + babylonPath(name) + '.' + name + ';\n').join(''));
    for (const { file, text } of modules) {
      fs.writeFileSync(path.join(dir, file), text.replace(IMPORT, (statement, list, quote, from) => {
        if (!from.startsWith(BABYLON_PACKAGE)) return statement;
        return list ? 'import {' + list + "} from './__babylon.mjs';" : '';
      }));
    }
    globalThis.BABYLON = BABYLON;
    const loaded = new Map();
    for (const { file, stem } of modules) loaded.set(stem, await import(pathToFileURL(path.join(dir, file)).href));
    return loaded;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const labelOf = (ship) => ship[0].toUpperCase() + ship.slice(1);

/** One module as a classic script: its imports become lookups, its exports the factory's result. */
function convert(ship, module, exported) {
  const body = module.text.replace(IMPORT, (statement, list, quote, from) => {
    const local = from.startsWith('./') && "use('" + ship + '/' + stemOf(from) + "')";
    // Imported for its side effects: a ship module still has to run; Babylon's are in the UMD build already.
    if (!list) return local ? local + ';' : '';
    const names = namesOf(list);
    if (local) return 'const { ' + destructure(names) + ' } = ' + local + ';';
    const groups = Map.groupBy(names, ([name]) => babylonPath(name));
    return [...groups].map(([where, group]) => 'const { ' + destructure(group) + ' } = ' + where + ';').join('\n');
  }).replace(EXPORT, '');
  const leftover = body.match(LEFTOVER);
  if (leftover) fail(module.file + ' has an import or export this script cannot convert: ' + leftover[0].trim());
  return [
    '// @ts-check',
    '// Generated by scripts/import-ship.mjs from ' + labelOf(ship) + "'s " + module.file + ' (source.json names the commit). Do not',
    '// edit this file: change the ship at its source and run the script again.',
    "'use strict';",
    '',
    "window.AUR.shipModule('" + ship + '/' + module.stem + "', function (use) {",
    body.replace(/^\n+|\n+$/g, ''),
    'return { ' + exported.join(', ') + ' };',
    '});',
    '',
  ].join('\n');
}

// The last commit that touched the ship's folder, so commits elsewhere in its repository change nothing here.
function sourceCommit(sourceDir) {
  const git = (...args) => execFileSync('git', ['-C', sourceDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const commit = git('log', '-1', '--format=%h', '--abbrev=12', '--', '.');
    return commit ? commit + (git('status', '--porcelain', '--', '.') ? '-modified' : '') : 'unversioned';
  } catch (error) {
    return 'unversioned';
  }
}

async function main() {
  const [ship, sourceArg] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const check = process.argv.includes('--check');
  const spec = SHIPS[ship];
  if (!spec || !sourceArg) fail('Usage: node scripts/import-ship.mjs <' + Object.keys(SHIPS).join('|') + '> <source folder> [--check]');
  const sourceDir = path.resolve(sourceArg);
  const outDir = path.join(ROOT, 'src', 'renderer', 'ships', ship, 'source');
  const commit = sourceCommit(sourceDir);
  const modules = readModules(sourceDir, spec.entries);
  const original = await loadOriginal(modules);
  const [buildModule, buildFunction] = spec.build;

  const files = new Map();
  const record = { ship, commit, build: spec.build, modules: {}, geometry: null, variants: {} };
  for (const module of modules) {
    const exported = Object.keys(original.get(module.stem));
    const generated = convert(ship, module, exported);
    files.set(module.stem + '.js', generated);
    record.modules[module.stem] = { source: module.file, sha256: sha256(module.text), generated: sha256(generated), exports: exported };
  }

  // The converted files must build the ship the source builds, vertex for vertex, in every variant.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-import-out-'));
  try {
    for (const [name, text] of files) fs.writeFileSync(path.join(stage, name), text);
    const use = loadShipModules(BABYLON, REGISTRY, [...files.keys()].map((name) => path.join(stage, name)));
    const proven = (call, label) => {
      const reference = fingerprintOf(BABYLON, (scene) => rootOf(original.get(buildModule)[buildFunction](scene), call));
      const geometry = fingerprintOf(BABYLON, (scene) => rootOf(use(ship + '/' + buildModule)[buildFunction](scene), call));
      if (JSON.stringify(reference) !== JSON.stringify(geometry)) {
        fail('The converted modules build a different ' + label + ': ' + JSON.stringify(geometry) + ' against ' + JSON.stringify(reference));
      }
      return geometry;
    };
    record.geometry = proven(null, 'ship');
    for (const [name, call] of Object.entries(spec.variants)) record.variants[name] = { call, geometry: proven(call, name + ' variant') };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  files.set('source.json', JSON.stringify(record, null, 2) + '\n');

  const onDisk = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const stale = onDisk.filter((name) => !files.has(name));
  const changed = [...files].filter(([name, text]) => !onDisk.includes(name) || lf(fs.readFileSync(path.join(outDir, name), 'utf8')) !== text)
    .map(([name]) => name);
  if (!check) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of stale) fs.rmSync(path.join(outDir, name));
    for (const name of changed) fs.writeFileSync(path.join(outDir, name), files.get(name));
  }
  const counts = ({ meshes, triangles, sha256: hash }) => meshes + ' meshes, ' + triangles + ' triangles, geometry ' + hash.slice(0, 12);
  console.log(labelOf(ship) + ' at ' + commit + ': ' + modules.length + ' modules, ' + counts(record.geometry) +
    Object.entries(record.variants).map(([name, { geometry }]) => '; ' + name + ': ' + counts(geometry)).join('') + '.');
  console.log((check ? 'Would change: ' : 'Wrote: ') + (changed.join(', ') || 'nothing') + (stale.length ? '; removed: ' + stale.join(', ') : ''));
  console.log('Script tags, after ships/modules.js:');
  for (const name of files.keys()) if (name.endsWith('.js')) console.log('  <script src="ships/' + ship + '/source/' + name + '"></script>');
  if (check && (changed.length || stale.length)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
