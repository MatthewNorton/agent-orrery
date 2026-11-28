// @ts-check
// Breakwater, the drydock that flies the Flagship rank with four Petrels parked on its berths: what
// the app needs to know about the model that its converted source (source/, written by
// scripts/import-ship.mjs) does not say itself.
'use strict';

(function () {
  const AUR = window.AUR;
  const use = AUR.useShipModule;
  const petrel = AUR.shipModels.model('petrel');
  // Its axis is Y and its landing decks lie at Y = 0, so it flies deck up as a ship does, its north
  // berth as its nose. Across two opposite berths' beacons in the model's units, its longest side.
  const SPAN = 54.39;

  AUR.shipModels.register({
    id: 'breakwater',
    // As wide as the fleet shows its Flagship long.
    replaces: [{ hull: 'aur-ark-carrier-v3', size: 1.9 }],
    correction: { scale: 1 / SPAN, offset: [0, 0, 0] },
    // Its work lights are lamps in the ship color, and the Petrels parked on it wear the trim they
    // fly in. Its windows keep the warm rooms the art lights behind them.
    trim: { ...petrel.trim, 'Work lights': AUR.shipModels.TRIM_LIGHT },
    build: (scene) => use('breakwater/yard').createDrydock(scene).root,
    // The yard was finished under the probe its Petrels reflect.
    probe: petrel.probe,
    // A yard has no drive of its own: it trails no plume.
    nozzles: () => [],
  });
})();
