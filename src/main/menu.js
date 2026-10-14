// @ts-check
'use strict';

// The application menu. It stays hidden (autoHideMenuBar) and exists for its accelerators:
// Electron's default zoom-in binding is Ctrl+Plus, which Windows keyboards never produce, so
// zoom in is bound to the keys people actually press.

/** @param {Pick<typeof import('electron'), 'Menu'>} [electron] */
function installAppMenu(electron = require('electron')) {
  const { Menu } = electron;
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { installAppMenu };
