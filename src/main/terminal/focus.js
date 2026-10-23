// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalProjectPath, isLocalProjectPath } = require('../provider-adapters');
const { runHelper } = require('./process');
const { focusMacTerminal } = require('./macos');

/**
 * @typedef {{ provider: string, sessionId: string, transcriptPath: string,
 *   registryDirectory?: string | null, cwd: string }} TerminalSession
 */

function createTerminalFocus({ platform = process.platform, env = process.env,
  fsImpl = fs, run = runHelper } = {}) {
  return {
    /** @param {TerminalSession} session */
    async focus(session) {
      if (!['win32', 'darwin'].includes(platform)) return { ok: false, code: 'UNAVAILABLE' };
      if (!validSession(session)) return { ok: false, code: 'INVALID' };
      try {
        if (!fsImpl.statSync(session.transcriptPath).isFile()) return missing();
        const candidates = registryCandidates(session, fsImpl);
        const deadline = Date.now() + 12_000;
        const boundedRun = (command, args, input = '') => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('Terminal lookup timed out');
          return run(command, args, input, remaining);
        };
        let result;
        if (platform === 'darwin') {
          result = await focusMacTerminal(session, candidates, boundedRun);
        } else {
          const root = env.SystemRoot;
          if (!isLocalProjectPath(root) || !path.win32.isAbsolute(root)) {
            return { ok: false, code: 'UNAVAILABLE' };
          }
          // Security: the helper is fixed; all session data travels as JSON on stdin,
          // never as PowerShell source, command arguments, or a renderer-supplied PID.
          result = await boundedRun(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'windows.ps1')],
            JSON.stringify({ transcriptPath: session.transcriptPath, provider: session.provider, candidates }));
        }
        if (result === 'FOCUSED') return { ok: true };
        if (result === 'AMBIGUOUS') return { ok: false, code: 'AMBIGUOUS' };
        if (result === 'BLOCKED') return { ok: false, code: 'TERMINAL_BLOCKED' };
        return missing();
      } catch {
        return missing();
      }
    },
  };
}

function missing() { return { ok: false, code: 'TERMINAL_NOT_FOUND' }; }

/** @param {TerminalSession} session */
function validSession(session) {
  return session && ['claude', 'codex'].includes(session.provider) &&
    typeof session.sessionId === 'string' && /^[\w-]{1,160}$/.test(session.sessionId) &&
    [session.cwd, session.transcriptPath].every((p) => isLocalProjectPath(p) && path.isAbsolute(p));
}

// Claude closes transcripts between writes; its own live-session registry supplies the PID.
// Codex holds its rollout open, so the OS can identify the exact owner of that file.
function registryCandidates(session, fsImpl) {
  const directory = session.registryDirectory;
  if (session.provider !== 'claude' || !isLocalProjectPath(directory) || !path.isAbsolute(directory)) return [];
  try {
    const candidates = [];
    for (const name of fsImpl.readdirSync(directory).slice(0, 4096)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const file = path.join(directory, name);
        if (fsImpl.statSync(file).size > 16_384) continue;
        const record = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        if (record.sessionId !== session.sessionId || !Number.isSafeInteger(record.pid) ||
            record.pid <= 0 || name !== `${record.pid}.json` ||
            !Number.isFinite(record.startedAt) || record.startedAt <= 0 ||
            canonicalProjectPath(record.cwd) !== canonicalProjectPath(session.cwd)) continue;
        candidates.push({ pid: record.pid, startedAt: record.startedAt });
      } catch { /* stale or partially written registry entry */ }
    }
    return candidates;
  } catch { return []; }
}

module.exports = { createTerminalFocus, registryCandidates };
