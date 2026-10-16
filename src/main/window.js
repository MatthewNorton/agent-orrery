// @ts-check
'use strict';

const path = require('path');
const { rendererUrl, hardenWebContents } = require('./window-security');

const RENDERER_ENTRY_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_ENTRY_URL = rendererUrl(RENDERER_ENTRY_PATH);

// Electron is resolved at call time: ipc/guards.js imports RENDERER_ENTRY_URL, and
// unit tests load the ipc modules under plain Node, where the electron package throws.
/** @param {Pick<typeof import('electron'), 'app' | 'BrowserWindow'>} [electron] */
function createWindow(ctx, electron = require('electron')) {
  const { app, BrowserWindow } = electron;
  const win = new BrowserWindow({
    width: ctx.flags.providerTest || ctx.flags.historyTest || ctx.flags.controlTest ? 1200 : 1680,
    height: ctx.flags.providerTest || ctx.flags.historyTest || ctx.flags.controlTest ? 720 : 980,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: '#04050a',
    autoHideMenuBar: true,
    title: 'Agent Orrery',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Visual runners can execute from an occluded desktop session. Keep
      // their render loop alive so debug-ready can observe a completed frame.
      backgroundThrottling: !ctx.flags.testMode,
      // Test runs keep their storage in memory, so the viewer's saved preferences (graphics,
      // folded panels, focus) never shape what a gate sees.
      partition: ctx.flags.testMode ? 'orrery-test' : undefined,
    },
  });
  hardenWebContents(win.webContents, RENDERER_ENTRY_URL);

  if (ctx.flags.testMode) {
    // Register load diagnostics before navigation starts. A warm renderer can
    // finish loading while the synchronous tracker setup (ctx.start) is still
    // running; attaching these after loadFile() can miss did-finish-load and
    // leave the visual harness waiting forever.
    // Newer Electron puts level and message on the first argument; older builds pass
    // them only positionally (event, level, message).
    win.webContents.on('console-message', (...args) => {
      const d = /** @type {{ level?: string | number, message: string } | undefined} */ (
        args.find((a) => a && typeof a === 'object' && 'message' in a)
      );
      const msg = d ? `${d.level ?? ''} ${d.message}` : `${args[1] ?? ''} ${args[2] ?? ''}`;
      console.log(`[renderer] ${msg}`);
      if (/Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure/i.test(msg)) {
        ctx.harness.rendererTestErrors.push(msg);
      }
    });
    win.webContents.once('did-finish-load', () => ctx.harness.runTestMode());
    win.webContents.on('did-fail-load', (e, code, desc) => {
      console.error(`did-fail-load: ${code} ${desc}`);
      app.exit(1);
    });
  }
  win.loadFile(RENDERER_ENTRY_PATH);
  return win;
}

module.exports = { createWindow, RENDERER_ENTRY_URL };
