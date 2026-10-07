// @ts-check
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AU', /** @satisfies {import('./types/contract').AUBridge} */ ({
  snapshot: () => ipcRenderer.invoke('au:snapshot'),
  getSystem: (id) => ipcRenderer.invoke('au:system', id),
  getPlanet: (id, name) => ipcRenderer.invoke('au:planet', id, name),
  openProject: (id) => ipcRenderer.invoke('au:open', id),
  openExternal: (url) => ipcRenderer.invoke('au:open-external', url),
  openTerminal: (projectId) => ipcRenderer.invoke('au:open-terminal', projectId),
  tasksGet: (projectId) => ipcRenderer.invoke('au:tasks-get', projectId),
  taskAdd: (projectId, text) => ipcRenderer.invoke('au:task-add', projectId, text),
  taskSetDone: (projectId, request) => ipcRenderer.invoke('au:task-set-done', projectId, request),
  taskRemove: (projectId, request) => ipcRenderer.invoke('au:task-remove', projectId, request),
  onTasksChanged: (cb) => ipcRenderer.on('au:tasks-changed', (e, update) => cb(update)),
  rootTasksGet: () => ipcRenderer.invoke('au:root-tasks-get'),
  rootTaskCreate: (text) => ipcRenderer.invoke('au:root-task-create', text),
  rootTaskRemove: (taskId) => ipcRenderer.invoke('au:root-task-remove', taskId),
  rootTaskAssign: (taskId, projectId) => (
    ipcRenderer.invoke('au:root-task-assign', taskId, projectId)
  ),
  rootTaskRetry: (taskId) => ipcRenderer.invoke('au:root-task-retry', taskId),
  onRootTasksChanged: (cb) => (
    ipcRenderer.on('au:root-tasks-changed', (e, update) => cb(update))
  ),
  projectPathsScan: () => ipcRenderer.invoke('au:project-paths-scan'),
  projectPathLocate: (projectId) => ipcRenderer.invoke('au:project-path-locate', projectId),
  projectPathApply: (projectId, token) => (
    ipcRenderer.invoke('au:project-path-apply', projectId, token)
  ),
  onProjectVcsStatusChanged: (cb) => (
    ipcRenderer.on('au:project-vcs-status-changed', (e, status, meta) => cb(status, meta))
  ),
  replay: (command) => ipcRenderer.invoke('au:replay', command),
  onEvents: (cb) => ipcRenderer.on('au:events', (e, batch, meta) => cb(batch, meta)),
  onReplayState: (cb) => ipcRenderer.on('au:replay-state', (e, playback) => cb(playback)),
  onDebugView: (cb) => ipcRenderer.on('au:debug-view', (e, view) => cb(view)),
  debugReady: () => ipcRenderer.send('au:debug-ready'),
}));
