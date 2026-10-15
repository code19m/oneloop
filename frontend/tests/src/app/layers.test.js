import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { openDialog, placeNear } from '../../../src/app/layers.js';

import { useGlobals } from '../../support/helpers.cjs';

const { JSDOM } = createRequire(import.meta.url)('../../support/dom.cjs');

/** A page with an inert-able #app, its document standing in for the global one. */
function page(t) {
  const w = new JSDOM('<div id="app"><button id="behind">Behind</button></div>').window;
  useGlobals(t, { document: w.document });
  return w;
}
const key = (w, name, shiftKey = false) => { const event = new w.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }); w.document.activeElement.dispatchEvent(event); return event; };

test('a dialog keeps Tab among its enabled controls, answers Escape and gives the page back its inert state', (t) => {
  const w = page(t), d = w.document, app = d.getElementById('app'), toasts = d.createElement('div');
  toasts.inert = true; d.body.append(toasts);
  const form = d.createElement('form');
  form.innerHTML = '<input id="first"><button type="button" id="middle">Cancel</button><button id="last">Save</button><button id="off" disabled>Off</button>';
  let escapes = 0;
  const dialog = openDialog({ form, inert: [app, toasts, null], onEscape: () => escapes++ });
  assert.equal(dialog.layer.className, 'confirmation-layer');
  assert.deepEqual([...dialog.layer.children].map((child) => child.className), ['scrim', 'confirmation-wrap']);
  assert.equal(form.parentElement.className, 'confirmation-wrap');
  assert(app.inert);
  d.getElementById('last').focus(); assert(key(w, 'Tab').defaultPrevented); assert.equal(d.activeElement.id, 'first');
  assert(key(w, 'Tab', true).defaultPrevented); assert.equal(d.activeElement.id, 'last');
  d.getElementById('middle').focus(); assert(!key(w, 'Tab').defaultPrevented);
  assert(key(w, 'Escape').defaultPrevented); assert.equal(escapes, 1);
  dialog.close();
  assert(!dialog.layer.isConnected); assert(!app.inert); assert(toasts.inert, 'an element that was inert stays inert');
  d.getElementById('behind').focus(); key(w, 'Escape'); assert.equal(escapes, 1, 'a closed dialog hears no keys');
});

test('a layer goes below its anchor when it fits, above when it does not, and stays inside the view', (t) => {
  const w = page(t), d = w.document;
  Object.assign(w, { innerWidth: 400, innerHeight: 300 });
  const layer = d.createElement('div'); d.body.append(layer);
  Object.defineProperties(layer, { offsetWidth: { value: 100 }, offsetHeight: { value: 50 } });
  const box = (left, top) => ({ left, top, right: left + 40, bottom: top + 20, width: 40 });
  assert.deepEqual(placeNear(box(20, 30), layer), { left: 20, top: 56 });
  assert.deepEqual(placeNear(box(20, 230), layer), { left: 20, top: 174 });
  assert.deepEqual(placeNear(box(390, 30), layer, { align: 'end', gap: 4 }), { left: 292, top: 54 });
  assert.deepEqual(placeNear(box(100, 30), layer, { align: 'center' }), { left: 70, top: 56 });
  assert.deepEqual(placeNear(box(-50, 30), layer), { left: 8, top: 56 });
});
