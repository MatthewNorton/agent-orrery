'use strict';

const path = require('path');
const { wait } = require('./driver');

function createMetrics(ctx, driver) {
  const { rendererEval, elementCenter, clickPoint } = driver;

  async function readHistoryMetrics() {
    return rendererEval(`(() => typeof AUR.historyTestMetrics === 'function'
      ? AUR.historyTestMetrics() : null)()`);
  }

  async function waitForHistory(predicate, label, timeoutMs = 12_000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
      try { last = await readHistoryMetrics(); } catch { /* renderer transition */ }
      if (last && predicate(last)) return last;
      await wait(25);
    }
    throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  }

  async function clickHistoryControl(selector) {
    const point = await elementCenter(selector);
    if (!point) throw new Error(`history control unavailable: ${selector}`);
    clickPoint(point);
    return point;
  }

  async function historyScrubberPoint(timestamp) {
    return rendererEval(`(() => {
      const el = document.getElementById('history-scrubber');
      if (!el || el.disabled) return null;
      const rect = el.getBoundingClientRect();
      const min = Number(el.dataset.minTs), max = Number(el.dataset.maxTs);
      const ts = ${JSON.stringify(timestamp)};
      const ratio = max > min ? Math.max(0, Math.min(1, (ts - min) / (max - min))) : 0;
      return {
        x: Math.round(rect.left + 8 + ratio * Math.max(1, rect.width - 16)),
        y: Math.round(rect.top + rect.height / 2), min, max,
      };
    })()`);
  }

  async function scrubHistory(timestamp) {
    const target = await historyScrubberPoint(timestamp);
    if (!target) throw new Error('history scrubber was disabled');
    clickPoint(target);
    return target;
  }

  async function dragHistory(fromTimestamp, toTimestamp, moveCount = 80) {
    return rendererEval(`new Promise((resolve, reject) => {
      const el = document.getElementById('history-scrubber');
      if (!el || el.disabled) { reject(new Error('history scrubber was disabled')); return; }
      const minTs = Number(el.dataset.minTs), maxTs = Number(el.dataset.maxTs);
      const sliderMin = Number(el.min), sliderMax = Number(el.max);
      const position = (ts) => sliderMin + Math.max(0, Math.min(1,
        (ts - minTs) / Math.max(1, maxTs - minTs))) * (sliderMax - sliderMin);
      const start = position(${JSON.stringify(fromTimestamp)});
      const end = position(${JSON.stringify(toTimestamp)});
      const count = ${JSON.stringify(moveCount)};
      let index = 0;
      const frame = () => {
        // Several pointer samples can arrive inside one display frame. Dispatch
        // them in groups to prove the preview renderer coalesces that workload.
        for (let sample = 0; sample < 4 && index < count; sample++) {
          index++;
          el.value = String(start + (end - start) * (index / count));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (index < count) requestAnimationFrame(frame);
        else {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          resolve({ start, end, moveCount: count });
        }
      };
      requestAnimationFrame(frame);
    })`);
  }

  function snapshotBuilds(snapshot) {
    const project = snapshot && Array.isArray(snapshot.projects) ? snapshot.projects[0] : null;
    return {
      total: project ? project.totalBuilds || 0 : 0,
      buckets: project && project.buckets ? { ...project.buckets } : {},
    };
  }

  function liveTrackerBuilds() {
    const project = ctx.tracker && ctx.tracker.projects instanceof Map
      ? [...ctx.tracker.projects.values()][0]
      : null;
    return {
      total: project ? project.totalBuilds || 0 : 0,
      buckets: project && project.buckets ? { ...project.buckets } : {},
    };
  }

  async function readControlMetrics() {
    return rendererEval(`(() => {
      const button = document.getElementById('project-terminal');
      const status = document.getElementById('project-control-status');
      const card = document.getElementById('project-card');
      const scene = BABYLON.EngineStore.LastCreatedScene;
      const visible = (el) => Boolean(el && !el.classList.contains('hidden') &&
        getComputedStyle(el).display !== 'none');
      const bounds = (el) => {
        if (!visible(el)) return null;
        const rect = el.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height };
      };
      const intersects = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left &&
        a.top < b.bottom && a.bottom > b.top);
      const targetRects = [bounds(button), bounds(status)].filter(Boolean);
      const blockerIds = ['back-btn', 'sidebar', 'summary-card', 'planet-card', 'tabbar', 'history-bar'];
      const overlapIds = [];
      for (const id of blockerIds) {
        const blocker = bounds(document.getElementById(id));
        if (targetRects.some((target) => intersects(target, blocker))) overlapIds.push(id);
      }
      let clippedCount = 0;
      for (const rect of targetRects) {
        if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 ||
            rect.right > innerWidth || rect.bottom > innerHeight) clippedCount++;
      }
      const forbiddenText = card ? /(?:Launch|New)\\s+(?:Claude|Codex)|prompt|resume/i.test(card.textContent) : false;
      const forbiddenInputs = card ? card.querySelectorAll('select,textarea,input').length : 0;
      return {
        view: scene && scene.metadata ? scene.metadata.view : null,
        ids: ['project-terminal', 'project-control-status'].filter((id) => document.getElementById(id)),
        exactText: button ? button.textContent.trim() : null,
        disabled: button ? button.disabled : null,
        busy: button ? button.getAttribute('aria-busy') === 'true' : null,
        state: button ? button.dataset.state || '' : '',
        note: status ? status.textContent.trim() : null,
        terminalCount: document.querySelectorAll('#project-terminal').length,
        overlapIds,
        overlapCount: overlapIds.length,
        clippedCount,
        noProviderOrPromptControls: !forbiddenText && forbiddenInputs === 0,
      };
    })()`);
  }

  async function waitForControl(predicate, label, timeoutMs = 10_000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
      try { last = await readControlMetrics(); } catch { /* renderer transition */ }
      if (last && predicate(last)) return last;
      await wait(30);
    }
    throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  }

  function safeRecordedTerminalCalls(cwd) {
    if (!ctx.harness.controlFixture || ctx.terminalLauncher.calls.length === 0) return false;
    const expectedCommand = path.win32.join(
      ctx.harness.controlFixture.localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'
    );
    const optionKeys = ['cwd', 'detached', 'shell', 'stdio', 'windowsHide'];
    return ctx.terminalLauncher.calls.every((call) => call && call.command === expectedCommand &&
      Array.isArray(call.args) && call.args.length === 2 && call.args[0] === '-d' &&
      call.args[1] === cwd && call.options && call.options.cwd === cwd &&
      call.options.shell === false && call.options.detached === true &&
      call.options.stdio === 'ignore' && call.options.windowsHide === false &&
      Object.keys(call.options).sort().join('|') === optionKeys.sort().join('|'));
  }

  return {
    readHistoryMetrics,
    waitForHistory,
    clickHistoryControl,
    historyScrubberPoint,
    scrubHistory,
    dragHistory,
    snapshotBuilds,
    liveTrackerBuilds,
    readControlMetrics,
    waitForControl,
    safeRecordedTerminalCalls,
  };
}

module.exports = { createMetrics };
