// views/app.js: the Roadmap, its milestones, zoom and track moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, withRuntime, settle, tick, waitFor } = require('../../support/dom.cjs');

/** Boot the views; `prepare(D, w)` edits the projection before they load. */
const boot = (route = 'roadmap', { readOnly = false, prepare } = {}) => bootApp({ route, prepare: (D, w) => {
  prepare?.(D, w);
  if (readOnly) D.users.find(u => u.id === D.session.userId).admin = false;
} });


/** Resolve after the next animation frame, which applies a pending zoom step. */
const nextFrame = w => new Promise(resolve => w.requestAnimationFrame(resolve));
/** Dispatch one ctrl+wheel event on the Roadmap; a notch in by default. */
const zoomWheel = (w, sc, init = {}) => { const event = new w.WheelEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: 500, bubbles: true, cancelable: true, ...init }); sc.dispatchEvent(event); return event; };
/** What the zoom tests read from the mounted Roadmap. */
function timeline(d) {
  const sc = d.getElementById('rmScroll'), rail = parseFloat(d.querySelector('.lane-head').style.width), bar = id => d.querySelector(`[data-epic="${id}"]`);
  return {
    sc, rail,
    width: () => parseFloat(d.querySelector('.rm-canvas').style.width) - rail,
    barWidth: id => parseFloat(bar(id).style.width),
    /** Pixels from the scroller's left edge to the epic's start date. */
    startX: id => rail + parseFloat(bar(id).style.left) - sc.scrollLeft,
  };
}
/** Bars sit on whole pixels, half a pixel at most from their dates, and a zoom of up to 2x scales that half pixel. */
const anchored = (x, pointer) => Math.abs(x - pointer) <= 1.5;

test('ctrl-wheel zoom is scoped to the Roadmap and resizes it in place, without a rebuild or a jump at the end', async t => {
  const { w, d } = bootApp({ route: 'roadmap' });
  const { sc, barWidth } = timeline(d), shell = d.querySelector('.sidebar'), bar = d.querySelector('[data-epic="e6"]'), before = barWidth('e6');
  const geometry = () => [...d.querySelectorAll('#rmScroll .lane, #rmScroll [data-epic], #rmScroll [data-milestone]')].map(el => el.getAttribute('style'));
  bar.focus();
  const scroll = new w.WheelEvent('wheel', { deltaY: 40, clientX: 500, bubbles: true, cancelable: true });
  sc.dispatchEvent(scroll);
  assert(!scroll.defaultPrevented, 'a plain wheel scrolls the Roadmap');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert(zoomWheel(w, sc).defaultPrevented, 'ctrl-wheel never zooms the page');
  await nextFrame(w);
  const during = geometry();
  // The pause that ends the gesture changes nothing: what it showed is the result.
  t.mock.timers.tick(180);
  t.mock.timers.reset();
  assert.deepEqual(geometry(), during);
  assert(Math.abs(barWidth('e6') / before - 1.15) < 0.01, 'a notch makes bars 15% wider');
  assert.equal(d.getElementById('rmScroll'), sc); assert.equal(d.querySelector('[data-epic="e6"]'), bar);
  assert.equal(d.activeElement, bar); assert.equal(d.querySelector('.sidebar'), shell);
});

test('zooming keeps the date under the pointer in place, also when the pointer moves', async t => {
  const { w, d } = bootApp({ route: 'roadmap' });
  const { sc, barWidth, startX } = timeline(d), before = barWidth('e9');
  sc.scrollLeft += startX('e9') - 300;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 3; i++) zoomWheel(w, sc, { clientX: 300 });
  await nextFrame(w);
  assert(barWidth('e9') > before * 1.5, 'three notches zoom in');
  assert(anchored(startX('e9'), 300), 'the start of the epic under the pointer stays there');
  // The same gesture continues with the pointer over another epic's start.
  const x = startX('e10'), zoomed = barWidth('e10');
  zoomWheel(w, sc, { clientX: x, deltaY: 100 });
  await nextFrame(w);
  t.mock.timers.reset();
  assert(barWidth('e10') < zoomed, 'a notch out');
  assert(anchored(startX('e10'), x), 'the date under the moved pointer stays there');
});

