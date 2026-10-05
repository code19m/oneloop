// views/file-views.js: Markdown, code, HTML and diagram previews.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, bootApp, source, previewLibraries, waitFor, fixtures } = require('../support/dom.cjs');

const markdownLibraries = ['vendor/katex/katex.min', 'vendor/marked-katex-extension/index', 'vendor/marked-footnote/index', 'vendor/marked-alert/index'];
const scripts = ['theme', 'data', 'motion', 'vendor/js-sha256/sha256', 'activity', 'recovery', ...previewLibraries, ...markdownLibraries, 'file-views', 'uploads', 'collaboration', 'app'];
// KaTeX refuses to render in quirks mode.
const boot = () => bootApp({ route: 'task/BIR-079', scripts, html: '<!doctype html><meta name="theme-color"><div id="app"></div>' });

const readme = ['# Review', '', '## Notes', '## Notes', '', '**bold** and ~~old~~', '', '- [x] Ready', '- [ ] Later', '', '| A | B |', '| - | - |', '| 1 | 2 |', '', '```js', 'const total = 2; // <script>bad()</script>', '```', '', '<details><summary>More</summary>Details</details>', '', '[Jump](#notes)', '[Docs](https://example.invalid/docs)', '[Relative](./other.md)', '[Unsafe](javascript:alert(1))', '![Remote](https://example.invalid/image.png)', '', '<script>window.evil=true</script><img src="x" onerror="evil()"><input name="App"><style>body{display:none}</style>'].join('\n');
const report = '<h1>Report</h1><link rel="stylesheet" href="https://example.invalid/style.css"><script src="https://example.invalid/code.js"></script><img src="https://example.invalid/pic.png" onerror="alert(1)"><iframe src="https://example.invalid/frame"></iframe><form action="https://example.invalid"><button>Go</button></form>';

/** Boot a task page and attach one file of each kind the previews handle. */
async function taskWithFiles() {
  const t = boot();
  const { w, d } = t;
  const task = w.DATA.tasks.find(item => item.id === 'BIR-079');
  const files = [new w.File([readme], 'README.md'), new w.File(['{"broken":'], 'broken.json'), new w.File(['<script>alert(1)</script>'], 'source.ts'), new w.File(['FROM scratch'], 'Dockerfile'), new w.File([new Uint8Array([0, 255, 2, 4])], 'release.zip'), new w.File(['corrupt'], 'broken.png'), new w.File([new Uint8Array([0, 255])], 'binary.txt'), new w.File([report], 'report.html')];
  w.App.attachFiles(task.id, { files, value: '' });
  await waitFor(() => task.attachments?.length === files.length, 'every file is attached');
  const file = name => task.attachments.find(f => f.name === name);
  return { ...t, task, file, open: name => w.App.previewAttachment(task.id, file(name).id), close: () => d.querySelector('[data-file-close]').click() };
}

test('uploads accept broken files and keep unpreviewable content download-only', async () => {
  const { w, file } = await taskWithFiles();
  for (const name of ['release.zip', 'broken.png', 'binary.txt']) { assert(!w.Uploads.canPreview(file(name))); assert.equal(file(name).type, 'application/octet-stream'); }
  for (const name of ['README.md', 'broken.json', 'source.ts', 'Dockerfile']) assert(w.Uploads.canPreview(file(name)));
  assert.equal(file('report.html').type, 'application/octet-stream');
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
  const { d, open, close } = await taskWithFiles();
  open('source.ts'); assert.equal(d.querySelector('.file-preview-content pre').textContent, '<script>alert(1)</script>'); assert(!d.querySelector('.file-preview-content script')); close();
  open('broken.json'); assert.equal(d.querySelector('.file-preview-content pre').textContent, '{"broken":'); close();
});

test('Markdown renders GitHub-flavored content safely and offers its source', async () => {
  const { d, open, close } = await taskWithFiles();
  open('README.md');
  const article = d.querySelector('.markdown-body');
  assert(article.querySelector('h1')); assert(article.querySelector('table')); assert(article.querySelector('del')); assert(article.querySelector('details summary'));
  assert.equal(article.querySelectorAll('input[type=checkbox]:disabled').length, 2); assert(article.querySelector('code .hljs-keyword')); assert(article.querySelector('#md-notes-1'));
  assert(!article.querySelector('script,style,iframe,[name],[onerror]')); assert(!article.querySelector('a[href^="javascript:"]'));
  assert(article.querySelector('a[href="https://example.invalid/docs"]').rel.includes('noopener')); assert(article.querySelector('a[href="#md-notes"]'));
  d.querySelector('[data-view-source]').click(); assert(d.querySelector('.document-preview').hidden); assert.equal(d.querySelector('.html-source').textContent, readme);
  d.querySelector('[data-view-preview]').click(); assert(!d.querySelector('.document-preview').hidden);
  assert(d.querySelector('.markdown-body img[src="https://example.invalid/image.png"]')); assert(!d.querySelector('[data-view-resources]')); close();
});

