'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTasksIpc } = require('../src/main/ipc/tasks');
const { createTerminalIpc } = require('../src/main/ipc/terminal');
const {
  fakeCtx, fakeTracker, liveProject, tempDir, trustedEvent, untrustedEvent,
} = require('./support/main-wiring');

function fakeTaskRuns() {
  const calls = [];
  return {
    calls,
    reconcile(projectId, items) { calls.push(['reconcile', projectId, items.map((item) => item.text)]); },
    decorate(projectId, items) {
      calls.push(['decorate', projectId]);
      return items.map((item) => ({ ...item, agentStatus: 'agent-working' }));
    },
  };
}

function tasksCtx(t, { taskRuns = null } = {}) {
  const dir = tempDir(t, 'au-ipc-tasks-');
  const ctx = fakeCtx({ tracker: fakeTracker({ projects: [liveProject('alpha', dir)] }), taskRuns });
  ctx.activeSource = ctx.tracker;
  ctx.ipc.terminal = createTerminalIpc(ctx);
  const tasks = createTasksIpc(ctx);
  return { ctx, tasks, dir, goalsPath: path.join(dir, 'GOALS.md'), event: trustedEvent(ctx.win) };
}

const FAILED = { ok: false, items: [] };

test('reads GOALS.md from the live project root, absent or present', (t) => {
  const { tasks, goalsPath, event } = tasksCtx(t);
  assert.deepEqual(tasks.handleTasksGet(event, 'alpha'), { exists: false, path: goalsPath, items: [] });

  fs.writeFileSync(goalsPath, '# Goals\n\n- [ ] first\n- [x] second\n');
  const snapshot = tasks.handleTasksGet(event, 'alpha');
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.path, goalsPath);
  assert.deepEqual(snapshot.items.map(({ text, done, line }) => ({ text, done, line })), [
    { text: 'first', done: false, line: 2 },
    { text: 'second', done: true, line: 3 },
  ]);
});

test('add, set-done and remove round-trip through the file', (t) => {
  const { tasks, goalsPath, event } = tasksCtx(t);
  const added = tasks.handleTaskAdd(event, 'alpha', 'write the tests');
  assert.equal(added.ok, true);
  assert.deepEqual(added.items.map((item) => item.text), ['write the tests']);
  assert.match(fs.readFileSync(goalsPath, 'utf8'), /- \[ \] write the tests/);

  const { line } = added.items[0];
  const done = tasks.handleTaskSetDone(event, 'alpha', { line, text: 'write the tests', done: true });
  assert.equal(done.ok, true);
  assert.equal(done.items[0].done, true);
  assert.match(fs.readFileSync(goalsPath, 'utf8'), /- \[x\] write the tests/);

  const removed = tasks.handleTaskRemove(event, 'alpha', { line, text: 'write the tests' });
  assert.deepEqual(removed, { ok: true, items: [] });
  assert.doesNotMatch(fs.readFileSync(goalsPath, 'utf8'), /write the tests/);
});

test('every handler is LIVE-only and refuses untrusted frames, bad ids and missing roots', (t) => {
  const { ctx, tasks, goalsPath, event } = tasksCtx(t);
  const denials = [
    ['untrusted frame', [untrustedEvent(ctx.win), 'alpha']],
    ['invalid id', [event, 'bad\u0000id']],
    ['unknown project', [event, 'beta']],
    ['replay mode', [event, 'alpha'], () => { ctx.activeSource = ctx.replaySource; }],
    ['seek in flight', [event, 'alpha'], () => {
      ctx.activeSource = ctx.tracker;
      ctx.replay.replayBoundaryOperations = 1;
    }],
    ['project missing on disk', [event, 'alpha'], () => {
      ctx.replay.replayBoundaryOperations = 0;
      ctx.tracker.projects.get('alpha').exists = false;
    }],
  ];
  for (const [label, args, arrange = () => {}] of denials) {
    arrange();
    assert.equal(tasks.handleTasksGet(...args), null, label);
    assert.deepEqual(tasks.handleTaskAdd(...args, 'new goal'), FAILED, label);
    assert.deepEqual(tasks.handleTaskSetDone(...args, { line: 0, text: 'new goal', done: true }), FAILED, label);
    assert.deepEqual(tasks.handleTaskRemove(...args, { line: 0, text: 'new goal' }), FAILED, label);
  }
  assert.equal(fs.existsSync(goalsPath), false, 'no denied call touched the file');
});

test('goal-file errors become a plain failure instead of throwing', (t) => {
  const { tasks, goalsPath, event } = tasksCtx(t);
  assert.deepEqual(tasks.handleTaskAdd(event, 'alpha', '   '), FAILED);
  assert.deepEqual(tasks.handleTaskSetDone(event, 'alpha', { line: 0, text: 'absent', done: true }), FAILED);
  assert.deepEqual(tasks.handleTaskRemove(event, 'alpha', { line: 'x', text: 'absent' }), FAILED);
  fs.mkdirSync(goalsPath);
  assert.equal(tasks.handleTasksGet(event, 'alpha'), null, 'GOALS.md that is a directory');
});

test('task runs reconcile on reads and successful writes, and decorate what is returned', (t) => {
  const taskRuns = fakeTaskRuns();
  const { tasks, event } = tasksCtx(t, { taskRuns });
  const added = tasks.handleTaskAdd(event, 'alpha', 'tracked');
  assert.deepEqual(added.items.map((item) => item.agentStatus), ['agent-working']);
  const snapshot = tasks.handleTasksGet(event, 'alpha');
  assert.deepEqual(snapshot.items.map((item) => item.agentStatus), ['agent-working']);
  assert.deepEqual(taskRuns.calls, [
    ['reconcile', 'alpha', ['tracked']], ['decorate', 'alpha'],
    ['reconcile', 'alpha', ['tracked']], ['decorate', 'alpha'],
  ]);

  taskRuns.calls.length = 0;
  assert.deepEqual(tasks.handleTaskAdd(event, 'alpha', ''), FAILED);
  assert.deepEqual(taskRuns.calls, [], 'a failed write reconciles nothing');
});