test('a wheel notch zooms 15%, touchpad pinch deltas follow the fingers, and zoom stays within 2.2 to 42 px a day', t => {
  const { w, d } = bootApp({ route: 'roadmap' });
  const { width, barWidth } = timeline(d);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** The zoom factor of one gesture: its wheel events, then the pause that ends it. */
  const zoom = events => { const before = width(); for (const init of events) zoomWheel(w, d.getElementById('rmScroll'), init); t.mock.timers.tick(150); return width() / before; };
  // Chrome and Firefox send a touchpad pinch as ctrl+wheel deltas of -100 × ln(scale), split over many events.
  const pinch = (scale, events = 24) => Array.from({ length: events }, () => ({ deltaY: -100 * Math.log(scale) / events }));
  for (const [input, events, factor] of [
    ['a mouse notch', [{ deltaY: -100 }], 1.15],
    ['a mouse notch out', [{ deltaY: 100 }], 1 / 1.15],
    ['a notch in lines', [{ deltaY: -3, deltaMode: 1 }], 1.15],
    ['a notch in pages', [{ deltaY: 1, deltaMode: 2 }], 1 / 1.15],
    ['a macOS notch', [{ deltaY: -4.000244140625 }], 1.15],
    ['an accelerated macOS notch', [{ deltaY: 8.00048828125 }], 1 / 1.15],
    ['a 2.4x touchpad pinch', pinch(2.4), 2.4],
    ['the pinch back', pinch(1 / 2.4), 1 / 2.4],
  ]) assert(Math.abs(zoom(events) / factor - 1) < 0.005, `${input} zooms ${factor.toFixed(3)}x`);
  // At 42 and 2.2 px a day, the 39-day Reader app build is 1638 and 86 px wide.
  zoom(Array.from({ length: 30 }, () => ({ deltaY: -100 })));
  assert(Math.abs(barWidth('e6') - 39 * 42) <= 1, 'the zoom stops at 42 px a day');
  zoom(Array.from({ length: 40 }, () => ({ deltaY: 100 })));
  assert(Math.abs(barWidth('e6') - 39 * 2.2) <= 1, 'the zoom stops at 2.2 px a day');
  t.mock.timers.reset();
});

test('zooming re-packs rows and lane heights exactly as a fresh render does', t => {
  const { w, d, A } = bootApp({ route: 'roadmap' });
  const { sc } = timeline(d), lane = d.querySelector('.lane[data-track="t3"]'), height = lane.style.height;
  const geometry = () => ({
    bars: [...d.querySelectorAll('#rmScroll [data-epic]')].map(el => [el.dataset.epic, el.style.left, el.style.top, el.style.width]),
    lanes: [...d.querySelectorAll('#rmScroll .lane')].map(el => el.style.height),
    marks: [...d.querySelectorAll('#rmScroll :is(.ms-line, .ms-label, .today-line, .today-pill)')].map(el => [el.className, el.style.left, el.style.top]),
    axis: d.querySelector('#rmScroll .rm-axis').style.height, canvas: d.querySelector('#rmScroll .rm-canvas').style.width,
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 12; i++) zoomWheel(w, sc, { deltaY: 100 });
  t.mock.timers.tick(150);
  t.mock.timers.reset();
  assert.equal(d.querySelector('.lane[data-track="t3"]'), lane, 'the zoom kept the lane');
  assert.notEqual(lane.style.height, height, 'Mobile experience needs a second row at the minimum zoom');
  const zoomed = geometry();
  A.refreshRoadmap();
  assert.deepEqual(geometry(), zoomed);
});

test('a touch pinch follows the fingers and ignores the gesture events iOS sends with it', async () => {
  const { w, d } = bootApp({ route: 'roadmap' });
  const { sc, width, startX } = timeline(d), before = width();
  sc.scrollLeft += startX('e9') - 400; sc.scrollTop = 50;
  const fingers = (x, y, spread) => [{ clientX: x - spread / 2, clientY: y }, { clientX: x + spread / 2, clientY: y }];
  const touch = (type, touches) => { const event = new w.TouchEvent(type, { touches, bubbles: true, cancelable: true }); sc.dispatchEvent(event); return event; };
  const gesture = (type, scale) => { const event = new w.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { scale, clientX: 400 }); sc.dispatchEvent(event); return event; };
  touch('touchstart', fingers(400, 300, 100)); gesture('gesturestart', 1);
  // The fingers spread to twice their distance while their center moves 30 px right and 10 px up.
  const move = touch('touchmove', fingers(430, 290, 200)), change = gesture('gesturechange', 3);
  await nextFrame(w);
  assert(Math.abs(width() / before - 2) < 0.005, 'the zoom follows the fingers, not the gesture events');
  assert(anchored(startX('e9'), 430), 'the date under the fingers moves with them');
  assert.equal(sc.scrollTop, 60);
  assert(move.defaultPrevented && change.defaultPrevented, 'the page does not scroll or zoom');
  touch('touchend', fingers(430, 290, 0).slice(1)); gesture('gestureend', 3);
  await nextFrame(w);
  assert(Math.abs(width() / before - 2) < 0.005, 'lifting the fingers keeps the zoom');
});

