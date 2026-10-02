'use strict';

const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { scanProjectCandidates, isPathInside } = require('../project-paths');
const guards = require('./guards');
const { validProjectId } = guards;

function createProjectPathsIpc(ctx) {
  let projectPathDialogInFlight = false;
  let projectPathScanAbort = null;
  const projectPathCandidates = new Map();
  const PROJECT_PATH_CANDIDATE_TTL_MS = 10 * 60 * 1000;
  const trustedMainFrame = (event) => guards.trustedMainFrame(ctx, event);

  function projectPathFailure(code) {
    const allowed = new Set([
      'INVALID', 'REPLAY', 'BUSY', 'NOT_FOUND', 'NOT_MISSING',
      'IN_USE', 'EXPIRED', 'FAILED',
    ]);
    return { ok: false, code: allowed.has(code) ? code : 'FAILED' };
  }

  function projectPathRequestAllowed(event) {
    if (!trustedMainFrame(event)) return projectPathFailure('INVALID');
    if (!ctx.tracker || ctx.activeSource !== ctx.tracker || ctx.replay.replayBoundaryOperations > 0) {
      return projectPathFailure('REPLAY');
    }
    return null;
  }

  function missingLiveProject(projectId) {
    if (!validProjectId(projectId) || !ctx.tracker || !(ctx.tracker.projects instanceof Map)) return null;
    const project = ctx.tracker.projects.get(projectId);
    return project && project.exists === false ? project : null;
  }

  function nearestExistingDirectory(inputPath) {
    let candidate = typeof inputPath === 'string' && path.isAbsolute(inputPath)
      ? path.normalize(inputPath) : null;
    if (candidate) {
      try {
        if (!fs.statSync(candidate).isDirectory()) candidate = path.dirname(candidate);
      } catch {
        candidate = path.dirname(candidate);
      }
      while (candidate && path.isAbsolute(candidate)) {
        try {
          if (fs.statSync(candidate).isDirectory()) return candidate;
        } catch { /* keep walking toward the filesystem root */ }
        const parent = path.dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
      }
    }
    try {
      const documents = app.getPath('documents');
      if (documents && fs.statSync(documents).isDirectory()) return documents;
    } catch { /* dialog can choose its own default */ }
    return undefined;
  }

  function currentMissingProjects() {
    if (!ctx.tracker || !(ctx.tracker.projects instanceof Map)) return [];
    return [...ctx.tracker.projects.values()]
      .filter((project) => project && project.exists === false)
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }

  function pruneProjectPathCandidates() {
    const now = Date.now();
    for (const [token, candidate] of projectPathCandidates) {
      if (!candidate || candidate.expiresAt <= now) projectPathCandidates.delete(token);
    }
  }

  function revokeProjectPathCandidates(projectId) {
    for (const [token, candidate] of projectPathCandidates) {
      if (candidate && candidate.projectId === projectId) projectPathCandidates.delete(token);
    }
  }

  function sameFilesystemPath(left, right) {
    const a = path.normalize(left);
    const b = path.normalize(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  function pathRecoveryError(error) {
    return projectPathFailure(error && typeof error.code === 'string' ? error.code : 'FAILED');
  }

  async function handleProjectPathsScan(event) {
    const denied = projectPathRequestAllowed(event);
    if (denied) return denied;
    if (projectPathDialogInFlight) return projectPathFailure('BUSY');
    const projects = currentMissingProjects();
    if (projects.length === 0) {
      return { ok: true, canceled: false, root: null, directoriesVisited: 0, truncated: false, matches: [] };
    }

    projectPathDialogInFlight = true;
    try {
      const selection = await dialog.showOpenDialog(ctx.win, {
        title: 'Choose a folder to scan for moved projects',
        buttonLabel: 'Scan this folder',
        defaultPath: nearestExistingDirectory(projects[0].path),
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true };
      const afterSelectionDenied = projectPathRequestAllowed(event);
      if (afterSelectionDenied) return afterSelectionDenied;

      projectPathScanAbort = new AbortController();
      const result = await scanProjectCandidates(selection.filePaths[0], projects, {
        signal: projectPathScanAbort.signal,
      });
      const afterScanDenied = projectPathRequestAllowed(event);
      if (afterScanDenied) return afterScanDenied;
      const stillMissing = new Set(currentMissingProjects().map((project) => project.id));
      const scanId = crypto.randomUUID();
      const expiresAt = Date.now() + PROJECT_PATH_CANDIDATE_TTL_MS;
      projectPathCandidates.clear();
      const matches = result.matches.filter((match) => stillMissing.has(match.projectId)).map((match) => ({
        projectId: match.projectId,
        candidates: match.candidates.map((candidatePath) => {
          const token = crypto.randomUUID();
          projectPathCandidates.set(token, {
            scanId,
            projectId: match.projectId,
            path: candidatePath,
            root: result.root,
            expiresAt,
          });
          return { token, path: candidatePath };
        }),
      }));
      return {
        ok: true,
        canceled: false,
        scanId,
        root: result.root,
        directoriesVisited: result.directoriesVisited,
        truncated: result.truncated,
        matches,
      };
    } catch (error) {
      return pathRecoveryError(error);
    } finally {
      projectPathScanAbort = null;
      projectPathDialogInFlight = false;
    }
  }

  async function handleProjectPathLocate(event, projectId) {
    const denied = projectPathRequestAllowed(event);
    if (denied) return denied;
    if (!validProjectId(projectId)) return projectPathFailure('INVALID');
    if (!ctx.tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
    const project = missingLiveProject(projectId);
    if (!project) return projectPathFailure('NOT_MISSING');
    if (projectPathDialogInFlight) return projectPathFailure('BUSY');

    projectPathDialogInFlight = true;
    try {
      const selection = await dialog.showOpenDialog(ctx.win, {
        title: `Locate ${project.name || 'project'}`,
        buttonLabel: 'Use this folder',
        defaultPath: nearestExistingDirectory(project.path),
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true };
      const afterSelectionDenied = projectPathRequestAllowed(event);
      if (afterSelectionDenied) return afterSelectionDenied;
      if (!ctx.tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
      if (!missingLiveProject(projectId)) return projectPathFailure('NOT_MISSING');
      const recovered = ctx.tracker.remapProjectPath(projectId, selection.filePaths[0]);
      revokeProjectPathCandidates(projectId);
      return { ok: true, canceled: false, project: recovered };
    } catch (error) {
      return pathRecoveryError(error);
    } finally {
      projectPathDialogInFlight = false;
    }
  }

  function handleProjectPathApply(event, projectId, token) {
    const denied = projectPathRequestAllowed(event);
    if (denied) return denied;
    if (!validProjectId(projectId) || typeof token !== 'string' || !token || token.length > 128) {
      return projectPathFailure('INVALID');
    }
    if (!ctx.tracker.projects.has(projectId)) return projectPathFailure('NOT_FOUND');
    if (!missingLiveProject(projectId)) return projectPathFailure('NOT_MISSING');
    pruneProjectPathCandidates();
    const candidate = projectPathCandidates.get(token);
    if (!candidate || candidate.projectId !== projectId) return projectPathFailure('EXPIRED');

    try {
      const realRoot = path.normalize(fs.realpathSync.native(candidate.root));
      const realCandidate = path.normalize(fs.realpathSync.native(candidate.path));
      if (!sameFilesystemPath(realRoot, candidate.root) ||
          !sameFilesystemPath(realCandidate, candidate.path) ||
          !fs.statSync(realCandidate).isDirectory() || !isPathInside(realRoot, realCandidate)) {
        return projectPathFailure('INVALID');
      }
      const project = ctx.tracker.remapProjectPath(projectId, realCandidate);
      revokeProjectPathCandidates(projectId);
      return { ok: true, canceled: false, project };
    } catch (error) {
      return pathRecoveryError(error);
    }
  }

  function reset() {
    if (projectPathScanAbort) projectPathScanAbort.abort();
    projectPathScanAbort = null;
    projectPathDialogInFlight = false;
    projectPathCandidates.clear();
  }

  return {
    handleProjectPathsScan,
    handleProjectPathLocate,
    handleProjectPathApply,
    revokeProjectPathCandidates,
    reset,
  };
}

module.exports = { createProjectPathsIpc };
