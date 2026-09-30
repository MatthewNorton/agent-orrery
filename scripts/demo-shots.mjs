#!/usr/bin/env node
// Capture README screenshots from a fully synthetic universe.
//
// Builds a throwaway home directory containing fictional Claude Code and Codex
// transcripts (fake project names, fake files, fake sessions), points the app at
// it by overriding HOME/USERPROFILE/APPDATA exactly like the kit gates do, runs the
// app's own `--shots` mode, and copies the three captures into docs/screenshots/.
// Nothing under the real ~/.claude, ~/.codex or the real app state is read.
//
// How the tracker sees the fixture (see src/main/tracker.js):
//   - projects come from transcript folders; their planets come from the persisted
//     universe-state.json, which this script writes with fictional edit counts;
//   - only transcript files modified in the last 15 min are tailed, and at startup
//     their existing content is skipped, so "live" activity (edits, a subagent, a
//     pending permission prompt) is appended while the app is running;
//   - old sessions get old modification times so they do not show as live ships.
//
// Usage: node scripts/demo-shots.mjs            capture docs/screenshots/*.png
//        node scripts/demo-shots.mjs --keep     also keep the profile and print how
//                                               to run the live app against it
//                                               (for recording a video or GIF)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = require(path.join(ROOT, 'package.json')).name; // Electron userData folder
const KEEP = process.argv.includes('--keep');
const OUT = path.join(ROOT, 'docs', 'screenshots');

// ---------- the fictional universe ----------
// Galaxies come from the parent folder of each project path; projects from the
// folder name; planets from the top-level directories that edits touched.
const GALAXIES = {
  work: [
    { name: 'orion-api', dirs: ['src', 'test', 'docs', 'migrations', 'scripts'], edits: [48, 21, 12, 9, 5], live: 'claude', attention: true },
    { name: 'nebula-dashboard', dirs: ['src', 'public', 'test'], edits: [34, 8, 11], live: 'codex' },
    { name: 'comet-billing', dirs: ['src', 'lib', 'docs'], edits: [19, 7, 4] },
    { name: 'pulsar-gateway', dirs: ['cmd', 'internal', 'docs'], edits: [6, 14, 3] },
  ],
  personal: [
    { name: 'quasar-notes', dirs: ['app', 'content', 'test'], edits: [22, 15, 6], live: 'claude', drone: true },
    { name: 'meteor-recipes', dirs: ['site', 'data'], edits: [9, 12] },
    { name: 'aurora-photos', dirs: ['src', 'assets'], edits: [7, 3] },
  ],
  'open-source': [
    { name: 'starlight-cli', dirs: ['src', 'test', 'docs', 'examples'], edits: [27, 13, 8, 5] },
    { name: 'halo-parser', dirs: ['src', 'bench', 'test'], edits: [15, 4, 9] },
    { name: 'vega-charts', dirs: ['src', 'examples', 'docs'], edits: [11, 6, 4], live: 'claude' },
  ],
};
const FILES = ['index.js', 'router.js', 'schema.js', 'handlers.js', 'utils.js', 'README.md', 'config.json', 'client.js'];

