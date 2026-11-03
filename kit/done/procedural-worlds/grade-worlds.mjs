// Kit 15 grader: procedural worlds and the photosphere sun (CONTRACT.md W0–W6).
//   node kit/done/procedural-worlds/grade-worlds.mjs               every check
//   node kit/done/procedural-worlds/grade-worlds.mjs --killswitch  W0 only; run it first
// Exit 0 = PASS, 1 = FAIL. Writes only under .shots/worlds and .shots/worlds-killswitch.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createSyntheticProfile } from '../../../scripts/lib/synthetic-profile.mjs';

const kitDir = import.meta.dirname;
const root = path.resolve(kitDir, '..', '..', '..');
const require = createRequire(import.meta.url);
const KILLSWITCH_ONLY = process.argv.includes('--killswitch');
// Babylon reports a shader that fails to compile as 'Unable to compile effect' and 'FRAGMENT SHADER ERROR'.
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|Failed to load resource|boot-failure|Unable to compile effect|SHADER ERROR/i;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'self' blob:";
const SIZES = { low: { system: 256, detail: 1024 }, balanced: { system: 512, detail: 2048 }, high: { system: 512, detail: 2048 } };
const failures = [];
const notes = [];
const fail = (id, message) => failures.push(`${id}: ${message}`);
const read = (rel) => { const file = path.join(root, rel); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; };
const electronBin = process.platform === 'win32'
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(root, 'node_modules', '.bin', 'electron');

// D2: AUR.worldProfile(projectId, name) on main at 40331ca (2026-11-01): key, seed, hueShift, colors.
const PROFILES = [
  ['-work-orion-api', 'src', 'rocky', 1019766990, 0.02, '#171a20 #55504a #a89072'],
  ['-work-orion-api', 'test', 'gas', 2209617148, 0.04, '#30253f #b66d51 #e8c99f'],
  ['-work-orion-api', 'docs', 'ice', 878832591, 0.02, '#15283a #6595ac #d9eef1'],
  ['-work-orion-api', 'migrations', 'rocky', 3200716717, 0.12, '#171a20 #55504a #a89072'],
  ['-work-orion-api', 'scripts', 'gas', 192696936, 0.1, '#30253f #b66d51 #e8c99f'],
  ['-work-nebula-dashboard', 'test', 'volcanic', 3084078934, -0.04, '#100e0d #4b2920 #f06b32'],
  ['-work-comet-billing', 'lib', 'oceanic', 2238529249, -0.08, '#071b35 #17617a #b7cab8'],
  ['-personal-quasar-notes', 'content', 'rocky', 3349784099, 0.07, '#171a20 #55504a #a89072'],
  ['-open-source-starlight-cli', 'examples', 'oceanic', 1369243019, -0.07, '#071b35 #17617a #b7cab8'],
  ['-open-source-halo-parser', 'bench', 'volcanic', 4121110203, -0.01, '#100e0d #4b2920 #f06b32'],
];
// One planet per class from that table, with the preview's ring rule (orion-api/test is ringed).
const JOB = Object.fromEntries(['rocky', 'gas', 'ice', 'volcanic', 'oceanic'].map((cls) => {
  const [, , , seed, hue, colors] = PROFILES.find((p) => p[2] === cls);
  return [cls, { cls, seed, hue, palette: colors.split(' '), rings: cls === 'gas' && ((seed >>> 7) & 1) === 1 }];
}));

function run(cmd, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32' });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      resolve({ code: 'timeout', output });
    }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: 'spawn-error', output: output + String(error) }); });
  });
}

// ---------- W0: installed versions and the worker kill-switch ----------
function checkVersions() {
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ['electron', 'babylonjs']) {
    const wanted = String(deps[name] || '0.0.0').replace(/^[^\d]*/, '');
    let have = null;
    try { have = JSON.parse(read(`node_modules/${name}/package.json`)).version; } catch { /* not installed */ }
    const a = String(have || '0').split('.').map(Number), b = wanted.split('.').map(Number);
    const ok = have && (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && (a[2] || 0) >= (b[2] || 0)))));
    if (!ok) fail('W0', `node_modules has ${name} ${have || 'none'} but package.json asks for ^${wanted}: run npm ci`);
  }
}

