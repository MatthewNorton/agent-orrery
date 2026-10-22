// @ts-check
'use strict';

const { trustedMainFrame: isTrustedMainFrame } = require('../window-security');
const { RENDERER_ENTRY_URL } = require('../window');
const { validProjectId } = require('../shared/ids');

function trustedMainFrame(ctx, event) {
  return isTrustedMainFrame(event, ctx.win, RENDERER_ENTRY_URL);
}

// The live Tracker is what the window shows, and no history seek is crossing over.
function showingLive(ctx) {
  return Boolean(ctx.tracker) && ctx.activeSource === ctx.tracker && ctx.replay.replayBoundaryOperations === 0;
}

module.exports = { validProjectId, trustedMainFrame, showingLive };