function rng(seed) {
  // mulberry32: deterministic so re-running gives the same universe.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260929);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const uuid = (n) => `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString();
const line = (obj) => `${JSON.stringify(obj)}\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function claudeLine(projectDir, sessionId, ts, body, sidechain = false) {
  return line({ timestamp: iso(ts), cwd: projectDir, sessionId, ...(sidechain ? { isSidechain: true } : {}), ...body });
}
function editPair(projectDir, sessionId, ts, id, sidechain = false) {
  const dirs = fs.readdirSync(projectDir).filter((d) => fs.statSync(path.join(projectDir, d)).isDirectory());
  const file = path.join(projectDir, pick(dirs), pick(FILES));
  return claudeLine(projectDir, sessionId, ts, { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id, name: id.endsWith('5') ? 'Write' : 'Edit', input: { file_path: file, new_string: '// demo' } }] } }, sidechain)
    + claudeLine(projectDir, sessionId, ts + 700, { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: id, content: 'ok' }] } }, sidechain);
}

// An old, finished session: a handful of edits with old timestamps, and an old
// file modification time so the tracker treats it as history, not a live ship.
function writeHistorySession(claudeDir, projectDir, sessionId, endedAt) {
  let t = endedAt - 40 * 60_000;
  let out = claudeLine(projectDir, sessionId, t, { type: 'user', message: { role: 'user', content: 'Continue the current task.' } });
  for (let i = 0; i < 6; i++) { t += 60_000; out += editPair(projectDir, sessionId, t, `${sessionId.slice(-4)}-h${i}`); }
  out += claudeLine(projectDir, sessionId, t + 5000, { type: 'system', subtype: 'turn_duration' });
  const file = path.join(claudeDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, out);
  fs.utimesSync(file, endedAt / 1000, endedAt / 1000);
  return file;
}

function buildProfile() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-demo-'));
  const claudeRoot = path.join(profile, '.claude', 'projects');
  const codexDay = path.join(profile, '.codex', 'sessions', '2026', '09', '29');
  const roaming = path.join(profile, 'AppData', 'Roaming');
  for (const d of [claudeRoot, codexDay, path.join(profile, '.codex', 'archived_sessions'), roaming,
    path.join(profile, 'AppData', 'Local'), path.join(profile, '.config'), path.join(profile, 'Library', 'Application Support')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const now = Date.now();
  const state = { projects: {}, pathIds: {}, pathOverrides: {} };
  const live = []; // { kind, file, projectDir, sessionId, attention, drone }
  let n = 1;
  for (const [galaxy, projects] of Object.entries(GALAXIES)) {
    for (const p of projects) {
      const projectDir = path.join(profile, galaxy, p.name);
      for (const d of p.dirs) {
        fs.mkdirSync(path.join(projectDir, d), { recursive: true });
        for (const f of FILES) fs.writeFileSync(path.join(projectDir, d, f), '// demo\n');
      }
      fs.writeFileSync(path.join(projectDir, 'README.md'), `# ${p.name}\n`);
      const slug = `-${galaxy}-${p.name}`;
      const claudeDir = path.join(claudeRoot, slug);
      fs.mkdirSync(claudeDir, { recursive: true });

      // Planets: persisted edit counts per top-level directory.
      const buckets = Object.fromEntries(p.dirs.map((d, i) => [d, p.edits[i] || 1]));
      state.projects[slug] = { buckets, totalBuilds: Object.values(buckets).reduce((a, b) => a + b, 0), firstSeen: now - 40 * 86_400_000 };

      // Two finished sessions, days ago.
      const daysAgo = 2 + Math.floor(rand() * 20);
      writeHistorySession(claudeDir, projectDir, uuid(n++), now - daysAgo * 86_400_000);
      writeHistorySession(claudeDir, projectDir, uuid(n++), now - (daysAgo + 3) * 86_400_000);

      if (p.live === 'claude') {
        const sessionId = uuid(n++);
        const file = path.join(claudeDir, `${sessionId}.jsonl`);
        fs.writeFileSync(file, claudeLine(projectDir, sessionId, now - 4 * 60_000, { type: 'user', message: { role: 'user', content: 'Continue the current task.' } }));
        live.push({ kind: 'claude', file, projectDir, sessionId, attention: !!p.attention });
        if (p.drone) {
          const droneId = uuid(n++);
          const droneFile = path.join(claudeDir, `${droneId}.jsonl`);
          fs.writeFileSync(droneFile, claudeLine(projectDir, droneId, now - 2 * 60_000, { type: 'user', message: { role: 'user', content: 'Subagent task.' } }, true));
          live.push({ kind: 'claude', file: droneFile, projectDir, sessionId: droneId, drone: true });
        }
      }
      if (p.live === 'codex') {
        const sessionId = uuid(n++);
        const file = path.join(codexDay, `rollout-2026-09-29T12-00-00-${sessionId}.jsonl`);
        fs.writeFileSync(file, [
          { timestamp: iso(now - 3 * 60_000), type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: projectDir, thread_source: 'user' } },
          { timestamp: iso(now - 3 * 60_000 + 1000), type: 'event_msg', payload: { type: 'task_started' } },
        ].map(line).join(''));
        live.push({ kind: 'codex', file, projectDir, sessionId });
      }
    }
  }

  const stateDir = path.join(roaming, APP_NAME);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'universe-state.json'), JSON.stringify(state));
  return { profile, live };
}

