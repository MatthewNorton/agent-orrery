'use strict';

// A document with just enough of the DOM for the renderer's row and card builders: elements that
// keep their class, text, children, attributes and listeners, to be read back by the tests.

function fakeElement(tag) {
  const attributes = new Map();
  const listeners = new Map();
  const element = {
    tagName: String(tag).toUpperCase(), className: '', textContent: '', title: '', tabIndex: 0,
    children: [], style: {}, dataset: {},
    append(...nodes) { element.children.push(...nodes); },
    appendChild(node) { element.children.push(node); return node; },
    removeChild(node) { element.children.splice(element.children.indexOf(node), 1); return node; },
    get firstChild() { return element.children[0] || null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    removeAttribute(name) { attributes.delete(name); },
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

/** A document whose getElementById makes each element the first time it is asked for. */
function fakeDocument() {
  const byId = new Map();
  return {
    createElement: fakeElement,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, fakeElement('div'));
      return byId.get(id);
    },
  };
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
