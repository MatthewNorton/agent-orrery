'use strict';

// Owner's rule (2026-10-18, AGENTS.md): a folder stays flat until more than three files in it share
// the first word of their names; then they move into a folder named for that word.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const MAX_SHARED_PREFIX = 3;

function crowdedPrefixes(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const groups = new Map();
  for (const entry of entries.filter((e) => e.isFile())) {
    const word = entry.name.split(/[-.]/)[0];
    groups.set(word, [...(groups.get(word) ?? []), entry.name]);
  }
  const where = path.relative(SRC, dir).split(path.sep).join('/') || '.';
  return [
    ...[...groups].filter(([, files]) => files.length > MAX_SHARED_PREFIX)
      .map(([word, files]) => `src/${where}: ${files.join(', ')} belong in ${word}/`),
    ...entries.filter((e) => e.isDirectory()).flatMap((e) => crowdedPrefixes(path.join(dir, e.name))),
  ];
}

test('no folder under src/ holds more than three files that share a name prefix', () => {
  assert.deepEqual(crowdedPrefixes(SRC), []);
});
