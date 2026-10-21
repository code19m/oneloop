// Attachments and their previews: Markdown, HTML, PDF and images.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { test, expect, openApp, holdResponses } from '../support/test.mjs';

const pdf = readFileSync(new URL('../support/fixtures/document.pdf', import.meta.url));
const png = readFileSync(new URL('../../frontend/icons/icon-192.png', import.meta.url));

/** The requests that reached the network. Chromium also reports loads that a policy blocked. */
async function sent(requests) {
  const urls = [];
  for (const request of requests) {
    await request.response();
    if (!/^csp$|BLOCKED_BY_CSP/.test(request.failure()?.errorText ?? '')) urls.push(request.url());
  }
  return urls;
}

// The harness's init script can't run in the script-less preview frame either.
const sandboxedScript = /Blocked script execution in '[^']*\/preview\/html[^']*' because the document's frame is sandboxed/;

async function attach(page, name, mimeType, content) {
  await page.locator('#attIn').setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
}

test('the attachment preview traps focus, exposes details and restores its trigger', { tag: '@smoke' }, async ({ page, instance }) => {
  await openApp(page, instance);
  await attach(page, 'example.csv', 'text/csv', 'Name,Status\nExample,planning\n');
  await expect(page.locator('.attachment-title')).toHaveCount(1);
  await attach(page, 'second.txt', 'text/plain', 'Second file');
  await expect(page.locator('.attachment-title')).toHaveCount(2);
  const attachment = page.locator('.attachment-title').filter({ hasText: 'example.csv' });
  await expect(attachment).toBeVisible();
  await attachment.focus();
  await attachment.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('File 1 of', { exact: false })).toBeVisible();
  const details = dialog.getByRole('button', { name: 'File details' });
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('heading', { name: 'File details', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close file preview' }).click();
  await expect(dialog).toBeHidden();
  await expect(attachment).toBeFocused();
});

test('every page, theme, icon and preview type loads from the embedded assets', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(sandboxedScript);
  const missing = [];
  page.on('response', response => { if (response.status() === 404) missing.push(response.url()); });
  await openApp(page, instance);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => Theme.set(theme), theme);
    for (const route of ['board', 'roadmap', 'knowledge', 'inbox', 'storage', 'profile', 'users', 'settings']) {
      await page.evaluate(route => App.nav(route), route);
      await expect(page.locator('.topbar h1')).toBeVisible();
      await expect(page.locator('.page-error')).toHaveCount(0);
    }
  }
  for (const name of readdirSync(new URL('../../frontend/icons/', import.meta.url))) {
    const response = await page.request.get(`${instance.url}/icons/${name}`);
    expect(response.ok(), name).toBe(true);
  }
  await page.evaluate(key => { location.hash = `#/task/${key}`; }, instance.projects[0].task.taskKey);
  await expect(page.locator('#attIn')).toBeAttached();
  // The server's file limits reach the client under the names it reads.
  await expect(page.locator('.attachment-drop-limit')).toHaveText('Max file size: 25 MB');
  expect(await page.evaluate(() => [DATA.limits.maxAvatarBytes, DATA.limits.maxAttachmentsPerTask])).toEqual([5 * 1024 * 1024, 25]);
  const files = [
    ['reader.md', 'text/markdown', Buffer.from('# Reader\n\n$x^2$\n\n```mermaid\nflowchart LR\n A-->B\n```'), '.markdown-body .katex'],
    ['document.pdf', 'application/pdf', pdf, '.pdf-surface canvas'],
    ['image.png', 'image/png', png, '.image-stage img'],
    ['notes.txt', 'text/plain', Buffer.from('Plain text preview'), '.file-dialog pre'],
    ['page.html', 'text/html', Buffer.from('<h1>Sandbox page</h1>'), '.html-preview'],
  ];
  for (const [name, mimeType, buffer, selector] of files) {
    await page.locator('#attIn').setInputFiles({ name, mimeType, buffer });
    await page.locator('.attachment-title').filter({ hasText: name }).click();
    await expect(page.locator(selector).first()).toBeVisible({ timeout: 15_000 });
    if (name === 'reader.md') await expect.poll(() => page.locator('.markdown-diagram img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    if (name === 'page.html') await expect(page.frameLocator('.html-preview').getByRole('heading', { name: 'Sandbox page' })).toBeVisible();
    await page.getByRole('button', { name: 'Close file preview' }).click();
  }
  expect(missing).toEqual([]);
});

test('previews render under a policy that refuses HTML strings and inline style elements', async ({ page, instance, allowedConsoleErrors }) => {
  await page.addInitScript(() => { window.violations = []; document.addEventListener('securitypolicyviolation', event => window.violations.push(event.effectiveDirective)); });
  await openApp(page, instance);
  await attach(page, 'policy.md', 'text/markdown', '# Policy\n\n$x^2$\n\n```js\nconst answer = 42;\n```\n\n```mermaid\nsequenceDiagram\n A->>B: Hello\n```');
  await page.locator('.attachment-title').filter({ hasText: 'policy.md' }).click();
  await expect(page.locator('.markdown-body .katex')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.markdown-body code.hljs')).toBeVisible();
  await expect.poll(() => page.locator('.markdown-diagram img').evaluate(image => image.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close file preview' }).click();
  await attach(page, 'policy.pdf', 'application/pdf', pdf);
  await page.locator('.attachment-title').filter({ hasText: 'policy.pdf' }).click();
  await expect(page.locator('.pdf-surface canvas')).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => window.violations)).toEqual([]);
  // Each browser reports the two probes below in its own words.
  allowedConsoleErrors.push(/TrustedHTML|Sink type mismatch|trusted-types|inline style|style-src-elem|Refused to apply a stylesheet/i);
  expect(await page.evaluate(() => { try { document.createElement('div').innerHTML = '<b>untrusted</b>'; return 'accepted'; } catch (error) { return error.name; } })).toBe('TypeError');
  expect(await page.evaluate(() => { const style = document.createElement('style'); style.textContent = 'body { visibility: hidden }'; document.head.append(style); return getComputedStyle(document.body).visibility; })).toBe('visible');
  await expect.poll(() => page.evaluate(() => window.violations)).toEqual(['require-trusted-types-for', 'style-src-elem']);
});

const outside = 'https://outside.invalid';
const dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const hostile = `<!doctype html><title>Isolation probe</title><link rel="stylesheet" href="${outside}/style.css"><link rel="preconnect" href="${outside}">
<style>@font-face{font-family:probe;src:url(${outside}/font.woff)}h1{font-family:probe}body{background:url(${outside}/background.png)}</style>
<h1 id="status" style="color: rgb(1, 2, 3)">Static</h1><img alt="Dot" src="${dot}"><img alt="Outside" src="${outside}/image.png"><script src="${outside}/script.js"></script>
<form action="/?preview-form-probe" method="get"><input name="probe" value="1"></form><script>
document.getElementById('status').textContent='Script ran';
fetch('/?preview-fetch-probe');document.forms[0].submit();location.href='${outside}/navigation';
</script>`;

test('HTML previews run no scripts and load nothing from other sites, framed or at their direct URL', { tag: '@smoke' }, async ({ page, context, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/Content Security Policy|Content-Security-Policy|content security policy|violates.*policy|sandbox|Sandbox|Blocked script|downloadable font: .*content blocked|insecure/i);
  const escapes = [];
  context.on('request', request => { if (request.url().startsWith(outside) || /preview-(?:form|fetch)-probe/.test(request.url())) escapes.push(request); });
  await openApp(page, instance);
  await attach(page, 'hostile.html', 'text/html', hostile);
  await page.locator('.attachment-title').filter({ hasText: 'hostile.html' }).click();
  const iframe = page.locator('iframe.html-preview');
  await expect(iframe).toHaveAttribute('sandbox', '');
  const src = new URL(await iframe.getAttribute('src'), instance.url).href, original = page.url();
  const direct = await context.newPage();
  await direct.goto(src);
  for (const [frame, view] of [[page.frames().find(item => item.url().includes('/preview/html')), page.frameLocator('iframe.html-preview')], [direct.mainFrame(), direct]]) {
    // Every request the page could make has started once it has loaded.
    await frame.waitForLoadState('load');
    await expect(view.locator('#status')).toHaveText('Static');
    await expect(view.locator('#status')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(view.getByRole('img', { name: 'Dot' })).toHaveJSProperty('naturalWidth', 1);
  }
  expect(await sent(escapes)).toEqual([]);
  expect(page.url()).toBe(original);
  expect(direct.url()).toBe(src);
  await direct.close();
});

/** A PNG of `size` × `size` pixels of noise, which doesn't compress: about 120 KB for 200. */
function noisePng(size, seed) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]), check = Buffer.alloc(4);
    length.writeUInt32BE(data.length); check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let index = 0, state = seed; index < rows.length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    rows[index] = index % (size * 3 + 1) === 0 ? 0 : state >>> 24;
  }
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('a 3 MiB HTML report with embedded screenshots previews, and opens again from the cache', async ({ page, instance, browserName, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/Content Security Policy|Content-Security-Policy|content security policy|violates.*policy|sandbox|Sandbox|Blocked script/i);
  const shots = Array.from({ length: 20 }, (_, index) => `<h2>Step ${index + 1}</h2><img alt="Screenshot ${index + 1}" src="data:image/png;base64,${noisePng(200, index + 1).toString('base64')}">`);
  const report = `<!doctype html><title>Daily report</title><h1 id="status">Static</h1><img alt="Outside" src="${outside}/image.png"><script>document.getElementById('status').textContent='Script ran'</script>${shots.join('\n')}`;
  expect(report.length).toBeGreaterThan(3 * 1024 * 1024);
  const escapes = [], previews = [];
  page.context().on('request', request => { if (request.url().startsWith(outside)) escapes.push(request); });
  page.on('requestfinished', request => { if (request.url().includes('/preview/html')) previews.push(request); });
  // Whether the server sent the page, rather than 304 for the browser's copy.
  // Chromium reports such a copy with no body, Firefox with its 304.
  const sentPage = async request => (await request.response()).status() !== 304 && (await request.sizes()).responseBodySize > 0;
  await openApp(page, instance);
  await attach(page, 'report.html', 'text/html', report);
  const title = page.locator('.attachment-title').filter({ hasText: 'report.html' });
  const view = page.frameLocator('iframe.html-preview');
  const shown = async () => {
    await expect(page.locator('iframe.html-preview')).toHaveAttribute('sandbox', '');
    await expect(view.getByRole('img', { name: 'Screenshot 20' })).toHaveJSProperty('naturalWidth', 200);
    await expect(view.locator('#status')).toHaveText('Static');
  };
  await title.click();
  await shown();
  expect(await sent(escapes)).toEqual([]);
  await expect.poll(() => previews.length).toBe(1);
  // WebKit reports the copy it checked with the server as a new response, so
  // only the other browsers show what the server sent.
  if (browserName === 'webkit') return;
  expect(await sentPage(previews[0])).toBe(true);

  // Opening the file again checks the browser's copy and downloads nothing.
  await page.getByRole('button', { name: 'Close file preview' }).click();
  await title.click();
  await shown();
  await expect.poll(() => previews.length).toBe(2);
  expect(await sentPage(previews[1])).toBe(false);

  // **Reload preview** gets a new copy.
  await page.getByRole('button', { name: 'Reload preview' }).click();
  await shown();
  await expect.poll(() => previews.length).toBe(3);
  expect(new URL(previews[2].url()).searchParams.get('reload')).toBe('1');
  expect(await sentPage(previews[2])).toBe(true);
});

