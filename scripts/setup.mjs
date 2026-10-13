// Sets up Agent Orrery in one step; the double-click files in the repository root run this.
//   node scripts/setup.mjs [--no-launch] [-- <Windows shortcut script arguments>]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './lib/setup.mjs';

// Not import.meta.dirname: it needs Node 20.11, and an older Node must still reach the version message.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  // npm is a .cmd shim on Windows, which only starts through a shell. The arguments are fixed strings.
  const result = command === 'npm'
    ? spawnSync([command, ...args].join(' '), { cwd: root, stdio: 'inherit', shell: true })
    : spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}).`);
}

function launch(electron, cwd) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(electron, ['.'], { cwd, env, detached: true, stdio: 'ignore' }).unref();
}

try {
  setup({
    root, platform: process.platform, nodeVersion: process.versions.node, argv: process.argv.slice(2),
    exists: fs.existsSync, run, launch, log: (line) => console.log(line),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
