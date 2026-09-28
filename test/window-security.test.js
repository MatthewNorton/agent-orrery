'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const {
  rendererUrl,
  trustedMainFrame,
  hardenWebContents,
} = require('../src/main/window-security');

function fakeWindow(expectedUrl) {
  const mainFrame = { url: expectedUrl };
  const webContents = new EventEmitter();
  webContents.mainFrame = mainFrame;
  webContents.setWindowOpenHandler = (handler) => { webContents.windowOpenHandler = handler; };
  return {
    isDestroyed: () => false,
    webContents,
  };
}

test('trusts only the expected application main frame', () => {
  const expectedUrl = rendererUrl(path.resolve('src/renderer/index.html'));
  const win = fakeWindow(expectedUrl);
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };

  assert.equal(trustedMainFrame(event, win, expectedUrl), true);
  assert.equal(trustedMainFrame({ ...event, senderFrame: { url: expectedUrl } }, win, expectedUrl), false);
  win.webContents.mainFrame.url = 'https://github.com/example/project';
  assert.equal(trustedMainFrame(event, win, expectedUrl), false);
});

test('blocks navigation away from the application and denies new windows', () => {
  const expectedUrl = rendererUrl(path.resolve('src/renderer/index.html'));
  const win = fakeWindow(expectedUrl);
  hardenWebContents(win.webContents, expectedUrl);

  let prevented = false;
  win.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.com');
  assert.equal(prevented, true);
  assert.deepEqual(win.webContents.windowOpenHandler({ url: 'https://github.com/example/project' }), {
    action: 'deny',
  });
});

function hardenedSession(expectedUrl) {
  const win = fakeWindow(expectedUrl);
  const session = {};
  session.setPermissionRequestHandler = (handler) => { session.requestHandler = handler; };
  session.setPermissionCheckHandler = (handler) => { session.checkHandler = handler; };
  win.webContents.session = session;
  hardenWebContents(win.webContents, expectedUrl);
  const request = (contents, permission, details) => {
    let granted = null;
    session.requestHandler(contents, permission, (allow) => { granted = allow; }, details);
    return granted;
  };
  return { win, session, request };
}

test('allows only desktop notifications, and only for the trusted renderer main frame', () => {
  const expectedUrl = rendererUrl(path.resolve('src/renderer/index.html'));
  const { win, session, request } = hardenedSession(expectedUrl);
  // Shapes observed from Electron for a file:// page: every local file shares the
  // `file:///` origin, so the full requesting URL is what identifies the app.
  const trusted = { isMainFrame: true, requestingUrl: expectedUrl, embeddingOrigin: 'file:///' };

  assert.equal(session.checkHandler(win.webContents, 'notifications', 'file:///', trusted), true);
  assert.equal(request(win.webContents, 'notifications', trusted), true);

  const otherFile = rendererUrl(path.resolve('other.html'));
  const untrusted = [
    [win.webContents, 'file:///', { ...trusted, requestingUrl: otherFile }],
    [win.webContents, 'https://evil.example', { ...trusted, requestingUrl: 'https://evil.example/' }],
    [win.webContents, 'file:///', { ...trusted, isMainFrame: false }],
    [win.webContents, 'file:///', undefined],
    [new EventEmitter(), 'file:///', trusted],
    [null, 'file:///', trusted],
  ];
  for (const [contents, origin, details] of untrusted) {
    assert.equal(session.checkHandler(contents, 'notifications', origin, details), false);
    assert.equal(request(contents, 'notifications', details), false);
  }
});

test('denies every other web permission even for the trusted renderer', () => {
  const expectedUrl = rendererUrl(path.resolve('src/renderer/index.html'));
  const { win, session, request } = hardenedSession(expectedUrl);
  const trusted = { isMainFrame: true, requestingUrl: expectedUrl, embeddingOrigin: 'file:///' };
  for (const permission of ['geolocation', 'media', 'clipboard-read', 'midi', 'openExternal']) {
    assert.equal(session.checkHandler(win.webContents, permission, 'file:///', trusted), false, permission);
    assert.equal(request(win.webContents, permission, trusted), false, permission);
  }
});

test('renderer declares a restrictive content security policy', () => {
  const html = fs.readFileSync(path.resolve('src/renderer/index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src 'none'/);
});
