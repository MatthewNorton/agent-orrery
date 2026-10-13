// @ts-check
'use strict';

// The live model's time windows and read limits.

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;   // ship visible this long after last write
const HOT_WINDOW_MS = 15 * 60 * 1000;     // only files this fresh get tailed
const READ_LIMIT_BYTES = 8 * 1024 * 1024; // most read from one file per poll
const LINE_LIMIT_BYTES = 1024 * 1024;     // longer lines are skipped, never parsed

module.exports = { ACTIVE_WINDOW_MS, HOT_WINDOW_MS, READ_LIMIT_BYTES, LINE_LIMIT_BYTES };
