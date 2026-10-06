// Shared jsdom harness for the classic view scripts in frontend/views.
//
// Every window is strict: a page error or jsdom error fails the test that
// caused it, and the process exit code catches anything reported later. The
// harness closes every window after each test, so tests do not clean up.
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jsdom = require('jsdom');
const { ApiError } = require('../../src/data/api-client.js');
const { installViewActions } = require('../../src/app/view-actions.js');

const frontend = path.resolve(__dirname, '../..');
const fixtures = path.join(__dirname, 'fixtures');
const open = new Set();

class JSDOM extends jsdom.JSDOM {
  constructor(html, options = {}) {
    const virtualConsole = options.virtualConsole || new jsdom.VirtualConsole();
    const errors = [];
    virtualConsole.on('error', (...args) => { console.error(...args); errors.push(args.join(' ')); process.exitCode = 1; });
    virtualConsole.on('jsdomError', error => { console.error(error); errors.push(error.stack || String(error)); process.exitCode = 1; });
    super(html, { ...options, virtualConsole });
    this.errors = errors;
    this.window.TestApiError = ApiError;
    open.add(this);
  }
}

afterEach(() => {
  const errors = [];
  for (const dom of open) { errors.push(...dom.errors); dom.window.close(); }
  open.clear();
  assert.deepEqual(errors, [], 'Unexpected errors in the view');
});

const files = new Map();
const read = file => { if (!files.has(file)) files.set(file, fs.readFileSync(file, 'utf8')); return files.get(file); };

/** The sample projection. Timestamps move with the clock so Today, Yesterday and session ages stay stable. */
function dataScript(fixture = 'fixture') {
  return `window.DATA=${read(path.join(fixtures, `${fixture}.json`))};(() => {
    const offset=Date.now()-DATA.session.authenticatedAt;
    const timestamps=new Set(['created','createdAt','authenticatedAt','lastActiveAt','authorizedAt','lastUsedAt','expiresAt','ts','uploadedAt','lastAccessAt','readAt','archivedAt','at']);
    function rebase(value){for(const [key,item] of Object.entries(value)){if(item&&typeof item==='object')rebase(item);else if(timestamps.has(key)&&typeof item==='number'&&item>1e12)value[key]=item+offset;}}
    rebase(DATA);
  })();`;
}

/** The production recovery controller, adapted from its ES module into a classic script. */
function recoveryScript() {
  return '(function(){' + read(path.join(frontend, 'src/features/recovery/controller.js')).replace(/^import .*;$/mg, 'const ApiError=window.TestApiError;').replaceAll('export ', '')
    + '\nwindow.Recovery=createRecoveryController({data:DATA,api:{serverNow:()=>Date.now()/1000},gateway:{},getApp:()=>window.App,getAuth:()=>({withRecentAuth:run=>run()}),windowObject:window,documentObject:document,setTimer:window.setTimeout.bind(window),clearTimer:window.clearTimeout.bind(window)});})();';
}

/**
 * Source for one script: `data` (a fixture), `recovery`, `vendor/...` or a
 * file in frontend/views, named without its extension.
 */
function source(name, fixture) {
  name = name.replace(/^\//, '').replace(/\.js$/, '');
  if (name === 'data') return dataScript(fixture);
  if (name === 'recovery') return recoveryScript();
  return read(path.join(frontend, name.startsWith('vendor/') ? `${name}.js` : `views/${name}.js`));
}

const previewLibraries = ['vendor/marked/marked', 'vendor/dompurify/purify', 'vendor/cdn-assets/highlight'];
/** The scripts the application loads, in order, with preview libraries already present. */
const appScripts = ['theme', 'data', 'motion', 'vendor/js-sha256/sha256', 'activity', 'recovery', ...previewLibraries, 'file-views', 'uploads', 'collaboration', 'app'];

/**
 * Boot the view layer on the sample projection.
 *
 * @param {object} [options]
 * @param {string} [options.route] hash route, such as `board` or `task/BIR-079`
 * @param {string} [options.url] full URL, instead of `route` and `scenario`
 * @param {string} [options.scenario] `?scenario=` value; it also scopes local storage
 * @param {string} [options.fixture] fixture JSON in support/fixtures
 * @param {string} [options.html] initial document
 * @param {(query: string) => boolean} [options.media] matchMedia answers; reduced motion by default
 * @param {Record<string,string>} [options.stored] local storage entries set before boot
 * @param {string[]} [options.scripts] scripts to load, as `source` names
 * @param {boolean} [options.actions] run `data-action` attributes, as the app does; jsdom runs no handlers by itself
 * @param {(window: any) => void} [options.setup] runs before any script
 * @param {(data: any, window: any) => void} [options.prepare] runs after the fixture loads
 * @param {(name: string, window: any) => void} [options.beforeScript] runs before each script
 */
function bootApp({
  route = 'board', url, scenario = '', fixture, html = '<meta name="theme-color"><div id="app"></div>',
  media = query => query.includes('reduced-motion'), stored = {}, scripts = appScripts, actions = false, setup, prepare, beforeScript,
} = {}) {
  const dom = new JSDOM(html, { url: url || `http://localhost/${scenario ? `?scenario=${scenario}` : ''}#/${route}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = query => ({ matches: media(query), addEventListener() {}, removeEventListener() {} });
  w.TextDecoder = TextDecoder;
  w.URL.createObjectURL = () => 'blob:test';
  w.URL.revokeObjectURL = () => {};
  for (const [key, value] of Object.entries(stored)) w.localStorage.setItem(key, value);
  // Before any script, so actions run first on the document, as in the app.
  if (actions) installViewActions(w.document);
  setup?.(w);
  for (const name of scripts) {
    beforeScript?.(name, w);
    w.eval(source(name, fixture));
    if (name === 'data') prepare?.(w.DATA, w);
  }
  return { dom, w, d: w.document, A: w.App, D: w.DATA };
}

/** Poll `condition` on the event loop until it holds, then assert it. */
async function waitFor(condition, message = 'condition holds', timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), message);
}

/** Let pending microtasks and immediate callbacks run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

module.exports = { JSDOM, jsdom, source, bootApp, appScripts, previewLibraries, waitFor, settle, fixtures };
