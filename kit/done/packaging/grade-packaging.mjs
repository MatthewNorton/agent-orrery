// Item 03 Windows shortcut grader. Run from anywhere:
//   node kit/done/packaging/grade-packaging.mjs
// Exit 0 = PASS, 1 = FAIL.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const scriptPath = path.join(root, 'scripts', 'windows-shortcuts.ps1');
const docsPath = path.join(root, 'docs', 'WINDOWS-LAUNCH.md');
const assetRequestsPath = path.join(root, 'kit', 'ASSET-REQUESTS.md');
const outputRoot = path.join(root, '.shots', 'packaging');
fs.mkdirSync(outputRoot, { recursive: true });
const outDir = fs.mkdtempSync(path.join(outputRoot, 'run-'));

const failures = [];
const notes = [];
const result = {
  schemaVersion: 1,
  passed: false,
  platform: process.platform,
  outputDirectory: outDir,
};

function fail(id, message) { failures.push(`${id}: ${message}`); }
function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function normWin(value) {
  return path.win32.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}
function samePath(a, b) { return normWin(a) === normWin(b); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function listExtension(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(extension));
}

function treeEntries(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name);
    const relative = path.relative(base, absolute).replaceAll('\\', '/');
    entries.push(`${item.isDirectory() ? 'D' : 'F'}:${relative}`);
    if (item.isDirectory()) entries.push(...treeEntries(absolute, base));
  }
  return entries.sort();
}

