// views/theme.js: the device's theme until someone picks Light or Dark.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('../support/dom.cjs');

/** A device setting the test can change, like a system switch to dark mode. */
function device(dark) {
  const listeners = new Set();
  const query = { get matches() { return dark; }, addEventListener(type, listener) { if (type === 'change') listeners.add(listener); }, removeEventListener(type, listener) { listeners.delete(listener); } };
  return { query, set(value) { dark = value; for (const listener of listeners) listener({ matches: dark }); } };
}

/** Load theme.js alone on a device that starts dark or light. */
function theme({ dark = false, stored = {} } = {}) {
  const system = device(dark);
  const t = bootApp({ scripts: ['theme'], stored, setup: w => { w.matchMedia = query => query === '(prefers-color-scheme: dark)' ? system.query : { matches: false, addEventListener() {}, removeEventListener() {} }; } });
  return { ...t, system, shown: () => t.d.documentElement.dataset.theme, color: () => t.d.querySelector('meta[name="theme-color"]').content };
}

test('a first visit shows the device theme and follows it when it changes', () => {
  const t = theme({ dark: true });
  assert.equal(t.shown(), 'dark'); assert.equal(t.color(), '#181818');
  assert.equal(t.w.Theme.choice, 'system');
  t.system.set(false);
  assert.equal(t.shown(), 'light'); assert.equal(t.color(), '#ffffff');
});

test('a picked theme wins over the device until System is picked again', () => {
  const t = theme({ dark: true, stored: { 'oneloop.theme': 'light' } });
  assert.equal(t.shown(), 'light');
  t.system.set(false); t.system.set(true);
  assert.equal(t.shown(), 'light', 'the device change does not override the choice');
  t.w.Theme.set('system');
  assert.equal(t.shown(), 'dark');
  assert.equal(t.w.localStorage.getItem('oneloop.theme'), null, 'System forgets the stored choice');
  t.w.Theme.set('dark'); t.system.set(false);
  assert.equal(t.shown(), 'dark'); assert.equal(t.w.localStorage.getItem('oneloop.theme'), 'dark');
});

test('a choice made in another tab applies here, and a removed one means System', () => {
  const t = theme({ dark: false });
  const storage = (newValue, key = 'oneloop.theme') => t.w.dispatchEvent(new t.w.StorageEvent('storage', { key, newValue }));
  storage('dark'); assert.equal(t.shown(), 'dark'); assert.equal(t.w.Theme.choice, 'dark');
  storage(null); assert.equal(t.shown(), 'light'); assert.equal(t.w.Theme.choice, 'system');
  storage('dark'); storage(null, null);
  assert.equal(t.w.Theme.choice, 'system', 'cleared storage means System');
});

test('the account menu offers Light, Dark and System and marks the choice', () => {
  const t = bootApp({ route: 'board' });
  t.A.userMenu({ currentTarget: t.d.querySelector('.me-chip') });
  const options = () => [...t.d.querySelectorAll('.theme-options [data-theme-option]')].map(button => [button.textContent, button.getAttribute('aria-pressed')]);
  assert.deepEqual(options(), [['Light', 'false'], ['Dark', 'false'], ['System', 'true']]);
  t.A.setTheme('dark');
  assert.deepEqual(options(), [['Light', 'false'], ['Dark', 'true'], ['System', 'false']]);
  assert.equal(t.d.documentElement.dataset.theme, 'dark');
});
