'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hasControlChars, validProjectId, validGoalId } = require('../src/main/shared/ids');
const goals = require('../src/main/goals');

test('hasControlChars covers C0, DEL and C1 but not ordinary text', () => {
  for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x9f]) {
    assert.equal(hasControlChars(`a${String.fromCharCode(code)}b`), true, code.toString(16));
  }
  for (const text of ['plain', 'tab-free text', 'é ü \u00a0 \u2028', '']) {
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

test('validGoalId accepts UUID versions 1-8 in either case', () => {
  for (const version of '12345678') {
    assert.equal(validGoalId(`123e4567-e89b-${version}2d3-a456-426614174000`), true, version);
  }
  assert.equal(validGoalId('123E4567-E89B-42D3-A456-426614174000'), true);
  assert.equal(validGoalId(crypto.randomUUID()), true);
  for (const id of ['123e4567-e89b-02d3-a456-426614174000', '123e4567-e89b-92d3-a456-426614174000',
    '123e4567-e89b-42d3-c456-426614174000', '123e4567e89b42d3a456426614174000',
    ' 123e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174000\n',
    'not-a-uuid', '', null, 42]) {
    assert.equal(validGoalId(id), false, JSON.stringify(id));
  }
});

test('goals.js still exports the shared goal-id check', () => {
  assert.equal(goals.validGoalId, validGoalId);
});
