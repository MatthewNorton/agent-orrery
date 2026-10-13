// @ts-check
'use strict';

// Signal ships: files in the folders providers.json watches dock a ship from their stat alone.
// Their contents are never read.

const { canonicalProjectPath, readGenericWatchConfig } = require('../provider-adapters');
const { hex8 } = require('../shared/hash');
const { signalSources, watchedFiles } = require('../signal-sources');
const { liveShip } = require('../universe/public-shape');
const { queue, pushFeed } = require('./events');
const { ACTIVE_WINDOW_MS, HOT_WINDOW_MS } = require('./model');
const { ensureProjectForPath } = require('./projects');
const { ensureProviderShip } = require('./ships');

/** @import { LiveModel } from '../../types/live-model' */

/**
 * @param {LiveModel} model
 * @param {boolean} isStartup
 */
function scanSignals(model, isStartup) {
  const config = readGenericWatchConfig(model.providerConfigPath);
  for (const warning of config.warnings || []) {
    if (model.providerWarnings.has(warning)) continue;
    model.providerWarnings.add(warning);
    console.warn(`[providers] ${warning}`);
  }
  const now = Date.now();
  const seenFiles = new Set();
  for (const source of signalSources(config.watch || [])) {
    // Security follow-up: a UNC/device projectPath has no project key; skip it instead of fnv1a(null).
    const projectKey = canonicalProjectPath(source.projectPath);
    if (!projectKey) continue;
    for (const { fp, st } of watchedFiles(source)) {
      seenFiles.add(fp);
      const project = ensureProjectForPath(model, source.projectPath, `project:${hex8(projectKey)}`, st.mtimeMs, 0);
      if (!project || now - st.mtimeMs > HOT_WINDOW_MS) continue;
      const previous = model.signalFiles.get(fp);
      // Security follow-up: a POSIX file name containing `\` has no canonical key; hash the raw path instead.
      const sessionId = `${source.id}:${hex8(canonicalProjectPath(fp) || fp)}`;
      const changed = !previous || previous.size !== st.size || previous.mtimeMs !== st.mtimeMs;
      model.signalFiles.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sessionId });
      // sweepShips departs a ship idle past the active window; docking one here would flap.
      if (now - st.mtimeMs > ACTIVE_WINDOW_MS) continue;
      const ship = ensureProviderShip(model, 'signal', project.id, sessionId, 'main', st.mtimeMs, null);
      if (!isStartup && changed) {
        ship.lastEvent = Math.max(ship.lastEvent, st.mtimeMs);
        ship.status = 'Working';
        ship.detail = null;
        queue(model, { type: 'ship-updated', ship: liveShip(ship) });
        queue(model, {
          type: 'activity', project: project.id, shipId: ship.id,
          tool: 'signal', status: 'Working', detail: null, ts: st.mtimeMs,
        });
      }
    }
  }
  for (const [fp, previous] of model.signalFiles) {
    if (seenFiles.has(fp)) continue;
    model.signalFiles.delete(fp);
    const shipId = `ship:generic:${previous.sessionId}`;
    const ship = model.ships.get(shipId);
    if (!ship) continue;
    model.ships.delete(shipId);
    queue(model, { type: 'ship-departed', shipId, ts: now });
    pushFeed(model, 'depart', `${ship.name} signal disappeared`, ship.project);
  }
}

module.exports = { scanSignals };
