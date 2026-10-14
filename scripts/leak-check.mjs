// Leak check: nothing tracked by git may carry a real home folder, a personal email address, a
// credential or a private key. Fixtures use invented users (see ALLOWED_USERS) and example
// addresses. test/leak-check.test.js runs this on every `npm test`, so CI blocks a leak before it
// reaches main.
//
//   node scripts/leak-check.mjs        exit 1 and list the findings, or exit 0 when clean

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_USERS = new Set([
  'alice', 'bob', 'sam', 'coder', 'user', 'users', 'u', 'x', 'real', 'container', 'fixture', 'runner', 'you', 'me',
]);
const ALLOWED_EMAIL = /@(users\.noreply\.github\.com|github\.com|example\.(com|org|net)|[a-z0-9.-]+\.invalid)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|glb|gltf|bin|woff2?|ttf|otf|mp4|webm|zip|pdf|psd|blend)$/i;
const SKIP = new Set(['package-lock.json']);
const MAX_BYTES = 4 * 1024 * 1024;

const RULES = [
  {
    id: 'home-path',
    re: /(?:[A-Za-z]:[\\/]{1,2}[Uu]sers[\\/]{1,2}|\/home\/|\/Users\/|[Cc]--[Uu]sers-)([A-Za-z0-9._-]+)/g,
    bad: (m) => !ALLOWED_USERS.has(m[1].toLowerCase()) && !/^[.~]|^[<$%{]/.test(m[1]),
  },
  {
    id: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    bad: (m) => !ALLOWED_EMAIL.test(m[0]),
  },
  {
    id: 'credential',
    re: /sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/|-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/g,
    bad: () => true,
  },
];

function trackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((f) => f && !SKIP.has(path.basename(f)) && !BINARY.test(f));
}

/** @param {string} text @param {string} file */
export function scanText(text, file = '') {
  const findings = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (!rule.bad(m)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ file, line, rule: rule.id, match: m[0].slice(0, 80) });
    }
  }
  return findings;
}

/** @param {string} root */
export function scanRepo(root) {
  const findings = [];
  for (const file of trackedFiles(root)) {
    let text;
    try {
      const full = path.join(root, file);
      if (fs.statSync(full).size > MAX_BYTES) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    findings.push(...scanText(text, file));
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const findings = scanRepo(root);
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.match}`);
  console.log(findings.length ? `FAIL  ${findings.length} finding(s)` : 'PASS  no leaks in tracked files');
  process.exit(findings.length ? 1 : 0);
}
