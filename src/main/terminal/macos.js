// @ts-check
'use strict';

const path = require('node:path');

async function focusMacTerminal(session, candidates, run) {
  if (candidates.length > 32) return 'AMBIGUOUS';
  const pids = new Set();
  for (const candidate of candidates) {
    try {
      const started = Date.parse(await run('/bin/ps', ['-p', String(candidate.pid), '-o', 'lstart=']));
      if (started <= candidate.startedAt && candidate.startedAt - started < 120_000) pids.add(candidate.pid);
    } catch { /* the registry outlives an exited process */ }
  }
  const registered = new Set(pids);
  if (!pids.size) {
    const owners = await run('/usr/sbin/lsof', ['-t', '--', session.transcriptPath]);
    for (const value of owners.split(/\s+/)) {
      if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) pids.add(Number(value));
    }
  }
  if (pids.size > 32) return 'AMBIGUOUS';
  const terminals = new Set();
  for (const pid of pids) {
    try {
      const command = await run('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
      const name = path.posix.basename(command);
      if (name !== session.provider && !(registered.has(pid) && name === 'node')) continue;
      const tty = await run('/bin/ps', ['-p', String(pid), '-o', 'tty=']);
      if (/^ttys?\d+$/.test(tty)) terminals.add(`/dev/${tty}`);
    } catch { /* exited or inaccessible */ }
  }
  if (terminals.size !== 1) return terminals.size > 1 ? 'AMBIGUOUS' : 'NOT_FOUND';
  return run('/usr/bin/osascript', [path.join(__dirname, 'macos.applescript'), [...terminals][0]]);
}

module.exports = { focusMacTerminal };
