// @ts-check
// Renders the IDEAS list: phase labels, assign/retry/view controls, focus restore.
'use strict';

(function () {
  const AUR = window.AUR;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/ideas-list.js');
  const S = A.state;

  function liveIdeaProjects() {
    return [...S.store.projects.values()]
      .filter((project) => project && project.exists === true)
      .sort((a, b) => A.byProjectName(a, b) || String(a.id).localeCompare(String(b.id)));
  }

  const WORKING = { label: 'Agent working', css: 'working' };
  const ASSIGNED = { label: 'Assigned', css: '' };
  const PHASE_META = new Map([
    ['ready-for-review', { label: 'Ready for review', css: 'ready-for-review' }],
    ['agent-working', WORKING], ['waiting-for-agent', WORKING], ['running', WORKING],
    ['launch-requested', { label: 'Start requested', css: 'working' }],
    ['launch-failed', { label: 'Start failed', css: 'failed' }],
    ['agent-aborted', { label: 'Agent stopped', css: 'failed' }],
    ['agent-departed', { label: 'Agent lost', css: 'failed' }],
    ['agent-not-found', { label: 'Agent not found', css: 'failed' }],
    ['completion-failed', { label: 'Completion failed', css: 'failed' }],
    ['prepared', ASSIGNED], ['goal-written', ASSIGNED],
    ['reopened', { label: 'Reopened', css: '' }],
  ]);
  const IDEA_META = { label: 'Idea', css: '' };

  function ideaPhaseMeta(phase) {
    return PHASE_META.get(phase) || IDEA_META;
  }

  // Anything not mid-start or mid-run can go; the coordinator refuses the rest.
  const UNREMOVABLE_PHASES = new Set([
    'launch-requested', 'agent-working', 'waiting-for-agent', 'running', 'completing',
  ]);
  const RETRYABLE_PHASES = new Set([
    'launch-failed', 'agent-aborted', 'agent-departed', 'agent-not-found',
    'prepared', 'goal-written', 'reopened',
  ]);

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

  function ideaButton(cls, text, action, describedBy, onClick) {
    const button = AUR.button(cls, text, onClick);
    button.dataset.ideaAction = action;
    if (describedBy) button.setAttribute('aria-describedby', describedBy);
    return button;
  }

  function ideaRow(item, projects) {
    const row = AUR.el('article', 'idea-row');
    row.dataset.ideaId = item.id;
    const heading = AUR.el('div', 'idea-heading');
    const taskText = AUR.el('div', 'idea-text', item.text);
    taskText.id = `idea-text-${item.id}`;
    taskText.tabIndex = -1;
    const meta = ideaPhaseMeta(item.phase);
    heading.append(taskText, AUR.el('span', `idea-phase ${meta.css}`.trim(), meta.label));
    if (!UNREMOVABLE_PHASES.has(item.phase)) {
      const prompt = item.projectId
        ? 'Remove this idea? Its unfinished GOALS.md entry is removed from the project too.'
        : 'Remove this unassigned idea?';
      // removeIdea refuses on its own; this check only spares the confirm dialog.
      const remove = ideaButton('idea-remove', '×', 'remove', null, () => {
        if (ideaMutationsDisabled() || !A.confirmRemoval(prompt, item.text)) return;
        A.removeIdea(item);
      });
      remove.setAttribute('aria-label', 'Remove idea');
      remove.setAttribute('aria-describedby', taskText.id);
      remove.title = 'Remove idea';
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
    const controls = ideaControls(item, taskText.id, assignedAvailable, projects);
    if (controls) row.appendChild(controls);
    return row;
  }

  // Assign while an idea, retry after a failed start, view once the project has the task.
  function ideaControls(item, describedBy, assignedAvailable, projects) {
    const controls = AUR.el('div', 'idea-controls');
    if (item.phase === 'idea') {
      const select = document.createElement('select');
      select.className = 'idea-select';
      select.dataset.ideaAction = 'select';
      select.setAttribute('aria-label', 'Project or star system');
      select.setAttribute('aria-describedby', describedBy);
      select.appendChild(new Option('Choose project…', ''));
      for (const project of projects) {
        const name = A.projectLabel(project);
        const detail = A.projectSearchSubtitle(project);
        select.appendChild(new Option(detail ? `${name} — ${detail}` : name, project.id));
      }
      const selected = S.ideaPanel.selections.get(item.id) || '';
      if (projects.some((project) => project.id === selected)) select.value = selected;
      const assign = ideaButton('idea-action', 'Assign & start', 'assign', describedBy,
        () => A.assignIdea(item.id, select.value));
      select.addEventListener('change', () => {
        S.ideaPanel.selections.set(item.id, select.value);
        assign.disabled = !select.value;
      });
      controls.append(select, assign);
    } else if (RETRYABLE_PHASES.has(item.phase)) {
      const retry = ideaButton('idea-action', 'Retry start', 'retry', describedBy,
        () => A.retryIdea(item.id));
      retry.dataset.unavailable = String(!assignedAvailable);
      controls.append(AUR.el('span', 'idea-project', retryIdeaCopy(item.phase)), retry);
    } else if (item.projectId &&
        (item.phase === 'ready-for-review' || item.phase === 'completion-failed')) {
      const view = ideaButton('idea-action', 'View project', 'view', describedBy,
        () => A.jumpToProject(item.projectId));
      view.disabled = !assignedAvailable;
      controls.append(AUR.el('span', 'idea-project', 'Project task'), view);
    } else {
      return null;
    }
    return controls;
  }

  function showMoreButton(remaining) {
    return ideaButton('idea-action idea-show-more', `Show ${Math.min(100, remaining)} more`,
      'show-more', null, () => {
        const firstNewItem = S.ideaPanel.items[S.ideaPanel.visibleLimit];
        S.ideaPanel.visibleLimit += 100;
        S.ideaPanel.focusAfterRender = firstNewItem
          ? { id: firstNewItem.id, action: null, reveal: true } : null;
        S.ideaPanel.renderKey = '';
        A.renderIdeas();
      });
  }

  A.renderIdeas = function renderIdeas() {
    const els = S.ideaPanel.els;
    if (!els || !els.panel) return;
    const projects = liveIdeaProjects();
    const replay = S.playback.mode !== 'live' || S.replayTransitionPending;
    const disabled = ideaMutationsDisabled();
    const count = S.ideaPanel.items.length;
    A.setRailCount('ideas', count, count === 0);
    els.panel.setAttribute('aria-busy', String(S.ideaPanel.busy));
    els.count.textContent = `${count} idea${count === 1 ? '' : 's'}`;
    const nextRenderKey = ideaRenderKey(S.ideaPanel.items, projects);
    if (nextRenderKey !== S.ideaPanel.renderKey) {
      const previousFocus = ideaFocusedControl(els.list);
      S.ideaPanel.renderKey = nextRenderKey;
      AUR.clear(els.list);
      if (count === 0) {
        els.list.appendChild(AUR.el(
          'div', 'empty-note', 'Capture an idea, then assign it to a project'
        ));
      } else {
        const visibleItems = S.ideaPanel.items.slice(0, S.ideaPanel.visibleLimit);
        for (const item of visibleItems) els.list.appendChild(ideaRow(item, projects));
        if (visibleItems.length < count) els.list.appendChild(showMoreButton(count - visibleItems.length));
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
})();
