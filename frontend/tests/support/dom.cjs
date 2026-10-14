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
const { createCommandGateway } = require('../../src/data/command-gateway.js');
const { createLegacyData } = require('../../src/data/projection-store.js');
const { actionErrorFeedback, retryableFailure } = require('../../src/app/action-feedback.js');
const { createRuntimeHooks } = require('../../src/app/runtime-hooks.js');
const { setTrustedHTML } = require('../../src/app/trusted-types.js');
const { installViewActions } = require('../../src/app/view-actions.js');
const { installViewBridge } = require('../../src/app/view-bridge.js');
const { installCollaborationController } = require('../../src/features/collaboration/controller.js');

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
    // The views' one HTML sink, as src/app/boot.js sets it.
    this.window.OneloopSetHTML = setTrustedHTML;
    open.add(this);
  }
}

// The src modules run in Node and reach the page through these globals, so
// while a booted window is open they name that window's. A test may still
// assign one; the harness puts every global back after the test.
const WINDOW_GLOBALS = ['document', 'location', 'FormData', 'Event', 'HTMLElement', 'Collab', 'OneloopRecovery'];
const replacedGlobals = new Map();
function useWindowGlobals(w) {
  for (const name of WINDOW_GLOBALS) {
    if (!replacedGlobals.has(name)) replacedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true, enumerable: true,
      get: () => w[name],
      set: value => Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value }),
    });
  }
}
function restoreGlobals() {
  for (const [name, descriptor] of replacedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  replacedGlobals.clear();
}

afterEach(() => {
  restoreGlobals();
  const errors = [];
  for (const dom of open) { errors.push(...dom.errors); dom.window.close(); }
  open.clear();
  assert.deepEqual(errors, [], 'Unexpected errors in the view');
});

const files = new Map();
const read = file => { if (!files.has(file)) files.set(file, fs.readFileSync(file, 'utf8')); return files.get(file); };

/**
 * The sample projection, in the shape the projection store gives the views.
 * Timestamps move with the clock so Today, Yesterday and session ages stay stable.
 */
function dataScript() {
  return `window.DATA=${JSON.stringify({ ...createLegacyData(), ...JSON.parse(read(path.join(fixtures, 'fixture.json'))) })};(() => {
    const offset=Date.now()-DATA.session.authenticatedAt;
    const timestamps=new Set(['created','createdAt','authenticatedAt','lastActiveAt','authorizedAt','lastUsedAt','expiresAt','ts','uploadedAt','lastAccessAt','readAt','archivedAt','at']);
    function rebase(value){for(const [key,item] of Object.entries(value)){if(item&&typeof item==='object')rebase(item);else if(timestamps.has(key)&&typeof item==='number'&&item>1e12)value[key]=item+offset;}}
    rebase(DATA);
  })();`;
}

/**
 * The production recovery controller, adapted from its ES module into a
 * classic script, with the API, gateway and auth that the harness wired.
 */
function recoveryScript() {
  return '(function(){' + read(path.join(frontend, 'src/features/recovery/controller.js')).replace(/^import .*;$/mg, 'const ApiError=window.TestApiError;').replaceAll('export ', '')
    + '\nwindow.Recovery=window.OneloopRecovery=createRecoveryController({data:DATA,...window.TestWiring,getApp:()=>window.App,windowObject:window,documentObject:document,setTimer:window.setTimeout.bind(window),clearTimer:window.clearTimeout.bind(window)});})();';
}

/**
 * Source for one script: `data` (the sample projection), `recovery`,
 * `vendor/...` or a file in frontend/views, named without its extension.
 */
function source(name) {
  name = name.replace(/^\//, '').replace(/\.js$/, '');
  if (name === 'data') return dataScript();
  if (name === 'recovery') return recoveryScript();
  return read(path.join(frontend, name.startsWith('vendor/') ? `${name}.js` : `views/${name}.js`));
}

const previewLibraries = ['vendor/marked/marked', 'vendor/dompurify/purify', 'vendor/cdn-assets/highlight'];
/** The scripts the application loads, in order, with preview libraries already present. */
const appScripts = ['theme', 'data', 'motion', 'recovery', ...previewLibraries, 'file-views', 'uploads', 'collaboration', 'app'];

/** A stand-in for the browser's EventSource that the test drives with `emit`. */
function fakeEventSource(url) {
  const listeners = new Map();
  return {
    url, closed: false,
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    close() { this.closed = true; },
    /** Deliver an event, with `data` as its JSON payload. */
    emit(type, data = {}) { for (const listener of listeners.get(type) ?? []) listener({ type, data: JSON.stringify(data) }); },
  };
}

/**
 * Wire `w` as src/app/boot.js does, over a fake API. Every API call is
 * recorded in `calls` and waits until the test settles it; a command is also
 * recorded in `commands`, with its operation, payload and expected revision.
 * `api` answers some methods itself. Reads and bootstrap reloads find nothing
 * new: they succeed at once and repaint what they show, as the read
 * controller does, and are recorded in `reads.calls`.
 */
function wire(w, { api: answers = {}, reads: readAnswers = {}, auth: authAnswers = {}, reloadBootstrap = async () => ({ stale: false }) }) {
  const calls = [], commands = [], events = [];
  const held = method => (...args) => new Promise((resolve, reject) => {
    const call = { method, args, settled: false };
    call.resolve = value => { call.settled = true; resolve(value); };
    call.reject = error => { call.settled = true; reject(error); };
    calls.push(call);
    if (method === 'command') commands.push(Object.assign(call, args[0]));
    // A cancelled request fails at once, as the API client's does.
    const signal = args.find(arg => arg?.signal)?.signal;
    signal?.addEventListener('abort', () => call.reject(new ApiError('Request cancelled', { code: 'aborted' })), { once: true });
  });
  const api = new Proxy({ serverNow: () => w.Date.now(), ...answers }, {
    get: (target, name) => typeof name !== 'string' || name === 'then' || name in target ? target[name] : (target[name] = held(name)),
  });
  const readCalls = [], app = () => w.App;
  const repaint = {
    board: () => app().context().view === 'board' ? app().refreshBoard() : app().refreshCounts(),
    counts: () => app().refreshCounts(), roadmap: () => app().refreshRoadmap(),
    pool: () => app().refreshPool(), morePool: () => app().refreshPool(),
    epic: () => app().refreshEpic(), moreEpicTasks: () => app().refreshEpic(), moreEpicActivity: () => app().refreshEpic(),
    task() {}, moreBoard() {},
  };
  const reads = {
    calls: readCalls, cancel() {}, invalidateBoard() {}, idle: async () => {}, adoptBoard: () => false,
    ...Object.fromEntries(Object.entries(repaint).map(([name, paint]) => [name, async (...args) => { readCalls.push([name, ...args]); paint(); return { stale: false }; }])),
    ...readAnswers,
  };
  const data = w.DATA, auth = { withRecentAuth: run => run(), ...authAnswers };
  let runtime;
  const gateway = createCommandGateway({
    api, data,
    getScope: () => `${data.session?.userId ?? ''}:${data.session?.id ?? ''}`,
    onChange: result => runtime.publish({ type: 'command', result }),
    onPending: (key, pending) => w.Recovery?.interactionPending(key, pending),
  });
  runtime = createRuntimeHooks({ api, gateway, data, reload: reloadBootstrap });
  w.OneloopTransport = runtime;
  w.OneloopErrorMessage = (error, fallback = 'The request could not be completed.') => { const feedback = actionErrorFeedback(error); return feedback.silent ? '' : feedback.message || fallback; };
  w.OneloopRetryable = retryableFailure;
  w.OneloopCollaboration = installCollaborationController({ transport: runtime, visibility: w.document, eventSourceFactory: url => { const source = fakeEventSource(url); events.push(source); return source; } });
  w.TestWiring = { api, gateway, getAuth: () => auth, reload: reloadBootstrap };
  w.ONELOOP_DEFER_BOOT_RENDER = true;
  return {
    calls, commands, events, api, reads, gateway, auth, runtime,
    /** Answer every waiting call of the API's `method` with `value`. */
    answer(method, value) { for (const call of calls) if (call.method === method && !call.settled) call.resolve(value); },
    /** Install the view bridge and the runtime, then draw the first page. */
    start() {
      const bridge = installViewBridge({ app: w.App, data, gateway, auth, api, reads, recovery: w.Recovery, reloadBootstrap });
      w.OneloopRuntime = Object.freeze({ ...bridge, transport: runtime, now: api.serverNow });
      w.App.refresh();
      return bridge;
    },
  };
}

/**
 * Boot the view layer on the sample projection, wired as the app wires it:
 * the transport, the collaboration controller, the view bridge and the
 * runtime, over a fake API (see `wire`).
 *
 * @param {object} [options]
 * @param {string} [options.route] hash route, such as `board` or `task/BIR-079`
 * @param {string} [options.url] full URL, instead of `route`
 * @param {string} [options.html] initial document
 * @param {(query: string) => boolean} [options.media] matchMedia answers; reduced motion by default
 * @param {Record<string,string>} [options.stored] local storage entries set before boot
 * @param {string[]} [options.scripts] scripts to load, as `source` names
 * @param {boolean} [options.actions] run `data-action` attributes, as the app does; jsdom runs no handlers by itself
 * @param {Record<string,Function>} [options.api] API methods that answer by themselves
 * @param {Record<string,unknown>} [options.reads] read controller methods to replace
 * @param {Record<string,unknown>} [options.auth] auth controller methods to replace
 * @param {(scope?: object) => Promise<unknown>} [options.reloadBootstrap] the bootstrap reload
 * @param {(window: any) => void} [options.setup] runs before any script
 * @param {(data: any, window: any) => void} [options.prepare] runs after the fixture loads
 * @param {(name: string, window: any) => void} [options.beforeScript] runs before each script
 */
function bootApp({
  route = 'board', url, html = '<meta name="theme-color"><div id="app"></div>',
  media = query => query.includes('reduced-motion'), stored = {}, scripts = appScripts, actions = false,
  api, reads, auth, reloadBootstrap, setup, prepare, beforeScript,
} = {}) {
  const dom = new JSDOM(html, { url: url || `http://localhost/#/${route}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = query => ({ matches: media(query), addEventListener() {}, removeEventListener() {} });
  w.TextDecoder = TextDecoder;
  w.URL.createObjectURL = () => 'blob:test';
  w.URL.revokeObjectURL = () => {};
  for (const [key, value] of Object.entries(stored)) w.localStorage.setItem(key, value);
  useWindowGlobals(w);
  // Before any script, so actions run first on the document, as in the app.
  if (actions) installViewActions(w.document);
  setup?.(w);
  let wiring = null;
  for (const name of scripts) {
    beforeScript?.(name, w);
    w.eval(source(name));
    if (name !== 'data') continue;
    wiring = wire(w, { api, reads, auth, reloadBootstrap });
    prepare?.(w.DATA, w);
  }
  const bridge = wiring && w.App ? wiring.start() : null;
  return { dom, w, d: w.document, A: w.App, D: w.DATA, bridge, ...wiring };
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
