'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

function rendererUrl(entryPath) {
  return typeof entryPath === 'string' && path.isAbsolute(entryPath)
    ? pathToFileURL(path.normalize(entryPath)).href
    : null;
}

function trustedMainFrame(event, browserWindow, expectedUrl) {
  return Boolean(
    browserWindow && !browserWindow.isDestroyed() && event &&
    event.sender === browserWindow.webContents && event.senderFrame &&
    event.senderFrame === browserWindow.webContents.mainFrame &&
    event.senderFrame.url === expectedUrl
  );
}

function hardenWebContents(webContents, expectedUrl) {
  if (!webContents || typeof webContents.on !== 'function' ||
      typeof webContents.setWindowOpenHandler !== 'function' || !expectedUrl) {
    throw new TypeError('window security requires web contents and an expected URL');
  }
  webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== expectedUrl && event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  });
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The renderer is fully offline and uses no device or web-platform permissions
  // except desktop notifications for attention alerts. Deny everything else instead
  // of relying on Electron's permissive default.
  // Security follow-up: allow `notifications` only for the trusted renderer page in
  // its own main frame. Every local file shares the `file:///` origin, so the full
  // requesting URL (not the origin) is what identifies the app.
  const trustedNotification = (contents, permission, details) => Boolean(
    permission === 'notifications' && contents && contents === webContents &&
    details && details.isMainFrame === true && details.requestingUrl === expectedUrl &&
    contents.mainFrame && contents.mainFrame.url === expectedUrl
  );
  const session = webContents.session;
  if (session && typeof session.setPermissionRequestHandler === 'function') {
    session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(trustedNotification(contents, permission, details)));
  }
  if (session && typeof session.setPermissionCheckHandler === 'function') {
    session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      trustedNotification(contents, permission, details));
  }
}

module.exports = { rendererUrl, trustedMainFrame, hardenWebContents };
