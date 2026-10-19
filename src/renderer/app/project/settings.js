// @ts-check
// Project path settings (missing-folder recovery).
'use strict';

/**
 * @import { Failure, ProjectPathFailureCode } from '../../../types/contract'
 */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/settings.js');
  const S = A.state;

  // ---------- project path settings ----------
  A.wireProjectSettings = function wireProjectSettings() {
    S.projectSettings.els = {
      button: document.getElementById('settings-button'),
      count: document.getElementById('settings-count'),
      dialog: document.getElementById('settings-dialog'),
      shell: document.querySelector('#settings-dialog .settings-shell'),
      close: document.getElementById('settings-close'),
      summary: document.getElementById('settings-summary'),
      scan: document.getElementById('settings-scan'),
      status: document.getElementById('settings-status'),
      projects: document.getElementById('settings-projects'),
    };
    const els = S.projectSettings.els;
    if (!els.button || !els.dialog || !els.close || !els.scan || !els.projects) return;

    els.button.addEventListener('click', A.openProjectSettings);
    els.close.addEventListener('click', closeProjectSettings);
    els.scan.addEventListener('click', scanForProjectPaths);
    els.dialog.addEventListener('close', finishProjectSettingsClose);
    els.dialog.addEventListener('click', (event) => {
      if (event.target !== els.dialog || !els.shell) return;
      const rect = els.shell.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) closeProjectSettings();
    });
    A.renderProjectSettings();
  };

  function missingPathProjects() {
    return [...S.store.projects.values()]
      .filter((project) => project && project.exists === false)
      .sort(A.byProjectName);
  }

  A.openProjectSettings = function openProjectSettings() {
    const els = S.projectSettings.els;
    if (!els || !els.dialog || S.projectSettings.open) return;
    A.clearProjectSearch();
    A.closeProjectDirectory(false);
    resetSettingsSession(true);
    els.button.setAttribute('aria-expanded', 'true');
    els.dialog.showModal();
    A.renderProjectSettings();
    requestAnimationFrame(() => {
      const target = !els.scan.disabled ? els.scan : els.close;
      target.focus();
    });
  };

  function closeProjectSettings() {
    const els = S.projectSettings.els;
    if (!els || !els.dialog || !els.dialog.open) return;
    els.dialog.close();
  }

  // Opening or closing ends any request in flight and forgets the last scan.
  function resetSettingsSession(open) {
    S.projectSettings.owner++;
    S.projectSettings.request++;
    S.projectSettings.open = open;
    S.projectSettings.busy = false;
    S.projectSettings.scanPerformed = false;
    S.projectSettings.scanRoot = '';
    S.projectSettings.matches.clear();
    setProjectSettingsStatus('');
  }

  function finishProjectSettingsClose() {
    const els = S.projectSettings.els;
    resetSettingsSession(false);
    if (els && els.button) {
      els.button.setAttribute('aria-expanded', 'false');
      els.button.focus();
    }
    A.renderProjectSettings();
  }

  const PATH_ERRORS = new Map([
    ['REPLAY', 'Return to LIVE before changing project paths.'],
    ['BUSY', 'Another folder picker or scan is already open.'],
    ['IN_USE', 'That folder is already assigned to another project.'],
    ['EXPIRED', 'That scan result expired. Scan the folder again.'],
    ['NOT_FOUND', 'The selected folder is no longer available.'],
    ['NOT_MISSING', 'This project path has already been recovered.'],
    ['INVALID', 'That folder cannot be used for this project.'],
  ]);

  function projectPathErrorText(code) {
    return PATH_ERRORS.get(code) || 'The project path could not be updated.';
  }

  function setProjectSettingsStatus(message, error = false) {
    S.projectSettings.status = message || '';
    S.projectSettings.error = Boolean(error);
  }

  function settingsRequestIsCurrent(owner, request) {
    return S.projectSettings.open && owner === S.projectSettings.owner && request === S.projectSettings.request;
  }

  function focusProjectSettingsControl(kind, projectId, token) {
    requestAnimationFrame(() => {
      if (!S.projectSettings.open || !S.projectSettings.els) return;
      const els = S.projectSettings.els;
      let target = null;
      if (kind === 'locate') {
        target = [...els.projects.querySelectorAll('.settings-locate')].find(
          (button) => button.dataset.projectId === projectId && !button.disabled
        );
      } else if (kind === 'candidate') {
        target = [...els.projects.querySelectorAll('.settings-candidate-use')].find(
          (button) => button.dataset.projectId === projectId &&
            button.dataset.token === token && !button.disabled
        );
      } else if (kind === 'first-candidate') {
        target = els.projects.querySelector('.settings-candidate-use:not(:disabled)');
      }
      if (!target && !els.scan.disabled) target = els.scan;
      if (!target) target = els.projects.querySelector('.settings-locate:not(:disabled)');
      if (!target) target = els.close;
      target.focus();
    });
  }

  /**
   * One folder picker or scan with the dialog busy. Null when refused (busy, not LIVE) or
   * superseded; a missing or thrown result becomes FAILED.
   * @template T
   * @param {string} statusText
   * @param {() => Promise<T>} call
   * @returns {Promise<T | Failure<ProjectPathFailureCode> | null>}
   */
  async function runSettingsRequest(statusText, call) {
    if (S.projectSettings.busy || S.playback.mode !== 'live' || S.replayTransitionPending) return null;
    const owner = S.projectSettings.owner;
    const request = ++S.projectSettings.request;
    S.projectSettings.busy = true;
    setProjectSettingsStatus(statusText);
    A.renderProjectSettings();
    S.projectSettings.els.close.focus();
    const result = await AUR.settle(call);
    if (!settingsRequestIsCurrent(owner, request)) return null;
    S.projectSettings.busy = false;
    return result;
  }

  async function scanForProjectPaths() {
    const result = await runSettingsRequest('Choose a parent folder to scan.', () => AU.projectPathsScan());
    if (!result) return;
    if (result.ok !== true) {
      setProjectSettingsStatus(projectPathErrorText(result.code), true);
      A.renderProjectSettings();
      focusProjectSettingsControl('scan');
      return;
    }
    if (result.canceled) {
      setProjectSettingsStatus('Scan canceled. No paths were changed.');
      A.renderProjectSettings();
      focusProjectSettingsControl('scan');
      return;
    }

    S.projectSettings.scanPerformed = true;
    S.projectSettings.scanRoot = typeof result.root === 'string' ? result.root : '';
    S.projectSettings.matches = new Map();
    for (const match of Array.isArray(result.matches) ? result.matches : []) {
      if (!match || typeof match.projectId !== 'string') continue;
      const candidates = (Array.isArray(match.candidates) ? match.candidates : []).filter(
        (candidate) => candidate && typeof candidate.token === 'string' &&
          typeof candidate.path === 'string'
      );
      S.projectSettings.matches.set(match.projectId, candidates);
    }
    const found = [...S.projectSettings.matches.values()].filter((items) => items.length > 0).length;
    const visited = Number.isFinite(result.directoriesVisited) ? result.directoriesVisited : 0;
    const suffix = result.truncated ? ' The bounded scan stopped early.' : '';
    const root = S.projectSettings.scanRoot ? ` under ${S.projectSettings.scanRoot}` : '';
    setProjectSettingsStatus(
      `Scanned ${visited.toLocaleString()} folders${root}; found matches for ${found} project${found === 1 ? '' : 's'}.${suffix}`
    );
    A.renderProjectSettings();
    focusProjectSettingsControl('first-candidate');
  }

  async function locateProjectPath(projectId) {
    const result = await runSettingsRequest('Choose the project folder.', () => AU.projectPathLocate(projectId));
    if (!result) return;
    if (result.ok !== true) {
      setProjectSettingsStatus(projectPathErrorText(result.code), true);
    } else if (result.canceled) {
      setProjectSettingsStatus('No folder selected. No paths were changed.');
    } else {
      S.projectSettings.matches.delete(projectId);
      setProjectSettingsStatus(`Recovered ${result.project && result.project.name || 'project'}.`);
    }
    A.renderProjectSettings();
    focusProjectSettingsControl(result.ok !== true || result.canceled ? 'locate' : 'scan', projectId);
  }

  async function applyProjectPathCandidate(projectId, token) {
    const result = await runSettingsRequest(
      'Applying the selected project folder…', () => AU.projectPathApply(projectId, token)
    );
    if (!result) return;
    if (result.ok !== true) {
      setProjectSettingsStatus(projectPathErrorText(result.code), true);
      if (result.code === 'EXPIRED') S.projectSettings.matches.delete(projectId);
    } else {
      S.projectSettings.matches.delete(projectId);
      setProjectSettingsStatus(`Recovered ${result.project && result.project.name || 'project'}.`);
    }
    A.renderProjectSettings();
    focusProjectSettingsControl(result.ok !== true ? 'candidate' : 'scan', projectId, token);
  }

  A.renderProjectSettings = function renderProjectSettings() {
    const els = S.projectSettings.els;
    if (!els || !els.button || !els.count) return;
    const projects = missingPathProjects();
    const missingCount = projects.length;
    els.count.textContent = missingCount > 99 ? '99+' : String(missingCount);
    els.count.classList.toggle('hidden', missingCount === 0);
    els.button.setAttribute('aria-label', missingCount === 0
      ? 'Settings'
      : `Settings, ${missingCount} projects missing`);
    if (!S.projectSettings.open || !els.dialog || !els.dialog.open) return;

    const live = S.playback.mode === 'live' && !S.replayTransitionPending;
    els.summary.textContent = missingCount === 0
      ? 'All paths valid' : `${missingCount} missing`;
    els.summary.classList.toggle('clear', missingCount === 0);
    els.scan.disabled = S.projectSettings.busy || !live || missingCount === 0;
    els.scan.textContent = S.projectSettings.busy ? 'Working…' : 'Scan folder…';
    const visibleStatus = !live
      ? 'Return to LIVE before changing project paths.' : S.projectSettings.status;
    els.status.textContent = visibleStatus;
    els.status.classList.toggle('error', !live || S.projectSettings.error);

    AUR.clear(els.projects);
    if (missingCount === 0) {
      els.projects.appendChild(AUR.el('div', 'settings-empty', 'All known project folders are connected.'));
      return;
    }

    projects.forEach((project, projectIndex) => {
      const row = AUR.el('section', 'settings-project-row');
      const head = AUR.el('div', 'settings-project-head');
      const copy = AUR.el('div', 'settings-project-copy');
      const projectName = A.projectLabel(project);
      const name = AUR.el('div', 'settings-project-name', projectName);
      name.id = `settings-project-name-${projectIndex}`;
      row.setAttribute('aria-labelledby', name.id);
      copy.append(name, AUR.el(
        'div', 'settings-project-path', project.path || 'No recorded folder path'
      ));
      const locate = AUR.button('settings-locate', 'Locate…', () => locateProjectPath(project.id));
      locate.disabled = S.projectSettings.busy || !live;
      locate.dataset.projectId = project.id;
      locate.setAttribute('aria-label', `Locate folder for ${projectName}`);
      head.append(copy, locate);
      row.appendChild(head);

      const candidates = S.projectSettings.matches.get(project.id) || [];
      if (candidates.length > 0) {
        const list = AUR.el('div', 'settings-candidates');
        const candidateLabel = AUR.el(
          'div', 'settings-candidates-label',
          candidates.length === 1 ? 'SCAN MATCH' : `${candidates.length} SCAN MATCHES`
        );
        candidateLabel.id = `settings-candidates-label-${projectIndex}`;
        list.setAttribute('role', 'group');
        list.setAttribute('aria-labelledby', candidateLabel.id);
        list.appendChild(candidateLabel);
        for (const candidate of candidates) {
          const candidateRow = AUR.el('div', 'settings-candidate');
          candidateRow.appendChild(AUR.el('div', 'settings-candidate-path', candidate.path));
          const use = AUR.button(
            'settings-candidate-use', 'Use this folder',
            () => applyProjectPathCandidate(project.id, candidate.token)
          );
          use.disabled = S.projectSettings.busy || !live;
          use.dataset.projectId = project.id;
          use.dataset.token = candidate.token;
          use.setAttribute('aria-label', `Use ${candidate.path} for ${projectName}`);
          candidateRow.appendChild(use);
          list.appendChild(candidateRow);
        }
        row.appendChild(list);
      } else if (S.projectSettings.scanPerformed) {
        row.appendChild(AUR.el(
          'div', 'settings-no-match', 'No exact folder-name match in the last scan.'
        ));
      }
      els.projects.appendChild(row);
    });
  };
})();
