'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isLocalProjectPath, canonicalProjectPath } = require('../src/main/provider-adapters');
const { Tracker } = require('../src/main/tracker');

test('isLocalProjectPath accepts drive-rooted and POSIX-rooted paths only', () => {
  for (const ok of ['C:\\Work\\proj', 'c:/work/proj', '/Users/coder/proj', '/']) {
    assert.equal(isLocalProjectPath(ok), true, ok);
  }
  for (const bad of [
    '\\\\attacker.example.com\\share\\x', // UNC
    '//attacker.example.com/share/x', // POSIX-style UNC
    '\\\\?\\C:\\Work', // device namespace
    'C:\\\\?\\x', // drive-prefixed device namespace
    'C:relative', // drive-relative
    'relative/path',
    '/Users/coder/with\\backslash',
    '',
    'C:\\Work\0',
    'C:\\Work\nnext',
    null,
    42,
  ]) {
    assert.equal(isLocalProjectPath(bad), false, String(bad));
  }
});

test('canonicalProjectPath refuses network and device paths from transcripts', () => {
  assert.equal(canonicalProjectPath('\\\\attacker\\share\\x'), null);
  assert.equal(canonicalProjectPath('//attacker/share/x'), null);
  assert.equal(canonicalProjectPath('\\\\?\\C:\\Work'), null);
  assert.equal(canonicalProjectPath('C:\\Work\\Proj\\'), 'win:c:/work/proj');
  assert.equal(canonicalProjectPath('/Users/coder/proj/'), 'posix:/Users/coder/proj');
});

function withTempRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-path-safety-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('tracker readCwd drops a UNC cwd and never marks the project as existing', () => {
  withTempRoot((root) => {
    const claudeDir = path.join(root, 'claude', 'projects', 'evil-project');
    fs.mkdirSync(claudeDir, { recursive: true });
    const transcript = path.join(claudeDir, 'session.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'user', cwd: '\\\\127.0.0.1\\share\\x', sessionId: 'abc', timestamp: new Date().toISOString(),
    }) + '\n');
    const tracker = new Tracker(path.join(root, 'state.json'), {
      claudeProjectsDir: path.join(root, 'claude', 'projects'),
      codexSessionDirs: [],
    });
    assert.equal(tracker.readCwd(transcript), null);
    assert.equal(tracker.preferredProjectPath('any', '\\\\127.0.0.1\\share\\x'), null);
    assert.equal(tracker.preferredProjectPath('any', '//127.0.0.1/share/x'), null);
  });
});

test('getPlanet refuses traversal segments and only walks inside the project', () => {
  withTempRoot((root) => {
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'secret'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'a.js'), 'x');
    fs.writeFileSync(path.join(root, 'secret', 'b.txt'), 'y');
    const tracker = new Tracker(path.join(root, 'state.json'), {
      claudeProjectsDir: path.join(root, 'none'),
      codexSessionDirs: [],
    });
    tracker.projects.set('p1', {
      id: 'p1', path: project, name: 'project', exists: true, buckets: {}, lastActivity: 0,
      totalBytes: 0, totalBuilds: 0, firstSeen: 0,
    });
    const inside = tracker.getPlanet('p1', 'src');
    assert.equal(inside.files, 1);
    for (const evil of ['..', '../secret', '..\\secret', 'src/../../secret', '/secret', 'C:\\Windows']) {
      assert.equal(tracker.getPlanet('p1', evil), null, evil);
    }
  });
});

function isolatedTracker(root) {
  return new Tracker(path.join(root, 'state.json'), {
    claudeProjectsDir: path.join(root, 'none'),
    codexSessionDirs: [],
  });
}

test('provider session signals with a UNC, relative, or backslash POSIX cwd do not throw or create a project', () => {
  withTempRoot((root) => {
    const tracker = isolatedTracker(root);
    for (const cwd of [
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj',
      'relative/proj',
      '/home/u/with\\backslash',
    ]) {
      const tail = { provider: 'codex', session: 'session-1' };
      assert.doesNotThrow(() => tracker.applyProviderSignals([
        { type: 'session', provider: 'codex', sessionId: 'session-1', cwd, ts: 1 },
      ], tail), cwd);
      assert.equal(tail.project, undefined, cwd);
      assert.equal(tracker.projects.size, 0, cwd);
      assert.equal(tracker.ships.size, 0, cwd);
    }
  });
});

