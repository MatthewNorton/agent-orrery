'use strict';

// src/main/window.js: the app window, and the check that fails a test run on a renderer error.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindow } = require('../src/main/window');
const { runRenderer, settled } = require('./support/renderer-source');
const { fakeDocument, fakeElement } = require('./support/fake-dom');

// Electron with a window that loads nothing and keeps the listeners on its web contents.
function fakeElectron() {
  class BrowserWindow {
    constructor() {
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
    }
    loadFile() {}
  }
  return { app: { exit() {} }, BrowserWindow };
}

// What util.js's AUR.listen writes to the console when each of `listeners` fails, a line each as
// Chromium hands it to the main process: the console.log arguments joined by spaces.
async function listenerLines(listeners) {
  const window = {}, lines = [];
  const pageConsole = { log: (...args) => lines.push(args.join(' ')) };
  runRenderer('util.js', { window, document: fakeDocument(), console: pageConsole });
  for (const listener of listeners) {
    const node = fakeElement('button');
    window.AUR.listen(node, 'click', listener);
    assert.deepEqual(await settled(() => node.fire('click')), [], 'the failure is handled');
  }
  return lines;
}

test('a test run fails on the error of a page handler that AUR.listen logged', async (t) => {
  const lines = await listenerLines([
    () => { throw new Error('render failed'); },
    async () => { throw new Error('answer failed'); },
    () => { throw 'not an Error'; },
  ]);
  assert.equal(lines.length, 3);
  const ctx = { flags: { testMode: true }, harness: { rendererTestErrors: [], runTestMode() {} } };
  t.mock.method(console, 'log', () => {});
  const win = createWindow(ctx, fakeElectron());
  const diagnostic = '[AUR] [worlds] map workers unavailable; maps are made on the main thread at up to 1024 × 512';
  for (const message of [...lines, diagnostic]) win.webContents.emit('console-message', { level: 'info', message });
  assert.deepEqual(ctx.harness.rendererTestErrors, lines.map((line) => `info ${line}`));
});
