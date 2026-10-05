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

/** Dispatch one ctrl+wheel event on the Roadmap; a notch in by default. */
const zoomWheel = (w, sc, init = {}) => { const event = new w.WheelEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: 500, bubbles: true, cancelable: true, ...init }); sc.dispatchEvent(event); return event; };
/** What the zoom tests read from the mounted Roadmap. */
function timeline(d) {
  const sc = d.getElementById('rmScroll'), rail = parseFloat(d.querySelector('.lane-head').style.width), bar = id => d.querySelector(`[data-epic="${id}"]`);
  return {
    sc, rail,
    width: () => parseFloat(d.querySelector('.rm-canvas').style.width) - rail,
    barWidth: id => parseFloat(bar(id).style.width),
  };
}

test('ctrl-wheel zoom is scoped to the Roadmap and re-renders only its canvas after a pause', t => {
  const { w, d } = bootApp({ route: 'roadmap', media: () => true });
  const shell = d.querySelector('.sidebar'), sc = d.getElementById('rmScroll');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const event = new w.WheelEvent('wheel', { ctrlKey: true, deltaY: -10, clientX: 500, bubbles: true, cancelable: true });
  sc.dispatchEvent(event); sc.dispatchEvent(new w.WheelEvent('wheel', { ctrlKey: true, deltaY: -10, clientX: 500, bubbles: true, cancelable: true }));
  assert.equal(d.getElementById('rmScroll'), sc); assert(event.defaultPrevented);
  t.mock.timers.tick(180);
  t.mock.timers.reset();
  assert.notEqual(d.getElementById('rmScroll'), sc); assert.equal(d.querySelector('.sidebar'), shell); assert.equal(d.querySelector('.rm-canvas').style.willChange, '');
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

test('extreme calendar spans keep Roadmap cells bounded and records editable', () => {
 const t=boot('roadmap',{prepare:D=>{D.epics[0].start='0000-01-01';D.milestones[0].date='9999-12-31';}});
 assert(t.d.querySelectorAll('.rm-month').length > 0);
 assert(t.d.querySelectorAll('.rm-month').length < 100);
 assert(t.d.querySelectorAll('.rm-axis-divider').length < 200);
 const sc=t.d.querySelector('#rmScroll');
 sc.scrollLeft=0;sc.dispatchEvent(new t.w.Event('scroll'));
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