const KS_MAIN = `const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [page, out] = process.argv.slice(-2);
app.whenReady().then(async () => {
  const result = { electron: process.versions.electron, console: [] };
  const win = new BrowserWindow({ width: 320, height: 200, show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'orrery-killswitch' } });
  win.webContents.on('console-message', (event) => result.console.push(String(event.message || '')));
  try {
    await win.loadFile(page);
    const until = Date.now() + 40000;
    while (Date.now() < until && !result.probe) {
      result.probe = await win.webContents.executeJavaScript('window.__killswitch || null');
      if (!result.probe) await new Promise((r) => setTimeout(r, 200));
    }
  } catch (error) { result.error = String((error && error.stack) || error); }
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  app.exit(0);
});
`;
const KS_WORKER = `importScripts('world-generator.js');
self.onmessage = (event) => {
  try {
    const out = self.ReferenceWorldGenerator.generate(event.data);
    const transfer = [out.surface.buffer, out.emission.buffer];
    if (out.clouds) transfer.push(out.clouds.buffer);
    self.postMessage(Object.assign({ ok: true }, out), transfer);
  } catch (error) { self.postMessage({ ok: false, error: String((error && error.message) || error) }); }
};
`;
const KS_PROBE = `(async function () {
  const result = { babylon: BABYLON.Engine.Version, pluginBase: typeof BABYLON.MaterialPluginBase === 'function' };
  const job = ${JSON.stringify({ ...JOB.oceanic, width: 2048, height: 1024 })};
  const started = performance.now();
  try {
    const worker = new Worker('worker.js');
    const out = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer within 15 s')), 15000);
      worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
      worker.onerror = (event) => { clearTimeout(timer); event.preventDefault(); reject(new Error('worker error event: ' + (event.message || '?'))); };
      worker.postMessage(job);
    });
    result.workerMs = Math.round(performance.now() - started);
    result.workerOk = out.ok === true;
    result.workerError = out.error || null;
    result.surfaceBytes = out.surface ? out.surface.byteLength : 0;
    result.cloudBytes = out.clouds ? out.clouds.byteLength : 0;
    worker.terminate();
    if (out.ok) {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64; document.body.appendChild(canvas);
      const engine = new BABYLON.Engine(canvas, false);
      const scene = new BABYLON.Scene(engine);
      const texture = BABYLON.RawTexture.CreateRGBATexture(out.surface, out.width, out.height, scene, true, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
      result.rawTextureReady = texture.isReady();
      scene.dispose(); engine.dispose();
    }
  } catch (error) { result.workerOk = false; result.workerError = String((error && error.message) || error); }
  try {
    const url = URL.createObjectURL(new Blob(['self.onmessage = (e) => self.postMessage(e.data * 2);'], { type: 'text/javascript' }));
    const blobWorker = new Worker(url);
    result.blobWorker = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      blobWorker.onmessage = (e) => { clearTimeout(timer); resolve(e.data === 42); };
      blobWorker.onerror = (e) => { e.preventDefault(); clearTimeout(timer); resolve(false); };
      blobWorker.postMessage(21);
    });
  } catch (error) { result.blobWorker = false; }
  window.__killswitch = result;
})();
`;

