// Knowledge: one folder of a Git repository, synced over HTTPS from a local Git
// host by the real `git` program, then read, searched and previewed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test as base, expect, openApp, command, scan } from '../support/test.mjs';
import { startGitServer } from '../support/git-server.mjs';

const png = readFileSync(new URL('../../frontend/icons/icon-192.png', import.meta.url));
const pdf = readFileSync(new URL('../support/fixtures/document.pdf', import.meta.url));
const scratch = fileURLToPath(new URL('../../target/e2e-instances/', import.meta.url));

const handbook = {
  'docs/README.md': '# Handbook\n\nStart with [onboarding](guides/onboarding.md).\n\n![Logo](logo.png)\n\n## Setup\n\nInstall the tools.\n',
  'docs/guides/onboarding.md': '# Joining\n\n## Before you start\n\nAsk for access.\n\n## First day\n\nMeet the team and read the handbook.\n',
  'docs/logo.png': png,
  'docs/examples/page.html': '<!doctype html><h1>Sandbox page</h1><img alt="Outside" src="https://outside.invalid/image.png"><script>document.querySelector("h1").textContent = "Script ran"</script>',
  'docs/examples/document.pdf': pdf,
  'docs/brand-kit.zip': Buffer.from('PK\u0005\u0006' + '\0'.repeat(18), 'latin1'),
  'src/main.rs': 'fn main() {}\n',
};

const test = base.extend({
  gitHost: [async ({}, use) => {
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(`${scratch}git-`);
    const host = await startGitServer(directory);
    try { await use(host); } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
  }, { scope: 'worker' }],
  // The server trusts the Git host's certificate as it would a private authority's.
  instanceEnvironment: async ({ gitHost }, use) => use({ GIT_SSL_CAINFO: gitHost.caFile }),
});

/** Connect through the API and wait for the first sync. */
async function connected(instance, gitHost, files = handbook) {
  const name = `handbook-${randomUUID().slice(0, 8)}`;
  const url = await gitHost.repository(name, files);
  const projectId = instance.projects[0].project.id;
  await command(instance.api, 'knowledge.connect', { projectId, url, branch: 'main', folder: 'docs' });
  await expect.poll(async () => (await (await instance.api.get(`/api/projects/${projectId}/knowledge`)).json()).state, { timeout: 30_000 }).toBe('ready');
  return { name, projectId };
}

test('heading links scroll into view in the inline Knowledge reader and full view', async ({ page, instance, gitHost }) => {
  const guide = '# Guide\n\n[Jump to final section](#final-section)\n\n'
    + 'A paragraph before the target.\n\n'.repeat(70) + '## Final section\n\nThe destination.\n\n'
    + 'A paragraph after the target.\n\n'.repeat(20);
  const { projectId } = await connected(instance, gitHost, { 'docs/guide.md': guide });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page, instance, `knowledge/${projectId}/blob/guide.md`);
  const route = page.url();
  for (const full of [false, true]) {
    if (full) await page.getByRole('button', { name: 'Open full view' }).click();
    const reader = page.locator(full ? '.knowledge-full-view .markdown-scroll' : '.knowledge-reader');
    const heading = reader.locator('#md-final-section');
    await expect(heading).toBeAttached();
    await expect(heading).not.toBeInViewport();
    await reader.getByRole('link', { name: 'Jump to final section' }).click();
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect(heading).toBeFocused();
    await expect(page).toHaveURL(route);
  }
});