test('HTML previews run no scripts, load nothing from other sites and restart from the same content', async () => {
  const { d, open, close } = await taskWithFiles();
  open('report.html');
  let frame = d.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), ''); assert(frame.hasAttribute('credentialless'));
  const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(frame.srcdoc)[1];
  assert.equal(policy, "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'");
  assert(!frame.srcdoc.includes('<iframe')); assert(!frame.srcdoc.includes('<link')); assert(!frame.srcdoc.includes('oneloop-preview-escape'));
  assert(frame.srcdoc.includes('onerror')); assert(!frame.srcdoc.includes('disabled')); assert(!d.querySelector('[data-view-resources]'));
  const contents = frame.srcdoc; d.querySelector('[data-html-restart]').click(); assert(!frame.isConnected); frame = d.querySelector('iframe'); assert.equal(frame.srcdoc, contents);
  d.querySelector('[data-view-source]').click(); assert(!frame.isConnected); assert(!d.querySelector('.document-preview iframe')); assert(d.querySelector('[data-html-restart]').hidden);
  d.querySelector('[data-view-preview]').click(); assert(d.querySelector('.document-preview iframe')); assert(!d.querySelector('[data-html-restart]').hidden); close();
});

test('large Markdown stays attachable and both preview modes are bounded', async () => {
  const { w, d, task, file, open, close } = await taskWithFiles();
  w.App.attachFiles(task.id, { files: [new w.File(['# Large\n\n' + 'word '.repeat(50000)], 'large.markdown')], value: '' });
  await waitFor(() => file('large.markdown'), 'the large file is attached');
  open('large.markdown'); assert(d.querySelector('.access-note').textContent.includes('truncated')); assert(d.querySelector('.html-source').textContent.length <= 200000); close();
});

test('a single previewable file hides preview navigation', async () => {
  const { d, task, file, open, close } = await taskWithFiles();
  task.attachments = [file('README.md')]; open('README.md'); assert(d.querySelector('.file-navigation').hidden); close();
});

test('math, alerts and footnotes render and footnote links move focus', async () => {
  const { w, d } = boot();
  const extras = d.createElement('div'); d.body.append(extras);
  const sample = fs.readFileSync(path.join(fixtures, 'math.md'), 'utf8');
  w.FileViews.markdown(extras, { name: 'extras.md' }, sample, false);
  await waitFor(() => extras.querySelector('.markdown-body'), 'Markdown renders');
  assert.equal(extras.querySelectorAll('.katex').length, 5); assert.equal(extras.querySelectorAll('math').length, 5); assert.equal(extras.querySelectorAll('.markdown-alert').length, 5);
  assert.equal(extras.querySelectorAll('.markdown-alert-title svg').length, 5); assert.equal(extras.querySelectorAll('.footnotes li').length, 2);
  const refs = [...extras.querySelectorAll('sup a')]; assert.equal(refs.length, 2);
  for (const ref of refs) assert(extras.querySelector(ref.getAttribute('href')));
  const back = extras.querySelector('.footnotes a'); assert(extras.querySelector(back.getAttribute('href')));
  const scroller = extras.querySelector('.markdown-scroll'); let scrolled = false; scroller.scrollTo = () => scrolled = true;
  refs[0].click(); assert(scrolled); assert.equal(d.activeElement.id, refs[0].getAttribute('href').slice(1));
  assert.equal(extras.querySelector('.html-source').textContent, sample);
  extras.querySelector('[data-view-source]').click(); assert.equal(extras.querySelector('.html-source').textContent, sample);
});

test('Markdown anchors stay unique when literal suffixes collide with repeated headings', async () => {
  const { w, d } = boot();
  for (const [text, expected] of [
    ['## Setup\n\n## Setup\n\n## Setup-1\n\n## md-setup\n', ['md-setup', 'md-setup-1', 'md-setup-1-1', 'md-md-setup']],
    ['## Setup-1\n\n## Setup\n\n## Setup\n', ['md-setup-1', 'md-setup', 'md-setup-2']],
  ]) {
    const host = d.createElement('div'); d.body.append(host);
    w.FileViews.markdown(host, { name: 'anchors.md' }, text, false);
    await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
    assert.deepEqual([...host.querySelectorAll('.markdown-body h2')].map(heading => heading.id), expected);
    host.remove();
  }
});