async function killSwitch() {
  // Two levels below the repo root, like src/renderer/index.html, so the Babylon path and 'self' match the app.
  const dir = path.join(root, '.shots', 'worlds-killswitch');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const csp = (read('src/renderer/index.html').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1];
  if (!csp) { fail('W0', 'cannot read the CSP meta from src/renderer/index.html'); return; }
  fs.copyFileSync(path.join(kitDir, 'reference', 'world-generator.cjs'), path.join(dir, 'world-generator.js'));
  fs.writeFileSync(path.join(dir, 'worker.js'), KS_WORKER);
  fs.writeFileSync(path.join(dir, 'probe.js'), KS_PROBE);
  fs.writeFileSync(path.join(dir, 'main.cjs'), KS_MAIN);
  fs.writeFileSync(path.join(dir, 'page.html'), '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>` +
    '<script src="../../node_modules/babylonjs/babylon.js"></script><script src="probe.js"></script></body></html>');
  const out = path.join(dir, 'result.json');
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  const { code } = await run(electronBin, [path.join(dir, 'main.cjs'), path.join(dir, 'page.html'), out], env, 60_000);
  const result = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  const probe = result && result.probe;
  if (!probe) { fail('W0', `kill-switch page never reported (exit ${code}${result && result.error ? `, ${result.error}` : ''})`); return; }
  if (!probe.workerOk) fail('W0', `classic worker from file:// failed under the app CSP: ${probe.workerError}`);
  else if (probe.workerMs > 8000) fail('W0', `2048×1024 oceanic map took ${probe.workerMs} ms in a worker (budget 8000)`);
  if (probe.workerOk && (probe.surfaceBytes !== 2048 * 1024 * 4 || probe.cloudBytes !== 2048 * 1024 * 4)) fail('W0', 'transferred buffers have the wrong size');
  if (probe.workerOk && !probe.rawTextureReady) fail('W0', 'RawTexture upload of the 2048×1024 map failed');
  if (!probe.pluginBase) fail('W0', 'BABYLON.MaterialPluginBase is missing from the Babylon bundle');
  notes.push(`kill-switch: Electron ${result.electron}, Babylon ${probe.babylon}, 2048 oceanic in a worker ${probe.workerMs} ms, blob worker ${probe.blobWorker ? 'allowed' : 'blocked'}`);
}

