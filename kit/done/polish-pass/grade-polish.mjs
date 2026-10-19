// Item 02 mechanical + rendered grader. Run from anywhere:
//   node kit/done/polish-pass/grade-polish.mjs
// Exit 0 = PASS, 1 = FAIL.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const polishShotsDir = path.join(root, '.shots', 'polish');
let outDir = null;
const failures = [];
const notes = [];
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure/i;

function fail(id, message) { failures.push(`${id}: ${message}`); }
function close(a, b, epsilon = 1e-6) { return Math.abs(a - b) <= epsilon; }
function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { fail('P0', `missing ${rel}`); return '';
  }
  return fs.readFileSync(file, 'utf8');
}

async function withTimeout(promise, timeoutMs, timeoutValue) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(timeoutValue), timeoutMs); }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

async function waitForChildExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  return withTimeout(
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    timeoutMs, false
  );
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    try {
      // The harness is spawned detached on POSIX, so a negative PID targets
      // Electron and every renderer/GPU descendant in its process group.
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }
  return waitForChildExit(child);
}

function validateClickProof(result, proof, label, afterIndex) {
  const events = Array.isArray(result.inputEvents) ? result.inputEvents : [];
  if (!proof || !Number.isInteger(proof.start) || !Number.isInteger(proof.end) ||
      proof.start < afterIndex || proof.end !== proof.start + 3) {
    fail('P4', `${label} has no ordered low-level input proof`);
    return afterIndex;
  }
  const slice = events.slice(proof.start, proof.end);
  const types = slice.map((event) => event.type);
  const samePoint = slice.length === 3 && slice.every(
    (event) => event.x === proof.x && event.y === proof.y
  );
  if (JSON.stringify(types) !== JSON.stringify(['mouseMove', 'mouseDown', 'mouseUp']) ||
      !samePoint || slice[1].button !== 'left' || slice[2].button !== 'left') {
    fail('P4', `${label} input proof does not contain a real move/down/up click`);
  }
  return proof.end;
}

// Kit 14 (2026-10-01): main.js is split across src/main; grep the whole layer.
function readLayer(dir, skip = () => false) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => e.isDirectory() ? [readLayer(path.join(dir, e.name), skip)]
      : e.name.endsWith('.js') && !skip(e.name) ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : [])
    .join('\n');
}
const mainSource = readLayer(path.join(root, 'src', 'main'));
// 2026-10-18: the input proof is the harness. Its screenshot mode (modes/shots.js) arranges
// panels for `npm run shots` and claims no input, so it alone may fold them with element.click().
const inputSource = readLayer(path.join(root, 'src', 'main', 'harness'), (name) => name === 'shots.js');
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
const systemSource = viewSource('system');
const indexSource = read('src/renderer/index.html');
const mathPath = path.join(root, 'src', 'renderer', 'polish-math.js');

if (!fs.existsSync(mathPath)) fail('P1', 'missing pure label/color helper src/renderer/polish-math.js');
if (!indexSource.includes('polish-math.js')) fail('P1', 'renderer does not load polish-math.js');
if (/MAX_GLYPHS/.test(universeSource)) fail('P1', 'glyph-count truncation remains');
if (!/polishStats/.test(universeSource)) fail('P1', 'universe does not expose rendered label metrics');
if (!/UNIVERSE_SKY_LEVEL/.test(universeSource)) fail('P2', 'universe sky level is not named and measurable');
if (!/sunMat\.emissiveColor\s*=\s*sunCol\.clone\(\)/.test(systemSource)) {
  fail('P3', 'system sun material still aliases its base Color3');
}
if (!/--polish-test/.test(mainSource) || !/sendTestInput/.test(mainSource) || !/sendInputEvent/.test(mainSource)) {
  fail('P4', 'real Electron pointer harness is missing');
}
if (/\.click\(\)/.test(inputSource)) fail('P4', 'input harness contains direct element.click() input');

