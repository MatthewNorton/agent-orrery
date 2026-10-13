// @ts-check
'use strict';

// Needs-attention: a ship waiting on the user (question, permission), one that may be stuck,
// and one that finished its turn. The renderer raises the desktop notifications.

const { liveShip } = require('../universe/public-shape');
const { queue, pushFeed } = require('./events');

/**
 * @import { Attention } from '../../types/contract'
 * @import { LiveModel, LiveShip } from '../../types/live-model'
 */

const QUESTION_PENDING_MS = 2_000;
const FAST_PENDING_MS = 10_000;
const SLOW_PENDING_MS = 180_000;
const DONE_QUIET_MS = 10_000;
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const LONG_TOOLS = new Set([
  'Bash', 'PowerShell', 'BashOutput', 'TaskOutput', 'Agent', 'Task',
  'Workflow', 'WebFetch', 'WebSearch', 'Monitor',
]);

/**
 * @param {Pick<LiveShip, 'kind' | 'pending' | 'turnDone' | 'lastEvent'>} ship
 * @param {number} now
 * @returns {Attention | null}
 */
function classifyAttention(ship, now) {
  if (ship.kind === 'drone') return null;

  for (const pending of ship.pending.values()) {
    if (ASK_TOOLS.has(pending.tool) && now - pending.ts >= QUESTION_PENDING_MS) {
      return 'question';
    }
  }
  for (const pending of ship.pending.values()) {
    if (!LONG_TOOLS.has(pending.tool) && now - pending.ts >= FAST_PENDING_MS) {
      return 'permission';
    }
  }
  for (const pending of ship.pending.values()) {
    if (now - pending.ts >= SLOW_PENDING_MS) return 'stalled';
  }
  if (ship.pending.size === 0 && ship.turnDone === true && now - ship.lastEvent >= DONE_QUIET_MS) {
    return 'done';
  }
  return null;
}

/**
 * Re-classifies every ship; a change is announced once, and a new attention also in the feed.
 * @param {LiveModel} model
 * @param {number} now
 */
function evaluateAttention(model, now) {
  for (const ship of model.ships.values()) {
    const next = classifyAttention(ship, now);
    if (next === ship.attention) continue;

    ship.attention = next;
    ship.attentionSince = next ? now : null;
    queue(model, { type: 'ship-updated', ship: liveShip(ship) });

    if (!next) continue;
    const project = model.projects.get(ship.project);
    const projectName = project ? project.name : ship.project;
    if (next === 'question') {
      pushFeed(model, 'attention', `${ship.name} is asking you something in ${projectName}`, ship.project);
    } else if (next === 'permission') {
      pushFeed(model, 'attention', `${ship.name} needs permission in ${projectName}`, ship.project);
    } else if (next === 'stalled') {
      pushFeed(model, 'info', `${ship.name} may be stuck in ${projectName}`, ship.project);
    } else if (next === 'done') {
      pushFeed(model, 'done', `${ship.name} finished its task in ${projectName}`, ship.project);
    }
  }
}

module.exports = { classifyAttention, evaluateAttention };
