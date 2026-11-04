'use strict';

// The outside pull request check: who is outside, which files need the owner's review, the
// verdict and comment, and a workflow that never runs the pull request's code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../scripts/outside-pr.mjs');
const REPO = 'MatthewNorton/agent-orrery';
const FORK = 'someone/agent-orrery';
const pr = (login, headRepo = REPO, labels = []) => ({
  user: { login },
  head: { sha: '0123456789abcdef', repo: headRepo && { full_name: headRepo } },
  base: { ref: 'main', repo: { full_name: REPO } },
  labels: labels.map((name) => ({ name })),
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

test('agent instructions and code that runs locally need review, at the depth each one acts', async () => {
  const { toolingReason } = await load();
  const agents = ['AGENTS.md', 'src/renderer/AGENTS.md', 'docs/claude.md', 'CLAUDE.local.md', 'x/AGENTS.override.md',
    '.claude/settings.json', 'src/.Claude/skills/a/SKILL.md', '.codex/config.toml', 'kit/README.md', 'GOALS.md'];
  const runs = ['package.json', 'src/main/package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.yarnrc.yml',
    '.pnpmfile.cjs', 'src/node_modules/electron/index.js', 'scripts/setup.mjs', 'test/a.test.js', '.github/workflows/ci.yml',
    '.mcp.json', '.vscode/tasks.json', '.devcontainer/devcontainer.json', '.devcontainer.json', 'Install Agent Orrery.cmd',
    'install agent orrery.command'];
  const neither = ['src/main/tracker.js', 'README.md', 'docs/GOALS.md', 'docs/AGENTS-notes.md', 'toolkit/a.js',
    'src/scripts.js', 'tests/a.js', 'docs/kit/a.md', 'assets/a.png'];
  for (const file of agents) assert.equal(toolingReason(file), 'agent instructions', file);
  for (const file of runs) assert.equal(toolingReason(file), 'tooling', file);
  for (const file of neither) assert.equal(toolingReason(file), null, file);
  for (const file of ['.claude\\settings.json', 'CLAUDE.md.', 'AGENTS.md ', 'Package.JSON']) {
    assert.notEqual(toolingReason(file), null, `${file} lands on a listed file in a Windows checkout`);
  }
});

test('renamed-from paths count, and a file list the API cut short needs review', async () => {
  const { toolingFiles } = await load();
  const moved = [{ filename: 'docs/ci.yml', previous_filename: '.github/workflows/ci.yml' }];
  assert.deepEqual(toolingFiles(moved, 1).map((f) => f.file), ['.github/workflows/ci.yml']);
  assert.deepEqual(toolingFiles([{ filename: 'src/a.js' }], 1), []);
  assert.equal(toolingFiles([{ filename: 'src/a.js' }], 2).length, 1);
  assert.equal(toolingFiles(Array.from({ length: 3000 }, (_, i) => ({ filename: `src/${i}.js` })), 3000).length, 1);
});

test('an outside tooling change passes only on the owner adding the review label', async () => {
  const { decide, REVIEWED } = await load();
  const flagged = [{ file: 'package.json', why: 'runs' }];
  const state = (event, files = flagged) => decide(event, files).state;
  assert.equal(state({ pull_request: pr('dependabot[bot]') }), 'success');
  assert.equal(state({ pull_request: pr('someone', FORK) }, []), 'success');
  assert.equal(state({ action: 'opened', pull_request: pr('someone', FORK) }), 'failure');
  const label = { action: 'labeled', label: { name: REVIEWED } };
  const labelled = pr('someone', FORK, [REVIEWED]);
  assert.equal(state({ ...label, sender: { login: 'MatthewNorton' }, pull_request: labelled }), 'success');
  assert.equal(state({ ...label, sender: { login: 'someone' }, pull_request: labelled }), 'failure');
  assert.equal(state({ ...label, sender: { login: 'MatthewNorton' }, pull_request: pr('someone', FORK) }), 'failure', 'the label came off');
  assert.equal(state({ action: 'synchronize', sender: { login: 'someone' }, pull_request: labelled }), 'failure', 'a push needs a new review');
  for (const event of [{ pull_request: pr('dependabot[bot]') }, { action: 'opened', pull_request: pr('someone', FORK) }]) {
    assert.ok(decide(event, flagged).description.length <= 140, 'GitHub caps a status description at 140 characters');
  }
});

test('the comment neutralizes file names and caps its list', async () => {
  const { commentBody } = await load();
  const body = commentBody([{ file: 'a`b\n‮.md', why: 'agent instructions' }]);
  assert.match(body, /^<!-- outside-pr-guard -->\n/);
  assert.ok(body.includes('- `a?b??.md` (agent instructions)'), body);
  const long = commentBody(Array.from({ length: 60 }, (_, i) => ({ file: `test/${i}.js`, why: 'runs' })));
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
