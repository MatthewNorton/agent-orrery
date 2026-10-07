'use strict';

// C0 controls, DEL and C1 controls. path-safety.js checks C0 and DEL only, on purpose.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
// RFC 4122 versions 1-8. root-tasks.js keeps its narrower 1-5 pattern: widening it would
// change which stored records load and how unknown ids fail.
const GOAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasControlChars(value) {
  return CONTROL_CHARS.test(value);
}

function validProjectId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim().length > 0 && !hasControlChars(value);
}

function validGoalId(value) {
  return typeof value === 'string' && GOAL_ID.test(value);
}

module.exports = { hasControlChars, validProjectId, validGoalId };
