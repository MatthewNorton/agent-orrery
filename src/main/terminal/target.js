// @ts-check
'use strict';

const path = require('node:path');
const { isLocalProjectPath } = require('../provider-adapters');

// Only tracker-owned IDs and transcript paths cross into terminal discovery.
function resolveTerminalTarget(tracker, targetId) {
  const ships = tracker?.ships instanceof Map ? tracker.ships : new Map();
  let ship = ships.get(targetId);
  if (!ship && !tracker?.projects?.has(targetId)) return { code: 'NOT_FOUND' };
  const projectId = ship ? ship.project : targetId;
  if (!ship) {
    const candidates = [...ships.values()].filter((s) => s.project === projectId && s.kind === 'main');
    if (candidates.length > 1) return { code: 'AMBIGUOUS' };
    ship = candidates[0];
    if (!ship) return [...ships.values()].some((s) => s.project === projectId)
      ? { code: 'TERMINAL_NOT_FOUND' } : { projectId };
  }
  const visited = new Set();
  while (ship.kind === 'drone') {
    if (visited.has(ship.id)) return { code: 'TERMINAL_NOT_FOUND' };
    visited.add(ship.id);
    const parents = [...ships.values()].filter((s) => s.project === projectId &&
      s.provider === ship.provider && s.name === ship.parentName);
    if (parents.length !== 1) return { code: 'TERMINAL_NOT_FOUND' };
    ship = parents[0];
  }
  for (const [transcriptPath, tail] of tracker.files || []) {
    const provider = tail.provider || 'claude';
    const id = provider === 'claude' ? `ship:${tail.project}:${tail.session}` : `ship:${provider}:${tail.session}`;
    if (id !== ship.id || tail.project !== projectId) continue;
    // Security: never let transcript data turn a local focus lookup into a network probe.
    if (!['claude', 'codex'].includes(provider) || !isLocalProjectPath(transcriptPath) ||
        !path.isAbsolute(transcriptPath)) break;
    return {
      projectId,
      session: {
        provider, sessionId: tail.session, transcriptPath,
        registryDirectory: provider === 'claude' && tracker.model?.claudeProjectsDir
          ? path.join(path.dirname(tracker.model.claudeProjectsDir), 'sessions') : null,
      },
    };
  }
  return { code: 'TERMINAL_NOT_FOUND' };
}

module.exports = { resolveTerminalTarget };
