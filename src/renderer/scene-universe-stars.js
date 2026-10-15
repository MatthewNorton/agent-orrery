// scene-universe-stars.js — the body of a galaxy: thousands of stars on the spiral arms its systems
// follow, a thick luminous core, and dust along the arms in the galaxy's colour. Sprites, so a
// galaxy costs two draw calls and never enters the glow pass.
'use strict';

(function () {
  const AUR = window.AUR;
  const GALAXY = window.AUR_GALAXY;

  const CORE_COLORS = ['#ffe9c4', '#ffd9a0', '#fff3dc', '#ffc98a'];
  const ARM_COLORS = ['#dfe8ff', '#ffffff', '#c9d8ff', '#f4f6ff', '#ffe6d0'];
  const NEBULA_COLOR = '#ff9fb4';

  AUR.sceneParts.universe.stars = function (view) {
    const { scene, softDisc } = view;
    const dustUrl = softDisc.getContext().canvas.toDataURL();
    // Stars want a hard point inside a short glow, not the galaxy's wide falloff.
    const starDisc = AUR.softDiscTexture(scene, [[0, 1], [0.12, 0.9], [0.35, 0.2], [1, 0]]);
    const starUrl = starDisc.getContext().canvas.toDataURL();
    starDisc.dispose();

    const pick = (rand, list) => list[Math.floor(rand() * list.length)];
    const gaussian = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

    function spriteManager(name, url, capacity, additive) {
      const manager = new BABYLON.SpriteManager(name, url, capacity, { width: 128, height: 128 }, scene);
      manager.isPickable = false;
      manager.disableDepthWrite = true;
      if (additive) manager.blendMode = BABYLON.Constants.ALPHA_ADD;
      return manager;
    }

    function sprite(manager, position, hex, alpha, size) {
      const s = new BABYLON.Sprite('star', manager);
      s.position = position;
      const c = BABYLON.Color3.FromHexString(hex);
      s.color = new BABYLON.Color4(c.r, c.g, c.b, alpha);
      s.size = size;
      return s;
    }

    // Sprites live in world space, so the galaxy's tilt and lift are applied here.
    function buildGalaxyStars(record, spec) {
      disposeGalaxyStars(record);
      const { spiral } = spec;
      const dim = spec.key === 'graveyard';
      const rand = AUR.mulberry32(AUR.fnv1a('stars:' + spec.key));
      const world = record.pivot.computeWorldMatrix(true);
      const at = (x, y, z) => BABYLON.Vector3.TransformCoordinates(new BABYLON.Vector3(x, y, z), world);
      const R = spiral.radius;
      const count = Math.round(Math.min(12000, 2000 + R * 60));

      const stars = spriteManager('galaxy-stars:' + spec.key, starUrl, count, true);
      for (let i = 0; i < count; i++) {
        // Half the stars crowd the core, half spread evenly over the disc; most trace an arm,
        // the rest fill the field between them.
        const u = rand();
        const r = Math.min(R, rand() < 0.5 ? -R * 0.3 * Math.log(1 - u) : R * Math.sqrt(u));
        const field = rand() < 0.12;
        const angle = field ? rand() * Math.PI * 2
          : GALAXY.armAngle(spiral, i % spiral.arms, r) + gaussian(rand) * (0.04 + 0.14 * (r / R));
        const y = gaussian(rand) * GALAXY.discThickness(spiral, r) * 0.8;
        const core = r < R * 0.22;
        const hex = core ? pick(rand, CORE_COLORS) : (rand() < 0.04 ? NEBULA_COLOR : pick(rand, ARM_COLORS));
        const alpha = (dim ? 0.3 : 0.8) * (0.3 + 0.7 * rand());
        const bright = rand() < 0.08;
        sprite(stars, at(Math.cos(angle) * r, y, Math.sin(angle) * r), hex, alpha,
          bright ? 0.9 + rand() * 0.9 : 0.25 + rand() * rand() * 0.7);
      }

      // The luminous core (stacked warm glows) and dust along the arms in the galaxy's own colour.
      const perArm = 48;
      const glows = spriteManager('galaxy-dust:' + spec.key, dustUrl, perArm * spiral.arms + 4, false);
      for (const [size, alpha, hex] of [[R * 0.7, 0.12, CORE_COLORS[3]], [R * 0.36, 0.26, CORE_COLORS[1]],
        [R * 0.16, 0.45, CORE_COLORS[0]], [R * 0.06, 0.7, CORE_COLORS[2]]]) {
        sprite(glows, at(0, 0, 0), hex, dim ? alpha * 0.4 : alpha, size);
      }
      for (let i = 0; i < perArm * spiral.arms; i++) {
        const r = spiral.core + (R * 0.95 - spiral.core) * ((i % perArm) + 0.5) / perArm;
        const angle = GALAXY.armAngle(spiral, i % spiral.arms, r) + gaussian(rand) * 0.08;
        const size = R * (0.06 + rand() * 0.08);
        sprite(glows, at(Math.cos(angle) * r, gaussian(rand) * 0.6, Math.sin(angle) * r),
          record.colorHex, dim ? 0.05 : 0.14, size);
      }
      record.stars = stars;
      record.dust = glows;
    }

    function disposeGalaxyStars(record) {
      if (record.stars) record.stars.dispose();
      if (record.dust) record.dust.dispose();
      record.stars = null;
      record.dust = null;
    }

    return { buildGalaxyStars, disposeGalaxyStars };
  };
})();
