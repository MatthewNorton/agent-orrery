// @ts-check
'use strict';

// The live event stream. An event takes its seq when it is queued, so call order is event
// order; the batch goes out on the next flush (once per scan, poll or sweep).

/**
 * @import { FeedEntry, FeedKind } from '../../types/contract'
 * @import { LiveModel } from '../../types/live-model'
 */

const FEED_LIMIT = 60;

/**
 * @param {LiveModel} model
 * @param {any} event
 */
function queue(model, event) {
  event.seq = ++model.eventSequence;
  model.pending.push(event);
}

/**
 * @param {LiveModel} model
 * @param {FeedKind} kind
 * @param {string} text
 * @param {string} projectId
 */
function pushFeed(model, kind, text, projectId) {
  const entry = { kind, text, project: projectId, ts: Date.now() };
  model.feed.push(entry);
  if (model.feed.length > FEED_LIMIT * 2) model.feed = model.feed.slice(-FEED_LIMIT);
  queue(model, { type: 'feed', entry });
}

/** @param {LiveModel} model */
function flush(model) {
  if (model.pending.length === 0) return;
  const batch = model.pending;
  model.pending = [];
  model.publish(batch);
}

/**
 * The feed a snapshot carries.
 * @param {LiveModel} model
 * @returns {FeedEntry[]}
 */
function recentFeed(model) {
  return model.feed.slice(-FEED_LIMIT);
}

module.exports = { FEED_LIMIT, queue, pushFeed, flush, recentFeed };
