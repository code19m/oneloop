// views/app.js: the Roadmap's lanes of tasks, its epics and milestones, zoom, scales and track moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, withRuntime, settle, tick, waitFor } = require('../../support/dom.cjs');

/** Sep 28, 2026, 14:00 in the fixture's time zone, Asia/Tashkent: the fixture's today. */
const NOW = Date.parse('2026-09-28T09:00:00Z');
const RAIL = 216;
/**
 * Boot the Roadmap at NOW, 1000 px wide; `prepare(D, w)` edits the
 * projection before the views load. The address names a scale unless a test
 * gives one that doesn't, as the opening fit needs.
 */
function boot(route = 'roadmap/p1?scale=months', { readOnly = false, prepare, width = 1000, setup, api, ...options } = {}) {
  return bootApp({
    route, ...options, api: { serverNow: () => NOW, ...api },
    setup: w => {
      Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.id === 'rmScroll' ? width : 0; } });
      setup?.(w);
    },
    prepare: (D, w) => {
      prepare?.(D, w);
      if (readOnly) D.users.find(u => u.id === D.session.userId).admin = false;
    },
  });
}
/** Resolve after the next animation frame, which applies a pending zoom step or shows a focused mark's card. */
const nextFrame = w => new Promise(resolve => w.requestAnimationFrame(resolve));
/** Dispatch one ctrl+wheel event on the Roadmap; a notch in by default. */
const zoomWheel = (w, sc, init = {}) => { const event = new w.WheelEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: 500, bubbles: true, cancelable: true, ...init }); sc.dispatchEvent(event); return event; };
/** What the zoom tests read from the mounted Roadmap. */
function timeline(d) {
  const sc = () => d.getElementById('rmScroll');
  return {
    sc: sc(),
    /** The timeline's width in pixels, which the zoom scales. */
    width: () => parseFloat(d.querySelector('.rm-canvas').style.width) - RAIL,
    /** Pixels from the scroller's left edge to today, and to a milestone's date. */
    todayX: () => parseFloat(d.querySelector('.rt-lanes > .today-line').style.left) - sc().scrollLeft,
    milestoneX: id => RAIL + JSON.parse(`[${d.querySelector(`[data-milestone="${id}"]`).dataset.flag}]`)[0] - sc().scrollLeft,
  };
}
/** Dates sit on whole pixels, half a pixel at most from their place, and a zoom of up to 2x scales that half pixel. */
const anchored = (x, pointer) => Math.abs(x - pointer) <= 1.5;
const mark = (d, key) => d.querySelector(`.rt-body [data-task="${key}"]`);
const lane = (d, track) => d.querySelector(`.lane[data-track="${track}"]`);

test('ctrl-wheel zoom is scoped to the Roadmap and zooms it in place, keeping its lanes and the focused task', async t => {
  const { w, d } = boot();
  const { sc, width } = timeline(d), shell = d.querySelector('.sidebar'), lanes = [...d.querySelectorAll('.lane')], before = width();
  mark(d, 'BIR-075').focus();
  const scroll = new w.WheelEvent('wheel', { deltaY: 40, clientX: 500, bubbles: true, cancelable: true });
  sc.dispatchEvent(scroll);
  assert(!scroll.defaultPrevented, 'a plain wheel scrolls the Roadmap');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert(zoomWheel(w, sc).defaultPrevented, 'ctrl-wheel never zooms the page');
  await nextFrame(w);
  const during = d.querySelector('.rm-canvas').outerHTML;
  // The pause that ends the gesture changes nothing: what it showed is the result.
  t.mock.timers.tick(180);
  t.mock.timers.reset();
  assert.equal(d.querySelector('.rm-canvas').outerHTML, during);
  assert(Math.abs(width() / before - 1.15) < 0.01, 'a notch zooms 15%');
  assert.equal(d.getElementById('rmScroll'), sc); assert.deepEqual([...d.querySelectorAll('.lane')], lanes);
  assert.equal(d.activeElement.dataset.task, 'BIR-075', 'the drawn-again lane keeps focus on the same task');
  assert.equal(d.querySelector('.sidebar'), shell);
});

test('zooming keeps the date under the pointer in place, also when the pointer moves', async t => {
  const { w, d } = boot();
  const { sc, width, todayX, milestoneX } = timeline(d), before = width();
  sc.scrollLeft += todayX() - 300;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 3; i++) zoomWheel(w, sc, { clientX: 300 });
  await nextFrame(w);
  assert(width() > before * 1.5, 'three notches zoom in');
  assert(anchored(todayX(), 300), 'today, under the pointer, stays there');
  // The same gesture continues with the pointer over the Reading festival's date.
  const x = milestoneX('m2'), zoomed = width();
  zoomWheel(w, sc, { clientX: x, deltaY: 100 });
  await nextFrame(w);
  t.mock.timers.reset();
  assert(width() < zoomed, 'a notch out');
  assert(anchored(milestoneX('m2'), x), 'the date under the moved pointer stays there');
});

test('a wheel notch zooms 15%, touchpad pinch deltas follow the fingers, and zoom stays within 2.2 to 42 px a day', t => {
  const { w, d } = boot();
  const { width } = timeline(d);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** The zoom factor of one gesture: its wheel events, then the pause that ends it. */
  const zoom = events => { const before = width(); for (const init of events) zoomWheel(w, d.getElementById('rmScroll'), init); t.mock.timers.tick(150); return width() / before; };
  // Chrome and Firefox send a touchpad pinch as ctrl+wheel deltas of -100 × ln(scale), split over many events.
  const pinch = (scale, events = 24) => Array.from({ length: events }, () => ({ deltaY: -100 * Math.log(scale) / events }));
  for (const [input, events, factor] of [
    ['a mouse notch', [{ deltaY: -100 }], 1.15],
    ['a mouse notch out', [{ deltaY: 100 }], 1 / 1.15],
    ['a line-mode notch', [{ deltaY: -3, deltaMode: 1 }], 1.15],
    ['a macOS mouse notch', [{ deltaY: -4.000244140625 }], 1.15],
    ['a 1.5x touchpad pinch', pinch(1.5), 1.5],
    ['a 0.8x touchpad pinch', pinch(0.8), 0.8],
  ]) assert(Math.abs(zoom(events) / factor - 1) < 0.01, input);
  zoom(Array.from({ length: 40 }, () => ({ deltaY: -100 })));
  assert(Math.abs(Number(d.querySelector('.rm-month-grid').style.getPropertyValue('--ppd')) - 42) < 0.01, 'at most 42 px a day');
  zoom(Array.from({ length: 60 }, () => ({ deltaY: 100 })));
  assert(Math.abs(Number(d.querySelector('.rm-month-grid').style.getPropertyValue('--ppd')) - 2.2) < 0.01, 'at least 2.2 px a day');
  t.mock.timers.reset();
});

