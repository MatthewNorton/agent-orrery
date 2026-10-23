// Gate for kit 08, manifest-backed ship hulls (S0–S5).
// Usage: node kit/done/ship-assets-pack/grade-ships.mjs [--no-regression]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const failures = [];
const ok = (id, msg) => console.log(`${id} PASS  ${msg}`);
const bad = (id, msg) => { failures.push(`${id}: ${msg}`); console.log(`${id} FAIL  ${msg}`); };

// ---- S0: sourcing kill-switch ----
const inbox = path.join(ROOT, 'assets', 'staging', 'ships-inbox');
const manifestPath = path.join(ROOT, 'assets', 'ships', 'manifest.json');
const inboxReady = fs.existsSync(inbox) && fs.readdirSync(inbox).length > 0;
if (!inboxReady && !fs.existsSync(manifestPath)) {
  console.error('\n================ SHIPS GRADE ================');
  console.error('FAIL  S0: awaiting Phase 0 sourcing — drop CC0 packs into assets/staging/ships-inbox/');
  process.exit(1);
}
ok('S0', inboxReady ? 'sourcing inbox populated' : 'final assets already present');

// ---- S1: loaders dependency ----
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 2026-09-27: the contract's invariant is "exact pin, matches babylonjs"; 9.17.0 was
  // merely the core version at kit time. Check the invariant so dependency bumps that
  // keep loaders and core in lockstep (Dependabot #27) do not trip the gate.
  const v = (pkg.dependencies || {})['babylonjs-loaders'];
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'babylonjs', 'package.json'), 'utf8')).version;
  if (typeof v !== 'string' || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(v)) bad('S1', `babylonjs-loaders must be an exact pin, found ${JSON.stringify(v)}`);
  else if (v !== core) bad('S1', `babylonjs-loaders ${v} must equal installed babylonjs core ${core}`);
  else ok('S1a', `babylonjs-loaders pinned exactly ${v}, matching babylonjs core`);
} catch (e) { bad('S1', `package.json unreadable: ${e.message}`); }
const umd = path.join(ROOT, 'node_modules', 'babylonjs-loaders', 'babylonjs.loaders.min.js');
if (!fs.existsSync(umd)) bad('S1', 'babylonjs.loaders.min.js not installed in node_modules');
else ok('S1b', 'loaders UMD bundle installed');

// ---- S2: script tag order ----
try {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const iLoaders = html.indexOf('babylonjs.loaders.min.js');
  const iUtil = html.indexOf('util.js');
  const iShipAssets = html.indexOf('ship-assets.js');
  const iSceneU = html.indexOf('scene/universe/view.js');
  if (iLoaders === -1) bad('S2', 'loaders script tag missing from index.html');
  else if (!(iLoaders < iUtil)) bad('S2', 'loaders tag must come before util.js');
  else ok('S2a', 'loaders tag ordered before util.js');
  if (iShipAssets === -1) bad('S2', 'ship-assets.js script tag missing');
  else if (!(iShipAssets < iSceneU)) bad('S2', 'ship-assets.js must load before scene files');
  else ok('S2b', 'ship-assets.js ordered before scenes');
} catch (e) { bad('S2', `index.html unreadable: ${e.message}`); }

// ---- S3: manifest ----
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) { bad('S3', `manifest missing/unparseable: ${e.message}`); }
if (manifest) {
  if (manifest.schemaVersion !== 1) bad('S3', 'schemaVersion must be 1');
  const hulls = Array.isArray(manifest.hulls) ? manifest.hulls : [];
  // The manifest carries no model-free lists: signals are markers and drones fly the first rank (renderer rules).
  if (hulls.length < 6) bad('S3', `need >= 6 hulls (the shared six), found ${hulls.length}`);
  const familyIds = new Set(hulls.map((h) => h.family));
  let droneCount = 0;
  for (const h of hulls) {
    // 2026-10-10: fleet-v2 hulls add a far-LOD file under `lods`; every file a
    // hull references gets the same existence and size checks.
    const files = [h.file, ...Object.values(h.lods || {})];
    let missing = false;
    for (const file of files) {
      const f = path.join(ROOT, 'assets', 'ships', typeof file === 'string' ? file : '');
      if (typeof file !== 'string' || !file || !fs.existsSync(f)) {
        bad('S3', `hull ${h.id}: file missing (${file})`);
        missing = true;
        continue;
      }
      const size = fs.statSync(f).size;
      // Fleet v3 hero hulls carry their detail as geometry (the Flagship is 58k triangles), so the cap is 6 MB.
      if (size > 6 * 1024 * 1024) bad('S3', `hull ${h.id}: ${file} ${Math.round(size / 1024)}KB exceeds 6MB cap`);
    }
    if (missing) continue;
    if (h.license !== 'CC0') bad('S3', `hull ${h.id}: license must be "CC0", found ${JSON.stringify(h.license)}`);
    if (!h.source) bad('S3', `hull ${h.id}: source missing`);
    if (h.role === 'drone') droneCount++;
  }
  if (droneCount !== 0) bad('S3', `${droneCount} hull(s) carry role "drone"; the renderer flies drones on the first rank and would never select them`);
  const pf = manifest.providerFamilies || {};
  for (const p of ['claude', 'codex']) {
    if (!pf[p]) bad('S3', `providerFamilies.${p} unmapped`);
    else if (!familyIds.has(pf[p])) bad('S3', `providerFamilies.${p} -> "${pf[p]}" matches no hull family`);
  }
  if (pf.signal) bad('S3', 'Signal agents are markers, not hulls; providerFamilies must not map them');
  if (failures.length === 0) {
    ok('S3', `${hulls.length} hulls, ${familyIds.size} families, Signal markers, drones on the first rank, all CC0`);
  }
}

// ---- S4: offline rule ----
try {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'ship-assets.js'), 'utf8');
  const manifestText = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
  if (/https?:\/\//.test(src)) bad('S4', 'ship-assets.js contains an http(s) URL');
  else if (/https?:\/\//.test(manifestText)) bad('S4', 'manifest.json contains an http(s) URL');
  else ok('S4', 'ship-assets.js + manifest offline-clean');
} catch (e) { bad('S4', `ship-assets.js unreadable: ${e.message}`); }

// ---- S5: regression ----
if (process.argv.includes('--no-regression')) {
  console.log('S5 SKIPPED (--no-regression)');
} else if (failures.length === 0) {
  console.log('S5 ...   running node kit/grade.mjs (launches Electron, ~1-2 min)');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'grade.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) bad('S5', `kit/grade.mjs regression FAILED (exit ${r.status})`);
  else ok('S5', 'grade.mjs regression green');
} else {
  console.log('S5 SKIPPED (earlier failures)');
}

console.log('\n================ SHIPS GRADE ================');
if (failures.length === 0) {
  console.log('PASS  all mechanical checks green');
  console.log('Runner: also rerun the provider + polish gates under kit/done/, then eyeball hull silhouettes in .shots/shot-system.png.');
  process.exit(0);
}
for (const f of failures) console.log(`FAIL  ${f}`);
process.exit(1);
