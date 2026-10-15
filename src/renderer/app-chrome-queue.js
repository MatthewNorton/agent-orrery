// @ts-check
// app-chrome-queue.js — overlay chrome refresh: which panels an event dirties, coalesced into one frame.
'use strict';

/** @import { AUEvent } from '../types/contract' */

(function () {
  const AUR = window.AUR;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-chrome-queue.js');
  const C = A.const;
  const CHROME = C.CHROME;

  /** @param {AUEvent} ev */
  A.chromeMaskFor = function chromeMaskFor(ev) {
    if (ev.type === 'ship-spawned' || ev.type === 'ship-updated' || ev.type === 'ship-departed') {
      return CHROME.AGENTS | CHROME.SUMMARY | CHROME.PROJECT | CHROME.PLANET |
        CHROME.GALAXIES | CHROME.SEARCH | CHROME.DIRECTORY | CHROME.FOCUS;
    }
    if (ev.type === 'project-added' || ev.type === 'project-updated') {
      const projectChrome = CHROME.AGENTS | CHROME.FEED | CHROME.SUMMARY | CHROME.PROJECT |
        CHROME.GALAXIES | CHROME.SEARCH | CHROME.SETTINGS | CHROME.DIRECTORY | CHROME.IDEAS;
      return ev.type === 'project-added' ? projectChrome | CHROME.HISTORY : projectChrome;
    }
    if (ev.type === 'feed') return CHROME.FEED;
    if (ev.type === 'build') return CHROME.SUMMARY | CHROME.PROJECT | CHROME.PLANET | CHROME.GALAXIES;
    return 0;
  };

  let chromePending = false;
  let pendingChromeMask = 0;
  A.scheduleChrome = function scheduleChrome(mask) {
    pendingChromeMask |= mask;
    if (chromePending || pendingChromeMask === 0) return;
    chromePending = true;
    requestAnimationFrame(() => {
      chromePending = false;
      const next = pendingChromeMask;
      pendingChromeMask = 0;
      if (next & CHROME.AGENTS) A.renderAgents();
      if (next & CHROME.FEED) A.renderFeed();
      if (next & CHROME.SUMMARY) A.renderSummary();
      if (next & CHROME.PROJECT) A.renderProjectCard();
      if (next & CHROME.PLANET) A.renderPlanetCard();
      if (next & CHROME.GALAXIES) A.renderGalaxies();
      if (next & CHROME.SEARCH) A.refreshProjectSearchFromStore();
      if (next & CHROME.SETTINGS) A.renderProjectSettings();
      if (next & CHROME.DIRECTORY) A.refreshProjectDirectoryFromStore();
      if (next & CHROME.IDEAS) A.renderIdeas();
      if (next & CHROME.FOCUS) A.renderAgentFocus();
      if (next & CHROME.HISTORY) A.renderHistory();
    });
  };

  A.renderChrome = function renderChrome() {
    A.renderAgents();
    A.renderFeed();
    A.renderSummary();
    A.renderProjectCard();
    A.renderPlanetCard();
    A.renderTabbar();
    A.renderBackButton();
    A.renderGalaxies();
    A.renderProjectVcsFilter();
    A.renderProjectDirectory();
    A.renderProjectSettings();
    A.renderIdeas();
    A.renderHistory();
    A.renderAgentFocus();
  };
})();
