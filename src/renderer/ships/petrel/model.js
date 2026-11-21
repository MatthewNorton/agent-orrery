// @ts-check
// Petrel, bare as the Scout and fitted with its survey ring as the Workhorse and the Capital: what
// the app needs to know about the model that its converted source (source/, written by
// scripts/import-ship.mjs) does not say itself.
'use strict';

(function () {
  const AUR = window.AUR;
  const use = AUR.useShipModule;
  // Fin tips to nose along Z in the model's units, the middle of that span, and the survey ring's
  // diameter, the ringed ship's longest side.
  const LENGTH = 15.4;
  const MIDSHIP = 0.79;
  const RING_SPAN = 19;
  const LIGHT = AUR.shipModels.TRIM_LIGHT;
  const PANEL = 0.55;
  // The position lamps and the nozzle liners are lights in the ship color; the side inlets and
  // the wing ducts are wide, so they glow as lit panels; the hull's guide lamps take the color too.
  const TRIM = {
    'port position lamp': LIGHT, 'starboard position lamp': LIGHT, 'folded bronze nozzle liner': LIGHT,
    'burnt orange bay liner': PANEL, 'orange anodized return': PANEL, 'orange wing duct': PANEL,
    'pearl pressure hull': { lamps: '#f4ba76' },
  };
  // The survey ring's inspection rail is a row of lamps, so they take the color as well, and so do
  // the halos its map paints around them in a darker amber: lamps, halos and glow in the ship color.
  const RING_TRIM = { ...TRIM, 'amber inspection rail': { lamps: '#ffc074', halos: true } };

  /** Both ships come from the one build, the ring fitted or not. @param {boolean} ring */
  const petrel = (ring) => ({
    build(scene) {
      const ship = use('petrel/spacecraft').createPetrel(scene);
      if (ring) ship.setRing(true);
      return ship.root;
    },
    probe: (scene) => use('petrel/light-probe').createInspectionProbe(scene),
    nozzles() {
      const { DRIVE } = use('petrel/exhaust');
      return [-1, 1].map((side) => ({ position: [side * DRIVE.offset, DRIVE.y, DRIVE.lipZ], radius: 0.5 }));
    },
  });

  AUR.shipModels.register({
    id: 'petrel',
    replaces: [{ hull: 'aur-lance-interceptor-v3' }],
    correction: { scale: 1 / LENGTH, offset: [0, 0, -MIDSHIP] },
    trim: TRIM,
    ...petrel(false),
  });
  // Ringed, it flies at the fleet's Workhorse and Capital sizes: its ring as wide as those hulls are long.
  AUR.shipModels.register({
    id: 'petrel-ring',
    replaces: [{ hull: 'aur-bastion-corvette-v3', size: 1.25 }, { hull: 'aur-helix-destroyer-v3', size: 1.55 }],
    correction: { scale: 1 / RING_SPAN, offset: [0, 0, -MIDSHIP] },
    trim: RING_TRIM,
    ...petrel(true),
  });
})();
