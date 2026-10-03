import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { installKnowledgeController } from '../../../../src/features/knowledge/controller.js';

const { JSDOM } = createRequire(import.meta.url)('../../../support/dom.cjs');
const settle = () => new Promise((resolve) => setImmediate(resolve));

const handbook = () => ({
  state: 'ready', syncing: false, folder: 'docs', checkedAt: 1_700_000_000, skippedFiles: 0,
  files: [
    { path: 'README.md', size: 40, kind: 'markdown', updatedAt: 1_700_000_000, version: 'a1' },
    { path: 'guides/onboarding.md', size: 40, kind: 'markdown', updatedAt: 1_700_086_400, version: 'b2' },
    { path: 'guides/<img src=x onerror=alert(1)>.md', size: 4, kind: 'markdown', updatedAt: 1_699_000_000, version: 'c3' },
    { path: 'brand-kit.zip', size: 9, kind: null, updatedAt: 1_699_000_000, version: 'd4' },
  ],
});

/** A Knowledge page in jsdom with a scripted API, command runner and app shell. */
function fixture({ view = handbook(), admin = true, page = 'knowledge', route = 'knowledge' } = {}) {
  const dom = new JSDOM('<main id="main"></main><div id="overlay"></div>', { url: 'http://localhost/#/knowledge', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  const state = { context: { view: page, projectId: 'p1', modal: null }, toasts: [], fieldErrors: [], confirmations: [], closed: 0, requests: [], commands: [], markdown: [], view };
  const listeners = new Set();
  const api = {
    async request(path) {
      state.requests.push(path);
      if (path.includes('/knowledge/search')) return state.search ?? { files: [], documents: [], fileCount: 0, hitCount: 0 };
      return JSON.parse(JSON.stringify(state.view));
    },
  };
  const runtime = {
    api,
    data: { session: { userId: 'u1' }, users: [{ id: 'u1', admin }] },
    commands: { async execute(operation, payload, options) { state.commands.push([operation, payload, options]); if (state.failCommand) throw state.failCommand; return { entities: [state.commandEntity ?? {}], events: [], replayed: false }; } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  w.FileViews = {
    markdown(host, file, text, _truncated, context) { state.markdown.push({ file, text, context }); host.innerHTML = '<article class="markdown-body"><h1 id="md-handbook">Handbook</h1><h2 id="md-setup">Setup</h2></article>'; },
    text(host, _file, text) { host.textContent = text; },
    html(host) { host.textContent = 'html'; },
  };
  const app = {
    context: () => state.context,
    refresh: () => paint(),
    toast: (...args) => state.toasts.push(args),
    closeOverlays: () => { state.closed++; state.context.modal = null; d.getElementById('overlay').replaceChildren(); },
    confirm: (options) => state.confirmations.push(options),
    fieldError: (_form, name, message) => state.fieldErrors.push([name, message]),
  };
  const controller = installKnowledgeController({
    runtime, getApp: () => app, documentObject: d, windowObject: w,
    setTimer: (callback) => { state.timer = callback; return 1; }, clearTimer: () => { state.timer = null; },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('# Handbook\n\n## Setup\n').buffer }),
  });
  controller.route(route, 'p1');
  function paint() {
    controller.beforeRender();
    const main = d.getElementById('main');
    main.innerHTML = state.context.view === 'knowledge' ? controller.render('p1') : controller.settingsHtml('p1');
    controller.mount();
  }
  return { w, d, state, controller, listeners, paint };
}

async function painted(t) { t.paint(); await settle(); await settle(); }

test('a project without a source invites administrators to connect and members to ask', async () => {
  for (const admin of [true, false]) {
    const t = fixture({ admin, view: { state: 'unconnected', syncing: false, folder: null, checkedAt: null, skippedFiles: 0, files: [] } });
    await painted(t);
    assert.match(t.d.querySelector('.knowledge-empty h2').textContent, /A home for project knowledge/);
    const connect = t.d.querySelector('.knowledge-empty button');
    if (admin) assert.equal(connect.getAttribute('onclick'), "App.openModal('knowledge')");
    else { assert.equal(connect, null); assert.match(t.d.querySelector('.knowledge-badge').textContent, /Ask an admin/); }
    assert.equal(t.d.querySelector('.knowledge-search'), null, 'no search without files');
  }
});

test('a folder lists folders first with their newest dates and renders its README with Knowledge links', async () => {
  const t = fixture();
  await painted(t);
  const rows = [...t.d.querySelectorAll('.knowledge-file-list tbody tr')].map((row) => [row.querySelector('a > span:last-child').textContent, row.querySelector('time').textContent]);
  assert.deepEqual(rows, [['guides', '2023-11-15'], ['brand-kit.zip', '2023-11-03'], ['README.md', '2023-11-14']]);
  assert.equal(t.d.querySelector('.knowledge-breadcrumb').textContent, 'docs');
  assert.equal(t.d.querySelector('.knowledge-item-count').textContent, '3 items');
  const [rendered] = t.state.markdown;
  assert.equal(rendered.file.sourceUrl, '/api/projects/p1/knowledge/text?path=README.md');
  assert.equal(rendered.file.downloadUrl, '/api/projects/p1/knowledge/download?path=README.md');
  assert.equal(rendered.context.resolveLink('guides/onboarding.md#first-day'), '#/knowledge/p1/blob/guides/onboarding.md?section=first-day');
  assert.equal(rendered.context.resolveLink('../outside.md'), null);
  assert.equal(t.d.querySelector('[data-knowledge-action="copy-section"]').getAttribute('data-section'), 'setup');
});

test('file routes show one file, download-only formats and missing paths', async () => {
  const t = fixture({ route: 'knowledge/p1/blob/brand-kit.zip' });
  await painted(t);
  assert.equal(t.d.querySelector('.knowledge-file-title strong').textContent, 'brand-kit.zip');
  assert.equal(t.d.querySelector('[data-knowledge-action="full-view"]'), null, 'no full view for an unsupported format');
  assert.equal(t.d.querySelector('.knowledge-preview-actions a[download]').getAttribute('href'), '/api/projects/p1/knowledge/download?path=brand-kit.zip');
  assert.match(t.d.querySelector('.knowledge-preview-body').textContent, /not available for this format/);
  t.controller.route('knowledge/p1/blob/gone.md', 'p1');
  await painted(t);
  assert.match(t.d.querySelector('.knowledge-empty h2').textContent, /no longer here/);
});

test('search shows escaped names and sections, and Escape restores the page', async () => {
  const t = fixture();
  await painted(t);
  t.state.search = {
    files: [{ path: 'guides/<img src=x onerror=alert(1)>.md', folder: false }],
    documents: [{ path: 'guides/onboarding.md', total: 1, hits: [{ heading: 'First day', snippet: 'Meet the <team> on the first day.' }] }],
    fileCount: 1, hitCount: 1,
  };
  const input = t.d.querySelector('[data-knowledge-search]');
  input.focus();
  input.value = 'first';
  input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  t.state.timer();
  await settle();
  assert.ok(t.state.requests.some((path) => path === '/api/projects/p1/knowledge/search?q=first'));
  const finder = t.d.querySelector('.knowledge-finder');
  assert.equal(finder.querySelectorAll('img').length, 0, 'names are text');
  assert.deepEqual([...finder.querySelectorAll('.knowledge-scope button')].map((tab) => tab.textContent), ['All2', 'Files1', 'Content1']);
  const section = finder.querySelector('.knowledge-hit--text');
  assert.equal(section.getAttribute('href'), '#/knowledge/p1/blob/guides/onboarding.md?section=first-day');
  assert.equal(section.querySelector('mark').textContent, 'First');
  assert.match(section.querySelector('.knowledge-hit-snippet').innerHTML, /&lt;team&gt;/);
  input.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  assert.equal(t.d.querySelector('.knowledge-finder'), null);
  assert.ok(t.d.querySelector('.knowledge-file-list'));
});

test('a failed sync keeps the files under a banner, and only administrators retry', async () => {
  for (const admin of [true, false]) {
    const t = fixture({ admin, view: { ...handbook(), state: 'failed' } });
    await painted(t);
    const banner = t.d.querySelector('.knowledge-banner');
    assert.match(banner.textContent, /Knowledge may be out of date/);
    assert.ok(t.d.querySelector('.knowledge-file-list'));
    const retry = banner.querySelector('[data-knowledge-action="retry"]');
    assert.equal(!!retry, admin);
    if (!admin) continue;
    retry.click();
    await settle();
    assert.deepEqual(t.state.commands[0].slice(0, 2), ['knowledge.sync', { projectId: 'p1' }]);
  }
});

test('Settings reports the repository, its sync state and an actionable failure', async () => {
  const source = { repository: 'git.example.test/team/docs', url: 'https://git.example.test/team/docs.git', branch: 'main', folder: '', state: 'failed', syncing: false, checkedAt: 1_700_000_000, errorCode: 'auth_failed', hasToken: true, revision: 3 };
  const t = fixture({ page: 'settings', view: { ...handbook(), state: 'failed', source } });
  await painted(t);
  const row = t.d.querySelector('.knowledge-source-row');
  assert.equal(row.querySelector('b').textContent, 'git.example.test/team/docs');
  assert.equal(row.querySelector('.mono').textContent, 'main · /');
  assert.match(row.querySelector('.knowledge-source-status').textContent, /^Sync failed · last synced 2023-11-14 22:13$/);
  assert.match(row.querySelector('.knowledge-source-error').textContent, /refused the access token/);
  t.state.view = { ...t.state.view, state: 'ready', syncing: true, source: { ...source, state: 'ready', syncing: true, errorCode: null } };
  t.listeners.forEach((listener) => listener({ type: 'sse', kind: 'activity.changed', entityType: 'knowledge_source', projectId: 'p1' }));
  await settle(); await settle();
  assert.match(t.d.querySelector('.knowledge-source-status').textContent, /Syncing…/);
  assert.ok(t.state.timer, 'a running sync is polled');
});

test('the connection dialog sends the access the URL needs and keeps a saved token unless told otherwise', async () => {
  const t = fixture({ page: 'settings', view: { state: 'unconnected', syncing: false, folder: null, checkedAt: null, skippedFiles: 0, files: [] } });
  await painted(t);
  const open = () => { t.state.context.modal = { type: 'knowledge' }; t.d.getElementById('overlay').innerHTML = `<div class="modal">${t.controller.modalHtml()}</div>`; return t.d.querySelector('form[data-knowledge-form]'); };
  const submit = async (form) => { form.dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true })); await settle(); };
  let form = open();
  assert.equal(form.querySelector('h2, [type=submit]').textContent, 'Connect');
  form.elements.url.value = 'http://git.example.test/docs.git';
  await submit(form);
  assert.deepEqual(t.state.fieldErrors.at(-1), ['url', 'Enter an HTTPS or SSH Git URL.']);
  form.elements.url.value = 'https://git.example.test/docs.git';
  form.elements.token.value = 'secret-token';
  await submit(form);
  assert.deepEqual(t.state.commands.at(-1), ['knowledge.connect', { projectId: 'p1', url: 'https://git.example.test/docs.git', branch: 'main', folder: 'docs', token: 'secret-token' }, {}]);
  assert.equal(t.state.closed, 1);
  assert.equal(t.w.location.hash, '#/knowledge/p1/tree');

  t.state.view = { ...handbook(), source: { url: 'https://git.example.test/docs.git', repository: 'git.example.test/docs', branch: 'main', folder: 'docs', state: 'ready', hasToken: true, deployKey: null, revision: 4 } };
  t.state.context.view = 'settings';
  await painted(t);
  form = open();
  assert.match(form.querySelector('.knowledge-secret').textContent, /Token saved/);
  await submit(form);
  assert.equal(t.state.commands.length, 1, 'an unchanged form saves nothing');
  form = open();
  form.querySelector('[data-state="remove"]').click();
  assert.match(form.querySelector('[data-token-label]').textContent, /Token will be removed/);
  await submit(form);
  assert.deepEqual(t.state.commands.at(-1), ['knowledge.update', { projectId: 'p1', url: 'https://git.example.test/docs.git', branch: 'main', folder: 'docs', tokenAction: 'remove' }, { expectedRevision: 4 }]);
  form = open();
  form.querySelector('[data-state="replace"]').click();
  await submit(form);
  assert.deepEqual(t.state.fieldErrors.at(-1), ['token', 'Enter the new token.']);

  t.state.commandEntity = { publicKey: 'ssh-ed25519 AAAA oneloop' };
  form = open();
  form.elements.url.value = 'git@git.example.test:team/docs.git';
  form.elements.url.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  form.elements.url.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  await settle();
  assert.equal(form.querySelector('[data-access="https"]').hidden, true);
  assert.equal(form.querySelector('[data-access="ssh"]').hidden, false);
  assert.equal(form.querySelector('#knowledge-key').value, 'ssh-ed25519 AAAA oneloop');
  assert.equal(t.state.commands.filter(([operation]) => operation === 'knowledge.deploy-key.create').length, 1);
});

