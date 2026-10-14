'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installAppMenu } = require('../src/main/menu');

function fakeElectron() {
  const calls = { template: null, set: null };
  const Menu = {
    buildFromTemplate(template) { calls.template = template; return { template }; },
    setApplicationMenu(menu) { calls.set = menu; },
  };
  return { Menu, calls };
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
  const { Menu, calls } = fakeElectron();
  installAppMenu({ Menu });
  assert.ok(calls.set && calls.set.template === calls.template);
  const zoomIn = accelerators(calls.template, 'zoomIn');
  assert.ok(zoomIn.includes('CommandOrControl+='));
  assert.ok(zoomIn.includes('CommandOrControl+numadd'));
  assert.ok(accelerators(calls.template, 'zoomOut').includes('CommandOrControl+-'));
  assert.ok(accelerators(calls.template, 'resetZoom').includes('CommandOrControl+0'));
});
