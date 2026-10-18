// Item 05 gate: pure provider adapters, isolated multi-source tracker, and
// rendered provider identity. Run from anywhere; exit 0 = PASS, 1 = FAIL.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const failures = [];
const notes = [];
const SECRET = 'PRIVATE_TRANSCRIPT_SENTINEL_05';
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure/i;

function fail(id, message) { failures.push(`${id}: ${message}`); }
function same(actual, expected, label, id = 'V1') {
  try { assert.deepStrictEqual(actual, expected); }
  catch { fail(id, `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); }
}
function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { fail('V0', `missing ${rel}`); return ''; }
  return fs.readFileSync(file, 'utf8');
}
function countProviders(ships) {
  const out = { claude: 0, codex: 0, generic: 0 };
  for (const ship of ships || []) {
    if (Object.hasOwn(out, ship.provider)) out[ship.provider]++;
  }
  return out;
}
function signal(signals, type) { return signals.find((item) => item && item.type === type); }
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}
async function terminateTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      });
      killer.once('exit', resolve); killer.once('error', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if (error?.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }
}

const adapterRel = 'src/main/provider-adapters.js';
const adapterPath = path.join(root, adapterRel);
if (!fs.existsSync(adapterPath)) {
  console.log('\n============= PROVIDER GRADE =============');
  console.log(`FAIL  V0: missing ${adapterRel} — item 05 is not implemented`);
  process.exit(1);
}

// 2026-10-13: tracker.js is a facade over src/main/live and src/main/universe; read them together.
const trackerSource = ['src/main/tracker.js', ...['live', 'universe'].flatMap((dir) => {
  const full = path.join(root, 'src', 'main', dir);
  return fs.existsSync(full)
    ? fs.readdirSync(full).filter((f) => f.endsWith('.js')).sort().map((f) => `src/main/${dir}/${f}`) : [];
})].map(read).join('\n');
// Kit 14 (2026-10-01): main.js is split across src/main; grep the whole layer.
const mainSource = (function readMainLayer(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => e.isDirectory() ? [readMainLayer(path.join(dir, e.name))]
      : e.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : [])
    .join('\n');
})(path.join(root, 'src', 'main'));
const htmlSource = read('src/renderer/index.html');
// 2026-10-18: renderer files live in folders. A view's source is scene/<view>.js or scene/<view>/ plus
// the shared scene helpers and ship-assets*.js; util source is util.js plus util-*.js.
const rendererJs = fs.readdirSync(path.join(root, 'src', 'renderer'), { recursive: true })
  .map((f) => f.split(path.sep).join('/')).filter((f) => f.endsWith('.js')).sort();
const VIEWS = ['universe', 'system', 'planet'];
const viewSource = (view) => rendererJs.filter((f) => f.startsWith(`scene/${view}`) || f.startsWith('ship-assets') ||
  (f.startsWith('scene/') && !VIEWS.some((other) => f.startsWith(`scene/${other}`))))
  .map((f) => read(`src/renderer/${f}`)).join('\n');
const utilLayer = () => rendererJs.filter((f) => /^util(-[a-z0-9-]+)?\.js$/.test(f))
  .map((f) => read(`src/renderer/${f}`)).join('\n');
const utilSource = utilLayer();
// 2026-09-27 kit 13: app.js split into modules, under app/ since 2026-10-18; grep the whole app layer.
const appSource = fs.readdirSync(path.join(root, 'src', 'renderer', 'app'), { recursive: true })
  .filter((f) => f.endsWith('.js')).sort()
  .map((f) => read(path.join('src', 'renderer', 'app', f))).join('\n');
const universeSource = viewSource('universe');
const systemSource = viewSource('system');
const planetSource = viewSource('planet');
// 2026-10-14: style.css was split into styles/*.css; grep them all.
const styleSource = fs.readdirSync(path.join(root, 'src', 'renderer', 'styles'))
  .filter((f) => f.endsWith('.css')).sort()
  .map((f) => read(`src/renderer/styles/${f}`)).join('\n');
const docsSource = read('docs/MULTI-PROVIDER.md');

if (/MVP\s*·\s*CLAUDE ONLY/i.test(htmlSource) || !/MULTI-PROVIDER/.test(htmlSource)) {
  fail('V5', 'top badge was not retired to exact MULTI-PROVIDER text');
}
if (!/provider\s*:/.test(trackerSource) || !/provider-test/.test(mainSource)) {
  fail('V1', 'public provider field or isolated provider harness is not wired');
}
if (!/providerStats/.test(universeSource) || !/provider/i.test(utilSource) ||
    !/provider/i.test(appSource) || !/provider/i.test(styleSource)) {
  fail('V5', 'provider tint/tag/rendered proof wiring is incomplete');
}
if (![universeSource, systemSource, planetSource].every((source) => /provider/.test(source))) {
  fail('V5', 'one or more scenes do not pass provider identity to ship visuals');
}
if (!/providers\.json/.test(docsSource) || !/never\s+(launch|spawn)/i.test(docsSource)) {
  fail('V3', 'multi-provider documentation lacks config or passive-only boundary');
}

let adapters;
let Tracker;
try {
  adapters = require(adapterPath);
  ({ Tracker } = require(path.join(root, 'src', 'main', 'tracker.js')));
} catch (error) {
  fail('V0', `module load failed: ${error.stack || error}`);
}

if (adapters) {
  for (const name of ['canonicalProjectPath', 'codexRecordToSignals',
    'providerToolStatus', 'readGenericWatchConfig']) {
    if (typeof adapters[name] !== 'function') fail('V0', `${name} is not exported`);
  }
}

// Pure, privacy-sensitive adapter fixtures.
if (failures.length === 0) {
  const { canonicalProjectPath, codexRecordToSignals, providerToolStatus } = adapters;
  same(canonicalProjectPath('C:\\Repo\\App\\'), 'win:c:/repo/app', 'Windows canonical path');
  same(canonicalProjectPath('c:/repo/App'), 'win:c:/repo/app', 'mixed Windows canonical path');
  same(canonicalProjectPath('/opt/Acme/App/'), 'posix:/opt/Acme/App', 'POSIX canonical path');

  const mainMeta = codexRecordToSignals({
    timestamp: '2026-07-21T20:00:00.000Z', type: 'session_meta',
    payload: {
      session_id: '019f-provider-main', cwd: 'C:\\Repo\\App',
      thread_source: 'user', base_instructions: SECRET,
    },
  });
  const mainSession = signal(mainMeta, 'session');
  if (!mainSession || mainSession.sessionId !== '019f-provider-main' ||
      mainSession.cwd !== 'C:\\Repo\\App' || mainSession.kind !== 'main') {
    fail('V2', `bad main session signal ${JSON.stringify(mainMeta)}`);
  }
  const drone = signal(codexRecordToSignals({
    type: 'session_meta', payload: {
      id: '019f-provider-drone', cwd: '/repo/app', thread_source: 'subagent',
      agent_path: 'private/path',
    },
  }), 'session');
  if (!drone || drone.kind !== 'drone') fail('V2', 'Codex subagent did not normalize as drone');

  const started = signal(codexRecordToSignals({
    type: 'response_item', payload: {
      type: 'function_call', call_id: 'call-1', name: 'exec_command',
      arguments: JSON.stringify({ command: SECRET }),
    },
  }), 'tool-start');
  if (!started || started.callId !== 'call-1' || started.tool !== 'exec_command') {
    fail('V2', `bad tool-start ${JSON.stringify(started)}`);
  }
  const ended = signal(codexRecordToSignals({
    type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'call-1', output: SECRET,
    },
  }), 'tool-end');
  if (!ended || ended.callId !== 'call-1') fail('V2', 'bad tool-end signal');

  const buildSignals = codexRecordToSignals({
    type: 'event_msg', payload: {
      type: 'patch_apply_end', success: true, stdout: SECRET,
      changes: {
        'C:\\Repo\\App\\src\\a.js': { type: 'update', content: SECRET },
        'C:\\Repo\\App\\README.md': { type: 'add', content: SECRET },
      },
    },
  });
  const build = signal(buildSignals, 'build');
  if (!build || !Array.isArray(build.files) || build.files.length !== 2) {
    fail('V2', `bad patch build signal ${JSON.stringify(buildSignals)}`);
  }
  if (JSON.stringify([mainMeta, started, ended, buildSignals]).includes(SECRET)) {
    fail('V4', 'adapter leaked transcript/tool/patch content');
  }
  if (codexRecordToSignals({
    type: 'response_item', payload: { type: 'message', content: SECRET },
  }).length !== 0) fail('V4', 'message content produced a signal');
  if (codexRecordToSignals({
    type: 'event_msg', payload: { type: 'patch_apply_end', success: false,
      changes: { 'x.js': { content: SECRET } } },
  }).some((item) => item.type === 'build')) fail('V2', 'failed patch produced a build');

  same(signal(codexRecordToSignals({ type: 'event_msg', payload: {
    type: 'task_started', turn_id: 't1' } }), 'turn-start')?.type,
  'turn-start', 'task_started');
  same(signal(codexRecordToSignals({ type: 'event_msg', payload: {
    type: 'task_complete', last_agent_message: SECRET } }), 'turn-end')?.type,
  'turn-end', 'task_complete');

  const statusCases = [
    ['apply_patch', 'Building'], ['read_file', 'Exploring'],
    ['exec_command', 'Gathering Resources'], ['web_search', 'Scanning'],
    ['spawn_agent', 'Delegating'], ['update_plan', 'Planning'],
    ['unknown_tool', 'Working'],
  ];
  for (const [tool, expected] of statusCases) {
    same(providerToolStatus(tool), expected, `status ${tool}`, 'V2');
  }
}

// Real Tracker, isolated roots: same cwd must merge Claude + Codex while a
// generic watch creates a separate signal project. No real profile is read.
let unitRoot;
if (failures.length === 0) {
  try {
    unitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-provider-unit-'));
    const profile = path.join(unitRoot, 'profile');
    const sharedProject = path.join(unitRoot, 'workspace', 'shared-project');
    const signalProject = path.join(unitRoot, 'workspace', 'signal-project');
    const claudeRoot = path.join(profile, '.claude', 'projects');
    const codexRoot = path.join(profile, '.codex', 'sessions');
    const signalRoot = path.join(unitRoot, 'signal-logs');
    const statePath = path.join(unitRoot, 'state', 'universe-state.json');
    const configPath = path.join(unitRoot, 'state', 'providers.json');
    fs.mkdirSync(sharedProject, { recursive: true });
    fs.mkdirSync(signalProject, { recursive: true });
    fs.mkdirSync(signalRoot, { recursive: true });

    const claudeDir = path.join(claudeRoot, 'C--fixture-shared');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'claude-session.jsonl'), JSON.stringify({
      type: 'user', timestamp: new Date().toISOString(), cwd: sharedProject,
      message: { role: 'user', content: SECRET },
    }) + '\n');

    const codexDir = path.join(codexRoot, '2026', '07', '21');
    fs.mkdirSync(codexDir, { recursive: true });
    const codexFile = path.join(codexDir, 'rollout-provider-main.jsonl');
    fs.writeFileSync(codexFile, JSON.stringify({
      timestamp: new Date().toISOString(), type: 'session_meta',
      payload: { session_id: 'codex-unit-main', cwd: sharedProject,
        thread_source: 'user', base_instructions: SECRET },
    }) + '\n');

    fs.writeFileSync(path.join(signalRoot, 'agent.log'), SECRET + '\n');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ watch: [{
      directory: signalRoot, projectPath: signalProject, label: 'Fixture Agent',
    }] }));

    const tracker = new Tracker(statePath, {
      claudeProjectsDir: claudeRoot,
      codexSessionsDir: codexRoot,
      providerConfigPath: configPath,
    });
    const batches = [];
    tracker.on('events', (batch) => batches.push(batch));
    tracker.start();
    const initial = tracker.snapshot();
    const counts = countProviders(initial.ships);
    same(counts, { claude: 1, codex: 1, generic: 1 }, 'isolated provider counts', 'V3');
    if (initial.projects.length !== 2) {
      fail('V1', `shared cwd was not merged: ${initial.projects.length} projects`);
    }
    if (initial.ships.some((ship) => !['claude', 'codex', 'generic'].includes(ship.provider))) {
      fail('V1', 'snapshot contains a missing/invalid provider');
    }

    fs.appendFileSync(codexFile, [
      { timestamp: new Date().toISOString(), type: 'response_item', payload: {
        type: 'custom_tool_call', call_id: 'patch-unit', name: 'apply_patch',
        input: SECRET,
      } },
      { timestamp: new Date().toISOString(), type: 'event_msg', payload: {
        type: 'patch_apply_end', call_id: 'patch-unit', success: true,
        stdout: SECRET, changes: {
          [path.join(sharedProject, 'src', 'provider.js')]: {
            type: 'update', content: SECRET,
          },
        },
      } },
      { timestamp: new Date().toISOString(), type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'patch-unit', output: SECRET,
      } },
      { timestamp: new Date().toISOString(), type: 'event_msg', payload: {
        type: 'task_complete', last_agent_message: SECRET,
      } },
    ].map(JSON.stringify).join('\n') + '\n');
    tracker.pollFiles();
    tracker.stop();

    const events = batches.flat();
    const codexSpawn = events.find((event) =>
      event.type === 'ship-spawned' && event.ship?.provider === 'codex');
    const buildEvent = events.find((event) =>
      event.type === 'build' && event.shipId === codexSpawn?.ship?.id);
    if (!codexSpawn || !buildEvent || buildEvent.bucket !== 'src') {
      fail('V2', 'isolated Codex spawn/build vocabulary is incomplete');
    }
    if (JSON.stringify({ snapshot: tracker.snapshot(), events }).includes(SECRET)) {
      fail('V4', 'public snapshot/events leaked private transcript content');
    }
    notes.push('pure + isolated tracker fixtures passed');
  } catch (error) {
    fail('V3', error.stack || String(error));
  } finally {
    if (unitRoot) fs.rmSync(unitRoot, { recursive: true, force: true });
  }
}

// Dedicated real Electron proof. The product harness owns fixture creation so
// no real provider directory is touched.
let outDir;
let child;
if (failures.length === 0) {
  try {
    const outRoot = path.join(root, '.shots', 'providers');
    fs.mkdirSync(outRoot, { recursive: true });
    outDir = fs.mkdtempSync(path.join(outRoot, 'run-'));
    const electron = process.platform === 'win32'
      ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(root, 'node_modules', '.bin', 'electron');
    const startedAt = Date.now();
    child = spawn(electron, ['.', '--provider-test', `--provider-output=${outDir}`], {
      cwd: root, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
    child.stderr.on('data', (data) => { output += data; process.stderr.write(data); });
    const code = await withTimeout(new Promise((resolve) => {
      child.once('exit', resolve); child.once('error', () => resolve('spawn-error'));
    }), 75_000, 'timeout');
    if (code === 'timeout') await terminateTree(child);
    if (code !== 0) fail('V5', `provider Electron harness exited with ${code}`);
    const rendererErrors = output.split(/\r?\n/).filter((line) => ERROR_RE.test(line));
    if (rendererErrors.length) fail('V5', `renderer errors: ${rendererErrors.slice(0, 4).join(' | ')}`);

    const resultPath = path.join(outDir, 'result.json');
    if (!fs.existsSync(resultPath)) fail('V5', 'missing provider result.json');
    else {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      const metrics = result.providerMetrics || {};
      const publicCounts = metrics.publicProviderCounts || metrics.publicCounts || {};
      const meshCounts = metrics.meshProviderCounts || metrics.meshCounts || {};
      if (result.passed !== true || result.badgeText !== 'MULTI-PROVIDER') {
        fail('V5', `bad harness/badge result ${JSON.stringify(result.error || result.badgeText)}`);
      }
      for (const provider of ['claude', 'codex', 'generic']) {
        if (!(publicCounts[provider] >= 1) || !(meshCounts[provider] >= 1)) {
          fail('V5', `missing public/rendered ${provider} ship`);
        }
      }
      const tags = result.sidebarProviderTags || metrics.sidebarProviderTags || [];
      for (const label of ['CLAUDE', 'CODEX', 'SIGNAL']) {
        if (!tags.includes(label)) fail('V5', `missing sidebar provider tag ${label}`);
      }
      if (!(metrics.distinctProviderColors >= 3) ||
          (result.rendererErrors || []).length !== 0) {
        fail('V5', 'provider hull colors are not distinct or renderer errors were recorded');
      }
    }
    const screenshot = path.join(outDir, 'universe.png');
    if (!fs.existsSync(screenshot) || fs.statSync(screenshot).mtimeMs < startedAt ||
        fs.statSync(screenshot).size < 30 * 1024) {
      fail('V5', 'provider universe screenshot is missing, stale, or blank');
    }
    notes.push(`rendered artifacts ${outDir}`);
  } catch (error) {
    fail('V5', error.stack || String(error));
  } finally {
    await terminateTree(child);
  }
}

console.log('\n============= PROVIDER GRADE =============');
for (const note of notes) console.log(`INFO  ${note}`);
if (failures.length) {
  for (const item of failures) console.log(`FAIL  ${item}`);
  process.exit(1);
}
console.log('PASS  V1-V5 passive multi-provider checks green');
