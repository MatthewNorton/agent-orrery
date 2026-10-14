'use strict';

// Every tracked file is clean of home folders, personal addresses, credentials and private keys,
// and the rules catch what they are meant to.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = () => import('../scripts/leak-check.mjs');

// The samples are assembled at runtime so this file passes its own check.
const who = ['jor', 'dan'].join('');
const win = (user) => ['C:', 'Users', user, 'x'].join('\\');

test('the rules flag real home folders, addresses and credentials, and allow the fixtures', async () => {
  const { scanText } = await load();
  const rules = (text) => scanText(text).map((f) => f.rule);
  assert.deepEqual(rules(win(who)), ['home-path']);
  assert.deepEqual(rules(`c:/users/${who}/x and /home/${who}/x and /Users/${who}/x`), ['home-path', 'home-path', 'home-path']);
  assert.deepEqual(rules(`C--Users-${who}--claude`), ['home-path']);
  assert.deepEqual(rules(`${win('alice')} /home/coder/x /Users/sam/x ${win('<you>')} $HOME/x`), []);
  assert.deepEqual(rules(`${who}.smith@${['gmail', 'com'].join('.')}`), ['email']);
  assert.deepEqual(rules('1234+someone@users.noreply.github.com git@github.com fixture@example.invalid a@example.com'), []);
  assert.deepEqual(rules('ghp_' + 'a'.repeat(36)), ['credential']);
  assert.deepEqual(rules(['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')), ['credential']);
  assert.deepEqual(rules('sk-ant-' + 'b'.repeat(20)), ['credential']);
  assert.equal(scanText(`x\ny\n${win(who)}`, 'f.js')[0].line, 3);
});

test('no tracked file leaks', async () => {
  const { scanRepo } = await load();
  const findings = scanRepo(path.resolve(__dirname, '..'));
  assert.deepEqual(findings, [], findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.match}`).join('\n'));
});
