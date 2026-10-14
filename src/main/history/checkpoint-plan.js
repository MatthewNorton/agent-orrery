// @ts-check
'use strict';

/** @import { IndexEntry } from './index-builder' */

const MAX_CHECKPOINTS = 32;
const MAX_CORRECTION_STEPS = 4096;

/**
 * Up to `count` times inside (minMs, maxMs) that split the indexed bytes evenly, taking each
 * source's bytes as spread evenly over its time range.
 * @param {IndexEntry[]} entries
 * @param {number | null} minMs
 * @param {number | null} maxMs
 * @returns {number[]}
 */
function planCheckpointTimes(entries, minMs, maxMs, count = MAX_CHECKPOINTS) {
  if (minMs === null || maxMs === null || !(maxMs - minMs > 1)) return [];
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (!(total > 0)) return [];
  const bytesBy = (time) => {
    let sum = 0;
    for (const entry of entries) {
      if (time >= entry.endMs) sum += entry.size;
      else if (time > entry.startMs) sum += (entry.size * (time - entry.startMs)) / (entry.endMs - entry.startMs);
    }
    return sum;
  };
  // bytesBy is piecewise linear, so one walk over its breakpoints finds every crossing.
  /** @type {Map<number, { slope: number, jump: number }>} */
  const changes = new Map();
  const change = (time, slope, jump) => {
    const found = changes.get(time);
    if (found) {
      found.slope += slope;
      found.jump += jump;
    } else changes.set(time, { slope, jump });
  };
  for (const entry of entries) {
    if (entry.endMs > entry.startMs) {
      const slope = entry.size / (entry.endMs - entry.startMs);
      change(entry.startMs, slope, 0);
      change(entry.endMs, -slope, 0);
    } else change(entry.startMs, 0, entry.size);
  }
  const breakpoints = Float64Array.from(changes.keys()).sort();
  let next = 0;
  let at = breakpoints[0];
  let bytes = 0;
  let slope = 0;
  const cross = () => {
    const { slope: delta, jump } = changes.get(breakpoints[next++]);
    slope += delta;
    bytes += jump;
  };
  cross();
  const times = [];
  for (let index = 1; index <= count; index++) {
    const goal = (total * index) / (count + 1);
    while (bytes < goal && next < breakpoints.length) {
      const reach = bytes + slope * (breakpoints[next] - at);
      if (reach >= goal) {
        at += (goal - bytes) / slope;
        bytes = goal;
        break;
      }
      bytes = reach;
      at = breakpoints[next];
      cross();
    }
    // The first whole millisecond at which the goal is reached, exact despite rounding above.
    // Bounded: a checkpoint is an optimisation, so a few milliseconds off is harmless.
    let time = Math.ceil(at);
    let steps = 0;
    while (time - 1 > minMs && bytesBy(time - 1) >= goal && steps++ < MAX_CORRECTION_STEPS) time--;
    while (time < maxMs && bytesBy(time) < goal && steps++ < MAX_CORRECTION_STEPS) time++;
    if (time > minMs && time < maxMs && time !== times[times.length - 1]) times.push(time);
  }
  return times;
}

module.exports = { MAX_CHECKPOINTS, planCheckpointTimes };
