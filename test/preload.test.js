'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('todo removal methods invoke only their bounded IPC channels', async () => {
  const preloadPath = path.resolve(__dirname, '..', 'src', 'preload.js');
  const source = fs.readFileSync(preloadPath, 'utf8');
  const calls = [];
  let exposedName = null;
  let api = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposedName = name;
        api = value;
      },
    },
    ipcRenderer: {
      invoke(...args) {
        calls.push(args);
        return Promise.resolve({ ok: true });
      },
      on() {},
    },
  };

  vm.runInNewContext(source, {
    require(id) {
      assert.equal(id, 'electron');
      return electron;
    },
  }, { filename: preloadPath });

  assert.equal(exposedName, 'AU');
  const request = { line: 4, text: 'Manual task' };
  await api.taskRemove('project-one', request);
  await api.rootTaskRemove('123e4567-e89b-42d3-a456-426614174000');
  await api.openExternal('https://github.com/example/project');
  assert.equal(api.projectVcsStatus, undefined);
  assert.deepEqual(calls, [
    ['au:task-remove', 'project-one', request],
    ['au:root-task-remove', '123e4567-e89b-42d3-a456-426614174000'],
    ['au:open-external', 'https://github.com/example/project'],
  ]);
});