function assertTree(id, label, directory, expected) {
  const actual = treeEntries(directory);
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(id, `${label} tree ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);
  }
}

function runPowerShellFile(file, args, cwd = root) {
  return spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', file, ...args,
  ], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function installerArgs(action, repositoryRoot, desktop, programs, support) {
  return [
    ...(action == null ? [] : ['-Action', action]),
    '-RepositoryRoot', repositoryRoot,
    '-DesktopDirectory', desktop,
    '-ProgramsDirectory', programs,
    '-SupportDirectory', support,
  ];
}

function commandFailure(run) {
  if (run.error) return run.error.message;
  return `exit ${run.status}: ${(run.stderr || run.stdout || '').trim()}`;
}

function parseSingleJson(stdout, label) {
  const line = String(stdout || '').split(/\r?\n/).map((s) => s.trim())
    .filter(Boolean).findLast((s) => s.startsWith('{'));
  if (!line) throw new Error(`${label} emitted no JSON: ${String(stdout || '').trim()}`);
  return JSON.parse(line);
}

function inspectShortcuts(inspectorPath, desktopLink, startLink, iconPath) {
  const run = runPowerShellFile(inspectorPath, [
    '-DesktopLink', desktopLink,
    '-StartLink', startLink,
    '-IconPath', iconPath,
  ], path.dirname(inspectorPath));
  if (run.status !== 0) throw new Error(`shortcut inspection failed: ${commandFailure(run)}`);
  return parseSingleJson(run.stdout, 'shortcut inspector');
}

function assertShortcutSet(id, inspected, expectedRoot, expectedElectron, expectedIcon) {
  if (!inspected || !Array.isArray(inspected.links) || inspected.links.length !== 2) {
    fail(id, `expected two inspected links, got ${JSON.stringify(inspected)}`);
    return;
  }
  for (const link of inspected.links) {
    if (!samePath(link.targetPath, expectedElectron)) {
      fail(id, `${link.path} target ${link.targetPath} != ${expectedElectron}`);
    }
    if (link.arguments !== '.') fail(id, `${link.path} arguments are ${JSON.stringify(link.arguments)}`);
    if (!samePath(link.workingDirectory, expectedRoot)) {
      fail(id, `${link.path} working directory ${link.workingDirectory} != ${expectedRoot}`);
    }
    if (link.description !== 'Launch Agent Universe Lite') {
      fail(id, `${link.path} description is ${JSON.stringify(link.description)}`);
    }
    if (Number(link.windowStyle) !== 1) fail(id, `${link.path} window style is ${link.windowStyle}`);
    const expectedLocation = `${expectedIcon},0`;
    if (normWin(link.iconLocation) !== normWin(expectedLocation)) {
      fail(id, `${link.path} icon ${link.iconLocation} != ${expectedLocation}`);
    }
    if (/\.cmd(?:,|$)|cmd\.exe|powershell|pwsh|node\.exe/i.test(link.targetPath)) {
      fail('W1', `${link.path} targets a console or script wrapper`);
    }
  }
}

function readPeSubsystem(executable) {
  const bytes = fs.readFileSync(executable);
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('missing MZ header');
  const peOffset = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('missing PE header');
  return bytes.readUInt16LE(peOffset + 24 + 68);
}

function validateIco(iconPath) {
  const bytes = fs.readFileSync(iconPath);
  if (bytes.length < 22) throw new Error('ICO is too small');
  const reserved = bytes.readUInt16LE(0);
  const type = bytes.readUInt16LE(2);
  const count = bytes.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) throw new Error(`invalid ICO header ${reserved}/${type}`);
  if (count !== 7) throw new Error(`expected 7 ICO frames, got ${count}`);

  const frames = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const width = bytes[entry] || 256;
    const height = bytes[entry + 1] || 256;
    const planes = bytes.readUInt16LE(entry + 4);
    const bits = bytes.readUInt16LE(entry + 6);
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (planes !== 1 || bits !== 32 || offset + size > bytes.length) {
      throw new Error(`invalid ICO entry ${i}`);
    }
    const pngSignature = bytes.subarray(offset, offset + 8).toString('hex');
    if (pngSignature !== '89504e470d0a1a0a') throw new Error(`frame ${i} is not PNG-backed`);
    const pngWidth = bytes.readUInt32BE(offset + 16);
    const pngHeight = bytes.readUInt32BE(offset + 20);
    const bitDepth = bytes[offset + 24];
    const colorType = bytes[offset + 25];
    if (pngWidth !== width || pngHeight !== height || bitDepth !== 8 || colorType !== 6) {
      throw new Error(`frame ${i} has invalid PNG dimensions or RGBA encoding`);
    }
    frames.push({ width, height, bits, pngBitDepth: bitDepth, pngColorType: colorType, size, offset });
  }
  const expected = [16, 24, 32, 48, 64, 128, 256];
  if (JSON.stringify(frames.map((frame) => frame.width)) !== JSON.stringify(expected) ||
      frames.some((frame) => frame.width !== frame.height)) {
    throw new Error(`unexpected ICO dimensions ${frames.map((frame) => frame.width).join(',')}`);
  }

  const preview = frames.at(-1);
  fs.writeFileSync(path.join(outDir, 'icon-preview.png'), bytes.subarray(preview.offset, preview.offset + preview.size));
  fs.copyFileSync(iconPath, path.join(outDir, 'agent-universe-lite.ico'));
  return { bytes: bytes.length, sha256: sha256(bytes), frames };
}

const source = read(scriptPath);
const docs = read(docsPath);
const assetRequests = read(assetRequestsPath);

if (process.platform !== 'win32') fail('W0', 'item 03 gate requires Windows');
if (!source) fail('W0', 'missing scripts/windows-shortcuts.ps1');
if (!docs) fail('W4', 'missing docs/WINDOWS-LAUNCH.md');
const assetHeader = assetRequests.search(/^## agent-universe-windows-icon\s*$/im);
const nextAssetHeader = assetHeader < 0 ? -1 : assetRequests.indexOf('\n## ', assetHeader + 4);
const assetSection = assetHeader < 0 ? '' : assetRequests.slice(
  assetHeader,
  nextAssetHeader < 0 ? assetRequests.length : nextAssetHeader
);
if (!/- Purpose:\s*\S/i.test(assetSection) || !/- Suggested spec:\s*\S/i.test(assetSection) ||
    !/- Plugs in at:\s*\S/i.test(assetSection)) {
  fail('W3', 'missing formatted agent-universe-windows-icon asset request');
}

const docsRequirements = [
  [/windows-shortcuts\.ps1[\s\S]*-Action Install/i, 'Install command'],
  [/windows-shortcuts\.ps1[\s\S]*-Action Uninstall/i, 'Uninstall command'],
  [/Desktop/i, 'Desktop destination'],
  [/Start[- ]menu/i, 'Start-menu destination'],
  [/without a terminal|no terminal/i, 'terminal-free behavior'],
  [/Re-running Install is safe|idempotent/i, 'idempotence'],
  [/moving this checkout|moving the repo|repository moves/i, 'repository-move recovery'],
  [/launch-on-login|startup/i, 'startup exclusion'],
  [/tray/i, 'tray exclusion'],
  [/NSIS|portable bundle|installer/i, 'installer exclusion'],
];
for (const [pattern, label] of docsRequirements) {
  if (!pattern.test(docs)) fail('W4', `Windows launch docs omit ${label}`);
}

if (source) {
  const forbidden = [
    [/Invoke-Expression/i, 'Invoke-Expression'],
    [/Remove-Item[^\r\n]*-(?:Recurse|r\b)/i, 'recursive deletion'],
    [/-Verb\s+RunAs/i, 'self-elevation'],
    [/HKLM:|HKCU:|HKEY_|New-ItemProperty|Set-ItemProperty|\breg(?:\.exe)?\s+(?:add|delete)\b/i, 'registry mutation'],
    [/CommonDesktop|CommonPrograms|CommonStartMenu|PublicDesktop|shell:startup|SpecialFolder\]::Startup/i, 'machine-wide/startup folders'],
    [/Register-ScheduledTask|\bschtasks(?:\.exe)?\b/i, 'scheduled task'],
    [/NotifyIcon|System\.Windows\.Forms/i, 'tray machinery'],
    [/electron-builder|\bNSIS\b/i, 'installer machinery'],
    [/\$env:(?:USERPROFILE|HOME)[^\r\n]*Desktop/i, 'profile-path guessing'],
    [/cmd\.exe|powershell\.exe|pwsh\.exe/i, 'command wrapper target'],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) fail('W4', `shortcut script contains forbidden ${label}`);
  }
  if (!/WScript\.Shell/.test(source)) fail('W1', 'shortcut script does not use WScript.Shell');
  if (!/electron\.exe/i.test(source) || /electron\.cmd/i.test(source)) {
    fail('W1', 'shortcut script does not exclusively target direct electron.exe');
  }
  if (!/ValidateSet\(['"]Install['"],\s*['"]Uninstall['"]\)/i.test(source)) {
    fail('W2', 'shortcut script does not expose Install/Uninstall actions');
  }
  if (!/\$Action\s*=\s*['"]Install['"]/i.test(source)) fail('W2', 'Install is not the default action');
  for (const [pattern, label] of [
    [/SpecialFolder\]::DesktopDirectory/i, 'DesktopDirectory known folder'],
    [/SpecialFolder\]::Programs/i, 'Programs known folder'],
    [/SpecialFolder\]::LocalApplicationData/i, 'LocalApplicationData known folder'],
  ]) {
    if (!pattern.test(source)) fail('W2', `shortcut script omits ${label}`);
  }
}

const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
if (status.status !== 0) {
  fail('W0', `could not inspect editable scope: ${commandFailure(status)}`);
} else {
  const exactAllowed = new Set([
    'scripts/windows-shortcuts.ps1',
    'docs/WINDOWS-LAUNCH.md',
    'kit/ASSET-REQUESTS.md',
    'kit/README.md',
    'kit/todo/README.md',
    'kit/EXECUTOR-HANDOFF.md',
    'kit/todo/03-packaging.md',
    'kit/BLOCKED.md',
  ]);
  const unexpected = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3))
    .filter((file) => !exactAllowed.has(file) &&
      !file.startsWith('kit/todo/03-packaging/') &&
      !file.startsWith('kit/done/packaging/'));
  if (unexpected.length) fail('W0', `files outside item-03 scope changed: ${unexpected.join(', ')}`);
}

const frozen = spawnSync('git', [
  'status', '--porcelain', '--', 'package.json', 'package-lock.json', 'src', 'assets',
  '1.planet-view.png', '2.solar-system-view.png', '3.universe-map-view.png',
], { cwd: root, encoding: 'utf8', windowsHide: true });
if (frozen.status !== 0) fail('W0', `could not inspect frozen scope: ${commandFailure(frozen)}`);
else if (frozen.stdout.trim()) fail('W0', `frozen files changed: ${frozen.stdout.trim().replace(/\r?\n/g, ' | ')}`);

const packageJson = JSON.parse(read(path.join(root, 'package.json')) || '{}');
const dependencyNames = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.devDependencies || {}),
];
if (dependencyNames.some((name) => /electron-builder|electron-packager|forge|nsis/i.test(name)) ||
    packageJson.build || packageJson.packagerConfig) {
  fail('W4', 'package metadata contains packaging machinery');
}

let tempRoot = null;
if (failures.length === 0) {
  try {
    const actualElectron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(actualElectron)) throw new Error(`missing ${actualElectron}; run npm install`);
    const subsystem = readPeSubsystem(actualElectron);
    result.electron = { path: actualElectron, peSubsystem: subsystem };
    if (subsystem !== 2) fail('W1', `electron.exe PE subsystem is ${subsystem}, expected GUI subsystem 2`);

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aur-packaging-'));
    const desktop = path.join(tempRoot, 'Desktop With Spaces & Orbit');
    const programs = path.join(tempRoot, 'Start Menu (Programs)');
    const startApp = path.join(programs, 'Agent Universe Lite');
    const support = path.join(tempRoot, 'Local App Data', 'Agent Universe Lite');
    fs.mkdirSync(desktop, { recursive: true });
    fs.mkdirSync(programs, { recursive: true });
    if (fs.existsSync(startApp) || fs.existsSync(support)) {
      throw new Error('fresh-install fixture unexpectedly contains app-owned directories');
    }

    const fakeRoot = path.join(tempRoot, "Repo With Spaces & (Orbit) O'Brien");
    const fakeDist = path.join(fakeRoot, 'node_modules', 'electron', 'dist');
    fs.mkdirSync(fakeDist, { recursive: true });
    const fakeElectron = path.join(fakeDist, 'electron.exe');
    try { fs.linkSync(actualElectron, fakeElectron); }
    catch { fs.copyFileSync(actualElectron, fakeElectron); }
    fs.writeFileSync(path.join(fakeRoot, 'package.json'), JSON.stringify({
      name: 'agent-universe-lite', main: 'src/main/main.js',
    }, null, 2));
    const fakeMain = path.join(fakeRoot, 'src', 'main', 'main.js');
    fs.mkdirSync(path.dirname(fakeMain), { recursive: true });
    fs.writeFileSync(fakeMain, '// packaging fixture entry point\n');

    const inspectorPath = path.join(tempRoot, 'inspect-shortcuts.ps1');
    fs.writeFileSync(inspectorPath, String.raw`param(
  [Parameter(Mandatory = $true)][string]$DesktopLink,
  [Parameter(Mandatory = $true)][string]$StartLink,
  [Parameter(Mandatory = $true)][string]$IconPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$shell = New-Object -ComObject WScript.Shell
try {
  $links = foreach ($item in @($DesktopLink, $StartLink)) {
    $shortcut = $shell.CreateShortcut($item)
    try {
      [pscustomobject]@{
        path = $item
        targetPath = $shortcut.TargetPath
        arguments = $shortcut.Arguments
        workingDirectory = $shortcut.WorkingDirectory
        description = $shortcut.Description
        iconLocation = $shortcut.IconLocation
        windowStyle = $shortcut.WindowStyle
      }
    } finally {
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }
  }
  $icon = [System.Drawing.Icon]::new($IconPath)
  try {
    [pscustomobject]@{
      links = @($links)
      loadedIcon = @{ width = $icon.Width; height = $icon.Height }
    } | ConvertTo-Json -Depth 5 -Compress
  } finally {
    $icon.Dispose()
  }
} finally {
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
`);

    const desktopLink = path.join(desktop, 'Agent Universe Lite.lnk');
    const startLink = path.join(startApp, 'Agent Universe Lite.lnk');
    const iconPath = path.join(support, 'agent-universe-lite.ico');

    const first = runPowerShellFile(scriptPath,
      installerArgs(null, fakeRoot, desktop, programs, support), tempRoot);
    if (first.status !== 0) throw new Error(`first isolated install failed: ${commandFailure(first)}`);
    if (!fs.existsSync(desktopLink) || !fs.existsSync(startLink) || !fs.existsSync(iconPath)) {
      fail('W1', 'isolated install did not create both links and the icon');
    }
    if (listExtension(desktop, '.lnk').length !== 1 || listExtension(startApp, '.lnk').length !== 1 ||
        listExtension(support, '.ico').length !== 1) {
      fail('W1', 'isolated install created duplicate or unexpected shortcut/icon artifacts');
    }
    assertTree('W1', 'fresh Desktop', desktop, ['F:Agent Universe Lite.lnk']);
    assertTree('W1', 'fresh Programs', programs, [
      'D:Agent Universe Lite', 'F:Agent Universe Lite/Agent Universe Lite.lnk',
    ]);
    assertTree('W1', 'fresh support', support, ['F:agent-universe-lite.ico']);
    const initial = inspectShortcuts(inspectorPath, desktopLink, startLink, iconPath);
    assertShortcutSet('W1', initial, fakeRoot, fakeElectron, iconPath);
    const ico = validateIco(iconPath);
    if (!initial.loadedIcon || initial.loadedIcon.width < 16 || initial.loadedIcon.height < 16) {
      fail('W3', `System.Drawing did not load the generated icon: ${JSON.stringify(initial.loadedIcon)}`);
    }

    const desktopSentinels = [
      path.join(desktop, 'unrelated-desktop.txt'),
      path.join(desktop, 'unrelated-desktop.lnk'),
    ];
    const startSentinels = [
      path.join(startApp, 'unrelated-start.txt'),
      path.join(startApp, 'unrelated-start.lnk'),
    ];
    const supportSentinels = [
      path.join(support, 'unrelated-support.txt'),
      path.join(support, 'unrelated-support.ico'),
    ];
    for (const sentinel of [...desktopSentinels, ...startSentinels, ...supportSentinels]) {
      fs.writeFileSync(sentinel, 'keep');
    }

    const second = runPowerShellFile(scriptPath,
      installerArgs('Install', fakeRoot, desktop, programs, support), tempRoot);
    if (second.status !== 0) throw new Error(`idempotent install failed: ${commandFailure(second)}`);
    const idempotent = inspectShortcuts(inspectorPath, desktopLink, startLink, iconPath);
    assertShortcutSet('W2', idempotent, fakeRoot, fakeElectron, iconPath);
    if (listExtension(desktop, '.lnk').length !== 2 || listExtension(startApp, '.lnk').length !== 2 ||
        listExtension(support, '.ico').length !== 2) {
      fail('W2', 'second install produced duplicates');
    }
    const secondHash = sha256(fs.readFileSync(iconPath));
    if (secondHash !== ico.sha256) fail('W3', 'procedural ICO bytes changed across identical installs');
    assertTree('W2', 'idempotent Desktop', desktop, [
      'F:Agent Universe Lite.lnk', 'F:unrelated-desktop.lnk', 'F:unrelated-desktop.txt',
    ]);
    assertTree('W2', 'idempotent Programs', programs, [
      'D:Agent Universe Lite', 'F:Agent Universe Lite/Agent Universe Lite.lnk',
      'F:Agent Universe Lite/unrelated-start.lnk', 'F:Agent Universe Lite/unrelated-start.txt',
    ]);
    assertTree('W2', 'idempotent support', support, [
      'F:agent-universe-lite.ico', 'F:unrelated-support.ico', 'F:unrelated-support.txt',
    ]);

    const reboundRun = runPowerShellFile(scriptPath,
      installerArgs('Install', root, desktop, programs, support), tempRoot);
    if (reboundRun.status !== 0) throw new Error(`repository rebind failed: ${commandFailure(reboundRun)}`);
    const rebound = inspectShortcuts(inspectorPath, desktopLink, startLink, iconPath);
    assertShortcutSet('W2', rebound, root, actualElectron, iconPath);
    if (sha256(fs.readFileSync(iconPath)) !== ico.sha256) {
      fail('W3', 'procedural ICO bytes changed while rebinding the repository');
    }

    const uninstall = runPowerShellFile(scriptPath,
      installerArgs('Uninstall', path.join(tempRoot, 'repo-now-missing'), desktop, programs, support), tempRoot);
    if (uninstall.status !== 0) throw new Error(`uninstall failed: ${commandFailure(uninstall)}`);
    if (fs.existsSync(desktopLink) || fs.existsSync(startLink) || fs.existsSync(iconPath)) {
      fail('W2', 'uninstall left an owned link or icon');
    }
    const allSentinels = [...desktopSentinels, ...startSentinels, ...supportSentinels];
    if (!allSentinels.every((file) => fs.readFileSync(file, 'utf8') === 'keep')) {
      fail('W2', 'uninstall modified unrelated sentinel content');
    }
    assertTree('W2', 'uninstalled Desktop', desktop, [
      'F:unrelated-desktop.lnk', 'F:unrelated-desktop.txt',
    ]);
    assertTree('W2', 'uninstalled Programs', programs, [
      'D:Agent Universe Lite', 'F:Agent Universe Lite/unrelated-start.lnk',
      'F:Agent Universe Lite/unrelated-start.txt',
    ]);
    assertTree('W2', 'uninstalled support', support, [
      'F:unrelated-support.ico', 'F:unrelated-support.txt',
    ]);
    const repeatedUninstall = runPowerShellFile(scriptPath,
      installerArgs('Uninstall', path.join(tempRoot, 'still-missing'), desktop, programs, support), tempRoot);
    if (repeatedUninstall.status !== 0) fail('W2', `repeated uninstall failed: ${commandFailure(repeatedUninstall)}`);
    for (const sentinel of allSentinels) fs.rmSync(sentinel);
    const cleanEmpty = runPowerShellFile(scriptPath,
      installerArgs('Uninstall', path.join(tempRoot, 'still-missing'), desktop, programs, support), tempRoot);
    if (cleanEmpty.status !== 0) fail('W2', `empty-directory cleanup failed: ${commandFailure(cleanEmpty)}`);
    if (fs.existsSync(startApp) || fs.existsSync(support)) {
      fail('W2', 'uninstall did not remove empty app-owned directories');
    }
    if (!fs.existsSync(desktop) || !fs.existsSync(programs)) {
      fail('W2', 'uninstall removed a parent directory');
    }
    assertTree('W2', 'clean Desktop', desktop, []);
    assertTree('W2', 'clean Programs', programs, []);

    const missingRoot = path.join(tempRoot, 'Missing Electron Repo');
    fs.mkdirSync(missingRoot);
    fs.writeFileSync(path.join(missingRoot, 'package.json'), JSON.stringify({ name: 'agent-universe-lite' }));
    const failDesktop = path.join(tempRoot, 'Failure Desktop');
    const failPrograms = path.join(tempRoot, 'Failure Programs');
    const failSupport = path.join(tempRoot, 'Failure Support');
    const expectedFailure = runPowerShellFile(scriptPath,
      installerArgs('Install', missingRoot, failDesktop, failPrograms, failSupport), tempRoot);
    if (expectedFailure.status === 0) fail('W2', 'missing Electron preflight unexpectedly succeeded');
    const failureText = `${expectedFailure.stdout || ''}\n${expectedFailure.stderr || ''}`;
    if (!/Electron|npm install/i.test(failureText)) fail('W2', 'missing Electron failure is not actionable');
    if ([failDesktop, failPrograms, failSupport].some((dir) => fs.existsSync(dir))) {
      fail('W2', 'failed preflight wrote destination artifacts');
    }

    const wrongRoot = path.join(tempRoot, 'Wrong Package Repo');
    fs.mkdirSync(wrongRoot);
    fs.writeFileSync(path.join(wrongRoot, 'package.json'), JSON.stringify({ name: 'some-other-app' }));
    const wrongDesktop = path.join(tempRoot, 'Wrong Desktop');
    const wrongPrograms = path.join(tempRoot, 'Wrong Programs');
    const wrongSupport = path.join(tempRoot, 'Wrong Support');
    const wrongPackage = runPowerShellFile(scriptPath,
      installerArgs('Install', wrongRoot, wrongDesktop, wrongPrograms, wrongSupport), tempRoot);
    if (wrongPackage.status === 0) fail('W2', 'wrong package identity unexpectedly succeeded');
    if (!/Agent Universe Lite|agent-universe-lite/i.test(`${wrongPackage.stdout}\n${wrongPackage.stderr}`)) {
      fail('W2', 'wrong package identity failure is not actionable');
    }
    if ([wrongDesktop, wrongPrograms, wrongSupport].some((dir) => fs.existsSync(dir))) {
      fail('W2', 'wrong package preflight wrote destination artifacts');
    }

    const invalidDesktop = path.join(tempRoot, 'Desktop Is A File');
    fs.writeFileSync(invalidDesktop, 'keep');
    const invalidPrograms = path.join(tempRoot, 'Invalid Programs');
    const invalidSupport = path.join(tempRoot, 'Invalid Support');
    const invalidDestination = runPowerShellFile(scriptPath,
      installerArgs('Install', fakeRoot, invalidDesktop, invalidPrograms, invalidSupport), tempRoot);
    if (invalidDestination.status === 0) fail('W2', 'invalid destination unexpectedly succeeded');
    if (fs.readFileSync(invalidDesktop, 'utf8') !== 'keep' ||
        fs.existsSync(invalidPrograms) || fs.existsSync(invalidSupport)) {
      fail('W2', 'invalid destination failure was not atomic');
    }

    result.shortcuts = {
      names: [desktopLink, startLink].map((file) => path.basename(file)),
      initial: initial.links,
      rebound: rebound.links,
      count: 2,
      idempotent: true,
      rebindVerified: true,
    };
    result.icon = { ...ico, systemDrawing: initial.loadedIcon };
    result.lifecycle = {
      uninstallWithoutRepository: true,
      repeatedUninstall: true,
      sentinelsPreserved: true,
      emptyOwnedDirectoriesRemoved: true,
      missingElectronAtomicFailure: true,
      wrongPackageAtomicFailure: true,
      invalidDestinationAtomicFailure: true,
    };
    notes.push(`2 shortcuts, ${ico.frames.length} ICO frames, GUI subsystem ${subsystem}`);
  } catch (error) {
    fail('W0', error && error.stack ? error.stack : String(error));
  } finally {
    if (tempRoot) {
      const resolvedTemp = path.resolve(tempRoot);
      const requiredPrefix = path.resolve(os.tmpdir(), 'aur-packaging-');
      if (resolvedTemp.startsWith(requiredPrefix)) fs.rmSync(resolvedTemp, { recursive: true, force: true });
      else fail('W0', `refused to clean unexpected temp path ${resolvedTemp}`);
    }
  }
}

result.passed = failures.length === 0;
result.failures = failures;
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));

console.log('\n============= PACKAGING GRADE =============');
for (const note of notes) console.log(`INFO  ${note}`);
console.log(`INFO  artifacts ${outDir}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS  W0-W4 Windows shortcut checks green');
}
