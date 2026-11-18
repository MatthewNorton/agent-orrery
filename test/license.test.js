'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');

test('LICENSE is the unmodified Apache License 2.0, and the package, citation and NOTICE name it', () => {
  // The hash of https://www.apache.org/licenses/LICENSE-2.0.txt.
  assert.equal(crypto.createHash('sha256').update(read('LICENSE')).digest('hex'),
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  assert.equal(JSON.parse(read('package.json')).license, 'Apache-2.0');
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].license, 'Apache-2.0');
  assert.match(read('CITATION.cff'), /^license: Apache-2\.0$/m);
  // Pinned whole: redistributors have to carry every line of it.
  assert.equal(read('NOTICE'), [
    'Agent Orrery',
    'Copyright (c) 2026 Matt Norton',
    'https://github.com/MatthewNorton/agent-orrery',
    '',
    'Licensed under the Apache License, Version 2.0. See the LICENSE file.',
    '',
  ].join('\n'));
});