test('heading ids match the anchors the server gives search hits and MCP sections', async () => {
  const { w, d } = boot();
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'heading-anchors.json'), 'utf8'));
  const host = d.createElement('div'); d.body.append(host);
  w.FileViews.markdown(host, { name: 'guide.md' }, fixture.source, false);
  await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
  assert.deepEqual([...host.querySelectorAll('.markdown-body :is(h1,h2,h3,h4,h5,h6)')].map(heading => heading.id), fixture.ids);
  assert.equal(host.querySelectorAll('[data-md-heading]').length, 0);
});

test('a spoofed heading marker in uploaded HTML gives no server anchor', async () => {
  const { w, d } = boot();
  const host = d.createElement('div'); d.body.append(host);
  w.FileViews.markdown(host, { name: 'spoof.md' }, '<h2 data-md-heading="x-0">Fake</h2>\n\n## Setup\n', false);
  await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
  assert.deepEqual([...host.querySelectorAll('.markdown-body h2')].map(heading => heading.id), ['md-fake', 'md-setup']);
});

test('in-page links reach headings in any script', async () => {
  const { w, d } = boot();
  const host = d.createElement('div'); d.body.append(host);
  w.FileViews.markdown(host, { name: 'ru.md' }, '[Оплата и сроки](#оплата-и-сроки)\n\n## Оплата и сроки\n\nТекст.\n', false);
  await waitFor(() => host.querySelector('.markdown-body'), 'Markdown renders');
  const link = host.querySelector('.markdown-body a');
  assert.equal(link.getAttribute('href'), '#md-оплата-и-сроки');
  host.querySelector('.markdown-scroll').scrollTo = () => {};
  link.click();
  assert.equal(d.activeElement, host.querySelector('#md-оплата-и-сроки'));
});

