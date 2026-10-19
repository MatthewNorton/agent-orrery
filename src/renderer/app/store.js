// @ts-check
// Renderer store: snapshot seeding, event reducer, attention alerts, hull promotions.
'use strict';

/** @import { AUEvent, Snapshot } from '../../types/contract' */

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/store.js');
  const S = A.state, C = A.const;

  /** @param {Snapshot} snap */
  A.seedStore = function seedStore(snap) {
    const h = snap && snap.buildHistogram;
    S.store.buildHistogram = h && Array.isArray(h.bins) && h.bins.length === 48 && h.bins.every(Number.isFinite)
      ? { day: h.day, bins: h.bins.slice() } : null;
    S.store.projects.clear();
    S.store.ships.clear();
    S.store.feed = [];
    if (snap && Array.isArray(snap.projects)) {
      for (const p of snap.projects) S.store.projects.set(p.id, p);
    }
    if (snap && Array.isArray(snap.ships)) {
      for (const s of snap.ships) S.store.ships.set(s.id, s);
    }
    if (snap && Array.isArray(snap.feed)) {
      S.store.feed = snap.feed.slice(-C.FEED_CAP);
    }
  };

  /** @param {AUEvent} ev */
  A.applyEvent = function applyEvent(ev) {
    switch (ev.type) {
      case 'project-added':
      case 'project-updated':
        S.store.projects.set(ev.project.id, ev.project);
        break;
      case 'ship-spawned':
        S.store.ships.set(ev.ship.id, ev.ship);
        break;
      case 'ship-updated': {
        const previous = S.store.ships.get(ev.ship.id);
        maybeNotifyAttention(previous ? previous.attention : null, ev.ship);
        S.store.ships.set(ev.ship.id, ev.ship);
        break;
      }
      case 'ship-departed':
        S.store.ships.delete(ev.shipId);
        S.notificationByShip.delete(ev.shipId);
        break;
      case 'feed':
        S.store.feed.push(ev.entry);
        if (S.store.feed.length > C.FEED_CAP) S.store.feed = S.store.feed.slice(-C.FEED_CAP);
        break;
      case 'build': {
        const p = S.store.projects.get(ev.project);
        if (p) p.totalBuilds = (p.totalBuilds || 0) + 1;
        // A ship-updated can precede the build it reports (and Codex patches
        // send none), so the stored count follows build events too.
        const ship = S.store.ships.get(ev.shipId);
        if (ship) S.store.ships.set(ship.id, { ...ship, builds: (ship.builds || 0) + 1 });
        // Same binning as src/main/shared/build-histogram.js: half hours of the snapshot's day.
        const h = S.store.buildHistogram;
        if (h && Number.isFinite(ev.ts) && ev.ts >= h.day && ev.ts < h.day + 86400000) {
          h.bins[Math.min(47, Math.floor((ev.ts - h.day) / 1800000))] += 1;
        }
        break;
      }
      default: break;
    }
  };

  /**
   * @param {AUEvent[]} batch
   * @returns {Set<string>}
   */
  A.workedShipIds = function workedShipIds(batch) {
    const ids = new Set();
    for (const ev of batch) {
      if (ev.type === 'ship-updated') ids.add(ev.ship.id);
      else if (ev.type === 'build') ids.add(ev.shipId);
    }
    return ids;
  };

  /**
   * Promotes hulls whose build count crossed a rank. Every stored ship when no
   * ids are given, e.g. after focus mode stops fading ships.
   * @param {Iterable<string>} [ids]
   */
  A.refreshShipHulls = function refreshShipHulls(ids) {
    const scene = S.activeScene;
    if (!scene || !AUR.ships || typeof AUR.ships.refresh !== 'function') return;
    for (const id of ids || S.store.ships.keys()) {
      const ship = S.store.ships.get(id);
      if (ship) AUR.ships.refresh(scene, ship);
    }
  };

  function maybeNotifyAttention(previousAttention, ship) {
    const entered = ship && AUR.needsYou(ship.attention);
    if (S.playback.mode !== 'live' || previousAttention != null || !entered ||
        typeof window.Notification !== 'function') return;

    const now = Date.now();
    const lastForShip = S.notificationByShip.get(ship.id) ?? -Infinity;
    if (now - lastForShip < C.NOTIFICATION_SHIP_THROTTLE_MS ||
        now - S.lastNotificationAt < C.NOTIFICATION_GLOBAL_THROTTLE_MS) return;

    const meta = AUR.attentionMeta(ship.attention);
    if (!meta) return;
    try {
      new window.Notification(ship.name + ' needs you', {
        body: meta.label + ' · ' + A.projectName(ship.project),
      });
      S.notificationByShip.set(ship.id, now);
      S.lastNotificationAt = now;
    } catch (e) { /* notifications are best-effort */ }
  }
})();