test('a zoom draws the lanes, axis and milestones exactly as a fresh render at that zoom does', t => {
  const { w, d, A } = boot();
  const geometry = () => [...d.querySelectorAll('#rmScroll :is(.rt-body, .ms-line, .ms-label, .today-line, .rt-today, .rm-canvas)')]
    .map(el => [el.className, el.style.left, el.style.top, el.style.width, el.style.minHeight, el.dataset.flag, el.classList.contains('rt-body') ? el.innerHTML : '']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 6; i++) zoomWheel(w, d.getElementById('rmScroll'), { deltaY: 100 });
  t.mock.timers.tick(150);
  t.mock.timers.reset();
  const zoomed = geometry();
  A.refreshRoadmap();
  assert.deepEqual(geometry(), zoomed);
});

test('a touch pinch follows the fingers and ignores the gesture events iOS sends with it', async () => {
  const { w, d } = boot();
  const { sc, width, todayX } = timeline(d), before = width();
  sc.scrollLeft += todayX() - 400; sc.scrollTop = 50;
  const fingers = (x, y, spread) => [{ clientX: x - spread / 2, clientY: y }, { clientX: x + spread / 2, clientY: y }];
  const touch = (type, touches) => { const event = new w.TouchEvent(type, { touches, bubbles: true, cancelable: true }); sc.dispatchEvent(event); return event; };
  const gesture = (type, scale) => { const event = new w.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { scale, clientX: 400 }); sc.dispatchEvent(event); return event; };
  touch('touchstart', fingers(400, 300, 100)); gesture('gesturestart', 1);
  // The fingers spread to twice their distance while their center moves 30 px right and 10 px up.
  const move = touch('touchmove', fingers(430, 290, 200)), change = gesture('gesturechange', 3);
  await nextFrame(w);
  assert(Math.abs(width() / before - 2) < 0.005, 'the zoom follows the fingers, not the gesture events');
  assert(anchored(todayX(), 430), 'the date under the fingers moves with them');
  assert.equal(sc.scrollTop, 60);
  assert(move.defaultPrevented && change.defaultPrevented, 'the page does not scroll or zoom');
  touch('touchend', fingers(430, 290, 0).slice(1)); gesture('gestureend', 3);
  await nextFrame(w);
  assert(Math.abs(width() / before - 2) < 0.005, 'lifting the fingers keeps the zoom');
});

test('a pinch zooms on touch moves that can no longer be cancelled, without trying to cancel them', async () => {
  const { w, d } = boot();
  const { sc, width } = timeline(d), before = width();
  const fingers = (x, y, spread) => [{ clientX: x - spread / 2, clientY: y }, { clientX: x + spread / 2, clientY: y }];
  sc.dispatchEvent(new w.TouchEvent('touchstart', { touches: fingers(400, 300, 100), bubbles: true }));
  // Chrome sends such moves in a pinch that starts while a finger drags a grip, and warns about each cancel.
  const move = new w.TouchEvent('touchmove', { touches: fingers(400, 300, 200), bubbles: true, cancelable: false });
  let cancelled = false;
  move.preventDefault = () => { cancelled = true; };
  sc.dispatchEvent(move);
  await nextFrame(w);
  assert(Math.abs(width() / before - 2) < 0.005, 'the zoom follows the fingers');
  assert.equal(cancelled, false, 'no attempt to cancel the move');
});

test('Safari touchpad pinch gestures zoom the Roadmap around the pointer instead of the page', async () => {
  const { w, d } = boot();
  const { sc, width, todayX } = timeline(d), before = width();
  sc.scrollLeft += todayX() - 400;
  const gesture = (type, scale) => { const event = new w.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { scale, clientX: 400 }); sc.dispatchEvent(event); return event; };
  assert(gesture('gesturestart', 1).defaultPrevented, 'Safari does not zoom the page');
  assert(gesture('gesturechange', 1.5).defaultPrevented);
  await nextFrame(w);
  assert(Math.abs(width() / before - 1.5) < 0.005);
  assert(anchored(todayX(), 400), 'the date under the pointer stays there');
  gesture('gestureend', 1.8);
  assert(Math.abs(width() / before - 1.8) < 0.005, 'the end applies the final scale at once');
});

// ---------- the lanes ----------

test('each track\'s head counts its work in progress and its plans, dated or not, leaving out what it has none of', () => {
  const { d } = boot();
  const figure = track => lane(d, track).querySelector('.lane-figure')?.textContent ?? null;
  assert.deepEqual(['t1', 't2', 't3', 't4', 't5'].map(figure), ['1 planned', '3 in progress · 1 planned', '2 in progress · 2 planned', '1 in progress · 1 planned', null]);
});

test('lanes show skeletons until the Roadmap\'s read lands, then their tasks', () => {
  const { d, D, A } = boot('roadmap/p1?scale=months', { prepare: D => { D.roadmapLoaded = D.roadmap; D.roadmap = null; } });
  assert.equal(d.querySelectorAll('.lane .rt-loading').length, 5);
  assert.equal(d.querySelectorAll('.lane .rt-figure-skeleton').length, 5);
  assert.equal(d.querySelector('.rt-body [data-nav]'), null);
  assert.equal(d.querySelector('.rt-stat-late'), null, 'nothing is counted overdue yet');
  D.roadmap = D.roadmapLoaded; A.refreshRoadmap();
  assert.equal(d.querySelector('.rt-loading'), null);
  assert(mark(d, 'BIR-064'));
});

test('lanes drawn again at a new scroll position slide only up or down, never sideways', () => {
  const slides = [];
  const t = boot('roadmap/p1', { media: () => false, prepare: D => { D.roadmapLoaded = D.roadmap; D.roadmap = null; }, setup: w => {
    // A lane starts where the scroller shows the timeline's start.
    w.Element.prototype.getBoundingClientRect = function () {
      const left = this.matches('.lane') ? -this.ownerDocument.getElementById('rmScroll').scrollLeft : 0, top = this.matches('.lane') ? 100 : 0;
      return { left, top, right: left + 3000, bottom: top + 100, x: left, y: top, width: 3000, height: 100 };
    };
    w.Element.prototype.animate = function (frames) { if (this.matches('.lane')) slides.push(frames[0].transform); return { finished: Promise.resolve(), cancel() {} }; };
  } });
  // The lanes' read lands, and the Roadmap opens at the scale that fits the work, scrolled to it.
  const before = t.d.getElementById('rmScroll').scrollLeft;
  t.D.roadmap = t.D.roadmapLoaded; t.A.refreshRoadmap();
  assert.notEqual(t.d.getElementById('rmScroll').scrollLeft, before);
  assert.deepEqual(slides, []);
});

test('a track with tasks but nothing dated says No dated work, and one without tasks says No tasks yet', () => {
  const { d } = boot('roadmap/p1?scale=months', { prepare: D => {
    D.tracks.push({ id: 't6', projectId: 'p1', name: 'Docs', order: 6, revision: 1 });
    D.roadmap.trackCounts.t6 = { planning: 3, progress: 0, review: 0, done: 0 };
    // Community tools' only epic is done and has nothing on the timeline.
    D.epics.find(epic => epic.id === 'e11').state = 'done';
  } });
  assert.equal(lane(d, 't6').querySelector('.rt-empty-lane').textContent, 'No dated work');
  assert.equal(lane(d, 't6').querySelector('.lane-figure').textContent, '3 planned');
  assert.equal(lane(d, 't5').querySelector('.rt-empty-lane').textContent, 'No tasks yet');
});