test('a public repository saves without a token, and a saved token never follows the URL to another host', async () => {
  const source = { url: 'https://git.example.test/docs.git', repository: 'git.example.test/docs', branch: 'main', folder: 'docs', state: 'ready', hasToken: false, deployKey: null, revision: 2 };
  const t = fixture({ page: 'settings', view: { ...handbook(), source } });
  await painted(t);
  const open = () => { t.state.context.modal = { type: 'knowledge' }; t.d.getElementById('overlay').innerHTML = `<div class="modal">${t.controller.modalHtml()}</div>`; return t.d.querySelector('form[data-knowledge-form]'); };
  const submit = async (form) => { form.dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true })); await settle(); };
  let form = open();
  await submit(form);
  assert.equal(t.state.commands.length, 0, 'an unchanged public connection saves nothing');
  form = open();
  form.elements.branch.value = 'release';
  await submit(form);
  assert.deepEqual(t.state.commands.at(-1), ['knowledge.update', { projectId: 'p1', url: 'https://git.example.test/docs.git', branch: 'release', folder: 'docs', tokenAction: 'keep' }, { expectedRevision: 2 }]);

  t.state.view = { ...handbook(), source: { ...source, hasToken: true, revision: 3 } };
  await painted(t);
  form = open();
  form.elements.url.value = 'https://git.example.test/team/handbook.git';
  await submit(form);
  assert.deepEqual(t.state.commands.at(-1)[1], { projectId: 'p1', url: 'https://git.example.test/team/handbook.git', branch: 'main', folder: 'docs', tokenAction: 'keep' }, 'the same host keeps the token');
  const sent = t.state.commands.length;
  form = open();
  form.elements.url.value = 'https://git.other.test/docs.git';
  await submit(form);
  assert.equal(t.state.commands.length, sent, 'nothing is sent with the old token');
  assert.deepEqual(t.state.fieldErrors.at(-1), ['token', 'The saved token is for the previous host. Enter a new token or remove it.']);
  assert.equal(form.elements.tokenAction.value, 'replace');
  assert.equal(form.querySelector('.knowledge-secret-edit').hidden, false);
  form.elements.token.value = 'other-token';
  await submit(form);
  assert.deepEqual(t.state.commands.at(-1)[1], { projectId: 'p1', url: 'https://git.other.test/docs.git', branch: 'main', folder: 'docs', tokenAction: 'replace', token: 'other-token' });
});

