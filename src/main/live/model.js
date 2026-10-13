// @ts-check
'use strict';

// The live model's time windows.

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;   // ship visible this long after last write
const HOT_WINDOW_MS = 15 * 60 * 1000;     // only files this fresh get tailed

module.exports = { ACTIVE_WINDOW_MS, HOT_WINDOW_MS };
