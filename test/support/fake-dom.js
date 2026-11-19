'use strict';

// A document with just enough of the DOM for the renderer's row and card builders: elements that
// keep their class, text, children, attributes and listeners, to be read back by the tests. A
// child has one parent: placing it again moves it. `id`, `className` and `dataset` are plain
// fields, not attributes.

function fakeElement(tag) {
  const attributes = new Map();
  const listeners = new Map();
  // Puts `node` among the children before `before` (at the end without one), out of where it was.
  const place = (node, before = null) => {
    if (node && typeof node === 'object') {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = element;
    }
    const at = before ? element.children.indexOf(before) : -1;
    element.children.splice(at < 0 ? element.children.length : at, 0, node);
    return node;
  };
  const element = {
    tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(), nodeType: 1,
    className: '', textContent: '', title: '', tabIndex: 0,
    children: [], parentNode: null, style: {}, dataset: {},
    append(...nodes) { for (const node of nodes) place(node); },
    appendChild: (node) => place(node),
    insertBefore: (node, before) => place(node, before),
    replaceChild(node, old) { place(node, old); return element.removeChild(old); },
    removeChild(node) {
      element.children.splice(element.children.indexOf(node), 1);
      if (node && typeof node === 'object') node.parentNode = null;
      return node;
    },
    remove() { if (element.parentNode) element.parentNode.removeChild(element); },
    get firstChild() { return element.children[0] || null; },
    get childNodes() { return element.children; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    hasAttribute: (name) => attributes.has(name),
    removeAttribute(name) { attributes.delete(name); },
    get attributes() { return [...attributes].map(([name, value]) => ({ name, value })); },
    /** The first element below this one that `[name="value"]` picks; no other selector is known. */
    querySelector(selector) {
      const [, name, value] = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector) || [];
      if (!name) throw new Error('fake querySelector knows [name="value"] only: ' + selector);
      for (const child of element.children) {
        if (!child || typeof child !== 'object') continue;
        if (child.getAttribute(name) === value) return child;
        const below = child.querySelector(selector);
        if (below) return below;
      }
      return null;
    },
    scrolledIntoView: 0,
    scrollIntoView() { element.scrolledIntoView++; },
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    /** Runs the `type` listeners with `event`, which gains counting preventDefault and stopPropagation. */
    fire(type, event = {}) {
      const sent = { prevented: 0, stopped: 0, ...event };
      sent.preventDefault = () => { sent.prevented++; };
      sent.stopPropagation = () => { sent.stopped++; };
      for (const listener of listeners.get(type) || []) listener(sent);
      return sent;
    },
    classList: {
      contains: (name) => element.className.split(' ').includes(name),
      add(name) { if (!this.contains(name)) element.className = (element.className + ' ' + name).trim(); },
      remove(name) { element.className = element.className.split(' ').filter((part) => part !== name).join(' '); },
      toggle(name, on = !this.contains(name)) { if (on) this.add(name); else this.remove(name); },
    },
  };
  return element;
}

/**
 * A document whose getElementById makes each element the first time it is asked for. Given `ids`,
 * the page holds those elements and no others.
 */
function fakeDocument(ids) {
  const byId = new Map((ids || []).map((id) => [id, fakeElement('div')]));
  return Object.assign(fakeElement('#document'), {
    createElement: fakeElement,
    activeElement: null,
    getElementById(id) {
      if (!ids && !byId.has(id)) byId.set(id, fakeElement('div'));
      return byId.get(id) || null;
    },
  });
}

/** The text a node shows: its own, then its children's, in order. */
function textOf(node) {
  if (node == null || typeof node !== 'object') return node == null ? '' : String(node);
  return String(node.textContent || '') + node.children.map(textOf).join('');
}

/** Every element at or under `node` that has class `name`, in order. */
function withClass(node, name) {
  if (node == null || typeof node !== 'object') return [];
  return [...(node.classList.contains(name) ? [node] : []), ...node.children.flatMap((child) => withClass(child, name))];
}

module.exports = { fakeDocument, fakeElement, textOf, withClass };
