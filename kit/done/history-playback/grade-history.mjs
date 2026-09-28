// Item 06 gate: isolated deterministic replay plus a real rendered timeline.
// Run from anywhere; exit 0 = PASS, 1 = FAIL.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const failures = [];
const notes = [];
const SECRET = 'PRIVATE_HISTORY_SENTINEL_06';
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure/i;
const replayRel = 'src/main/replay-source.js';
const replayPath = path.join(root, replayRel);

function fail(id, message) { failures.push(`${id}: ${message}`); }
function same(actual, expected, label, id = 'H1') {
  try { assert.deepStrictEqual(actual, expected); }
  catch { fail(id, `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); }
}
function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { fail('H0', `missing ${rel}`); return ''; }
  return fs.readFileSync(file, 'utf8');
}
function sha256(file) {
  // Hash with line endings normalized to LF so the pins hold on every platform and
  // every core.autocrlf setting (a fresh Windows checkout is CRLF, macOS/Linux are LF).
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}
function jsonLine(value) { return `${JSON.stringify(value)}\n`; }
function iso(value) { return new Date(value).toISOString(); }
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

// A freshly distilled kit must stop here, without loading Electron or touching
// the real profile.
if (!fs.existsSync(replayPath)) {
  console.log('\n=============== HISTORY GRADE ===============');
  console.log(`FAIL  H0: missing ${replayRel} — item 06 is not implemented`);
  process.exit(1);
}

// Baseline re-pinned 2026-09-04 to main after PR #24 (macOS support + security
// hardening). Later kits legitimately moved these files; the hashes track the
// state each subsequent kit must not regress from.
// tracker.js re-pinned 2026-09-27 for the security follow-ups
// (null project keys, planet lookup; docs/PUBLIC-RELEASE-TASKS.md Phase 1).
// All hashes re-pinned 2026-09-27 as LF-normalized digests (docs/PUBLIC-RELEASE-TASKS.md
// item 5.6); file contents are unchanged from the previous pins.
// package.json and package-lock.json re-pinned 2026-09-27 after Dependabot #27 (Babylon 9.28) and #30 (Electron 44).
const frozen = new Map([
  ['src/main/tracker.js', '600c950483280eb66dd2726849ef4643dd5b894d5cec175eddf75035449bf5fb'],
  ['src/main/provider-adapters.js', 'e6930f483b6e52335b47ddccb34968d6a0e3d211aafe04cbaaa2e0aa31e5a037'],
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
  if (!fs.existsSync(file)) fail('H0', `frozen file missing: ${rel}`);
  else if (sha256(file) !== expected) fail('H0', `frozen file changed: ${rel}`);
}

const mainSource = read('src/main/main.js');
const preloadSource = read('src/preload.js');
const appSource = read('src/renderer/app.js');
const htmlSource = read('src/renderer/index.html');
const styleSource = read('src/renderer/style.css');
const utilSource = read('src/renderer/util.js');
const docsSource = read('docs/HISTORY-PLAYBACK.md');

if (!/history-test/.test(mainSource) || !/au:replay/.test(mainSource) ||
    !/au:replay-state/.test(mainSource) || !/streamEpoch/.test(mainSource)) {
  fail('H4', 'main lacks the isolated harness, replay IPC, progress IPC, or stream epoch');
}
if (!/replay\s*:/.test(preloadSource) || !/onReplayState/.test(preloadSource) ||
    !/onEvents/.test(preloadSource) || !/meta/.test(preloadSource)) {
  fail('H4', 'preload bridge lacks replay/onReplayState or onEvents(batch, meta)');
}
for (const id of ['history-play', 'history-speed', 'history-scrubber', 'history-time', 'history-live']) {
  if (!htmlSource.includes(`id="${id}"`)) fail('H5', `missing #${id}`);
}
if (!/history-(?:bar|timeline|controls)/.test(styleSource) ||
    !/streamEpoch/.test(appSource) || !/onReplayState/.test(appSource) ||
    !/REPLAY/.test(appSource) || !/LIVE/.test(appSource)) {
  fail('H5', 'timeline styling, epoch reconciliation, or LIVE/REPLAY renderer wiring is incomplete');
}
if (!/relTime\s*=|function\s+relTime|relTime\s*\(/.test(utilSource) ||
    !/base|cursor|now/i.test(utilSource)) {
  fail('H5', 'relative-time helper does not expose a virtual clock path');
}
if (!/Claude/i.test(docsSource) || !/Codex/i.test(docsSource) ||
    !/generic|Signal/i.test(docsSource) || !/LIVE/.test(docsSource) ||
    !/never\s+(?:writes?|modif)/i.test(docsSource)) {
  fail('H0', 'history documentation lacks providers, LIVE behavior, or read-only boundary');
}

let ReplaySource;
try {
  ({ ReplaySource } = require(replayPath));
  if (typeof ReplaySource !== 'function') fail('H1', 'ReplaySource is not exported');
} catch (error) {
  fail('H1', `replay module load failed: ${error.stack || error}`);
}

let fixtureRoot = null;
if (failures.length === 0) {
  let source = null;
  try {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-history-unit-'));
    const projectDir = path.join(fixtureRoot, 'workspace', 'history-project');
    const outsideDir = path.join(fixtureRoot, 'outside');
    const claudeRoot = path.join(fixtureRoot, '.claude', 'projects');
    const codexActive = path.join(fixtureRoot, '.codex', 'sessions');
    const codexArchive = path.join(fixtureRoot, '.codex', 'archived_sessions');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'alpha.js'), '// fixture\n');

    const t0 = Date.UTC(2026, 0, 2, 12, 0, 0);
    const claudeDir = path.join(claudeRoot, 'fixture-history-project');
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeFile = path.join(claudeDir, 'claude-history.jsonl');
    fs.writeFileSync(claudeFile, [
      { type: 'user', timestamp: iso(t0), cwd: projectDir,
        message: { role: 'user', content: SECRET } },
      { type: 'assistant', timestamp: iso(t0 + 1000), cwd: projectDir,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'claude-read',
          name: 'Read', input: { file_path: path.join(projectDir, 'src', 'alpha.js'), secret: SECRET } }] } },
      { type: 'user', timestamp: iso(t0 + 2000), cwd: projectDir,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'claude-read', content: SECRET }] } },
      { type: 'assistant', timestamp: iso(t0 + 3000), cwd: projectDir,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'claude-edit-one',
          name: 'Edit', input: { file_path: path.join(projectDir, 'src', 'alpha.js'), new_string: SECRET } }] } },
      { type: 'user', timestamp: iso(t0 + 4000), cwd: projectDir,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'claude-edit-one', content: SECRET }] } },
      { type: 'system', subtype: 'turn_duration', timestamp: iso(t0 + 5000), cwd: projectDir },
      { type: 'assistant', timestamp: iso(t0 + 6000), cwd: projectDir,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'claude-agent',
          name: 'Agent', input: { description: SECRET } }] } },
      { type: 'user', timestamp: iso(t0 + 7000), cwd: projectDir,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'claude-agent', content: SECRET }] } },
      { type: 'assistant', timestamp: iso(t0 + 9000), cwd: projectDir,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'claude-edit-two',
          name: 'Write', input: { file_path: path.join(projectDir, 'docs', 'later.md'), content: SECRET } }] } },
      { type: 'user', timestamp: iso(t0 + 10000), cwd: projectDir,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'claude-edit-two', content: SECRET }] } },
    ].map(jsonLine).join('') + '{malformed\n' + JSON.stringify({ type: 'user', timestamp: iso(t0 + 11000) }));

    const mainId = '019f0000-0000-7000-8000-000000000006';
    const droneId = '019f0000-0000-7000-8000-000000000007';
    const activeDay = path.join(codexActive, '2026', '01', '02');
    fs.mkdirSync(activeDay, { recursive: true });
    fs.mkdirSync(codexArchive, { recursive: true });
    const mainRecords = [
      { timestamp: iso(t0 + 500), type: 'session_meta', payload: {
        id: mainId, session_id: mainId, cwd: projectDir, thread_source: 'user', base_instructions: SECRET } },
      { timestamp: iso(t0 + 1500), type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: iso(t0 + 2500), type: 'response_item', payload: {
        type: 'custom_tool_call', call_id: 'codex-patch', name: 'apply_patch', input: SECRET } },
      { timestamp: iso(t0 + 3500), type: 'event_msg', payload: {
        type: 'patch_apply_end', call_id: 'codex-patch', success: true, stdout: SECRET,
        changes: {
          [path.join(projectDir, 'src', 'codex.js')]: { type: 'add', content: SECRET },
          [path.join(outsideDir, 'escape.js')]: { type: 'add', content: SECRET },
        } } },
      { timestamp: iso(t0 + 3600), type: 'event_msg', payload: {
        type: 'patch_apply_end', call_id: 'failed-patch', success: false,
        changes: { [path.join(projectDir, 'src', 'failed.js')]: { content: SECRET } } } },
      { timestamp: iso(t0 + 4500), type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: 'codex-patch', output: SECRET } },
      { timestamp: iso(t0 + 5500), type: 'event_msg', payload: {
        type: 'task_complete', last_agent_message: SECRET } },
    ];
    const activeMain = path.join(activeDay, `rollout-2026-01-02T12-00-00-${mainId}.jsonl`);
    const archivedMain = path.join(codexArchive, `rollout-archive-${mainId}.jsonl`);
    fs.writeFileSync(activeMain, mainRecords.map(jsonLine).join(''));
    fs.writeFileSync(archivedMain, mainRecords.map(jsonLine).join(''));

    const droneFile = path.join(activeDay, `rollout-2026-01-02T12-00-02-${droneId}.jsonl`);
    fs.writeFileSync(droneFile, [
      { timestamp: iso(t0 + 2500), type: 'session_meta', payload: {
        id: droneId, session_id: mainId, cwd: projectDir,
        thread_source: 'subagent', parent_thread_id: mainId, base_instructions: SECRET } },
      { timestamp: iso(t0 + 3000), type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: iso(t0 + 6000), type: 'event_msg', payload: {
        type: 'task_complete', last_agent_message: SECRET } },
    ].map(jsonLine).join(''));

    const transcriptFiles = [claudeFile, activeMain, archivedMain, droneFile];
    const before = new Map(transcriptFiles.map((file) => [file, {
      hash: sha256(file), size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs,
    }]));

    source = new ReplaySource({
      claudeProjectsDir: claudeRoot,
      codexSessionDirs: [codexActive, codexArchive],
      now: () => t0 + 60_000,
    });
    for (const method of ['index', 'status', 'seek', 'advanceTo', 'play', 'pause',
      'setSpeed', 'snapshot', 'getSystem', 'getPlanet', 'stop']) {
      if (typeof source[method] !== 'function') fail('H1', `ReplaySource.${method} is missing`);
    }
    if (failures.length) throw new Error('ReplaySource API is incomplete');

    await source.index();
    const indexed = source.status();
    if (!indexed.available || indexed.indexing || indexed.minTs !== t0 ||
        indexed.maxTs !== t0 + 10000 || indexed.sourceCount !== 3 || indexed.truncated) {
      fail('H2', `bad bounded index status ${JSON.stringify(indexed)}`);
    }

    const early = await source.seek(t0 + 3200);
    const earlyProject = early.projects?.[0];
    if (!earlyProject || early.projects.length !== 1 || earlyProject.totalBuilds !== 1 ||
        earlyProject.buckets?.src !== 1 || earlyProject.buckets?.docs) {
      fail('H3', `early seek has wrong build state ${JSON.stringify(early.projects)}`);
    }
    const earlyProviders = (early.ships || []).map((ship) => `${ship.provider}:${ship.kind}`).sort();
    same(earlyProviders, ['claude:main', 'codex:drone', 'codex:main'], 'early provider ships', 'H3');
    if ((early.ships || []).some((ship) => ship.attention != null || ship.attentionSince != null)) {
      fail('H3', 'historical ship exposed live attention');
    }

    const late = await source.seek(t0 + 10000);
    const lateProject = late.projects?.[0];
    if (!lateProject || lateProject.totalBuilds !== 3 || lateProject.buckets?.src !== 2 ||
        lateProject.buckets?.docs !== 1) {
      fail('H3', `late seek has wrong build state ${JSON.stringify(late.projects)}`);
    }
    const codexMainShips = (late.ships || []).filter((ship) => ship.id === `ship:codex:${mainId}`);
    if (codexMainShips.length !== 1) fail('H2', 'active/archive Codex duplicate created more than one ship');

    const reset = await source.seek(t0 + 3200);
    const resetProject = reset.projects?.[0];
    if (!resetProject || resetProject.totalBuilds !== 1 || resetProject.buckets?.src !== 1 ||
        Object.hasOwn(resetProject.buckets || {}, 'docs')) {
      fail('H3', 'backward seek retained future build state');
    }

    const batches = [];
    source.on('events', (batch) => batches.push(batch));
    await source.advanceTo(t0 + 10000, { emit: true });
    const events = batches.flat();
    const allowed = new Set(['project-added', 'project-updated', 'ship-spawned', 'ship-updated',
      'ship-departed', 'activity', 'build', 'feed']);
    if (events.length === 0 || events.some((event) => !allowed.has(event.type))) {
      fail('H3', `forward playback emitted missing/unknown events ${JSON.stringify(events.map((e) => e.type))}`);
    }
    for (let index = 1; index < events.length; index++) {
      if (!(events[index].seq > events[index - 1].seq)) {
        fail('H3', 'forward replay sequence is not strictly monotonic');
        break;
      }
    }
    const forwardBuilds = events.filter((event) => event.type === 'build');
    if (forwardBuilds.length !== 2 || forwardBuilds.some((event) => event.ts > t0 + 10000)) {
      fail('H3', `forward build count/timestamps are wrong ${JSON.stringify(forwardBuilds)}`);
    }

    const finalSnapshot = source.snapshot();
    const system = source.getSystem(finalSnapshot.projects[0].id);
    const planet = source.getPlanet(finalSnapshot.projects[0].id, 'src');
    const publicProof = JSON.stringify({ indexed, early, late, reset, events, finalSnapshot, system, planet });
    if (publicProof.includes(SECRET)) fail('H3', 'private transcript content leaked into replay output');
    if (!system || !planet || system.project?.id !== finalSnapshot.projects[0].id || planet.builds !== 2) {
      fail('H3', 'replay-derived system/planet data does not reflect historical buckets');
    }

    source.pause();
    source.stop();
    source.stop();
    for (const file of transcriptFiles) {
      const after = { hash: sha256(file), size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs };
      same(after, before.get(file), `transcript changed: ${path.basename(file)}`, 'H3');
    }
    if (fs.existsSync(path.join(fixtureRoot, 'universe-state.json'))) {
      fail('H3', 'replay created universe-state.json');
    }
    notes.push('isolated seek/reset/privacy/deduplication fixture passed');
  } catch (error) {
    fail('H1', error.stack || String(error));
  } finally {
    try { if (source) source.stop(); } catch { /* best effort */ }
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// Dedicated real Electron proof. Product test mode owns isolated fixture roots
// and drives actual DOM controls at the minimum supported window size.
let outDir = null;
let child = null;
if (failures.length === 0) {
  try {
    const outRoot = path.join(root, '.shots', 'history');
    fs.mkdirSync(outRoot, { recursive: true });
    outDir = fs.mkdtempSync(path.join(outRoot, 'run-'));
    const electron = process.platform === 'win32'
      ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(root, 'node_modules', '.bin', 'electron');
    const startedAt = Date.now();
    child = spawn(electron, ['.', '--history-test', `--history-output=${outDir}`], {
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
    if (code !== 0) fail('H5', `history Electron harness exited with ${code}`);
    const rendererErrors = output.split(/\r?\n/).filter((line) => ERROR_RE.test(line));
    if (rendererErrors.length) fail('H5', `renderer errors: ${rendererErrors.slice(0, 4).join(' | ')}`);

    const resultPath = path.join(outDir, 'result.json');
    if (!fs.existsSync(resultPath)) fail('H5', 'missing history result.json');
    else {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      const metrics = result.metrics || {};
      const controls = result.controls || {};
      const steps = Array.isArray(result.steps) ? result.steps : [];
      const actions = steps.map((step) => step.action);
      if (result.passed !== true || result.schemaVersion !== 1) {
        fail('H5', `history harness failed: ${result.error || 'bad result schema'}`);
      }
      same(result.windowSize, { width: 1200, height: 720 }, 'history harness window size', 'H5');
      for (const action of ['scrub', 'speed', 'play', 'pause', 'live']) {
        const step = steps.find((item) => item.action === action);
        if (!step || step.actualInput !== true) fail('H5', `missing actual ${action} control input`);
      }
      if (!(actions.indexOf('scrub') < actions.indexOf('play') &&
            actions.indexOf('pause') < actions.indexOf('live'))) {
        fail('H5', `history control order is wrong: ${JSON.stringify(actions)}`);
      }
      if (controls.feedModeDuringReplay !== 'REPLAY' || controls.feedModeAfterLive !== 'LIVE' ||
          controls.speedText !== '1000x' || controls.chromeOverlapCount !== 0) {
        fail('H5', `bad rendered controls ${JSON.stringify(controls)}`);
      }
      const ids = controls.controlIds || [];
      for (const id of ['history-play', 'history-speed', 'history-scrubber', 'history-time', 'history-live']) {
        if (!ids.includes(id)) fail('H5', `rendered proof missing #${id}`);
      }
      for (const key of ['seekReset', 'buildAdvanced', 'pauseStable', 'liveCaughtUp', 'streamIsolation']) {
        if (metrics[key] !== true) fail('H5', `rendered metric ${key} did not pass`);
      }
      if (!(Number.isInteger(metrics.initialEpoch) && Number.isInteger(metrics.replayEpoch) &&
            Number.isInteger(metrics.liveEpoch) && metrics.initialEpoch < metrics.replayEpoch &&
            metrics.replayEpoch < metrics.liveEpoch)) {
        fail('H4', `stream epochs did not advance ${JSON.stringify(metrics)}`);
      }
      if ((result.rendererErrors || []).length !== 0) fail('H5', 'history result recorded renderer errors');
    }

    for (const name of ['replay-universe.png', 'system-before-build.png',
      'system-after-build.png', 'live-return.png']) {
      const file = path.join(outDir, name);
      if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < startedAt ||
          fs.statSync(file).size < 30 * 1024) {
        fail('H5', `${name} is missing, stale, or blank`);
      }
    }
    notes.push(`rendered artifacts ${outDir}`);
  } catch (error) {
    fail('H5', error.stack || String(error));
  } finally {
    await terminateTree(child);
  }
}

console.log('\n=============== HISTORY GRADE ===============');
for (const note of notes) console.log(`INFO  ${note}`);
if (failures.length) {
  for (const item of failures) console.log(`FAIL  ${item}`);
  process.exit(1);
}
console.log('PASS  H1-H5 history playback checks green');