test('done work shows as dots at the day it finished; close ones merge into a count whose list Escape closes', async () => {
  const { w, d } = boot('roadmap/p1?scale=months', { actions: true });
  const web = lane(d, 't2');
  // Sep 22 (twice), 24 and 25 lie within 22 px of each other at 8.5 px a day; Sep 10 and 18 don't.
  assert.deepEqual([...web.querySelectorAll('.rt-done')].map(el => el.dataset.task).sort(), ['BIR-052', 'BIR-055']);
  const count = web.querySelector('.rt-count-done');
  assert.equal(count.textContent, '4');
  assert.equal(count.getAttribute('aria-label'), '4 done tasks, Sep 22 – Sep 25');
  count.focus(); count.click();
  const list = d.getElementById('roadmap-list');
  assert.equal(count.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...list.querySelectorAll('.tid')].map(el => el.textContent), ['BIR-061', 'BIR-058', 'BIR-057', 'BIR-056'], 'newest first');
  list.querySelector('.rt-pop-row').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(d.getElementById('roadmap-list'), null);
  assert.equal(d.activeElement, count);
  // At Weeks they are far enough apart to show apart, except the two of Sep 22.
  w.App.setRoadmapScale('weeks'); await nextFrame(w);
  assert.equal(lane(d, 't2').querySelector('.rt-count-done').textContent, '2');
});

test('dated plans show as rings at their deadlines with their titles, and plans without a deadline are not drawn', () => {
  const { d } = boot();
  const plan = mark(d, 'BIR-076');
  assert(plan.classList.contains('rt-planned')); assert(plan.querySelector('.rt-ring'));
  assert.equal(plan.querySelector('.rt-tag').textContent, d.defaultView.DATA.tasks.find(task => task.id === 'BIR-076').title);
  assert.equal(mark(d, 'BIR-079'), null);
  assert.equal(mark(d, 'BIR-069'), null);
});

test('work in progress shows as a bar from its start: late work has the error icon and a red end, blocked work is amber, and work without a deadline fades at now', () => {
  const { d } = boot('roadmap/p1?scale=months', { prepare: D => { D.tasks.find(task => task.id === 'BIR-071').block = { id: 'b1', reason: 'Waiting', by: 'robin', at: NOW, mentions: [] }; } });
  const late = mark(d, 'BIR-072'), blocked = mark(d, 'BIR-071'), open = mark(d, 'BIR-075');
  assert(late.classList.contains('rt-late')); assert(late.querySelector('.rt-slip')); assert(late.querySelector('.rt-icon-late'));
  assert(parseFloat(late.style.getPropertyValue('--slip')) >= 8, 'the late part is at least 8 px');
  assert(blocked.classList.contains('rt-blocked')); assert(blocked.querySelector('.rt-icon-blocked'));
  assert(open.classList.contains('rt-open')); assert(open.querySelector('.rt-tail')); assert(!open.querySelector('.rt-slip'));
  assert(parseFloat(open.style.width) >= 16);
});

test('a section shows three bars at most, the late and blocked first, then "+N in progress", or "+N in review", that opens the rest', () => {
  const more = (state, ids) => D => {
    for (const [index, id] of ids.entries()) {
      D.tasks.push({ ...D.tasks.find(task => task.id === 'BIR-075'), id, internalId: id.toLowerCase(), trackId: 't2', epicId: 'e5', state, deadline: null, startedAt: Date.parse('2026-09-20T10:00:00Z') + index * 3600000 });
      D.roadmap.taskIds.push(id.toLowerCase());
    }
  };
  const { d } = boot('roadmap/p1?scale=months', { actions: true, prepare: more('progress', ['BIR-090', 'BIR-091']) });
  const web = lane(d, 't2');
  assert.deepEqual([...web.querySelectorAll('.rt-bar')].map(el => el.dataset.task).sort(), ['BIR-064', 'BIR-066', 'BIR-080'], 'the three late ones');
  const button = web.querySelector('.rt-more');
  assert.equal(button.textContent, '+2 in progress');
  button.click();
  assert.deepEqual([...d.querySelectorAll('#roadmap-list .tid')].map(el => el.textContent), ['BIR-090', 'BIR-091']);
  const review = boot('roadmap/p1?scale=months', { prepare: more('review', ['BIR-092']) });
  assert.equal(lane(review.d, 't2').querySelector('.rt-more').textContent, '+1 in review');
});

test('every task on the timeline is a button that speaks its card', () => {
  const { d, D } = boot();
  const task = D.tasks.find(item => item.id === 'BIR-064'), epic = D.epics.find(item => item.id === task.epicId);
  assert.equal(mark(d, 'BIR-064').getAttribute('aria-label'), `${task.title}, In Progress, epic ${epic.title}, started Aug 25, due Sep 5, 23 days late, Robin Vale`);
  assert.equal(mark(d, 'BIR-076').tagName, 'BUTTON');
});

test('focus without a press shows a task\'s card, a press opens the task, and a press shows no card', async () => {
  const { w, d, A } = boot();
  const bar = mark(d, 'BIR-064');
  bar.focus(); await nextFrame(w);
  const card = d.getElementById('task-tooltip');
  assert.equal(card.getAttribute('role'), 'tooltip'); assert.equal(bar.getAttribute('aria-describedby'), 'task-tooltip');
  assert.deepEqual([...card.querySelectorAll('.rt-tip-status, .rt-tip-line')].map(el => el.textContent.trim()), ['In Progress', 'Web Apps · Polish reader & librarian apps', 'Started Aug 25 · Due Sep 5 · 23d late', 'Robin Vale']);
  bar.blur(); assert.equal(d.getElementById('task-tooltip'), null);
  const other = mark(d, 'BIR-075');
  other.dispatchEvent(new w.Event('pointerdown', { bubbles: true })); other.focus(); other.click(); await nextFrame(w);
  assert.equal(A.context().view, 'task'); assert.equal(A.context().taskId, 'BIR-075');
});

// ---------- epics ----------

test('an epic\'s box holds its work; its header names it, gives its dates when it has an end date and its progress, and opens its drawer', () => {
  const { d, A } = boot('roadmap/p1?scale=months', { actions: true });
  const header = id => d.querySelector(`.rt-epic-label[data-epic="${id}"]`);
  assert.equal(header('e5').textContent, 'Polish reader & librarian apps63/67');
  assert.equal(header('e6').textContent, 'Reader app buildAug 22 – Sep 3021/34');
  assert.equal(header('e6').querySelector('.rt-epic-prog i').style.width, '62%');
  const box = header('e6').closest('.rt-epic'), bar = mark(d, 'BIR-072'), left = parseFloat(box.style.left);
  assert(parseFloat(bar.style.left) > left && parseFloat(bar.style.left) + parseFloat(bar.style.width) < left + parseFloat(box.style.width), 'its tasks lie in its box');
  assert(header('e7').closest('.rt-epic').classList.contains('rt-epic-planning'));
  header('e6').click();
  assert.equal(A.context().peek, 'e6');
});