test('unsafe math commands and SVG script are stripped while literal dollars stay text', async () => {
  const { w, d } = boot();
  const extras = d.createElement('div'); d.body.append(extras);
  const unsafe = String.raw`Math: $\href{javascript:alert(1)}{unsafe}$ and $\includegraphics{https://example.invalid/tracker.png}$.

Inline code: ${'`'}$x$${'`'}. Prices: $5 and $10.

\$literal dollar

<svg onload="evil()"><script>evil()</script></svg>
`;
  w.FileViews.markdown(extras, { name: 'unsafe.md' }, unsafe, false);
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
  const { w, d } = boot();
  let config;
  const answer = { async render(_id, text, value) { config = value; if (text.includes('invalid')) throw Error('syntax'); return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 180"><text>Ready</text></svg>', width: 420, height: 180 }; } };
  stubRenderer(w, answer);
  const host = d.createElement('div'); d.body.append(host);
  w.FileViews.markdown(host, { name: 'diagrams.md' }, '```mermaid\nflowchart LR\n A-->B\n```\n\n```mermaid\ninvalid\n```', false);
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
  w.FileViews.markdown(host, { name: 'slow.md' }, '```mermaid\nflowchart LR\n A-->B\n```', false);
  await rendering;
  const pending = host.querySelector('.markdown-diagram'); host.remove();
  finish({ svg: '<svg viewBox="0 0 10 10"></svg>', width: 10, height: 10 });
  await new Promise(resolve => setImmediate(resolve));
  assert(!pending.querySelector('img'));
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

/** Load only motion.js and file-views.js, serving preview libraries from the harness on demand. */
function lazyPreviews() {
  const { window: w } = new JSDOM('<!doctype html><div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const d = w.document, host = d.getElementById('host');
  w.matchMedia = () => ({ matches: true });
  for (const name of ['motion', 'file-views']) w.eval(source(name));
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
  const open = async text => { w.FileViews.markdown(host, { name: 'test.md' }, text, false); await settle(); };
  return { w, d, host, loaded, open, settle };
}

test('Markdown loads only the libraries it needs and retries a failed math library once', async () => {
  const { host, loaded, open, settle } = lazyPreviews();
  await open('# Plain\n\nSimple text.'); assert(host.querySelector('h1')); assert(!loaded.some(name => /katex|highlight/.test(name)));
  await open('> ~~~js\n> const answer = 42;\n> ~~~'); assert(host.querySelector('.hljs-keyword')); assert(!loaded.some(name => /katex/.test(name)));
  await open('Math: $x^2$'); assert(host.querySelector('[role="alert"]')); assert.equal(host.querySelector('.html-source').textContent, 'Math: $x^2$');
  host.querySelector('[role="alert"] button').click(); await settle();
  assert(host.querySelector('.katex'), host.innerHTML + ' ' + JSON.stringify(loaded)); assert.equal(loaded.filter(name => name === 'vendor/katex/katex.min.js').length, 2);
  const count = loaded.length; await open('~~~math\nx^2\n~~~'); assert(host.querySelector('.katex')); assert.equal(loaded.length, count);
  await open('<pre><code class="language-js">const answer = 42;</code></pre>'); assert(host.querySelector('.hljs-keyword'));
});

test('server HTML previews keep Source usable without parsing, and local srcdoc is built once', () => {
  const { w, d, host } = lazyPreviews();
  let parses = 0;
  const create = d.implementation.createHTMLDocument.bind(d.implementation);
  d.implementation.createHTMLDocument = (...args) => { parses++; return create(...args); };
  w.FileViews.html(host, { name: 'server.html', size: 20, htmlPreviewUrl: '/api/attachments/f/preview' }, '<h1>Source</h1>');
  assert.equal(parses, 0); assert(host.querySelector('iframe').src.includes('/api/attachments/f/preview')); assert.equal(host.querySelector('iframe').getAttribute('sandbox'), '');
  host.querySelector('[data-html-restart]').click(); host.querySelector('[data-view-source]').click();
  assert(!host.querySelector('iframe')); assert.equal(host.querySelector('.html-source').textContent, '<h1>Source</h1>');
  host.querySelector('[data-view-preview]').click(); assert.equal(parses, 0);
  w.FileViews.html(host, { name: 'demo.html', size: 20 }, '<h1>Demo</h1><iframe src="bad"></iframe>'); assert.equal(parses, 1); assert(!host.querySelector('iframe').srcdoc.includes('<iframe'));
  host.querySelector('[data-html-restart]').click(); host.querySelector('[data-view-source]').click(); host.querySelector('[data-view-preview]').click(); assert.equal(parses, 1);
});

/** File views with the Markdown libraries present, outside the app. */
function directPreviews() {
  const { window: w } = new JSDOM('<!doctype html><div id="host"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  w.matchMedia = () => ({ matches: true });
  for (const name of ['motion', ...previewLibraries, 'vendor/marked-footnote/index', 'vendor/marked-alert/index', 'file-views']) w.eval(source(name));
  return { w, d: w.document, host: w.document.getElementById('host') };
}

test('a Knowledge context links relative files and shows relative images; attachments keep them inert', () => {
  const text = ['[Guide](guides/setup.md#install)', '[Missing](missing.md)', '[Unsafe](javascript:alert(1))', '![Logo](assets/logo.png)', '![Other](other.png)'].join('\n\n');
  const context = {
    resolveLink: href => href === 'guides/setup.md#install' ? '#/knowledge/p1/blob/guides/setup.md?section=install' : href === 'missing.md' ? 'https://example.invalid/not-a-route' : null,
    resolveImage: src => src === 'assets/logo.png' ? '/api/projects/p1/knowledge/content?path=assets%2Flogo.png' : null,
  };
  const { w, d, host } = directPreviews();
  w.FileViews.markdown(host, { name: 'README.md', size: text.length }, text, false, context);
  const links = [...d.querySelectorAll('.markdown-body a')];
  assert.equal(links[0].getAttribute('href'), '#/knowledge/p1/blob/guides/setup.md?section=install');
  assert.equal(links[0].getAttribute('target'), null);
  assert(!links[1].hasAttribute('href'), 'only Knowledge routes are accepted from the context');
  assert(!d.querySelector('a[href^="javascript:"]'));
  assert.equal(d.querySelector('.markdown-body img').getAttribute('src'), '/api/projects/p1/knowledge/content?path=assets%2Flogo.png');
  assert.match(d.querySelector('.markdown-image-placeholder').textContent, /Other/);
  w.FileViews.markdown(host, { name: 'README.md', size: text.length }, text, false);
  assert(!d.querySelector('.markdown-body a[href^="#/knowledge"]'));
  assert(!d.querySelector('.markdown-body img'));
});

test('plain text previews indent whole JSON files and say when they are cut', () => {
  const { w, host } = directPreviews();
  w.FileViews.text(host, { name: 'config.json' }, '{"a":[1,2]}', false);
  assert.equal(host.querySelector('pre').textContent, '{\n  "a": [\n    1,\n    2\n  ]\n}');
  w.FileViews.text(host, { name: 'config.json' }, '{"a":', true);
  assert.equal(host.querySelector('pre').textContent, '{"a":');
  assert.match(host.querySelector('.access-note').textContent, /truncated to 200 KB/);
});
