// @ts-check
// app-ideas.js — root task ideas (global IDEAS queue): loading and create/assign/retry/remove.
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

  A.assignIdea = function assignIdea(id, projectId) {
    if (!projectId) return;
    const project = S.store.projects.get(projectId);
    const label = project ? project.name : 'project';
    mutateIdea(() => AU.rootTaskAssign(id, projectId), `Assigned to ${label}; agent start requested`);
  };

  A.retryIdea = function retryIdea(id) {
    mutateIdea(() => AU.rootTaskRetry(id), 'Agent start requested again');
  };

  A.removeIdea = function removeIdea(item) {
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
  };

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
    // Security: a line break in the text could mimic the dialog's own copy.
    const value = String(text || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
    const summary = value.length > 160 ? value.slice(0, 157) + '…' : value;
    return window.confirm(`${prompt}\n\n${summary}\n\nThis cannot be undone.`);
  };
})();
