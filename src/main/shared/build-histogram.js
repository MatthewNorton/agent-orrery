// @ts-check
'use strict';

// Builds per half hour for the current local day: 48 bins that start over at midnight.
// The live model counts every verified edit into it; the renderer draws it under the timeline.

const BINS = 48;
const HALF_HOUR = 30 * 60 * 1000;

/** @typedef {{ day: number, bins: number[] }} BuildHistogram */

/** @param {number} ts */
function dayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * @param {number} now
 * @returns {BuildHistogram}
 */
function createHistogram(now) {
  return { day: dayStart(now), bins: new Array(BINS).fill(0) };
}

/**
 * Counts one build at `ts`. A build from a later day starts that day; one from an earlier day is ignored.
 * @param {BuildHistogram} h
 * @param {number} ts
 * @returns {boolean} whether the build landed in a bin
 */
function countBuild(h, ts) {
  if (!Number.isFinite(ts)) return false;
  const start = dayStart(ts);
  if (start > h.day) { h.day = start; h.bins.fill(0); }
  else if (start < h.day) return false;
  const index = Math.min(BINS - 1, Math.max(0, Math.floor((ts - h.day) / HALF_HOUR)));
  h.bins[index] += 1;
  return true;
}

/**
 * A copy for the snapshot, rolled forward to `now` so a quiet new day reads as empty.
 * @param {BuildHistogram} h
 * @param {number} now
 * @returns {BuildHistogram}
 */
function snapshotHistogram(h, now) {
  const start = dayStart(now);
  if (start > h.day) { h.day = start; h.bins.fill(0); }
  return { day: h.day, bins: h.bins.slice() };
}

module.exports = { BINS, HALF_HOUR, dayStart, createHistogram, countBuild, snapshotHistogram };
