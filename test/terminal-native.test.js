'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./support/main-wiring');

test('Windows native discovery compiles, identifies the exact open file owner and rejects PID reuse',
  { skip: process.platform !== 'win32' }, (t) => {
    const dir = tempDir(t, 'au-terminal-native-');
    const file = path.join(dir, 'rollout-\u03a9-\u65e5\u672c.jsonl');
    const fd = fs.openSync(file, 'a');
    t.after(() => fs.closeSync(fd));
    // Read-only native integration: no existing terminal is focused or modified.
    const script = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
      $refs = @('System.dll', ([System.Windows.Automation.AutomationElement]).Assembly.Location,
        ([System.Windows.Automation.ControlType]).Assembly.Location, ([System.Windows.Point]).Assembly.Location)
      [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
      $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
      Add-Type -Path $data.source -ReferencedAssemblies $refs
      $owners = @([Orrery.TerminalFocus]::FileOwners($data.file))
      @{
        matched = [Orrery.TerminalFocus]::Matches($data.pid, 'codex', $data.startedAt, 0)
        stale = [Orrery.TerminalFocus]::Matches($data.pid, 'codex', 1, 0)
        owners = @($owners | ForEach-Object { $_.Pid })
        verified = @($owners | ForEach-Object { [Orrery.TerminalFocus]::Matches($_.Pid, 'node', 0, $_.Start) })
        mistakenForCodex = @($owners | ForEach-Object { [Orrery.TerminalFocus]::Matches($_.Pid, 'codex', 0, $_.Start) })
      } | ConvertTo-Json -Compress
    `;
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, shell: false, encoding: 'utf8', timeout: 20_000,
        input: JSON.stringify({ file, pid: process.pid, startedAt: Date.now(),
          source: path.join(__dirname, '../src/main/terminal/windows-native.cs') }),
      });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.matched, true);
    assert.equal(outcome.stale, false);
    assert.deepEqual(outcome.owners, [process.pid]);
    assert.deepEqual(outcome.verified, [true]);
    assert.deepEqual(outcome.mistakenForCodex, [false]);
  });