test('Safari touchpad pinch gestures zoom the Roadmap around the pointer instead of the page', async () => {
  const { w, d } = bootApp({ route: 'roadmap' });
  const { sc, width, startX } = timeline(d), before = width();
  sc.scrollLeft += startX('e9') - 400;
  const gesture = (type, scale) => { const event = new w.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { scale, clientX: 400 }); sc.dispatchEvent(event); return event; };
  assert(gesture('gesturestart', 1).defaultPrevented, 'Safari does not zoom the page');
  assert(gesture('gesturechange', 1.5).defaultPrevented);
  await nextFrame(w);
  assert(Math.abs(width() / before - 1.5) < 0.005);
  assert(anchored(startX('e9'), 400), 'the date under the pointer stays there');
  gesture('gestureend', 1.8);
  assert(Math.abs(width() / before - 1.8) < 0.005, 'the end applies the final scale at once');
});

test('epics show a loading state, not 0/0, until their task counts arrive', () => {
  const { d, D, A } = boot('roadmap', { readOnly: true, prepare: D => {
    for (const id of ['e6', 'e8']) Object.assign(D.epics.find(epic => epic.id === id), { counted: false, done: 0, total: 0 });
  } });
  const meta = id => d.querySelector(`[data-epic="${id}"] .m`);
  assert(meta('e6').querySelector('.sr-only').textContent.includes('Loading task counts'));
  assert(!meta('e6').textContent.includes('0/0'));
  assert(!d.querySelector('[data-epic="e6"] .prog'), 'no progress bar without counts');
  assert.equal(meta('e8').textContent.trim(), 'complete', 'a done epic needs no counts');
  A.epicHover({ currentTarget: d.querySelector('[data-epic="e6"]') }, 'e6', true);
  assert(d.querySelector('#epic-tooltip').textContent.includes('Loading task counts'));
  Object.assign(D.epics.find(epic => epic.id === 'e6'), { counted: true, done: 21, total: 34 });
  A.refreshRoadmap();
  assert.equal(meta('e6').textContent.trim(), '21/34');
});

test('an epic bar shows its tooltip on keyboard focus and opens its drawer on Enter', () => {
  const t = bootApp({ route: 'roadmap', actions: true });
  const bar = t.d.querySelector('[data-epic]');
  bar.focus();
  assert.equal(t.d.getElementById('epic-tooltip')?.getAttribute('role'), 'tooltip');
  assert.equal(bar.getAttribute('aria-describedby'), 'epic-tooltip');
  bar.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(t.A.context().peek, bar.dataset.epic);
});

test('Today scrolls the mounted Roadmap instead of rebuilding the page', () => {
  const { d, A } = bootApp({ route: 'roadmap' });
  const sc = d.getElementById('rmScroll'), rail = parseFloat(d.querySelector('.lane-head').style.width), shell = d.querySelector('.sidebar'), pill = d.querySelector('.today-pill');
  Object.defineProperty(sc, 'clientWidth', { value: 1000 });
  sc.scrollLeft = 0;
  A.goToday();
  assert.equal(d.getElementById('rmScroll'), sc); assert.equal(d.querySelector('.sidebar'), shell);
  assert(Math.abs(rail + parseFloat(pill.style.left) - sc.scrollLeft - 420) <= 0.5, 'today sits at 42% of the view');
});