test('signal watch entries with a UNC projectPath are skipped instead of throwing', () => {
  withTempRoot((root) => {
    const watched = path.join(root, 'signals');
    fs.mkdirSync(watched);
    fs.writeFileSync(path.join(watched, 'beat.log'), 'x');
    fs.writeFileSync(path.join(root, 'providers.json'), JSON.stringify({
      watch: [{ directory: watched, projectPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj' }],
    }));
    const tracker = isolatedTracker(root);
    assert.doesNotThrow(() => tracker.scanSignals(false));
    assert.equal(tracker.projects.size, 0);
    assert.equal(tracker.ships.size, 0);
  });
});

test('ensureProjectForPath trims a leading-space cwd instead of throwing', () => {
  withTempRoot((root) => {
    const tracker = isolatedTracker(root);
    let project;
    assert.doesNotThrow(() => { project = tracker.ensureProjectForPath(' /home/u/proj', null, 1, 0); });
    assert.ok(project);
    assert.equal(project.path, '/home/u/proj');
    assert.equal(project.name, 'proj');
    assert.equal(tracker.ensureProjectForPath('/home/u/proj', null, 2, 0).id, project.id);
  });
});

test('getPlanet ignores inherited property names and returns a cloneable result', () => {
  withTempRoot((root) => {
    const tracker = isolatedTracker(root);
    tracker.projects.set('p1', {
      id: 'p1', path: null, name: 'project', exists: false, buckets: { src: 3 }, lastActivity: 0,
      totalBytes: 0, totalBuilds: 3, firstSeen: 0,
    });
    for (const name of ['constructor', '__proto__', 'toString']) {
      const planet = tracker.getPlanet('p1', name);
      assert.equal(planet.builds, 0, name);
      assert.equal(structuredClone(planet).builds, 0, name);
    }
    assert.equal(tracker.getPlanet('p1', 'src').builds, 3);
  });
});

// ---------- shared classifier: src/main/path-safety.js (kit 13, task C) ----------
const pathSafety = require('../src/main/path-safety');

test('path-safety exports the shared classifier and re-exports the project-path helpers', () => {
  for (const name of [
    'pathFlavor', 'validPathString', 'isCanonicalPath', 'isCanonicalPathFor',
    'isAbsolutePosixPath', 'isInsidePath', 'isLocalProjectPath', 'canonicalProjectPath',
  ]) {
    assert.equal(typeof pathSafety[name], 'function', name);
  }
  assert.equal(pathSafety.isLocalProjectPath, isLocalProjectPath);
  assert.equal(pathSafety.canonicalProjectPath, canonicalProjectPath);
});

test('relativeInside ignores case only under a Windows-style root and keeps the file\'s casing', () => {
  const { relativeInside, ignoresCase } = pathSafety;
  assert.equal(relativeInside('C:\\Work\\Demo', 'c:/work/demo/Docs/Guide.md', { separator: '/' }), 'Docs/Guide.md');
  assert.equal(relativeInside('c:\\work\\demo', 'C:\\WORK\\DEMO\\Src\\A.js', { separator: '\\' }), 'Src\\A.js');
  assert.equal(relativeInside('C:\\Work\\Demo', 'C:\\WORK\\Other\\x.js'), null);
  assert.equal(relativeInside('C:\\Work\\Demo', 'c:\\work\\demo'), null);
  assert.equal(relativeInside('/Work/Demo', '/Work/Demo/Docs/Guide.md', { separator: '/' }), 'Docs/Guide.md');
  assert.equal(relativeInside('/Work/Demo', '/work/demo/Docs/Guide.md'), null);
  assert.deepEqual(['C:\\Work', 'c:/work', 'relative\\dir', '/Work', null].map(ignoresCase),
    [true, true, true, false, false]);
});

test('pathFlavor names drive-rooted and POSIX paths and rejects UNC and //host/share', () => {
  const { pathFlavor } = pathSafety;
  assert.equal(pathFlavor('C:\\Work\\proj'), 'win32');
  assert.equal(pathFlavor('c:/work/proj'), 'win32');
  assert.equal(pathFlavor('/Users/coder/proj'), 'posix');
  assert.equal(pathFlavor('\\\\host\\share\\x'), null); // UNC
  assert.equal(pathFlavor('//host/share/x'), null); // POSIX-style UNC
  for (const bad of ['C:relative', 'relative/path', '', null, undefined, 42, {}]) {
    assert.equal(pathFlavor(bad), null, String(bad));
  }
});

test('validPathString bounds length and rejects NUL and control characters', () => {
  const { validPathString } = pathSafety;
  assert.equal(validPathString('C:\\Work'), true);
  assert.equal(validPathString('/' + 'a'.repeat(4095)), true);
  assert.equal(validPathString('/' + 'a'.repeat(4096)), false);
  for (const bad of ['', 'C:\\Work\0', 'C:\\Work\nnext', '/tmp/\tx', '/tmp/\u001bx', '/tmp/\u007fx', null, 7]) {
    assert.equal(validPathString(bad), false, JSON.stringify(bad));
  }
});

test('isCanonicalPath accepts only normalized absolute local paths', () => {
  const { isCanonicalPath } = pathSafety;
  for (const ok of ['C:\\Work\\proj', 'C:\\', '/Users/coder/proj']) {
    assert.equal(isCanonicalPath(ok), true, ok);
  }
  for (const bad of [
    'C:\\Work\\proj\\', // trailing separator
    '/Users/coder/proj/', // trailing separator
    'c:/work/proj', // not in win32 normalized form
    'C:\\Work\\.\\proj', // `.` segment
    'C:\\Work\\..\\proj', // `..` segment
    '/Users/coder/../proj',
    '/Users//coder',
    '\\\\host\\share\\x', // UNC
    '//host/share/x',
    'relative/path',
    'C:\\Work\0',
  ]) {
    assert.equal(isCanonicalPath(bad), false, bad);
  }
});

test('isCanonicalPathFor requires the flavor of the platform', () => {
  const { isCanonicalPathFor } = pathSafety;
  assert.equal(isCanonicalPathFor('C:\\Work', 'win32'), true);
  assert.equal(isCanonicalPathFor('C:\\Work', 'darwin'), false);
  assert.equal(isCanonicalPathFor('/Users/coder', 'darwin'), true);
  assert.equal(isCanonicalPathFor('/Users/coder', 'linux'), true);
  assert.equal(isCanonicalPathFor('/Users/coder', 'win32'), false);
  assert.equal(isCanonicalPathFor('C:\\Work\\', 'win32'), false);
});

test('isAbsolutePosixPath accepts normalized POSIX paths only', () => {
  const { isAbsolutePosixPath } = pathSafety;
  assert.equal(isAbsolutePosixPath('/Users/coder/proj'), true);
  assert.equal(isAbsolutePosixPath('/'), true);
  for (const bad of ['//host/share', 'C:\\Work', 'relative', '/Users/coder/../x', '/tmp/\0x', '']) {
    assert.equal(isAbsolutePosixPath(bad), false, bad);
  }
});

test('isInsidePath requires canonical paths of one flavor and a non-escaping relative', () => {
  const { isInsidePath } = pathSafety;
  assert.equal(isInsidePath('C:\\Work\\proj', 'C:\\Work\\proj'), true);
  assert.equal(isInsidePath('C:\\Work\\proj', 'C:\\Work\\proj\\bin\\codex.exe'), true);
  assert.equal(isInsidePath('C:\\Work\\proj', 'C:\\work\\PROJ\\bin'), true); // case folded
  assert.equal(isInsidePath('C:\\Work\\proj', 'C:\\Work\\project'), false);
  assert.equal(isInsidePath('C:\\Work\\proj', 'C:\\Work'), false);
  assert.equal(isInsidePath('C:\\Work\\proj', 'D:\\Work\\proj'), false);
  assert.equal(isInsidePath('/Users/coder/proj', '/Users/coder/proj/src'), true);
  assert.equal(isInsidePath('/Users/coder/proj', '/Users/coder/other'), false);
  // Windows-vs-POSIX mismatch never counts as inside, in either direction.
  assert.equal(isInsidePath('C:\\Work\\proj', '/Work/proj/bin'), false);
  assert.equal(isInsidePath('/Work/proj', 'C:\\Work\\proj\\bin'), false);
  // Non-canonical inputs fail closed.
  assert.equal(isInsidePath('C:\\Work\\proj\\', 'C:\\Work\\proj\\bin'), false);
  assert.equal(isInsidePath('\\\\host\\share', '\\\\host\\share\\x'), false);
});
