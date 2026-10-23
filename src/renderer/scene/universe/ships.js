// Ships on the universe map: each one orbits its
// project's glyph, warps in on spawn and is disposed when it departs.
'use strict';

(function () {
  const AUR = window.AUR;
  const { disposeMeshAndMaterial } = AUR;

  AUR.sceneParts.universe.ships = function (view) {
    const { scene, glyphs, ships } = view;
    const SIZE = AUR.SHIP_SIZE.universe;

    function buildShip(s) {
      const g = glyphs.get(s.project);
      const { mesh, tint, providerKey, scale } = AUR.shipMesh(scene, s, 'u', SIZE);
      const rand = AUR.mulberry32(AUR.fnv1a(s.id));
      const rec = {
        id: s.id, project: s.project, mesh, glyph: g, tint, providerKey, scale,
        r: g.outerR + 0.8 + rand() * 1.5, a: rand() * Math.PI * 2, // outside the glyph's planet rings
        speed: (AUR.MOTION.universeShipOrbitMin +
          rand() * AUR.MOTION.universeShipOrbitRange) * (rand() > 0.5 ? 1 : -1),
        bob: rand() * Math.PI * 2, born: performance.now(),
      };
      mesh.parent = g.root;
      ships.set(s.id, rec);
      return rec;
    }

    function removeShip(id) {
      const r = ships.get(id);
      if (!r) return;
      if (r.mesh) disposeMeshAndMaterial(r.mesh);
      ships.delete(id);
    }

    function animateShips(dt, now, t) {
      const fit = AUR.shipFit(scene, SIZE.minPx);
      for (const r of ships.values()) {
        r.a += r.speed * dt;
        AUR.orbitPoint(r.a, r.r, Math.sin(r.bob + t * AUR.MOTION.universeShipBobRate) * AUR.MOTION.universeShipBobAmount, r.mesh.position);
        r.mesh.rotation.y = -r.a + (r.speed < 0 ? Math.PI : 0);
        // The floor is judged from the glyph the ship orbits: a few units off at map distances.
        AUR.fitShip(fit, r, r.glyph.root.absolutePosition, now);
      }
    }

    return { buildShip, removeShip, animateShips };
  };
})();
