'use strict';

// The renderer page's script tags, read the same way by the tests and the structure gate.

// A comment ends at `-->` or `--!>`; `<!-->` and `<!--->` are whole comments; an unclosed one runs
// to the end of the page.
function withoutComments(html) {
  let page = '';
  let at = 0;
  for (;;) {
    const open = html.indexOf('<!--', at);
    if (open < 0) return page + html.slice(at);
    page += html.slice(at, open);
    const close = /^-?>|--!?>/.exec(html.slice(open + 4));
    if (!close) return page;
    at = open + 4 + close.index + close[0].length;
  }
}

/**
 * The `src` of every script tag in a page, in load order. Throws on a tag in any other form than
 * `<script src="...">` (deferred, typed, inline, upper case): it would not load in document order.
 * @param {string} html
 */
function scriptTags(html) {
  return (withoutComments(html).match(/<script\b[^>]*>/gi) ?? []).map((tag) => {
    const plain = /^<script src="([^"]+)">$/.exec(tag);
    if (!plain) throw new Error('index.html has a script tag that is not a plain <script src="...">: ' + tag);
    return plain[1];
  });
}

module.exports = { scriptTags };
