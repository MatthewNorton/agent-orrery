// @ts-check
// app-ideas.js — root task ideas (global IDEAS queue).
'use strict';

/** @import { RootTaskResult, RootTasksSnapshot } from '../types/contract' */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-ideas.js');
  const S = A.state, C = A.const;

  // ---------- root task ideas ----------
  A.wireIdeasPanel = function wireIdeasPanel() {
    S.ideaPanel.els = {
      panel: document.getElementById('ideas-panel'),
      count: document.getElementById('ideas-count'),
      list: document.getElementById('ideas-list'),
      form: document.getElementById('ideas-form'),
      input: document.getElementById('ideas-input'),
      create: document.getElementById('ideas-create'),
      status: document.getElementById('ideas-status'),
    };
    const els = S.ideaPanel.els;
    if (!els.panel || !els.count || !els.list || !els.form || !els.input ||
        !els.create || !els.status) return;
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = els.input.value.trim();
      if (!text || S.ideaPanel.busy || S.playback.mode !== 'live') return;
      mutateIdea(() => AU.rootTaskCreate(text), 'Idea created', true);
    });
  };

  A.handleRootTasksChanged = function handleRootTasksChanged() {
    if (S.ideaPanel.busy) {
      S.ideaPanel.refreshAfterBusy = true;
      return;
    }
    A.refreshIdeas();
  };

  /** @param {RootTasksSnapshot} result */
  function rootTaskItemsFrom(result) {
    if (!result || !Array.isArray(result.items)) return [];
    return result.items.filter((item) => item && typeof item.id === 'string' &&
      typeof item.text === 'string' && typeof item.phase === 'string' &&
      Number.isFinite(item.createdAt)).map((item) => ({
      id: item.id,
      text: item.text,
      projectId: typeof item.projectId === 'string' ? item.projectId : null,
      phase: item.phase,
      createdAt: item.createdAt,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : item.createdAt,
    })).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  A.refreshIdeas = async function refreshIdeas() {
    if (!S.ideaPanel.els || S.ideaPanel.busy) {
      if (S.ideaPanel.busy) S.ideaPanel.refreshAfterBusy = true;
      return;
    }
    const request = ++S.ideaPanel.request;
    /** @type {RootTasksSnapshot} */
    let result = null;
    try { result = await AU.rootTasksGet(); } catch (error) { /* retain the last good list */ }
    if (request !== S.ideaPanel.request || !result) return;
    S.ideaPanel.items = rootTaskItemsFrom(result);
    A.renderIdeas();
  };

  function liveIdeaProjects() {
    return [...S.store.projects.values()]
      .filter((project) => project && project.exists === true)
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)) ||
        String(a.id).localeCompare(String(b.id)));
  }

  function ideaPhaseMeta(phase) {
    if (phase === 'ready-for-review') return { label: 'Ready for review', css: 'ready-for-review' };
    if (phase === 'agent-working' || phase === 'waiting-for-agent' || phase === 'running') {
      return { label: 'Agent working', css: 'working' };
    }
    if (phase === 'launch-requested') return { label: 'Start requested', css: 'working' };
    if (phase === 'launch-failed') return { label: 'Start failed', css: 'failed' };
    if (phase === 'agent-aborted') return { label: 'Agent stopped', css: 'failed' };
    if (phase === 'agent-departed') return { label: 'Agent lost', css: 'failed' };
    if (phase === 'agent-not-found') return { label: 'Agent not found', css: 'failed' };
    if (phase === 'completion-failed') return { label: 'Completion failed', css: 'failed' };
    if (phase === 'prepared' || phase === 'goal-written') return { label: 'Assigned', css: '' };
    if (phase === 'reopened') return { label: 'Reopened', css: '' };
    return { label: 'Idea', css: '' };
  }

  function retryableIdeaPhase(phase) {
    return phase === 'launch-failed' || phase === 'agent-aborted' ||
      phase === 'agent-departed' || phase === 'agent-not-found' ||
      phase === 'prepared' || phase === 'goal-written' || phase === 'reopened';
  }

  function ideaRenderKey(items, projects) {
    const itemState = items.map((item) => [
      item.id, item.projectId, item.phase, item.createdAt, item.updatedAt,
    ]);
    const projectState = projects.map((project) => [
      project.id, project.name, project.path, A.projectGalaxyLabel(project), project.exists,
    ]);
    return JSON.stringify([S.ideaPanel.visibleLimit, itemState, projectState]);
  }

  function retryIdeaCopy(phase) {
    if (phase === 'prepared') return 'Assignment needs to resume before the goal is confirmed';
    if (phase === 'goal-written') return 'Goal is ready in GOALS.md';
    if (phase === 'reopened') return 'Goal was reopened after review';
    return 'Goal remains in GOALS.md';
  }

  function ideaMutationsDisabled() {
    return S.ideaPanel.busy || S.playback.mode !== 'live' || S.replayTransitionPending;
  }

  function ideaFocusedControl(list) {
    const active = document.activeElement;
    if (!active || !list.contains(active)) {
      return { id: null, action: null, scrollTop: list.scrollTop };
    }
    const row = /** @type {HTMLElement | null} */ (active.closest('.idea-row'));
    return {
      id: row ? row.dataset.ideaId : null,
      action: /** @type {HTMLElement} */ (active).dataset.ideaAction || null,
      scrollTop: list.scrollTop,
    };
  }

  function ideaRowById(list, id) {
    if (!id) return null;
    return [...list.querySelectorAll('.idea-row')]
      .find((row) => row.dataset.ideaId === id) || null;
  }

  function restoreIdeaFocus(list, previous) {
    const requested = S.ideaPanel.focusAfterRender;
    S.ideaPanel.focusAfterRender = null;
    const targetState = requested || previous;
    if (previous && Number.isFinite(previous.scrollTop)) list.scrollTop = previous.scrollTop;
    if (!targetState) return;
    if (!targetState.id && targetState.action === 'idea-input') {
      if (S.ideaPanel.els && S.ideaPanel.els.input) {
        S.ideaPanel.els.input.focus({ preventScroll: true });
      }
      return;
    }
    if (!targetState.id && targetState.action === 'show-more') {
      const showMore = list.querySelector('[data-idea-action="show-more"]');
      if (showMore) showMore.focus({ preventScroll: true });
      return;
    }
    if (!targetState.id) return;
    const row = ideaRowById(list, targetState.id);
    if (!row) return;
    const controls = [...row.querySelectorAll('[data-idea-action]')];
    const target = controls.find((control) => control.dataset.ideaAction === targetState.action) ||
      row.querySelector('.idea-text');
    if (!target || typeof target.focus !== 'function') return;
    target.focus({ preventScroll: true });
    if (requested && requested.reveal && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateIdeaMutationControls(list, disabled, projectCount) {
    for (const row of list.querySelectorAll('.idea-row')) {
      const select = row.querySelector('.idea-select');
      const assign = row.querySelector('[data-idea-action="assign"]');
      const retry = row.querySelector('[data-idea-action="retry"]');
      const remove = row.querySelector('[data-idea-action="remove"]');
      if (select) select.disabled = disabled || projectCount === 0;
      if (assign) {
        assign.disabled = !select || !select.value;
        assign.setAttribute('aria-disabled', String(disabled));
      }
      if (retry) {
        retry.disabled = retry.dataset.unavailable === 'true';
        retry.setAttribute('aria-disabled', String(disabled));
      }
      if (remove) remove.disabled = disabled;
    }
  }

  A.renderIdeas = function renderIdeas() {
    const els = S.ideaPanel.els;
    if (!els || !els.panel) return;
    const projects = liveIdeaProjects();
    const replay = S.playback.mode !== 'live' || S.replayTransitionPending;
    const disabled = ideaMutationsDisabled();
    els.panel.classList.toggle('is-empty', S.ideaPanel.items.length === 0);
    els.panel.setAttribute('aria-busy', String(S.ideaPanel.busy));
    els.count.textContent = `${S.ideaPanel.items.length} idea${S.ideaPanel.items.length === 1 ? '' : 's'}`;
    if (S.commandRail.els && S.commandRail.els.ideasCompactCount) {
      S.commandRail.els.ideasCompactCount.textContent = String(S.ideaPanel.items.length);
    }
    const nextRenderKey = ideaRenderKey(S.ideaPanel.items, projects);
    if (nextRenderKey !== S.ideaPanel.renderKey) {
      const previousFocus = ideaFocusedControl(els.list);
      S.ideaPanel.renderKey = nextRenderKey;
      AUR.clear(els.list);
      if (S.ideaPanel.items.length === 0) {
        els.list.appendChild(AUR.el(
          'div', 'empty-note', 'Capture an idea, then assign it to a project'
        ));
      } else {
        const visibleItems = S.ideaPanel.items.slice(0, S.ideaPanel.visibleLimit);
        for (const item of visibleItems) {
          const row = AUR.el('article', 'idea-row');
          row.dataset.ideaId = item.id;
          const heading = AUR.el('div', 'idea-heading');
          const taskText = AUR.el('div', 'idea-text', item.text);
          taskText.id = `idea-text-${item.id}`;
          taskText.tabIndex = -1;
          heading.appendChild(taskText);
          const meta = ideaPhaseMeta(item.phase);
          heading.appendChild(AUR.el('span', `idea-phase ${meta.css}`.trim(), meta.label));
          if (item.phase === 'idea') {
            const remove = AUR.el('button', 'idea-remove', '×');
            remove.type = 'button';
            remove.dataset.ideaAction = 'remove';
            remove.setAttribute('aria-label', 'Remove idea');
            remove.setAttribute('aria-describedby', taskText.id);
            remove.title = 'Remove idea';
            remove.addEventListener('click', () => {
              if (ideaMutationsDisabled() ||
                  !A.confirmRemoval('Remove this unassigned idea?', item.text)) return;
              if (!ideaMutationsDisabled()) removeIdea(item);
            });
            heading.appendChild(remove);
          }
          row.appendChild(heading);

          const assigned = item.projectId ? S.store.projects.get(item.projectId) : null;
          const assignedAvailable = Boolean(assigned && assigned.exists === true);
          if (item.projectId) {
            row.appendChild(AUR.el(
              'div', 'idea-project', assignedAvailable
                ? assigned.name : 'Assigned project unavailable'
            ));
          }

          if (item.phase === 'idea') {
            const controls = AUR.el('div', 'idea-controls');
            const select = document.createElement('select');
            select.className = 'idea-select';
            select.dataset.ideaAction = 'select';
            select.setAttribute('aria-label', 'Project or star system');
            select.setAttribute('aria-describedby', taskText.id);
            select.appendChild(new Option('Choose project…', ''));
            for (const project of projects) {
              const name = project.name || project.id;
              const detail = A.projectSearchSubtitle(project);
              select.appendChild(new Option(detail ? `${name} — ${detail}` : name, project.id));
            }
            const selected = S.ideaPanel.selections.get(item.id) || '';
            if (projects.some((project) => project.id === selected)) select.value = selected;
            select.addEventListener('change', () => {
              S.ideaPanel.selections.set(item.id, select.value);
              action.disabled = !select.value;
            });
            const action = AUR.el('button', 'idea-action', 'Assign & start');
            action.type = 'button';
            action.dataset.ideaAction = 'assign';
            action.setAttribute('aria-describedby', taskText.id);
            action.addEventListener('click', () => {
              if (!ideaMutationsDisabled()) assignIdea(item.id, select.value);
            });
            controls.appendChild(select);
            controls.appendChild(action);
            row.appendChild(controls);
          } else if (retryableIdeaPhase(item.phase)) {
            const controls = AUR.el('div', 'idea-controls');
            controls.appendChild(AUR.el('span', 'idea-project', retryIdeaCopy(item.phase)));
            const retry = AUR.el('button', 'idea-action', 'Retry start');
            retry.type = 'button';
            retry.dataset.ideaAction = 'retry';
            retry.dataset.unavailable = String(!assignedAvailable);
            retry.setAttribute('aria-describedby', taskText.id);
            retry.addEventListener('click', () => {
              if (!ideaMutationsDisabled()) retryIdea(item.id);
            });
            controls.appendChild(retry);
            row.appendChild(controls);
          } else if (item.projectId &&
              (item.phase === 'ready-for-review' || item.phase === 'completion-failed')) {
            const controls = AUR.el('div', 'idea-controls');
            controls.appendChild(AUR.el('span', 'idea-project', 'Project task'));
            const view = AUR.el('button', 'idea-action', 'View project');
            view.type = 'button';
            view.dataset.ideaAction = 'view';
            view.setAttribute('aria-describedby', taskText.id);
            view.disabled = !assignedAvailable;
            view.addEventListener('click', () => A.jumpToProject(item.projectId));
            controls.appendChild(view);
            row.appendChild(controls);
          }
          els.list.appendChild(row);
        }
        if (visibleItems.length < S.ideaPanel.items.length) {
          const remaining = S.ideaPanel.items.length - visibleItems.length;
          const showMore = AUR.el(
            'button', 'idea-action idea-show-more',
            `Show ${Math.min(100, remaining)} more`
          );
          showMore.type = 'button';
          showMore.dataset.ideaAction = 'show-more';
          showMore.addEventListener('click', () => {
            const firstNewItem = S.ideaPanel.items[S.ideaPanel.visibleLimit];
            S.ideaPanel.visibleLimit += 100;
            S.ideaPanel.focusAfterRender = firstNewItem
              ? { id: firstNewItem.id, action: null, reveal: true } : null;
            S.ideaPanel.renderKey = '';
            A.renderIdeas();
          });
          els.list.appendChild(showMore);
        }
      }
      restoreIdeaFocus(els.list, previousFocus);
    }
    updateIdeaMutationControls(els.list, disabled, projects.length);
    els.input.disabled = false;
    els.input.readOnly = disabled;
    els.input.setAttribute('aria-disabled', String(disabled));
    els.create.disabled = false;
    els.create.setAttribute('aria-disabled', String(disabled));
    els.status.textContent = replay ? 'Return to LIVE to create or start tasks.' : S.ideaPanel.status;
    els.status.classList.toggle('error', !replay && S.ideaPanel.error);
  };

  function assignIdea(id, projectId) {
    if (!projectId) return;
    const project = S.store.projects.get(projectId);
    const label = project ? project.name : 'project';
    mutateIdea(() => AU.rootTaskAssign(id, projectId), `Assigned to ${label}; agent start requested`);
  }

  function retryIdea(id) {
    mutateIdea(() => AU.rootTaskRetry(id), 'Agent start requested again');
  }

  function removeIdea(item) {
    const index = S.ideaPanel.items.findIndex((entry) => entry.id === item.id);
    mutateIdea(() => AU.rootTaskRemove(item.id), 'Idea removed', false, () => {
      S.ideaPanel.selections.delete(item.id);
      S.ideaPanel.items = S.ideaPanel.items.filter((entry) => entry.id !== item.id);
      const next = S.ideaPanel.items[Math.min(index, S.ideaPanel.items.length - 1)] || null;
      S.ideaPanel.focusAfterRender = next
        ? { id: next.id, action: 'remove', reveal: true }
        : { id: null, action: 'idea-input' };
      S.ideaPanel.renderKey = '';
    });
  }

  /** @param {() => Promise<RootTaskResult>} operation */
  async function mutateIdea(operation, successText, clearInput = false, onSuccess = null) {
    if (S.ideaPanel.busy || S.playback.mode !== 'live' || S.replayTransitionPending) return;
    S.ideaPanel.busy = true;
    S.ideaPanel.refreshAfterBusy = false;
    S.ideaPanel.status = '';
    S.ideaPanel.error = false;
    A.renderIdeas();
    /** @type {RootTaskResult} */
    let result = null;
    try { result = await operation(); } catch (error) { /* bounded failure below */ }
    S.ideaPanel.busy = false;
    if (result && result.ok === true) {
      S.ideaPanel.status = successText;
      S.ideaPanel.error = false;
      if (clearInput && S.ideaPanel.els) S.ideaPanel.els.input.value = '';
      if (typeof onSuccess === 'function') onSuccess(result);
    } else {
      S.ideaPanel.status = ideaFailureText(result && result.code);
      S.ideaPanel.error = true;
    }
    const refreshAgain = S.ideaPanel.refreshAfterBusy;
    S.ideaPanel.refreshAfterBusy = false;
    A.renderIdeas();
    await A.refreshIdeas();
    if (refreshAgain) A.refreshIdeas();
  }

  function ideaFailureText(code) {
    if (code === 'REPLAY') return 'Return to LIVE before changing task ideas.';
    if (code === 'PROJECT_BUSY') return 'That project already has an agent working on a task.';
    if (code === 'UNAVAILABLE') return 'Codex was not found on this computer.';
    if (code === 'LAUNCH_FAILED') return 'Goal assigned, but the agent did not start. Retry when ready.';
    if (code === 'WRITE_FAILED') return 'The project goal could not be written.';
    if (code === 'PROJECT_NOT_FOUND') return 'That project is unavailable. Choose an existing project.';
    if (code === 'LIMIT_REACHED') return 'The task idea list is full.';
    if (code === 'NOT_FOUND') return 'That idea or project is no longer available.';
    if (code === 'BUSY') return 'That idea is already being updated.';
    if (code === 'INVALID_TRANSITION') return 'That idea can no longer be updated.';
    return 'The task idea could not be updated.';
  }

  A.confirmRemoval = function confirmRemoval(prompt, text) {
    const value = String(text || '');
    const summary = value.length > 160 ? value.slice(0, 157) + '…' : value;
    return window.confirm(`${prompt}\n\n${summary}\n\nThis cannot be undone.`);
  };
})();
