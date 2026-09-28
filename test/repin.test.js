'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const repin = path.join(repoRoot, 'kit', 'repin.mjs');
const gates = ['kit/done/agent-control/grade-control.mjs', 'kit/done/history-playback/grade-history.mjs'];

// Copy both gates and every file they pin into a temp root so the real repo is never touched.
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-'));
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), path.join(root, rel));
  };
  for (const gate of gates) {
    copy(gate);
    for (const m of fs.readFileSync(path.join(repoRoot, gate), 'utf8').matchAll(/\[\s*'([^']+)'\s*,\s*'[0-9a-f]{64}'\s*\]/g)) {
      if (!fs.existsSync(path.join(root, m[1]))) copy(m[1]);
    }
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [repin, '--root', root, ...args], { encoding: 'utf8' });
}

test('repin --check reports a deliberately wrong pin and exits 1', (t) => {
  const root = tempRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gate = path.join(root, gates[0]);
  const source = fs.readFileSync(gate, 'utf8');
  const broken = source.replace(/(\['src\/renderer\/util\.js',\s*')[0-9a-f]{64}'/, `$1${'0'.repeat(64)}'`);
  assert.notEqual(broken, source, 'fixture must contain a util.js pin');
  fs.writeFileSync(gate, broken);

  const r = run(root, '--check');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^STALE kit\/done\/agent-control\/grade-control\.mjs src\/renderer\/util\.js$/m);
  assert.equal(fs.readFileSync(gate, 'utf8'), broken, '--check must not modify the gate');
});

test('repin refuses to rewrite without --note, then rewrites and annotates with it', (t) => {
  const root = tempRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gate = path.join(root, gates[1]);
  const source = fs.readFileSync(gate, 'utf8');
  // package.json is no longer fingerprinted (dependency names are pinned instead), so
  // corrupt a frozen code-file pin that both gates still carry.
  const broken = source.replace(/(\['src\/renderer\/polish-math\.js',\s*')[0-9a-f]{64}'/, `$1${'f'.repeat(64)}'`);
  assert.notEqual(broken, source, 'fixture must contain a polish-math.js pin');
  fs.writeFileSync(gate, broken);

  const refused = run(root);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--note/);

  const r = run(root, '--note', 'test note');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rewritten = fs.readFileSync(gate, 'utf8');
  assert.match(rewritten, /\/\/ \d{4}-\d{2}-\d{2} re-pinned: src\/renderer\/polish-math\.js — test note\r?\nconst frozen = new Map\(\[/);
  assert.equal(rewritten.includes('f'.repeat(64)), false);
  assert.equal(run(root, '--check').status, 0);
});
