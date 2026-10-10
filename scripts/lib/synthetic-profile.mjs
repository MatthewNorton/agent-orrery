// A throwaway home directory holding a fictional Claude Code and Codex universe, so the app
// can run (`--shots`, or the live app) without reading the real ~/.claude, ~/.codex or
// app state. Used by scripts/demo-shots.mjs and kit/grade.mjs.
//
// How the tracker sees it (see src/main/tracker.js):
//   - projects come from transcript folders; their planets come from the persisted
//     universe-state.json, which is written here with fictional edit counts;
//   - only transcript files modified in the last 15 min are tailed, and at startup
//     their existing content is skipped, so "live" activity (edits, a subagent, a
//     pending permission prompt) is appended while the app is running;
//   - old sessions get old modification times so they do not show as live ships.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const APP_NAME = createRequire(import.meta.url)('../../package.json').name; // Electron userData folder
const SEED = 20260929;

// Galaxies come from the parent folder of each project path; projects from the
// folder name; planets from the top-level directories that edits touched.
export const GALAXIES = {
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
export const FILES = ['index.js', 'router.js', 'schema.js', 'handlers.js', 'utils.js', 'README.md', 'config.json', 'client.js'];

// mulberry32: deterministic so re-running gives the same universe.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uuid = (n) => `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString();
const line = (obj) => `${JSON.stringify(obj)}\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function claudeLine(projectDir, sessionId, ts, body, sidechain = false) {
  return line({ timestamp: iso(ts), cwd: projectDir, sessionId, ...(sidechain ? { isSidechain: true } : {}), ...body });
}

export function editPair(projectDir, dirs, pick, sessionId, ts, id, sidechain = false) {
  const file = path.join(projectDir, pick(dirs), pick(FILES));
  return claudeLine(projectDir, sessionId, ts, { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id, name: id.endsWith('5') ? 'Write' : 'Edit', input: { file_path: file, new_string: '// demo' } }] } }, sidechain)
    + claudeLine(projectDir, sessionId, ts + 700, { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: id, content: 'ok' }] } }, sidechain);
}

// A tool_use that never gets a tool_result, timestamped well past the 10 s threshold:
// the app shows "Needs permission".
export function pendingPermissionLine(projectDir, sessionId, ts, id) {
  return claudeLine(projectDir, sessionId, ts - 45_000, { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } });
}

export function codexPatchLines(projectDir, dirs, pick, callId, ts) {
  const changes = { [path.join(projectDir, pick(dirs), pick(FILES))]: { type: 'update', content: '// demo' } };
  return [
    { timestamp: iso(ts), type: 'response_item', payload: { type: 'custom_tool_call', call_id: callId, name: 'apply_patch', input: '...' } },
    { timestamp: iso(ts + 300), type: 'event_msg', payload: { type: 'patch_apply_end', call_id: callId, success: true, stdout: 'ok', changes } },
    { timestamp: iso(ts + 600), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: 'ok' } },
  ].map(line).join('');
}

// Where Electron puts app.getPath('userData') once HOME/USERPROFILE/APPDATA/XDG point at root.
export function userDataDir(root, platform = process.platform) {
  if (platform === 'win32') return path.join(root, 'AppData', 'Roaming', APP_NAME);
  if (platform === 'darwin') return path.join(root, 'Library', 'Application Support', APP_NAME);
  return path.join(root, '.config', APP_NAME);
}

// The real Signal config would otherwise be read through AGENT_UNIVERSE_PROVIDER_CONFIG.
export function profileEnv(root, base = process.env) {
  const { AGENT_UNIVERSE_PROVIDER_CONFIG: _real, ...env } = base;
  return {
    ...env,
    HOME: root, USERPROFILE: root,
    APPDATA: path.join(root, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(root, '.config'), XDG_DATA_HOME: path.join(root, '.local', 'share'),
    XDG_CACHE_HOME: path.join(root, '.cache'),
  };
}

export function isInside(root, target) {
  if (typeof target !== 'string' || !target) return false;
  const rel = path.relative(root, target);
  return rel !== '' && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
}

// An old, finished session: a handful of edits with old timestamps, and an old file
// modification time so the tracker treats it as history, not a live ship.
function writeHistorySession(claudeDir, projectDir, dirs, pick, sessionId, endedAt) {
  let t = endedAt - 40 * 60_000;
  let out = claudeLine(projectDir, sessionId, t, { type: 'user', message: { role: 'user', content: 'Continue the current task.' } });
  for (let i = 0; i < 6; i++) { t += 60_000; out += editPair(projectDir, dirs, pick, sessionId, t, `${sessionId.slice(-4)}-h${i}`); }
  out += claudeLine(projectDir, sessionId, t + 5000, { type: 'system', subtype: 'turn_duration' });
  const file = path.join(claudeDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, out);
  fs.utimesSync(file, endedAt / 1000, endedAt / 1000);
}

export function createSyntheticProfile({ prefix = 'agent-universe-synthetic-', seed = SEED, now = Date.now() } = {}) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = profileEnv(root);
  const claudeRoot = path.join(root, '.claude', 'projects');
  const codexDay = path.join(root, '.codex', 'sessions', '2026', '09', '29');
  const stateDir = userDataDir(root);
  for (const d of [claudeRoot, codexDay, path.join(root, '.codex', 'archived_sessions'), env.APPDATA, env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, path.join(root, 'Library', 'Application Support'), stateDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const state = { projects: {}, pathIds: {}, pathOverrides: {} };
  const live = []; // { kind, file, projectDir, dirs, sessionId, attention, drone }
  let n = 1;
  for (const [galaxy, projects] of Object.entries(GALAXIES)) {
    for (const p of projects) {
      const projectDir = path.join(root, galaxy, p.name);
      const dirs = [...p.dirs].sort(); // the order readdirSync lists them in
      for (const d of p.dirs) {
        fs.mkdirSync(path.join(projectDir, d), { recursive: true });
        for (const f of FILES) fs.writeFileSync(path.join(projectDir, d, f), '// demo\n');
      }
      fs.writeFileSync(path.join(projectDir, 'README.md'), `# ${p.name}\n`);
      const slug = `-${galaxy}-${p.name}`;
      const claudeDir = path.join(claudeRoot, slug);
      fs.mkdirSync(claudeDir, { recursive: true });

      const buckets = Object.fromEntries(p.dirs.map((d, i) => [d, p.edits[i] || 1]));
      state.projects[slug] = { buckets, totalBuilds: Object.values(buckets).reduce((a, b) => a + b, 0), firstSeen: now - 40 * 86_400_000 };

      const daysAgo = 2 + Math.floor(rand() * 20);
      writeHistorySession(claudeDir, projectDir, dirs, pick, uuid(n++), now - daysAgo * 86_400_000);
      writeHistorySession(claudeDir, projectDir, dirs, pick, uuid(n++), now - (daysAgo + 3) * 86_400_000);

      if (p.live === 'claude') {
        const sessionId = uuid(n++);
        const file = path.join(claudeDir, `${sessionId}.jsonl`);
        fs.writeFileSync(file, claudeLine(projectDir, sessionId, now - 4 * 60_000, { type: 'user', message: { role: 'user', content: 'Continue the current task.' } }));
        live.push({ kind: 'claude', file, projectDir, dirs, sessionId, attention: !!p.attention });
        if (p.drone) {
          const droneId = uuid(n++);
          const droneFile = path.join(claudeDir, `${droneId}.jsonl`);
          fs.writeFileSync(droneFile, claudeLine(projectDir, droneId, now - 2 * 60_000, { type: 'user', message: { role: 'user', content: 'Subagent task.' } }, true));
          live.push({ kind: 'claude', file: droneFile, projectDir, dirs, sessionId: droneId, drone: true });
        }
      }
      if (p.live === 'codex') {
        const sessionId = uuid(n++);
        const file = path.join(codexDay, `rollout-2026-09-29T12-00-00-${sessionId}.jsonl`);
        fs.writeFileSync(file, [
          { timestamp: iso(now - 3 * 60_000), type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: projectDir, thread_source: 'user' } },
          { timestamp: iso(now - 3 * 60_000 + 1000), type: 'event_msg', payload: { type: 'task_started' } },
        ].map(line).join(''));
        live.push({ kind: 'codex', file, projectDir, dirs, sessionId });
      }
    }
  }
  const statePath = path.join(stateDir, 'universe-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));

  let batch = 0;
  let disposed = false;

  // One batch of live activity. Reverse order so the first configured live project
  // (orion-api) is touched last and becomes the most recently active project, which is
  // the one --shots mode features in the system and planet captures.
  function appendActivity(at = Date.now()) {
    if (disposed) return;
    for (const s of [...live].reverse()) {
      if (s.kind === 'codex') {
        fs.appendFileSync(s.file, codexPatchLines(s.projectDir, s.dirs, pick, `patch-${batch}`, at));
        continue;
      }
      let out = editPair(s.projectDir, s.dirs, pick, s.sessionId, at, `${s.sessionId.slice(-4)}-b${batch}`, s.drone);
      if (s.attention) out += pendingPermissionLine(s.projectDir, s.sessionId, at, `${s.sessionId.slice(-4)}-pending-${batch}`);
      fs.appendFileSync(s.file, out);
    }
    batch++;
  }

  // Batches written before the tracker's startup scan are ignored (by design); later ones are tailed.
  async function streamActivity(stopAfterMs) {
    const started = Date.now();
    while (!disposed && Date.now() - started < stopAfterMs) {
      appendActivity();
      await sleep(1500);
    }
  }

  function dispose() {
    disposed = true;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }

  return { root, env, statePath, live, appendActivity, streamActivity, dispose };
}
