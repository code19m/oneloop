// The Inbox and live updates between signed-in clients.
import { test, expect, openApp, failUntilRetry, command } from '../support/test.mjs';

test('two signed-in clients receive Inbox creation and read updates over live events', { tag: '@smoke' }, async ({ page, browser, browserName, instance, allowedConsoleErrors }) => {
  const second = await browser.newContext();
  const other = await second.newPage();
  try {
    await openApp(page, instance, 'inbox');
    await openApp(other, instance, 'inbox');
    const userId = instance.identity.user.id;
    const text = '@Smoke Owner Browser live Inbox';
    await command(instance.writer, 'discussion.comment.create', {
      taskId: instance.projects[0].task.id, content: text,
      mentions: [{ kind: 'user', userId, startOffset: 0, endOffset: 12, label: '@Smoke Owner' }],
    });
    const firstRow = page.locator('.inbox-row').filter({ hasText: text });
    const secondRow = other.locator('.inbox-row').filter({ hasText: text });
    await expect(firstRow).toBeVisible();
    await expect(secondRow).toBeVisible();
    await expect(firstRow).toHaveClass(/unread/);
    await secondRow.getByRole('button', { name: 'Mark notification read', exact: true }).click();
    await expect(firstRow).toHaveClass(/\bread\b/);
    await expect(secondRow).toHaveClass(/\bread\b/);
  } finally {
    // Playwright's WebKit inserts a style element while closing a page, which the app's policy refuses.
    if (browserName === 'webkit') allowedConsoleErrors.push(/Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/);
    await second.close().catch(() => {});
  }
});

test('a fresh page load shows unread notifications on the Inbox button', async ({ page, instance }) => {
  const userId = instance.identity.user.id;
  await command(instance.writer, 'discussion.comment.create', {
    taskId: instance.projects[0].task.id, content: '@Smoke Owner Unread on load',
    mentions: [{ kind: 'user', userId, startOffset: 0, endOffset: 12, label: '@Smoke Owner' }],
  });
  await openApp(page, instance, 'board');
  await expect(page.locator('.inbox-nav')).toHaveAttribute('aria-label', 'Inbox, 1 unread');
  await expect(page.locator('[data-inbox-dot]').first()).toBeVisible();
});

test('a failed initial Inbox read has a local Retry and no false empty state', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/500 .*\/api\/inbox\?/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await failUntilRetry(page, '**/api/inbox?*', { status: 500, body: JSON.stringify({ error: { code: 'internal', message: 'Test read failure' } }) }, { gate });
  try {
    await openApp(page, instance, 'inbox');
    await expect(page.getByText('Loading notifications', { exact: true })).toBeAttached();
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toHaveCount(0);
    release();
    await expect(page.getByRole('heading', { name: 'Could not load notifications' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toHaveCount(0);
    await page.locator('.inbox-page').getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Could not load notifications' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible();
  } finally { release(); }
});

test('repeated Inbox unread toggles issue exactly one read per click', async ({ page, instance }) => {
  await openApp(page, instance, 'inbox');
  await expect(page.locator('.inbox-empty')).toBeVisible();
  const reads = [];
  page.on('request', r => { if (new URL(r.url()).pathname === '/api/inbox') reads.push(r.url()); });
  const toggle = page.locator('.inbox-unread-filter');
  for (let i = 0; i < 12; i++) {
    const answered = page.waitForResponse(r => new URL(r.url()).pathname === '/api/inbox');
    await toggle.click();
    await answered;
    await expect(toggle).toHaveAttribute('aria-pressed', String(i % 2 === 0));
    // A duplicate read would have been sent before the first read was answered.
    expect(reads).toHaveLength(i + 1);
  }
});
