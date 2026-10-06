import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { actionEvents, installViewActions } from '../../../src/app/view-actions.js';
import { installViewBridge } from '../../../src/app/view-bridge.js';

const { JSDOM, bootApp } = createRequire(import.meta.url)('../../support/dom.cjs');

/** A page with actions installed, whose App and Recovery record each call. */
function page(html) {
  const dom = new JSDOM(`<main>${html}</main>`, { pretendToBeVisual: true });
  const w = dom.window, d = w.document, calls = [], errors = [];
  const record = (name, result) => function (...args) { calls.push([name, ...args]); return typeof result === 'function' ? result.apply(this, args) : result; };
  w.App = { count: 3, refuse: record('refuse', false), allow: record('allow', true), update: record('update'), open: record('open'), focused: record('focused'), left: record('left') };
  w.Recovery = { retryLoad: record('Recovery.retryLoad') };
  const remove = installViewActions(d, { onError: (error, element) => errors.push([error.name, element.id]) });
  const click = (element) => { const event = new w.MouseEvent('click', { bubbles: true, cancelable: true }); element.dispatchEvent(event); return event; };
  const key = (element, init) => { const event = new w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); element.dispatchEvent(event); return event; };
  return { w, d, calls, errors, remove, click, key, $: (id) => d.getElementById(id) };
}

test('placeholders stand for the event, the element, its value and its checked state', () => {
  const t = page(`<input id="name" value="Robin" data-action-input="update" data-args-input='["BIR-1",{"$":"value"},{"$":"event"},{"$":"element"},3,true,null,{"$":"unknown"},{"$":"value","x":1}]'>
    <input id="box" type="checkbox" checked data-action-change="update" data-args-change='[{"$":"checked"}]'>`);
  const input = new t.w.Event('input', { bubbles: true });
  t.$('name').dispatchEvent(input);
  t.$('box').dispatchEvent(new t.w.Event('change', { bubbles: true }));
  assert.deepEqual(t.calls, [
    ['update', 'BIR-1', 'Robin', input, t.$('name'), 3, true, null, { $: 'unknown' }, { $: 'value', x: 1 }],
    ['update', true],
  ]);
});

test('false from an action prevents the default, and nothing else does', () => {
  const t = page('<a id="refuse" href="#refused" data-action="refuse"></a><a id="allow" href="#allowed" data-action="allow"></a><form id="form" data-action-submit="refuse"></form>');
  assert.equal(t.click(t.$('refuse')).defaultPrevented, true);
  assert.equal(t.click(t.$('allow')).defaultPrevented, false);
  const submit = new t.w.Event('submit', { bubbles: true, cancelable: true });
  t.$('form').dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);
  assert.deepEqual(t.calls.map(([name]) => name), ['refuse', 'allow', 'refuse']);
});

