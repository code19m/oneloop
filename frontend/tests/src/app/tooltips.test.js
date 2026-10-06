import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { installTooltips } from '../../../src/app/tooltips.js';
const { JSDOM, bootApp } = createRequire(import.meta.url)('../../support/dom.cjs');

const page = `<main>
  <div class="card" id="card" data-oneloop-onclick="App.openTask('BIR-079')">
    <span class="blocked-badge" id="badge" data-tip-tap data-tip="Waiting for the API — Robin · 2026-10-05 14:03:22">Blocked</span>
    <div class="epic" id="epic" data-tip="Payment integration" data-tip-overflow>Payment integration</div>
  </div>
  <button type="button" id="due" aria-describedby="card-context" data-tip="Deadline 2026-12-24">Dec 24</button>
  <time id="time" aria-label="2026-10-05 14:03:22" data-tip="2026-10-05 14:03:22">5m ago</time>
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
  const t = tips(), due = t.d.getElementById('due');
  let escapes = 0; t.d.addEventListener('keydown', event => { if (event.key === 'Escape') escapes++; });
  due.focus();
  assert.equal(t.tip().textContent, 'Deadline 2026-12-24');
  assert.equal(t.tip().getAttribute('role'), 'tooltip');
  assert.equal(due.getAttribute('aria-describedby'), 'card-context app-tip', 'its own description stays');
  due.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(t.tip(), null); assert.equal(due.getAttribute('aria-describedby'), 'card-context');
  assert.equal(escapes, 0, 'a dialog under the tip would stay open');
  due.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(escapes, 1, 'with no tip open, Escape goes on as before');
  due.blur();
});

test('a tip that repeats the label or shows a cut-off text adds no description', ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const t = tips(), time = t.d.getElementById('time'), name = t.d.getElementById('name');
  t.pointer('pointerover', time); ctx.mock.timers.tick(300);
  assert.equal(t.tip().textContent, '2026-10-05 14:03:22'); assert.equal(time.hasAttribute('aria-describedby'), false);
  t.layout(name, true);
  t.pointer('pointerover', name); ctx.mock.timers.tick(300);
  assert.equal(t.tip().textContent, 'Olivia Owner'); assert.equal(name.hasAttribute('aria-describedby'), false);
  ctx.mock.timers.reset();
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

test('the tip goes when its element is redrawn, or when the page scrolls under a pointer', async () => {
  const t = tips();
  t.d.getElementById('due').focus(); assert(t.tip());
  t.d.getElementById('due').remove();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.tip(), null);
  t.tap(t.d.getElementById('badge')); assert(t.tip());
  t.d.dispatchEvent(new t.w.Event('scroll'));
  assert.equal(t.tip(), null);
});

test('a focused element keeps its tip while the page scrolls, and the tip moves with it', async () => {
  const t = tips(), due = t.d.getElementById('due');
  let top = 900;
  due.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 50, right: 150, width: 100, height: 20, x: 50, y: top });
  due.focus();
  // Tab moved focus below the fold; the browser now scrolls the element into view.
  top = 300; t.d.dispatchEvent(new t.w.Event('scroll'));
  await new Promise(resolve => t.w.requestAnimationFrame(resolve));
  assert(t.tip(), 'the tip stays');
  assert.equal(t.tip().style.top, '326px', 'below the element where it is now');
  top = -200; t.d.dispatchEvent(new t.w.Event('scroll'));
  await new Promise(resolve => t.w.requestAnimationFrame(resolve));
  assert.equal(t.tip(), null, 'gone once the element leaves the view');
});

test('times, Blocked badges and cut-off names carry their details as tips, without a Tab stop each', () => {
  const board = bootApp({ route: 'board', prepare: D => { D.tasks.find(task => task.id === 'BIR-079').block = { id: 'b1', reason: 'Waiting for the API', by: 'robin', at: Date.now() }; } });
  const badge = board.d.querySelector('[data-task="BIR-079"] .blocked-badge');
  assert.equal(badge.tabIndex, -1, 'the card\'s title already describes the block'); assert(board.d.getElementById('card-context-BIR-079').textContent.includes('Blocked: Waiting for the API'));
  assert(badge.hasAttribute('data-tip-tap')); assert.match(badge.dataset.tip, /^Waiting for the API — /); assert.equal(badge.hasAttribute('title'), false);
  const epic = board.d.querySelector('[data-task="BIR-079"] .epic');
  assert(epic.hasAttribute('data-tip-overflow')); assert.equal(epic.hasAttribute('title'), false);
  const task = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').comments = [{ id: 'c1', who: 'robin', ts: Date.now() - 60_000, text: 'Hello', mentions: [], parentId: null }]; } });
  const time = task.d.querySelector('[data-comment="c1"] time');
  assert.equal(time.tabIndex, -1, 'a comment time is no Tab stop');
  assert(task.d.querySelector('[data-comment="c1"] [role="group"]').getAttribute('aria-labelledby').split(' ').includes(time.id), 'the comment is named by its author and full time');
  assert.equal(time.dataset.tip, time.getAttribute('aria-label')); assert.equal(time.hasAttribute('title'), false);
  assert.equal(task.d.querySelectorAll('[title]:not(button):not(a):not([role="button"]):not(.nav-item)').length, 0, 'no detail is left behind a hover-only title');
});

test('a blocked card\'s title shows the reason on keyboard focus only, without repeating its description', ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const board = bootApp({ route: 'board', prepare: D => { D.tasks.find(task => task.id === 'BIR-079').block = { id: 'b1', reason: 'Waiting for the API', by: 'robin', at: Date.now() }; } });
  const matches = board.w.Element.prototype.matches;
  board.w.Element.prototype.matches = function (selector) { return selector === ':focus-visible' ? board.d.activeElement === this : matches.call(this, selector); };
  installTooltips(board.d);
  const title = board.d.querySelector('[data-task="BIR-079"] .card-title-button'), tip = () => board.d.getElementById('app-tip');
  title.dispatchEvent(new board.w.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); ctx.mock.timers.tick(300);
  assert.equal(tip(), null, 'a mouse on the title shows nothing; the badge has the tip');
  title.focus();
  assert.match(tip().textContent, /^Waiting for the API — /);
  assert.equal(title.getAttribute('aria-describedby'), 'card-context-BIR-079', 'screen readers hear the reason once, from the card');
  title.blur(); assert.equal(tip(), null);
  const plain = board.d.querySelector('.card:not(.blocked) .card-title-button');
  plain.focus(); assert.equal(tip(), null, 'a card that is not blocked has no tip');
  ctx.mock.timers.reset();
});

test('a live Board update keeps a shown tip in the badge\'s description', async () => {
  const board = bootApp({ route: 'board', prepare: D => { D.tasks.find(task => task.id === 'BIR-079').block = { id: 'b1', reason: 'Waiting for the API', by: 'robin', at: Date.now() }; } });
  installTooltips(board.d);
  const badge = () => board.d.querySelector('[data-task="BIR-079"] .blocked-badge');
  badge().dispatchEvent(new board.w.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  badge().dispatchEvent(new board.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(board.d.getElementById('app-tip')?.textContent.startsWith('Waiting for the API'), true);
  const shown = badge();
  board.D.tasks.find(task => task.id === 'BIR-079').title = 'Renamed while the tip shows';
  board.A.refreshBoard({ animate: false });
  assert.equal(badge(), shown, 'the update patches the card in place');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shown.getAttribute('aria-describedby'), 'app-tip');
});
