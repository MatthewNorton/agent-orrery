'use strict';

// Every hull's nose is local +Z (the manifest's rotateY turns fleet-v2's -Z noses around), and
// lookAt aims +Z at its target. These run each view's own heading line against orbits in both
// directions; about half the ships circle clockwise, and they used to fly tail first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rendererSource } = require('./support/renderer-source');

const viewSource = (view) => rendererSource(`scene/${view}`);
function headingCode(view, pattern) {
  const match = viewSource(view).match(pattern);
  assert.ok(match, `${view} view: heading code not found`);
  return match[0];
}

const AUR = { orbitPoint(angle, radius, y, out) { return out.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius); } };
// The views aim through the shared orbit helper; the heading lines run against this copy of it.
const R = 10;
const ORBITS = [];
for (const speed of [0.3, -0.3]) for (let a = 0; a < 2 * Math.PI; a += 0.7) ORBITS.push({ a, speed });
// The orbit is x = cos a, z = sin a; a grows when speed > 0.
const along = ({ a, speed }, [x, z]) => {
  const length = Math.hypot(x, z);
  return (x * -Math.sin(a) * Math.sign(speed) + z * Math.cos(a) * Math.sign(speed)) / length;
};

test('system view: a patrolling ship faces along its orbit either way round', () => {
  const look = new Function('r', 'shipLookTarget', 'AUR',
    headingCode('system', /r\.mesh\.lookAt\(AUR\.orbitPoint\([^;]+\);/));
  for (const orbit of ORBITS) {
    const target = { set(x, y, z) { Object.assign(this, { x, z }); return this; } };
    look({ ...orbit, r: R, mesh: { lookAt() {} } }, target, AUR);
    const forward = [target.x - Math.cos(orbit.a) * R, target.z - Math.sin(orbit.a) * R];
    assert.ok(along(orbit, forward) > 0.99, `a=${orbit.a.toFixed(1)} speed=${orbit.speed}`);
  }
});

test('planet view: an orbiting ship faces along its orbit either way round', () => {
  const look = new Function('r', 'heading', 'AUR',
    headingCode('planet', /const ahead = [^;]+;\s*r\.mesh\.lookAt\(AUR\.orbitPoint\([^;]+\);/));
  const heading = { set(x, y, z) { return { x, y, z }; } };
  for (const orbit of ORBITS) {
    let target = null;
    look({ ...orbit, r: R, yoff: 0, mesh: { lookAt: (v) => { target = v; } } }, heading, AUR);
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
