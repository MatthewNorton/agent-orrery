// @ts-check
'use strict';

// The application menu. It stays hidden (autoHideMenuBar) and exists for its accelerators and
// Help > About. Electron's default zoom-in binding is Ctrl+Plus, which Windows keyboards never
// produce, so zoom in is bound to the keys people actually press.

const APP_NAME = 'Agent Orrery';
const REPO_URL = 'https://github.com/MatthewNorton/agent-orrery';

/** @param {Pick<typeof import('electron'), 'Menu' | 'app'>} [electron] */
function installAppMenu(electron = require('electron')) {
  const { Menu, app } = electron;
  // Named explicitly: unpackaged, the panel would show the package name, or Electron's on macOS.
  // The credits line shows on macOS and Windows, the website on Linux.
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Copyright (c) 2026 Matt Norton',
    credits: REPO_URL,
    website: REPO_URL,
  });
  const hidden = (role, accelerator) => ({ role, accelerator, visible: false });
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom', accelerator: 'CommandOrControl+0' },
        { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
        hidden('zoomIn', 'CommandOrControl+Plus'),
        hidden('zoomIn', 'CommandOrControl+numadd'),
        hidden('zoomIn', 'CommandOrControl+Shift+='),
        { role: 'zoomOut', accelerator: 'CommandOrControl+-' },
        hidden('zoomOut', 'CommandOrControl+numsub'),
        hidden('resetZoom', 'CommandOrControl+num0'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ role: 'about', label: `About ${APP_NAME}` }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { installAppMenu };
