// @ts-check
'use strict';

/** @import { LiveShip } from '../../types/live-model' */

/**
 * A ship as it enters the universe: working, nothing pending, no attention, no builds.
 * Live and history keep the same internal record; the public shapes are built from it.
 * @param {{ id: string, name: string, provider: string, project: string, kind: 'main' | 'drone',
 *   parentName?: string | null, lastEvent: number, local?: boolean, model?: string | null }} fields
 * @returns {LiveShip}
 */
function createShipRecord({
  id, name, provider, project, kind, parentName = null, lastEvent, local = false, model = null,
}) {
  return {
    id,
    name,
    provider,
    project,
    kind,
    parentName,
    status: 'Working',
    detail: null,
    lastEvent,
    pending: new Map(),
    turnDone: false,
    attention: null,
    attentionSince: null,
    builds: 0,
    local,
    model,
  };
}

/**
 * Takes what a transcript says about a ship's model, the name and whether it is served locally,
 * from any carrier of those fields (a signal, a tail, a session's metadata, history's runtime).
 * Returns whether the ship changed. Either fact may still be unknown.
 * @param {LiveShip} ship
 * @param {{ local?: unknown, model?: unknown }} facts
 * @returns {boolean}
 */
function assignModel(ship, facts) {
  let changed = false;
  if (typeof facts.local === 'boolean' && ship.local !== facts.local) { ship.local = facts.local; changed = true; }
  if (typeof facts.model === 'string' && ship.model !== facts.model) { ship.model = facts.model; changed = true; }
  return changed;
}

module.exports = { createShipRecord, assignModel };
