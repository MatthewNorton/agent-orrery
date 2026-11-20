'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scriptTags } = require('../scripts/lib/script-tags.js');

const NOT_PLAIN = /not a plain <script src/;

test('script tags are listed in load order', () => {
  assert.deepEqual(scriptTags('<body><script src="a.js"></script>\n<script src="b/c.js"></script></body>'), ['a.js', 'b/c.js']);
  assert.deepEqual(scriptTags('<body></body>'), []);
});

test('a commented-out tag is not listed, and a comment may mention a script tag', () => {
  const page = '<script src="a.js"></script><!-- <script src="old.js"></script> --><!-- one <script> per file --><script src="b.js"></script>';
  assert.deepEqual(scriptTags(page), ['a.js', 'b.js']);
  assert.deepEqual(scriptTags('<script src="a.js"></script><!-- <script src="cut.js"></script>'), ['a.js'], 'an unclosed comment runs to the end');
});

test('a comment ends where HTML ends it, so a tag after it is read', () => {
  for (const comment of ['<!-->', '<!--->', '<!---->', '<!-- a --!>', '<!-- a <!-- b -->']) {
    const page = comment + '<script src="a.js"></script><!-- note -->';
    assert.deepEqual(scriptTags(page), ['a.js'], comment);
    assert.throws(() => scriptTags(comment + '<script src="a.js" defer></script><!-- note -->'), NOT_PLAIN, comment);
  }
  assert.deepEqual(scriptTags('<!-- a <!--><script src="in.js"></script> --><script src="a.js"></script>'), ['in.js', 'a.js'],
    'inside a comment, the --> of <!--> closes it');
});

test('a tag in any other form is named, not dropped', () => {
  for (const tag of [
    '<script src="a.js" defer></script>',
    '<script type="module" src="a.js"></script>',
    '<script>run()</script>',
    '<script  src="a.js"></script>',
    "<script src='a.js'></script>",
    '<SCRIPT defer src="a.js"></SCRIPT>',
  ]) {
    const opening = tag.slice(0, tag.indexOf('>') + 1);
    assert.throws(() => scriptTags('<script src="first.js"></script>' + tag),
      (error) => NOT_PLAIN.test(error.message) && error.message.endsWith(': ' + opening), tag);
  }
});