/** A request for `url` that stops reading once its response starts, as a stalled connection does. */
function stalledRequest(url, cookie) {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${cookie}\r\nSec-Fetch-Dest: iframe\r\n\r\n`);
    });
    socket.once('error', reject);
    socket.once('data', chunk => {
      socket.pause();
      if (!chunk.toString('latin1').startsWith('HTTP/1.1 200')) reject(new Error(chunk.toString('latin1', 0, 200)));
      resolve(socket);
    });
  });
}

test('a preview that cannot be prepared or whose session ended says why in its frame', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/sandbox|Sandbox|Blocked script|status of (503|401)|Service Unavailable|Unauthorized/i);
  // A page at the size limit is far more than a stalled connection buffers.
  const heading = '<!doctype html><title>Big report</title><h1>Big report</h1><p>';
  await openApp(page, instance);
  await attach(page, 'big.html', 'text/html', heading + 'word '.repeat((10 * 1024 * 1024 - heading.length) / 5));
  await page.locator('.attachment-title').filter({ hasText: 'big.html' }).click();
  const view = page.frameLocator('iframe.html-preview');
  await expect(view.getByRole('heading', { name: 'Big report' })).toBeVisible();
  // Three other pages of this person are still being sent.
  const preview = new URL(await page.locator('iframe.html-preview').getAttribute('src'), instance.url);
  preview.searchParams.set('reload', '1');
  const cookie = (await page.context().cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');
  const stalled = [];
  for (let index = 0; index < 3; index++) stalled.push(await stalledRequest(preview, cookie));
  await page.getByRole('button', { name: 'Reload preview' }).click();
  await expect(view.locator('main')).toMatchAriaSnapshot(`
    - main:
      - heading "Preview unavailable" [level=1]
      - paragraph: Your other previews are still loading, maybe in another tab or window.
      - paragraph:
        - text: Use
        - strong: Reload preview
        - text: to try again.
  `);
  for (const socket of stalled) socket.destroy();
  await page.getByRole('button', { name: 'Reload preview' }).click();
  await expect(view.getByRole('heading', { name: 'Big report' })).toBeVisible();
  // A session that ended while the preview was open.
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Reload preview' }).click();
  await expect(view.getByText('Your session has ended. Sign in to oneloop again.')).toBeVisible();
});

test('Markdown strips app actions and SVG navigation while keeping math, diagrams and footnotes', async ({ page, instance }) => {
  await openApp(page, instance);
  const markdown = `# Safe reader\n\n$x^2$\n\nReference[^1]\n\n[^1]: Footnote\n\n<svg viewBox="0 0 100 20"><a href="https://example.invalid/svg"><path d="M0 0h100v20H0z"/></a></svg>\n<span tabindex="0" data-reorder-task="${instance.projects[0].task.taskKey}" data-reorder-file="anything" data-action="logout" data-action-keydown="logout" data-args="[]">Gadget</span>\n[External](https://example.invalid/)` + '\n\n```mermaid\nsequenceDiagram\n A->>B: $$x^2$$\n```' + '\n\n```mermaid\nflowchart LR\n A$$B-->C\n subgraph s$$\n C-->D$$E-->F$$G\n end\n```';
  await attach(page, 'gadget.md', 'text/markdown', markdown);
  await page.locator('.attachment-title').filter({ hasText: 'gadget.md' }).click();
  const body = page.locator('.markdown-body');
  await expect(body.locator('h1')).toHaveText('Safe reader');
  await expect(body.locator('[data-reorder-file],[data-reorder-task],[data-action],[data-action-keydown],[data-args],[tabindex],svg a')).toHaveCount(0);
  await expect(body.locator('.katex')).toBeVisible();
  await expect(body.locator('[data-footnote-ref]')).toBeVisible();
  const diagrams = body.locator('.markdown-diagram img');
  // Mermaid lays out each diagram in its own document, which a busy computer makes slow.
  await expect(diagrams).toHaveCount(2, { timeout: 15_000 });
  for (const diagram of await diagrams.all()) await expect.poll(() => diagram.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  // The sanitizer removes the HTML that Mermaid draws math with, so the label shows its text.
  expect(decodeURIComponent(await diagrams.first().getAttribute('src'))).toContain('x^2');
  // Dollar signs in node and subgraph names keep the diagram valid.
  expect(decodeURIComponent(await diagrams.last().getAttribute('src'))).toContain('A$$B');
  await expect(body.getByRole('link', { name: 'External' })).toHaveAttribute('target', '_blank');
  const url = page.url(), writes = [];
  page.on('request', r => { if (r.method() === 'POST') writes.push(r.url()); });
  await body.locator('svg').last().click();
  await page.keyboard.press('Home');
  await body.getByText('Gadget').click();
  await expect(page.locator('.confirmation-layer')).toHaveCount(0);
  expect(page.url()).toBe(url);
  expect(writes).toEqual([]);
});

