'use strict';
// Test helpers that need no DOM, so unit tests can use them without loading jsdom.
const assert = require('node:assert/strict');

const replaced = new WeakMap();
/**
 * Point globals at test values until test `t` ends, such as
 * `useGlobals(t, {document: w.document})`. Each global then gets back its old
 * value, or goes away if it had none. With a booted app window, assign the
 * global instead: support/dom.cjs puts the window's globals back itself.
 */
function useGlobals(t, values) {
  if (!replaced.has(t)) {
    const saved = [];
    replaced.set(t, saved);
    t.after(() => {
      for (const [name, descriptor] of saved.reverse()) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
  }
  for (const [name, value] of Object.entries(values)) {
    replaced.get(t).push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value });
  }
}

/** Let pending microtasks and immediate callbacks run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Poll `condition` on the event loop until it holds, then assert it. */
async function waitFor(condition, message = 'condition holds', timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), message);
}

/** Let timers that are due run, and the promise work they start. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** A promise with its resolve and reject functions. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

module.exports = { useGlobals, settle, tick, waitFor, deferred };
