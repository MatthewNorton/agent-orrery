// @ts-check
// Routes: the universe, a project's system and one of its planets, the back button, and the
// views main asks for in shots mode (kit/SPEC.md §8). Each builds its view through A.setView.
'use strict';

/** @import { DebugView, PlanetData, SystemData } from '../../types/contract' */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/route.js');
  const S = A.state;

  // ---------- routes ----------
  /**
   * The route view `name` built from `data` is at: the view, and the project and planet its data
   * names. A.setView makes it S.current once the view is built, and not before, so a view that
   * cannot be built leaves the route of the one shown.
   * @param {string} name @param {{ projectId?: string, name?: string }} data
   */
  A.viewRoute = function viewRoute(name, data) {
    return { view: name, projectId: data.projectId ?? null, planetName: name === 'planet' ? data.name : null };
  };

  A.showUniverse = function showUniverse() {
    S.routeRequestGeneration++;
    A.setView('universe', { store: S.store });
  };

  A.openSystem = async function openSystem(projectId) {
    const request = ++S.routeRequestGeneration;
    const requestedEpoch = S.streamEpoch;
    const data = await AUR.fetchSystem(projectId);
    if (request !== S.routeRequestGeneration || !A.sameEpoch(requestedEpoch, S.streamEpoch)) return;
    // None: main has no such system, its answer lists no planets, or the call failed (logged there).
    if (!data) { AUR.log('no system data for', projectId); return A.showUniverse(); }
    A.setView('system', { system: data, projectId, store: S.store });
  };

  /** @param {string} projectId @param {string} name @param {SystemData} [system] from a caller that holds it current (the system view) */
  A.openPlanet = async function openPlanet(projectId, name, system) {
    const request = ++S.routeRequestGeneration;
    const requestedEpoch = S.streamEpoch;
    // The system rides along for the planet card's solar-system totals; without it they show dashes.
    const systemRequest = A.requestPlanetSystem(projectId, system);
    /** @type {PlanetData} */
    let data = null;
    try { data = await AU.getPlanet(projectId, name); } catch (e) { AUR.log('getPlanet err', e && e.message); }
    const held = await systemRequest;
    if (request !== S.routeRequestGeneration || !A.sameEpoch(requestedEpoch, S.streamEpoch)) return;
    if (!data) { AUR.log('no planet data for', projectId, name); return A.openSystem(projectId); }
    S.planetSystem.data = held;
    // Main answers with the name the system view draws the planet under; its casing can differ.
    A.setView('planet', { planet: data, projectId, name: data.name, store: S.store });
    A.planetSystemOpened(projectId);
  };

  function back() {
    if (S.current.view === 'planet' && S.current.projectId) A.openSystem(S.current.projectId);
    else A.showUniverse();
  }

  // Direct project links (feed, recent, task views) jump to the system. Agent
  // rows use the agent-focus flow (app/agent-focus.js).
  A.jumpToProject = function jumpToProject(projectId) {
    if (!projectId || !S.store.projects.has(projectId)) return;
    if (S.current.view === 'system' && S.current.projectId === projectId) return;
    A.openSystem(projectId);
  };

  A.wireBackButton = function wireBackButton() {
    const btn = document.getElementById('back-btn');
    btn.addEventListener('click', back);
  };

  // ---------- debug / shots ----------
  function pickDemoProject() {
    let best = null;
    for (const p of S.store.projects.values()) {
      if (!p.exists) continue;
      if (!best || p.lastActivity > best.lastActivity) best = p;
    }
    if (best) return best;
    // fallback: any project at all
    for (const p of S.store.projects.values()) return p;
    return null;
  }

  function largestPlanet(planets) {
    if (!planets || !planets.length) return null;
    let best = planets[0];
    let bestScore = AUR.planetWeight(best);
    for (const p of planets) {
      const s = AUR.planetWeight(p);
      if (s > bestScore) { best = p; bestScore = s; }
    }
    return best;
  }

  /** @param {DebugView} view */
  A.handleDebugView = async function handleDebugView(view) {
    try {
      if (view === 'system') {
        const p = pickDemoProject();
        if (p) await A.openSystem(p.id);
      } else if (view === 'planet') {
        const p = pickDemoProject();
        if (p) {
          const sys = await AUR.fetchSystem(p.id);
          const planet = sys ? largestPlanet(sys.planets) : null;
          if (planet) await A.openPlanet(p.id, planet.name);
        }
      } else {
        if (S.current.view !== 'universe') A.showUniverse();
      }
    } catch (e) {
      AUR.log('debug-view handling issue:', view, e && e.message);
    }
    signalReadyOnce();
  };

  // Fire AU.debugReady() exactly once, after the active scene is ready and has
  // rendered one frame. Never from a recurring observable.
  function signalReadyOnce() {
    const scene = S.activeScene;
    if (!scene || scene.isDisposed) { AU.debugReady(); return; }
    scene.executeWhenReady(() => {
      if (scene.isDisposed) { AU.debugReady(); return; }
      scene.onAfterRenderObservable.addOnce(() => AU.debugReady());
    });
  }
})();