test('Markdown in Arabic reads right to left, with its list on the right', async ({ page, instance }) => {
  await openApp(page, instance);
  await attach(page, 'دليل.md', 'text/markdown', '# دليل الفريق\n\nهذه فقرة عربية تنتهي بنقطة.\n\n- البند الأول\n- البند الثاني\n\nAn English paragraph.');
  await page.locator('.attachment-title').filter({ hasText: 'دليل.md' }).click();
  const body = page.locator('.markdown-body');
  // Where a text sits in its box: right-aligned when it reads right to left.
  const side = locator => locator.evaluate(element => {
    const range = document.createRange(), box = element.getBoundingClientRect();
    range.selectNodeContents(element);
    const line = range.getClientRects()[0];
    return Math.round(box.right - line.right) < Math.round(line.left - box.left) ? 'right' : 'left';
  });
  await expect(body.locator('p').first()).toHaveText('هذه فقرة عربية تنتهي بنقطة.');
  expect(await side(body.locator('p').first())).toBe('right');
  expect(await side(body.locator('li').first())).toBe('right');
  expect(await side(body.locator('p').last())).toBe('left');
  const list = await body.locator('ul').evaluate(element => { const style = getComputedStyle(element); return [style.direction, parseFloat(style.paddingRight) > 0, parseFloat(style.paddingLeft)]; });
  expect(list).toEqual(['rtl', true, 0]);
});