// ---------- W1: layout ----------
const worldsDir = path.join(root, 'src', 'renderer', 'worlds');
const PURE = ['noise.js', 'classes.js', 'maps.js'];
const RENDERER = ['textures.js', 'shaders.js', 'material.js', 'sun.js'];
function checkLayout() {
  for (const f of [...PURE, 'worker.js', ...RENDERER]) if (!fs.existsSync(path.join(worldsDir, f))) fail('W1', `missing src/renderer/worlds/${f}`);
  const files = fs.existsSync(worldsDir) ? fs.readdirSync(worldsDir, { recursive: true }).filter((f) => String(f).endsWith('.js')) : [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(worldsDir, f), 'utf8');
    if (!text.startsWith('// @ts-check')) fail('W1', `worlds/${f} does not start with // @ts-check`);
    if (text.split('\n').length > 400) fail('W1', `worlds/${f} has ${text.split('\n').length} lines (max 400)`);
    if (/^\s*(import|export)\s/m.test(text)) fail('W1', `worlds/${f} uses ES module syntax`);
  }
  const index = read('src/renderer/index.html');
  if (!index.includes(`content="${CSP}"`)) fail('W1', 'the CSP meta in src/renderer/index.html changed');
  const at = (name) => index.indexOf(`src="${name}"`);
  for (const f of [...PURE, ...RENDERER]) {
    const pos = at(`worlds/${f}`);
    if (pos < 0) fail('W1', `index.html does not load worlds/${f}`);
    else if (pos > at('scene/system/view.js') || pos > at('scene/planet/view.js')) fail('W1', `worlds/${f} loads after a view`);
  }
  if (at('worlds/worker.js') >= 0) fail('W1', 'worlds/worker.js must not be a page script');
  if (path.basename(path.dirname(kitDir)) === 'done') { notes.push('frozen-file check skipped: archived gate (it guarded the executor)'); return; }
  const base = frozenBase();
  if (!base) { notes.push('frozen-file check skipped: no base commit found'); return; }
  const changed = [
    ...spawnSync('git', ['diff', '--name-only', base], { cwd: root, encoding: 'utf8' }).stdout.split('\n'),
    ...spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).stdout.split('\n'),
  ].filter(Boolean);
  const FROZEN = [/^package(-lock)?\.json$/, /^assets\//, /^src\/preload\.js$/, /^src\/main\/window(-security)?\.js$/, /^[123]\.[a-z-]+-view\.png$/,
    /^kit\/grade\.mjs$/, /^kit\/done\//, /^kit\/todo\/15-procedural-worlds\/(grade-worlds\.mjs|reference\/)/];
  for (const file of changed) if (FROZEN.some((re) => re.test(file))) fail('W1', `frozen file changed: ${file}`);
}
// The commit that added this grader: everything after it is the executor's work.
function frozenBase() {
  const rel = path.relative(root, path.join(kitDir, 'grade-worlds.mjs')).split(path.sep).join('/');
  const added = spawnSync('git', ['log', '--diff-filter=A', '--format=%H', '--', rel], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
  return added[added.length - 1] || null;
}

// ---------- W2: the generator, in Node ----------
// The pure files run in this context with `self` passed in (a vm context would slow every global
// lookup such as Math.floor about tenfold and break the W2.6 budgets). No window, no document.
function loadWorlds() {
  const self = {};
  for (const f of PURE) {
    const code = fs.readFileSync(path.join(worldsDir, f), 'utf8');
    vm.runInThisContext(`(function (self, window, document) {\n${code}\n})`, { filename: `worlds/${f}` })(self, undefined, undefined);
  }
  if (!self.AUR || !self.AUR.worlds || typeof self.AUR.worlds.generate !== 'function') throw new Error('self.AUR.worlds.generate is missing');
  return self.AUR.worlds;
}
function compare(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0, close = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); sum += d; if (d <= 2) close++; }
  return { mean: sum / a.length, close: close / a.length };
}
function neighbours(out) {
  const { width: w, height: h, surface: s } = out;
  const diff = (a, b) => (Math.abs(s[a] - s[b]) + Math.abs(s[a + 1] - s[b + 1]) + Math.abs(s[a + 2] - s[b + 2])) / 3;
  const px = (x, y) => (y * w + x) * 4;
  let interior = 0, n = 0, seam = 0, pole = 0, equator = 0;
  for (let y = 0; y < h; y++) {
    seam += diff(px(0, y), px(w - 1, y));
    for (let x = 0; x < w - 1; x++) { interior += diff(px(x, y), px(x + 1, y)); n++; }
  }
  for (let x = 0; x < w - 1; x++) {
    pole += (diff(px(x, 0), px(x + 1, 0)) + diff(px(x, h - 1), px(x + 1, h - 1))) / 2;
    equator += diff(px(x, h >> 1), px(x + 1, h >> 1));
  }
  return { seam: seam / h / (interior / n || 1), pole: pole / (equator || 1) };
}
function checkGenerator() {
  let worlds;
  try { worlds = loadWorlds(); } catch (error) { fail('W2', `cannot load worlds/{${PURE.join(',')}} in Node: ${error.message}`); return; }
  const reference = require(path.join(kitDir, 'reference', 'world-generator.cjs'));
  const job = (cls, width, height) => ({ ...JOB[cls], width, height });
  const first = worlds.generate(job('rocky', 256, 128)), again = worlds.generate(job('rocky', 256, 128));
  for (const k of ['surface', 'emission']) {
    const c = compare(first[k], again[k]);
    if (!c || c.mean !== 0) fail('W2.1', `rocky ${k} differs between two runs`);
  }
  for (const cls of ['rocky', 'gas', 'volcanic', 'oceanic']) {
    const ours = worlds.generate(job(cls, 256, 128)), theirs = reference.generate(job(cls, 256, 128));
    for (const k of ['surface', 'emission', 'clouds', 'rings']) {
      if (!theirs[k]) { if (ours[k]) fail('W2.2', `${cls} returns ${k} the reference does not`); continue; }
      const c = compare(ours[k], theirs[k]);
      if (!c) fail('W2.2', `${cls} ${k} is missing or has the wrong length`);
      else if (c.mean > 0.5 || c.close < 0.995) fail('W2.2', `${cls} ${k} drifts from the reference (mean ${c.mean.toFixed(2)}, ${(c.close * 100).toFixed(1)}% within ±2)`);
    }
  }
  const ice = compare(worlds.generate(job('ice', 256, 128)).surface, reference.generate(job('ice', 256, 128)).surface);
  if (ice && ice.close > 0.9) fail('W2.4', 'ice still matches the reference iso-line cracks; replace them with lineae');
  for (const [width, height] of [[0, 0], [4096, 2048], [100.5, 50], [2049, 1024]]) {
    let name = null;
    try { worlds.generate(job('rocky', width, height)); } catch (error) { name = error && error.name; }
    if (name !== 'RangeError') fail('W2.3', `${width}×${height} did not throw a RangeError`);
  }
  for (const cls of Object.keys(JOB)) {
    worlds.generate(job(cls, 32, 16)); // warm the JIT before timing
    const started = performance.now();
    const out = worlds.generate(job(cls, 512, 256));
    const ms = performance.now() - started;
    if (ms > 600) fail('W2.6', `${cls} 512×256 took ${Math.round(ms)} ms (budget 600)`);
    const { seam, pole } = neighbours(out);
    if (seam > 1.6) fail('W2.3', `${cls} seam ratio ${seam.toFixed(2)} (max 1.6)`);
    if (pole > 0.08) fail('W2.3', `${cls} pole ratio ${pole.toFixed(3)} (max 0.08): pole pinch`);
    const pixels = out.width * out.height;
    let lit = 0, water = 0, ringGap = 255;
    for (let i = 0; i < pixels; i++) { if (out.emission[i * 4] || out.emission[i * 4 + 1] || out.emission[i * 4 + 2]) lit++; if (out.emission[i * 4 + 3] > 128) water++; }
    if (['rocky', 'gas', 'ice'].includes(cls) && lit) fail('W2.5', `${cls} has emission on ${lit} pixels (must be none)`);
    if (cls === 'volcanic' && (lit / pixels < 0.02 || lit / pixels > 0.35)) fail('W2.5', `volcanic lava covers ${(lit / pixels * 100).toFixed(1)}% (2–35%)`);
    if (cls === 'oceanic') {
      if (water / pixels < 0.35 || water / pixels > 0.85) fail('W2.5', `oceanic water mask covers ${(water / pixels * 100).toFixed(1)}% (35–85%)`);
      if (lit / pixels < 0.002 || lit / pixels > 0.1) fail('W2.5', `oceanic night lights cover ${(lit / pixels * 100).toFixed(2)}% (0.2–10%)`);
    }
    if ((cls === 'oceanic') !== Boolean(out.clouds)) fail('W2.5', `${cls} clouds ${out.clouds ? 'present' : 'missing'}`);
    if (Boolean(JOB[cls].rings) !== Boolean(out.rings)) fail('W2.5', `${cls} rings ${out.rings ? 'present' : 'missing'}`);
    if (out.rings) {
      if (out.rings.length !== 1024 * 4) fail('W2.5', 'rings must be 1024×1 RGBA');
      for (let i = 307; i < 717; i++) ringGap = Math.min(ringGap, out.rings[i * 4 + 3]);
      if (ringGap >= 10) fail('W2.5', 'rings have no gap between 30% and 70% of their width');
    }
  }
  const started = performance.now();
  worlds.generate(job('oceanic', 2048, 1024));
  const ms = performance.now() - started;
  if (ms > 8000) fail('W2.6', `oceanic 2048×1024 took ${Math.round(ms)} ms (budget 8000)`);
  notes.push(`generator: oceanic 2048×1024 in ${Math.round(ms)} ms on one Node thread`);
}

