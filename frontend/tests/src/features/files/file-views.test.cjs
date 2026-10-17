// src/features/files/file-views.js and preview.js: Markdown, code, HTML and diagram previews.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, bootApp, importModule, source, previewLibraries, waitFor, settle, fixtures } = require('../../../support/dom.cjs');

const libraries = [...previewLibraries, 'vendor/katex/katex.min', 'vendor/marked-katex-extension/index'];
// KaTeX refuses to render in quirks mode.
const boot = options => { const t = bootApp({ route: 'task/BIR-079', libraries, html: '<!doctype html><meta name="theme-color"><div id="app"></div>', ...options }); return { ...t, views: t.module('src/features/files/file-views.js') }; };

const readme = ['# Review', '', '## Notes', '## Notes', '', '**bold** and ~~old~~', '', '- [x] Ready', '- [ ] Later', '', '| A | B |', '| - | - |', '| 1 | 2 |', '', '```js', 'const total = 2; // <script>bad()</script>', '```', '', '<details><summary>More</summary>Details</details>', '', '[Jump](#notes)', '[Docs](https://example.invalid/docs)', '[Relative](./other.md)', '[Unsafe](javascript:alert(1))', '![Remote](https://example.invalid/image.png)', '', '<script>window.evil=true</script><img src="x" onerror="evil()"><input name="App"><style>body{display:none}</style>'].join('\n');
const report = '<h1>Report</h1><link rel="stylesheet" href="https://example.invalid/style.css"><script src="https://example.invalid/code.js"></script><img src="https://example.invalid/pic.png" onerror="alert(1)"><iframe src="https://example.invalid/frame"></iframe><form action="https://example.invalid"><button>Go</button></form>';

/**
 * Boot a task page whose server lists one file of each kind the previews
 * handle, with `extra` files; `fetch` gives each file's text.
 */
async function taskWithFiles(extra = []) {
  const files = [['README.md', 'markdown', readme], ['broken.json', 'text', '{"broken":'], ['source.ts', 'text', '<script>alert(1)</script>'], ['Dockerfile', 'text', 'FROM scratch'], ['release.zip', null, ''], ['broken.png', null, 'corrupt'], ['binary.txt', null, ''], ['report.html', 'html', report], ...extra];
  const record = ([name, previewKind, text], index) => ({ id: `file-${index}`, name, size: text.length, mediaType: 'application/octet-stream', previewKind, isEphemeral: false, uploadedBy: 'taylorwu', uploadedAt: 1, lastAccessedAt: 1, state: 'available', revision: 1, contentUrl: `/content/${index}`, sourceUrl: `/source/${index}`, downloadUrl: `/download/${index}` });
  const t = boot({ api: { attachments: async () => ({ items: files.map(record) }) }, setup: w => { w.fetch = async url => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(files[Number(String(url).split('/').at(-1))][2]).buffer }); } });
  const { w, d } = t;
  const task = w.DATA.tasks.find(item => item.id === 'BIR-079');
  await waitFor(() => task.attachments?.length === files.length, 'the server lists every file');
  const file = name => task.attachments.find(f => f.name === name);
  return { ...t, task, file, open: name => w.App.previewAttachment(task.id, file(name).id), close: () => d.querySelector('[data-file-close]').click() };
}

test('files the server cannot preview are download only', async () => {
  const { d, file } = await taskWithFiles();
  for (const name of ['release.zip', 'broken.png', 'binary.txt']) { assert(d.querySelector(`[data-attachment-id="${file(name).id}"] .attachment-meta`).textContent.includes('Download only')); }
});

