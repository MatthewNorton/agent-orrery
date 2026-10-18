'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = (name) => fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', name),
  'utf8'
);

// 2026-10-14: style.css was split into styles/*.css; grep them all.
const styles = () => fs.readdirSync(path.join(__dirname, '..', 'src', 'renderer', 'styles'))
  .filter((f) => f.endsWith('.css')).sort()
  .map((f) => renderer(path.join('styles', f))).join('\n');

// The app layer is every module under app/; grep it whole.
const appLayer = () => fs.readdirSync(path.join(__dirname, '..', 'src', 'renderer', 'app'), { recursive: true })
  .filter((f) => f.endsWith('.js')).sort()
  .map((f) => renderer(path.join('app', f))).join('\n');

test('first-person environments render a live orbital hologram', () => {
  const html = renderer('index.html');
  const app = appLayer();
  const css = styles();

  assert.match(html, /id="agent-focus-hologram-system"/);
  assert.match(html, /id="agent-focus-hologram-ship"/);
  assert.match(app, /systemPlanets\.slice\(0, 7\)/);
  assert.match(app, /agent-focus-hologram-orbit/);
  assert.match(app, /renderAgentFocusNavigationMap/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(css, /agent-focus-hologram-belt/);
  assert.match(css, /agent-focus-hologram-ship/);
  assert.match(css, /\.agent-focus\s*\{[^}]*pointer-events:\s*auto;/);
});

test('focused ships expose a normalized position for the navigation map', () => {
  const system = renderer('scene/system/view.js');

  assert.match(system, /radiusRatio: AUR\.clamp\(Math\.hypot\(x, z\) \/ mapRadius, 0, 1\)/);
});

test('POV environment registry keeps each generated foreground distinct', () => {
  const app = appLayer();

  assert.match(app, /environment-quarters\.png/);
  assert.match(app, /environment-office\.png/);
  assert.match(app, /environment-station\.png/);
  assert.match(app, /Object\.hasOwn\(C\.AGENT_FOCUS_ENVIRONMENTS,/);
});

test('POV foreground covers the viewport without distorting its native aspect ratio', () => {
  const html = renderer('index.html');
  const css = styles();

  assert.match(html, /class="agent-focus-stage"/);
  assert.match(css, /\.agent-focus-stage\s*\{[^}]*width:\s*max\(100vw, 177\.6833vh\);/s);
  assert.match(css, /\.agent-focus-stage\s*\{[^}]*aspect-ratio:\s*1672\s*\/\s*941;/s);
  assert.match(css, /\.agent-focus-frame\s*\{[^}]*object-fit:\s*cover;/s);
  assert.doesNotMatch(css, /\.agent-focus-frame\s*\{[^}]*object-fit:\s*fill;/s);
});

test('first-person mode offers persistent ship-relative camera headings', () => {
  const html = renderer('index.html');
  const app = appLayer();
  const system = renderer('scene/system/view.js');

  for (const vantage of ['forward', 'starboard', 'aft', 'port']) {
    assert.match(html, new RegExp(`data-vantage="${vantage}"`));
  }
  assert.match(app, /AGENT_FOCUS_VANTAGE_STORAGE_KEY/);
  assert.match(app, /activeView\.setShipFocusVantage\(key\)/);
  assert.match(system, /SHIP_FOCUS_VANTAGE_YAW/);
  assert.match(system, /BABYLON\.Vector3\.CrossToRef\(focusUp, focusForward, focusRight\)/);
  assert.match(system, /setShipFocusVantage,/);
});