test('an ongoing epic that starts after every other date stays on the timeline', () => {
  const { d } = boot('roadmap', { prepare: D => { D.epics.find(epic => epic.id === 'e11').start = '2099-01-01'; } });
  const rail = parseFloat(d.querySelector('.lane-head').style.width), bar = d.querySelector('[data-epic="e11"]');
  assert(rail + parseFloat(bar.style.left) + 60 <= parseFloat(d.querySelector('.rm-canvas').style.width), 'the bar starts with room for its minimum width');
});

test('a completed open-ended epic reads as complete, also without tasks', () => {
  // e11 has no end date. Done by hand with no tasks, it is complete, not a quiet ongoing bar.
  const { d } = boot('roadmap', { prepare: D => Object.assign(D.epics.find(epic => epic.id === 'e11'), { state: 'done', total: 0, done: 0 }) });
  const bar = d.querySelector('[data-epic="e11"].bar'), meta = bar.querySelector('.m').textContent;
  assert(bar.classList.contains('done'));
  assert(!bar.classList.contains('quiet'));
  assert(meta.includes('complete') && !meta.includes('ongoing'), meta);
});

test('milestone details stay readable for viewers, show safe full text and dismiss, while managers can edit', () => {
 const t=boot('roadmap',{readOnly:true,prepare:D=>{D.milestones[1].name='A very long milestone name '.repeat(6);D.milestones[1].desc='<img src=x onerror=alert(1)>\nFull description';}});
 const card=t.d.querySelector('[data-milestone="m2"]');assert.equal(card.tagName,'BUTTON');
 t.A.milestoneHover({currentTarget:card},'m2',true);let tip=t.d.querySelector('#milestone-tooltip');assert(tip.textContent.includes(t.D.milestones[1].name));assert(tip.textContent.includes('2026-10-22'));assert(tip.textContent.includes(t.D.milestones[1].desc));assert(!tip.querySelector('img'));assert.equal(card.getAttribute('aria-describedby'),'milestone-tooltip');
 t.A.milestoneClick({currentTarget:card},'m2');assert(!t.d.querySelector('.modal'));assert(t.d.querySelector('#milestone-tooltip'));
 t.d.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(!t.d.querySelector('#milestone-tooltip'));assert(!card.hasAttribute('aria-describedby'));
 t.D.milestones[0].desc='';t.A.milestoneHover({currentTarget:t.d.querySelector('[data-milestone="m1"]')},'m1',true);assert(t.d.querySelector('#milestone-tooltip').textContent.includes('No description'));assert(!t.d.querySelector('#milestone-tooltip').textContent.includes('Completed'));
 t.d.dispatchEvent(new t.w.Event('pointerdown',{bubbles:true}));assert(!t.d.querySelector('#milestone-tooltip'));
 const a=boot('roadmap'),anchor=a.d.querySelector('[data-milestone="m2"]');a.A.milestoneHover({currentTarget:anchor},'m2',true);assert(a.d.querySelector('#milestone-tooltip'));a.A.milestoneClick({currentTarget:anchor},'m2');assert(a.d.querySelector('.modal').textContent.includes('Edit milestone'));assert(!a.d.querySelector('#milestone-tooltip'));
});

test('a delayed milestone hover shares its lifecycle with epic tooltips', (t) => {
const hover=boot('roadmap',{readOnly:true});hover.w.matchMedia=()=>({matches:true});
// The milestone tooltip opens after a hover delay.
t.mock.timers.enable({apis:['setTimeout']});
const milestoneAnchor=hover.d.querySelector('[data-milestone="m2"]');hover.A.milestoneHover({currentTarget:milestoneAnchor},'m2');assert(!hover.d.querySelector('#milestone-tooltip'));t.mock.timers.tick(250);assert(hover.d.querySelector('#milestone-tooltip'));const epicAnchor=hover.d.querySelector('[data-epic]');hover.A.epicHover({currentTarget:epicAnchor},epicAnchor.dataset.epic,true);assert(hover.d.querySelector('#epic-tooltip'));assert(!hover.d.querySelector('#milestone-tooltip'));assert(!milestoneAnchor.hasAttribute('aria-describedby'));
t.mock.timers.reset();
});