test('the preview sequence spans every previewable format and keeps its shell', async () => {
  const { d, task, open, close } = await taskWithFiles();
  // Download-only and cleaned records are skipped.
  task.attachments.push({ id: 'cleaned-test', name: 'old.txt', previewKind: 'text', state: 'cleaned' });
  open('README.md'); assert.equal(d.querySelector('[data-file-position]').textContent, 'File 1 of 5'); assert(d.querySelector('[data-file-prev]').disabled);
  const shell = d.querySelector('.file-dialog'), scrim = d.querySelector('.file-overlay>.scrim'); d.querySelector('[data-file-details]').click();
  for (const name of ['broken.json', 'source.ts', 'Dockerfile', 'report.html']) {
    d.querySelector('[data-file-next]').click(); assert.equal(d.querySelector('#file-preview-title').textContent, name);
    assert.strictEqual(d.querySelector('.file-dialog'), shell); assert.strictEqual(d.querySelector('.file-overlay>.scrim'), scrim); assert.equal(d.querySelector('[data-file-details]').getAttribute('aria-expanded'), 'true');
  }
  assert(d.querySelector('[data-file-next]').disabled); d.querySelector('[data-file-prev]').click(); assert.equal(d.querySelector('#file-preview-title').textContent, 'Dockerfile'); assert(!d.querySelector('iframe')); close();
});

test('code and data previews stay escaped text', async () => {
  const { d, open, close } = await taskWithFiles(), text = () => d.querySelector('.file-preview-content pre')?.textContent;
  open('source.ts'); await waitFor(() => text(), 'the code loads'); assert.equal(text(), '<script>alert(1)</script>'); assert(!d.querySelector('.file-preview-content script')); close();
  open('broken.json'); await waitFor(() => text(), 'the data loads'); assert.equal(text(), '{"broken":'); close();
});

test('Markdown renders GitHub-flavored content safely and offers its source', async () => {
  const { d, open, close } = await taskWithFiles();
  open('README.md');
  await waitFor(() => d.querySelector('.markdown-body'), 'the Markdown renders');
  const article = d.querySelector('.markdown-body');
  assert(article.querySelector('h1')); assert(article.querySelector('table')); assert(article.querySelector('del')); assert(article.querySelector('details summary'));
  assert.equal(article.querySelectorAll('input[type=checkbox]:disabled').length, 2); assert(article.querySelector('code .hljs-keyword')); assert(article.querySelector('#md-notes-1'));
  assert(!article.querySelector('script,style,iframe,[name],[onerror]')); assert(!article.querySelector('a[href^="javascript:"]'));
  assert(article.querySelector('a[href="https://example.invalid/docs"]').rel.includes('noopener')); assert(article.querySelector('a[href="#md-notes"]'));
  d.querySelector('[data-view-source]').click(); assert(d.querySelector('.document-preview').hidden); assert.equal(d.querySelector('.html-source').textContent, readme);
  d.querySelector('[data-view-preview]').click(); assert(!d.querySelector('.document-preview').hidden);
  assert(d.querySelector('.markdown-body img[src="https://example.invalid/image.png"]')); assert(!d.querySelector('[data-view-resources]')); close();
});

test('Markdown can\'t point a label or a control at the app\'s own elements', async () => {
  const { d, views } = boot();
  const control = d.createElement('input'); control.type = 'checkbox'; control.id = 'app-control'; d.body.append(control);
  const clicks = []; control.addEventListener('click', () => clicks.push('app control'));
  const host = d.createElement('div'); d.body.append(host);
  views.markdownView(host, { name: 'gadget.md' }, '<label for="app-control">Open the picker</label>\n\n<input type="checkbox" form="app-form" popovertarget="app-menu" commandfor="app-menu" command="show-popover">', false);
  await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
  const body = host.querySelector('.markdown-body');
  assert.equal(body.querySelector('[for],[form],[popovertarget],[commandfor],[command]'), null);
  body.querySelector('label').click();
  assert.deepEqual(clicks, [], 'the label reaches nothing outside the file');
});

test('HTML previews frame the server preview in a sandbox and restart it', async () => {
  const { d, file, open, close } = await taskWithFiles();
  file('report.html').htmlPreviewUrl = '/api/attachments/report/preview/html';
  open('report.html');
  await waitFor(() => d.querySelector('iframe'), 'the preview loads');
  let frame = d.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), ''); assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(new URL(frame.src).pathname, '/api/attachments/report/preview/html'); assert(!frame.hasAttribute('srcdoc'));
  d.querySelector('[data-html-restart]').click(); assert(!frame.isConnected); frame = d.querySelector('iframe'); assert.equal(new URL(frame.src).pathname, '/api/attachments/report/preview/html');
  d.querySelector('[data-view-source]').click(); assert(!frame.isConnected); assert(!d.querySelector('.document-preview iframe')); assert(d.querySelector('[data-html-restart]').hidden);
  d.querySelector('[data-view-preview]').click(); assert(d.querySelector('.document-preview iframe')); assert(!d.querySelector('[data-html-restart]').hidden); close();
});