test('an epic with nothing on the timeline is its header alone just after Today, or at its start when that is later, and a done one is left out', () => {
  const box = (prepare) => { const { d } = boot('roadmap/p1?scale=months', { prepare }); return d.querySelector('.rt-epic-label[data-epic="e11"]')?.closest('.rt-epic'); };
  const todayLeft = parseFloat(boot().d.querySelector('.rt-lanes > .today-line').style.left) - RAIL;
  const now = box();
  assert(parseFloat(now.style.left) > todayLeft && parseFloat(now.style.left) < todayLeft + 40, 'just after Today');
  const later = box(D => { D.epics.find(epic => epic.id === 'e11').start = '2026-11-01'; });
  assert(parseFloat(later.style.left) >= todayLeft + 33 * 8.5, 'at its start, five weeks on');
  assert.equal(box(D => { D.epics.find(epic => epic.id === 'e11').state = 'done'; }), undefined);
});

test('a done epic\'s box has a green edge and its header a check', () => {
  const { d } = boot();
  const header = d.querySelector('.rt-epic-label[data-epic="e8"]');
  assert(header.closest('.rt-epic').classList.contains('rt-epic-done'));
  assert(header.querySelector('svg'));
  assert.match(header.getAttribute('aria-label'), /12 of 12 tasks done, complete$/);
});

test('focus on an epic\'s header shows its card', async () => {
  const { w, d } = boot();
  d.querySelector('.rt-epic-label[data-epic="e5"]').focus(); await nextFrame(w);
  assert.deepEqual([...d.querySelectorAll('#epic-tooltip :is(.rt-tip-status, .rt-tip-title, .rt-tip-line)')].map(el => el.textContent), ['Epic · In progress', 'Polish reader & librarian apps', 'Web Apps', 'From Aug 18', '63 of 67 tasks done']);
});

// ---------- the header ----------

test('Overdue N shows only when tasks are late, and each press focuses the next late task, longest overdue first, with its card', async () => {
  const { w, d, A } = boot();
  const button = d.querySelector('.rt-stat-late');
  assert.equal(button.textContent, 'Overdue4');
  const shown = [];
  for (let press = 0; press < 5; press++) { A.focusOverdue(); await nextFrame(w); shown.push([d.activeElement.dataset.task, !!d.getElementById('task-tooltip')]); }
  assert.deepEqual(shown, [['BIR-080', true], ['BIR-066', true], ['BIR-064', true], ['BIR-072', true], ['BIR-080', true]]);
  await waitFor(() => /^Overdue 1 of 4: /.test(d.querySelector('[data-announce="polite"]').textContent), 'each step is announced');
  const calm = boot('roadmap/p1?scale=months', { prepare: D => { D.roadmap.overdue = 0; } });
  assert.equal(calm.d.querySelector('.rt-stat-late'), null);
});

// ---------- keyboard ----------

test('each lane\'s timeline is one Tab stop; arrows move inside the lane and Up and Down between lanes', () => {
  const { w, d } = boot();
  for (const body of d.querySelectorAll('.lane .rt-body')) assert(body.querySelectorAll('[tabindex="0"]').length <= 1);
  const key = (el, name) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  const items = [...lane(d, 't2').querySelectorAll('.rt-body [data-nav]')];
  items[0].focus();
  key(items[0], 'ArrowRight');
  assert.equal(d.activeElement, items[1]);
  assert.equal(items[1].tabIndex, 0); assert.equal(items[0].tabIndex, -1, 'the Tab stop moves along');
  key(d.activeElement, 'End');
  assert.equal(d.activeElement, items.at(-1));
  key(d.activeElement, 'Home');
  assert.equal(d.activeElement, items[0]);
  key(d.activeElement, 'ArrowDown');
  assert(lane(d, 't3').contains(d.activeElement), 'Down moves to the next lane');
  key(d.activeElement, 'ArrowUp');
  assert(lane(d, 't2').contains(d.activeElement));
});

// ---------- loading more ----------

test('a view that reaches before the done work the lanes have asks for the next page once, and one that failed is not asked again', async () => {
  const pages = [];
  const t = boot('roadmap/p1?scale=months', {
    prepare: D => { D.roadmap.done.cursor = 'older'; },
    reads: { moreRoadmap: async (projectId, kind) => { pages.push([projectId, kind]); throw new Error('offline'); } },
  });
  await settle();
  assert.deepEqual(pages, [['p1', 'done']], 'the view reaches back past Sep 10');
  const sc = t.d.getElementById('rmScroll');
  sc.scrollLeft -= 50; sc.dispatchEvent(new t.w.Event('scroll')); await nextFrame(t.w); await settle();
  assert.equal(pages.length, 1, 'the page that failed waits for the next read of the Roadmap');
  assert.match(t.d.getElementById('toast-region').textContent, /could not be completed|offline/i);
});

test('a view that reaches past the last dated plan the lanes have asks for the next page of plans', async () => {
  const t = boot('roadmap/p1?scale=months', { prepare: D => { D.roadmap.plans.cursor = 'later'; } });
  const sc = t.d.getElementById('rmScroll');
  sc.scrollLeft = parseFloat(t.d.querySelector('.rm-canvas').style.width); sc.dispatchEvent(new t.w.Event('scroll')); await nextFrame(t.w);
  assert(t.reads.calls.some(([name, projectId, kind]) => name === 'moreRoadmap' && projectId === 'p1' && kind === 'plans'));
});

// ---------- the opening scale and the address ----------

/** The scale buttons in the Roadmap header, as label and pressed state. */
const scales = d => [...d.querySelectorAll('.roadmap-scale button')].map(button => [button.textContent, button.getAttribute('aria-pressed')]);
const pressed = name => ['Weeks', 'Months', 'Quarters'].map(label => [label, String(label === name)]);

test('a Roadmap without a picked scale opens at the one that fits its work, with that work in view, and names no scale', () => {
  // Three weeks of done work, the work in progress and six weeks of dates: Aug 29 to Oct 22.
  const fixture = boot('roadmap/p1', { prepare: D => { D.epics.find(epic => epic.id === 'e11').state = 'done'; } });
  assert.deepEqual(scales(fixture.d), pressed('Months'));
  assert.equal(fixture.w.location.hash, '#/roadmap/p1');
  const { todayX } = timeline(fixture.d);
  assert(todayX() > RAIL && todayX() < 1000, 'today shows');
  // A quiet project: one task started ten days ago.
  const quiet = boot('roadmap/p1', { prepare: D => {
    D.roadmap.taskIds = ['bir-075']; D.milestones.length = 0;
    D.epics.splice(0, D.epics.length, ...D.epics.filter(epic => epic.id === 'e9'));
  } });
  assert.deepEqual(scales(quiet.d), pressed('Weeks'));
  // A narrow window needs more days to a pixel.
  assert.deepEqual(scales(boot('roadmap/p1', { width: 600, prepare: D => { D.epics.find(epic => epic.id === 'e11').state = 'done'; } }).d), pressed('Quarters'));
});

test('a Roadmap address opens at the scale it names, Back shows each entry\'s scale, and one it lacks fits the work in place', async () => {
  const t = boot('roadmap/p1?scale=weeks');
  assert.deepEqual(scales(t.d), pressed('Weeks'));
  await go(t, () => { t.w.location.hash = '#/roadmap/p1?scale=quarters'; });
  assert.deepEqual(scales(t.d), pressed('Quarters'));
  await go(t, () => t.w.history.back());
  assert.equal(t.w.location.hash, '#/roadmap/p1?scale=weeks'); assert.deepEqual(scales(t.d), pressed('Weeks'));
  const other = boot('roadmap/p1?scale=days', { prepare: D => { D.epics.find(epic => epic.id === 'e11').state = 'done'; } });
  assert.deepEqual(scales(other.d), pressed('Months'), 'the fitted scale');
  assert.equal(other.w.location.hash, '#/roadmap/p1'); assert.equal(other.w.history.length, 1, 'in place');
});

