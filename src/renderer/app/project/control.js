// @ts-check
// app/project/control.js — project card (folder/terminal actions) and planet card.
'use strict';

/** @import { OpenTerminalResult } from '../../../types/contract' */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const VCS = AUR.ProjectVcsStatus;
  const A = AUR.app;               // created by app/state.js; throw if missing
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

  function terminalFailureText(code) {
    if (code === 'UNAVAILABLE') return 'A terminal app is unavailable on this computer.';
    if (code === 'REPLAY') return 'Return to LIVE to open a terminal.';
    if (code === 'NOT_FOUND') return 'This project is unavailable.';
    if (code === 'BUSY') return 'A terminal launch was just requested.';
    if (code === 'INVALID') return 'The terminal request was rejected.';
    return 'Terminal launch failed. Try again.';
  }

  A.projectControlPresentation = function projectControlPresentation(projectId) {
    const state = ensureProjectControl(projectId);
    if (S.playback.mode !== 'live') {
      return {
        phase: 'replay', disabled: true, busy: false,
        buttonText: 'Open Terminal', note: 'Return to LIVE to open a terminal.',
      };
    }
    if (S.replayTransitionPending || S.replayBusy) {
      return {
        phase: 'transition', disabled: true, busy: true,
        buttonText: 'Open Terminal', note: 'History view is changing.',
      };
    }
    if (state.phase === 'pending') {
      return {
        phase: 'pending', disabled: true, busy: true,
        buttonText: 'Opening\u2026', note: 'Requesting terminal launch\u2026',
      };
    }
    if (state.phase === 'success') {
      return {
        phase: 'success', disabled: false, busy: false,
        buttonText: 'Open Terminal', note: 'Terminal launch requested',
      };
    }
    if (state.phase === 'failure') {
      return {
        phase: 'failure', disabled: false, busy: false,
        buttonText: 'Open Terminal', note: terminalFailureText(state.code),
      };
    }
    return {
      phase: 'idle', disabled: false, busy: false,
      buttonText: 'Open Terminal', note: '',
    };
  };

  A.requestProjectTerminal = async function requestProjectTerminal(projectId) {
    const state = ensureProjectControl(projectId);
    if (state.phase === 'pending' || S.playback.mode !== 'live' ||
        S.replayTransitionPending || S.replayBusy) return;

    const requestId = ++S.terminalRequestSerial;
    S.projectControl = { projectId, requestId, phase: 'pending', code: null };
    A.renderProjectCard();
    A.renderAgentFocus();

    /** @type {OpenTerminalResult} */
    let result;
    try {
      result = await AU.openTerminal(projectId);
    } catch (error) {
      result = { ok: false, code: 'FAILED' };
    }
    if (S.projectControl.projectId !== projectId || S.projectControl.requestId !== requestId) return;

    const ok = Boolean(result && result.ok === true);
    const code = !ok && result && typeof result.code === 'string' ? result.code : 'FAILED';
    S.projectControl = {
      projectId,
      requestId,
      phase: ok ? 'success' : 'failure',
      code: ok ? null : code,
    };
    A.renderProjectCard();
    A.renderAgentFocus();
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
    const needsYou = ships.some(
      (s) => s.attention === 'question' || s.attention === 'permission'
    );
    const state = needsYou ? 'Needs You' : busiestStatus(ships);
    card.appendChild(pcRow('STATE', state, state === 'Building', needsYou ? 'needs-you' : null));
    card.appendChild(pcRow('BUILDS', String(p.totalBuilds || 0)));
    card.appendChild(pcRow('LAST SIGNAL', AUR.relTime(p.lastActivity, A.playbackReferenceTs())));

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
      const folder = AUR.el('button', 'pc-btn', 'Open Folder');
      folder.id = 'project-open-folder';
      folder.type = 'button';
      folder.addEventListener('click', () => { AU.openProject(p.id); });
      actions.appendChild(folder);

      const presentation = A.projectControlPresentation(p.id);
      const terminal = AUR.el('button', 'pc-btn project-terminal', presentation.buttonText);
      terminal.id = 'project-terminal';
      terminal.type = 'button';
      terminal.disabled = presentation.disabled;
      terminal.setAttribute('aria-label', 'Open Terminal');
      terminal.setAttribute('aria-describedby', 'project-control-status');
      terminal.setAttribute('aria-busy', String(presentation.busy));
      terminal.dataset.state = presentation.phase;
      terminal.addEventListener('click', () => { A.requestProjectTerminal(p.id); });
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
    row.appendChild(AUR.el('div', 'pc-key', key));
    const v = AUR.el('div', 'pc-val' + (accent ? ' accent' : '') + (tone ? ' ' + tone : ''), val);
    row.appendChild(v);
    return row;
  }

  // ---------- planet card ----------
  A.renderPlanetCard = function renderPlanetCard() {
    const card = document.getElementById('planet-card');
    if (S.current.view !== 'planet') { card.classList.add('hidden'); return; }
    const pd = S.activeView && S.activeView.planetData ? S.activeView.planetData : null;
    if (!pd) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    AUR.clear(card);

    const ships = A.shipsInProject(S.current.projectId);
    const active = ships.length > 0;

    const status = AUR.el('span', 'mod-m panel-note');
    const sdot = AUR.el('span', 'agent-dot');
    sdot.style.background = active ? '#34d399' : '#8b93a8';
    sdot.style.boxShadow = active ? '0 0 7px #34d399' : 'none';
    status.appendChild(sdot);
    status.appendChild(document.createTextNode(active ? 'Active' : 'Dormant'));
    A.moduleHead(card, 'PLANET: ' + String(pd.name).toUpperCase(), { extras: [status] });

    const body = AUR.el('div', 'mod-b plc-body');
    body.appendChild(pcRow('TYPE', pd.procedural ? 'Unknown' : 'Terrestrial'));
    body.appendChild(pcRow('RESOURCES', (pd.resources && pd.resources.length) ? pd.resources.join(', ') : '—'));
    body.appendChild(pcRow('MASS', (pd.files || 0) + ' files'));
    body.appendChild(pcRow('DIAMETER', (pd.sizeKb || 0) + ' KB'));
    body.appendChild(pcRow('STRUCTURES', String(pd.subdirs || 0)));
    body.appendChild(AUR.el('div', 'bars-title', 'PLANET STATUS'));
    body.appendChild(bar('Infrastructure', (pd.subdirs || 0) / 10));
    body.appendChild(bar('Resources', (pd.files || 0) / 500));
    body.appendChild(bar('Build Energy', (pd.builds || 0) / 50));
    card.appendChild(body);
  };

  function bar(key, frac) {
    const pct = Math.round(AUR.clamp(frac, 0, 1) * 100);
    const row = AUR.el('div', 'bar-row');
    row.appendChild(AUR.el('div', 'bar-key', key));
    const track = AUR.el('div', 'bar-track');
    const fill = AUR.el('div', 'bar-fill');
    fill.style.width = pct + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(AUR.el('div', 'bar-val', pct + '%'));
    return row;
  }
})();