// ---------- W3/W4/W5: seeds kept, PNG path gone, wiring present ----------
function checkSources() {
  const sandbox = { window: {} };
  try {
    for (const f of ['util.js', 'procedural-worlds.js']) vm.runInNewContext(read(`src/renderer/${f}`), sandbox, { filename: f });
    const AUR = sandbox.window.AUR;
    for (const [id, name, key, seed, hueShift, colors] of PROFILES) {
      const p = AUR.worldProfile(id, name);
      if (p.key !== key || p.seed !== seed || p.hueShift !== hueShift || p.colors.join(' ') !== colors) fail('W3', `worldProfile(${id}, ${name}) changed (D2)`);
    }
    for (const fn of ['applyPlanetSurface', 'proceduralPlanetData', 'planetTexPath', 'planetBumpPath']) {
      if (typeof AUR[fn] !== 'undefined') fail('W4', `AUR.${fn} still exists (D1 removes the PNG planet path)`);
    }
  } catch (error) { fail('W3', `cannot load util.js + procedural-worlds.js in Node: ${error.message}`); }
  const rendererFiles = fs.readdirSync(path.join(root, 'src', 'renderer'), { recursive: true }).map((f) => String(f).split(path.sep).join('/'));
  const source = (prefix) => rendererFiles.filter((f) => f.startsWith(prefix) && /\.(js|html)$/.test(f)).map((f) => read(`src/renderer/${f}`)).join('\n');
  const all = source('');
  if (/assets\/planets/.test(all)) fail('W4', 'src/renderer still references assets/planets');
  const system = source('scene/system/'), planet = source('scene/planet/'), worlds = source('worlds/');
  if (!/sunMat\.emissiveColor\s*=\s*sunCol\.clone\(\)/.test(system)) fail('W5', 'scene/system lost sunMat.emissiveColor = sunCol.clone() (polish P3)');
  if (/addExcludedMesh\(\s*sun\s*\)/.test(system) || !/customEmissiveColorSelector/.test(system)) {
    fail('W5', 'the sun must stay in the glow pass as a dark occluder (customEmissiveColorSelector), not leave it');
  }
  if (!/extends\s+BABYLON\.MaterialPluginBase/.test(worlds)) fail('W5', 'no BABYLON.MaterialPluginBase subclass under worlds/');
  if (!/addPendingData/.test(planet) || !/removePendingData/.test(planet)) fail('W4', 'the planet view does not hold readiness for the detail map');
  if (!/new Worker\(\s*['"]worlds\/worker\.js['"]/.test(worlds)) fail('W3', "worlds/ never creates new Worker('worlds/worker.js')");
  if (!/importScripts\(/.test(read('src/renderer/worlds/worker.js'))) fail('W3', 'worlds/worker.js does not importScripts the generator');
  if (!/worldStats/.test(system) || !/worldStats/.test(planet)) fail('W6', 'both views must expose scene.metadata.worldStats()');
  const harness = ['driver.js', 'metrics.js', 'modes/polish.js'].map((f) => read(`src/main/harness/${f}`)).join('\n');
  if (!/worldMetrics/.test(harness)) fail('W6', 'the polish harness does not record worldMetrics');
}

// ---------- W6: the real app, through the polish harness ----------
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
function tint(rgb) { const s = rgb[0] + rgb[1] + rgb[2] || 1; return rgb.map((v) => v / s - 1 / 3); }
function checkSun(core, color) {
  if (!Array.isArray(core) || core.length < 3) { fail('W6', 'worldMetrics.sunCore is missing'); return; }
  const a = tint(core), b = tint(hexRgb(color));
  const na = Math.hypot(...a), nb = Math.hypot(...b) || 1;
  const cos = na ? (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb) : 0;
  if (Math.max(...core) > 250) fail('W6', `sun core ${JSON.stringify(core)} clips (max channel > 250)`);
  if (na / nb < 0.25 || cos < 0.8) fail('W6', `sun core ${JSON.stringify(core)} lost the ${color} tint (strength ${(na / nb).toFixed(2)}, direction ${cos.toFixed(2)})`);
}
function checkStats(stats, view, tier) {
  if (!stats || stats.view !== view) { fail('W6', `worldMetrics.${view} is missing`); return; }
  if (stats.pending !== 0) fail('W6', `${view}: ${stats.pending} map jobs still pending after the wait`);
  if (stats.pngPlanetTextures !== 0) fail('W6', `${view}: ${stats.pngPlanetTextures} planet PNG textures loaded`);
  if (!(stats.workers >= 1)) fail('W6', `${view}: no live world worker in the app (fell back to the main thread)`);
  const size = SIZES[stats.tier] || SIZES.high;
  if (stats.tier !== tier) notes.push(`${view} rendered at tier ${stats.tier}`);
  if (view === 'system') {
    if (!Array.isArray(stats.planets) || !stats.planets.length) fail('W6', 'system: worldStats lists no planets');
    for (const p of stats.planets || []) {
      if (p.cls !== p.expectedCls) fail('W6', `system: ${p.name} is ${p.cls}, worldProfile says ${p.expectedCls}`);
      if (p.mapWidth !== size.system) fail('W6', `system: ${p.name} map is ${p.mapWidth} wide (want ${size.system})`);
      if (!['worker', 'cache'].includes(p.source)) fail('W6', `system: ${p.name} map came from ${p.source}`);
    }
    if (!stats.sun || stats.sun.plugin !== true || stats.sun.darkInGlow !== true) fail('W6', 'system: sun plugin missing, or the sun is not dark in the glow pass');
  } else {
    const d = stats.detail || {};
    if (d.mapWidth !== size.detail) fail('W6', `planet: detail map is ${d.mapWidth} wide (want ${size.detail})`);
    if (!(d.swapMs <= 6000)) fail('W6', `planet: detail swap took ${d.swapMs} ms (max 6000)`);
    if (d.heldReady !== true) fail('W6', 'planet: readiness was not held until the detail map landed');
    if (!['worker', 'cache'].includes(d.source)) fail('W6', `planet: detail map came from ${d.source}`);
  }
}
async function checkApp() {
  const outDir = path.join(root, '.shots', 'worlds');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const profile = createSyntheticProfile({ prefix: 'agent-orrery-worlds-' });
  try {
    const env = { ...profile.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    const pending = run(electronBin, ['.', '--polish-test', `--polish-output=${outDir}`], env, 120_000);
    profile.streamActivity(12_000).catch(() => {});
    const { code, output } = await pending;
    const errors = output.split(/\r?\n/).filter((line) => ERROR_RE.test(line));
    if (errors.length) fail('W6', `renderer error output: ${errors.slice(0, 5).join(' | ')}`);
    const resultPath = path.join(outDir, 'result.json');
    if (!fs.existsSync(resultPath)) { fail('W6', `polish harness wrote no result.json (exit ${code})`); return; }
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (!result.passed) fail('W6', `polish harness failed: ${String(result.error || code).split('\n')[0]}`);
    const m = result.worldMetrics || {};
    checkStats(m.system, 'system', 'high');
    checkStats(m.planet, 'planet', 'high');
    if (m.system && m.system.sun) checkSun(m.sunCore, m.system.sun.color);
    notes.push(`app: ${result.projectId} / ${result.planetName}, detail swap ${m.planet && m.planet.detail ? m.planet.detail.swapMs : '?'} ms, sun core ${JSON.stringify(m.sunCore)}; shots in .shots/worlds`);
  } finally {
    profile.dispose();
  }
}

checkVersions();
await killSwitch();
if (!KILLSWITCH_ONLY) {
  checkLayout();
  checkGenerator();
  checkSources();
  if (failures.length === 0) await checkApp();
  else notes.push('app run skipped until the static and Node checks pass');
}
for (const note of notes) console.log(`note: ${note}`);
if (failures.length) {
  console.log(`FAIL (${failures.length})`);
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(1);
}
console.log(KILLSWITCH_ONLY ? 'PASS (kill-switch)' : 'PASS');
