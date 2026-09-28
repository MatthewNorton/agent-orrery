// Item 07 gate: safe live-only Windows Terminal action plus real rendered proof.
// Run from anywhere; exit 0 = PASS, 1 = FAIL.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
function sha256(file) {
  // Hash with line endings normalized to LF so the pins hold on every platform and
  // every core.autocrlf setting (a fresh Windows checkout is CRLF, macOS/Linux are LF).
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
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

// Baseline re-pinned 2026-09-04 to main after PR #24 (macOS support + security
// hardening). Later kits legitimately moved these files; the hashes track the
// state each subsequent kit must not regress from.
// tracker.js and replay-source.js re-pinned 2026-09-27 for the security follow-ups
// (null project keys, planet lookup; docs/PUBLIC-RELEASE-TASKS.md Phase 1).
// All hashes re-pinned 2026-09-27 as LF-normalized digests (docs/PUBLIC-RELEASE-TASKS.md
// item 5.6); file contents are unchanged from the previous pins.
// package.json and package-lock.json re-pinned 2026-09-27 after Dependabot #27 (Babylon 9.28) and #30 (Electron 44).
// 2026-09-28 re-pinned: src/renderer/index.html — kit 13 task 0: app-state/app-agent-focus split
// 2026-09-28 re-pinned: src/renderer/index.html — kit 13 task B: app-playback split
// 2026-09-28 re-pinned: src/renderer/index.html — kit 13 task B: app-chrome split
// 2026-09-28 re-pinned: src/renderer/index.html — kit 13 task B: app-project-search split
const frozen = new Map([
  ['src/main/tracker.js', '600c950483280eb66dd2726849ef4643dd5b894d5cec175eddf75035449bf5fb'],
  ['src/main/provider-adapters.js', 'e6930f483b6e52335b47ddccb34968d6a0e3d211aafe04cbaaa2e0aa31e5a037'],
  ['src/main/replay-source.js', 'd3f16564970e7500ac54a135936a75eb3b10ba03a466fa78ba3c75b38f493f36'],
  ['src/renderer/index.html', '588b1b7e23acb229f82ae233d22175f8527bac7bea2f6c7a7047cfa21f3009a5'],
  ['src/renderer/util.js', 'c8f49b054033d95be89846359a8bf065a07a26e37284775f3970afc49cf3bf2c'],
  ['src/renderer/scene-universe.js', '61ff27fa53ea8ca6d3d944c29ece4f9f82aa46fea53321df0e01d1e82b1a5b3a'],
  ['src/renderer/scene-system.js', '1819bfc26082fd06f4035a98197821808d35c8826d29fb962764d65ed4a8968b'],
  ['src/renderer/scene-planet.js', '7c6bd48e4c90183b01b382e5fb4d7ed7e7ede3f14b88f0d8813fb0ea716575b3'],
  ['src/renderer/galaxy-layout.js', '3b6456404bea666a2b7d6e0db5b5c57190b3a67b7c383786beb4d8fb7e76ea39'],
  ['src/renderer/polish-math.js', '2d8c154844aa89aeb3d666a8be1e1583cae45f42ce2d8f6ca75c5c17e02385ef'],
  ['package.json', 'a5ce483c35445819e69e89e0818f355a638563926e8c5754df540f4c2769fc3d'],
  ['package-lock.json', '6d01a454183894b555883d6707e71e32c5c5710fd67941213f8a62c7c93ea7e1'],
]);
for (const [rel, expected] of frozen) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) fail('C0', `frozen file missing: ${rel}`);
  else if (sha256(file) !== expected) fail('C0', `frozen file changed: ${rel}`);
}

const launcherSource = read(launcherRel);
const mainSource = read('src/main/main.js');
const preloadSource = read('src/preload.js');
// 2026-09-27 kit 13: app.js split into app-*.js modules; grep the whole app layer.
const appSource = fs.readdirSync(path.join(root, 'src', 'renderer'))
  .filter((f) => /^app.*\.js$/.test(f)).sort()
  .map((f) => read(`src/renderer/${f}`)).join('\n');
const styleSource = read('src/renderer/style.css');
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
