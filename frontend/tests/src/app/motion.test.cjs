// src/app/motion.js: interruptible motion, disclosure and reduced-motion behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, importModule, settle } = require('../../support/dom.cjs');

/** Import motion.js alone, with Element.animate recorded and finished by the test. */
function motion(html = '<div id="panel" hidden></div><div class="markdown-body"><details><summary>History</summary><article>Content</article></details></div>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  const state = { reduced: false, animations: [] };
  w.matchMedia = () => ({ matches: state.reduced });
  w.Element.prototype.animate = function (frames, options) {
    let resolve, reject;
    const finished = new Promise((a, b) => { resolve = a; reject = b; });
    const animation = { frames, options, finished, cancel() { reject(new Error('cancelled')); }, finish: resolve };
    state.animations.push(animation);
    return animation;
  };
  const { UIMotion, installDisclosures } = importModule(dom, 'src/app/motion.js');
  installDisclosures(w.document);
  return { w, d: w.document, state, UIMotion };
}

test('visibility motion can be interrupted and settles hidden or inert state', async () => {
  const { d, state, UIMotion } = motion();
  const panel = d.querySelector('#panel');
  panel.style.opacity = '1'; UIMotion.visibility(panel, true); assert(!panel.hidden);
  UIMotion.visibility(panel, false); assert(panel.inert);
  UIMotion.visibility(panel, true); state.animations.at(-1).finish(); await settle();
  assert(!panel.hidden); assert(!panel.inert); assert(!panel.hasAttribute('aria-hidden'));
  UIMotion.visibility(panel, false); state.animations.at(-1).finish(); await settle(); assert(panel.hidden);
});

test('removal disposes frames immediately and detaches after the exit', async () => {
  const { d, state, UIMotion } = motion();
  const layer = d.createElement('div'); layer.innerHTML = '<iframe></iframe>'; d.body.append(layer);
  UIMotion.remove(layer); assert(!layer.querySelector('iframe')); assert(layer.inert); assert.equal(layer.style.pointerEvents, 'none');
  state.animations.at(-1).finish(); await settle(); assert(!layer.isConnected);
});

test('disclosures reverse mid-motion and reduced motion skips animation', async () => {
  const { d, state, UIMotion } = motion();
  const panel = d.querySelector('#panel'), details = d.querySelector('details'), summary = details.querySelector('summary');
  summary.click(); assert(details.open); summary.click(); assert.equal(summary.getAttribute('aria-expanded'), 'false');
  summary.click(); state.animations.at(-1).finish(); await settle(); assert(details.open); assert(!details.querySelector('article').inert);
  summary.click(); state.animations.at(-1).finish(); await settle(); assert(!details.open);
  state.reduced = true; const count = state.animations.length;
  UIMotion.visibility(panel, true); UIMotion.visibility(panel, false); assert(panel.hidden);
  summary.click(); assert(details.open); summary.click(); assert(!details.open); assert.equal(state.animations.length, count);
});

test('fades never animate template content or disconnected nodes', () => {
  const { w, d, UIMotion } = motion('');
  let animations = 0;
  w.Element.prototype.animate = () => { animations++; return { finished: Promise.resolve() }; };
  const template = d.createElement('template'); template.innerHTML = '<div>inert</div>';
  assert.equal(UIMotion.fade(template.content.firstChild), null); assert.equal(UIMotion.fade(d.createElement('div')), null); assert.equal(animations, 0);
});

test('large lists skip per-row layout measurement and motion', () => {
  const { d, UIMotion } = motion('');
  const host = d.createElement('div');
  host.innerHTML = Array.from({ length: 150 }, (_, i) => `<div data-row="${i}"></div>`).join(''); d.body.append(host);
  let measured = 0, animated = 0;
  for (const el of host.children) {
    el.getBoundingClientRect = () => { measured++; return { top: 0, bottom: 10, height: 10 }; };
    el.animate = () => { animated++; return { finished: Promise.resolve(), cancel() {} }; };
  }
  const before = UIMotion.rows(host, '[data-row]', 'data-row'); UIMotion.reflow(host, '[data-row]', 'data-row', before);
  assert.equal(measured, 0); assert.equal(animated, 0);
});

test('a ghost keeps the look of its element but takes no input and has no IDs, names, data or handlers', () => {
  const { d, UIMotion } = motion('<div id="card" class="card" data-task="T-1" data-action="openTask" data-args="[1]" draggable="true"><button id="move" name="move" onclick="App.logout()" data-tip="Move" aria-label="Move T-1">Move</button></div>');
  const ghost = UIMotion.ghost(d.getElementById('card'));
  assert.equal(ghost.className, 'card'); assert(ghost.inert); assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  const left = [ghost, ...ghost.querySelectorAll('*')].flatMap(node => node.getAttributeNames().filter(name => ['id', 'name', 'draggable'].includes(name) || /^(?:on|data-)/.test(name)));
  assert.deepEqual(left, []);
  assert.equal(ghost.querySelector('button').getAttribute('aria-label'), 'Move T-1');
});
