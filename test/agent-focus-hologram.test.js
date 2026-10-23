'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readRenderer: renderer, rendererSource } = require('./support/renderer-source');

const styles = () => rendererSource('styles', (f) => f.endsWith('.css'));
const appLayer = () => rendererSource('app');

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
  assert.match(css, /\.agent-focus\s*\{[^}]*pointer-events:\s*none;/, 'the scene keeps the pointer; the button groups opt back in');
});

test('focused ships expose a normalized position for the navigation map', () => {
  const focus = renderer('scene/system/focus.js');

  assert.match(focus, /radiusRatio: AUR\.clamp\(Math\.hypot\(x, z\) \/ mapRadius, 0, 1\)/);
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
  const focus = renderer('scene/system/focus.js');
  const system = renderer('scene/system/view.js');

  for (const vantage of ['forward', 'starboard', 'aft', 'port']) {
    assert.match(html, new RegExp(`data-vantage="${vantage}"`));
  }
  assert.match(app, /AGENT_FOCUS_VANTAGE_STORAGE_KEY/);
  assert.match(app, /activeView\.setShipFocus\(focusSettings\(\)\)/);
  assert.match(focus, /SHIP_FOCUS_VANTAGE_YAW/);
  assert.match(focus, /BABYLON\.Vector3\.CrossToRef\(focusUp, focusForward, focusRight\)/);
  assert.match(system, /setShipFocus: view\.setShipFocus,/);
});

test('the chase camera orbits with a left drag and zooms with the wheel, through the overlay', () => {
  const focus = renderer('scene/system/focus.js');
  const system = renderer('scene/system/view.js');
  const css = styles();

  assert.match(focus, /POINTERDOWN && event\.button === 0/);
  assert.match(focus, /const sensibility = camera\.angularSensibilityX \* \(1 - camera\.inertia\)/, 'the drag feels like the system camera');
  assert.match(focus, /orbit\.yaw \+= \(event\.clientX - drag\.x\) \/ sensibility/);
  assert.match(focus, /POINTERWHEEL/);
  assert.match(focus, /shipFocus\.orbit = \{ yaw: CHASE\.yaw, pitch: CHASE\.pitch, zoom: 1 \}/, 'a chosen vantage or environment re-seats the camera');
  assert.match(system, /if \(view\.shipFocus\) \{\s*leaveHover\(\);.*\n\s*view\.orbitShipFocus\(pi\);/, 'no planet opens or lights up while a ship is followed');
  assert.match(css, /\.agent-focus-vantages\s*\{[^}]*pointer-events:\s*auto;/, 'the button groups take the pointer back');
});
