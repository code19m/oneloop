// views/motion.js: interruptible motion, disclosure and reduced-motion behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, source, settle } = require('../support/dom.cjs');

/** Load motion.js alone, with Element.animate recorded and finished by the test. */
function motion(html = '<div id="panel" hidden></div><div class="markdown-body"><details><summary>History</summary><article>Content</article></details></div>') {
  const { window: w } = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const state = { reduced: false, animations: [] };
  w.matchMedia = () => ({ matches: state.reduced });
  w.Element.prototype.animate = function (frames, options) {
    let resolve, reject;
    const finished = new Promise((a, b) => { resolve = a; reject = b; });
    const animation = { frames, options, finished, cancel() { reject(new Error('cancelled')); }, finish: resolve };
    state.animations.push(animation);
    return animation;
  };
  w.eval(source('motion'));
  return { w, d: w.document, state };
}

test('visibility motion can be interrupted and settles hidden or inert state', async () => {
  const { w, d, state } = motion();
  const panel = d.querySelector('#panel');
  panel.style.opacity = '1'; w.UIMotion.visibility(panel, true); assert(!panel.hidden);
  w.UIMotion.visibility(panel, false); assert(panel.inert);
  w.UIMotion.visibility(panel, true); state.animations.at(-1).finish(); await settle();
  assert(!panel.hidden); assert(!panel.inert); assert(!panel.hasAttribute('aria-hidden'));
  w.UIMotion.visibility(panel, false); state.animations.at(-1).finish(); await settle(); assert(panel.hidden);
});

test('removal disposes frames immediately and detaches after the exit', async () => {
  const { w, d, state } = motion();
  const layer = d.createElement('div'); layer.innerHTML = '<iframe></iframe>'; d.body.append(layer);
  w.UIMotion.remove(layer); assert(!layer.querySelector('iframe')); assert(layer.inert); assert.equal(layer.style.pointerEvents, 'none');
  state.animations.at(-1).finish(); await settle(); assert(!layer.isConnected);
});

test('disclosures reverse mid-motion and reduced motion skips animation', async () => {
  const { w, d, state } = motion();
  const panel = d.querySelector('#panel'), details = d.querySelector('details'), summary = details.querySelector('summary');
  summary.click(); assert(details.open); summary.click(); assert.equal(summary.getAttribute('aria-expanded'), 'false');
  summary.click(); state.animations.at(-1).finish(); await settle(); assert(details.open); assert(!details.querySelector('article').inert);
  summary.click(); state.animations.at(-1).finish(); await settle(); assert(!details.open);
  state.reduced = true; const count = state.animations.length;
  w.UIMotion.visibility(panel, true); w.UIMotion.visibility(panel, false); assert(panel.hidden);
  summary.click(); assert(details.open); summary.click(); assert(!details.open); assert.equal(state.animations.length, count);
});

test('fades never animate template content or disconnected nodes', () => {
  const { w, d } = motion('');
  let animations = 0;
  w.Element.prototype.animate = () => { animations++; return { finished: Promise.resolve() }; };
  const template = d.createElement('template'); template.innerHTML = '<div>inert</div>';
  assert.equal(w.UIMotion.fade(template.content.firstChild), null); assert.equal(w.UIMotion.fade(d.createElement('div')), null); assert.equal(animations, 0);
});

test('large lists skip per-row layout measurement and motion', () => {
  const { w, d } = motion('');
  const host = d.createElement('div');
  host.innerHTML = Array.from({ length: 150 }, (_, i) => `<div data-row="${i}"></div>`).join(''); d.body.append(host);
  let measured = 0, animated = 0;
  for (const el of host.children) {
    el.getBoundingClientRect = () => { measured++; return { top: 0, bottom: 10, height: 10 }; };
    el.animate = () => { animated++; return { finished: Promise.resolve(), cancel() {} }; };
  }
  const before = w.UIMotion.rows(host, '[data-row]', 'data-row'); w.UIMotion.reflow(host, '[data-row]', 'data-row', before);
  assert.equal(measured, 0); assert.equal(animated, 0);
});
