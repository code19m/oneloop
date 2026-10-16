// Shared jsdom harness for frontend/views. It evaluates the classic scripts and
// imports the ES modules (Node's vm modules, so the test script turns on
// --experimental-vm-modules).
//
// Every window is strict: a page error or jsdom error fails the test that
// caused it, and the process exit code catches anything reported later. The
// harness closes every window after each test, so tests do not clean up.
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jsdom = require('jsdom');
const { ApiError } = require('../../src/data/api-client.js');
const { normalizeBoardFilters } = require('../../src/data/board-filters.js');
const { createCommandGateway } = require('../../src/data/command-gateway.js');
const { createLegacyData, sessionKey } = require('../../src/data/projection-store.js');
const { createRuntimeHooks } = require('../../src/app/runtime-hooks.js');
const { settle, waitFor, deferred, tick } = require('./helpers.cjs');
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
    open.add(this);
  }
}

// The src modules run in Node and reach the page through these globals, so
// while a booted window is open they name that window's. A test may still
// assign one; the harness puts every global back after the test.
const WINDOW_GLOBALS = ['document', 'location', 'FormData', 'Event', 'HTMLElement'];
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
  // The collaboration controller runs Node's timers, which closing a window leaves running.
  for (const dom of open) { dom.window.OneloopCollaboration?.dispose?.(); errors.push(...dom.errors); dom.window.close(); }
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
 * Source for one classic script: `data` (the sample projection), `vendor/...`
 * or a file in frontend/views, named without its extension.
 */
