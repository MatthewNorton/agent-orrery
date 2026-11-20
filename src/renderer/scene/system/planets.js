// A solar system's planets: each one's orbit ring, generated world and label, built whole or not
// at all.
'use strict';

(function () {
  const AUR = window.AUR;

  AUR.sceneParts.system.planets = function (view) {
    const { scene, gui, projectId, orbitR, planets, topNames, ringRoot } = view;

    // The planet `pd` on orbit `i`, added to the view's planets. One that cannot be finished
    // throws and leaves nothing in the scene: a ring or a globe left behind would be drawn a
    // second time when the planet is built again.
    function buildPlanet(pd, i) {
      /** @type {(() => void)[]} how to take back each thing made so far */
      const undo = [];
      try {
        const rand = AUR.mulberry32(AUR.fnv1a(projectId + ':' + pd.name));
        const r = orbitR(i);
        const ring = AUR.orbitRing(scene, r, '#9fb0e0', 0.16, 0);
        undo.push(() => ring.dispose());
        ring.parent = ringRoot;
        const dia = AUR.clamp(AUR.PLANET_DIA.min + Math.sqrt(AUR.planetWeight(pd)) * 0.18, AUR.PLANET_DIA.min, AUR.PLANET_DIA.max);
        const persistent = topNames.indexOf(pd.name) >= 0;
        const world = view.makeWorld(pd.name, dia, persistent);
        const mesh = world.globe;
        undo.push(() => mesh.dispose(false, true)); // its shells are its children; materials and maps go with it
        mesh.metadata = { planetName: pd.name, isPlanet: true, worldType: world.spec.cls };
        const a0 = rand() * Math.PI * 2;
        AUR.orbitPoint(a0, r, 0, mesh.position);

        const label = AUR.label(gui, pd.name, {
          fontSize: 12.5, weight: '600', mesh, offsetY: -(18 + dia * 5),
        });
        undo.push(() => label.dispose());
        // Hidden, not transparent: Babylon GUI still projects and draws a linked label at alpha 0.
        label.alpha = 0.95;
        label.isVisible = persistent;

        const rec = {
          name: pd.name, key: pd.key, mesh, ring, world, r, a: a0,
          speed: AUR.MOTION.systemPlanetOrbitMin +
            rand() * AUR.MOTION.systemPlanetOrbitRange,
          axialSpeed: AUR.MOTION.systemPlanetAxialMin +
            rand() * AUR.MOTION.systemPlanetAxialRange,
          dia, baseScale: 1,
          label, persistent, pulseUntil: 0, appear: 1,
        };
        planets.set(pd.name, rec);
        return rec;
      } catch (error) {
        for (const takeBack of undo.reverse()) {
          try { takeBack(); } catch (e) { AUR.log('planet part not removed', pd.name, e && e.message); }
        }
        throw error;
      }
    }

    return { buildPlanet };
  };
})();
