// Item 04 mechanical + rendered grader. Run from anywhere:
//   node kit/done/galaxy-grouping/grade-galaxies.mjs
// Exit 0 = PASS, 1 = FAIL. This file remains unchanged when archived.
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
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure/i;

function fail(id, message) { failures.push(`${id}: ${message}`); }
function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { fail('G0', `missing ${rel}`); return ''; }
  return fs.readFileSync(file, 'utf8');
}
function same(actual, expected, label) {
  try { assert.deepStrictEqual(actual, expected); }
  catch { fail('G1', `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); }
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
      killer.once('exit', resolve); killer.once('error', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if (error?.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }
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
const indexSource = read('src/renderer/index.html');
// 2026-10-13: renderer files may be split. A view's source is its scene-<view>*.js files plus the
// shared scene helpers and ship-assets*.js; util source is util.js plus util-*.js.
const rendererJs = fs.readdirSync(path.join(root, 'src', 'renderer')).filter((f) => f.endsWith('.js')).sort();
const VIEWS = ['universe', 'system', 'planet'];
const viewSource = (view) => rendererJs.filter((f) => f.startsWith(`scene-${view}`) || f.startsWith('ship-assets') ||
  (f.startsWith('scene-') && !VIEWS.some((other) => f.startsWith(`scene-${other}`))))
  .map((f) => read(`src/renderer/${f}`)).join('\n');
const utilLayer = () => rendererJs.filter((f) => /^util(-[a-z0-9-]+)?\.js$/.test(f))
  .map((f) => read(`src/renderer/${f}`)).join('\n');
const universeSource = viewSource('universe');
const layoutPath = path.join(root, 'src', 'renderer', 'galaxy-layout.js');

if (!/function\s+deriveGalaxy\s*\(/.test(trackerSource) ||
    !/module\.exports\s*=\s*\{[^}]*deriveGalaxy/s.test(trackerSource) ||
    !/galaxy\s*:\s*deriveGalaxy\s*\(/.test(trackerSource)) {
  fail('G1', 'tracker does not export and serialize deriveGalaxy');
}
if (!fs.existsSync(layoutPath)) fail('G2', 'missing pure src/renderer/galaxy-layout.js');
if (!indexSource.includes('galaxy-layout.js')) fail('G2', 'renderer does not load galaxy-layout.js');
if (!/galaxyStats/.test(universeSource) || !/galaxyMetrics/.test(mainSource)) {
  fail('G4', 'live galaxy metrics are not wired into the isolated harness');
}

let Tracker;
let deriveGalaxy;
let galaxyLayout;
if (failures.length === 0) {
  try {
    ({ Tracker, deriveGalaxy } = require(path.join(root, 'src', 'main', 'tracker.js')));
    galaxyLayout = require(layoutPath);
  } catch (error) { fail('G0', `module load failed: ${error.stack || error}`); }
}

if (failures.length === 0) {
  const cases = [
    ['C:\\workspace\\code\\personal\\portfolio', 'id', true,
      { key: 'workspace:personal', label: 'Personal' }],
    ['c:/WORKSPACE/code/Personal/portfolio/', 'id', true,
      { key: 'workspace:personal', label: 'Personal' }],
    ['C:\\workspace\\code\\experimental', 'id', true,
      { key: 'workspace:experimental', label: 'Experimental' }],
    ['/workspace/code/research/mono/packages/api', 'id', true,
      { key: 'workspace:research', label: 'Research' }],
    ['/srv/repos/acme/platform/api', 'id', true,
      { key: 'container:acme', label: 'Acme' }],
    ['C:\\Users\\matt\\Documents\\Codex\\task', 'id', true,
      { key: 'home:documents', label: 'Documents' }],
    ['/home/alice/Documents/Codex/task', 'id', true,
      { key: 'home:documents', label: 'Documents' }],
    ['/Users/alice/Desktop/task', 'id', true,
      { key: 'home:desktop', label: 'Desktop' }],
    ['C:\\Users\\matt\\.claude\\agents', 'id', true,
      { key: 'home', label: 'Home' }],
    ['C:\\Clients\\Acme\\repo', 'id', true,
      { key: 'path:win:c:/clients/acme', label: 'Acme' }],
    ['/opt/Acme/repo', 'id', true,
      { key: 'path:posix:/opt/Acme', label: 'Acme' }],
    ['C:\\top-level-repo', 'id', true,
      { key: 'path:win:c:/', label: 'C: Drive' }],
    ['/top-level-repo', 'id', true,
      { key: 'path:posix:/', label: 'Root' }],
    ['C:\\workspace\\code\\personal\\gone', 'id', false,
      { key: 'graveyard', label: 'Graveyard' }],
    [null, 'C--workspace-code-personal-missing-repo', false,
      { key: 'workspace:personal', label: 'Personal' }],
    [null, '-home-alice-Documents-Codex-task', false,
      { key: 'home:documents', label: 'Documents' }],
  ];
  for (const [projectPath, id, exists, expected] of cases) {
    same(deriveGalaxy(projectPath, id, exists), expected, `${projectPath || id}`);
  }
  const opaqueA = deriveGalaxy(null, 'opaque-alpha', false);
  const opaqueAgain = deriveGalaxy(null, 'opaque-alpha', false);
  const opaqueB = deriveGalaxy(null, 'opaque-beta', false);
  same(opaqueA, opaqueAgain, 'opaque repeat');
  if (!/^slug:[0-9a-f]{8}$/.test(opaqueA.key) || opaqueA.key === opaqueB.key ||
      typeof opaqueA.label !== 'string' || opaqueA.label.length > 32) {
    fail('G1', `opaque slug fallback is not bounded/deterministic: ${JSON.stringify(opaqueA)}`);
  }

  let integrationRoot;
  try {
    integrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-galaxy-unit-'));
    const projectPath = path.join(integrationRoot, 'workspace', 'code', 'personal', 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    const raw = {
      id: 'integration', path: projectPath, name: 'repo', exists: true,
      lastActivity: 1, totalBytes: 2, buckets: {}, totalBuilds: 0, firstSeen: 1,
    };
    const tracker = new Tracker(path.join(integrationRoot, 'state.json'));
    tracker.projects.set(raw.id, raw);
    const expected = { key: 'workspace:personal', label: 'Personal' };
    same(tracker.snapshot().projects[0].galaxy, expected, 'snapshot galaxy');
    same(tracker.getSystem(raw.id).project.galaxy, expected, 'system galaxy');
    same(tracker.getPlanet(raw.id, 'Sector-1').project.galaxy, expected, 'planet galaxy');

    const latePath = path.join(integrationRoot, 'workspace', 'code', 'research', 'late');
    fs.mkdirSync(latePath, { recursive: true });
    const late = { ...raw, id: 'late', path: null, name: 'late', exists: false };
    tracker.projects.set(late.id, late);
    const batches = [];
    tracker.on('events', (batch) => batches.push(batch));
    tracker.parseLine(JSON.stringify({
      type: 'user', timestamp: new Date().toISOString(), cwd: latePath,
      message: { role: 'user', content: 'fixture' },
    }), { project: late.id, session: 'late-session', catchup: false });
    tracker.flush();
    const update = batches.flat().find((event) =>
      event.type === 'project-updated' && event.project?.id === late.id);
    if (!update) fail('G1', 'late cwd emitted no project-updated payload');
    else same(update.project.galaxy,
      { key: 'workspace:research', label: 'Research' }, 'late cwd galaxy');
  } catch (error) { fail('G1', `tracker integration: ${error.stack || error}`); }
  finally { if (integrationRoot) fs.rmSync(integrationRoot, { recursive: true, force: true }); }
}

if (failures.length === 0) {
  try {
    if (typeof galaxyLayout.layoutGalaxyProjects !== 'function' ||
        typeof galaxyLayout.galaxyColor !== 'function') {
      throw new Error('expected layoutGalaxyProjects and galaxyColor exports');
    }
    const counts = [
      ['workspace:personal', 'Personal', 8],
      ['workspace:experimental', 'Experimental', 8],
      ['home:documents', 'Documents', 8],
      ['graveyard', 'Graveyard', 6],
    ];
    const projects = [];
    for (const [key, label, count] of counts) {
      for (let i = 0; i < count; i++) {
        projects.push({ id: `${key}:${i}`, seed: i + 1, galaxy: { key, label } });
      }
    }
    const forward = galaxyLayout.layoutGalaxyProjects(projects);
    const reverse = galaxyLayout.layoutGalaxyProjects([...projects].reverse());
    same(reverse, forward, 'layout input-order invariance');
    if (forward.galaxies.length !== 4 || forward.projects.length !== 30) {
      fail('G2', `layout cardinality ${forward.galaxies.length}/${forward.projects.length}`);
    }
    const galaxyByKey = new Map(forward.galaxies.map((item) => [item.key, item]));
    const seen = new Set();
    const positionsByGalaxy = new Map();
    for (const item of forward.projects) {
      const galaxy = galaxyByKey.get(item.galaxyKey);
      if (!galaxy || seen.has(item.id) || ![item.x, item.z].every(Number.isFinite)) {
        fail('G2', `invalid/duplicate project placement ${JSON.stringify(item)}`); continue;
      }
      seen.add(item.id);
      const distance = Math.hypot(item.x - galaxy.x, item.z - galaxy.z);
      if (distance > galaxy.radius + 1e-9) fail('G2', `${item.id} escapes ${galaxy.key}`);
      const key = `${item.x.toFixed(6)},${item.z.toFixed(6)}`;
      if (!positionsByGalaxy.has(item.galaxyKey)) positionsByGalaxy.set(item.galaxyKey, new Set());
      positionsByGalaxy.get(item.galaxyKey).add(key);
    }
    if (seen.size !== 30) fail('G2', `only ${seen.size}/30 projects placed`);
    for (const [key, label, count] of counts) {
      if (!galaxyByKey.has(key) || positionsByGalaxy.get(key)?.size !== count) {
        fail('G2', `${label} placement/count mismatch`);
      }
    }
    for (let i = 0; i < forward.galaxies.length; i++) {
      const a = forward.galaxies[i];
      if (![a.x, a.z, a.radius].every(Number.isFinite) || a.radius <= 0) {
        fail('G2', `non-finite galaxy ${JSON.stringify(a)}`);
      }
      for (let j = i + 1; j < forward.galaxies.length; j++) {
        const b = forward.galaxies[j];
        if (Math.hypot(a.x - b.x, a.z - b.z) <= a.radius + b.radius) {
          fail('G2', `${a.key} overlaps ${b.key}`);
        }
      }
    }
    const graveyard = galaxyByKey.get('graveyard');
    const graveDistance = Math.hypot(graveyard.x, graveyard.z);
    if (forward.galaxies.some((item) => item.key !== 'graveyard' &&
        Math.hypot(item.x, item.z) >= graveDistance)) {
      fail('G2', 'Graveyard is not on the layout periphery');
    }
    const colors = new Set(forward.galaxies.map((item) => galaxyLayout.galaxyColor(item.key)));
    if (colors.size < 4 || [...colors].some((color) => !/^#[0-9a-f]{6}$/i.test(color))) {
      fail('G2', `galaxy colors are invalid/non-distinct: ${[...colors].join(', ')}`);
    }
  } catch (error) { fail('G2', error.stack || String(error)); }
}

let tempRoot;
let outDir;
let child;
if (failures.length === 0) {
  try {
    const shotsRoot = path.join(root, '.shots', 'galaxy');
    fs.mkdirSync(shotsRoot, { recursive: true });
    outDir = fs.mkdtempSync(path.join(shotsRoot, 'run-'));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-galaxy-live-'));
    const profile = path.join(tempRoot, 'home', 'fixture');
    const transcripts = path.join(profile, '.claude', 'projects');
    fs.mkdirSync(transcripts, { recursive: true });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const fixture = [];
    for (const [bucket, count] of [['personal', 8], ['experimental', 8]]) {
      for (let i = 0; i < count; i++) {
        fixture.push({
          slug: `fixture-${bucket}-${i + 1}`,
          cwd: path.join(tempRoot, 'workspace', 'code', bucket, `project-${i + 1}`),
          exists: true,
        });
      }
    }
    for (let i = 0; i < 8; i++) fixture.push({
      slug: `fixture-documents-${i + 1}`,
      cwd: path.join(profile, 'Documents', `project-${i + 1}`), exists: true,
    });
    for (let i = 0; i < 6; i++) fixture.push({
      slug: `fixture-graveyard-${i + 1}`,
      cwd: path.join(tempRoot, 'deleted', `project-${i + 1}`), exists: false,
    });
    for (const [index, item] of fixture.entries()) {
      const dir = path.join(transcripts, item.slug);
      fs.mkdirSync(dir, { recursive: true });
      if (item.exists) fs.mkdirSync(item.cwd, { recursive: true });
      const file = path.join(dir, `session-${index + 1}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({
        type: 'user', timestamp: old.toISOString(), cwd: item.cwd,
        message: { role: 'user', content: 'fixture' },
      }) + '\n');
      fs.utimesSync(file, old, old);
    }

    const electron = process.platform === 'win32'
      ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(root, 'node_modules', '.bin', 'electron');
    const env = {
      ...process.env, USERPROFILE: profile, HOME: profile,
      APPDATA: path.join(profile, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    };
    fs.mkdirSync(env.APPDATA, { recursive: true });
    fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
    const started = Date.now();
    child = spawn(electron, ['.', '--polish-test', `--polish-output=${outDir}`], {
      cwd: root, env, windowsHide: true, detached: process.platform !== 'win32',
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
    child.stderr.on('data', (data) => { output += data; process.stderr.write(data); });
    const exitCode = await withTimeout(new Promise((resolve) => {
      child.once('exit', resolve); child.once('error', () => resolve('spawn-error'));
    }), 90_000, 'timeout');
    if (exitCode === 'timeout') await terminateTree(child);
    if (exitCode !== 0) fail('G4', `Electron harness exited with ${exitCode}`);
    const errors = output.split(/\r?\n/).filter((line) => ERROR_RE.test(line));
    if (errors.length) fail('G4', `renderer errors: ${errors.slice(0, 5).join(' | ')}`);

    const resultPath = path.join(outDir, 'result.json');
    if (!fs.existsSync(resultPath)) fail('G4', 'missing result.json');
    else {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      if (result.passed !== true) fail('G4', `harness failed: ${result.error || 'unknown'}`);
      const m = result.galaxyMetrics || {};
      if (m.projectCount !== 30 || m.galaxyCount !== 4 || m.graveyardProjectCount !== 6) {
        fail('G4', `rendered cardinality ${m.projectCount}/${m.galaxyCount}/${m.graveyardProjectCount}`);
      }
      const expectedCounts = {
        'workspace:personal': 8, 'workspace:experimental': 8,
        'home:documents': 8, graveyard: 6,
      };
      const actualCounts = Object.fromEntries((m.clusters || []).map((g) => [g.key, g.memberCount]));
      if (JSON.stringify(Object.entries(actualCounts).sort()) !==
          JSON.stringify(Object.entries(expectedCounts).sort())) {
        fail('G4', `rendered groups ${JSON.stringify(actualCounts)}`);
      }
      if (m.pickableSunCount !== 30 || m.projectLabelControlCount !== 30 ||
          m.regionMeshCount !== 4 || m.pickableRegionCount !== 0 ||
          m.galaxyLabelControlCount !== 4) {
        fail('G4', `mesh/control proof ${m.pickableSunCount}/${m.projectLabelControlCount}/${m.regionMeshCount}/${m.pickableRegionCount}/${m.galaxyLabelControlCount}`);
      }
      if (m.assignmentMismatchCount !== 0 || m.memberOutsideCount !== 0 ||
          !Number.isFinite(m.minClusterGap) || m.minClusterGap <= 0 ||
          !Array.isArray(m.assignments) || m.assignments.length !== 30) {
        fail('G4', 'actual glyph assignment/containment/separation proof failed');
      }
      if (m.visibleGalaxyLabelCount < 3 || m.combinedLabelOverlaps !== 0 ||
          m.combinedChromeOcclusions !== 0 || m.distinctColorCount < 4) {
        fail('G4', `galaxy labels/colors ${m.visibleGalaxyLabelCount}/${m.combinedLabelOverlaps}/${m.combinedChromeOcclusions}/${m.distinctColorCount}`);
      }
      const labels = result.labelMetrics || {};
      if (labels.glyphCount !== 30 || labels.pickableSunCount !== 30 ||
          labels.labelControlCount !== 30 || labels.overlaps !== 0 ||
          labels.measuredOverlaps !== 0 || labels.hoverReveal !== true) {
        fail('G4', 'existing project label/pointer proof regressed');
      }
      const luma = result.backdropMetrics || {};
      if (!(luma.median <= 24 && luma.p90 <= 48 && luma.p99 >= 18 && luma.stddev >= 3)) {
        fail('G4', `backdrop luma ${JSON.stringify(luma)}`);
      }
    }
    for (const name of ['universe', 'hover', 'camera', 'back-universe']) {
      const file = path.join(outDir, `${name}.png`);
      if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < started || fs.statSync(file).size < 30 * 1024) {
        fail('G4', `${name}.png missing, stale, or blank`);
      }
    }
    notes.push(`artifacts ${outDir}`);
  } catch (error) { fail('G4', error.stack || String(error)); }
  finally {
    await terminateTree(child);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log('\n============= GALAXY GRADE =============');
for (const note of notes) console.log(`INFO  ${note}`);
if (failures.length) {
  for (const item of failures) console.log(`FAIL  ${item}`);
  process.exit(1);
}
console.log('PASS  G1-G4 galaxy grouping checks green');
