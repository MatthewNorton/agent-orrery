// One-step setup: installs dependencies when the Electron runtime is missing, adds this
// platform's launcher shortcut, then opens the app. Every side effect is injected so tests
// never touch npm, the Desktop or a real window.
import path from 'node:path';

export const MIN_NODE = [22, 12];

export function electronPath(root, platform) {
  const dist = path.join(root, 'node_modules', 'electron', 'dist');
  if (platform === 'win32') return path.join(dist, 'electron.exe');
  if (platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

export function nodeTooOld(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

function shortcutStep(root, platform, extra) {
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(root, 'scripts', 'windows-shortcuts.ps1'), '-Action', 'Install', ...extra]];
  }
  if (platform === 'darwin') return ['/bin/bash', [path.join(root, 'scripts', 'macos-shortcuts.sh'), 'install']];
  return null;
}

const NEXT_TIME = {
  win32: 'Next time, open it from the Agent Orrery shortcut on your Desktop or Start menu.',
  darwin: 'Next time, open Agent Orrery from ~/Applications, Launchpad or Spotlight.',
};

/**
 * @param {{ root: string, platform: string, nodeVersion: string, argv: string[],
 *   exists: (file: string) => boolean, run: (command: string, args: string[]) => void,
 *   launch: (electron: string, root: string) => void, log: (line: string) => void }} deps
 * `argv`: `--no-launch` skips opening the app; anything after `--` goes to the Windows
 * shortcut script (tests point it at temporary folders).
 */
export function setup({ root, platform, nodeVersion, argv, exists, run, launch, log }) {
  const split = argv.indexOf('--');
  const options = split < 0 ? argv : argv.slice(0, split);
  const extra = split < 0 ? [] : argv.slice(split + 1);
  if (nodeTooOld(nodeVersion)) {
    throw new Error(`Agent Orrery needs Node.js ${MIN_NODE.join('.')} or newer (this is ${nodeVersion}). Get it from https://nodejs.org`);
  }

  const electron = electronPath(root, platform);
  if (!exists(path.join(root, 'node_modules', 'electron', 'package.json'))) {
    log('Installing dependencies. The first time downloads a few hundred MB.');
    run('npm', ['ci']);
  }
  if (!exists(electron)) {
    log('Downloading the Electron runtime.');
    run('npm', ['exec', '--no', '--', 'install-electron']);
  }
  if (!exists(electron)) throw new Error(`The Electron runtime is still missing at ${electron}.`);

  const shortcut = shortcutStep(root, platform, extra);
  if (shortcut) run(...shortcut);
  if (!options.includes('--no-launch')) launch(electron, root);
  log(`Agent Orrery is set up. ${NEXT_TIME[platform] || 'Start it with npm start in this folder.'}`);
}
