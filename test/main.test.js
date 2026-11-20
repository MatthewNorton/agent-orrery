'use strict';

// src/main/main.js, the main process's entry: what it does before anything else is loaded, as
// each file under scripts/ that Electron is started with does. kit/grade.mjs checks the flag in
// the running app (M7), as the shots run reports it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main');
// A source's statements' lines: no comment lines, no blank ones.
const codeLines = (source) => source.split('\n').map((line) => line.trim()).filter((line) => line && !/^(\/\/|\/?\*)/.test(line));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Asar handling is off before any module is loaded (SECURITY.md): a module loaded before the
// flag could already have read a user's folder with it on.
function assertNoAsarFirst(file) {
  const lines = codeLines(read(file));
  assert.deepEqual(lines.slice(0, 2), ["'use strict';", 'process.noAsar = true;'], `${file}: the first statement`);
  const firstLoad = lines.findIndex((line) => /\b(require|import)\b/.test(line));
  assert.ok(firstLoad > 1, `${file}: and the first require comes after it`);
}

test('main: asar handling is turned off before any module is loaded, and nothing turns it back on', () => {
  assert.equal(require('../package.json').main, 'src/main/main.js', 'main.js is the entry Electron runs');
  assertNoAsarFirst('src/main/main.js');

  const files = fs.readdirSync(MAIN, { recursive: true }).map(String).filter((file) => file.endsWith('.js'));
  assert.ok(files.length > 50, 'src/main was read');
  const named = files.flatMap((file) => codeLines(fs.readFileSync(path.join(MAIN, file), 'utf8'))
    .filter((line) => /noAsar\s*=(?!=)|original-fs/.test(line)).map((line) => `${file.replaceAll('\\', '/')}: ${line}`));
  assert.deepEqual(named, ['main.js: process.noAsar = true;'], 'set once, and no module reads around it');
});

test('main: every file under src/main and scripts that Electron starts turns asar handling off first', () => {
  const pkg = require('../package.json');
  // The files package.json starts Electron with ('electron .' runs main)...
  const declared = new Set([pkg.main]);
  for (const script of Object.values(pkg.scripts)) {
    for (const [, file] of script.matchAll(/(?:^|\s)electron\s+(\S+)/g)) declared.add(file === '.' ? pkg.main : file);
  }
  // ...and any file that waits for the app to be ready, which only a file Electron starts does.
  const entries = ['src/main', 'scripts'].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).map(String)
    .filter((file) => /\.[cm]?js$/.test(file)).map((file) => `${dir}/${file.replaceAll('\\', '/')}`))
    .filter((file) => codeLines(read(file)).some((line) => /\bapp\.(whenReady\(|on\(\s*['"]ready['"])/.test(line)));
  for (const file of declared) assert.ok(entries.includes(file), `${file} is found as an entry: ${entries.join(', ')}`);
  assert.ok(entries.length > declared.size, `a file run with npx electron is found too: ${entries.join(', ')}`);
  for (const file of entries) assertNoAsarFirst(file);
});