test('with data-key, a keydown action runs only for that key, typed once and not mid-composition', () => {
  const t = page(`<input id="enter" data-key="Enter" data-action-keydown="update" data-args-keydown='["enter"]'>
    <input id="any" data-action-keydown="update" data-args-keydown='["any"]'>`);
  for (const init of [{ key: 'a' }, { key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Enter', repeat: true }]) t.key(t.$('enter'), init);
  assert.deepEqual(t.calls, []);
  t.key(t.$('enter'), { key: 'Enter' });
  t.key(t.$('any'), { key: 'a' });
  assert.deepEqual(t.calls, [['update', 'enter'], ['update', 'any']]);
});

test('nothing in rendered Markdown or a file preview runs, while the app around it still does', () => {
  const t = page(`<section id="outer" data-action="open" data-args='["outer"]'>
    <div class="markdown-body"><button id="planted" data-action="update" data-action-focus="update" data-action-mouseenter="update">Planted</button></div>
    <div class="file-preview-body"><a id="preview" href="#x" data-action="refuse" data-action-keydown="update">Preview</a></div></section>`);
  t.click(t.$('planted')); t.$('planted').focus();
  t.$('planted').dispatchEvent(new t.w.MouseEvent('mouseenter'));
  assert.equal(t.click(t.$('preview')).defaultPrevented, false);
  t.key(t.$('preview'), { key: 'Enter' });
  assert.deepEqual(t.calls, [['open', 'outer'], ['open', 'outer']]);
});

test('only existing methods of App and Recovery run, with their owner as this', () => {
  const names = ['missing', 'count', 'inherited', 'constructor', 'toString', 'hasOwnProperty', '__proto__', 'Other.open', 'window.open', 'Recovery.missing', 'Recovery.constructor', 'Recovery.retryLoad', 'open'];
  const t = page(names.map((name, i) => `<button id="b${i}" data-action="${name}">${i}</button>`).join(''));
  Object.setPrototypeOf(t.w.App, { inherited: () => t.calls.push(['inherited']) });
  t.w.App.open = function () { t.calls.push(['open', this === t.w.App]); };
  names.forEach((_name, i) => t.click(t.$(`b${i}`)));
  assert.deepEqual(t.calls, [['Recovery.retryLoad'], ['open', true]]);
});

test('actions run from the target out until one stops propagation, which also stops later listeners', () => {
  const t = page(`<div id="card" data-action="open" data-args='["card"]'><span id="title">Title</span>
    <button id="move" data-action="update" data-args='["move",{"$":"event"}]'>Move</button></div>`);
  const heard = [];
  t.d.addEventListener('click', () => heard.push('document'));
  t.w.addEventListener('click', () => heard.push('window'));
  t.click(t.$('title'));
  t.w.App.update = (name, event) => { t.calls.push([name]); event.stopPropagation(); };
  t.click(t.$('move'));
  assert.deepEqual(t.calls, [['open', 'card'], ['move']]);
  assert.deepEqual(heard, ['document', 'window'], 'a stopped click reaches no later listener');
  t.w.App.update = (name) => t.calls.push([name]);
  t.click(t.$('move'));
  assert.deepEqual(t.calls.slice(2), [['move'], ['open', 'card']], 'inner first, then outer');
});

test('during its call an action sees its element as event.currentTarget, and the event is restored after', () => {
  const t = page(`<button id="button" data-action="update" data-args='[{"$":"event"}]'><span id="label">Label</span></button>`);
  t.w.App.update = (event) => t.calls.push([event.currentTarget, event.target]);
  const event = t.click(t.$('label'));
  assert.deepEqual(t.calls, [[t.$('button'), t.$('label')]]);
  assert.equal(event.currentTarget, null);
  assert.equal(Object.hasOwn(event, 'currentTarget'), false);
});

test('focus, blur and hover actions run for their own element only', () => {
  const t = page(`<div id="outer" tabindex="-1" data-action-focus="focused" data-action-blur="left" data-action-mouseenter="focused" data-action-mouseleave="left" data-args-focus='["outer"]' data-args-mouseenter='["outer"]'>
    <button id="inner" data-action-focus="focused" data-action-blur="left" data-action-mouseenter="focused" data-action-mouseleave="left" data-args-focus='["inner",true]' data-args-mouseenter='["inner"]' data-args-blur='[{"$":"element"}]'>Inner</button></div>`);
  t.$('inner').focus(); t.$('inner').blur();
  t.$('inner').dispatchEvent(new t.w.MouseEvent('mouseenter')); t.$('inner').dispatchEvent(new t.w.MouseEvent('mouseleave'));
  t.$('outer').dispatchEvent(new t.w.MouseEvent('mouseenter'));
  assert.deepEqual(t.calls, [['focused', 'inner', true], ['left', t.$('inner')], ['focused', 'inner'], ['left'], ['focused', 'outer']]);
});

test('a clicked button, and a role=button that opens a dialog, have focus when their action runs', () => {
  const t = page('<button id="button" data-action="update">Button</button><div id="bar" role="button" tabindex="0" data-action="openPeek" data-args=\'["E1"]\'>Bar</div><div id="plain" tabindex="0" data-action="update">Plain</div>');
  const focused = [];
  t.w.App.update = () => focused.push(t.d.activeElement.id);
  t.w.App.openPeek = (id) => focused.push(`${t.d.activeElement.id} ${id}`);
  for (const id of ['button', 'bar', 'plain']) { t.d.activeElement.blur(); t.click(t.$(id)); }
  assert.deepEqual(focused, ['button', 'bar E1', '']);
});

test('a file input runs its change action once, also after a render removed it while its picker was open', async () => {
  const t = page('<div id="host"></div>');
  t.$('host').innerHTML = `<input id="file" type="file" data-action-change="update" data-args-change='[{"$":"element"}]'>`;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const input = t.$('file');
  input.dispatchEvent(new t.w.Event('change', { bubbles: true }));
  t.$('host').replaceChildren();
  input.dispatchEvent(new t.w.Event('change', { bubbles: true }));
  assert.deepEqual(t.calls, [['update', input], ['update', input]]);
});

test('arguments that are not a JSON array run nothing and are reported; removing stops all actions', () => {
  const t = page(`<button id="object" data-action="update" data-args='{"0":1}'>Object</button><button id="broken" data-action="update" data-args='["x"'>Broken</button><button id="fine" data-action="update">Fine</button>`);
  t.click(t.$('object')); t.click(t.$('broken'));
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.errors, [['TypeError', 'object'], ['SyntaxError', 'broken']]);
  t.remove(); t.click(t.$('fine'));
  assert.deepEqual(t.calls, []);
});

/** Every script and page in views/ and src/, as [path, source]. */
function appSources() {
  const frontend = new URL('../../../', import.meta.url);
  return ['views/', 'src/'].flatMap((folder) => readdirSync(new URL(folder, frontend), { recursive: true })
    .filter((name) => /\.(?:js|html)$/.test(name)).map((name) => [folder + name, readFileSync(new URL(folder + name, frontend), 'utf8')]));
}

test('no inline event handler is left in the app\'s markup', () => {
  const w = new JSDOM('').window;
  // The handler attributes browsers know, as lowercase names; camelCase names in code are no handlers.
  const names = new Set([w.HTMLElement.prototype, w.Document.prototype, w.Window.prototype, w.HTMLBodyElement.prototype].flatMap((prototype) => Object.getOwnPropertyNames(prototype)).filter((name) => /^on[a-z]+$/.test(name)));
  const handler = new RegExp(`(?<![\\w$.])(?:${[...names].join('|')}|onanimation[a-z]+|ontransition[a-z]+)\\s*=`, 'g');
  const found = appSources().flatMap(([file, source]) => [...source.matchAll(handler)].map((match) => `${file}: ${source.slice(match.index, match.index + 60)}`));
  assert.ok(names.has('onclick') && names.has('onkeydown'));
  assert.deepEqual(found, []);
});

test('every action in the app\'s markup answers an event that actions hear and names an existing method', () => {
  const actions = [], placeholders = [];
  for (const [file, source] of appSources()) {
    for (const [, method] of source.matchAll(/UIAction\(\s*'([^']*)'/g)) actions.push([file, 'click', method]);
    for (const [, type, method] of source.matchAll(/UIAction\.on\(\s*'([^']*)',\s*'([^']*)'/g)) actions.push([file, type, method]);
    for (const [, type, method] of source.matchAll(/data-action(?:-([a-z]+))?=["']([^"'$]*)["']/g)) actions.push([file, type ?? 'click', method]);
    for (const [, name] of source.matchAll(/UIAction\.(\w+)/g)) if (!['on', 'event', 'element', 'value', 'checked'].includes(name)) placeholders.push(`${file}: UIAction.${name}`);
  }
  assert.ok(actions.length > 150, `${actions.length} actions found`);
  assert.deepEqual(placeholders, []);
  // The views as the app runs them, with the production actions.
  const t = bootApp({ route: 'board' });
  installViewBridge({ app: t.A, data: t.D, api: {}, reads: { cancel() {} }, gateway: {}, auth: {}, recovery: {}, reloadBootstrap: async () => ({}) });
  const exists = (method) => method.startsWith('Recovery.') ? typeof t.w.Recovery[method.slice('Recovery.'.length)] === 'function' : Object.hasOwn(t.A, method) && typeof t.A[method] === 'function';
  assert.deepEqual(actions.filter(([, type, method]) => !actionEvents.includes(type) || !exists(method)), []);
});
