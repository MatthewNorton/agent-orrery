#!/usr/bin/env node
// Capture README screenshots from a fully synthetic universe.
//
// Builds a throwaway home directory containing fictional Claude Code and Codex
// transcripts (fake project names, fake files, fake sessions; see
// scripts/lib/synthetic-profile.mjs), points the app at it by overriding
// HOME/USERPROFILE/APPDATA exactly like the kit gates do, runs the app's own `--shots`
// mode, and copies the three captures into docs/screenshots/. Nothing under the real
// ~/.claude, ~/.codex or the real app state is read.
//
// Usage: node scripts/demo-shots.mjs            capture docs/screenshots/*.png
//        node scripts/demo-shots.mjs --keep     also keep the profile and print how
//                                               to run the live app against it
//                                               (for recording a video or GIF)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSyntheticProfile } from './lib/synthetic-profile.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const OUT = path.join(ROOT, 'docs', 'screenshots');

function runShots(profile) {
  const electron = require('electron');
  return new Promise((resolve, reject) => {
    const child = spawn(electron, ['.', '--shots'], { cwd: ROOT, env: profile.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('shots mode did not finish in 120 s')); }, 120_000);
    profile.streamActivity(12_000).catch(reject);
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`electron exited ${code}\n${out}`)); });
    child.on('error', reject);
  });
}

const profile = createSyntheticProfile({ prefix: 'agent-universe-demo-' });
console.log(`demo profile: ${profile.root}`);
try {
  await runShots(profile);
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
    console.log(`  $env:HOME='${profile.root}'; $env:USERPROFILE='${profile.root}'; $env:APPDATA='${profile.env.APPDATA}'; $env:LOCALAPPDATA='${profile.env.LOCALAPPDATA}'; npm start`);
    console.log('Record with Win+Alt+R (Game Bar) or OBS, then delete the folder.');
  } else {
    profile.dispose();
  }
}