test('a reload while the dialog is open keeps what the administrator typed', async () => {
  const source = { url: 'https://git.example.test/docs.git', repository: 'git.example.test/docs', branch: 'main', folder: 'docs', state: 'ready', hasToken: false, deployKey: null, revision: 2 };
  const t = fixture({ page: 'settings', view: { ...handbook(), source } });
  await painted(t);
  t.state.context.modal = { type: 'knowledge' };
  t.d.getElementById('overlay').innerHTML = `<div class="modal">${t.controller.modalHtml()}</div>`;
  const form = t.d.querySelector('form[data-knowledge-form]');
  form.elements.url.value = 'git@git.example.test:team/docs.git';
  form.elements.branch.value = 'release';
  const row = t.d.querySelector('.knowledge-source-row');
  t.state.view = { ...t.state.view, source: { ...source, deployKey: 'ssh-ed25519 AAAA oneloop' } };
  t.listeners.forEach((listener) => listener({ type: 'sse', kind: 'activity.changed', entityType: 'knowledge_source', projectId: 'p1' }));
  await settle(); await settle();
  assert.equal(t.d.querySelector('form[data-knowledge-form]'), form, 'the dialog is not rebuilt');
  assert.equal(form.elements.branch.value, 'release');
  assert.equal(form.querySelector('#knowledge-key').value, 'ssh-ed25519 AAAA oneloop');
  assert.equal(t.d.querySelector('.knowledge-source-row'), row, 'the page waits until the dialog closes');
  t.state.context.modal = null;
  t.listeners.forEach((listener) => listener({ type: 'sse', kind: 'activity.changed', entityType: 'knowledge_source', projectId: 'p1' }));
  await settle(); await settle();
  assert.notEqual(t.d.querySelector('.knowledge-source-row'), row, 'the next read repaints the page');
});

