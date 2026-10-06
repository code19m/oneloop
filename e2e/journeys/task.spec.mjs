// The task page: editing, blocks, discussion and the activity feed.
import { test, expect, openApp, waitForLiveChannel, holdResponses, command, useTheme } from '../support/test.mjs';

test('the task page integrates comments and attachments', { tag: '@smoke' }, async ({ page, instance }) => {
  await useTheme(page, 'dark');
  await openApp(page, instance);
  await expect(page.getByLabel('Task title')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Attachments', exact: true })).toBeVisible();
  await expect(page.locator('.attachment-dropzone')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.locator('#cmtIn')).toBeVisible();
});

test('the task page keeps usable controls on a narrow phone viewport', async ({ page, instance }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, instance);
  await expect(page.getByLabel('Toggle sidebar')).toBeVisible();
  await expect(page.locator('.task-page')).toBeVisible();
  await expect(page.locator('#cmtIn')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('Enter posts a comment and a reply closes its inline composer after sending', { tag: '@smoke' }, async ({ page, instance }) => {
  await openApp(page, instance);
  const composer = page.locator('#cmtIn');
  await composer.fill('Browser baseline root comment');
  await composer.press('Enter');
  const root = page.locator('article[data-comment]').filter({ hasText: 'Browser baseline root comment' });
  await expect(root).toBeVisible();
  await root.locator('.reply-action').click();
  await expect(page.getByText('Replying to', { exact: false })).toBeVisible();
  await page.locator('#cmtIn').fill('Browser baseline reply');
  await page.locator('#cmtIn').press('Enter');
  await expect(page.getByText('Replying to', { exact: false })).toBeHidden();
  await expect(page.locator('article[data-comment]').filter({ hasText: 'Browser baseline reply' })).toBeVisible();
  await expect(page.locator('#cmtIn')).toBeVisible();
});

test('an unsent comment asks before another page or a reload discards it', async ({ page, instance }) => {
  await openApp(page, instance);
  const composer = page.locator('#cmtIn');
  await composer.fill('Half a thought');
  await page.getByRole('button', { name: 'Back to Board' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Discard changes?' });
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(composer).toHaveValue('Half a thought');
  // The browser asks before a reload; staying keeps the text.
  const prompts = [];
  page.on('dialog', dialog => { prompts.push(dialog.type()); void dialog.dismiss(); });
  await page.evaluate(() => { location.reload(); });
  await expect.poll(() => prompts).toEqual(['beforeunload']);
  await expect(composer).toHaveValue('Half a thought');
  await page.getByRole('button', { name: 'Back to Board' }).click();
  await ask.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('.board')).toBeVisible();
  // Nothing typed is left, so a reload goes ahead without asking.
  await page.reload();
  await expect(page.locator('.board')).toBeVisible();
  expect(prompts).toEqual(['beforeunload']);
});

test('a failed block submission keeps its reason and the retry saves once', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/500.*\/api\/commands|Failed to load resource.*\/api\/commands/);
  await openApp(page, instance);
  let attempts = 0;
  await page.route('**/api/commands', route => {
    if (route.request().postDataJSON()?.operation === 'task.block' && ++attempts === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal_error', message: 'Fixture failure' } }) });
    return route.continue();
  });
  await page.evaluate(key => App.openModal('block', key), instance.projects[0].task.taskKey);
  const reason = page.locator('#block-reason');
  await reason.fill('Keep this reason');
  await reason.press('Enter');
  await expect(page.locator('.save-feedback')).toBeVisible();
  await expect(reason).toHaveValue('Keep this reason');
  expect(await page.evaluate(() => DATA.tasks.find(task => task.id === App.context().taskId)?.block ?? null)).toBeNull();
  await page.evaluate(() => OneloopRecovery.reconnect(true));
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.task-page')).toContainText('Keep this reason');
  expect(attempts).toBe(2);
});

test('unchanged task saves stay quiet and send no command', async ({ page, instance }) => {
  await openApp(page, instance);
  const commands = [];
  page.on('request', request => { if (request.url().endsWith('/api/commands')) commands.push(request); });
  await page.evaluate(key => { const task = DATA.tasks.find(task => task.id === key); App.updTask(key, 'title', task.title); }, instance.projects[0].task.taskKey);
  await expect(page.locator('.task-save-status')).toHaveText('');
  expect(commands).toEqual([]);
});

test('live metadata, delayed reads and completed saves preserve task typing and pickers', async ({ page, instance }) => {
  await openApp(page, instance);
  const description = page.locator('#task-description'), title = page.locator('.tp-title');
  await description.fill('Typing before a metadata update');
  const held = await holdResponses(page, '**/api/bootstrap**');
  try {
    await command(instance.writer, 'track.create', { projectId: instance.projects[0].project.id, name: 'Remote track' });
    await held.started;
    await description.pressSequentially(' and while it loads');
    await held.release();
    await expect(description).toHaveValue('Typing before a metadata update and while it loads');
    await expect(description).toBeFocused();
    expect((await (await instance.api.get(`/api/tasks/${instance.projects[0].task.id}`)).json()).description).toBe('');
    await title.click();
    await title.fill('Still typing after description saved');
    await expect.poll(async () => ((await instance.api.get(`/api/tasks/${instance.projects[0].task.id}`)).json()).then(t => t.description)).toBe('Typing before a metadata update and while it loads');
    await title.pressSequentially(' Z');
    await expect(title).toHaveValue('Still typing after description saved Z');
    await expect(title).toBeFocused();
  } finally { await held.release(); }
  // A slow press spans the deferred background render, which must keep its target.
  await page.evaluate(() => App.refreshBackground());
  await page.locator('[data-date-key="tpDl"] button').click({ delay: 150 });
  const picker = page.locator('.pop');
  await expect(picker).toBeVisible();
  const refreshed = page.waitForResponse(r => r.url().includes('/api/bootstrap'));
  await command(instance.writer, 'track.create', { projectId: instance.projects[0].project.id, name: 'Another remote track' });
  await refreshed;
  await expect(picker).toBeVisible();
});

test('a task evicted from the Board keeps its attachments and discussion after return', async ({ page, instance }) => {
  const { project, epic } = instance.projects[0];
  let task;
  for (let i = 0; i < 52; i++) [task] = (await command(instance.api, 'task.create', { projectId: project.id, epicId: epic.id, title: `Pagination ${i}` })).entities;
  await openApp(page, instance, `task/${task.taskKey}`);
  await page.locator('#attIn').setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('retained') });
  await expect(page.locator('.attachment-title')).toHaveCount(1);
  await page.locator('#cmtIn').fill('Retained comment');
  await page.locator('#cmtIn').press('Enter');
  await expect(page.locator('.comment-conversation')).toHaveCount(1);
  await page.locator('.nav-item[title=Board]').click();
  await expect(page.locator('.board')).toBeVisible();
  await expect.poll(() => page.evaluate(id => DATA.tasks.some(t => t.internalId === id), task.id)).toBe(false);
  await page.evaluate(key => location.hash = `#/task/${key}`, task.taskKey);
  await expect(page.locator('.attachment-title')).toHaveCount(1);
  await expect(page.locator('.comment-conversation')).toContainText('Retained comment');
});

test('comment readers avoid duplicate landmarks and focus only bounded bodies', async ({ page, instance }) => {
  const task = instance.projects[0].task;
  await command(instance.api, 'discussion.comment.create', { taskId: task.id, content: 'Short comment', mentions: [] });
  await command(instance.api, 'discussion.comment.create', { taskId: task.id, content: 'Long comment\n'.repeat(60), mentions: [] });
  await openApp(page, instance, `task/${task.taskKey}`);
  const bodies = page.locator('.comment-body-content');
  await expect(bodies).toHaveCount(2);
  await expect(bodies.first()).toHaveAttribute('role', 'group');
  await expect(bodies.first()).not.toHaveAttribute('tabindex');
  await expect(bodies.first()).toHaveAccessibleName(/Smoke Owner/);
  await expect(bodies.last()).toHaveAttribute('tabindex', '0');
  await expect(page.getByRole('region', { name: 'Comment', exact: true })).toHaveCount(0);
  await page.locator('.comment-reading').last().getByRole('button', { name: 'Show more' }).click();
  await expect(bodies.last()).toHaveAttribute('tabindex', '0');
});

test('feed updates reuse unchanged comments and animate only connected document nodes', async ({ page, context, browserName, instance }) => {
  await page.addInitScript(() => {
    window.invalidAnimations = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { if (!this.isConnected || this.ownerDocument !== document) window.invalidAnimations++; return animate.apply(this, args); };
  });
  const task = instance.projects[0].task;
  for (let i = 0; i < 105; i++) await command(instance.writer, 'discussion.comment.create', { taskId: task.id, content: `Comment ${i}`, mentions: [] });
  await openApp(page, instance);
  await expect(page.locator('.comment-conversation')).toHaveCount(50);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Load older activity' }).click();
    await expect(page.locator('.comment-conversation')).toHaveCount(i === 0 ? 100 : 105);
  }
  // Background refresh retains the already loaded history window.
  await page.evaluate(() => OneloopCollaboration.loadTaskPage(App.context().taskId));
  await expect(page.locator('.comment-conversation')).toHaveCount(105);
  expect(await page.evaluate(() => window.invalidAnimations)).toBe(0);
  // A new page starts a fresh window for the independent node/listener budget.
  await page.reload();
  await waitForLiveChannel(page);
  await expect(page.locator('.comment-conversation')).toHaveCount(50);
  const liveComment = async i => {
    await command(instance.writer, 'discussion.comment.create', { taskId: task.id, content: `Live comment ${i}`, mentions: [] });
    await expect(page.locator('.timeline')).toContainText(`Live comment ${i}`);
  };
  // The first live comment arrives after the event stream's opening
  // reconciliation, which may legitimately reload the feed.
  await liveComment(0);
  const row = await page.locator('.comment-conversation').last().elementHandle();
  for (let i = 1; i < 20; i++) {
    await liveComment(i);
    expect(await row.evaluate(el => el.isConnected)).toBe(true);
  }
  expect(await page.evaluate(() => window.invalidAnimations)).toBe(0);
  if (browserName !== 'chromium') return;
  // New live comments legitimately extend the retained window. Measure leaks
  // across repeated reads of that same window, without adding more rows.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => {
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
    await cdp.send('HeapProfiler.collectGarbage');
    return Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  };
  const baseline = await metrics();
  for (let i = 0; i < 20; i++) await page.evaluate(() => OneloopCollaboration.loadTaskPage(App.context().taskId));
  const after = await metrics();
  expect(after.Nodes).toBeLessThan(baseline.Nodes * 1.15 + 100);
  expect(after.JSEventListeners).toBeLessThan(baseline.JSEventListeners * 1.15 + 20);
  await cdp.detach();
});

