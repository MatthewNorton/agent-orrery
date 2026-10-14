'use strict';

// Every tracked file is clean of home folders, personal addresses, credentials and private keys,
// and the rules catch what they are meant to.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = () => import('../scripts/leak-check.mjs');

test('the rules flag real home folders, addresses and credentials, and allow the fixtures', async () => {
  const { scanText } = await load();
  const rules = (text) => scanText(text).map((f) => f.rule);
  assert.deepEqual(rules('C:\\Users\\jordan\\Documents\\x'), ['home-path']);
  assert.deepEqual(rules('c:/users/jordan/x and /home/jordan/x and /Users/jordan/x'), ['home-path', 'home-path', 'home-path']);
  assert.deepEqual(rules('C--Users-jordan--claude'), ['home-path']);
  assert.deepEqual(rules('C:\\Users\\alice\\x /home/coder/x /Users/sam/x C:\\Users\\<you>\\x $HOME/x'), []);
  assert.deepEqual(rules('someone@example.com'), ['email']);
  assert.deepEqual(rules('1234+someone@users.noreply.github.com git@github.com fixture@example.invalid a@example.com'), []);
  assert.deepEqual(rules('ghp_' + 'a'.repeat(36)), ['credential']);
  assert.deepEqual(rules('-----BEGIN OPENSSH PRIVATE KEY-----'), ['credential']);
  assert.deepEqual(rules('sk-ant-' + 'b'.repeat(20)), ['credential']);
  assert.equal(scanText('x\ny\nC:\\Users\\jordan', 'f.js')[0].line, 3);
});

test('no tracked file leaks', async () => {
  const { scanRepo } = await load();
  const findings = scanRepo(path.resolve(__dirname, '..'));
  assert.deepEqual(findings, [], findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.match}`).join('\n'));
});