test('large Markdown previews are bounded in both modes', async () => {
  const { d, open, close } = await taskWithFiles([['large.markdown', 'markdown', '# Large\n\n' + 'word '.repeat(50000)]]);
  open('large.markdown'); await waitFor(() => d.querySelector('.file-preview-content .access-note')?.textContent.includes('truncated'), 'the preview says it is cut');
  assert(d.querySelector('.html-source').textContent.length <= 200000); close();
});

test('math, alerts and footnotes render and footnote links move focus', async () => {
  const { w, d, views } = boot();
  const extras = d.createElement('div'); d.body.append(extras);
  const sample = fs.readFileSync(path.join(fixtures, 'math.md'), 'utf8');
  views.markdownView(extras, { name: 'extras.md' }, sample, false);
  await waitFor(() => extras.querySelector('.markdown-body'), 'Markdown renders');
  assert.equal(extras.querySelectorAll('.katex').length, 5); assert.equal(extras.querySelectorAll('math').length, 5); assert.equal(extras.querySelectorAll('.markdown-alert').length, 5);
  assert.equal(extras.querySelectorAll('.markdown-alert-title svg').length, 5); assert.equal(extras.querySelectorAll('.footnotes li').length, 2);
  const refs = [...extras.querySelectorAll('sup a')]; assert.equal(refs.length, 2);
  for (const ref of refs) assert(extras.querySelector(ref.getAttribute('href')));
  const back = extras.querySelector('.footnotes a'); assert(extras.querySelector(back.getAttribute('href')));
  // jsdom lays nothing out, so it has no scrollIntoView.
  let shown = null; w.Element.prototype.scrollIntoView = function () { shown = this; };
  refs[0].click(); assert.equal(shown?.id, refs[0].getAttribute('href').slice(1)); assert.equal(d.activeElement, shown);
  assert.equal(extras.querySelector('.html-source').textContent, sample);
  extras.querySelector('[data-view-source]').click(); assert.equal(extras.querySelector('.html-source').textContent, sample);
});

test('Markdown anchors stay unique when literal suffixes collide with repeated headings', async () => {
  const { d, views } = boot();
  for (const [text, expected] of [
    ['## Setup\n\n## Setup\n\n## Setup-1\n\n## md-setup\n', ['md-setup', 'md-setup-1', 'md-setup-1-1', 'md-md-setup']],
    ['## Setup-1\n\n## Setup\n\n## Setup\n', ['md-setup-1', 'md-setup', 'md-setup-2']],
  ]) {
    const host = d.createElement('div'); d.body.append(host);
    views.markdownView(host, { name: 'anchors.md' }, text, false);
    await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
    assert.deepEqual([...host.querySelectorAll('.markdown-body h2')].map(heading => heading.id), expected);
    host.remove();
  }
});

test('heading ids match the anchors the server gives search hits and MCP sections', async () => {
  const { d, views } = boot();
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'heading-anchors.json'), 'utf8'));
  const host = d.createElement('div'); d.body.append(host);
  views.markdownView(host, { name: 'guide.md' }, fixture.source, false);
  await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
  assert.deepEqual([...host.querySelectorAll('.markdown-body :is(h1,h2,h3,h4,h5,h6)')].map(heading => heading.id), fixture.ids);
  assert.equal(host.querySelectorAll('[data-md-heading]').length, 0);
});

test('a spoofed heading marker in uploaded HTML gives no server anchor', async () => {
  const { d, views } = boot();
  const host = d.createElement('div'); d.body.append(host);
  views.markdownView(host, { name: 'spoof.md' }, '<h2 data-md-heading="x-0">Fake</h2>\n\n## Setup\n', false);
  await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
  assert.deepEqual([...host.querySelectorAll('.markdown-body h2')].map(heading => heading.id), ['md-fake', 'md-setup']);
});

