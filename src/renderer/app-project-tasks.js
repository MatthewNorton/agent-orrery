// @ts-check
// app-project-tasks.js — per-project GOALS.md task panel.
'use strict';

/** @import { TaskMutationResult, TasksChangedPush, TasksSnapshot } from '../types/contract' */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;               // created by app-state.js; throw if missing
  if (!A) throw new Error('app-state.js must load before app-project-tasks.js');
  const S = A.state, C = A.const;

  // ---------- project tasks ----------
  /** @param {TasksChangedPush} update */
  A.handleTasksChanged = function handleTasksChanged(update) {
    if (!update || update.projectId !== S.taskPanel.projectId ||
        S.current.view !== 'system' || S.playback.mode !== 'live') return;
    if (S.taskPanel.saving) {
      S.taskPanel.refreshAfterSave = true;
      return;
    }
    refreshTasks(S.taskPanel.owner);
  };

  A.wireTasksPanel = function wireTasksPanel() {
    S.taskPanel.els = {
      panel: document.getElementById('tasks-panel'),
      count: document.getElementById('tasks-count'),
      list: document.getElementById('tasks-list'),
      form: document.getElementById('tasks-form'),
      input: document.getElementById('tasks-input'),
      add: document.getElementById('tasks-add'),
      status: document.getElementById('tasks-status'),
    };
    const els = S.taskPanel.els;
    if (!els.panel || !els.count || !els.list || !els.form || !els.input || !els.add ||
        !els.status) return;
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!S.taskPanel.trusted || S.taskPanel.saving) return;
      const text = els.input.value.trim();
      if (!text) return;
      addTask(text);
    });
  };

  A.stopTasksView = function stopTasksView() {
    S.taskPanel.owner++;
    S.taskPanel.request++;
    if (S.taskPanel.interval != null) clearInterval(S.taskPanel.interval);
    S.taskPanel.interval = null;
    S.taskPanel.projectId = null;
    S.taskPanel.items = [];
    S.taskPanel.trusted = false;
    S.taskPanel.saving = false;
    S.taskPanel.refreshAfterSave = false;
    S.taskPanel.status = '';
    S.taskPanel.error = false;
    S.taskPanel.focusAfterRender = null;
    if (S.taskPanel.els && S.taskPanel.els.panel) {
      S.taskPanel.els.panel.classList.add('hidden');
      S.taskPanel.els.panel.removeAttribute('aria-busy');
    }
  };

  A.startTasksView = function startTasksView(projectId) {
    S.taskPanel.projectId = projectId;
    const owner = S.taskPanel.owner;
    refreshTasks(owner);
    S.taskPanel.interval = setInterval(() => refreshTasks(owner), 10_000);
  };

  function taskOwnerIsActive(owner, projectId) {
    return owner === S.taskPanel.owner && S.current.view === 'system' &&
      S.current.projectId === projectId && S.taskPanel.projectId === projectId;
  }

  /** @param {TasksSnapshot | TaskMutationResult} result */
  function taskItemsFrom(result) {
    if (!result || !Array.isArray(result.items)) return [];
    return result.items.filter((item) => item && typeof item.text === 'string' &&
      typeof item.done === 'boolean').map((item) => {
      const next = { text: item.text, done: item.done };
      if (Number.isSafeInteger(item.line) && item.line >= 0) next.line = item.line;
      if (typeof item.id === 'string') next.id = item.id;
      if (item.agentStatus === 'agent-working' || item.agentStatus === 'ready-for-review') {
        next.agentStatus = item.agentStatus;
      }
      return next;
    });
  }

  async function refreshTasks(owner) {
    const projectId = S.taskPanel.projectId;
    if (!taskOwnerIsActive(owner, projectId) || S.taskPanel.saving) return;
    const request = ++S.taskPanel.request;
    /** @type {TasksSnapshot} */
    let result = null;
    try { result = await AU.tasksGet(projectId); } catch (error) { /* hidden on trust/read failure */ }
    if (!taskOwnerIsActive(owner, projectId) || request !== S.taskPanel.request) return;
    if (!result) {
      S.taskPanel.trusted = false;
      renderTasksPanel();
      return;
    }
    S.taskPanel.trusted = true;
    S.taskPanel.items = taskItemsFrom(result);
    renderTasksPanel();
  }

  async function addTask(text) {
    return mutateTasks(() => AU.taskAdd(S.taskPanel.projectId, text), true, {
      successText: 'Task added',
    });
  }

  async function setTaskDone(item, done) {
    const request = {
      ...(typeof item.id === 'string' ? { id: item.id } : { line: item.line }),
      text: item.text,
      done,
    };
    return mutateTasks(() => AU.taskSetDone(S.taskPanel.projectId, request), false);
  }

  async function removeTask(item, index) {
    if (item.id || !A.confirmRemoval('Remove this project task?', item.text)) return;
    const request = { line: item.line, text: item.text };
    return mutateTasks(() => AU.taskRemove(S.taskPanel.projectId, request), false, {
      successText: 'Task removed',
      failureText: 'The task could not be removed. Refresh and try again.',
      focusIndex: index,
    });
  }

  /** @param {() => Promise<TaskMutationResult>} operation */
  async function mutateTasks(operation, clearInput, options = {}) {
    const owner = S.taskPanel.owner;
    const projectId = S.taskPanel.projectId;
    if (!taskOwnerIsActive(owner, projectId) || !S.taskPanel.trusted || S.taskPanel.saving) return;
    S.taskPanel.saving = true;
    S.taskPanel.refreshAfterSave = false;
    S.taskPanel.status = '';
    S.taskPanel.error = false;
    const request = ++S.taskPanel.request;
    renderTasksPanel();
    /** @type {TaskMutationResult} */
    let result = null;
    try { result = await operation(); } catch (error) { /* refresh below */ }
    if (!taskOwnerIsActive(owner, projectId) || request !== S.taskPanel.request) return;
    S.taskPanel.saving = false;
    const refreshAfterSave = S.taskPanel.refreshAfterSave;
    S.taskPanel.refreshAfterSave = false;
    if (result && result.ok === true && Array.isArray(result.items)) {
      S.taskPanel.items = taskItemsFrom(result);
      if (clearInput && S.taskPanel.els) S.taskPanel.els.input.value = '';
      S.taskPanel.status = options.successText || '';
      if (Number.isSafeInteger(options.focusIndex)) {
        S.taskPanel.focusAfterRender = S.taskPanel.items.length > 0
          ? { index: Math.min(options.focusIndex, S.taskPanel.items.length - 1), action: 'remove' }
          : { action: 'input' };
      }
      renderTasksPanel();
      if (refreshAfterSave) refreshTasks(owner);
      return;
    }
    S.taskPanel.status = options.failureText || 'The task could not be updated.';
    S.taskPanel.error = true;
    if (Number.isSafeInteger(options.focusIndex)) {
      S.taskPanel.focusAfterRender = {
        index: Math.min(options.focusIndex, Math.max(0, S.taskPanel.items.length - 1)),
        action: 'remove',
      };
    }
    renderTasksPanel();
    refreshTasks(owner);
  }

  function taskFocusState(list) {
    const active = document.activeElement;
    if (!active || !list.contains(active)) return null;
    const row = /** @type {HTMLElement | null} */ (active.closest('.task-row'));
    const index = row ? Number.parseInt(row.dataset.taskIndex, 10) : Number.NaN;
    if (!Number.isSafeInteger(index)) return null;
    return {
      index,
      action: active.classList.contains('task-remove') ? 'remove' : 'toggle',
    };
  }

  function renderTasksPanel() {
    const els = S.taskPanel.els;
    if (!els || !els.panel) return;
    if (!S.taskPanel.trusted || S.current.view !== 'system' ||
        S.current.projectId !== S.taskPanel.projectId) {
      els.panel.classList.add('hidden');
      return;
    }

    els.panel.classList.remove('hidden');
    els.panel.setAttribute('aria-busy', String(S.taskPanel.saving));
    const done = S.taskPanel.items.filter((item) => item.done).length;
    els.count.textContent = `${done} / ${S.taskPanel.items.length} done`;
    const previousFocus = taskFocusState(els.list);
    const scrollTop = els.list.scrollTop;
    AUR.clear(els.list);
    if (S.taskPanel.items.length === 0) {
      els.list.appendChild(AUR.el('div', 'tasks-empty', 'No goals yet — add one'));
    } else {
      S.taskPanel.items.forEach((item, index) => {
        const row = AUR.el('div', 'task-row' + (item.done ? ' done' : ''));
        row.dataset.taskIndex = String(index);
        const toggle = AUR.el('button', 'task-toggle');
        toggle.type = 'button';
        toggle.disabled = S.taskPanel.saving;
        toggle.setAttribute('role', 'checkbox');
        toggle.setAttribute('aria-checked', String(item.done));
        toggle.appendChild(AUR.el('span', 'task-check', item.done ? '☑' : '☐'));
        const body = AUR.el('span', 'task-body');
        const taskText = AUR.el('span', 'task-text', item.text);
        taskText.id = `task-text-${index}`;
        body.appendChild(taskText);
        if (item.agentStatus) {
          const label = item.agentStatus === 'ready-for-review'
            ? 'Ready for review' : 'Agent working';
          body.appendChild(AUR.el('span', `task-status ${item.agentStatus}`, label));
        }
        toggle.appendChild(body);
        toggle.addEventListener('click', () => {
          setTaskDone(item, !item.done);
        });
        row.appendChild(toggle);
        if (!item.id) {
          const remove = AUR.el('button', 'task-remove', '×');
          remove.type = 'button';
          remove.disabled = S.taskPanel.saving;
          remove.setAttribute('aria-label', 'Remove task');
          remove.setAttribute('aria-describedby', taskText.id);
          remove.title = 'Remove task';
          remove.addEventListener('click', () => removeTask(item, index));
          row.appendChild(remove);
        }
        els.list.appendChild(row);
      });
    }
    els.status.textContent = S.taskPanel.status;
    els.status.classList.toggle('error', S.taskPanel.error);
    els.input.disabled = S.taskPanel.saving;
    els.add.disabled = S.taskPanel.saving;
    els.list.scrollTop = scrollTop;
    const requestedFocus = S.taskPanel.focusAfterRender;
    S.taskPanel.focusAfterRender = null;
    const focus = requestedFocus || previousFocus;
    if (focus) {
      const row = Number.isSafeInteger(focus.index)
        ? els.list.querySelector(`[data-task-index="${focus.index}"]`)
        : null;
      const target = focus.action === 'input'
        ? els.input
        : focus.action === 'remove'
          ? row && (row.querySelector('.task-remove') || row.querySelector('.task-toggle'))
          : row && (row.querySelector('.task-toggle') || row.querySelector('.task-remove'));
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
        if (requestedFocus && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'nearest' });
        }
      }
    }
    A.positionTasksPanel();
  }

  A.positionTasksPanel = function positionTasksPanel() {
    const els = S.taskPanel.els;
    if (!els || !els.panel || els.panel.classList.contains('hidden')) return;
    const project = document.getElementById('project-card');
    const summary = document.getElementById('summary-card');
    if (!project || project.classList.contains('hidden')) return;
    const top = Math.ceil(project.getBoundingClientRect().bottom + 12);
    const summaryTop = summary ? summary.getBoundingClientRect().top : window.innerHeight;
    const available = Math.max(154, Math.floor(summaryTop - top - 12));
    els.panel.style.top = top + 'px';
    els.panel.style.maxHeight = available + 'px';
  };
})();
