'use strict';

const { trustedMainFrame: isTrustedMainFrame } = require('../window-security');
const { RENDERER_ENTRY_URL } = require('../window');
const { validProjectId } = require('../shared/ids');

function trustedMainFrame(ctx, event) {
  return isTrustedMainFrame(event, ctx.win, RENDERER_ENTRY_URL);
}

module.exports = { validProjectId, trustedMainFrame };