test('server validation errors point at the field that needs a change', async () => {
  const t = fixture({ page: 'settings', view: { state: 'unconnected', syncing: false, folder: null, checkedAt: null, skippedFiles: 0, files: [] } });
  await painted(t);
  t.d.getElementById('overlay').innerHTML = `<div class="modal">${t.controller.modalHtml()}</div>`;
  const form = t.d.querySelector('form[data-knowledge-form]');
  form.elements.url.value = 'https://bot@git.example.test/docs.git';
  form.elements.branch.value = 'main';
  t.state.failCommand = Object.assign(new Error('invalid url'), { code: 'validation_failed', status: 400, details: { field: 'url', message: 'must not contain a password; use the access token field' } });
  form.dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(t.state.fieldErrors.at(-1), ['url', 'Put the password in Access token, not in the URL.']);
  assert.equal(t.state.closed, 0);
});

test('unchanged content keeps its rendered workspace when the app renders again', async () => {
  const t = fixture();
  await painted(t);
  const before = t.d.querySelector('.knowledge-workspace');
  await painted(t);
  assert.equal(t.d.querySelector('.knowledge-workspace'), before);
  assert.equal(t.state.markdown.length, 1, 'the README is not rendered twice');
  t.controller.route('knowledge/p1/tree/guides', 'p1');
  await painted(t);
  assert.notEqual(t.d.querySelector('.knowledge-workspace'), before);
});
