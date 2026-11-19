// @ts-check
// Petrel, the Scout: what the app needs to know about the model that its converted source
// (source/, written by scripts/import-ship.mjs) does not say itself.
'use strict';

(function () {
  const AUR = window.AUR;
  const use = AUR.useShipModule;
  // Fin tips to nose along Z in the model's units, and the middle of that span.
  const LENGTH = 15.4;
  const MIDSHIP = 0.79;
  const LIGHT = AUR.shipModels.TRIM_LIGHT;
  const PANEL = 0.55;

  AUR.shipModels.register({
    id: 'petrel',
    replaces: 'aur-lance-interceptor-v3',
    correction: { scale: 1 / LENGTH, offset: [0, 0, -MIDSHIP] },
    build: (scene) => use('petrel/spacecraft').createPetrel(scene).root,
    probe: (scene) => use('petrel/light-probe').createInspectionProbe(scene),
    // The position lamps and the nozzle liners are lights in the ship color; the side inlets and
    // the wing ducts are wide, so they glow as lit panels; the hull's guide lamps take the color too.
    trim: {
      'port position lamp': LIGHT, 'starboard position lamp': LIGHT, 'folded bronze nozzle liner': LIGHT,
      'burnt orange bay liner': PANEL, 'orange anodized return': PANEL, 'orange wing duct': PANEL,
      'pearl pressure hull': { lamps: '#f4ba76' },
    },
    nozzles() {
      const { DRIVE } = use('petrel/exhaust');
      return [-1, 1].map((side) => ({ position: [side * DRIVE.offset, DRIVE.y, DRIVE.lipZ], radius: 0.5 }));
    },
  });
})();
