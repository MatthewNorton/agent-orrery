// @ts-check
// Overlay chrome refresh: which panels an event dirties, coalesced into one frame.
'use strict';

/** @import { AUEvent } from '../../types/contract' */

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/chrome-queue.js');
  const CHROME = A.const.CHROME;

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

  const RENDERERS = [
    [CHROME.AGENTS, 'renderAgents'],
    [CHROME.FEED, 'renderFeed'],
    [CHROME.SUMMARY, 'renderSummary'],
    [CHROME.PROJECT, 'renderProjectCard'],
    [CHROME.PLANET, 'renderPlanetCard'],
    [CHROME.GALAXIES, 'renderGalaxies'],
    [CHROME.SEARCH, 'refreshProjectSearchFromStore'],
    [CHROME.SETTINGS, 'renderProjectSettings'],
    [CHROME.DIRECTORY, 'refreshProjectDirectoryFromStore'],
    [CHROME.IDEAS, 'renderIdeas'],
    [CHROME.FOCUS, 'renderAgentFocus'],
    [CHROME.HISTORY, 'renderHistory'],
  ];

  /** Renders the panels in `mask` now; a frame already scheduled still renders its own. @param {number} mask */
  A.renderChromeNow = function renderChromeNow(mask) {
    for (const [bit, name] of RENDERERS) if (mask & bit) A[name]();
  };

  let pendingChromeMask = 0;
  A.scheduleChrome = function scheduleChrome(mask) {
    const idle = pendingChromeMask === 0;
    pendingChromeMask |= mask;
    if (!idle || pendingChromeMask === 0) return;
    requestAnimationFrame(() => {
      const next = pendingChromeMask;
      pendingChromeMask = 0;
      A.renderChromeNow(next);
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
    A.renderProjectDirectory();
    A.renderProjectSettings();
    A.renderIdeas();
    A.renderHistory();
    A.renderAgentFocus();
  };
})();
