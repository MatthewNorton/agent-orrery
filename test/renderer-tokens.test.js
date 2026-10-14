'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylesDir = path.join(__dirname, '..', 'src', 'renderer', 'styles');
const read = (name) => fs.readFileSync(path.join(stylesDir, name), 'utf8');

// The restyled stylesheets take every colour from tokens.css, so a new colour scheme is a change to
// design/tricolor/tokens.json and a regenerate, never a hunt through component CSS.
const TOKEN_ONLY = ['modules.css', 'topbar.css', 'hud.css', 'rail.css', 'cards.css', 'history.css'];
const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-mix\(/i;

test('restyled stylesheets contain no colour literals', () => {
  for (const name of TOKEN_ONLY) {
    const offenders = read(name).split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => LITERAL.test(line.replace(/\/\*.*?\*\//g, '')));
    assert.deepEqual(offenders, [], `${name} has colour literals`);
  }
});

test('restyled stylesheets set no type under 12px', () => {
  const sizes = /font(?:-size)?:\s*(?:\d+\s+)?(\d+(?:\.\d+)?)px/g;
  for (const name of TOKEN_ONLY) {
    const small = [];
    for (const m of read(name).matchAll(sizes)) if (Number(m[1]) < 12) small.push(m[0]);
    assert.deepEqual(small, [], `${name} sets type under 12px`);
  }
});

test('tokens.css is generated from tokens.json', () => {
  const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'design', 'tricolor', 'tokens.json'), 'utf8'));
  const css = read('tokens.css');
  for (const token of tokens.color.tokens) assert.match(css, new RegExp(`--${token.name}:`), token.name);
  assert.match(css, /@font-face \{ font-family: "Archivo"/);
});
