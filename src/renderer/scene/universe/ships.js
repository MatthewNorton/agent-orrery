// scene/universe/ships.js — ships on the universe map: each one orbits its
// project's glyph, warps in on spawn and is disposed when it departs.
'use strict';

(function () {
  const AUR = window.AUR;
  const { disposeMeshAndMaterial } = AUR;

  AUR.sceneParts.universe.ships = function (view) {
    const { scene, glyphs, ships } = view;
    const tmp = new BABYLON.Vector3();

    function buildShip(s) {
      const g = glyphs.get(s.project);
      const tint = AUR.shipTint(s.id, s.provider);
      const signal = AUR.isSignalEntity(s);
      const scale = signal ? 0.64 : 1.0;
      let mesh = signal
        ? AUR.signalMarker(scene, 'usig_' + s.id, tint)
        : AUR.ships.instantiate(scene, s);
      const usedFallback = !signal && !mesh;
      if (usedFallback) mesh = AUR.dartMesh(scene, 'ushp_' + s.id, tint, scale);
      else mesh.scaling.setAll(scale);
      const provider = AUR.markShipMesh(mesh, s);
      const rand = AUR.mulberry32(AUR.fnv1a(s.id));
      const rec = {
        id: s.id, mesh, kind: s.kind, tint, providerKey: provider.key,
        r: 5 + rand() * 2.5, a: rand() * Math.PI * 2,
        speed: (AUR.MOTION.universeShipOrbitMin +
          rand() * AUR.MOTION.universeShipOrbitRange) * (rand() > 0.5 ? 1 : -1),
        bob: rand() * Math.PI * 2, born: performance.now(),
      };
      mesh.parent = g.root;
      if (usedFallback) AUR.ships.upgrade(scene, s, mesh, scale);
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
      for (const r of ships.values()) {
        r.a += r.speed * dt;
        tmp.set(
          Math.cos(r.a) * r.r,
          Math.sin(r.bob + t * AUR.MOTION.universeShipBobRate) * AUR.MOTION.universeShipBobAmount,
          Math.sin(r.a) * r.r
        );
        r.mesh.position.copyFrom(tmp);
        r.mesh.rotation.y = -r.a + (r.speed < 0 ? Math.PI : 0);
        // warp-in grow
        const age = (now - r.born) / 900;
        if (age < 1) r.mesh.scaling.setAll(0.3 + 0.7 * age);
      }
    }

    return { buildShip, removeShip, animateShips };
  };
})();