function source(name) {
  name = name.replace(/^\//, '').replace(/\.js$/, '');
  if (name === 'data') return dataScript();
  return read(path.join(frontend, name.startsWith('vendor/') ? `${name}.js` : `views/${name}.js`));
}

/** The views that are ES modules, which `load` imports; the others are classic scripts. */
const viewModules = new Set(['app']);

// Modules the window shares with the harness instead of loading its own, so
// that an error the harness makes is an instance of the window's ApiError.
const sharedModules = new Map([[path.join(frontend, 'src/data/api-client.js'), require('../../src/data/api-client.js')]]);

/**
 * Import `file`, an ES module, and the modules it imports into the window of
 * `dom`, as a browser does: each window has one instance of each module, at
 * the URL the server gives it. `dom.stubs` (paths in frontend/ to exports),
 * set before the first import, stand in for some modules. Returns the
 * module's exports.
 */
function importModule(dom, file) {
  file = path.resolve(frontend, file);
  dom.modules ??= new Map();
  const stubs = dom.stubs ?? {};
  const context = dom.getInternalVMContext(), loaded = dom.modules;
  const origin = dom.window.location.origin === 'null' ? 'http://localhost' : dom.window.location.origin;
  const urlOf = file => new URL(path.relative(frontend, file).split(path.sep).join('/'), `${origin}/`).href;
  const synthetic = (exports, identifier) => new vm.SyntheticModule(Object.keys(exports), function () { for (const name of Object.keys(exports)) this.setExport(name, exports[name]); }, { context, identifier });
  const link = file => {
    if (loaded.has(file)) return loaded.get(file);
    const stub = sharedModules.get(file) ?? stubs[path.relative(frontend, file)], identifier = urlOf(file);
    const module = stub ? synthetic(stub, identifier) : new vm.SourceTextModule(read(file), {
      context, identifier,
      initializeImportMeta: meta => { meta.url = identifier; },
      importModuleDynamically: async specifier => {
        const imported = link(path.join(frontend, decodeURIComponent(new URL(specifier, identifier).pathname)));
        if (imported.status === 'unlinked') imported.instantiate();
        await imported.evaluate();
        return imported;
      },
    });
    loaded.set(file, module);
    if (stub) return module;
    module.linkRequests(module.moduleRequests.map(({ specifier }) => link(path.resolve(path.dirname(file), specifier))));
    return module;
  };
  const module = link(file);
  if (module.status === 'unlinked') module.instantiate();
  // A module without top-level await runs now; a failure leaves it errored.
  module.evaluate().catch(() => {});
  if (module.status === 'errored') throw module.error;
  return module.namespace;
}

/** Run one script in the window of `dom`, by its `source` name, as the app loads it. */
function load(dom, name) {
  if (viewModules.has(name)) return importModule(dom, path.join(frontend, `views/${name}.js`));
  dom.window.eval(source(name));
}

/** The browser libraries that Markdown previews load on demand, already present. */
const previewLibraries = ['vendor/marked/marked', 'vendor/dompurify/purify', 'vendor/cdn-assets/highlight', 'vendor/marked-footnote/index', 'vendor/marked-alert/index'];

/** Knowledge, which view tests leave out: a page and sections with nothing in them. */
const knowledgeStub = () => ({ route: (_route, projectId) => projectId, render: () => '', topbar: () => '<h1>Knowledge base</h1>', beforeRender() {}, mount() {}, settingsHtml: () => '', modalHtml: () => '', clear() {} });

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
function wire(dom, { api: answers = {}, reads: readAnswers = {}, reloadBootstrap = async () => ({ stale: false }) }) {
  const w = dom.window;
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
    // A Board read loads the cards for its filters, which the sample projection already holds.
    board: (projectId, filters) => {
      w.DATA.boardPageInfo = { ...w.DATA.boardPageInfo, projectId, filters: normalizeBoardFilters(filters) };
      return app().context().view === 'board' ? app().refreshBoard() : app().refreshCounts();
    },
    counts: () => app().refreshCounts(), roadmap: () => app().refreshRoadmap(),
    pool: () => app().refreshPool(), morePool: () => app().refreshPool(),
    epic: () => app().refreshEpic(), moreEpicTasks: () => app().refreshEpic(), moreEpicActivity: () => app().refreshEpic(),
    task() {}, moreBoard() {},
  };
  const reads = {
    calls: readCalls, cancel() {}, invalidateBoard() {}, idle: async () => {}, adoptBoard: () => false,
    ...Object.fromEntries(Object.entries(repaint).map(([name, paint]) => [name, async (...args) => { readCalls.push([name, ...args]); paint(...args); return { stale: false }; }])),
    ...readAnswers,
  };
  // The tests end sessions themselves, so expiry leaves the projection alone.
  const data = w.DATA, auth = { withRecentAuth: run => run(), expire() {} };
  let runtime;
  const gateway = createCommandGateway({
    api, data,
    getScope: () => sessionKey(data),
    onChange: result => runtime.publish({ type: 'command', result }),
    onPending: (key, pending) => w.Recovery?.interactionPending(key, pending),
  });
  runtime = createRuntimeHooks({ api, gateway, data, reload: reloadBootstrap });
  const { createRecoveryController } = importModule(dom, 'src/features/recovery/controller.js');
  w.Recovery = createRecoveryController({ data, api, gateway, getApp: () => w.App, getAuth: () => auth, reload: reloadBootstrap, windowObject: w, documentObject: w.document, setTimer: w.setTimeout.bind(w), clearTimer: w.clearTimeout.bind(w) });
  w.OneloopCollaboration = installCollaborationController({ transport: runtime, recovery: w.Recovery, visibility: w.document, eventSourceFactory: url => { const source = fakeEventSource(url); events.push(source); return source; } });
  w.OneloopKnowledge = knowledgeStub();
  return {
    calls, commands, events, api, reads, gateway, runtime,
    /** Answer every waiting call of the API's `method` with `value`. */
    answer(method, value) { for (const call of calls) if (call.method === method && !call.settled) call.resolve(value); },
    /** Install the view bridge and the runtime, then draw the first page. */
    start() {
      w.Recovery.start();
      const bridge = installViewBridge({ app: w.App, data, gateway, auth, api, reads, recovery: w.Recovery, reloadBootstrap });
      w.OneloopRuntime = Object.freeze({ ...bridge, transport: runtime, now: api.serverNow });
      w.App.refresh();
      return bridge;
    },
  };
}