// Fail before launching Electron when the implementation has not started.
if (failures.length === 0) {
  const require = createRequire(import.meta.url);
  const polish = require(mathPath);
  const BABYLON = require(path.join(root, 'node_modules', 'babylonjs'));

  const candidates = [
    { id: 'recent', priority: 4, rect: { x: 10, y: 10, width: 90, height: 20 } },
    { id: 'hovered', priority: 0, rect: { x: 20, y: 10, width: 90, height: 20 } },
    { id: 'isolated', priority: 5, rect: { x: 150, y: 10, width: 90, height: 20 } },
    { id: 'offscreen', priority: 1, rect: { x: 390, y: 10, width: 40, height: 20 } },
  ];
  const selected = polish.selectLabelLayout(candidates, { x: 0, y: 0, width: 400, height: 100 }, 6);
  const ids = selected.map((p) => p.id);
  if (!ids.includes('hovered') || ids.includes('recent') || !ids.includes('isolated') || ids.includes('offscreen')) {
    fail('P1', `pure selector priority/clipping mismatch: ${ids.join(', ')}`);
  }
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      if (polish.rectsOverlap(selected[i].rect, selected[j].rect, 6)) {
        fail('P1', `${selected[i].id} overlaps ${selected[j].id}`);
      }
    }
  }
  const priority = polish.selectLabelLayout([
    { id: 'recent', priority: 3, rect: { x: 10, y: 10, width: 80, height: 20 } },
    { id: 'online', priority: 2, rect: { x: 10, y: 10, width: 80, height: 20 } },
    { id: 'attention', priority: 1, rect: { x: 10, y: 10, width: 80, height: 20 } },
  ], { x: 0, y: 0, width: 200, height: 100 }, 6);
  if (priority.length !== 1 || priority[0].id !== 'attention') {
    fail('P1', `attention/online/recent priority mismatch: ${priority.map((item) => item.id).join(', ')}`);
  }

  const base = BABYLON.Color3.FromHexString('#9db8ff');
  const original = base.clone();
  const material = base.clone();
  if (material === base) fail('P3', 'material test setup aliases base');
  for (let i = 0; i < 240; i++) {
    const t = i / 17;
    const factor = polish.applySunPulse(material, base, t);
    if (!close(material.r, original.r * factor) ||
        !close(material.g, original.g * factor) ||
        !close(material.b, original.b * factor)) {
      fail('P3', `pulse drift at tick ${i}`);
      break;
    }
  }
  if (!close(base.r, original.r, 0) || !close(base.g, original.g, 0) || !close(base.b, original.b, 0)) {
    fail('P3', 'base sun color mutated across pulse ticks');
  }
}