test('Markdown keeps renderer formatting and cannot borrow dialog classes', async ({ page, instance }) => {
  await openApp(page, instance);
  await attach(page, 'hostile.md', 'text/markdown', '<div data-action="nav" data-args="[&quot;users&quot;]" class="confirmation-layer scrim modal-wrap peek">Fake dialog</div>\n\n> [!NOTE]\n> Safe note\n\n```js\nconst value = 1;\n```');
  await page.locator('.attachment-title').click();
  const body = page.locator('.markdown-body');
  await expect(body).toBeVisible();
  await expect(body.locator('.confirmation-layer,.scrim,.modal-wrap,.peek,[data-action],[data-args]')).toHaveCount(0);
  await expect(body.locator('.markdown-alert')).toHaveCount(1);
  await expect(body.locator('.hljs')).toHaveCount(1);
  await expect(page.locator('[data-file-close]')).toBeVisible();
});

test('Markdown loads on demand and a dependency failure is local and retryable', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/(?:ERR_FAILED|Failed to load resource|Loading failed).*katex(?:\.min)?\.js/, sandboxedScript);
  const preview = page.locator('.file-overlay:not([data-motion-exiting])');
  let mathRequests = 0;
  await page.route('**/vendor/katex/katex.min.js', route => ++mathRequests === 1 ? route.abort() : route.continue());
  await openApp(page, instance);
  const markdown = '# Lazy Markdown\n\n$x^2$\n\n> [!NOTE]\n> A note.\n\n```js\nconst value = 2;\n```\n\n<script>window.previewInjected=true</script>';
  await page.locator('#attIn').setInputFiles([
    { name: 'lazy.html', mimeType: 'text/html', buffer: Buffer.from('<h1>HTML preview</h1>') },
    { name: 'lazy.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) },
  ]);
  await expect(page.locator('.attachment-title').filter({ hasText: 'lazy.html' })).toBeVisible();
  expect(mathRequests).toBe(0);
  await page.locator('.attachment-title').filter({ hasText: 'lazy.html' }).click();
  await expect(page.locator('iframe.html-preview')).toBeVisible();
  expect((await page.locator('iframe.html-preview').boundingBox()).height).toBeGreaterThan(300);
  expect(mathRequests).toBe(0);
  await preview.locator('[data-file-close]').click();
  await page.locator('.attachment-title').filter({ hasText: 'lazy.md' }).click();
  await expect(preview.locator('.file-dialog [role="alert"]')).toContainText('Markdown preview could not load');
  await preview.locator('[data-view-source]').click();
  await expect(preview.locator('.html-source')).toHaveText(markdown);
  await preview.locator('[data-view-preview]').click();
  await preview.locator('.file-dialog').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(preview.locator('.markdown-body h1')).toHaveText('Lazy Markdown');
  await expect(preview.locator('.markdown-body .katex')).toBeVisible();
  await expect(preview.locator('.markdown-alert-note')).toBeVisible();
  await expect(preview.locator('.markdown-body .hljs-keyword')).toHaveText('const');
  expect(await page.evaluate(() => window.previewInjected)).toBeUndefined();
  expect(mathRequests).toBe(2);
  await preview.locator('[data-file-close]').click();
  await page.locator('.attachment-title').filter({ hasText: 'lazy.md' }).click();
  await expect(preview.locator('.markdown-body h1')).toHaveText('Lazy Markdown');
  expect(mathRequests).toBe(2);
});

