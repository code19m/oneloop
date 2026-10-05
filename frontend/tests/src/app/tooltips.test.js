import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { installTooltips } from '../../../src/app/tooltips.js';
const { JSDOM, bootApp } = createRequire(import.meta.url)('../../support/dom.cjs');

const page = `<main>
  <div class="card" id="card" data-oneloop-onclick="App.openTask('BIR-079')">
    <span class="blocked-badge" tabindex="0" id="badge" aria-describedby="card-context" data-tip="Waiting for the API — Robin · 2026-10-05 14:03:22">Blocked</span>
    <div class="epic" id="epic" data-tip="Payment integration" data-tip-overflow>Payment integration</div>
  </div>
  <time tabindex="0" id="time" aria-label="2026-10-05 14:03:22" data-tip="2026-10-05 14:03:22">5m ago</time>
  <b id="name" data-tip="Olivia Owner" data-tip-overflow>Olivia Owner</b>
</main>`;

/** A page with tips. Keyboard focus counts as visible focus, which jsdom can't tell. */
function tips() {
  const dom = new JSDOM(page, { pretendToBeVisual: true }), w = dom.window, d = w.document;
  const matches = w.Element.prototype.matches;
  w.Element.prototype.matches = function (selector) { return selector === ':focus-visible' ? d.activeElement === this : matches.call(this, selector); };
  const opened = [];
  d.getElementById('card').addEventListener('click', () => opened.push('card'));
  const tooltips = installTooltips(d, { delay: 300, hideDelay: 120 });
  const tip = () => d.getElementById('app-tip');
  const pointer = (type, target, init = {}) => target.dispatchEvent(new w.PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', ...init }));
  const tap = target => { pointer('pointerdown', target, { pointerType: 'touch' }); target.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
  /** Lay `element` out with text that fits, or is cut off. */
  const layout = (element, cut) => {
    element.getClientRects = () => [{}];
    Object.defineProperties(element, { scrollWidth: { configurable: true, value: cut ? 300 : 100 }, clientWidth: { configurable: true, value: 100 } });
  };
  return { w, d, tip, tooltips, opened, pointer, tap, layout };
}

test('keyboard focus shows the tip and describes the element; Escape hides it and nothing else', () => {
  const t = tips(), badge = t.d.getElementById('badge');
  let escapes = 0; t.d.addEventListener('keydown', event => { if (event.key === 'Escape') escapes++; });
  badge.focus();
  assert.equal(t.tip().textContent, 'Waiting for the API — Robin · 2026-10-05 14:03:22');
  assert.equal(t.tip().getAttribute('role'), 'tooltip');
  assert.equal(badge.getAttribute('aria-describedby'), 'card-context app-tip', 'its own description stays');
  badge.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(t.tip(), null); assert.equal(badge.getAttribute('aria-describedby'), 'card-context');
  assert.equal(escapes, 0, 'a dialog under the tip would stay open');
  badge.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(escapes, 1, 'with no tip open, Escape goes on as before');
});

test('a focused time is described by its full value until it loses focus', () => {
  const t = tips(), time = t.d.getElementById('time');
  time.focus();
  assert.equal(t.tip().textContent, '2026-10-05 14:03:22'); assert.equal(time.getAttribute('aria-describedby'), 'app-tip');
  time.blur();
  assert.equal(t.tip(), null); assert.equal(time.hasAttribute('aria-describedby'), false);
});

test('a mouse hover shows the tip after a short delay, and the pointer can move onto it', ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const t = tips(), time = t.d.getElementById('time');
  t.pointer('pointerover', time);
  ctx.mock.timers.tick(299); assert.equal(t.tip(), null);
  ctx.mock.timers.tick(1); assert(t.tip());
  t.pointer('pointerout', time, { relatedTarget: t.tip() }); t.pointer('pointerover', t.tip());
  ctx.mock.timers.tick(500); assert(t.tip(), 'it stays while the pointer is on it');
  t.pointer('pointerout', t.tip(), { relatedTarget: t.d.body });
  ctx.mock.timers.tick(120); assert.equal(t.tip(), null);
  ctx.mock.timers.reset();
});

test('a tap on the Blocked badge shows the reason instead of opening the card, and a second tap hides it', () => {
  const t = tips(), badge = t.d.getElementById('badge');
  t.tap(badge);
  assert.match(t.tip().textContent, /Waiting for the API/); assert.deepEqual(t.opened, []);
  t.tap(badge);
  assert.equal(t.tip(), null); assert.deepEqual(t.opened, []);
  t.tap(t.d.getElementById('time')); assert(t.tip());
  t.pointer('pointerdown', t.d.body, { pointerType: 'touch' });
  assert.equal(t.tip(), null, 'a tap elsewhere hides it');
});

test('a tip on text inside a card leaves the tap to the card', () => {
  const t = tips(), epic = t.d.getElementById('epic');
  t.layout(epic, true);
  t.tap(epic);
  assert.deepEqual(t.opened, ['card']); assert.equal(t.tip(), null);
});

test('with data-tip-overflow, only a name that is cut off or hidden shows its tip', ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const t = tips(), name = t.d.getElementById('name');
  t.layout(name, false);
  t.tap(name); assert.equal(t.tip(), null, 'the whole name shows');
  t.layout(name, true);
  t.tap(name); assert.equal(t.tip().textContent, 'Olivia Owner');
  t.tap(name);
  name.getClientRects = () => [];
  t.pointer('pointerover', name); ctx.mock.timers.tick(300);
  assert(t.tip(), 'a label that is not shown at all, such as in the icon rail');
  ctx.mock.timers.reset();
});

test('the tip goes when its element is redrawn, or the page scrolls', async () => {
  const t = tips();
  t.d.getElementById('time').focus(); assert(t.tip());
  t.d.getElementById('time').remove();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.tip(), null);
  t.d.getElementById('badge').focus(); assert(t.tip());
  t.d.dispatchEvent(new t.w.Event('scroll'));
  assert.equal(t.tip(), null);
});

test('times, Blocked badges and cut-off names in the views carry their details as tips', () => {
  const board = bootApp({ route: 'board', prepare: D => { D.tasks.find(task => task.id === 'BIR-079').block = { id: 'b1', reason: 'Waiting for the API', by: 'robin', at: Date.now() }; } });
  const badge = board.d.querySelector('[data-task="BIR-079"] .blocked-badge');
  assert.equal(badge.getAttribute('tabindex'), '0'); assert.match(badge.dataset.tip, /^Waiting for the API — /); assert.equal(badge.hasAttribute('title'), false);
  const epic = board.d.querySelector('[data-task="BIR-079"] .epic');
  assert(epic.hasAttribute('data-tip-overflow')); assert.equal(epic.hasAttribute('title'), false);
  const task = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').comments = [{ id: 'c1', who: 'robin', ts: Date.now() - 60_000, text: 'Hello', mentions: [], parentId: null }]; } });
  const time = task.d.querySelector('[data-comment="c1"] time');
  assert.equal(time.getAttribute('tabindex'), '0', 'a comment time takes keyboard focus');
  assert.equal(time.dataset.tip, time.getAttribute('aria-label')); assert.equal(time.hasAttribute('title'), false);
  assert.equal(task.d.querySelectorAll('[title]:not(button):not(a):not([role="button"]):not(.nav-item)').length, 0, 'no detail is left behind a hover-only title');
});