test('a scale change rewrites the Roadmap address in place, and after a free zoom it names the nearest scale, which Back keeps', async t => {
  const r = boot();
  const { width } = timeline(r.d);
  r.A.setRoadmapScale('quarters');
  assert.equal(r.w.location.hash, '#/roadmap/p1?scale=quarters');
  r.A.setRoadmapScale('weeks');
  assert.equal(r.w.location.hash, '#/roadmap/p1?scale=weeks'); assert.equal(r.w.history.length, 1);
  /** Zoom out by `notches` wheel notches, of 15% each. */
  const zoomOut = notches => { t.mock.timers.enable({ apis: ['setTimeout'] }); for (let i = 0; i < notches; i++) zoomWheel(r.w, r.d.getElementById('rmScroll'), { deltaY: 100 }); t.mock.timers.tick(150); t.mock.timers.reset(); };
  // 26 px a day is nearest Weeks.
  zoomOut(1);
  assert.deepEqual(scales(r.d), pressed(null)); assert.equal(r.w.location.hash, '#/roadmap/p1?scale=weeks');
  const zoomed = width();
  await go(r, () => r.A.nav('board')); await go(r, () => r.w.history.back());
  assert.equal(width(), zoomed, 'Back keeps the free zoom');
  // 15 px a day is nearest Months, which a picked zoom names too.
  zoomOut(4);
  assert.equal(r.w.location.hash, '#/roadmap/p1?scale=months');
});

test('a sign-out on purpose forgets the picked scale, so the next person\'s Roadmap fits the work', () => {
  const t = boot('roadmap/p1', { prepare: D => { D.epics.find(epic => epic.id === 'e11').state = 'done'; } });
  t.A.setRoadmapScale('weeks');
  t.A.nav('board');
  t.A.clearAddress();
  // The next person signs in on the Board, then opens the Roadmap.
  t.A.resolveRoute(); t.A.nav('roadmap');
  assert.equal(t.w.location.hash, '#/roadmap/p1'); assert.deepEqual(scales(t.d), pressed('Months'));
});

// ---------- scales ----------

/** A keydown on the focused element, such as a shortcut. */
const press = (w, key, init = {}) => { const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }); (w.document.activeElement || w.document.body).dispatchEvent(event); return event; };

