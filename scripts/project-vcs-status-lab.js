'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot='));
const screenshotPath = screenshotArg ? path.resolve(screenshotArg.slice('--screenshot='.length)) : null;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    show: !screenshotPath,
    backgroundColor: '#040a0f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'components', 'project-vcs-status-lab.html'));

  if (!screenshotPath) return;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, image.toPNG());
  app.quit();
});

app.on('window-all-closed', () => app.quit());
