// @ts-check
'use strict';

/** @import { LiveShip } from '../../types/live-model' */

/**
 * A ship as it enters the universe: working, nothing pending, no attention, no builds.
 * Live and history keep the same internal record; the public shapes are built from it.
 * @param {{ id: string, name: string, provider: string, project: string, kind: 'main' | 'drone',
 *   parentName?: string | null, lastEvent: number, local?: boolean }} fields
 * @returns {LiveShip}
 */
function createShipRecord({ id, name, provider, project, kind, parentName = null, lastEvent, local = false }) {
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
  };
}

module.exports = { createShipRecord };
