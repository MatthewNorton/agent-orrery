// @ts-check
// Project card (folder/terminal actions) and planet card.
'use strict';

/** @import { OpenTerminalResult } from '../../../types/contract' */

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

      const status = AUR.el('div', 'project-control-status', presentation.note);
      status.id = 'project-control-status';
      status.dataset.state = presentation.phase;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      card.appendChild(status);
    }
  };

  function pcRow(key, val, accent, tone) {
    const row = AUR.el('div', 'pc-row');
    row.append(
      AUR.el('div', 'pc-key', key),
      AUR.el('div', 'pc-val' + (accent ? ' accent' : '') + (tone ? ' ' + tone : ''), val)
    );
    return row;
  }

  // ---------- planet card ----------
  A.renderPlanetCard = function renderPlanetCard() {
    const card = document.getElementById('planet-card');
    if (S.current.view !== 'planet') { card.classList.add('hidden'); return; }
    const pd = A.activePlanetData();
    if (!pd) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    AUR.clear(card);

    const ships = A.shipsInProject(S.current.projectId);
    const active = ships.length > 0;

    const status = AUR.el('span', 'mod-m panel-note');
    const sdot = AUR.el('span', 'agent-dot');
    sdot.style.background = active ? '#34d399' : '#8b93a8';
    sdot.style.boxShadow = active ? '0 0 7px #34d399' : 'none';
    status.append(sdot, active ? 'Active' : 'Dormant');
    A.moduleHead(card, 'PLANET: ' + String(pd.name).toUpperCase(), { extras: [status] });

    const body = AUR.el('div', 'mod-b plc-body');
    body.append(
      pcRow('TYPE', pd.procedural ? 'Unknown' : 'Terrestrial'),
      pcRow('RESOURCES', (pd.resources && pd.resources.length) ? pd.resources.join(', ') : '—'),
      pcRow('MASS', (pd.files || 0) + ' files'),
      pcRow('DIAMETER', (pd.sizeKb || 0) + ' KB'),
      pcRow('STRUCTURES', String(pd.subdirs || 0)),
      AUR.el('div', 'bars-title', 'PLANET STATUS'),
      bar('Infrastructure', (pd.subdirs || 0) / 10),
      bar('Resources', (pd.files || 0) / 500),
      bar('Build Energy', (pd.builds || 0) / 50)
    );
    card.appendChild(body);
  };

  function bar(key, frac) {
    const pct = Math.round(AUR.clamp(frac, 0, 1) * 100);
    const row = AUR.el('div', 'bar-row');
    const track = AUR.el('div', 'bar-track');
    const fill = AUR.el('div', 'bar-fill');
    fill.style.width = pct + '%';
    track.appendChild(fill);
    row.append(AUR.el('div', 'bar-key', key), track, AUR.el('div', 'bar-val', pct + '%'));
    return row;
  }
})();
