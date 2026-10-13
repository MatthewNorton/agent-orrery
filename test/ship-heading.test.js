'use strict';

// Every hull's nose is local +Z (the manifest's rotateY turns fleet-v2's -Z noses around), and
// lookAt aims +Z at its target. These run each view's own heading line against orbits in both
// directions; about half the ships circle clockwise, and they used to fly tail first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
// A view's source is its scene-<view>*.js files.
const viewSource = (view) => fs.readdirSync(RENDERER)
  .filter((file) => file.startsWith(`scene-${view}`) && file.endsWith('.js')).sort()
  .map((file) => fs.readFileSync(path.join(RENDERER, file), 'utf8')).join('\n');
function headingCode(view, pattern) {
  const match = viewSource(view).match(pattern);
  assert.ok(match, `${view} view: heading code not found`);
  return match[0];
}

const R = 10;
const ORBITS = [];
for (const speed of [0.3, -0.3]) for (let a = 0; a < 2 * Math.PI; a += 0.7) ORBITS.push({ a, speed });
// The orbit is x = cos a, z = sin a; a grows when speed > 0.
const along = ({ a, speed }, [x, z]) => {
  const length = Math.hypot(x, z);
  return (x * -Math.sin(a) * Math.sign(speed) + z * Math.cos(a) * Math.sign(speed)) / length;
};

test('system view: a patrolling ship faces along its orbit either way round', () => {
  const look = new Function('r', 'shipLookTarget',
    headingCode('system', /shipLookTarget\.set\([^;]+\);/));
  for (const orbit of ORBITS) {
    const target = { set(x, y, z) { Object.assign(this, { x, z }); } };
    look({ ...orbit, r: R }, target);
    const forward = [target.x - Math.cos(orbit.a) * R, target.z - Math.sin(orbit.a) * R];
    assert.ok(along(orbit, forward) > 0.99, `a=${orbit.a.toFixed(1)} speed=${orbit.speed}`);
  }
});

test('planet view: an orbiting ship faces along its orbit either way round', () => {
  const look = new Function('r', 'BABYLON',
    headingCode('planet', /r\.mesh\.lookAt\(new BABYLON\.Vector3\([\s\S]*?\)\);/));
  const BABYLON = { Vector3: function Vector3(x, y, z) { Object.assign(this, { x, y, z }); } };
  for (const orbit of ORBITS) {
    let target = null;
    look({ ...orbit, r: R, yoff: 0, mesh: { lookAt: (v) => { target = v; } } }, BABYLON);
    const forward = [target.x - Math.cos(orbit.a) * R, target.z - Math.sin(orbit.a) * R];
    assert.ok(along(orbit, forward) > 0.99, `a=${orbit.a.toFixed(1)} speed=${orbit.speed}`);
  }
});

test('universe view: a ship faces along its orbit either way round, not out from the star', () => {
  const turn = new Function('r', headingCode('universe', /r\.mesh\.rotation\.y = [^;]+;/));
  for (const orbit of ORBITS) {
    const r = { ...orbit, mesh: { rotation: {} } };
    turn(r);
    // Babylon's left-handed rotation about Y takes local +Z to (sin y, 0, cos y).
    const y = r.mesh.rotation.y;
    assert.ok(along(orbit, [Math.sin(y), Math.cos(y)]) > 0.99, `a=${orbit.a.toFixed(1)} speed=${orbit.speed}`);
  }
});
