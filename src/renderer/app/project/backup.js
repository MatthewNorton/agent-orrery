// @ts-check
// The settings dialog's backup section: save the universe to a file, or merge one back in.
'use strict';

/**
 * @import { UniverseExportResult, UniverseImportResult } from '../../../types/contract'
 */
/**
 * @template R
 * @typedef {{ prompt: string, call: () => Promise<R>, failed: string, canceled: string,
 *   done: (result: R) => string }} BackupAction
 */

(function () {
  const AUR = window.AUR;
  const AU = window.AU;
  const A = AUR.app;
  if (!A) throw new Error('app/state.js must load before app/project/backup.js');
  const S = A.state;

  // Called by A.wireProjectSettings once its own elements are found.
  A.wireUniverseBackup = function wireUniverseBackup() {
    const els = S.projectSettings.els;
    els.exportButton = document.getElementById('settings-export');
    els.importButton = document.getElementById('settings-import');
    els.backupStatus = document.getElementById('settings-backup-status');
    if (!els.exportButton || !els.importButton || !els.backupStatus) return;
    els.exportButton.addEventListener('click', () => runBackup(els.exportButton, EXPORT));
    els.importButton.addEventListener('click', () => runBackup(els.importButton, IMPORT));
  };

  A.setBackupStatus = function setBackupStatus(message, error = false) {
    S.projectSettings.backupStatus = message || '';
    S.projectSettings.backupError = Boolean(error);
  };

  const BACKUP_ERRORS = new Map([
    ['REPLAY', 'Return to LIVE before importing a backup.'],
    ['BUSY', 'Another file dialog is already open.'],
    ['INVALID', 'That file is not an Agent Orrery backup.'],
  ]);

  function counted(n, noun) {
    return `${n || 0} ${noun}${n === 1 ? '' : 's'}`;
  }

  /** @type {BackupAction<UniverseExportResult>} */
  const EXPORT = {
    prompt: 'Choose where to save the backup.',
    call: () => AU.universeExport(),
    failed: 'The backup could not be saved.',
    canceled: 'Export canceled.',
    done: (r) => `Saved ${counted(r.projects, 'project')} and ${counted(r.ideas, 'idea')} to ${r.path}.`,
  };

  /** @type {BackupAction<UniverseImportResult>} */
  const IMPORT = {
    prompt: 'Choose a backup file to merge in.',
    call: () => AU.universeImport(),
    failed: 'The backup could not be imported.',
    canceled: 'Import canceled. Nothing changed.',
    done: (r) => `Added ${counted(r.added, 'project')}, merged ${counted(r.merged, 'project')}` +
      ` and added ${counted(r.ideas, 'idea')}.`,
  };

  /**
   * @template {UniverseExportResult | UniverseImportResult} R
   * @param {HTMLButtonElement} button
   * @param {BackupAction<R>} action
   */
  async function runBackup(button, action) {
    const result = await A.runSettingsRequest(action.prompt, action.call, A.setBackupStatus);
    if (!result) return;
    if (result.ok !== true) {
      A.setBackupStatus(BACKUP_ERRORS.get(result.code) || action.failed, true);
    } else {
      A.setBackupStatus(result.canceled ? action.canceled : action.done(result));
    }
    A.renderProjectSettings();
    requestAnimationFrame(() => {
      if (S.projectSettings.open && !button.disabled) button.focus();
    });
  }

  /** @param {boolean} live */
  A.renderUniverseBackup = function renderUniverseBackup(live) {
    const els = S.projectSettings.els;
    if (!els || !els.exportButton || !els.importButton || !els.backupStatus) return;
    els.exportButton.disabled = S.projectSettings.busy || !live;
    els.importButton.disabled = S.projectSettings.busy || !live;
    els.backupStatus.textContent = S.projectSettings.backupStatus;
    els.backupStatus.classList.toggle('error', S.projectSettings.backupError);
  };
})();
