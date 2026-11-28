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
  // The size the yard draws the Petrels on its berths at, in its own units.
  const { CUTTER_SCALE } = use('breakwater/layout');

  AUR.shipModels.register({
    id: 'breakwater',
    // Sized so a Petrel parked on a berth is as long as a Scout in flight: the yard is about seven
    // and a half Scouts across, as wide as the fleet showed its Flagship long.
    replaces: [{ hull: 'aur-ark-carrier-v3', size: SPAN * petrel.correction.scale * AUR.SCOUT_LENGTH / CUTTER_SCALE }],
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