test('extreme calendar spans keep Roadmap cells bounded at every zoom and records editable', ctx => {
 const t=boot('roadmap',{prepare:D=>{D.epics[0].start='0000-01-01';D.milestones[0].date='9999-12-31';}});
 const bounded=zoom=>{const labels=t.d.querySelectorAll('.rm-month,.rm-week').length;assert(labels>0&&labels<100,`${labels} month or week labels at ${zoom}`);assert(t.d.querySelectorAll('.rm-axis-divider').length<200,`dividers at ${zoom}`);assert(t.d.querySelectorAll('.rm-month-line,.rm-week-line').length<200,`lines at ${zoom}`);};
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

test('a track\'s menu offers only Rename track and Delete track, and viewers get neither the menu nor the grip', () => {
  const t = bootApp({ route: 'roadmap', actions: true });
  t.d.querySelector('.lane[data-track="t3"] .kebab').click();
  assert.deepEqual([...t.d.querySelectorAll('#overlay-root > .menu button')].map(button => button.textContent.trim()), ['Rename track', 'Delete track']);
  const viewer = boot('roadmap', { readOnly: true });
  assert.equal(viewer.d.querySelectorAll('.lane[data-track]').length, 5);
  assert.equal(viewer.d.querySelector('.lane .grip, .lane .kebab'), null);
});

test('arrow keys, Home and End on a track\'s grip move the track, keep focus on its grip and say where it went', async () => {
  const t = withRuntime('roadmap', ['moveTrack']);
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
  const t = withRuntime('roadmap', ['moveTrack']), main = t.d.getElementById('main'), header = t.d.querySelector('.topbar');
  // The 1000 px wide Roadmap shows five 100 px lanes from 100 px down, scrolled 500 px into their 3000 px.
  t.w.Element.prototype.getBoundingClientRect = function () {
    const lanes = [...this.ownerDocument.querySelectorAll('.lane[data-track]')], index = lanes.indexOf(this);
    const [left, top, right, bottom] = this.id === 'rmScroll' ? [0, 0, 1000, 800] : index >= 0 ? [-500, 100 + index * 100, 2500, 200 + index * 100] : [0, 0, 0, 0];
    return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top };
  };
  const pointer = (type, target, x, y) => { const event = new t.w.Event(type, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y })) Object.defineProperty(event, key, { value }); target.dispatchEvent(event); };
  // Backend & API goes below the lower half of Mobile experience, the third lane.
  pointer('pointerdown', gripOf(t.d, 't1'), 20, 150); pointer('pointermove', t.d, 500, 380);
  const line = t.d.querySelector('.sort-marker');
  assert.deepEqual([line.hidden, line.style.left, line.style.width], [false, '0px', '1000px'], 'the line shows across the Roadmap, not past it');
  pointer('pointerup', t.d, 500, 380);
  assert.deepEqual(laneOrder(t.d), ['t2', 't3', 't1', 't4', 't5']);
  assert.equal(t.d.getElementById('main'), main); assert.equal(t.d.querySelector('.topbar'), header, 'only the Roadmap is drawn again');
  // The move comes from the page's window, so it compares as JSON.
  assert.equal(JSON.stringify(t.calls), JSON.stringify([['moveTrack', { trackId: 't1', position: 2, optimistic: true }]]));
  assert.ok(t.A.context().movePending);
  await saved(t);
  assert.equal(t.A.context().movePending, false);
  // Dropped below Mobile experience again, it stays where it is.
  pointer('pointerdown', gripOf(t.d, 't1'), 20, 350); pointer('pointermove', t.d, 500, 280); pointer('pointerup', t.d, 500, 280);
  assert.equal(t.calls.length, 1);
});

test('a track moved with the keyboard comes into view below the date axis, then slides there from where it showed', async () => {
  // Lay out 160 px lanes under a 90 px sticky axis in a 400 px tall Roadmap.
  const AXIS = 90, LANE = 160, VIEW = { top: 100, bottom: 500 };
  const t = withRuntime('roadmap', ['moveTrack'], { media: () => false });
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

/** The scale buttons in the Roadmap header, as label and pressed state. */
const scales = d => [...d.querySelectorAll('.roadmap-scale button')].map(button => [button.textContent, button.getAttribute('aria-pressed')]);
const pressed = name => ['Weeks', 'Months', 'Quarters'].map(label => [label, String(label === name)]);
/** A keydown on the focused element, such as a shortcut. */
const press = (w, key, init = {}) => { const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }); (w.document.activeElement || w.document.body).dispatchEvent(event); return event; };
/** Boot the Roadmap 1000 px wide, the size the anchors below are measured in. */
function wide(options = {}) {
  const t = bootApp({ route: 'roadmap', ...options });
  Object.defineProperty(t.d.getElementById('rmScroll'), 'clientWidth', { configurable: true, value: 1000 });
  return { ...t, ...timeline(t.d) };
}

