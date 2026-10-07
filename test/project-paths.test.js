'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanProjectCandidates, isPathInside } = require('../src/main/project-paths');

async function withTree(directories, run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-project-paths-'));
  try {
    for (const directory of directories) {
      fs.mkdirSync(path.join(base, ...directory.split('/')), { recursive: true });
    }
    const root = path.normalize(fs.realpathSync(base));
    return await run(root, (relative) => path.join(root, ...relative.split('/')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function candidatesFor(result, projectId) {
  const entry = result.matches.find((match) => match.projectId === projectId);
  return entry ? entry.candidates : null;
}

test('matches project names and path basenames case-insensitively, breadth first', async () => {
  await withTree(['alpha', 'beta', 'one/Alpha', 'node_modules/alpha', '.hidden/alpha'],
    async (root, at) => {
      const result = await scanProjectCandidates(root, [
        { id: 'p1', name: 'Alpha' },
        { id: 'p2', path: path.join(path.parse(root).root, 'old', 'place', 'Beta') },
        { id: 'p3' },
        { id: '', name: 'alpha' },
      ]);
      assert.equal(result.root, root);
      assert.equal(result.truncated, false);
      assert.equal(result.directoriesVisited, 5);
      assert.deepEqual(result.matches, [
        { projectId: 'p1', candidates: [at('alpha'), at('one/Alpha')] },
        { projectId: 'p2', candidates: [at('beta')] },
      ]);
    });
});

test('rejects a relative or non-directory scan root', async () => {
  await assert.rejects(scanProjectCandidates('relative/root', []), TypeError);
  await withTree(['folder'], async (root, at) => {
    const file = at('folder/file.txt');
    fs.writeFileSync(file, 'x');
    await assert.rejects(scanProjectCandidates(file, []), TypeError);
  });
});

test('maxDepth accepts integers 0 to 12 and otherwise falls back to 6', async () => {
  await withTree(['l1/l2/l3/l4/l5/wanted', 'l1/l2/l3/l4/l5/l6/wanted'], async (root, at) => {
    const shallow = at('l1/l2/l3/l4/l5/wanted');
    const deep = at('l1/l2/l3/l4/l5/l6/wanted');
    const scan = async (options) => candidatesFor(
      await scanProjectCandidates(root, [{ id: 't', name: 'wanted' }], options), 't'
    );
    assert.deepEqual(await scan({}), [shallow]);
    assert.deepEqual(await scan({ maxDepth: 7 }), [shallow, deep]);
    assert.deepEqual(await scan({ maxDepth: 12 }), [shallow, deep]);
    assert.deepEqual(await scan({ maxDepth: 0 }), []);
    for (const invalid of [13, -1, 6.5, '7', Number.NaN, null]) {
      assert.deepEqual(await scan({ maxDepth: invalid }), [shallow], `maxDepth ${invalid}`);
    }
  });
});

test('candidate and directory limits fall back to defaults when out of range', async () => {
  await withTree(['a/wanted', 'b/wanted', 'c/wanted'], async (root, at) => {
    const all = [at('a/wanted'), at('b/wanted'), at('c/wanted')];
    const projects = [{ id: 't', name: 'wanted' }, { id: 'u', name: 'WANTED' }];
    const scan = (options) => scanProjectCandidates(root, projects, options);

    assert.deepEqual(candidatesFor(await scan({ maxCandidates: 2 }), 't'), all.slice(0, 2));
    for (const invalid of [0, 33, 2.5]) {
      assert.deepEqual(candidatesFor(await scan({ maxCandidates: invalid }), 't'), all);
    }

    const capped = await scan({ maxTotalCandidates: 4 });
    assert.deepEqual(candidatesFor(capped, 't'), all.slice(0, 2));
    assert.deepEqual(candidatesFor(capped, 'u'), all.slice(0, 2));
    for (const invalid of [0, 1_001]) {
      const result = await scan({ maxTotalCandidates: invalid });
      assert.deepEqual(candidatesFor(result, 'u'), all);
    }

    const single = await scan({ maxDirectories: 1 });
    assert.equal(single.directoriesVisited, 1);
    assert.equal(single.truncated, true);
    for (const invalid of [0, 100_001, 1.5]) {
      const result = await scan({ maxDirectories: invalid });
      assert.equal(result.directoriesVisited, 7);
      assert.equal(result.truncated, false);
    }

    for (const invalid of [99, 60_001]) {
      assert.equal((await scan({ maxDurationMs: invalid })).truncated, false);
    }
  });
});

test('an aborted signal stops the scan before the first directory', async () => {
  await withTree(['wanted'], async (root) => {
    const controller = new AbortController();
    controller.abort();
    const result = await scanProjectCandidates(root, [{ id: 't', name: 'wanted' }], {
      signal: controller.signal,
    });
    assert.equal(result.directoriesVisited, 0);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.matches, [{ projectId: 't', candidates: [] }]);
  });
});

test('isPathInside accepts the root itself and descendants only', () => {
  const root = path.resolve('workspace', 'project');
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, path.join(root, 'src', 'main')), true);
  assert.equal(isPathInside(root + path.sep, path.join(root, 'src')), true);
  assert.equal(isPathInside(root, path.join(root, '..', 'project-other')), false);
  assert.equal(isPathInside(root, `${root}-other`), false);
  assert.equal(isPathInside(root, path.dirname(root)), false);
  assert.equal(isPathInside(root, path.join(root, 'a', '..', '..', 'escape')), false);
});
