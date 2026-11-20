'use strict';

// The renderer page's script tags, read the same way by the tests and the structure gate.

function withoutComments(html) {
  return html.split('<!--').map((part, index) => {
    if (!index) return part;
    const end = part.indexOf('-->');
    return end < 0 ? '' : part.slice(end + 3);
  }).join('');
}

/**
 * The `src` of every script tag in a page, in load order. Throws on a tag in any other form than
 * `<script src="...">` (deferred, typed, inline, upper case): it would not load in document order.
 * @param {string} html
 */
function scriptTags(html) {
  const page = withoutComments(html);
  const tags = [...page.matchAll(/<script src="([^"]+)">/g)].map((match) => match[1]);
  if (tags.length !== (page.match(/<script\b/gi) ?? []).length) {
    throw new Error('index.html has a script tag that is not a plain <script src="...">');
  }
  return tags;
}

module.exports = { scriptTags };
