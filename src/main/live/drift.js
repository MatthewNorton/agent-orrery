// @ts-check
'use strict';

// Format drift. The transcripts are the providers' own files, not a published interface: a record
// this version does not recognise is skipped, so a changed format would empty the universe without
// a word. Each tail counts the lines it read and the records its adapter recognises, the kinds it
// reads and the kinds it knows to skip (transcripts/claude.js and codex.js say which); one that has
// read DRIFT_LINES lines and recognised none raises a warning, which the feed shows and the snapshot
// keeps for the rest of the run. A Claude transcript tailed from its end at startup has its head
// counted first (live/claude-source.js).
// providers.json errors reach the viewer the same way.

const { pushFeed } = require('./events');

/** @import { LiveModel, LiveTail } from '../../types/live-model' */

const DRIFT_LINES = 40;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const PROVIDER_NAMES = /** @type {Record<string, string>} */ ({ claude: 'Claude Code', codex: 'Codex' });

/** @param {Pick<LiveTail, 'drift'>} tail */
function driftOf(tail) {
  return tail.drift || (tail.drift = { lines: 0, recognised: 0, version: null });
}

/**
 * Counts one line a tail read.
 * @param {Pick<LiveTail, 'drift'>} tail
 * @param {boolean} recognised the line held a record of a kind the adapter recognises
 */
function noteLine(tail, recognised) {
  const drift = driftOf(tail);
  drift.lines += 1;
  if (recognised) drift.recognised += 1;
}

/**
 * Remembers the provider version a record names, so a warning can quote it.
 * @param {Pick<LiveTail, 'drift'>} tail
 * @param {unknown} version
 */
function noteVersion(tail, version) {
  if (typeof version === 'string' && VERSION_RE.test(version)) driftOf(tail).version = version;
}

/**
 * Counts one line as its adapter sees it; a line that is not JSON is an unrecognised one.
 * @param {Pick<LiveTail, 'drift'>} tail
 * @param {string} line
 * @param {(record: unknown) => { known: boolean, version: string | null }} factsOf the adapter's record facts
 * @returns {any} the parsed record, or undefined when the line is not JSON
 */
function noteRecord(tail, line, factsOf) {
  let record;
  try { record = JSON.parse(line); } catch { noteLine(tail, false); return undefined; }
  const facts = factsOf(record);
  noteLine(tail, facts.known);
  noteVersion(tail, facts.version);
  return record;
}

/**
 * After a poll: a tail that has read enough and recognised nothing warns, once per provider and version.
 * @param {LiveModel} model
 * @param {Pick<LiveTail, 'provider' | 'drift'>} tail
 */
function checkDrift(model, tail) {
  const drift = tail.drift;
  if (!drift || drift.recognised > 0 || drift.lines < DRIFT_LINES) return;
  const name = PROVIDER_NAMES[tail.provider] || tail.provider;
  const seen = drift.version ? ` (${name} ${drift.version})` : '';
  warnOnce(model, `${name} writes records this version does not recognise${seen}; its sessions will not show until Agent Orrery is updated.`);
}

/**
 * A provider problem the viewer should see: once per text, in the console and the feed, and kept
 * for the snapshot. No system to jump to: the problem is the provider's, not a project's.
 * @param {LiveModel} model
 * @param {string} text
 */
function warnOnce(model, text) {
  if (model.providerWarnings.has(text)) return;
  model.providerWarnings.add(text);
  console.warn(`[providers] ${text}`);
  pushFeed(model, 'warning', text, '');
}

module.exports = { DRIFT_LINES, noteLine, noteVersion, noteRecord, checkDrift, warnOnce };