test('the scale buttons zoom the Roadmap in place to weeks, months or quarters, and show which one it is at', t => {
  const r = boot(), { sc, width } = timeline(r.d), days = width() / 8.5, lanes = [...r.d.querySelectorAll('.lane')];
  assert.deepEqual(scales(r.d), pressed('Months'));
  r.A.setRoadmapScale('weeks');
  assert(Math.abs(width() - days * 30) <= 2, '30 px a day');
  assert.deepEqual(scales(r.d), pressed('Weeks'));
  assert.equal(r.d.getElementById('rmScroll'), sc); assert.deepEqual([...r.d.querySelectorAll('.lane')], lanes, 'no rebuild');
  r.A.setRoadmapScale('quarters');
  assert(Math.abs(width() - days * 2.6) <= 2);
  assert.deepEqual(scales(r.d), pressed('Quarters'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  zoomWheel(r.w, sc); t.mock.timers.tick(150); t.mock.timers.reset();
  assert.deepEqual(scales(r.d), pressed(null), 'after a free zoom, no scale is on');
});

test('a scale change keeps today where it was', () => {
  const r = boot(), { todayX } = timeline(r.d);
  r.A.goToday();
  const before = todayX();
  for (const scale of ['weeks', 'months']) {
    r.A.setRoadmapScale(scale);
    assert(Math.abs(todayX() - before) <= 1, `${scale}: today stays at ${before} px`);
  }
});

test('a scale change keeps the focused task where it was', () => {
  const r = boot('roadmap/p1?scale=months', { setup: w => {
    // Every task shows in the middle of a 1000 × 800 px Roadmap.
    w.Element.prototype.getBoundingClientRect = function () {
      const box = this.id === 'rmScroll' ? [0, 0, 1000, 800] : this.dataset?.nav ? [400, 300, 420, 320] : [0, 0, 0, 0];
      return { left: box[0], top: box[1], right: box[2], bottom: box[3], x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] };
    };
  } });
  const startX = () => RAIL + parseFloat(mark(r.d, 'BIR-075').style.left) - r.d.getElementById('rmScroll').scrollLeft;
  mark(r.d, 'BIR-075').focus();
  const before = startX();
  r.A.setRoadmapScale('weeks');
  assert(anchored(startX(), before), 'the bar starts where it did');
});

test('W, M and Q switch the scale on the Roadmap, but not while typing, in a dialog or a list, with a modifier or elsewhere', () => {
  const r = boot('roadmap/p1?scale=months', { actions: true });
  r.d.querySelector('.topbar h1').focus();
  assert(press(r.w, 'w').defaultPrevented); assert.deepEqual(scales(r.d), pressed('Weeks'));
  press(r.w, 'Q'); assert.deepEqual(scales(r.d), pressed('Quarters'), 'Caps Lock makes no difference');
  press(r.w, 'm', { ctrlKey: true }); press(r.w, 'm', { shiftKey: true }); press(r.w, 'm', { repeat: true });
  assert.deepEqual(scales(r.d), pressed('Quarters'));
  r.A.openModal('epic');
  r.d.querySelector('.modal [name="title"]').focus();
  assert.equal(press(r.w, 'm').defaultPrevented, false);
  r.A.closeOverlays();
  r.d.querySelector('.sidebar .nav-item').focus();
  assert.equal(press(r.w, 'm').defaultPrevented, false, 'not from the sidebar');
  mark(r.d, 'BIR-075').focus();
  press(r.w, 'm'); assert.deepEqual(scales(r.d), pressed('Months'));
  const count = lane(r.d, 't2').querySelector('.rt-count-done');
  count.focus(); count.click();
  assert.equal(press(r.w, 'w').defaultPrevented, false, 'not while a list is open');
  // A click on empty lane space, or on a button in Safari, leaves focus on the page itself.
  r.d.activeElement.blur(); r.d.getElementById('roadmap-list')?.remove(); assert.equal(r.d.activeElement, r.d.body);
  press(r.w, 'w'); assert.deepEqual(scales(r.d), pressed('Weeks'), 'with focus on the page itself');
  assert.equal(r.d.querySelector('.roadmap-scale [data-scale="weeks"]').getAttribute('aria-keyshortcuts'), 'W');
  r.A.nav('board');
  assert.equal(press(r.w, 'w').defaultPrevented, false, 'only on the Roadmap');
});

test('at the Weeks scale the axis names each Monday, and the first of a month with the month', () => {
  const r = boot();
  r.A.setRoadmapScale('weeks');
  const weeks = [...r.d.querySelectorAll('.rm-month-grid .rm-week')].map(el => el.textContent);
  assert(weeks.length > 3); assert.equal(r.d.querySelectorAll('.rm-month').length, 0);
  assert(weeks.every(label => /^([A-Z][a-z]{2} [1-7]|\d{1,2})$/.test(label)), weeks.join(' | '));
  assert(weeks.includes('Oct 5') && weeks.includes('12'), weeks.join(' | '));
  r.A.setRoadmapScale('months');
  assert.equal(r.d.querySelectorAll('.rm-week').length, 0);
  assert(r.d.querySelectorAll('.rm-month').length > 0);
});

/** Animation frames that run only when the test calls `frame` with their time. */
function heldFrames() {
  const queue = new Map(); let next = 0;
  return {
    setup: w => { w.requestAnimationFrame = callback => { queue.set(++next, callback); return next; }; w.cancelAnimationFrame = id => queue.delete(id); },
    frame: time => { const due = [...queue.values()]; queue.clear(); for (const callback of due) callback(time); },
  };
}

test('a scale change eases over a few frames, and a wheel zoom takes over where it is', () => {
  const { setup, frame } = heldFrames(), r = boot('roadmap/p1?scale=months', { media: () => false, setup });
  const { width } = timeline(r.d), days = width() / 8.5, perDay = () => width() / days;
  r.A.setRoadmapScale('weeks');
  assert(Math.abs(perDay() - 8.5) < 0.05, 'nothing moves before the first frame');
  frame(1000);
  const first = perDay();
  assert(first > 8.5 && first < 30, `the first frame is part of the way: ${first} px a day`);
  frame(1060);
  const second = perDay();
  assert(second > first && second < 30);
  zoomWheel(r.w, r.d.getElementById('rmScroll'), { deltaY: 100 });
  frame(1120); frame(1400);
  assert(Math.abs(perDay() / (second / 1.15) - 1) < 0.02, 'the wheel zooms out from where the scale change was');
  assert.deepEqual(scales(r.d), pressed(null));
});

/** Go to another address with `move`, such as a link or Back, and wait until the page shows it. */
async function go(t, move) {
  const changed = new Promise(resolve => t.w.addEventListener('hashchange', resolve, { once: true }));
  move(); await changed; await settle();
}

test('a scale change still easing when Back leaves the Roadmap writes no address over Back\'s', () => {
  const { setup, frame } = heldFrames(), r = boot('roadmap/p1?scale=months', { media: () => false, setup });
  r.A.setRoadmapScale('weeks');
  // Back has moved the tab to the Board's entry, and its hashchange waits.
  r.w.history.replaceState(r.w.history.state, '', '#/board/p1');
  frame(1000); frame(1060);
  assert.equal(r.w.location.hash, '#/board/p1');
});

test('Today scrolls the mounted Roadmap instead of rebuilding the page', () => {
  const { d, A } = boot();
  const sc = d.getElementById('rmScroll'), shell = d.querySelector('.sidebar'), { todayX } = timeline(d);
  sc.scrollLeft = 0;
  A.goToday();
  assert.equal(d.getElementById('rmScroll'), sc); assert.equal(d.querySelector('.sidebar'), shell);
  assert(Math.abs(todayX() - (RAIL + 0.56 * (1000 - RAIL))) <= 1, 'with dates ahead, today sits at 56% of the timeline');
});

test('on a phone each track\'s head sits above its lane, and the Roadmap opens at Weeks with Today at 60%', () => {
  // Nothing waits after Today, as an epic's header with no work on the timeline would.
  const { d } = boot('roadmap/p1', { width: 390, setup: w => { w.innerWidth = 390; }, prepare: D => { D.epics.find(epic => epic.id === 'e11').state = 'done'; } });
  assert(d.getElementById('rmScroll').classList.contains('rt-stacked'));
  assert.equal(d.querySelector('.rm-axis .rail-cell'), null, 'no rail beside the axis');
  assert.deepEqual(scales(d), pressed('Weeks'));
  const todayX = parseFloat(d.querySelector('.rt-lanes > .today-line').style.left) - d.getElementById('rmScroll').scrollLeft;
  assert(Math.abs(todayX - 0.6 * 390) <= 1, `today at ${todayX} px`);
});

// ---------- milestones ----------

test('milestone details stay readable for viewers, show safe full text and dismiss, while managers can edit', () => {
 const t=boot('roadmap/p1?scale=months',{readOnly:true,prepare:D=>{D.milestones[1].name='A very long milestone name '.repeat(6);D.milestones[1].desc='<img src=x onerror=alert(1)>\nFull description';}});
 const card=t.d.querySelector('[data-milestone="m2"]');assert.equal(card.tagName,'BUTTON');
 t.A.milestoneHover({currentTarget:card},'m2',true);let tip=t.d.querySelector('#milestone-tooltip');assert(tip.textContent.includes(t.D.milestones[1].name));assert(tip.textContent.includes('2026-10-22'));assert(tip.textContent.includes(t.D.milestones[1].desc));assert(!tip.querySelector('img'));assert.equal(card.getAttribute('aria-describedby'),'milestone-tooltip');
 t.A.milestoneClick({currentTarget:card},'m2');assert(!t.d.querySelector('.modal'));assert(t.d.querySelector('#milestone-tooltip'));
 t.d.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(!t.d.querySelector('#milestone-tooltip'));assert(!card.hasAttribute('aria-describedby'));
 t.D.milestones[0].desc='';t.A.milestoneHover({currentTarget:t.d.querySelector('[data-milestone="m1"]')},'m1',true);assert(t.d.querySelector('#milestone-tooltip').textContent.includes('No description'));
 t.d.dispatchEvent(new t.w.Event('pointerdown',{bubbles:true}));assert(!t.d.querySelector('#milestone-tooltip'));
 const a=boot(),anchor=a.d.querySelector('[data-milestone="m2"]');a.A.milestoneHover({currentTarget:anchor},'m2',true);assert(a.d.querySelector('#milestone-tooltip'));a.A.milestoneClick({currentTarget:anchor},'m2');assert(a.d.querySelector('.modal').textContent.includes('Edit milestone'));assert(!a.d.querySelector('#milestone-tooltip'));
});

test('a milestone\'s card shows after a hover delay, and a task\'s card replaces it', async t => {
  const hover = boot('roadmap/p1?scale=months', { readOnly: true }); hover.w.matchMedia = () => ({ matches: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const milestone = hover.d.querySelector('[data-milestone="m2"]');
  hover.A.milestoneHover({ currentTarget: milestone }, 'm2');
  assert(!hover.d.querySelector('#milestone-tooltip'));
  t.mock.timers.tick(250);
  assert(hover.d.querySelector('#milestone-tooltip'));
  t.mock.timers.reset();
  mark(hover.d, 'BIR-075').focus(); await nextFrame(hover.w);
  assert(hover.d.querySelector('#task-tooltip')); assert(!hover.d.querySelector('#milestone-tooltip'));
  assert(!milestone.hasAttribute('aria-describedby'));
});

test('milestone cards a week apart don\'t overlap: the first ends at its line, the next starts at its own', () => {
  const { d } = boot('roadmap/p1?scale=months', { prepare: D => { D.milestones[0].date = '2026-10-05'; D.milestones[1].date = '2026-10-12'; } });
  const cards = [...d.querySelectorAll('[data-milestone]')].map(card => [parseFloat(card.style.left), parseFloat(card.style.left) + parseFloat(card.style.width), card.className]);
  assert(cards[0][1] + 8 <= cards[1][0], JSON.stringify(cards));
  assert.deepEqual(cards.map(([, , className]) => className), ['ms-label rt-card rt-card-end', 'ms-label rt-card']);
});

test('extreme calendar spans keep Roadmap cells bounded at every zoom and records editable', ctx => {
 const t=boot('roadmap/p1?scale=months',{prepare:D=>{D.epics[0].start='0000-01-01';D.milestones[0].date='9999-12-31';}});
 const bounded=zoom=>{const labels=t.d.querySelectorAll('.rm-month,.rm-week').length;assert(labels>0&&labels<100,`${labels} month or week labels at ${zoom}`);assert(t.d.querySelectorAll('.rm-axis-divider').length<200,`dividers at ${zoom}`);assert(t.d.querySelectorAll('.rm-month-line').length<200,`lines at ${zoom}`);};
 bounded('the default zoom');
 const sc=t.d.querySelector('#rmScroll');
 sc.scrollLeft=0;sc.dispatchEvent(new t.w.Event('scroll'));
 ctx.mock.timers.enable({apis:['setTimeout']});
 for(let i=0;i<30;i++)zoomWheel(t.w,sc);
 ctx.mock.timers.tick(150);bounded('the maximum zoom');
 for(let i=0;i<40;i++)zoomWheel(t.w,sc,{deltaY:100});
 ctx.mock.timers.tick(150);bounded('the minimum zoom');
 ctx.mock.timers.reset();
 t.A.refreshRoadmap();
 assert(t.d.querySelectorAll('.rm-month').length < 100);
 assert(t.d.querySelector('[data-milestone]'));
});

// ---------- the epic drawer ----------

test('the epic drawer names its status, gives its dates, and offers New task to people who manage the Board', () => {
  const t = boot('roadmap/p1?scale=months', { actions: true });
  const epic = t.D.epics.find(item => item.id === 'e5'), shown = [];
  for (const end of ['2026-12-31', null]) for (const state of ['planning', 'active', 'done']) {
    Object.assign(epic, { state, end });
    t.A.openPeek(epic.id);
    shown.push([t.d.querySelector('.peek .chip').textContent, t.d.querySelector('.peek-meta .mono').textContent]);
    t.A.closeOverlays();
  }
  assert.deepEqual(shown, [
    ['Planning', 'Aug 18 → Dec 31'], ['In progress', 'Aug 18 → Dec 31'], ['Done', 'Aug 18 → Dec 31'],
    ['Planning', 'From Aug 18'], ['In progress', 'From Aug 18'], ['Done', 'From Aug 18'],
  ]);
  epic.state = 'active'; t.A.openPeek(epic.id);
  [...t.d.querySelectorAll('.peek-actions button')].find(button => button.textContent.trim() === 'New task').click();
  assert.deepEqual([t.A.context().modal.type, t.A.context().modal.epicId], ['task', 'e5']);
  const viewer = boot('roadmap/p1?scale=months', { readOnly: true });
  viewer.A.openPeek('e5');
  assert.deepEqual([...viewer.d.querySelectorAll('.peek-actions button')].map(button => button.textContent), []);
  assert.equal(viewer.d.querySelector('.peek-actions .access-note').textContent, 'Read only');
});

test('Edit epic says that its tasks move with it to another track', () => {
  const t = boot();
  t.A.openModal('epic', 'e6');
  assert.equal(t.d.querySelector('.modal .field .hint').textContent, 'Its 34 tasks move with it to another track.');
  t.A.closeOverlays(); t.A.openModal('epic', 'e11');
  assert.equal(t.d.querySelector('.modal .field .hint'), null, 'an epic without tasks says nothing');
});

// ---------- moving tracks ----------

/** The tracks in the order the Roadmap shows them. */
const laneOrder = d => [...d.querySelectorAll('.lane[data-track]')].map(lane => lane.dataset.track);
const gripOf = (d, id) => d.querySelector(`.lane[data-track="${id}"] .grip`);
/** Press `key` on track `id`'s grip, as a keyboard user does once it has focus. */
function pressGrip(t, id, key) {
  const grip = gripOf(t.d, id);
  grip.focus(); grip.dispatchEvent(new t.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
/** Answer the track move that waits, and let it finish. */
const saved = async t => { t.requests.at(-1).resolve({}); await tick(); };
/** Lay out five 100 px lanes from 100 px down in a 1000 px wide Roadmap, scrolled 500 px into their 3000 px. */
function laneGeometry(t) {
  t.w.Element.prototype.getBoundingClientRect = function () {
    const lanes = [...this.ownerDocument.querySelectorAll('.lane[data-track]')], index = lanes.indexOf(this);
    const [left, top, right, bottom] = this.id === 'rmScroll' ? [0, 0, 1000, 800] : index >= 0 ? [-500, 100 + index * 100, 2500, 200 + index * 100] : [0, 0, 0, 0];
    return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top };
  };
}
/** Send `type` from the first pointer, or from pointer `id`, at `x` and `y`. */
function pointer(t, type, target, x, y, id = 1) {
  const event = new t.w.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, pointerId: id, clientX: x, clientY: y })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
}
const moving = (options = {}) => withRuntime('roadmap/p1?scale=months', ['moveTrack'], { api: { serverNow: () => NOW }, ...options });

test('a track\'s menu offers only Rename track and Delete track, and viewers get no menu, grip or Add track', () => {
  const t = boot('roadmap/p1?scale=months', { actions: true });
  t.d.querySelector('.lane[data-track="t3"] .kebab').click();
  assert.deepEqual([...t.d.querySelectorAll('#overlay-root > .menu button')].map(button => button.textContent.trim()), ['Rename track', 'Delete track']);
  assert(t.d.querySelector('.rt-add-track button'));
  const viewer = boot('roadmap/p1?scale=months', { readOnly: true });
  assert.equal(viewer.d.querySelectorAll('.lane[data-track]').length, 5);
  assert.equal(viewer.d.querySelector('.lane .grip, .lane .kebab, .rt-add-track'), null);
});

test('arrow keys, Home and End on a track\'s grip move the track, keep focus on its grip and say where it went', async () => {
  const t = moving();
  pressGrip(t, 't1', 'ArrowDown');
  assert.deepEqual(laneOrder(t.d), ['t2', 't1', 't3', 't4', 't5']);
  assert.equal(t.d.activeElement, gripOf(t.d, 't1'));
  await waitFor(() => t.d.querySelector('[data-announce="polite"]').textContent === 'Backend & API moved to position 2 of 5', 'the move is announced');
  await saved(t);
  pressGrip(t, 't1', 'End'); await saved(t);
  assert.deepEqual(laneOrder(t.d), ['t2', 't3', 't4', 't5', 't1']);
  pressGrip(t, 't1', 'ArrowUp'); await saved(t);
  pressGrip(t, 't1', 'Home'); await saved(t);
  assert.deepEqual(laneOrder(t.d), ['t1', 't2', 't3', 't4', 't5']);
  assert.equal(t.d.activeElement, gripOf(t.d, 't1'));
  pressGrip(t, 't1', 'ArrowUp');
  assert.deepEqual(t.calls.map(([, move]) => [move.trackId, move.position]), [['t1', 1], ['t1', 4], ['t1', 3], ['t1', 0]], 'the first track goes no higher');
});

test('a track move redraws the Roadmap in place at once, sends one optimistic command and skips a no-op repeat', async () => {
  const t = moving(), main = t.d.getElementById('main'), header = t.d.querySelector('.topbar');
  laneGeometry(t);
  // Backend & API goes below the lower half of Mobile experience, the third lane.
  pointer(t, 'pointerdown', gripOf(t.d, 't1'), 20, 150); pointer(t, 'pointermove', t.d, 500, 380);
  const line = t.d.querySelector('.sort-marker');
  assert.deepEqual([line.hidden, line.style.left, line.style.width], [false, '0px', '1000px'], 'the line shows across the Roadmap, not past it');
  pointer(t, 'pointerup', t.d, 500, 380);
  assert.deepEqual(laneOrder(t.d), ['t2', 't3', 't1', 't4', 't5']);
  assert.equal(t.d.getElementById('main'), main); assert.equal(t.d.querySelector('.topbar'), header, 'only the Roadmap is drawn again');
  // The move comes from the page's window, so it compares as JSON.
  assert.equal(JSON.stringify(t.calls), JSON.stringify([['moveTrack', { trackId: 't1', position: 2, optimistic: true }]]));
  assert.ok(t.A.context().movePending);
  await saved(t);
  assert.equal(t.A.context().movePending, false);
  // Dropped below Mobile experience again, it stays where it is.
  pointer(t, 'pointerdown', gripOf(t.d, 't1'), 20, 350); pointer(t, 'pointermove', t.d, 500, 280); pointer(t, 'pointerup', t.d, 500, 280);
  assert.equal(t.calls.length, 1);
});

test('while a track move saves, a key press on another grip says why and moves nothing, and no drag starts', async () => {
  const t = moving();
  laneGeometry(t);
  pressGrip(t, 't1', 'ArrowDown');
  const key = new t.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  gripOf(t.d, 't3').focus(); gripOf(t.d, 't3').dispatchEvent(key);
  assert(key.defaultPrevented, 'the key does not scroll the Roadmap instead');
  assert.match(t.d.getElementById('toast-region').textContent, /The last track move is still saving/);
  // Mobile experience, now third, is dragged above Web Apps.
  pointer(t, 'pointerdown', gripOf(t.d, 't3'), 20, 350); pointer(t, 'pointermove', t.d, 500, 120);
  assert.equal(t.d.querySelector('.sort-marker'), null, 'no line shows where it would land');
  pointer(t, 'pointerup', t.d, 500, 120);
  assert.equal(t.calls.length, 1);
  await saved(t);
  pressGrip(t, 't3', 'ArrowDown');
  assert.equal(t.calls.length, 2, 'once the move saved, the grip moves its track again');
});

test('a second finger stops a track drag, so a pinch zooms instead of moving the track', () => {
  const t = moving();
  laneGeometry(t);
  pointer(t, 'pointerdown', gripOf(t.d, 't1'), 20, 150); pointer(t, 'pointermove', t.d, 500, 380);
  assert(t.d.querySelector('.sort-marker'), 'the drag shows where the track would land');
  pointer(t, 'pointerdown', t.d.getElementById('rmScroll'), 600, 300, 2);
  assert.equal(t.d.querySelector('.sort-marker'), null, 'the drag stops');
  pointer(t, 'pointerup', t.d, 500, 380);
  assert.deepEqual(laneOrder(t.d), ['t1', 't2', 't3', 't4', 't5']); assert.equal(t.calls.length, 0);
});

test('a change made elsewhere while a grip is held shows once the press ends, so a drag goes on', async () => {
  const t = moving(), renamed = () => t.d.querySelector('.lane[data-track="t5"] .name').textContent;
  laneGeometry(t);
  // A teammate renames a track while Backend & API's grip is held.
  pointer(t, 'pointerdown', gripOf(t.d, 't1'), 20, 150);
  t.D.tracks.find(track => track.id === 't5').name = 'Renamed elsewhere';
  t.A.refreshRoadmap();
  assert.equal(renamed(), 'Community tools', 'the held lanes stay');
  pointer(t, 'pointermove', t.d, 500, 380); pointer(t, 'pointerup', t.d, 500, 380);
  assert.deepEqual(laneOrder(t.d), ['t2', 't3', 't1', 't4', 't5']); assert.equal(t.calls.length, 1);
  await saved(t);
  // A press that ends without a move shows the change too.
  t.D.tracks.find(track => track.id === 't5').name = 'Renamed again';
  pointer(t, 'pointerdown', gripOf(t.d, 't2'), 20, 150); t.A.refreshRoadmap();
  assert.equal(renamed(), 'Renamed elsewhere');
  pointer(t, 'pointerup', t.d, 20, 150); await tick();
  assert.equal(renamed(), 'Renamed again');
});

test('a track moved with the keyboard comes into view below the date axis, then slides there from where it showed', async () => {
  // Lay out 160 px lanes under a 90 px sticky axis in a 400 px tall Roadmap.
  const AXIS = 90, LANE = 160, VIEW = { top: 100, bottom: 500 };
  const t = moving({ media: () => false });
  /** Where each lane's slide starts, by its track. */
  const slides = new Map();
  t.w.Element.prototype.animate = function (frames) {
    if (this.matches('.lane')) slides.set(this.dataset.track, frames[0].transform);
    return { finished: Promise.resolve(), cancel() {} };
  };
  const box = (top, height) => ({ x: 0, left: 0, right: 300, width: 300, y: top, top, bottom: top + height, height });
  t.w.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'rmScroll') return box(VIEW.top, VIEW.bottom - VIEW.top);
    const lane = this.closest?.('.lane[data-track]');
    if (!lane) return box(0, 0);
    const index = [...this.ownerDocument.querySelectorAll('.lane[data-track]')].indexOf(lane);
    return box(VIEW.top + AXIS + index * LANE - this.ownerDocument.getElementById('rmScroll').scrollTop, LANE);
  };
  Object.defineProperty(t.w.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('rm-axis') ? AXIS : 0; } });
  const view = () => {
    const grip = t.d.activeElement, head = grip.closest('.lane-head').getBoundingClientRect();
    return { grip: grip.classList.contains('grip'), below: head.top >= VIEW.top + AXIS, above: head.bottom <= VIEW.bottom };
  };
  pressGrip(t, 't1', 'End');
  assert.deepEqual(view(), { grip: true, below: true, above: true }, 'moved to the bottom');
  // It showed 190 px down and shows 340 px down, so it slides 150 px instead of jumping in from below.
  assert.equal(slides.get('t1'), 'translate(0px, -150px)');
  await saved(t);
  pressGrip(t, 't1', 'Home');
  assert.deepEqual(laneOrder(t.d)[0], 't1');
  assert.deepEqual(view(), { grip: true, below: true, above: true }, 'moved back to the top');
});