test('Load older activity still works when a live comment arrives during the click', async ({ page, instance }) => {
  const task = instance.projects[0].task;
  for (let i = 0; i < 55; i++) await command(instance.writer, 'discussion.comment.create', { taskId: task.id, content: `Comment ${i}`, mentions: [] });
  await openApp(page, instance);
  await expect(page.locator('.comment-conversation')).toHaveCount(50);
  await expect(page.locator('.timeline')).not.toContainText('Comment 0');
  await page.getByRole('button', { name: 'Load older activity' }).hover();
  await page.mouse.down();
  // The live update refreshes the timeline between press and release.
  await command(instance.writer, 'discussion.comment.create', { taskId: task.id, content: 'Live during the click', mentions: [] });
  await expect(page.locator('.timeline')).toContainText('Live during the click');
  await page.mouse.up();
  await expect(page.locator('.timeline')).toContainText('Comment 0');
});

test('large task and Inbox renderer workloads preserve unchanged rows', async ({ page, instance }, testInfo) => {
  // Isolate renderer cost with synthetic projections in a real production page;
  // this measures neither server pagination nor notification delivery throughput.
  await page.addInitScript(() => {
    let controller;
    Object.defineProperty(window, 'OneloopCollaboration', {
      configurable: true, get: () => controller, set(value) {
        const bind = value.bind;
        value.bind = function (app, hooks, facade) { window.scaleFacade = facade; return bind.call(this, app, hooks, facade); };
        controller = value;
      },
    });
  });
  await openApp(page, instance);
  const taskMetrics = await page.evaluate(() => {
    const task = DATA.tasks.find(item => item.id === App.context().taskId), who = DATA.session.userId, ts = Date.now() - 60000;
    task.comments = Array.from({ length: 500 }, (_, index) => ({ id: 'scale-comment-' + index, who, ts: ts + index, text: 'A library review comment. '.repeat(10), mentions: [], parentId: null }));
    const meta = { loaded: true, loading: false, error: false, hasMore: false };
    const start = performance.now(); scaleFacade.taskPage(task.id, meta); const paintMs = performance.now() - start;
    const first = document.querySelector('[data-feed-key="comment-scale-comment-0"]');
    task.comments[499].text = 'Changed final comment';
    const update = performance.now(); scaleFacade.taskPage(task.id, meta);
    return { paintMs, updateMs: performance.now() - update, rows: document.querySelectorAll('[data-comment]').length, reused: first === document.querySelector('[data-feed-key="comment-scale-comment-0"]') };
  });
  expect(taskMetrics.rows).toBe(500);
  expect(taskMetrics.reused).toBe(true);
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.locator('.inbox-page')).toBeVisible();
  const inboxMetrics = await page.evaluate(() => {
    const task = DATA.tasks[0], project = DATA.projects[0], ts = Date.now();
    const item = index => ({ id: 'scale-notice-' + index, recipientId: DATA.session.userId, actorId: DATA.session.userId, projectId: project.id, taskId: task.id, reason: 'assigned', createdAt: ts - index, readAt: null, archivedAt: null, destinationAvailable: true });
    DATA.notifications = Array.from({ length: 2000 }, (_, index) => item(index));
    const meta = { loaded: true, loading: false, error: false, filteredCount: 2050, unreadCount: 2050, nextCursor: 'scale-more' };
    const start = performance.now(); scaleFacade.inboxPage(meta); const paintMs = performance.now() - start;
    const first = document.querySelector('[data-notification-id]');
    const items = Array.from({ length: 50 }, (_, index) => item(2000 + index));
    DATA.notifications.push(...items);
    const append = performance.now(); scaleFacade.inboxPage({ ...meta, append: true, items }); const appendMs = performance.now() - append;
    const update = performance.now(); DATA.notifications.at(-1).readAt = ts; scaleFacade.inboxPage({ ...meta, unreadCount: 2049 });
    return { paintMs, appendMs, updateMs: performance.now() - update, rows: document.querySelectorAll('.inbox-row').length, reused: first === document.querySelector('[data-notification-id]') };
  });
  expect(inboxMetrics.rows).toBe(2050);
  expect(inboxMetrics.reused).toBe(true);
  // Timings are diagnostics for reviewers, not assertions.
  await testInfo.attach('renderer-scale.json', { body: JSON.stringify({ task: taskMetrics, inbox: inboxMetrics }, null, 2), contentType: 'application/json' });
});

