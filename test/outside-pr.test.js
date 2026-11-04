'use strict';

// The outside pull request check: who is outside, which files need the owner's review, which events
// count, the verdict and comment, and a workflow that never runs the pull request's code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../scripts/outside-pr.mjs');
const REPO = 'MatthewNorton/agent-orrery';
const FORK = 'someone/agent-orrery';
const pr = (login, headRepo = REPO) => ({
  user: { login },
  head: { sha: '0123456789abcdef', repo: headRepo && { full_name: headRepo } },
  base: { ref: 'main', repo: { full_name: REPO } },
});

test('only the owner and Dependabot, from this repository, are inside', async () => {
  const { isOutside } = await load();
  assert.equal(isOutside(pr('MatthewNorton')), false);
  assert.equal(isOutside(pr('dependabot[bot]')), false);
  assert.equal(isOutside(pr('MatthewNorton', 'MatthewNorton/agent-orrery-copy')), true);
  assert.equal(isOutside(pr('someone', FORK)), true);
  assert.equal(isOutside(pr('someone')), true);
  assert.equal(isOutside(pr('MatthewNorton', null)), true, 'a deleted fork has no head repository');
});

test('source, docs and assets change freely; agent and tool files anywhere, and everything else, need review', async () => {
  const { needsReview } = await load();
  const review = ['AGENTS.md', 'src/renderer/AGENTS.md', 'docs/claude.md', 'CLAUDE.local.md', 'src/a/AGENTS.override.md',
    'docs/GEMINI.md', '.claude/settings.json', 'src/.Claude/skills/a/SKILL.md', '.codex/config.toml', '.cursor/rules/a.mdc',
    '.envrc', 'kit/README.md', 'GOALS.md', 'package.json', 'src/main/package.json', 'package-lock.json', '.npmrc',
    'src/node_modules/electron/index.js', 'scripts/setup.mjs', 'test/a.test.js', '.github/workflows/ci.yml', '.mcp.json',
    '.vscode/tasks.json', 'docs/a.code-workspace', 'Install Agent Orrery.cmd', 'design/tricolor/build.cjs', 'tsconfig.json',
    'assets/ships/a/.gitignore', 'new-tool.toml'];
  const free = ['src/main/tracker.js', 'src/renderer/index.html', 'README.md', 'LICENSE', 'SECURITY.md', 'docs/GOALS.md',
    'docs/AGENTS-notes.md', 'docs/kit/a.md', 'src/scripts.js', 'assets/a.png'];
  for (const file of review) assert.equal(needsReview(file), true, file);
  for (const file of free) assert.equal(needsReview(file), false, file);
  for (const file of ['src/a\\AGENTS.md', 'src/CLAUDE.md.', 'src/AGENTS.md ', 'src/Package.JSON', 'src/AGENT\u017f.md', 'src/.../a.js']) {
    assert.equal(needsReview(file), true, `${file} can land on a listed file in a Windows or macOS checkout`);
  }
});

test('renamed-from paths count, and a file list the API cut short needs review', async () => {
  const { filesToReview } = await load();
  assert.deepEqual(filesToReview([{ filename: 'docs/ci.md', previous_filename: '.github/workflows/ci.yml' }], 1), ['.github/workflows/ci.yml']);
  assert.deepEqual(filesToReview([{ filename: 'src/a.js' }], 1), []);
  assert.equal(filesToReview([{ filename: 'src/a.js' }], 2).length, 1);
  assert.equal(filesToReview(Array.from({ length: 3000 }, (_, i) => ({ filename: `src/${i}.js` })), 3000).length, 1);
});

test('among label and edit events, only the review label and a new base branch count', async () => {
  const { relevant, REVIEWED } = await load();
  assert.equal(relevant({ action: 'synchronize' }), true);
  assert.equal(relevant({ action: 'labeled', label: { name: REVIEWED } }), true);
  assert.equal(relevant({ action: 'unlabeled', label: { name: REVIEWED } }), true);
  assert.equal(relevant({ action: 'labeled', label: { name: 'bug' } }), false);
  assert.equal(relevant({ action: 'edited', changes: { title: { from: 'a' } } }), false);
  assert.equal(relevant({ action: 'edited', changes: { base: { ref: { from: 'dev' } } } }), true);
});

test('an outside change that needs review passes only on the owner adding the review label', async () => {
  const { decide, REVIEWED } = await load();
  const flagged = ['package.json'];
  const on = new Set([REVIEWED]);
  const outside = pr('someone', FORK);
  const approve = { action: 'labeled', label: { name: REVIEWED }, sender: { login: 'MatthewNorton' }, pull_request: outside };
  const state = (event, files = flagged, labels = on) => decide(event, files, labels).state;
  assert.equal(state({ pull_request: pr('dependabot[bot]') }), 'success');
  assert.equal(state({ action: 'opened', pull_request: outside }, []), 'success');
  assert.equal(state({ action: 'opened', pull_request: outside }), 'failure');
  assert.equal(state(approve), 'success');
  assert.equal(state({ ...approve, sender: { login: 'someone' } }), 'failure');
  assert.equal(state(approve, flagged, new Set()), 'failure', 'the label came off');
  assert.equal(state({ action: 'synchronize', sender: { login: 'someone' }, pull_request: outside }), 'failure', 'a push needs a new review');
  for (const event of [{ pull_request: pr('dependabot[bot]') }, { action: 'opened', pull_request: outside }, approve]) {
    assert.ok(decide(event, flagged, on).description.length <= 140, 'GitHub caps a status description at 140 characters');
  }
});

test('the comment neutralizes file names and caps its list', async () => {
  const { commentBody } = await load();
  const body = commentBody(['a`b\n\u202e.md']);
  assert.match(body, /^<!-- outside-pr-guard -->\n/);
  assert.ok(body.includes('- `a?b??.md`'), body);
  const long = commentBody(Array.from({ length: 60 }, (_, i) => `test/${i}.js`));
  assert.equal(long.match(/^- `/gm)?.length, 50);
  assert.match(long, /^- and 10 more$/m);
});

test('the workflow runs main\'s copy of the check and never the pull request\'s code', () => {
  const yml = fs.readFileSync(path.resolve(__dirname, '..', '.github', 'workflows', 'outside-pr.yml'), 'utf8');
  assert.match(yml, /^ {2}pull_request_target:/m);
  assert.match(yml, /persist-credentials: false/);
  assert.doesNotMatch(yml, /^\s*ref:/m, 'the checkout stays on the base branch');
  assert.doesNotMatch(yml, /\bnpm\b|\bnpx\b/, 'nothing is installed');
  const runs = yml.split('\n').filter((line) => /^\s*(- )?run:/.test(line));
  assert.deepEqual(runs.map((line) => line.trim()), ['- run: node scripts/outside-pr.mjs --ci']);
});
