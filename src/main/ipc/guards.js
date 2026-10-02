'use strict';

const { trustedMainFrame: isTrustedMainFrame } = require('../window-security');
const { RENDERER_ENTRY_URL } = require('../window');

function validProjectId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function trustedMainFrame(ctx, event) {
  return isTrustedMainFrame(event, ctx.win, RENDERER_ENTRY_URL);
}

module.exports = { validProjectId, trustedMainFrame };
