'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'lib', 'synthetic-profile.mjs')).href);
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const HOT_WINDOW_MS = 15 * 60 * 1000;
const readLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function profileFor(t, lib, options = {}) {
  const profile = lib.createSyntheticProfile(options);
  t.after(() => fs.rmSync(profile.root, { recursive: true, force: true }));
  return profile;
}

test('profileEnv points every home and app-data variable into the profile and drops the real Signal config', async () => {
  const { profileEnv } = await load();
  const root = path.join(path.sep, 'tmp', 'synthetic');
  const base = { PATH: '/usr/bin', HOME: '/home/real', AGENT_UNIVERSE_PROVIDER_CONFIG: '/home/real/providers.json' };
  const env = profileEnv(root, base);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    assert.ok(env[key] === root || env[key].startsWith(root + path.sep), `${key}=${env[key]}`);
  }
  assert.equal(env.APPDATA, path.join(root, 'AppData', 'Roaming'));
  assert.equal(env.PATH, '/usr/bin');
  assert.equal('AGENT_UNIVERSE_PROVIDER_CONFIG' in env, false);
  assert.equal(base.HOME, '/home/real', 'base env is not mutated');
});

test('userDataDir follows Electron per platform', async () => {
  const { userDataDir } = await load();
  const root = path.join(path.sep, 'p');
  assert.equal(userDataDir(root, 'win32'), path.join(root, 'AppData', 'Roaming', 'agent-orrery'));
  assert.equal(userDataDir(root, 'darwin'), path.join(root, 'Library', 'Application Support', 'agent-orrery'));
  assert.equal(userDataDir(root, 'linux'), path.join(root, '.config', 'agent-orrery'));
});

test('isInside accepts only paths below the root', async () => {
  const { isInside } = await load();
  const root = path.join(path.sep, 'p', 'root');
  assert.equal(isInside(root, path.join(root, 'work', 'orion-api')), true);
  assert.equal(isInside(root, root), false);
  assert.equal(isInside(root, path.join(path.sep, 'p', 'rooted', 'x')), false);
  assert.equal(isInside(root, path.join(path.sep, 'home', 'real', 'project')), false);
  assert.equal(isInside(root, null), false);
});

test('editPair writes a matching tool_use / tool_result pair inside the project', async () => {
  const { editPair, FILES } = await load();
  const projectDir = path.join(path.sep, 'p', 'work', 'orion-api');
  const first = (arr) => arr[0];
  const [use, result] = editPair(projectDir, ['docs', 'src'], first, 'session-1', NOW, 'ab-b5', true)
    .trim().split('\n').map((l) => JSON.parse(l));
  const call = use.message.content[0];
  assert.equal(call.name, 'Write');
  assert.equal(call.input.file_path, path.join(projectDir, 'docs', FILES[0]));
  assert.equal(result.message.content[0].tool_use_id, call.id);
  assert.equal(Date.parse(result.timestamp) - Date.parse(use.timestamp), 700);
  assert.equal(use.cwd, projectDir);
  assert.equal(use.isSidechain, true);
  const plain = JSON.parse(editPair(projectDir, ['src'], first, 'session-1', NOW, 'ab-b0').split('\n')[0]);
  assert.equal(plain.message.content[0].name, 'Edit');
  assert.equal('isSidechain' in plain, false);
});

test('codexPatchLines reports a successful patch inside the project', async () => {
  const { codexPatchLines } = await load();
  const projectDir = path.join(path.sep, 'p', 'work', 'nebula-dashboard');
  const lines = codexPatchLines(projectDir, ['src'], (arr) => arr[0], 'patch-0', NOW).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.payload.type), ['custom_tool_call', 'patch_apply_end', 'custom_tool_call_output']);
  assert.equal(lines[1].payload.success, true);
  assert.ok(Object.keys(lines[1].payload.changes).every((file) => file.startsWith(path.join(projectDir, 'src') + path.sep)));
});

test('createSyntheticProfile builds the fictional universe with history and live sessions', async (t) => {
  const lib = await load();
  const profile = profileFor(t, lib);
  const state = JSON.parse(fs.readFileSync(profile.statePath, 'utf8'));
  const projects = Object.values(lib.GALAXIES).flat();
  assert.equal(profile.statePath, path.join(lib.userDataDir(profile.root), 'universe-state.json'));
  assert.equal(Object.keys(state.projects).length, projects.length);
  assert.deepEqual(state.projects['-work-orion-api'].buckets, { src: 48, test: 21, docs: 12, migrations: 9, scripts: 5 });

  const claudeRoot = path.join(profile.root, '.claude', 'projects');
  const liveFiles = new Set(profile.live.map((s) => s.file));
  for (const slug of fs.readdirSync(claudeRoot)) {
    for (const name of fs.readdirSync(path.join(claudeRoot, slug))) {
      const file = path.join(claudeRoot, slug, name);
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (liveFiles.has(file)) assert.ok(age < 60_000, `${name} is fresh`);
      else assert.ok(age > HOT_WINDOW_MS, `${name} is history`);
      for (const record of readLines(file)) assert.ok(lib.isInside(profile.root, record.cwd), record.cwd);
    }
  }
  assert.deepEqual(profile.live.map((s) => s.kind).sort(), ['claude', 'claude', 'claude', 'claude', 'codex']);
  assert.equal(profile.live.filter((s) => s.drone).length, 1);
  assert.equal(profile.live.filter((s) => s.attention).length, 1);
});

test('appendActivity adds parseable live lines, including a pending permission and a drone edit', async (t) => {
  const lib = await load();
  const profile = profileFor(t, lib);
  const before = new Map(profile.live.map((s) => [s.file, readLines(s.file).length]));
  profile.appendActivity(NOW);
  for (const s of profile.live) {
    const added = readLines(s.file).slice(before.get(s.file));
    assert.ok(added.length >= 2, `${s.sessionId} got new lines`);
    if (s.kind === 'codex') assert.ok(added.some((l) => l.payload.type === 'patch_apply_end' && l.payload.success));
    if (s.drone) assert.ok(added.every((l) => l.isSidechain === true));
    if (s.attention) {
      const pending = added.find((l) => l.message.content[0].name === 'Bash');
      assert.ok(pending && NOW - Date.parse(pending.timestamp) >= 10_000);
      const resolved = added.flatMap((l) => l.message.content).filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id);
      assert.equal(resolved.includes(pending.message.content[0].id), false);
    }
  }
});

test('the same seed and time build the same universe', async (t) => {
  const lib = await load();
  const a = profileFor(t, lib, { now: NOW });
  const b = profileFor(t, lib, { now: NOW });
  assert.equal(fs.readFileSync(a.statePath, 'utf8'), fs.readFileSync(b.statePath, 'utf8'));
  const scrub = (profile, file) => fs.readFileSync(file, 'utf8').split(JSON.stringify(profile.root).slice(1, -1)).join('<root>');
  const history = (profile) => path.join(profile.root, '.claude', 'projects', '-work-orion-api', '019f0000-0000-7000-8000-000000000001.jsonl');
  assert.equal(scrub(a, history(a)), scrub(b, history(b)));
});

test('dispose removes the profile and stops further appends', async (t) => {
  const lib = await load();
  const profile = profileFor(t, lib);
  profile.dispose();
  assert.equal(fs.existsSync(profile.root), false);
  assert.doesNotThrow(() => profile.appendActivity(NOW));
  await profile.streamActivity(10_000);
  assert.equal(fs.existsSync(profile.root), false);
});
