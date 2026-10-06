// Attachments and their previews: Markdown, HTML, PDF and images.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test, expect, openApp, signIn, holdResponses } from '../support/test.mjs';

const pdf = readFileSync(new URL('../support/fixtures/document.pdf', import.meta.url));
const png = readFileSync(new URL('../../frontend/icons/icon-192.png', import.meta.url));

function largePdf(marker) {
  const xref = [...pdf.toString('latin1').matchAll(/startxref\s+(\d+)/g)].at(-1)[1];
  return Buffer.concat([pdf, Buffer.from('\n% ' + marker.repeat(12 * 1024 * 1024) + '\nstartxref\n' + xref + '\n%%EOF\n')]);
}

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
  await page.evaluate(key => App.nav('task/' + key), instance.projects[0].task.taskKey);
  await expect(page.locator('#attIn')).toBeAttached();
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

test('Markdown strips app actions and SVG navigation while keeping math, diagrams and footnotes', async ({ page, instance }) => {
  await openApp(page, instance);
  const markdown = `# Safe reader\n\n$x^2$\n\nReference[^1]\n\n[^1]: Footnote\n\n<svg viewBox="0 0 100 20"><a href="https://example.invalid/svg"><path d="M0 0h100v20H0z"/></a></svg>\n<span tabindex="0" data-reorder-task="${instance.projects[0].task.taskKey}" data-reorder-file="anything" data-action="logout" data-action-keydown="logout" data-args="[]">Gadget</span>\n[External](https://example.invalid/)` + '\n\n```mermaid\nsequenceDiagram\n A->>B: $$x^2$$\n```';
  await attach(page, 'gadget.md', 'text/markdown', markdown);
  await page.locator('.attachment-title').filter({ hasText: 'gadget.md' }).click();
  const body = page.locator('.markdown-body');
  await expect(body.locator('h1')).toHaveText('Safe reader');
  await expect(body.locator('[data-reorder-file],[data-reorder-task],[data-action],[data-action-keydown],[data-args],[tabindex],svg a')).toHaveCount(0);
  await expect(body.locator('.katex')).toBeVisible();
  await expect(body.locator('[data-footnote-ref]')).toBeVisible();
  const diagram = body.locator('.markdown-diagram img');
  await expect(diagram).toBeVisible();
  await expect.poll(() => diagram.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  // The sanitizer removes the HTML that Mermaid draws math with, so the label shows its text.
  expect(decodeURIComponent(await diagram.getAttribute('src'))).toContain('x^2');
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

test('PDF pages render, the source cache is bounded and sign-out releases it', async ({ page, instance }) => {
  await openApp(page, instance);
  await page.locator('#attIn').setInputFiles(['A', 'B', 'C'].map((marker, index) => ({ name: `cache-${index}.pdf`, mimeType: 'application/pdf', buffer: largePdf(marker) })));
  await expect(page.locator('.attachment-title')).toHaveCount(3, { timeout: 20_000 });
  const downloads = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/content')) downloads.push(request.url()); });
  const open = async index => {
    await page.locator('.attachment-title').filter({ hasText: `cache-${index}.pdf` }).click();
    const overlay = page.locator('.file-overlay:not([data-motion-exiting])');
    await expect(overlay.locator('.pdf-surface canvas')).toBeVisible({ timeout: 15_000 });
    await overlay.locator('[data-file-close]').click();
    await expect(page.locator('.file-overlay')).toHaveCount(0);
  };
  for (let i = 0; i < 3; i++) await open(i);
  expect(downloads).toHaveLength(3);
  await open(2);
  expect(downloads).toHaveLength(3);
  await open(0);
  expect(downloads).toHaveLength(4);
  await page.evaluate(() => App.logout());
  await page.locator('.confirmation-layer').getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, instance);
  await expect(page.locator('.attachment-title')).toHaveCount(3);
  await open(0);
  expect(downloads).toHaveLength(5);
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