test('an administrator connects a private repository and reads, searches and opens its files', { tag: '@smoke' }, async ({ page, instance, gitHost }) => {
  const url = await gitHost.repository(`private-${randomUUID().slice(0, 8)}`, handbook, { token: 'e2e-access-token' });
  // Scans measure settled colors, as in the accessibility journeys.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page, instance, 'knowledge');
  await expect(page.getByRole('heading', { name: 'A home for project knowledge' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect repository' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect repository' });
  await expect(dialog).toBeVisible();
  await scan(page, 'Connect repository');
  await dialog.getByLabel('Repository URL').fill(url);
  await expect(dialog.getByLabel('Branch')).toHaveValue('main');
  await expect(dialog.getByLabel('Folder')).toHaveValue('docs');
  await dialog.getByLabel('Access token').fill('e2e-access-token');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog).toBeHidden();

  const reader = page.locator('.knowledge-reader');
  await expect(reader.getByRole('heading', { name: 'Handbook', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.knowledge-file-list tbody tr a > span:last-child')).toHaveText(['examples', 'guides', 'brand-kit.zip', 'logo.png', 'README.md']);
  await expect.poll(() => reader.locator('.markdown-body img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await scan(page, 'Knowledge folder');

  await reader.getByRole('link', { name: 'onboarding' }).click();
  await expect(reader.getByRole('heading', { name: 'Joining', exact: true })).toBeVisible();
  await expect(page.locator('.knowledge-breadcrumb')).toHaveText('docs/guides/onboarding.md');

  await page.locator('.knowledge-reader').focus();
  await page.keyboard.press('/');
  const search = page.getByRole('searchbox', { name: 'Search knowledge' });
  await expect(search).toBeFocused();
  await search.fill('first day');
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(results.locator('.knowledge-hit-heading')).toHaveText('First day');
  await scan(page, 'Knowledge search');
  await search.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/blob\/guides\/onboarding\.md\?section=first-day$/);
  await expect(results).toBeHidden();

  await page.getByRole('button', { name: 'Open full view' }).click();
  const full = page.getByRole('dialog', { name: 'onboarding.md' });
  await expect(full.getByRole('heading', { name: 'First day' })).toBeVisible();
  await full.getByRole('button', { name: 'Close file preview' }).click();
  await expect(full).toBeHidden();

  await page.evaluate(() => App.nav('settings'));
  const row = page.locator('.knowledge-source-row');
  await expect(row).toContainText(new URL(url).host);
  await expect(row.locator('.knowledge-source-status')).toHaveText(/^Synced /);
  await row.getByRole('button', { name: 'Manage connection' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit repository' }).getByText('Token saved')).toBeVisible();
});

test('synced HTML stays sandboxed, PDFs and images preview inline, and other files download only', async ({ page, context, instance, gitHost, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/Content Security Policy|Content-Security-Policy|content security policy|violates.*policy|sandbox|Sandbox|Blocked script/i);
  const outside = [];
  context.on('request', request => { if (request.url().startsWith('https://outside.invalid')) outside.push(request); });
  const { projectId } = await connected(instance, gitHost);
  await openApp(page, instance, `knowledge/${projectId}/blob/examples/page.html`);
  const card = page.locator('.knowledge-preview');
  await expect(card.locator('.html-preview')).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('.knowledge-preview .html-preview').getByRole('heading', { name: 'Sandbox page' })).toBeVisible();
  await page.frames().find(frame => frame.url().includes('/knowledge/preview/html')).waitForLoadState('load');
  // Chromium also reports loads that the preview's policy blocked.
  for (const request of outside) await request.response();
  expect(outside.filter(request => !/^csp$|BLOCKED_BY_CSP/.test(request.failure()?.errorText ?? '')), 'nothing loads from other sites').toEqual([]);
  await page.evaluate(id => { location.hash = `#/knowledge/${id}/blob/examples/document.pdf`; }, projectId);
  await expect(card.locator('.pdf-surface canvas')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(id => { location.hash = `#/knowledge/${id}/blob/logo.png`; }, projectId);
  await expect.poll(() => card.locator('.image-stage img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await page.evaluate(id => { location.hash = `#/knowledge/${id}/blob/brand-kit.zip`; }, projectId);
  await expect(card).toContainText('Preview is not available for this format');
  await expect(card.getByRole('button', { name: 'Open full view' })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await card.getByRole('link', { name: 'Download brand-kit.zip' }).click();
  expect((await download).suggestedFilename()).toBe('brand-kit.zip');
});

test('a failed sync keeps the last files readable until an administrator retries', async ({ page, instance, gitHost }) => {
  const { name, projectId } = await connected(instance, gitHost);
  gitHost.unavailable(name);
  await command(instance.api, 'knowledge.sync', { projectId });
  await expect.poll(async () => (await (await instance.api.get(`/api/projects/${projectId}/knowledge`)).json()).state, { timeout: 30_000 }).toBe('failed');
  await openApp(page, instance, 'knowledge');
  const banner = page.locator('.knowledge-banner');
  await expect(banner).toContainText('Knowledge may be out of date');
  await expect(page.locator('.knowledge-reader').getByRole('heading', { name: 'Handbook', exact: true })).toBeVisible();
  gitHost.unavailable(name, false);
  await banner.getByRole('button', { name: 'Retry sync' }).click();
  await expect(banner).toBeHidden({ timeout: 30_000 });
});