test('the PDF preview loads bundled assets from a deep app URL', async ({ page, context, instance }) => {
  await context.addCookies((await instance.api.storageState()).cookies);
  const assets = [];
  page.on('response', response => { if (new URL(response.url()).pathname.includes('/vendor/pdfjs/')) assets.push(response); });
  await page.goto(`${instance.url}/x/y#/task/${instance.projects[0].task.taskKey}`);
  await page.locator('#attIn').setInputFiles({ name: 'deep-path.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.locator('.attachment-title').filter({ hasText: 'deep-path.pdf' }).click();
  await expect(page.locator('.pdf-surface canvas')).toBeVisible({ timeout: 15_000 });
  const assetPath = response => new URL(response.url()).pathname.replace(/^\/v\/[a-f0-9]{64}(?=\/)/, '');
  for (const name of ['pdf.mjs', 'pdf.worker.mjs']) expect(assets.some(response => assetPath(response) === `/vendor/pdfjs/${name}` && response.ok())).toBe(true);
  expect(assets.every(response => assetPath(response).startsWith('/vendor/pdfjs/') && response.ok())).toBe(true);
});

test('a file list read before an upload finished neither hides the new file nor closes its preview', async ({ page, instance }) => {
  await openApp(page, instance);
  // The live update after the first upload reads the list, which is held
  // until the second upload has finished here and its preview is open.
  const read = await holdResponses(page, '**/api/tasks/*/attachments', { method: 'GET' });
  const dialog = page.getByRole('dialog');
  try {
    await attach(page, 'first.txt', 'text/plain', 'First file');
    await read.started;
    await attach(page, 'second.txt', 'text/plain', 'Second file');
    await expect(page.locator('.attachment-title')).toHaveCount(2);
    await page.evaluate(() => {
      window.__fewestFiles = 2;
      new MutationObserver(() => { window.__fewestFiles = Math.min(window.__fewestFiles, document.querySelectorAll('.attachment-title').length); })
        .observe(document.body, { childList: true, subtree: true });
    });
    await page.locator('.attachment-title').filter({ hasText: 'second.txt' }).click();
    await expect(dialog.getByText('File 2 of 2')).toBeVisible();
  } finally {
    // The list is read again after the held answer.
    const again = page.waitForResponse(response => response.request().method() === 'GET' && /\/attachments$/.test(response.url()));
    await read.release();
    await again;
  }
  await expect(dialog.locator('pre')).toHaveText('Second file');
  expect(await page.evaluate(() => window.__fewestFiles)).toBe(2);
});

test('an attachment response survives task projection replacement', async ({ page, instance }) => {
  const upload = await instance.api.post(`/api/tasks/${instance.projects[0].task.id}/attachments`, {
    headers: { 'Idempotency-Key': randomUUID(), 'X-File-Size': '12' },
    multipart: { file: { name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello world!') } },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  await openApp(page, instance, 'inbox');
  const taskKey = instance.projects[0].task.taskKey;
  await page.evaluate(key => { window.__attachmentTaskBefore = window.DATA.tasks.find(item => item.id === key); }, taskKey);
  const held = await holdResponses(page, '**/api/tasks/*/attachments');
  try {
    await page.goto(`${instance.url}/#/task/${taskKey}`);
    await held.started;
    await expect.poll(() => page.evaluate(key => window.DATA.tasks.find(item => item.id === key) !== window.__attachmentTaskBefore, taskKey)).toBeTruthy();
  } finally { await held.release(); }
  await expect(page.locator('.attachment-card')).toHaveCount(1);
  await expect(page.locator('.attachment-title')).toHaveAttribute('data-tip', 'retained.txt');
});