test('in-page links reach headings in any script', async () => {
  const { w, d, views } = boot();
  const host = d.createElement('div'); d.body.append(host);
  views.markdownView(host, { name: 'ru.md' }, '[Оплата и сроки](#оплата-и-сроки)\n\n## Оплата и сроки\n\nТекст.\n', false);
  await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
  const link = host.querySelector('.markdown-body a');
  assert.equal(link.getAttribute('href'), '#md-оплата-и-сроки');
  // jsdom lays nothing out, so it has no scrollIntoView.
  w.Element.prototype.scrollIntoView = () => {};
  link.click();
  assert.equal(d.activeElement, host.querySelector('#md-оплата-и-сроки'));
});

test('each Markdown block takes its direction from its own text, as Knowledge pages and attachment previews show it', async () => {
  const { d, views } = boot();
  const host = d.createElement('div'); d.body.append(host);
  views.markdownView(host, { name: 'دليل.md' }, '# دليل الفريق\n\nهذه فقرة عربية.\n\n- البند الأول\n- البند الثاني\n\n> اقتباس\n\n| العمود | Column |\n| - | - |\n| ١ | 1 |\n\n<p dir="ltr">Kept as written.</p>\n\n```js\nconst code = 1;\n```', false);
  await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
  const body = host.querySelector('.markdown-body');
  for (const selector of ['h1', 'p', 'ul', 'blockquote p', 'table']) assert.equal(body.querySelector(selector).getAttribute('dir'), 'auto', selector);
  for (const selector of ['li', 'td']) assert.equal(body.querySelector(selector).hasAttribute('dir'), false, `${selector} takes its list's or table's direction`);
  assert.equal([...body.querySelectorAll('p')].at(-1).getAttribute('dir'), 'ltr', 'a direction the file sets stays');
  assert.equal(body.querySelector('pre').hasAttribute('dir'), false, 'code stays as it is');
});

test('unsafe math commands and SVG script are stripped while literal dollars stay text', async () => {
  const { d, views } = boot();
  const extras = d.createElement('div'); d.body.append(extras);
  const unsafe = String.raw`Math: $\href{javascript:alert(1)}{unsafe}$ and $\includegraphics{https://example.invalid/tracker.png}$.

Inline code: ${'`'}$x$${'`'}. Prices: $5 and $10.

\$literal dollar

<svg onload="evil()"><script>evil()</script></svg>
`;
  views.markdownView(extras, { name: 'unsafe.md' }, unsafe, false);
  await waitFor(() => extras.querySelector('.markdown-body'), 'Markdown renders');
  assert(!extras.querySelector('[href^="javascript:"],script,[onload]')); assert(!extras.querySelector('img[src*="tracker"]'));
  assert(extras.querySelector('code').textContent.includes('$x$')); assert(extras.textContent.includes('Prices: $5 and $10.'));
});

/** Stand in for the Mermaid renderer document; `answer.render` draws each diagram. */
function stubRenderer(w, answer) {
  const append = w.document.body.append.bind(w.document.body);
  w.document.body.append = (...nodes) => {
    append(...nodes);
    for (const node of nodes) if (node.classList?.contains('diagram-renderer')) {
      node.contentWindow.renderDiagram = (...args) => answer.render(...args);
      node.dispatchEvent(new w.Event('load'));
    }
  };
}