let tempRoot = null;
let child = null;
if (failures.length === 0) {
  try {
    fs.mkdirSync(polishShotsDir, { recursive: true });
    outDir = fs.mkdtempSync(path.join(polishShotsDir, 'run-'));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-universe-polish-'));
    const profile = path.join(tempRoot, 'home');
    const projects = path.join(profile, '.claude', 'projects');
    const workspaces = path.join(tempRoot, 'workspaces');
    fs.mkdirSync(projects, { recursive: true });
    fs.mkdirSync(workspaces, { recursive: true });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    for (let i = 0; i < 30; i++) {
      const slug = `-fixture-polish-project-${String(i + 1).padStart(2, '0')}`;
      const dir = path.join(projects, slug);
      const workspace = path.join(workspaces, `polish-project-${String(i + 1).padStart(2, '0')}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });
      const transcript = path.join(dir, `session-${i + 1}.jsonl`);
      const row = {
        type: 'user', timestamp: old.toISOString(), cwd: workspace,
        message: { role: 'user', content: 'fixture' },
      };
      fs.writeFileSync(transcript, JSON.stringify(row) + '\n');
      if (i !== 0) fs.utimesSync(transcript, old, old);
    }

    const electron = process.platform === 'win32'
      ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(root, 'node_modules', '.bin', 'electron');
    const env = {
      ...process.env,
      USERPROFILE: profile,
      HOME: profile,
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
    child.stdout.on('data', (d) => { output += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { output += d; process.stderr.write(d); });
    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve('spawn-error'));
    });
    const exitCode = await withTimeout(exitPromise, 75_000, 'timeout');
    if (exitCode === 'timeout') await terminateProcessTree(child);
    if (exitCode !== 0) fail('P4', `electron polish harness exited with ${exitCode}`);
    const errorLines = output.split(/\r?\n/).filter((line) => ERROR_RE.test(line));
    if (errorLines.length) fail('P4', `renderer error output: ${errorLines.slice(0, 5).join(' | ')}`);

    const resultPath = path.join(outDir, 'result.json');
    if (!fs.existsSync(resultPath)) {
      fail('P4', 'missing result.json');
    } else {
      let result = null;
      try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch (e) { fail('P4', `result JSON: ${e.message}`); }
      if (result) {
        if (result.passed !== true) fail('P4', `harness reported failure: ${result.error || 'unknown'}`);
        const expected = ['universe', 'system', 'planet', 'system', 'universe'];
        if (JSON.stringify(result.views) !== JSON.stringify(expected)) fail('P4', `view sequence ${JSON.stringify(result.views)}`);
        if (!result.projectId || !result.planetName) fail('P4', 'missing selected project or planet');
        if (result.openedProjectId !== result.projectId) fail('P4', 'Open Folder did not record the selected project');
        const expectedActions = ['canvas-sun-click', 'canvas-planet-click', 'back-button-click', 'back-button-click'];
        if (!Array.isArray(result.steps) ||
            JSON.stringify(result.steps.map((step) => step.action)) !== JSON.stringify(expectedActions)) {
          fail('P4', `navigation actions ${JSON.stringify(result.steps && result.steps.map((step) => step.action))}`);
        } else {
          if (!result.steps[0].pickValidated || !result.steps[1].pickValidated) fail('P4', 'canvas picks were not validated');
          let eventIndex = validateClickProof(result, result.steps[0].input, 'sun click', 0);
          eventIndex = validateClickProof(result, result.openFolderInput, 'Open Folder click', eventIndex);
          eventIndex = validateClickProof(result, result.steps[1].input, 'planet click', eventIndex);
          eventIndex = validateClickProof(result, result.steps[2].input, 'planet Back click', eventIndex);
          validateClickProof(result, result.steps[3].input, 'system Back click', eventIndex);
        }
        const labels = result.labelMetrics || {};
        if (labels.glyphCount !== 30 || labels.totalLabels !== 30 ||
            labels.pickableSunCount !== 30 || labels.labelControlCount !== 30) {
          fail('P1', `expected 30 glyphs/labels/pickable suns/controls, got ${labels.glyphCount}/${labels.totalLabels}/${labels.pickableSunCount}/${labels.labelControlCount}`);
        }
        if (labels.finiteProjections !== 30) fail('P1', `only ${labels.finiteProjections}/30 glyphs projected into screen space`);
        if (labels.visibleLabels < 3 || labels.visibleLabels > 12 || labels.hiddenLabels < 1) fail('P1', `default visibility ${labels.visibleLabels} visible, ${labels.hiddenLabels} hidden`);
        if (labels.measuredLabelCount !== labels.visibleLabels) fail('P1', `measured ${labels.measuredLabelCount}/${labels.visibleLabels} visible labels`);
        if (labels.overlaps !== 0 || labels.afterHoverOverlaps !== 0 || labels.afterCameraOverlaps !== 0 ||
            labels.measuredOverlaps !== 0 || labels.afterHoverMeasuredOverlaps !== 0 || labels.afterCameraMeasuredOverlaps !== 0) {
          fail('P1', 'estimated or measured rendered labels overlap');
        }
        if (labels.measuredChromeOcclusions !== 0 || labels.afterHoverChromeOcclusions !== 0 ||
            labels.afterCameraChromeOcclusions !== 0) fail('P1', 'a measured label intersects reserved DOM chrome');
        if (!labels.hoverReveal || labels.hoverProjectId !== result.projectId) fail('P1', 'hidden label was not revealed and clicked');
        const color = result.systemColorMetrics || {};
        if (!color.materialOwnsColor || !color.coronaOwnsColor || !color.baseStable) {
          fail('P3', `live system color identity/base check failed: ${JSON.stringify(color)}`);
        }
        const luma = result.backdropMetrics || {};
        if (!(luma.median <= 24 && luma.p90 <= 48 && luma.p99 >= 18 && luma.stddev >= 3)) {
          fail('P2', `backdrop luma median=${luma.median} p90=${luma.p90} p99=${luma.p99} stddev=${luma.stddev}`);
        }
        notes.push(`labels ${labels.visibleLabels}/${labels.totalLabels}, backdrop median ${luma.median}, p90 ${luma.p90}`);
      }
    }

    const shots = ['universe', 'hover', 'camera', 'system', 'planet', 'back-system', 'back-universe'];
    for (const name of shots) {
      const file = path.join(outDir, `${name}.png`);
      if (!fs.existsSync(file)) { fail('P4', `missing ${name}.png`); continue; }
      const st = fs.statSync(file);
      if (st.mtimeMs < started || st.size < 30 * 1024) fail('P4', `${name}.png is stale or blank`);
    }
    notes.push(`artifacts ${outDir}`);
  } catch (error) {
    fail('P0', error && error.stack ? error.stack : String(error));
  } finally {
    const terminated = await terminateProcessTree(child);
    if (!terminated) {
      fail('P0', `Electron process tree did not terminate; preserved temp profile ${tempRoot}`);
    } else if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

console.log('\n============= POLISH GRADE =============');
for (const note of notes) console.log(`INFO  ${note}`);
if (failures.length) {
  for (const item of failures) console.log(`FAIL  ${item}`);
  process.exit(1);
}
console.log('PASS  P1-P4 polish checks green');