/**
 * Boot the app on the sample projection, wired as src/app/boot.js wires it:
 * the transport, the recovery and collaboration controllers, the view
 * bridge and the runtime, over a fake API (see `wire`), with a stand-in for
 * Knowledge.
 *
 * @param {object} [options]
 * @param {string} [options.route] hash route, such as `board` or `task/BIR-079`
 * @param {string} [options.url] full URL, instead of `route`
 * @param {string} [options.html] initial document
 * @param {(query: string) => boolean} [options.media] matchMedia answers; reduced motion by default
 * @param {Record<string,string>} [options.stored] local storage entries set before boot
 * @param {string[]} [options.libraries] preview libraries already on the page, as `source` names
 * @param {boolean} [options.actions] run `data-action` attributes, as the app does; jsdom runs no handlers by itself
 * @param {Record<string,Function>} [options.api] API methods that answer by themselves
 * @param {Record<string,unknown>} [options.reads] read controller methods to replace
 * @param {(scope?: object) => Promise<unknown>} [options.reloadBootstrap] the bootstrap reload
 * @param {boolean} [options.layout] give every element the same 300 by 500 pixel box, as jsdom lays nothing out
 * @param {Record<string,object>} [options.modules] exports that stand in for modules, by their path in frontend/
 * @param {(window: any) => void} [options.setup] runs before any script
 * @param {(data: any, window: any) => void} [options.prepare] runs after the fixture and the controllers load, before the views
 */
function bootApp({
  route = 'board', url, html = '<meta name="theme-color"><div id="app"></div>',
  media = query => query.includes('reduced-motion'), stored = {}, libraries = previewLibraries, actions = false,
  api, reads, reloadBootstrap, layout = false, modules, setup, prepare,
} = {}) {
  const dom = new JSDOM(html, { url: url || `http://localhost/#/${route}`, runScripts: 'outside-only', pretendToBeVisual: true });
  dom.stubs = modules;
  const w = dom.window;
  w.matchMedia = query => ({ matches: media(query), addEventListener() {}, removeEventListener() {} });
  w.TextDecoder = TextDecoder;
  w.URL.createObjectURL = () => 'blob:test';
  w.URL.revokeObjectURL = () => {};
  for (const [key, value] of Object.entries(stored)) w.localStorage.setItem(key, value);
  if (layout) w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 500, width: 300, height: 500 });
  useWindowGlobals(w);
  // Before any script, so actions run first on the document, as in the app.
  if (actions) installViewActions(w.document);
  setup?.(w);
  load(dom, 'theme');
  load(dom, 'data');
  const wiring = wire(dom, { api, reads, reloadBootstrap });
  importModule(dom, 'src/app/motion.js').installDisclosures(w.document);
  importModule(dom, 'src/features/files/preview.js').installPreviews(w.document, wiring.runtime);
  importModule(dom, 'src/app/save-shortcut.js').installSaveShortcut(w.document, w.Recovery);
  importModule(dom, 'src/features/checklist/checklist.js').installChecklistControls(w.document);
  prepare?.(w.DATA, w);
  for (const name of libraries) load(dom, name);
  load(dom, 'app');
  const bridge = wiring.start();
  return { dom, w, d: w.document, A: w.App, D: w.DATA, bridge, module: file => importModule(dom, file), ...wiring };
}

/**
 * Boot `route` with the runtime functions `held` replaced: each records its
 * call in `calls` and stays pending in `requests` until the test settles it.
 */
function withRuntime(route, held) {
  const calls = [], reports = [], requests = [];
  const t = bootApp({ route });
  const hold = name => (...args) => { calls.push([name, ...args]); const request = deferred(); requests.push(request); return request.promise; };
  t.w.OneloopRuntime = { ...t.w.OneloopRuntime, ...Object.fromEntries(held.map(name => [name, hold(name)])), report(error) { reports.push(error); } };
  return { ...t, calls, reports, requests };
}

/** The dataTransfer of a drag that carries `id` as `type`. */
const transfer = (type, id) => ({ types: [type], getData(value) { return value === type ? id : ''; }, setData() {}, effectAllowed: '', dropEffect: '' });

module.exports = { JSDOM, source, load, importModule, bootApp, withRuntime, transfer, previewLibraries, waitFor, settle, deferred, tick, fixtures };
