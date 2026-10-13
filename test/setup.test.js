'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'setup.mjs')).href);
const REPO = path.join(path.sep, 'repo');

// A fake machine: `present` is the set of files that exist; npm ci and install-electron add theirs.
function machine(lib, { platform = 'win32', present = [], nodeVersion = '24.1.0', argv = [], installs = true } = {}) {
  const files = new Set(present);
  const electron = lib.electronPath(REPO, platform);
  const calls = [];
  const deps = {
    root: REPO, platform, nodeVersion, argv,
    exists: (file) => files.has(file),
    run: (command, args) => {
      calls.push(['run', command, ...args]);
      if (!installs) return;
      if (args[0] === 'ci') files.add(path.join(REPO, 'node_modules', 'electron', 'package.json')).add(electron);
      if (args.includes('install-electron')) files.add(electron);
    },
    launch: (binary, cwd) => calls.push(['launch', binary, cwd]),
    log: (line) => calls.push(['log', line]),
  };
  return { deps, calls, electron, steps: () => calls.filter((c) => c[0] !== 'log') };
}

const electronPackage = path.join(REPO, 'node_modules', 'electron', 'package.json');
const windowsShortcut = (...extra) => ['run', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(REPO, 'scripts', 'windows-shortcuts.ps1'), '-Action', 'Install', ...extra];

test('a fresh Windows checkout installs dependencies, adds the shortcuts, then opens the app', async () => {
  const lib = await load();
  const m = machine(lib);
  lib.setup(m.deps);
  assert.deepEqual(m.steps(), [['run', 'npm', 'ci'], windowsShortcut(), ['launch', m.electron, REPO]]);
});

test('a checkout that is already installed skips npm', async () => {
  const lib = await load();
  const probe = machine(lib);
  const m = machine(lib, { present: [electronPackage, probe.electron] });
  lib.setup(m.deps);
  assert.deepEqual(m.steps(), [windowsShortcut(), ['launch', m.electron, REPO]]);
});

test('a skipped postinstall restores only the Electron runtime', async () => {
  const lib = await load();
  const m = machine(lib, { present: [electronPackage] });
  lib.setup(m.deps);
  assert.deepEqual(m.steps()[0], ['run', 'npm', 'exec', '--no', '--', 'install-electron']);
  assert.equal(m.steps().length, 3);
});

test('a runtime that is still missing stops before the shortcuts and the launch', async () => {
  const lib = await load();
  const m = machine(lib, { installs: false });
  assert.throws(() => lib.setup(m.deps), /Electron runtime is still missing/);
  assert.deepEqual(m.steps().map((c) => c.slice(0, 3)), [['run', 'npm', 'ci'], ['run', 'npm', 'exec']]);
});

test('--no-launch skips the app, and arguments after -- reach the Windows shortcut script', async () => {
  const lib = await load();
  const m = machine(lib, { argv: ['--no-launch', '--', '-DesktopDirectory', 'D:\\tmp\\desk'] });
  lib.setup(m.deps);
  assert.deepEqual(m.steps(), [['run', 'npm', 'ci'], windowsShortcut('-DesktopDirectory', 'D:\\tmp\\desk')]);
});

test('macOS installs the app bundle; Linux has no shortcut and is told to use npm start', async () => {
  const lib = await load();
  const mac = machine(lib, { platform: 'darwin' });
  lib.setup(mac.deps);
  assert.deepEqual(mac.steps()[1], ['run', '/bin/bash', path.join(REPO, 'scripts', 'macos-shortcuts.sh'), 'install']);
  assert.match(mac.electron, /Electron\.app[\\/]Contents[\\/]MacOS[\\/]Electron$/);

  const linux = machine(lib, { platform: 'linux' });
  lib.setup(linux.deps);
  assert.deepEqual(linux.steps(), [['run', 'npm', 'ci'], ['launch', linux.electron, REPO]]);
  assert.match(linux.calls.at(-1)[1], /npm start/);
});

test('an old Node stops before anything runs', async () => {
  const lib = await load();
  for (const version of ['20.18.0', '22.11.0']) {
    const m = machine(lib, { nodeVersion: version });
    assert.throws(() => lib.setup(m.deps), /Node\.js 22\.12 or newer/);
    assert.deepEqual(m.calls, []);
  }
  assert.equal(lib.nodeTooOld('22.12.0'), false);
  assert.equal(lib.nodeTooOld('23.0.0'), false);
});

test('the double-click files run the setup script and keep the line endings and mode they need', () => {
  const cmd = fs.readFileSync(path.join(ROOT, 'Install Agent Orrery.cmd'), 'utf8');
  const command = fs.readFileSync(path.join(ROOT, 'Install Agent Orrery.command'), 'utf8');
  assert.match(cmd, /node scripts\\setup\.mjs %\*/);
  assert.match(command, /node scripts\/setup\.mjs "\$@"/);
  assert.doesNotMatch(cmd, /^\s*if\b[^\r\n]*\(\s*$/m, 'a parenthesized block breaks when the folder path has a )');

  const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\*\.cmd\s+text eol=crlf\r?$/m);
  assert.match(attributes, /^\*\.command\s+text eol=lf\r?$/m);
  const index = spawnSync('git', ['ls-files', '-s', '--', 'Install Agent Orrery.command'], { cwd: ROOT, encoding: 'utf8' });
  if (index.status === 0 && index.stdout) assert.match(index.stdout, /^100755 /, 'Finder only runs an executable .command');
});
