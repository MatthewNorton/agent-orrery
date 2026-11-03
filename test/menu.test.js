'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installAppMenu } = require('../src/main/menu');

function fakeElectron() {
  const calls = { template: null, set: null, about: null };
  const Menu = {
    buildFromTemplate(template) { calls.template = template; return { template }; },
    setApplicationMenu(menu) { calls.set = menu; },
  };
  const app = {
    getVersion: () => '9.9.9',
    setAboutPanelOptions(options) { calls.about = options; },
  };
  return { Menu, app, calls };
}

function accelerators(template, role) {
  const out = [];
  for (const item of template) {
    if (item.role === role && item.accelerator) out.push(item.accelerator);
    if (Array.isArray(item.submenu)) out.push(...accelerators(item.submenu, role));
  }
  return out;
}

test('zoom keys: in on Ctrl+= and the keypad, out on Ctrl+-, reset on Ctrl+0', () => {
  const { Menu, app, calls } = fakeElectron();
  installAppMenu({ Menu, app });
  assert.ok(calls.set && calls.set.template === calls.template);
  const zoomIn = accelerators(calls.template, 'zoomIn');
  assert.ok(zoomIn.includes('CommandOrControl+='));
  assert.ok(zoomIn.includes('CommandOrControl+numadd'));
  assert.ok(accelerators(calls.template, 'zoomOut').includes('CommandOrControl+-'));
  assert.ok(accelerators(calls.template, 'resetZoom').includes('CommandOrControl+0'));
});

test('Help > About credits the author and the repository, as LICENSE does', () => {
  const { Menu, app, calls } = fakeElectron();
  installAppMenu({ Menu, app });
  const help = calls.template.find((item) => item.label === 'Help');
  assert.deepEqual(help.submenu.map((item) => item.role), ['about']);
  assert.equal(calls.about.applicationName, 'Agent Orrery');
  assert.equal(calls.about.applicationVersion, '9.9.9');
  const license = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');
  assert.ok(license.includes(calls.about.copyright), 'the About copyright matches LICENSE');
  assert.ok(license.includes(calls.about.credits), 'LICENSE carries the repository link');
});