test('diagrams render in their own document, fall back on syntax errors and drop stale results', async () => {
  const { w, d, views } = boot();
  let config;
  const answer = { async render(_id, text, value) { config = value; if (text.includes('invalid')) throw Error('syntax'); return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 180"><text>Ready</text></svg>', width: 420, height: 180 }; } };
  stubRenderer(w, answer);
  const host = d.createElement('div'); d.body.append(host);
  views.markdownView(host, { name: 'diagrams.md' }, '```mermaid\nflowchart LR\n A-->B\n```\n\n```mermaid\ninvalid\n```', false);
  await waitFor(() => !host.querySelector('[aria-busy]'), 'diagrams finish rendering');
  const diagram = host.querySelector('.markdown-diagram img');
  assert(diagram); assert.equal(diagram.width, 420); assert.equal(diagram.height, 180); assert.match(decodeURIComponent(diagram.src), /^data:image\/svg\+xml;charset=utf-8,<svg .*Ready/);
  assert.equal(config.securityLevel, 'strict'); assert(host.textContent.includes('could not be rendered')); assert(host.querySelector('pre code').textContent.includes('invalid'));
  const frame = d.querySelectorAll('.diagram-renderer');
  assert.equal(frame.length, 1, 'one renderer document draws every diagram');
  assert.equal(new URL(frame[0].src).pathname, '/views/diagram-renderer.html'); assert(frame[0].inert); assert.equal(frame[0].getAttribute('aria-hidden'), 'true');
  let finish, started;
  const rendering = new Promise(resolve => { started = resolve; });
  answer.render = () => { started(); return new Promise(resolve => finish = resolve); };
  views.markdownView(host, { name: 'slow.md' }, '```mermaid\nflowchart LR\n A-->B\n```', false);
  await rendering;
  const pending = host.querySelector('.markdown-diagram'); host.remove();
  finish({ svg: '<svg viewBox="0 0 10 10"></svg>', width: 10, height: 10 });
  await settle();
  assert(!pending.querySelector('img'));
});

test('diagrams wait for a slow renderer download, and blame the connection when the renderer did not load', async t => {
  const { w, d, views } = boot();
  const frames = [], append = d.body.append.bind(d.body);
  d.body.append = (...nodes) => { append(...nodes); frames.push(...nodes.filter(node => node.classList?.contains('diagram-renderer'))); };
  const host = d.createElement('div'); d.body.append(host);
  const diagram = '```mermaid\nflowchart LR\n A-->B\n```';
  // The renderer's scripts did not load.
  views.markdownView(host, { name: 'offline.md' }, diagram, false);
  await waitFor(() => frames.length === 1, 'the renderer document is added');
  frames[0].dispatchEvent(new w.Event('load'));
  await waitFor(() => !host.querySelector('[aria-busy]'), 'the diagram gives up');
  assert.match(host.querySelector('.markdown-diagram').textContent, /^Diagrams could not load\. Check your connection\./);
  // Mermaid takes a minute to download. waitFor needs the real timers.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  views.markdownView(host, { name: 'slow.md' }, diagram, false);
  for (let turn = 0; turn < 20 && frames.length < 2; turn++) await settle();
  t.mock.timers.tick(60_000); t.mock.timers.reset();
  assert.equal(frames.length, 2, 'the renderer document is added again');
  frames[1].contentWindow.renderDiagram = async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', width: 10, height: 10 });
  frames[1].dispatchEvent(new w.Event('load'));
  await waitFor(() => host.querySelector('.markdown-diagram img'), 'the diagram is drawn');
});

test('a diagram shows in the app\'s colors, in a description as in a file, and again in the new ones when the theme changes', async () => {
  const { w, d, views } = boot();
  // jsdom resolves no custom properties, so the page gives each theme's ink.
  const ink = { light: 'rgb(17, 17, 17)', dark: 'rgb(238, 238, 238)' }, computed = w.getComputedStyle.bind(w);
  w.getComputedStyle = element => element.style.color === 'var(--ink)' ? { color: ink[d.documentElement.dataset.theme] } : computed(element);
  stubRenderer(w, { async render(_id, _text, value) { return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>${value.theme} ${value.themeVariables.textColor}</text></svg>`, width: 10, height: 10 }; } });
  const host = d.createElement('div'); d.body.append(host);
  d.documentElement.dataset.theme = 'light';
  views.markdownInto(host, '```mermaid\nflowchart LR\n A-->B\n```', { breaks: true });
  const drawnIn = () => decodeURIComponent(host.querySelector('.markdown-diagram img')?.src ?? '').match(/<text>([^<]+)<\/text>/)?.[1];
  await waitFor(() => drawnIn() === 'base #111111', 'the diagram shows in the app\'s light colors');
  // The device turned dark while the theme follows it.
  d.documentElement.dataset.theme = 'dark';
  await waitFor(() => drawnIn() === 'base #eeeeee', 'the diagram shows in the app\'s dark colors');
});

test('the renderer document returns sanitized SVG with its size', async () => {
  const { window: w } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/views/diagram-renderer.html', runScripts: 'outside-only' });
  w.eval(source('vendor/dompurify/purify'));
  let config;
  w.mermaid = { initialize(value) { config = value; }, async render() { return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 419.2 180"><style>text{fill:red}</style><script>evil()</script><a href="https://example.invalid"><text onclick="evil()">Ready</text></a></svg>' }; } };
  w.eval(source('diagram-renderer'));
  const settings = { securityLevel: 'strict', flowchart: { htmlLabels: false } };
  const drawn = await w.renderDiagram('d1', 'flowchart LR\n A-->B', settings);
  assert.deepEqual([drawn.width, drawn.height], [420, 180]);
  assert.match(drawn.svg, /Ready/); assert.match(drawn.svg, /<style>/);
  assert.doesNotMatch(drawn.svg, /<script|onclick|<a\b/);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), settings); assert.notEqual(config, settings, 'Mermaid gets its own copy');
});

test('the renderer hides $$ pairs from Mermaid\'s math, and draws a diagram as written when that breaks a name', async () => {
  const { window: w } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/views/diagram-renderer.html', runScripts: 'outside-only' });
  w.eval(source('vendor/dompurify/purify'));
  const rendered = [];
  // Like Mermaid, a flowchart whose node names get a zero-width space doesn't parse.
  w.mermaid = { initialize() {}, async render(_id, text) { rendered.push(text); if (text.startsWith('flowchart') && text.includes('\u200b')) throw new Error('Lexical error on line 2'); return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>Drawn</text></svg>' }; } };
  w.eval(source('diagram-renderer'));
  for (const diagram of ['sequenceDiagram\n A->>B: $$x^2$$', 'flowchart LR\n A$$B-->C\n subgraph s$$\n end', 'flowchart LR\n A$$B-->C$$D']) assert.match((await w.renderDiagram('d', diagram, {})).svg, /Drawn/);
  assert.deepEqual(rendered, [
    'sequenceDiagram\n A->>B: $\u200b$x^2$\u200b$',
    'flowchart LR\n A$$B-->C\n subgraph s$$\n end',
    'flowchart LR\n A$\u200b$B-->C$\u200b$D', 'flowchart LR\n A$$B-->C$$D',
  ]);
});

/** Load only file-views.js, serving preview libraries from the harness on demand. */
function lazyPreviews() {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  const d = w.document, host = d.getElementById('host');
  w.matchMedia = () => ({ matches: true });
  const views = importModule(dom, 'src/features/files/file-views.js');
  const loaded = [], append = d.head.append.bind(d.head);
  const state = { failMath: true };
  d.head.append = element => {
    append(element);
    const name = new URL(element.src || element.href).pathname.replace(/^\//, '');
    loaded.push(name);
    queueMicrotask(() => {
      if (name === 'vendor/katex/katex.min.js' && state.failMath) { state.failMath = false; element.onerror(); return; }
      if (element.tagName === 'SCRIPT') w.eval(source(name));
      element.onload();
    });
  };
  const settle = () => waitFor(() => !host.textContent.includes('Loading Markdown'), 'Markdown finishes loading');
  const open = async text => { views.markdownView(host, { name: 'test.md' }, text, false); await settle(); };
  return { w, d, host, loaded, open, settle, views };
}

test('Markdown loads only the libraries it needs and retries a failed math library once', async () => {
  const { host, loaded, open, settle } = lazyPreviews();
  await open('# Plain\n\nSimple text.'); assert(host.querySelector('h1')); assert(!loaded.some(name => /katex|highlight/.test(name)));
  await open('It costs $5 or $10, and `echo $HOME` prints $HOME.'); assert(!loaded.some(name => /katex/.test(name)), 'prices and shell variables are no math');
  await open('> ~~~js\n> const answer = 42;\n> ~~~'); assert(host.querySelector('.hljs-keyword')); assert(!loaded.some(name => /katex/.test(name)));
  await open('Math: $x^2$'); assert(host.querySelector('[role="alert"]')); assert.equal(host.querySelector('.html-source').textContent, 'Math: $x^2$');
  host.querySelector('[role="alert"] button').click(); await settle();
  assert(host.querySelector('.katex'), host.innerHTML + ' ' + JSON.stringify(loaded)); assert.equal(loaded.filter(name => name === 'vendor/katex/katex.min.js').length, 2);
  const count = loaded.length; await open('~~~math\nx^2\n~~~'); assert(host.querySelector('.katex')); assert.equal(loaded.length, count);
  await open('<pre><code class="language-js">const answer = 42;</code></pre>'); assert(host.querySelector('.hljs-keyword'));
});

test('HTML previews keep Source usable without parsing, and show nothing without a server preview', () => {
  const { d, host, views } = lazyPreviews();
  let parses = 0;
  const create = d.implementation.createHTMLDocument.bind(d.implementation);
  d.implementation.createHTMLDocument = (...args) => { parses++; return create(...args); };
  views.htmlView(host, { name: 'server.html', size: 20, htmlPreviewUrl: '/api/attachments/f/preview' }, '<h1>Source</h1>');
  assert(host.querySelector('iframe').src.includes('/api/attachments/f/preview')); assert.equal(host.querySelector('iframe').getAttribute('sandbox'), '');
  host.querySelector('[data-html-restart]').click(); host.querySelector('[data-view-source]').click();
  assert(!host.querySelector('iframe')); assert.equal(host.querySelector('.html-source').textContent, '<h1>Source</h1>');
  host.querySelector('[data-view-preview]').click();
  views.htmlView(host, { name: 'local.html', size: 20 }, '<h1>Local</h1><iframe src="bad"></iframe>');
  assert(!host.querySelector('iframe')); assert.match(host.querySelector('.preview-unavailable').textContent, /Preview unavailable/);
  assert(host.querySelector('[data-html-restart]').hidden); assert.equal(host.querySelector('.html-source').textContent, '<h1>Local</h1><iframe src="bad"></iframe>');
  assert.equal(parses, 0, 'uploaded HTML is never parsed in the app page');
});

/** File views with the Markdown libraries present, outside the app. */
function directPreviews() {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  w.matchMedia = () => ({ matches: true });
  for (const name of previewLibraries) w.eval(source(name));
  return { w, d: w.document, host: w.document.getElementById('host'), views: importModule(dom, 'src/features/files/file-views.js') };
}

test('a spot in rendered Markdown is found in its source piece by piece, past link addresses, repeated words and math', () => {
  const { d, views } = boot();
  const host = d.createElement('div'); d.body.append(host);
  const source = '## Plan\n\nSee [README](README.md) then **README**, and [the docs](https://example.com/docs) then **docs**.\n\nMath $x^2 + y$ is Tom &amp; Jerry.\n\n| Where | What |\n| - | - |\n| docs | two |';
  views.markdownInto(host, source, { breaks: true });
  // A text node that `selector` shows with the text `value`.
  const text = (selector, value) => [...host.querySelectorAll(selector)].flatMap(element => [...element.childNodes]).find(node => node.nodeValue === value);
  const at = (node, offset) => views.sourcePosition(host, node, offset, source);
  assert.equal(at(text('h2', 'Plan'), 1), 4, 'after the P of ## Plan');
  assert.equal(at(text('strong', 'README'), 2), source.indexOf('**README**') + 4, 'the bold README, not the link\'s address');
  assert.equal(at(text('strong', 'docs'), 0), source.indexOf('**docs**') + 2, 'the bold docs, not the end of the URL');
  assert.equal(at(text('td', 'docs'), 1), source.indexOf('| docs |') + 3, 'the table cell, not the bold docs before it');
  assert.equal(at(text('.katex-html span', 'y'), 0), source.indexOf('+ y$') + 2, 'the y of the formula');
  assert.equal(at(text('p', ' is Tom & Jerry.'), 4), null, 'the source writes & otherwise');
  assert.equal(at(d.createTextNode('Plan'), 0), null, 'text the page doesn\'t show there');
});

test('a Knowledge context links relative files and shows relative images; attachments keep them inert', () => {
  const text = ['[Guide](guides/setup.md#install)', '[Missing](missing.md)', '[Unsafe](javascript:alert(1))', '![Logo](assets/logo.png)', '![Other](other.png)'].join('\n\n');
  const context = {
    resolveLink: href => href === 'guides/setup.md#install' ? '#/knowledge/p1/blob/guides/setup.md?section=install' : href === 'missing.md' ? 'https://example.invalid/not-a-route' : null,
    resolveImage: src => src === 'assets/logo.png' ? '/api/projects/p1/knowledge/content?path=assets%2Flogo.png' : null,
  };
  const { d, host, views } = directPreviews();
  views.markdownView(host, { name: 'README.md', size: text.length }, text, false, context);
  const links = [...d.querySelectorAll('.markdown-body a')];
  assert.equal(links[0].getAttribute('href'), '#/knowledge/p1/blob/guides/setup.md?section=install');
  assert.equal(links[0].getAttribute('target'), null);
  assert(!links[1].hasAttribute('href'), 'only Knowledge routes are accepted from the context');
  assert(!d.querySelector('a[href^="javascript:"]'));
  assert.equal(d.querySelector('.markdown-body img').getAttribute('src'), '/api/projects/p1/knowledge/content?path=assets%2Flogo.png');
  assert.match(d.querySelector('.markdown-image-placeholder').textContent, /Other/);
  views.markdownView(host, { name: 'README.md', size: text.length }, text, false);
  assert(!d.querySelector('.markdown-body a[href^="#/knowledge"]'));
  assert(!d.querySelector('.markdown-body img'));
});

test('deciding what hostile Markdown needs takes a few plain passes over it, not one per character', () => {
  // The libraries never arrive, so markdownInto only checks which ones the text needs.
  const dom = new JSDOM('<!doctype html><div></div>', { url: 'http://localhost/', runScripts: 'outside-only' }), d = dom.window.document;
  d.head.append = () => {};
  const views = importModule(dom, 'src/features/files/file-views.js');
  // CPU work: the machine's speed and load affect the checks and a plain pass alike.
  const work = run => { const start = process.cpuUsage(); run(); const used = process.cpuUsage(start); return used.user + used.system; };
  // 128 KB, under the 200 KiB that previews read, so checks that grow with the square of the text fail in seconds.
  for (const unit of ['\\$', '\\$a', '`', '$`a', '~', '<code ']) {
    const text = unit.repeat(Math.ceil(2 ** 17 / unit.length)), check = () => views.markdownInto(d.createElement('div'), text);
    const pass = Math.min(...[1, 2, 3].map(() => work(() => { let dollars = 0; for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) === 36) dollars++; return dollars; })));
    const limit = 100 * pass;
    // The best of up to three rounds, as the process's other threads, such as the garbage collector, can slow
    // one. A round ten times over the limit is no such noise, so it ends the test at once.
    let checks = work(check);
    for (let round = 2; round <= 3 && checks >= limit && checks < 10 * limit; round++) checks = Math.min(checks, work(check));
    assert(checks < limit, `${JSON.stringify(unit)} × 128 KB: ${checks} µs of checks, ${pass} µs for a plain pass`);
  }
});

test('a link to a oneloop page opens it in place, while other links keep their rules', () => {
  const { d, host, views } = directPreviews();
  const text = ['[Task](#/task/WEB-002)', '[Board](http://localhost/#/board)', '[Section](#setup)', '[Other app](http://localhost:9000/#/board)', '[Docs](https://example.invalid/docs)'].join('\n\n');
  views.markdownView(host, { name: 'notes.md', size: text.length }, text, false);
  assert.deepEqual([...d.querySelectorAll('.markdown-body a')].map(link => [link.getAttribute('href'), link.getAttribute('target')]), [
    ['#/task/WEB-002', null], ['#/board', null], ['#md-setup', null], ['http://localhost:9000/#/board', '_blank'], ['https://example.invalid/docs', '_blank'],
  ]);
});

test('plain text previews indent whole JSON files and say when they are cut', () => {
  const { host, views } = directPreviews();
  views.textView(host, { name: 'config.json' }, '{"a":[1,2]}', false);
  assert.equal(host.querySelector('pre').textContent, '{\n  "a": [\n    1,\n    2\n  ]\n}');
  views.textView(host, { name: 'config.json' }, '{"a":', true);
  assert.equal(host.querySelector('pre').textContent, '{"a":');
  assert.match(host.querySelector('.access-note').textContent, /truncated to 200 KB/);
});
