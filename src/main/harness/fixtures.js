'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createTerminalLauncher } = require('../terminal-launcher');

function createProviderFixture() {
  const providerFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-provider-render-'));
  const projectDir = path.join(providerFixtureRoot, 'workspace', 'provider-fixture');
  const claudeRoot = path.join(providerFixtureRoot, '.claude', 'projects');
  const codexRoot = path.join(providerFixtureRoot, '.codex', 'sessions');
  const signalRoot = path.join(providerFixtureRoot, 'signal-logs');
  const statePath = path.join(providerFixtureRoot, 'state', 'universe-state.json');
  const configPath = path.join(providerFixtureRoot, 'state', 'providers.json');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'fixture.js'), '/* provider fixture */\n');

  const claudeDir = path.join(claudeRoot, 'fixture-provider-project');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'claude-render.jsonl'), JSON.stringify({
    type: 'user', timestamp: new Date().toISOString(), cwd: projectDir,
    message: { role: 'user', content: 'fixture' },
  }) + '\n');

  const codexId = '019f0000-0000-7000-8000-000000000005';
  const codexDir = path.join(codexRoot, '2026', '07', '21');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, `rollout-2026-07-21T00-00-00-${codexId}.jsonl`),
    JSON.stringify({
      timestamp: new Date().toISOString(), type: 'session_meta',
      payload: { id: codexId, session_id: codexId, cwd: projectDir, source: 'cli' },
    }) + '\n'
  );

  fs.mkdirSync(signalRoot, { recursive: true });
  fs.writeFileSync(path.join(signalRoot, 'builder.log'), 'fixture\n');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    watch: [{ directory: signalRoot, projectPath: projectDir, label: 'Fixture' }],
  }));
  return {
    root: providerFixtureRoot,
    statePath,
    options: { claudeProjectsDir: claudeRoot, codexSessionsDir: codexRoot, providerConfigPath: configPath },
  };
}

function historyLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function createHistoryFixture() {
  const historyFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-history-render-'));
  const projectDir = path.join(historyFixtureRoot, 'workspace', 'history-fixture');
  const claudeRoot = path.join(historyFixtureRoot, '.claude', 'projects');
  const codexActive = path.join(historyFixtureRoot, '.codex', 'sessions');
  const codexArchive = path.join(historyFixtureRoot, '.codex', 'archived_sessions');
  const statePath = path.join(historyFixtureRoot, 'state', 'universe-state.json');
  const providerConfigPath = path.join(historyFixtureRoot, 'state', 'providers.json');
  const t0 = Date.now() - 12 * 60 * 1000;
  const iso = (offset) => new Date(t0 + offset).toISOString();

  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'live'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'fixture.js'), '// history fixture\n');

  const claudeDir = path.join(claudeRoot, 'fixture-history-project');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeFile = path.join(claudeDir, 'history-render.jsonl');
  fs.writeFileSync(claudeFile, [
    { type: 'user', timestamp: iso(0), cwd: projectDir,
      message: { role: 'user', content: 'private fixture prompt' } },
    { type: 'assistant', timestamp: iso(5_000), cwd: projectDir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'history-read',
        name: 'Read', input: { file_path: path.join(projectDir, 'src', 'fixture.js') } }] } },
    { type: 'user', timestamp: iso(8_000), cwd: projectDir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'history-read', content: 'private' }] } },
    { type: 'assistant', timestamp: iso(30_000), cwd: projectDir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'history-edit',
        name: 'Edit', input: { file_path: path.join(projectDir, 'src', 'historical.js'), new_string: 'private' } }] } },
    { type: 'user', timestamp: iso(35_000), cwd: projectDir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'history-edit', content: 'private' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: iso(600_000), cwd: projectDir },
  ].map(historyLine).join(''));

  const codexId = '019f0000-0000-7000-8000-000000000106';
  const codexDay = path.join(codexActive, '2026', '07', '21');
  fs.mkdirSync(codexDay, { recursive: true });
  fs.mkdirSync(codexArchive, { recursive: true });
  fs.writeFileSync(path.join(codexDay, `rollout-history-${codexId}.jsonl`), [
    { timestamp: iso(2_000), type: 'session_meta', payload: {
      id: codexId, session_id: codexId, cwd: projectDir, thread_source: 'user',
      base_instructions: 'private fixture instructions' } },
    { timestamp: iso(12_000), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: iso(40_000), type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'history-patch', name: 'apply_patch', input: 'private' } },
    { timestamp: iso(45_000), type: 'event_msg', payload: {
      type: 'patch_apply_end', call_id: 'history-patch', success: true,
      changes: { [path.join(projectDir, 'docs', 'history.md')]: { type: 'add', content: 'private' } } } },
    { timestamp: iso(50_000), type: 'event_msg', payload: {
      type: 'task_complete', last_agent_message: 'private' } },
  ].map(historyLine).join(''));

  return {
    root: historyFixtureRoot,
    projectDir,
    claudeFile,
    claudeRoot,
    t0,
    earlyTs: t0 + 10_000,
    lateTs: t0 + 60_000,
    forwardTs: t0 + 300_000,
    statePath,
    trackerOptions: {
      claudeProjectsDir: claudeRoot,
      codexSessionDirs: [codexActive, codexArchive],
      providerConfigPath,
    },
    replayOptions: {
      claudeProjectsDir: claudeRoot,
      codexSessionDirs: [codexActive, codexArchive],
    },
  };
}

function createControlFixture() {
  const fixture = createHistoryFixture();
  fixture.localAppData = path.win32.join(fixture.root, 'Local App Data & (Orbit)');
  return fixture;
}

function createRecordingTerminalLauncher(fixture) {
  const controlTerminalCalls = [];
  let controlTerminalUnrefs = 0;
  const fakeFs = {
    constants: { F_OK: fs.constants.F_OK },
    accessSync() { /* fixed app alias is deliberately intercepted */ },
  };
  const launcher = createTerminalLauncher({
    platform: 'win32',
    env: { LOCALAPPDATA: fixture.localAppData },
    fsImpl: fakeFs,
    spawnImpl(command, args, options) {
      controlTerminalCalls.push({
        command,
        args: Array.isArray(args) ? args.slice() : args,
        options: options && typeof options === 'object' ? { ...options } : options,
      });
      return {
        once() { return this; },
        unref() { controlTerminalUnrefs++; },
      };
    },
  });
  let delayFirstOpen = true;
  return Object.freeze({
    calls: controlTerminalCalls,
    get unrefs() { return controlTerminalUnrefs; },
    async open(request) {
      if (delayFirstOpen) {
        delayFirstOpen = false;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return launcher.open(request);
    },
  });
}

module.exports = {
  createProviderFixture,
  historyLine,
  createHistoryFixture,
  createControlFixture,
  createRecordingTerminalLauncher,
};
