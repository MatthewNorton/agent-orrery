#!/usr/bin/env node
// Re-pin the SHA-256 digests of frozen files in the two hash-pinning gates.
// Digests are LF-normalized: read as UTF-8, replace CRLF with LF, hash.
//
// Usage: node kit/repin.mjs --check                  report stale pins, exit 1 if any
//        node kit/repin.mjs --note "<why>"           rewrite stale pins in place
//        [--root <dir>]                              repository root (default: this repo)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const GATES = ['kit/done/agent-control/grade-control.mjs', 'kit/done/history-playback/grade-history.mjs'];
const PIN = /\[\s*'([^']+)'\s*,\s*'([0-9a-f]{64})'\s*\]/g;
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const CHECK = args.includes('--check');
const NOTE = opt('--note');
const ROOT = path.resolve(opt('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

if (!CHECK && (typeof NOTE !== 'string' || !NOTE.trim() || NOTE.startsWith('--'))) {
  console.error('refusing to rewrite pins without --note "<text>" (or use --check)');
  process.exit(2);
}

function digest(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

let staleCount = 0;
for (const gate of GATES) {
  const file = path.join(ROOT, gate);
  const source = fs.readFileSync(file, 'utf8');
  const stale = [];
  const updated = source.replace(PIN, (whole, rel, hex) => {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      console.error(`MISSING ${gate} ${rel}`);
      process.exit(1);
    }
    const actual = digest(rel);
    if (actual === hex) return whole;
    stale.push(rel);
    return whole.replace(hex, actual);
  });
  if (!stale.length) continue;
  staleCount += stale.length;
  if (CHECK) {
    for (const rel of stale) console.log(`STALE ${gate} ${rel}`);
    continue;
  }
  const anchor = updated.match(/^([ \t]*)const frozen = new Map\(\[(\r?\n)/m);
  if (!anchor) {
    console.error(`${gate}: no "const frozen = new Map([" line to annotate`);
    process.exit(1);
  }
  const comment = `${anchor[1]}// ${today()} re-pinned: ${stale.join(', ')} — ${NOTE.trim()}${anchor[2]}`;
  fs.writeFileSync(file, updated.slice(0, anchor.index) + comment + updated.slice(anchor.index));
  console.log(`re-pinned ${gate}: ${stale.join(', ')}`);
}

if (CHECK && staleCount) process.exit(1);
if (!staleCount) console.log('all pins current');
