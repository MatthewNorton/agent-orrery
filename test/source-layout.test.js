'use strict';

// AGENTS.md "Folders over prefixes", checked for the source files under src/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const entries = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, withFileTypes: true });
const folderOf = (entry) => path.relative(ROOT, entry.parentPath).split(path.sep).join('/');
// One stem per module: a component's .js and .css count once.
const stems = new Map(entries.filter((e) => e.isFile() && /\.(js|css|html|ts)$/.test(e.name)).map((e) => {
  const stem = { folder: folderOf(e), name: e.name.slice(0, e.name.indexOf('.')) };
  return [`${stem.folder}/${stem.name}`, stem];
}));

test('no src/ folder holds more than three source files that share a name prefix', () => {
  const groups = Map.groupBy(stems.entries(), ([, { folder, name }]) => `${folder}/${name.split('-')[0]}`);
  const crowded = [...groups.values()].filter((group) => group.length > 3)
    .map((group) => group.map(([where]) => where).join(', '));
  assert.deepEqual(crowded, [], 'move each group into a folder named for what it shares');
});

test('a source file named for a sibling folder lives in that folder', () => {
  const folders = entries.filter((e) => e.isDirectory()).map((e) => `${folderOf(e)}/${e.name}`);
  const strays = [...stems.keys()]
    .filter((where) => folders.some((folder) => where === folder || where.startsWith(`${folder}-`)));
  assert.deepEqual(strays, []);
});
