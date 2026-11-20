// @ts-check
// Project card (folder/terminal actions) and planet card.
'use strict';

/** @import { OpenTerminalResult, PlanetData, SystemData } from '../../../types/contract' */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/control.js');
  const S = A.state, C = A.const;

  // ---------- project card ----------
  function busiestStatus(ships) {
    if (ships.length === 0) return 'Dormant';
    for (const s of ships) if (s.status === 'Building') return 'Building';
    return ships[0].status;
  }

  function projectMarkSvg() {
    return '<svg class="pc-mark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M12 3 L21 20 L3 20 Z" fill="#6c8cff" fill-opacity="0.85"/>' +
      '<path d="M12 3 L12 20 L3 20 Z" fill="#6c8cff" fill-opacity="0.45"/></svg>';
  }

  function ensureProjectControl(projectId) {
    if (S.projectControl.projectId !== projectId) {
      S.projectControl = {
        projectId,
        requestId: ++S.terminalRequestSerial,
        phase: 'idle',
        code: null,
      };
    }
    return S.projectControl;
  }

  const TERMINAL_FAILURES = new Map([
    ['UNAVAILABLE', 'A terminal app is unavailable on this computer.'],
    ['REPLAY', 'Return to LIVE to open a terminal.'],
    ['NOT_FOUND', 'This project or agent is unavailable.'],
    ['TERMINAL_NOT_FOUND', 'The agent\u2019s existing terminal could not be found. It may be closed or running without a terminal.'],
    ['TERMINAL_BLOCKED', 'The agent\u2019s terminal was found but stayed in the background. Switch to it from the taskbar.'],
    ['AMBIGUOUS', 'Select an agent to open its terminal.'],
    ['BUSY', 'A terminal request is already in progress.'],
    ['INVALID', 'The terminal request was rejected.'],
  ]);

  function terminalFailureText(code) {
    return TERMINAL_FAILURES.get(code) || 'Could not open the terminal. Try again.';
  }

  const CONTROL_NOTES = new Map([
    ['replay', TERMINAL_FAILURES.get('REPLAY')],
    ['transition', 'History view is changing.'],
    ['pending', 'Opening terminal\u2026'],
    ['success', 'Terminal opened'],
    ['idle', ''],
  ]);

  A.projectControlPresentation = function projectControlPresentation(projectId, shipId = null) {
    const state = ensureProjectControl(projectId);
    const matches = (state.targetId || state.projectId) === (shipId || projectId);
    const phase = S.playback.mode !== 'live' ? 'replay'
      : S.replayTransitionPending || S.replayBusy ? 'transition'
        : state.phase === 'pending' ? 'pending'
          : matches && ['success', 'failure'].includes(state.phase) ? state.phase : 'idle';
    const busy = phase === 'transition' || phase === 'pending';
    return {
      phase, disabled: busy || phase === 'replay', busy,
      buttonText: phase === 'pending' ? 'Opening\u2026' : 'Open Terminal',
      note: phase === 'failure' ? terminalFailureText(state.code) : CONTROL_NOTES.get(phase),
    };
  };

  A.requestProjectTerminal = async function requestProjectTerminal(projectId, shipId = null) {
    if (A.projectControlPresentation(projectId, shipId).disabled) return;

    const requestId = ++S.terminalRequestSerial;
    const targetId = shipId || projectId;
    S.projectControl = { projectId, targetId, requestId, phase: 'pending', code: null };
    A.renderChromeNow(C.CHROME.PROJECT | C.CHROME.FOCUS);

    /** @type {OpenTerminalResult} */
    const result = await AUR.settle(() => AU.openTerminal(targetId));
    if (S.projectControl.projectId !== projectId || S.projectControl.requestId !== requestId) return;

    const ok = result.ok === true;
    const code = !ok && typeof result.code === 'string' ? result.code : 'FAILED';
    S.projectControl = {
      projectId,
      targetId,
      requestId,
      phase: ok ? 'success' : 'failure',
      code: ok ? null : code,
    };
    A.renderChromeNow(C.CHROME.PROJECT | C.CHROME.FOCUS);
  };

  // ---------- project card rendering ----------
  A.renderProjectCard = function renderProjectCard() {
    const card = document.getElementById('project-card');
    if (S.current.view === 'universe' || !S.current.projectId) { card.classList.add('hidden'); return; }
    const p = S.store.projects.get(S.current.projectId);
    if (!p) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    card.dataset.view = S.current.view;
    AUR.clear(card);

    const mark = document.createElement('span');
    mark.innerHTML = projectMarkSvg();
    A.moduleHead(card, 'PROJECT: ' + p.name, { lead: mark.firstChild });

    const ships = A.shipsInProject(p.id);
    const needsYou = ships.some((s) => AUR.needsYou(s.attention));
    const state = needsYou ? 'Needs You' : busiestStatus(ships);
    card.append(
      pcRow('STATE', state, state === 'Building', needsYou ? 'needs-you' : null),
      pcRow('BUILDS', String(p.totalBuilds || 0)),
      pcRow('LAST SIGNAL', AUR.relTime(p.lastActivity, A.playbackReferenceTs()))
    );

    if (S.current.view === 'system') {
      const repository = AUR.el('div', 'project-card-vcs');
      VCS.renderDetails(repository, p, {
        onOpenRepository(url) {
          if (typeof AU.openExternal === 'function') AU.openExternal(url);
        },
      });
      card.appendChild(repository);
    }

    if (p.exists) {
      const actions = AUR.el('div', 'pc-actions');
      const folder = AUR.button('pc-btn', 'Open Folder', () => { AU.openProject(p.id); });
      folder.id = 'project-open-folder';
      actions.appendChild(folder);

      const presentation = A.projectControlPresentation(p.id);
      const terminal = AUR.button(
        'pc-btn project-terminal', presentation.buttonText, () => { A.requestProjectTerminal(p.id); }
      );
      terminal.id = 'project-terminal';
      terminal.disabled = presentation.disabled;
      terminal.setAttribute('aria-label', 'Open Terminal');
      terminal.setAttribute('aria-describedby', 'project-control-status');
      terminal.setAttribute('aria-busy', String(presentation.busy));
      terminal.dataset.state = presentation.phase;
      actions.appendChild(terminal);
      card.appendChild(actions);

      // A refused forget explains itself on that project's card until the next forget.
      const forgetNote = S.projectForget.projectId === p.id ? S.projectForget.note : '';
      const foot = AUR.el('div', 'pc-foot');
      const status = AUR.el('div', 'project-control-status', forgetNote || presentation.note);
      status.id = 'project-control-status';
      status.dataset.state = forgetNote ? 'failure' : presentation.phase;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      foot.appendChild(status);
      if (S.current.view === 'system') foot.appendChild(forgetButton(p, ships, presentation));
      card.appendChild(foot);
    }
  };

  function forgetButton(p, ships, presentation) {
    const working = ships.length > 0;
    const button = AUR.button('pc-forget', 'Forget…', () => { A.forgetFromCard(p.id); });
    button.id = 'project-forget';
    button.disabled = working || S.projectForget.pending ||
      presentation.phase === 'replay' || presentation.phase === 'transition';
    button.title = working ? 'An agent is working in this project' : 'Forget this project and its build history';
    button.setAttribute('aria-label', `Forget ${p.name}`);
    return button;
  }

  function pcRow(key, val, accent, tone) {
    const row = AUR.el('div', 'pc-row');
    row.append(
      AUR.el('div', 'pc-key', key),
      AUR.el('div', 'pc-val' + (accent ? ' accent' : '') + (tone ? ' ' + tone : ''), val)
    );
    return row;
  }

  // ---------- planet card: a folder's numbers in plain words, beside its solar system's ----------
  const WORLD_NAMES = Object.freeze({
    rocky: 'Rocky world', gas: 'Gas giant', ice: 'Ice world', volcanic: 'Volcanic world', oceanic: 'Oceanic world',
  });

  /**
   * What the globe is drawn as, what the planet stands for, and why its folder rows are dashes.
   * From the planet's own data, not the mode, which moves first when LIVE and REPLAY switch.
   * @param {PlanetData} pd @param {string} projectName
   */
  function planetLine(pd, projectName) {
    const world = WORLD_NAMES[AUR.worldProfile(S.current.projectId, pd.name).key] || 'World';
    // A stand-in: its project has no folder on disk, or nothing was built here (yet, in history).
    if (pd.procedural) return world + (pd.project.path && pd.project.exists !== false ? ' · no builds here yet' : ' · no folder on disk');
    const line = world + (pd.name === '(root)' ? ' · the top-level files of ' : ' · a folder in ') + projectName;
    if (pd.folderRead === 'gone') return line + ' · no longer on disk';
    if (pd.folderRead === 'none') return line + ' · could not be read';
    return pd.folderRead ? line : line + ' · history keeps no file counts';
  }

  /**
   * The system a planet opens its card with: the system view's own (`handed`) or a fetch. Either
   * can predate a planet that forms in the project while the planet is read, so from here until
   * A.planetSystemOpened such a build is noted.
   * @param {string} projectId @param {SystemData} [handed] @returns {Promise<SystemData | null>}
   */
  A.requestPlanetSystem = function requestPlanetSystem(projectId, handed) {
    Object.assign(S.planetSystem, { awaited: projectId, missed: false });
    return handed ? Promise.resolve(handed) : AUR.fetchSystem(projectId);
  };

  /**
   * The planet view of `projectId` is open with the system it asked for: one a planet has formed since is fetched again.
   * @param {string} projectId
   */
  A.planetSystemOpened = function planetSystemOpened(projectId) {
    const { missed } = S.planetSystem;
    Object.assign(S.planetSystem, { awaited: null, missed: false });
    if (missed) A.refreshPlanetSystem(projectId);
  };

  /**
   * A build that starts a planet in `projectId` changes a planet card's PLANETS row. For the open
   * planet, its system (S.planetSystem) is fetched again, one request at a time, and once more for
   * a build that came while one was out; for a planet still opening, when it has opened. An answer
   * is the card's only if no route was asked for and no stream adopted since the request (each
   * counts in S.routeRequestGeneration, so history never gets the live system) and the card still
   * shows that project. A request that fails is not made again, unless a planet started while it
   * was out, which is a new reason to ask: the rule of the system view's loop (scene/system/ships.js).
   * @param {string} projectId
   */
  A.refreshPlanetSystem = async function refreshPlanetSystem(projectId) {
    const held = S.planetSystem;
    if (projectId === held.awaited) held.missed = true;
    if (S.current.view !== 'planet' || S.current.projectId !== projectId) return;
    held.stale = true;
    if (held.loading) return;
    held.loading = true;
    // Whatever goes wrong, it ends not loading: the next build fetches again.
    try {
      while (held.stale && S.current.view === 'planet') {
        held.stale = false;
        const open = S.current.projectId, route = S.routeRequestGeneration;
        const system = await AUR.fetchSystem(open);
        const stillThisCard = route === S.routeRequestGeneration && S.current.view === 'planet' && S.current.projectId === open;
        if (!system || !stillThisCard) continue;
        held.data = system;
        A.scheduleChrome(C.CHROME.PLANET);
      }
    } finally {
      held.loading = false;
    }
  };

  A.renderPlanetCard = function renderPlanetCard() {
    const card = document.getElementById('planet-card');
    if (S.current.view !== 'planet') { card.classList.add('hidden'); return; }
    /** @type {PlanetData | null} */
    const pd = A.activePlanetData();
    if (!pd) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    AUR.clear(card);

    const project = S.store.projects.get(S.current.projectId) || pd.project;
    const ships = A.shipsInProject(S.current.projectId);
    const active = ships.length > 0;

    const status = AUR.el('span', 'mod-m panel-note');
    const sdot = AUR.el('span', 'agent-dot');
    sdot.style.background = active ? '#34d399' : '#8b93a8';
    sdot.style.boxShadow = active ? '0 0 7px #34d399' : 'none';
    status.append(sdot, active ? 'Active' : 'Dormant');
    A.moduleHead(card, 'PLANET: ' + String(pd.name).toUpperCase(), { extras: [status] });

    const counts = A.planetFolderCounts(pd);
    const types = counts && pd.resources.length
      ? pd.resources.map((ext) => (ext === 'MISC' ? 'other' : ext)).join(' · ') : '—';
    const planetBuilds = pd.builds || 0;
    const systemBuilds = project.totalBuilds || 0;
    const system = S.planetSystem.data;
    const body = AUR.el('div', 'mod-b plc-body');
    body.append(
      AUR.el('div', 'plc-sub', planetLine(pd, project.name)),
      pcRow('FILES', counts ? counts.files : '—'),
      pcRow('SIZE', counts ? counts.size : '—'),
      pcRow('SUBFOLDERS', counts ? counts.subdirs : '—'),
      pcRow('FILE TYPES', types),
      AUR.el('div', 'plc-title', 'BUILDS (FILE EDITS)'),
      pcRow('THIS PLANET', String(planetBuilds)),
      pcRow('WHOLE SOLAR SYSTEM', String(systemBuilds)),
      shareBar(planetBuilds, systemBuilds),
      AUR.el('div', 'plc-title', 'SOLAR SYSTEM'),
      // The system view draws at most 8; past that, of how many.
      pcRow('PLANETS', !system ? '—' : system.planetTotal
        ? `${system.planets.length} of ${system.planetTotal}` : String(system.planets.length)),
      pcRow('AGENTS', String(ships.length))
    );
    card.appendChild(body);
  };

  /**
   * The planet's share of its system's builds: a whole percent, but never 0% of a planet that has
   * builds nor 100% of one that does not have them all.
   * @param {number} planetBuilds @param {number} systemBuilds
   */
  function shareBar(planetBuilds, systemBuilds) {
    const frac = systemBuilds > 0 ? AUR.clamp(planetBuilds / systemBuilds, 0, 1) : 0;
    const pct = AUR.clamp(Math.round(frac * 100), frac > 0 ? 1 : 0, frac < 1 ? 99 : 100);
    const text = frac > 0 && frac < 0.005 ? '< 1%' : frac < 1 && frac >= 0.995 ? '> 99%' : pct + '%';
    const share = AUR.el('div', 'plc-share');
    const track = AUR.el('div', 'bar-track');
    const fill = AUR.el('div', 'bar-fill');
    fill.style.width = pct + '%';
    track.appendChild(fill);
    share.append(track, AUR.el('div', 'plc-share-note',
      systemBuilds > 0 ? text + ' of the system’s builds' : 'No builds in this system yet'));
    return share;
  }
})();
