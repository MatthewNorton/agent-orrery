'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasControlChars, validProjectId } = require('../src/main/shared/ids');

test('hasControlChars covers C0, DEL and C1 but not ordinary text', () => {
  for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x9f]) {
    assert.equal(hasControlChars(`a${String.fromCharCode(code)}b`), true, code.toString(16));
  }
  for (const text of ['plain', 'tab-free text', 'é ü    ', '']) {
    assert.equal(hasControlChars(text), false, JSON.stringify(text));
  }
});

test('validProjectId accepts 1 to 256 characters with something besides whitespace', () => {
  for (const id of ['p', 'project-one', 'C--workspace-code', 'project:abc123', ' padded ', 'x'.repeat(256)]) {
    assert.equal(validProjectId(id), true, id);
  }
  for (const id of ['', '   ', 'x'.repeat(257), 'line\nbreak', 'nul\0', 'del\u007f', 'c1\u0085',
    null, undefined, 42, ['p'], { id: 'p' }]) {
    assert.equal(validProjectId(id), false, JSON.stringify(id));
  }
});