test('the scale buttons zoom the Roadmap in place to weeks, months or quarters, and show which one it is at', t => {
  const r = wide(), bar = r.d.querySelector('[data-epic="e6"]');
  assert.deepEqual(scales(r.d), pressed('Months'), 'Months is the zoom a Roadmap opens at');
  r.A.setRoadmapScale('weeks');
  assert(Math.abs(r.barWidth('e6') - 39 * 30) <= 1, 'the 39-day epic is 30 px a day');
  assert.deepEqual(scales(r.d), pressed('Weeks'));
  assert.equal(r.d.getElementById('rmScroll'), r.sc); assert.equal(r.d.querySelector('[data-epic="e6"]'), bar, 'no rebuild');
  r.A.setRoadmapScale('quarters');
  assert(Math.abs(r.barWidth('e6') - 39 * 2.6) <= 1);
  assert.deepEqual(scales(r.d), pressed('Quarters'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  zoomWheel(r.w, r.sc); t.mock.timers.tick(150); t.mock.timers.reset();
  assert.deepEqual(scales(r.d), pressed(null), 'after a free zoom, no scale is on');
});

test('a scale change keeps today where it was', () => {
  const r = wide();
  r.A.goToday();
  const todayX = () => r.rail + parseFloat(r.d.querySelector('.today-pill').style.left) - r.sc.scrollLeft, before = todayX();
  for (const scale of ['weeks', 'months']) {
    r.A.setRoadmapScale(scale);
    assert(Math.abs(todayX() - before) <= 1, `${scale}: today stays at ${before} px`);
  }
});

test('a scale change keeps the selected epic in view: its middle when it fits, else its start', () => {
  const r = wide({ setup: w => {
    // Every epic bar shows in the middle of a 1000 × 800 px Roadmap.
    w.Element.prototype.getBoundingClientRect = function () {
      const box = this.id === 'rmScroll' ? [0, 0, 1000, 800] : this.dataset?.epic ? [400, 300, 600, 360] : [0, 0, 0, 0];
      return { left: box[0], top: box[1], right: box[2], bottom: box[3], x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] };
    };
  } });
  const startX = id => r.startX(id), middleX = id => r.startX(id) + r.barWidth(id) / 2;
  r.sc.scrollLeft += startX('e7') - 500;
  r.d.querySelector('[data-epic="e7"]').focus();
  const middle = middleX('e7');
  r.A.setRoadmapScale('weeks');
  assert(anchored(middleX('e7'), middle), 'the 20-day epic keeps its middle where it was');
  r.A.setRoadmapScale('months');
  r.sc.scrollLeft += startX('e6') - 300;
  r.d.querySelector('[data-epic="e6"]').focus();
  const start = startX('e6');
  r.A.setRoadmapScale('weeks');
  assert(anchored(startX('e6'), start), 'the 39-day epic is wider than the view, so its start stays');
});

test('W, M and Q switch the scale on the Roadmap, but not while typing, in a dialog, with a modifier or elsewhere', () => {
  const r = wide();
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
  r.d.querySelector('[data-epic]').focus();
  press(r.w, 'm'); assert.deepEqual(scales(r.d), pressed('Months'));
  // A click on empty lane space, or on a button in Safari, leaves focus on the page itself.
  r.d.activeElement.blur(); assert.equal(r.d.activeElement, r.d.body);
  press(r.w, 'w'); assert.deepEqual(scales(r.d), pressed('Weeks'), 'with focus on the page itself');
  assert.equal(r.d.querySelector('.roadmap-scale [data-scale="weeks"]').getAttribute('aria-keyshortcuts'), 'W');
  r.A.nav('board');
  assert.equal(press(r.w, 'w').defaultPrevented, false, 'only on the Roadmap');
});

test('at the Weeks scale the axis shows a line and a date for each week instead of month names', () => {
  const r = wide();
  r.A.setRoadmapScale('weeks');
  const weeks = [...r.d.querySelectorAll('.rm-month-grid .rm-week')].map(el => el.textContent);
  assert(weeks.length > 3); assert.equal(r.d.querySelectorAll('.rm-month').length, 0);
  assert(weeks.every(label => /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/.test(label)), weeks.join(' | '));
  assert(r.d.querySelectorAll('.rm-calendar-lines .rm-week-line').length > 3);
  r.A.setRoadmapScale('months');
  assert.equal(r.d.querySelectorAll('.rm-week,.rm-week-line').length, 0);
  assert(r.d.querySelectorAll('.rm-month').length > 0);
});

test('task counts still loading keep their placeholder through a scale change, and show at that scale when they arrive', () => {
  const r = wide({ prepare: D => Object.assign(D.epics.find(epic => epic.id === 'e6'), { counted: false, done: 0, total: 0 }) });
  const meta = () => r.d.querySelector('[data-epic="e6"] .m');
  r.A.setRoadmapScale('weeks');
  assert(meta().textContent.includes('Loading task counts'), 'the zoom moves the bar and keeps what it says');
  assert(!r.d.querySelector('[data-epic="e6"] .prog'));
  Object.assign(r.D.epics.find(epic => epic.id === 'e6'), { counted: true, done: 21, total: 34 });
  r.A.refreshRoadmap();
  assert.equal(meta().textContent.trim(), '21/34');
  assert(Math.abs(r.barWidth('e6') - 39 * 30) <= 1, 'the counts keep the Weeks zoom');
  assert.deepEqual(scales(r.d), pressed('Weeks'));
  assert(r.d.querySelectorAll('.rm-month-grid .rm-week').length > 3, 'and its week axis');
});

test('a scale change eases over a few frames, and a wheel zoom takes over where it is', () => {
  // Frames run when the test says, at the times it gives.
  const queue = new Map(); let next = 0;
  const r = wide({ media: () => false, setup: w => { w.requestAnimationFrame = callback => { queue.set(++next, callback); return next; }; w.cancelAnimationFrame = id => queue.delete(id); } });
  const frame = time => { const due = [...queue.values()]; queue.clear(); for (const callback of due) callback(time); };
  // The 39-day epic's width tells the zoom in pixels per day.
  const perDay = () => r.barWidth('e6') / 39;
  r.A.setRoadmapScale('weeks');
  assert(Math.abs(perDay() - 8.5) < 0.05, 'nothing moves before the first frame');
  frame(1000);
  const first = perDay();
  assert(first > 8.5 && first < 30, `the first frame is part of the way: ${first} px a day`);
  frame(1060);
  const second = perDay();
  assert(second > first && second < 30);
  zoomWheel(r.w, r.sc, { deltaY: 100 });
  frame(1120); frame(1400);
  assert(Math.abs(perDay() / (second / 1.15) - 1) < 0.02, 'the wheel zooms out from where the scale change was');
  assert.deepEqual(scales(r.d), pressed(null));
});

/** Go to another address with `move`, such as a link or Back, and wait until the page shows it. */
async function go(t, move) {
  const changed = new Promise(resolve => t.w.addEventListener('hashchange', resolve, { once: true }));
  move(); await changed; await settle();
}

test('a Roadmap address opens at the scale it names, Back shows each entry\'s scale, and a scale it lacks gives way to Months in place', async () => {
  const t = bootApp({ route: 'roadmap/p1?scale=weeks' });
  assert.deepEqual(scales(t.d), pressed('Weeks'));
  await go(t, () => { t.w.location.hash = '#/roadmap/p1?scale=quarters'; });
  assert.deepEqual(scales(t.d), pressed('Quarters'));
  await go(t, () => t.w.history.back());
  assert.equal(t.w.location.hash, '#/roadmap/p1?scale=weeks'); assert.deepEqual(scales(t.d), pressed('Weeks'));
  for (const scale of ['days', 'months']) {
    const other = bootApp({ route: `roadmap/p1?scale=${scale}` });
    assert.deepEqual(scales(other.d), pressed('Months'), scale);
    assert.equal(other.w.location.hash, '#/roadmap/p1', scale); assert.equal(other.w.history.length, 1, 'in place');
  }
});

test('a scale change rewrites the Roadmap address in place, and after a free zoom it names the nearest scale, which Back keeps', async t => {
  const r = wide();
  r.A.setRoadmapScale('quarters');
  assert.equal(r.w.location.hash, '#/roadmap/p1?scale=quarters');
  r.A.setRoadmapScale('weeks');
  assert.equal(r.w.location.hash, '#/roadmap/p1?scale=weeks'); assert.equal(r.w.history.length, 1);
  /** Zoom out by `notches` wheel notches, of 15% each. */
  const zoomOut = notches => { t.mock.timers.enable({ apis: ['setTimeout'] }); for (let i = 0; i < notches; i++) zoomWheel(r.w, r.d.getElementById('rmScroll'), { deltaY: 100 }); t.mock.timers.tick(150); t.mock.timers.reset(); };
  // 26 px a day is nearest Weeks.
  zoomOut(1);
  assert.deepEqual(scales(r.d), pressed(null)); assert.equal(r.w.location.hash, '#/roadmap/p1?scale=weeks');
  const width = r.barWidth('e6');
  await go(r, () => r.A.nav('board')); await go(r, () => r.w.history.back());
  assert.equal(r.barWidth('e6'), width, 'Back keeps the free zoom');
  // 15 px a day is nearest Months, which the address leaves out.
  zoomOut(4);
  assert.equal(r.w.location.hash, '#/roadmap/p1');
});

test('a sign-out on purpose forgets the Roadmap\'s scale, so the next person\'s Roadmap opens at Months', () => {
  const t = bootApp({ route: 'roadmap/p1' });
  t.A.setRoadmapScale('weeks');
  t.A.nav('board');
  t.A.clearAddress();
  // The next person signs in on the Board, then opens the Roadmap.
  t.A.resolveRoute(); t.A.nav('roadmap');
  assert.equal(t.w.location.hash, '#/roadmap/p1'); assert.deepEqual(scales(t.d), pressed('Months'));
});

test('the epic drawer names every status as the Roadmap does, and an ongoing epic shows both facts', () => {
  const t = boot();
  const epic = t.D.epics.find(item => t.D.tracks.find(track => track.id === item.trackId)?.projectId === t.A.context().projectId);
  const shown = [];
  for (const end of ['2026-12-31', null]) for (const state of ['planning', 'active', 'done']) {
    Object.assign(epic, { state, end });
    t.A.openPeek(epic.id);
    shown.push(t.d.querySelector('.peek .chip').textContent);
    t.A.closeOverlays();
  }
  assert.deepEqual(shown, ['Planning', 'In progress', 'Done', 'Ongoing · Planning', 'Ongoing · In progress', 'Ongoing · Done']);
});

test('the Roadmap header counts what its timeline shows, and shows no numbers while another project\'s Roadmap loads', () => {
  const t = boot('roadmap/p1'), stats = () => [...t.d.querySelectorAll('.topbar .roadmap-stat')].map(stat => stat.textContent);
  assert.deepEqual(stats(), ['Tracks5', 'Epics11', 'Milestones2']);
  // A live change adds an epic, and the read that follows draws the timeline again.
  const epic = t.D.epics.find(item => t.D.tracks.find(track => track.id === item.trackId).projectId === 'p1');
  t.D.epics.push({ ...epic, id: 'e-new', title: 'Added elsewhere' });
  t.A.refreshRoadmap();
  assert.deepEqual(stats(), ['Tracks5', 'Epics12', 'Milestones2']);
  // Back to the Roadmap of a project whose data isn't loaded yet.
  t.w.location.hash = '#/roadmap/p2';
  t.w.dispatchEvent(new t.w.HashChangeEvent('hashchange', { oldURL: 'http://localhost/#/roadmap/p1', newURL: t.w.location.href }));
  assert(t.d.querySelector('.loading-roadmap'));
  assert.deepEqual(stats(), ['Tracks', 'Epics', 'Milestones']);
  assert.equal(t.d.querySelector('.roadmap-structure-stats').getAttribute('aria-busy'), 'true');
  assert.equal(t.d.querySelector('.sidebar .nav-item[title="Board"] .end').textContent, '', 'the sidebar\'s Board count waits too');
  // Its data arrives.
  t.D.bootstrapProjectId = 'p2'; t.A.refresh();
  assert.equal(t.d.querySelectorAll('.topbar .roadmap-stat strong').length, 3);
  assert(!t.d.querySelector('.roadmap-structure-stats[aria-busy]'));
});
