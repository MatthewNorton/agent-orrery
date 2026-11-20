'use strict';

// src/main/main.js, the main process's entry: what it does before anything else is loaded.
// kit/grade.mjs checks the flag in the running app (M7), as the shots run reports it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'src', 'main');
// A source's statements' lines: no comment lines, no blank ones.
const codeLines = (source) => source.split('\n').map((line) => line.trim()).filter((line) => line && !/^(\/\/|\/?\*)/.test(line));

test('main: asar handling is turned off before any module is loaded, and nothing turns it back on', () => {
  assert.equal(require('../package.json').main, 'src/main/main.js', 'main.js is the entry Electron runs');
  const lines = codeLines(fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8'));
  // Electron's fs opens and parses a file named *.asar on stat and lstat; a module loaded before
  // the flag could already have read a user's folder that way.
  assert.deepEqual(lines.slice(0, 2), ["'use strict';", 'process.noAsar = true;'], 'the first statement of the entry');
  const firstLoad = lines.findIndex((line) => /\b(require|import)\b/.test(line));
  assert.ok(firstLoad > 1, 'and the first require comes after it');

  const files = fs.readdirSync(MAIN, { recursive: true }).map(String).filter((file) => file.endsWith('.js'));
  assert.ok(files.length > 50, 'src/main was read');
  const named = files.flatMap((file) => codeLines(fs.readFileSync(path.join(MAIN, file), 'utf8'))
    .filter((line) => /noAsar\s*=(?!=)|original-fs/.test(line)).map((line) => `${file.replaceAll('\\', '/')}: ${line}`));
  assert.deepEqual(named, ['main.js: process.noAsar = true;'], 'set once, and no module reads around it');
});