test('a live change re-reads the task page in the background, so it does not count as use', async ({ page, instance }) => {
  const { task } = instance.projects[0];
  await openApp(page, instance);
  await expect(page.locator('.timeline')).toBeVisible();
  await expect(page.locator('.attachment-dropzone')).toBeVisible();
  const reads = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.startsWith('/api/') && path !== '/api/events') reads.push({ path, background: request.headers()['x-oneloop-background'] === '1' });
  });
  await command(instance.writer, 'task.update', { taskId: task.id, title: 'Renamed elsewhere' }, task.revision);
  await expect(page.locator('.tp-title')).toHaveValue('Renamed elsewhere');
  // The discussion is read again twice: for the live change, and after the task was replaced.
  await expect.poll(() => reads.filter(read => read.path.endsWith('/comments')).length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => reads.filter(read => read.path.endsWith('/attachments')).length).toBeGreaterThanOrEqual(1);
  expect(reads.filter(read => !read.background)).toEqual([]);
});

test('descriptions and comments take each paragraph\'s direction from its own text', async ({ page, instance }) => {
  const { task } = instance.projects[0];
  await command(instance.api, 'task.update', { taskId: task.id, description: 'وصف المهمة بالعربية.\nAn English line.' }, task.revision);
  for (const content of ['تعليق باللغة العربية، هل يظهر بشكل صحيح؟', 'An English comment.']) {
    await command(instance.api, 'discussion.comment.create', { taskId: task.id, content, mentions: [] });
  }
  await openApp(page, instance);
  // Where a text sits in its box: right-aligned when it reads right to left.
  const sides = locator => locator.evaluate(element => {
    const range = document.createRange(), box = element.getBoundingClientRect();
    range.selectNodeContents(element);
    return [...range.getClientRects()].map(line => Math.round(box.right - line.right) < Math.round(line.left - box.left) ? 'right' : 'left');
  });
  await expect.poll(() => sides(page.locator('.cmt-body').filter({ hasText: 'تعليق' }))).toEqual(['right']);
  expect(await sides(page.locator('.cmt-body').filter({ hasText: 'An English comment.' }))).toEqual(['left']);
  const description = await page.locator('#task-description').evaluate(element => getComputedStyle(element).unicodeBidi);
  expect(description).toBe('plaintext');
});

test('Undo brings a deleted task back to the Board', async ({ page, instance, allowedConsoleErrors }) => {
  // A live read of the open task page can still be on its way when it is deleted.
  allowedConsoleErrors.push(/404 .*\/api\/tasks\//);
  const key = instance.projects[0].task.taskKey;
  await openApp(page, instance);
  await page.getByRole('button', { name: 'Task actions' }).click();
  await page.locator('#action-menu').getByText('Delete task').click();
  await expect(page.locator('#confirmation-description')).toContainText('You can undo this right after');
  await page.locator('[data-confirm-accept]').click();
  const deleted = page.locator('#toast-region .toast').filter({ hasText: `${key} deleted` });
  await expect(deleted).toBeVisible();
  await expect(page.locator(`.board .card[data-task="${key}"]`)).toHaveCount(0);
  await deleted.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('#toast-region')).toContainText(`${key} restored`);
  await expect(page.locator(`.board .card[data-task="${key}"]`)).toBeVisible();
  await page.reload();
  await expect(page.locator(`.board .card[data-task="${key}"]`)).toBeVisible();
});
