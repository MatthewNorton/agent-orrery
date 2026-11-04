'use strict';

// The outside pull request check: who is outside, which files need the owner's review, which events
// count, what approves a commit, the verdict and comment, and a workflow that never runs the pull
// request's code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../scripts/outside-pr.mjs');
const OWNER = 'MatthewNorton';
const REPO = `${OWNER}/agent-orrery`;
const FORK = 'someone/agent-orrery';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const OLD = 'fedcba9876543210fedcba9876543210fedcba98';
const pr = (login, headRepo = REPO) => ({
  user: { login },
  head: { sha: SHA, repo: headRepo && { full_name: headRepo } },
  base: { ref: 'main', repo: { full_name: REPO } },
});
const by = (login, body) => ({ user: { login }, body });

test('only the owner and Dependabot, from this repository, are inside', async () => {
  const { isOutside } = await load();
  assert.equal(isOutside(pr(OWNER)), false);
  assert.equal(isOutside(pr('dependabot[bot]')), false);
  assert.equal(isOutside(pr(OWNER, `${OWNER}/agent-orrery-copy`)), true);
  assert.equal(isOutside(pr('someone', FORK)), true);
  assert.equal(isOutside(pr('someone')), true);
  assert.equal(isOutside(pr(OWNER, null)), true, 'a deleted fork has no head repository');
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
  const windows = ['src/a\\AGENTS.md', 'src/CLAUDE.md.', 'src/AGENTS.md ', 'src/Package.JSON', 'CLAUDE~1/settings.json',
    'src/NODE_M~1/a.js', 'src/AGENT\u017f.md', 'src/caf\u00e9.js', 'src/.../a.js'];
  for (const file of windows) assert.equal(needsReview(file), true, `${file} can land on a listed file in a Windows or macOS checkout`);
});

test('renamed-from paths count, and a file list the API cut short needs review', async () => {
  const { filesToReview } = await load();
  assert.deepEqual(filesToReview([{ filename: 'docs/ci.md', previous_filename: '.github/workflows/ci.yml' }], 1), ['.github/workflows/ci.yml']);
  assert.deepEqual(filesToReview([{ filename: 'src/a.js' }], 1), []);
  assert.equal(filesToReview([{ filename: 'src/a.js' }], 2).length, 1);
  assert.equal(filesToReview(Array.from({ length: 3000 }, (_, i) => ({ filename: `src/${i}.js` })), 3000).length, 1);
});

test('pull request events count, but not edits that keep the base; owner comments count when they add or drop an approval', async () => {
  const { relevant } = await load();
  const comment = (login, body, from) => ({ action: from === undefined ? 'created' : 'edited',
    issue: { pull_request: {} }, comment: by(login, body), changes: { body: { from } } });
  assert.equal(relevant({ action: 'synchronize' }), true);
  assert.equal(relevant({ action: 'edited', changes: { title: { from: 'a' } } }), false);
  assert.equal(relevant({ action: 'edited', changes: { base: { ref: { from: 'dev' } } } }), true);
  assert.equal(relevant(comment(OWNER, `/tooling-reviewed ${SHA}`)), true);
  assert.equal(relevant(comment(OWNER, 'Thanks!')), false);
  assert.equal(relevant(comment(OWNER, 'Not yet.', `/tooling-reviewed ${SHA}`)), true, 'an approval edited away');
  assert.equal(relevant(comment(OWNER, `/TOOLING-REVIEWED ${SHA}`)), false, 'only the lowercase command approves');
  assert.equal(relevant(comment('someone', `/tooling-reviewed ${SHA}`)), false);
  assert.equal(relevant({ ...comment(OWNER, `/tooling-reviewed ${SHA}`), issue: {} }), false, 'an issue, not a pull request');
});

test('only an owner comment that is just the command and a full SHA approves that commit', async () => {
  const { approvals } = await load();
  const approved = approvals([
    by(OWNER, `\r\n/tooling-reviewed ${SHA}\r\n`),
    by(OWNER, `Reviewed the hooks change.\n/tooling-reviewed ${OLD}`),
    by(OWNER, `/tooling-reviewed ${OLD.slice(0, 12)}`),
    by(OWNER, `> /tooling-reviewed ${OLD}`),
    by(OWNER, `> quoted\u2028/tooling-reviewed ${OLD}`),
    by(OWNER, `/TOOLING-REVIEWED ${OLD}`),
    by(OWNER, `/tooling-reviewed ${OLD.toUpperCase()}`),
    by('someone', `/tooling-reviewed ${OLD}`),
    by('github-actions[bot]', `/tooling-reviewed ${OLD}`),
  ]);
  assert.deepEqual([...approved], [SHA]);
});

test('the comment an event is about counts as the event has it, so a list that lags behind it changes nothing', async () => {
  const { approvals, withEvent } = await load();
  const listed = [{ id: 1, ...by(OWNER, `/tooling-reviewed ${SHA}`) }];
  const event = (action, body) => ({ action, comment: { id: 1, ...by(OWNER, body) } });
  assert.deepEqual([...approvals(withEvent(listed, event('deleted', `/tooling-reviewed ${SHA}`)))], [], 'deleted');
  assert.deepEqual([...approvals(withEvent(listed, event('edited', 'Not yet.')))], [], 'edited away');
  assert.deepEqual([...approvals(withEvent([], event('created', `/tooling-reviewed ${SHA}`)))], [SHA], 'not listed yet');
  assert.equal(withEvent(listed, { action: 'synchronize' }), listed);
});

test('an outside change that needs review passes only once the owner approves its head commit', async () => {
  const { decide } = await load();
  const outside = pr('someone', FORK);
  const files = ['package.json'];
  const denied = decide(outside, files);
  const passed = decide(outside, files, new Set([SHA]));
  assert.equal(decide(pr('dependabot[bot]'), files).state, 'success');
  assert.equal(decide(outside, []).state, 'success');
  assert.equal(denied.state, 'failure');
  assert.equal(decide(outside, files, new Set([OLD])).state, 'failure', 'an earlier commit was approved');
  assert.equal(passed.state, 'success');
  assert.equal(passed.approved, true, 'a pass from an approval is checked again after it posts');
  assert.ok(!decide(outside, []).approved && !decide(pr('dependabot[bot]'), files).approved);
  for (const verdict of [denied, passed]) assert.ok(verdict.description.length <= 140, 'GitHub caps a status description at 140 characters');
});

test('the comment neutralizes and shortens file names, caps its list, and names no commit to approve', async () => {
  const { commentBody } = await load();
  const body = commentBody(['a`b\n\u202e\u200b.md', 'x\u00ad\u{e0041}.md', 'x'.repeat(300)]);
  assert.match(body, /^<!-- outside-pr-guard -->\n/);
  assert.ok(body.includes('- `a?b???.md`'), body);
  assert.ok(body.includes('- `x??.md`'), 'a soft hyphen and a tag character');
  assert.ok(body.includes(`- \`${'x'.repeat(200)}...\``), 'long names are cut');
  assert.ok(body.includes('`/tooling-reviewed <full SHA>`'), body);
  assert.doesNotMatch(body, /[0-9a-f]{40}/, 'the head can move during a review, so the SHA comes from the commit the owner read');
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
  assert.equal(yml.match(/^ {4}if: (.*)$/m)?.[1],
    `github.event_name == 'pull_request_target' || (github.event.issue.pull_request && github.event.comment.user.login == '${OWNER}')`,
    'a prefilter stricter than relevant() would skip runs it needs, such as an approval taken back');
});
