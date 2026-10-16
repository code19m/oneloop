// src/features/files/preview.js: the file dialog, inline previews and PDFs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootApp, waitFor, settle } = require('../../../support/dom.cjs');

test('text file names match the server detection list', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../../../../..', file), 'utf8');
  const js = read('frontend/src/features/files/preview.js'), rust = read('src/files/detect.rs');
  const body = rust.slice(rust.indexOf('fn is_text_name('), rust.indexOf('fn is_text_name(') + 8000).split('\n}')[0];
  const ext = js.match(/textExtensions=new Set\('([^']+)'/)[1].split(' ');
  const names = [...js.match(/textNames=new Set\(\[(.*?)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(new Set([...body.matchAll(/"([^"]+)"/g)].map(match => match[1])), new Set([...ext, ...names]));
});

/**
 * Boot a task page, in a page at `url`, with `count` PDFs of `size` bytes,
 * whose PDF.js module and canvas are test doubles. `state.downloads` lists
 * the files read from the server.
 */
async function pdfPreview(url, { count = 1, size = 9 } = {}) {
  const state = { renders: 0, textReads: 0, fades: 0, documentOptions: null, downloads: [] }, observers = [];
  const page = { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render() { state.renders++; return { promise: Promise.resolve(), cancel() {} }; }, getTextContent() { state.textReads++; return Promise.resolve({ items: [] }); } };
  const pdfs = Array.from({ length: count }, (_, i) => ({ id: `pdf-${i}`, name: `test-${i}.pdf`, size, mediaType: 'application/pdf', previewKind: 'pdf', isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1, contentUrl: `/content/pdf-${i}`, downloadUrl: `/download/pdf-${i}` }));
  const pdfjs = { GlobalWorkerOptions: {}, getDocument: options => { state.documentOptions = options; return { promise: Promise.resolve({ numPages: 2, getPage: async () => page }), destroy: async () => {} }; } };
  const t = bootApp({
    url: url + '#/task/BIR-079', media: () => false,
    api: { attachments: async () => ({ items: pdfs }) },
    modules: { 'vendor/pdfjs/pdf.mjs': pdfjs },
    setup: w => {
      w.URL.createObjectURL = () => 'blob:pdf'; w.HTMLCanvasElement.prototype.getContext = () => ({});
      w.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe(el) { this.el = el; } disconnect() { this.stopped = true; } };
      w.fetch = async url => { state.downloads.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(size) }; };
    },
  });
  const { w, d } = t;
  t.module('src/app/motion.js').UIMotion.fade = el => { if (el?.tagName === 'CANVAS') state.fades++; };
  const task = w.DATA.tasks.find(item => item.id === 'BIR-079');
  await waitFor(() => task.attachments?.length, 'the PDF is listed');
  const open = (index = 0) => {
    w.App.previewAttachment(task.id, task.attachments[index].id);
    const host = d.querySelector('.file-preview-content'); Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    return host;
  };
  return { d, D: t.D, runtime: t.runtime, state, observers, open, pdfjs };
}

test('PDF previews load PDF.js and its assets from the app\'s files, also on a page in a folder', async () => {
  const { d, state, open, pdfjs } = await pdfPreview('http://localhost/x/y');
  open();
  await waitFor(() => state.fades === 1, 'the first page is painted');
  const root = 'http://localhost/vendor/pdfjs/';
  assert.equal(pdfjs.GlobalWorkerOptions.workerSrc, root + 'pdf.worker.mjs');
  assert.equal(state.documentOptions.standardFontDataUrl, root + 'standard_fonts/'); assert.equal(state.documentOptions.cMapUrl, root + 'cmaps/');
  assert.equal(state.renders, 1); assert.equal(state.textReads, 0); assert(!d.querySelector('.pdf-text-version'));
});

test('the PDF byte cache keeps the most recently shown files within its limit and forgets them all when the session changes', async () => {
  // A file counts twice, its bytes and their Blob, so two 12 MiB files fit in 64 MiB and a third pushes one out.
  const { d, D, runtime, state, open } = await pdfPreview('http://localhost/', { count: 3, size: 12 * 1024 * 1024 });
  const view = async index => { const fades = state.fades; open(index); await waitFor(() => state.fades > fades, 'the first page is painted'); d.querySelector('[data-file-close]').click(); };
  for (const index of [0, 1, 2]) await view(index);
  await view(2); await view(1);
  assert.deepEqual(state.downloads, ['/content/pdf-0', '/content/pdf-1', '/content/pdf-2'], 'two cached files show without a download');
  await view(0); await view(1);
  assert.deepEqual(state.downloads.slice(3), ['/content/pdf-0'], 'the least recently shown file, not the oldest download, left the cache');
  D.session = { ...D.session, id: 'next-session' }; runtime.publish({ type: 'auth' });
  await view(1);
  assert.equal(state.downloads.at(4), '/content/pdf-1', 'another session downloads the file again');
});

test('PDF previews redraw only on width changes, zoom and paging, and stop when closed', async t => {
  const { d, state, observers, open } = await pdfPreview('http://localhost/');
  // Width changes are debounced for 120 ms; drive the clock instead of sleeping.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async milliseconds => { t.mock.timers.tick(milliseconds); for (let i = 0; i < 5; i++) await settle(); };
  const host = open(); await advance(0);
  const observer = observers.find(o => o.el === host);
  assert.equal(state.renders, 1);
  // Initial and height-only resize callbacks keep the original canvas.
  const canvas = d.querySelector('.pdf-surface canvas'); observer.fn(); observer.fn(); await advance(150); assert.equal(state.renders, 1); assert.strictEqual(d.querySelector('.pdf-surface canvas'), canvas);
  d.querySelector('[data-pdf-fit]').click(); await advance(0); assert.equal(state.renders, 1);
  Object.defineProperty(host, 'clientWidth', { value: 620, configurable: true }); observer.fn(); observer.fn(); await advance(150); assert.equal(state.renders, 2); assert.equal(state.fades, 1);
  d.querySelector('[data-pdf-in]').click(); await advance(0); assert.equal(state.renders, 3); assert.equal(state.fades, 1);
  d.querySelector('[data-pdf-next]').click(); await advance(0); assert.equal(state.renders, 4); assert.equal(state.fades, 2); assert.equal(d.querySelector('[data-pdf-page]').textContent, 'Page 2 of 2');
  // A pending resize cannot redraw after closing or replace another preview.
  Object.defineProperty(host, 'clientWidth', { value: 500, configurable: true }); observer.fn(); d.querySelector('[data-file-close]').click(); await advance(150); assert.equal(state.renders, 4); assert(observer.stopped);
  open(); await advance(0); assert.equal(state.renders, 5);
  const retention = d.querySelector('[data-file-retention]');
  assert.equal(retention.parentElement, d.querySelector('[data-file-ephemeral]').parentElement); assert(retention.parentElement.querySelector('.retention-help')); assert(d.querySelector('.file-overlay > .retention-tooltip'));
  // Restore real timers before the harness closes the window, so it can clear
  // the real timers that were started before the clock was mocked.
  t.mock.timers.reset();
});

test('the file dialog shows the details it is given, and closes once its file can\'t be read', () => {
  const t = bootApp({ route: 'board' }), previews = t.module('src/features/files/preview.js');
  let readable = true;
  const file = { id: 'synced', name: 'setup.png', size: 12, previewKind: 'image', state: 'available', url: 'blob:synced', contentUrl: 'blob:synced', downloadUrl: '/download/setup.png' };
  previews.previewFile({ file, files: [file], details: '<dt>Path</dt><dd>docs/setup.png</dd>', canRead: () => readable, session: () => t.D.session, open: () => {} });
  const dialog = t.d.querySelector('.file-dialog');
  assert.equal(dialog.querySelector('.file-info dl').textContent, 'Pathdocs/setup.png');
  assert.equal(dialog.querySelector('[data-file-download]').getAttribute('href'), file.downloadUrl);
  assert(dialog.querySelector('.file-navigation').hidden, 'one file has no Previous and Next');
  previews.checkPreviewAccess();
  assert(t.d.querySelector('.file-overlay:not([data-motion-exiting]) .file-dialog'), 'a readable file stays');
  readable = false;
  previews.checkPreviewAccess();
  assert.equal(t.d.querySelector('.file-overlay:not([data-motion-exiting]) .file-dialog'), null, 'losing access closes it');
});

test('the file dialog closes when the session ends, whatever page opened it', () => {
  // As Knowledge's Full view does: no task page, and a file that stays readable while the page shows.
  const t = bootApp({ route: 'board' }), previews = t.module('src/features/files/preview.js');
  const file = { id: 'guide', name: 'guide.png', size: 12, previewKind: 'image', state: 'available', url: 'blob:guide', contentUrl: 'blob:guide', downloadUrl: '/download/guide.png' };
  previews.previewFile({ file, files: [file], details: '', canRead: () => true, session: () => t.D.session, open: () => {} });
  assert.equal(t.d.getElementById('app').inert, true);
  t.D.session = null; t.runtime.publish({ type: 'auth', session: null }); t.A.refresh();
  assert.equal(t.d.querySelector('.file-overlay:not([data-motion-exiting])'), null, 'the previous person\'s file is gone');
  assert.equal(t.d.getElementById('app').inert, false, 'the sign-in screen takes input');
});

test('inline image previews work outside the dialog and stop when disposed', async () => {
  const t = bootApp({ route: 'board' });
  const host = t.d.createElement('div'), tools = t.d.createElement('div');
  t.d.body.append(tools, host);
  const dispose = t.module('src/features/files/preview.js').mountInlinePreview(host, { id: 'inline-image', name: 'logo.png', size: 10, previewKind: 'image', url: 'blob:logo' }, tools, () => t.D.session);
  assert.equal(host.querySelector('img').getAttribute('src'), 'blob:logo');
  assert(tools.querySelector('.image-controls'), 'zoom controls move to the page header');
  assert.equal(t.d.querySelector('.file-dialog'), null);
  tools.querySelector('[data-image-in]').click();
  assert.equal(tools.querySelector('[data-image-out]').disabled, false);
  const stage = host.querySelector('.image-stage');
  const wheelZooms = () => { const event = new t.w.WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }); stage.dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(wheelZooms(), true, 'Ctrl and the wheel zoom the image');
  dispose();
  assert.equal(wheelZooms(), false, 'a disposed preview leaves the wheel to the page');
});
