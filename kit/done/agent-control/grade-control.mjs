// Item 07 gate: safe live-only Windows Terminal action plus real rendered proof.
// Run from anywhere; exit 0 = PASS, 1 = FAIL.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const failures = [];
const notes = [];
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure/i;
const launcherRel = 'src/main/terminal-launcher.js';
const launcherPath = path.join(root, launcherRel);

function fail(id, message) { failures.push(`${id}: ${message}`); }
function same(actual, expected, label, id = 'C2') {
  try { assert.deepStrictEqual(actual, expected); }
  catch { fail(id, `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); }
}
function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { fail('C0', `missing ${rel}`); return ''; }
  return fs.readFileSync(file, 'utf8');
}
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
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error?.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
}
async function failureCode(operation) {
  try {
    const result = await operation();
    return result && result.ok === false ? result.code : null;
  } catch (error) {
    return error && error.code ? error.code : null;
  }
}

// A freshly distilled kit must stop here, without loading Electron, reading a
// profile, or attempting to locate Windows Terminal.
if (!fs.existsSync(launcherPath)) {
  console.log('\n=============== CONTROL GRADE ===============');
  console.log(`FAIL  C0: missing ${launcherRel} — item 07 is not implemented`);
  process.exit(1);
}

// No new dependencies without asking: version bumps pass, an added package fails.
const FROZEN_DEPENDENCY_NAMES = ['babylonjs', 'babylonjs-gui', 'babylonjs-loaders', 'electron', 'typescript'];
{
  const pkg = JSON.parse(read('package.json') || '{}');
  const names = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {})).sort();
  if (names.join(',') !== FROZEN_DEPENDENCY_NAMES.join(',')) {
    fail('C0', `dependency set changed: expected [${FROZEN_DEPENDENCY_NAMES.join(', ')}], found [${names.join(', ')}]`);
  }
}

const launcherSource = read(launcherRel);
// Kit 14 (2026-10-01): main.js is split across src/main; grep the whole layer.
const mainSource = (function readMainLayer(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => e.isDirectory() ? [readMainLayer(path.join(dir, e.name))]
      : e.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : [])
    .join('\n');
})(path.join(root, 'src', 'main'));
const preloadSource = read('src/preload.js');
// 2026-09-27 kit 13: app.js split into app-*.js modules; grep the whole app layer.
const appSource = fs.readdirSync(path.join(root, 'src', 'renderer'))
  .filter((f) => /^app.*\.js$/.test(f)).sort()
  .map((f) => read(`src/renderer/${f}`)).join('\n');
// 2026-10-14: style.css was split into styles/*.css; grep them all.
const styleSource = fs.readdirSync(path.join(root, 'src', 'renderer', 'styles'))
  .filter((f) => f.endsWith('.css')).sort()
  .map((f) => read(`src/renderer/styles/${f}`)).join('\n');
const docsSource = read('docs/AGENT-CONTROL.md');

if (!/CONTROL_TEST/.test(mainSource) || !/control-test/.test(mainSource) ||
    !/control-output/.test(mainSource) || !/au:open-terminal/.test(mainSource)) {
  fail('C1', 'main lacks control test plumbing or au:open-terminal IPC');
}
// Main-frame validation moved into src/main/window-security.js after this kit
// shipped; accept it inline in main or imported from that helper.
const securitySource = read('src/main/window-security.js');
const frameSource = /window-security/.test(mainSource) ? mainSource + securitySource : mainSource;
if (!/senderFrame/.test(frameSource) || !/mainFrame/.test(frameSource) ||
    !/activeSource/.test(mainSource) ||
    !/tracker/.test(mainSource) || !/realpath/i.test(mainSource) || !/stat/i.test(mainSource)) {
  fail('C1', 'main lacks main-frame, live-source, or fresh cwd validation');
}
if (!/openTerminal\s*:\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*=>/.test(preloadSource) ||
    !/au:open-terminal/.test(preloadSource)) {
  fail('C1', 'preload lacks the one-argument openTerminal bridge');
}
if (!appSource.includes('project-terminal') || !appSource.includes('project-control-status') ||
    !appSource.includes('Open Terminal') ||
    !appSource.includes('Return to LIVE to open a terminal.')) {
  fail('C4', 'project card lacks the exact terminal/status/replay UI');
}
if (!/aria-live/.test(appSource) || !/aria-atomic/.test(appSource) ||
    !/openTerminal/.test(appSource)) {
  fail('C4', 'terminal action lacks accessible status or bridge wiring');
}
if (/project-launch-mode|Launch Claude|Launch Codex|New Claude|New Codex/.test(appSource)) {
  fail('C4', 'renderer added a provider launcher or selector outside item 07 scope');
}
if (!/project-(?:terminal|control)|terminal-action/.test(styleSource) ||
    !/:focus-visible/.test(styleSource)) {
  fail('C4', 'terminal action lacks scoped styling or visible keyboard focus');
}
if (!/Windows Terminal/i.test(docsSource) || !/Open Terminal/.test(docsSource) ||
    !/LIVE/.test(docsSource) || !/replay/i.test(docsSource) ||
    !/never\s+(?:owns?|manages?|tracks?)/i.test(docsSource) ||
    !/no\s+(?:provider|prompt)|does not\s+(?:launch|pretype)/i.test(docsSource)) {
  fail('C0', 'agent-control docs omit use, replay, or no-ownership boundaries');
}

const forbiddenLauncher = [
  [/\bexec(?:File|Sync)?\s*\(/, 'exec API'],
  [/shell\s*:\s*true/, 'shell:true'],
  [/\b(?:cmd|powershell|pwsh|bash|sh)\.(?:exe|cmd)\b|\/(?:bin\/)?(?:ba)?sh\b/i, 'command shell'],
  [/(?:^|[\s'"`])(?:-c|\/c)(?:[\s'"`]|$)/im, 'shell command flag'],
  [/\.(?:kill|disconnect)\s*\(|process\.kill|taskkill/i, 'process lifecycle control'],
  [/\.on\s*\(\s*['"](?:exit|close|data)['"]|\.stdout\b|\.stderr\b|\.stdin\b/, 'process supervision or stdio'],
  [/\b(?:claude|codex)\b|--resume|session[_-]?id|prompt/i, 'provider/session launch'],
  [/(?:process\.)?env\.(?:PATH|Path)|path\.delimiter|where\.exe|which\b/i, 'PATH discovery'],
  [/\.cmd\b|\.bat\b|\.ps1\b/i, 'script-wrapper fallback'],
];
for (const [pattern, label] of forbiddenLauncher) {
  if (pattern.test(launcherSource)) fail('C2', `terminal adapter contains forbidden ${label}`);
}
for (const [pattern, label] of [
  [/LOCALAPPDATA/, 'LOCALAPPDATA'],
  [/Microsoft/, 'Microsoft alias segment'],
  [/WindowsApps/, 'WindowsApps alias segment'],
  [/wt\.exe/i, 'wt.exe alias'],
  [/accessSync/, 'app-alias access check'],
  [/F_OK/, 'F_OK access mode'],
  [/path\.win32/, 'Windows path construction'],
  [/\bspawn(?:Impl)?\s*\(/, 'spawn call'],
  [/shell\s*:\s*false/, 'shell:false'],
  [/detached\s*:\s*true/, 'detached:true'],
  [/stdio\s*:\s*['"]ignore['"]/, 'ignored stdio'],
  [/windowsHide\s*:\s*false/, 'visible terminal'],
  [/\.unref\s*\(/, 'immediate unref'],
]) {
  if (!pattern.test(launcherSource)) fail('C2', `terminal adapter omits ${label}`);
}

let createTerminalLauncher;
let buildTerminalSpec;
let resolveWindowsTerminal;
try {
  ({ createTerminalLauncher, buildTerminalSpec, resolveWindowsTerminal } = require(launcherPath));
  if (typeof createTerminalLauncher !== 'function' || typeof buildTerminalSpec !== 'function' ||
      typeof resolveWindowsTerminal !== 'function') {
    fail('C2', 'terminal-launcher exports are incomplete');
  }
} catch (error) {
  fail('C2', `terminal adapter load failed: ${error.stack || error}`);
}

if (failures.length === 0) {
  try {
    const localAppData = "C:\\Users\\Fixture User\\App Data & (Orbit) O'Brien";
    const terminalPath = path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
    const cwd = "C:\\Workspace With Spaces & (Orbit) O'Brien\\-mission;$(nope)";
    const accessCalls = [];
    const fakeFs = {
      constants: { F_OK: fs.constants.F_OK },
      accessSync(candidate, mode) {
        accessCalls.push([candidate, mode]);
        if (candidate !== terminalPath) {
          const error = new Error('PRIVATE_OS_ERROR unexpected alias');
          error.code = 'ENOENT';
          throw error;
        }
      },
    };

    const resolved = resolveWindowsTerminal({
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData, PATH: `${cwd};C:\\Malicious Bin` },
      fsImpl: fakeFs,
    });
    same(resolved, terminalPath, 'fixed app-alias resolution');
    same(accessCalls, [[terminalPath, fs.constants.F_OK]], 'single F_OK alias check');

    const spec = buildTerminalSpec({ terminalPath, cwd });
    same(spec, {
      command: terminalPath,
      args: ['-d', cwd],
      options: {
        cwd,
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    }, 'adversarial cwd stays one opaque argv element');
    if (spec.args.length !== 2 || spec.args[1] !== cwd ||
        JSON.stringify(spec).includes('PRIVATE_OS_ERROR')) {
      fail('C2', 'terminal spec escaped, split, or leaked the adversarial cwd/error');
    }
    for (const input of [
      { terminalPath: 'wt.exe', cwd },
      { terminalPath, cwd: 'relative-project' },
      { terminalPath, cwd: '' },
    ]) {
      try {
        buildTerminalSpec(input);
        fail('C2', `unsafe terminal spec was accepted: ${JSON.stringify(input)}`);
      } catch { /* expected */ }
    }

    const spawnCalls = [];
    const fakeChild = new EventEmitter();
    let unrefCount = 0;
    fakeChild.unref = () => { unrefCount++; };
    fakeChild.kill = () => { throw new Error('launcher must not kill'); };
    const launcher = createTerminalLauncher({
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData, PATH: cwd },
      fsImpl: fakeFs,
      spawnImpl(command, args, options) {
        spawnCalls.push({ command, args, options });
        return fakeChild;
      },
    });
    if (!launcher || typeof launcher.open !== 'function') fail('C2', 'launcher.open is missing');
    const launched = await launcher.open({ cwd });
    same(spawnCalls, [{ command: terminalPath, args: ['-d', cwd], options: spec.options }],
      'one exact no-shell spawn');
    if (unrefCount !== 1) fail('C2', `child unref count ${unrefCount}, expected 1`);
    if (fakeChild.listenerCount('exit') || fakeChild.listenerCount('close') ||
        fakeChild.listenerCount('data') || fakeChild.listenerCount('error') > 1) {
      fail('C2', 'launcher attached lifecycle/stdio listeners');
    }
    if (!launched || launched.ok !== true || launched.terminal !== 'windows-terminal' ||
        /[\\/]|pid|argv|cwd/i.test(JSON.stringify(launched))) {
      fail('C2', `launch result is missing or exposes internals: ${JSON.stringify(launched)}`);
    }
    for (const forbiddenMethod of ['kill', 'stop', 'write', 'send', 'children', 'processes']) {
      if (forbiddenMethod in launcher) fail('C2', `launcher exposes ${forbiddenMethod}`);
    }

    let unsupportedAccess = 0;
    const unsupported = createTerminalLauncher({
      platform: 'linux',
      env: { LOCALAPPDATA: localAppData },
      fsImpl: { ...fakeFs, accessSync() { unsupportedAccess++; } },
      spawnImpl() { throw new Error('must not spawn'); },
    });
    const unsupportedCode = await failureCode(() => unsupported.open({ cwd }));
    if (unsupportedCode !== 'UNAVAILABLE' || unsupportedAccess !== 0) {
      fail('C2', `unsupported platform did not fail closed: ${unsupportedCode}/${unsupportedAccess}`);
    }

    let missingSpawnCount = 0;
    const missing = createTerminalLauncher({
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
      fsImpl: {
        constants: fakeFs.constants,
        accessSync() {
          const error = new Error(`PRIVATE_OS_ERROR ${terminalPath}`);
          error.code = 'EACCES';
          throw error;
        },
      },
      spawnImpl() { missingSpawnCount++; throw new Error('must not spawn'); },
    });
    let missingOutcome;
    try { missingOutcome = await missing.open({ cwd }); }
    catch (error) { missingOutcome = { ok: false, code: error.code, message: error.message }; }
    if (missingOutcome?.code !== 'UNAVAILABLE' || missingSpawnCount !== 0 ||
        JSON.stringify(missingOutcome).includes('PRIVATE_OS_ERROR') ||
        JSON.stringify(missingOutcome).includes(localAppData)) {
      fail('C2', `missing alias failure leaked or spawned: ${JSON.stringify(missingOutcome)}`);
    }
    notes.push('isolated fixed-alias/no-shell/no-ownership adapter checks passed');
  } catch (error) {
    fail('C2', error.stack || String(error));
  }
}

let outDir = null;
let child = null;
if (failures.length === 0) {
  try {
    const outRoot = path.join(root, '.shots', 'control');
    fs.mkdirSync(outRoot, { recursive: true });
    outDir = fs.mkdtempSync(path.join(outRoot, 'run-'));
    const electron = process.platform === 'win32'
      ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(root, 'node_modules', '.bin', 'electron');
    const startedAt = Date.now();
    child = spawn(electron, ['.', '--control-test', `--control-output=${outDir}`], {
      cwd: root,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
    child.stderr.on('data', (data) => { output += data; process.stderr.write(data); });
    const code = await withTimeout(new Promise((resolve) => {
      child.once('exit', resolve);
      child.once('error', () => resolve('spawn-error'));
    }), 90_000, 'timeout');
    if (code === 'timeout') await terminateTree(child);
    if (code !== 0) fail('C5', `control Electron harness exited with ${code}`);
    const rendererErrors = output.split(/\r?\n/).filter((line) => ERROR_RE.test(line));
    if (rendererErrors.length) fail('C5', `renderer errors: ${rendererErrors.slice(0, 4).join(' | ')}`);

    const resultPath = path.join(outDir, 'result.json');
    if (!fs.existsSync(resultPath)) fail('C5', 'missing control result.json');
    else {
      const resultText = fs.readFileSync(resultPath, 'utf8');
      const result = JSON.parse(resultText);
      const controls = result.controls || {};
      const metrics = result.metrics || {};
      const steps = Array.isArray(result.steps) ? result.steps : [];
      if (result.passed !== true || result.schemaVersion !== 1) {
        fail('C5', `control harness failed: ${result.error || 'bad result schema'}`);
      }
      same(result.windowSize, { width: 1200, height: 720 }, 'control harness window size', 'C5');
      const expectedActions = ['system-terminal', 'replay-blocked', 'live-return', 'planet-proof'];
      same(steps.map((step) => step.action), expectedActions, 'actual control step order', 'C5');
      for (const action of expectedActions) {
        const step = steps.find((item) => item.action === action);
        if (!step || step.actualInput !== true) fail('C5', `missing actual ${action} input`);
      }
      same(controls.ids, ['project-terminal', 'project-control-status'], 'control ids', 'C5');
      if (controls.exactText !== 'Open Terminal' || controls.liveEnabled !== true ||
          controls.replayDisabled !== true ||
          controls.replayNote !== 'Return to LIVE to open a terminal.' ||
          controls.overlapCount !== 0 || controls.clippedCount !== 0 ||
          controls.singleTerminalButton !== true || controls.noProviderOrPromptControls !== true) {
        fail('C5', `bad rendered controls ${JSON.stringify(controls)}`);
      }
      const expectedMetrics = {
        initialLaunchCount: 1,
        replayLaunchCount: 1,
        finalLaunchCount: 2,
        safeWindowsSpec: true,
        sameCanonicalCwd: true,
        replayMainRejected: true,
        planetRendered: true,
        noProcessOwnership: true,
      };
      for (const [key, value] of Object.entries(expectedMetrics)) {
        if (metrics[key] !== value) fail('C5', `metric ${key}: ${JSON.stringify(metrics[key])} != ${value}`);
      }
      if ((result.rendererErrors || []).length !== 0) fail('C5', 'control result recorded renderer errors');
      if (/[A-Za-z]:[\\/]|\/(?:home|tmp|Users)\//.test(resultText) ||
          /"(?:cwd|argv|args|command|environment|env|pid|terminalPath|projectPath|transcript)"\s*:/i.test(resultText)) {
        fail('C5', 'control result contains a path, command, process, environment, or transcript field');
      }
    }

    for (const name of ['control-live.png', 'control-replay.png']) {
      const file = path.join(outDir, name);
      if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < startedAt ||
          fs.statSync(file).size < 30 * 1024) {
        fail('C5', `${name} is missing, stale, or blank`);
      }
    }
    notes.push(`rendered artifacts ${outDir}`);
  } catch (error) {
    fail('C5', error.stack || String(error));
  } finally {
    await terminateTree(child);
  }
}

console.log('\n=============== CONTROL GRADE ===============');
for (const note of notes) console.log(`INFO  ${note}`);
if (failures.length) {
  for (const item of failures) console.log(`FAIL  ${item}`);
  process.exit(1);
}
console.log('PASS  C1-C5 safe terminal action checks green');
