// views/app.js: the Roadmap, its milestones, zoom and track moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('../../support/dom.cjs');

/** Boot the views; `prepare(D, w)` edits the projection before they load. */
const boot = (route = 'roadmap', { readOnly = false, stored, prepare } = {}) => bootApp({ route, stored, prepare: (D, w) => {
  prepare?.(D, w);
  if (readOnly) D.users.find(u => u.id === D.session.userId).admin = false;
} });

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
/** Boot with a runtime whose commands stay pending until the test settles them. */
function withRuntime(route) {
  const calls = [], reports = [], requests = [];
  const t = bootApp({ route, beforeScript: (name, w) => {
    if (name === 'app') w.OneloopRuntime = { invoke(action, payload) { calls.push([action, payload]); const request = deferred(); requests.push(request); return request.promise; }, report(error) { reports.push(error); } };
  } });
  return { ...t, calls, reports, requests };
}
const transfer = (type, id) => ({ types: [type], getData(value) { return value === type ? id : ''; }, setData() {}, effectAllowed: '', dropEffect: '' });

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
 const bounded=zoom=>{const months=t.d.querySelectorAll('.rm-month').length;assert(months>0&&months<100,`${months} month labels at ${zoom}`);assert(t.d.querySelectorAll('.rm-axis-divider').length<200,`dividers at ${zoom}`);};
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

test('a track move paints at once, sends one optimistic command and skips a no-op repeat', async () => {
  const t=withRuntime('roadmap'),ordered=()=>t.D.tracks.filter((item)=>item.projectId===t.D.projects[0].id).sort((left,right)=>left.order-right.order),before=ordered(),moved=before[0],target=before[1];
  t.A._drag={kind:'track',id:moved.id};t.A._laneBefore=false;
  t.A.trackDrop({preventDefault(){},dataTransfer:transfer('text/track',moved.id)},target.id);
  assert.equal(ordered()[1],moved);assert.equal(t.calls.length,1);assert.equal(t.calls[0][0],'track.reorder');assert.equal(t.calls[0][1].optimistic,true);assert.ok(t.A._roadmapMovePending);
  t.requests[0].resolve({});await tick();assert.equal(t.A._roadmapMovePending,false);

  const calls=t.calls.length;t.A._drag={kind:'track',id:moved.id};t.A._laneBefore=false;
  t.A.trackDrop({preventDefault(){},dataTransfer:transfer('text/track',moved.id)},target.id);
  assert.equal(t.calls.length,calls);
});

test('a track moved with the keyboard scrolls into view below the date axis', () => {
  // Lay out 160 px lanes under a 90 px sticky axis in a 400 px tall Roadmap.
  const AXIS = 90, LANE = 160, VIEW = { top: 100, bottom: 500 };
  const t = boot('roadmap', { prepare: (_D, w) => {
    const box = (top, height) => ({ x: 0, left: 0, right: 300, width: 300, y: top, top, bottom: top + height, height });
    w.Element.prototype.getBoundingClientRect = function () {
      if (this.id === 'rmScroll') return box(VIEW.top, VIEW.bottom - VIEW.top);
      const lane = this.closest?.('.lane[data-track]');
      if (!lane) return box(0, 0);
      const index = [...this.ownerDocument.querySelectorAll('.lane[data-track]')].indexOf(lane);
      return box(VIEW.top + AXIS + index * LANE - this.ownerDocument.getElementById('rmScroll').scrollTop, LANE);
    };
    Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('rm-axis') ? AXIS : 0; } });
  } });
  const view = () => {
    const grip = t.d.activeElement, head = grip.closest('.lane-head').getBoundingClientRect();
    return { grip: grip.classList.contains('grip'), below: head.top >= VIEW.top + AXIS, above: head.bottom <= VIEW.bottom };
  };
  const first = t.d.querySelector('.lane[data-track]').dataset.track, last = t.D.tracks.filter(track => track.projectId === t.A.context().projectId).length - 1;
  t.A.moveTrack(first, last);
  assert.deepEqual(view(), { grip: true, below: true, above: true }, 'moved to the bottom');
  t.A.moveTrack(first, 0);
  assert.deepEqual(view(), { grip: true, below: true, above: true }, 'moved back to the top');
});