// Append live activity in small batches while the app runs. Batches written before
// the tracker's startup scan are ignored (by design); later ones are tailed.
async function streamActivity(live, stopAfterMs) {
  const started = Date.now();
  let batch = 0;
  while (Date.now() - started < stopAfterMs) {
    const now = Date.now();
    // Reverse order so the first configured live project (orion-api) is touched last
    // in every batch and therefore becomes the most recently active project, which is
    // the one --shots mode features in the system and planet captures.
    for (const s of [...live].reverse()) {
      if (s.kind === 'codex') {
        const dirs = fs.readdirSync(s.projectDir).filter((d) => fs.statSync(path.join(s.projectDir, d)).isDirectory());
        const changes = { [path.join(s.projectDir, pick(dirs), pick(FILES))]: { type: 'update', content: '// demo' } };
        fs.appendFileSync(s.file, [
          { timestamp: iso(now), type: 'response_item', payload: { type: 'custom_tool_call', call_id: `patch-${batch}`, name: 'apply_patch', input: '...' } },
          { timestamp: iso(now + 300), type: 'event_msg', payload: { type: 'patch_apply_end', call_id: `patch-${batch}`, success: true, stdout: 'ok', changes } },
          { timestamp: iso(now + 600), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: `patch-${batch}`, output: 'ok' } },
        ].map(line).join(''));
        continue;
      }
      let out = editPair(s.projectDir, s.sessionId, now, `${s.sessionId.slice(-4)}-b${batch}`, s.drone);
      if (s.attention) {
        // A tool_use that never gets a tool_result, timestamped well past the
        // 10 s threshold: the app shows "Needs permission".
        out += claudeLine(s.projectDir, s.sessionId, now - 45_000, { type: 'assistant', message: { role: 'assistant', content: [
          { type: 'tool_use', id: `${s.sessionId.slice(-4)}-pending-${batch}`, name: 'Bash', input: { command: 'npm test' } }] } });
      }
      fs.appendFileSync(s.file, out);
    }
    batch++;
    await sleep(1500);
  }
}

function profileEnv(profile) {
  return {
    ...process.env,
    HOME: profile, USERPROFILE: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(profile, '.config'),
  };
}

function runShots(profile, live) {
  const electron = require('electron');
  return new Promise((resolve, reject) => {
    const child = spawn(electron, ['.', '--shots'], { cwd: ROOT, env: profileEnv(profile), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('shots mode did not finish in 120 s')); }, 120_000);
    streamActivity(live, 12_000).catch(reject);
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`electron exited ${code}\n${out}`)); });
    child.on('error', reject);
  });
}

const { profile, live } = buildProfile();
console.log(`demo profile: ${profile}`);
try {
  await runShots(profile, live);
  fs.mkdirSync(OUT, { recursive: true });
  for (const view of ['universe', 'system', 'planet']) {
    const src = path.join(ROOT, '.shots', `shot-${view}.png`);
    if (!fs.existsSync(src)) throw new Error(`missing capture ${src}`);
    fs.copyFileSync(src, path.join(OUT, `${view}.png`));
    console.log(`wrote docs/screenshots/${view}.png`);
  }
} finally {
  if (KEEP) {
    console.log('\nProfile kept. To run the live app against it (PowerShell):');
    console.log(`  $env:HOME='${profile}'; $env:USERPROFILE='${profile}'; $env:APPDATA='${path.join(profile, 'AppData', 'Roaming')}'; $env:LOCALAPPDATA='${path.join(profile, 'AppData', 'Local')}'; npm start`);
    console.log('Record with Win+Alt+R (Game Bar) or OBS, then delete the folder.');
  } else {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
