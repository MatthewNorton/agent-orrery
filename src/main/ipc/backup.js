// @ts-check
'use strict';

// Universe export and import (settings dialog). The file format and the merge live in
// live/backup.js; this side owns the file dialogs and the IDEAS queue.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../shared/atomic-write');
const { MAX_BACKUP_BYTES, parseBackup } = require('../live/backup');
const guards = require('./guards');

/** @import { BackupFailureCode, Failure, UniverseExportResult, UniverseImportResult } from '../../types/contract' */

const FILE_FILTERS = [{ name: 'Agent Orrery backup', extensions: ['json'] }];

/** @param {Pick<typeof import('electron'), 'app' | 'dialog'>} [electron] */
function createBackupIpc(ctx, electron = require('electron')) {
  const { app, dialog } = electron;
  let dialogInFlight = false;

  /** @returns {Failure<BackupFailureCode>} */
  function backupFailure(code) {
    return { ok: false, code };
  }

  /**
   * One file dialog at a time; `run` gets the chosen path and settles the result.
   * @template T
   * @param {() => Promise<string | null>} choose
   * @param {(file: string) => T} run
   * @returns {Promise<T | Failure<BackupFailureCode> | { ok: true, canceled: true }>}
   */
  async function withFileDialog(choose, run) {
    if (dialogInFlight) return backupFailure('BUSY');
    dialogInFlight = true;
    try {
      const file = await choose();
      return file ? run(file) : { ok: true, canceled: true };
    } catch {
      return backupFailure('FAILED');
    } finally {
      dialogInFlight = false;
    }
  }

  /** @returns {Promise<UniverseExportResult>} */
  async function handleUniverseExport(event) {
    if (!guards.trustedMainFrame(ctx, event)) return backupFailure('INVALID');
    if (!ctx.tracker) return backupFailure('FAILED');
    const day = new Date().toISOString().slice(0, 10);
    return withFileDialog(async () => {
      const selection = await dialog.showSaveDialog(ctx.win, {
        title: 'Export your universe',
        defaultPath: path.join(app.getPath('documents'), `agent-orrery-${day}.json`),
        filters: FILE_FILTERS,
      });
      return selection.canceled ? null : selection.filePath || null;
    }, (file) => {
      const backup = ctx.tracker.createBackup(ctx.rootTasks ? ctx.rootTasks.list() : []);
      writeFileAtomic(file, `${JSON.stringify(backup, null, 2)}\n`);
      return {
        ok: true, canceled: false, path: file,
        projects: Object.keys(backup.universe.projects).length, ideas: backup.ideas.length,
      };
    });
  }

  /** @returns {Promise<UniverseImportResult>} */
  async function handleUniverseImport(event) {
    if (!guards.trustedMainFrame(ctx, event)) return backupFailure('INVALID');
    if (!guards.showingLive(ctx)) return backupFailure('REPLAY');
    return withFileDialog(async () => {
      const selection = await dialog.showOpenDialog(ctx.win, {
        title: 'Import a universe backup',
        buttonLabel: 'Import',
        defaultPath: app.getPath('documents'),
        filters: FILE_FILTERS,
        properties: ['openFile'],
      });
      return selection.canceled ? null : selection.filePaths[0] || null;
    }, (file) => {
      if (!guards.showingLive(ctx)) return backupFailure('REPLAY');
      // Security: read only a plain file of bounded size, never through a link.
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_BACKUP_BYTES) return backupFailure('INVALID');
      const backup = parseBackup(fs.readFileSync(file, 'utf8'));
      if (!backup) return backupFailure('INVALID');
      const { added, merged } = ctx.tracker.importBackup(backup);
      return { ok: true, canceled: false, added, merged, ideas: importIdeas(backup.ideas) };
    });
  }

  // Ideas come back as new, unassigned items in one write, with one change notice.
  function importIdeas(ideas) {
    if (!ctx.rootTasks) return 0;
    let created;
    try { created = ctx.rootTasks.createMany(ideas); } catch { return 0; }
    if (created.length > 0) ctx.ipc.rootTasks.sendRootTasksChanged(created[created.length - 1], 'created');
    return created.length;
  }

  return { handleUniverseExport, handleUniverseImport };
}

module.exports = { createBackupIpc };
