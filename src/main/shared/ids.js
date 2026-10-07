'use strict';

// C0 controls, DEL and C1 controls. path-safety.js checks C0 and DEL only, on purpose.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function hasControlChars(value) {
  return CONTROL_CHARS.test(value);
}

function validProjectId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim().length > 0 && !hasControlChars(value);
}

module.exports = { hasControlChars, validProjectId };
