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

test('Ctrl+S saves the task title where it is typed and never saves the page', { tag: '@smoke' }, async ({ page, instance }) => {
  await openApp(page, instance);
  await page.evaluate(() => window.addEventListener('keydown', event => { window.savePagePrevented = event.defaultPrevented; }));
  const title = page.getByLabel('Task title');
  await title.fill('Saved with the shortcut');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.task-save-status')).toHaveText('Saved');
  await expect(title).toBeFocused();
  expect(await page.evaluate(() => window.savePagePrevented)).toBe(true);
  expect((await (await instance.api.get(`/api/tasks/${instance.projects[0].task.id}`)).json()).title).toBe('Saved with the shortcut');
});

test('a description shows as Markdown, opens for editing where it is clicked, saves on Escape and links to app pages in place', async ({ page, instance }) => {
  const { project, task } = instance.projects[0];
  await command(instance.api, 'task.update', { taskId: task.id, description: '## Plan\n\nSee [the Board](#/board) and **this**.' }, task.revision);
  await openApp(page, instance);
  const reader = page.locator('#task-description-content');
  await expect(reader.getByRole('heading', { name: 'Plan' })).toBeVisible();
  // The caret lands where the click does, just before "this".
  await reader.getByText('this').click({ position: { x: 1, y: 8 } });
  const editor = page.locator('#task-description');
  await expect(editor).toBeFocused();
  await editor.pressSequentially('all of ');
  await editor.press('Escape');
  await expect(page.getByRole('button', { name: 'Edit description' })).toBeFocused();
  await expect(reader).toContainText('all of this.');
  // A double-click selects the word it lands on.
  await reader.getByRole('heading', { name: 'Plan' }).dblclick();
  await expect(editor).toBeFocused();
  await editor.pressSequentially('Steps');
  await editor.press('Escape');
  await expect(reader.getByRole('heading', { name: 'Steps' })).toBeVisible();
  expect((await (await instance.api.get(`/api/tasks/${task.id}`)).json()).description).toBe('## Steps\n\nSee [the Board](#/board) and **all of this**.');
  await reader.getByRole('link', { name: 'the Board' }).click();
  // An address without a project opens the Board of the project on screen.
  await expect(page).toHaveURL(new RegExp(`#/board/${project.id}$`));
  await expect(page.locator('.board')).toBeVisible();
});

test('a click in a long description opens the editor with its caret in view, near the end as near the top', async ({ page, instance }) => {
  const { task } = instance.projects[0];
  const lines = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} of the plan.`).join('\n\n');
  await command(instance.api, 'task.update', { taskId: task.id, description: lines }, task.revision);
  await openApp(page, instance);
  await page.getByRole('button', { name: 'Show more' }).click();
  const reader = page.locator('#task-description-content'), editor = page.locator('#task-description');
  // The reader grows to its full height first; a click while it grows lands on another line.
  await reader.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await reader.getByText('Line 55 of the plan.').click({ position: { x: 1, y: 8 } });
  await expect(editor).toBeFocused();
  // Line 55 of 60 shows near the end of the editor's text.
  expect(await editor.evaluate(field => field.scrollTop > (field.scrollHeight - field.clientHeight) / 2)).toBe(true);
  await page.keyboard.type('First ');
  await expect(editor).toHaveValue(/\n\nFirst Line 55 of the plan\./);
  await editor.press('Escape');
  await reader.getByText('Line 3 of the plan.').click({ position: { x: 1, y: 8 } });
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(field => field.scrollTop)).toBe(0);
});

test('a footnote link in a description brings its footnote into view, and its back link the reference', async ({ page, instance }) => {
  const { task } = instance.projects[0];
  await command(instance.api, 'task.update', { taskId: task.id, description: 'See the note.[^1]\n\nOne.\n\nTwo.\n\nThree.\n\n[^1]: The note.' }, task.revision);
  await page.setViewportSize({ width: 1280, height: 360 });
  await openApp(page, instance);
  const reader = page.locator('#task-description-content'), reference = reader.locator('[data-footnote-ref]'), note = reader.locator('.footnotes li');
  await expect(reference).toBeInViewport();
  await expect(note).not.toBeInViewport();
  await reference.click();
  await expect(note).toBeInViewport();
  await note.locator('[data-footnote-backref]').click();
  await expect(reference).toBeInViewport();
});

test('the task page keeps usable controls on a narrow phone viewport', async ({ page, instance }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, instance);
  await expect(page.getByLabel('Toggle sidebar')).toBeVisible();
  await expect(page.locator('.task-page')).toBeVisible();
  await expect(page.locator('#cmtIn')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('Enter posts a comment, and a reply shows last in the chat with the comment it answers', { tag: '@smoke' }, async ({ page, instance }) => {
  await openApp(page, instance);
  const composer = page.locator('#cmtIn');
  await composer.fill('Browser baseline root comment');
  await composer.press('Enter');
  await expect(page.locator('article[data-comment]').filter({ hasText: 'Browser baseline root comment' })).toBeVisible();
  // The reply quotes the root's text too, so the root is held by its ID.
  const root = page.locator(`article[data-comment="${await page.locator('article[data-comment]').last().getAttribute('data-comment')}"]`);
  await expect(page.locator('.comment-row.is-own')).toHaveCount(1);
  await root.locator('.reply-action').click();
  await expect(page.locator('.comment-composer-home').getByText('Replying to', { exact: false })).toBeVisible();
  await page.locator('#cmtIn').fill('Browser baseline reply');
  await page.locator('#cmtIn').press('Enter');
  await expect(page.getByText('Replying to', { exact: false })).toBeHidden();
  const reply = page.locator('article[data-comment]').last();
  await expect(reply).toContainText('Browser baseline reply');
  await expect(reply.locator('.reply-reference')).toContainText('Browser baseline root comment');
  await expect(page.locator('.comment-composer-home #cmtIn')).toBeVisible();
  await reply.locator('.reply-reference').click();
  await expect(root).toBeFocused();
});

test('a comment whose answer is lost is saved once, also when the next one was typed meanwhile', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/ERR_FAILED .*\/api\/commands\b/);
  const { task } = instance.projects[0];
  let typed, first = true;
  const nextTyped = new Promise(resolve => { typed = resolve; });
  await page.route('**/api/commands', async route => {
    if (!first || route.request().postDataJSON().operation !== 'discussion.comment.create') return route.continue();
    first = false;
    // The comment reaches the server, but its answer is lost once the next one is typed.
    await route.fetch(); await nextTyped; await route.abort('failed');
  });
  await openApp(page, instance);
  const composer = page.locator('#cmtIn');
  await composer.fill('First comment');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await composer.fill('Second comment');
  typed();
  await expect(page.locator('#toast-region')).toContainText('Connection restored');
  await expect(composer).toHaveValue('Second comment');
  await composer.press('Enter');
  // The first comes back alone once the box is empty; sent again, the server knows it.
  await expect(composer).toHaveValue('First comment');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(page.locator('article[data-comment]').filter({ hasText: 'First comment' })).toHaveCount(1);
  const listed = await (await instance.api.get(`/api/discussion/tasks/${task.id}/comments?limit=50`)).json();
  expect(listed.items.map(item => item.content).sort()).toEqual(['First comment', 'Second comment']);
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

test('Cancel after Back keeps the unsent comment and every page behind it', async ({ page, instance }) => {
  const { task, project } = instance.projects[0];
  await openApp(page, instance, 'board');
  await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/roadmap/${project.id}$`));
  await page.evaluate(key => { location.hash = `#/task/${key}`; }, task.taskKey);
  const composer = page.locator('#cmtIn');
  await composer.fill('Half a thought');
  const ask = page.getByRole('alertdialog', { name: 'Discard changes?' });
  await page.goBack({ waitUntil: 'commit' });
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${task.taskKey}$`));
  await expect(composer).toHaveValue('Half a thought');
  // History is as it was: Back still leads to the Roadmap, then to the Board.
  await page.goBack({ waitUntil: 'commit' });
  await ask.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/roadmap/${project.id}$`));
  await expect(page.locator('.rm-canvas')).toBeVisible();
  await page.goBack({ waitUntil: 'commit' });
  await expect(page).toHaveURL(new RegExp(`#/board/${project.id}$`));
  await expect(page.locator('.board')).toBeVisible();
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
  await page.evaluate(() => Recovery.reconnect(true));
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

test('moving a task to another track by keyboard takes it out of its epic and says why', async ({ page, instance }) => {
  const { project, track, epic, task } = instance.projects[0];
  await command(instance.api, 'track.create', { projectId: project.id, name: 'Mobile' });
  await openApp(page, instance);
  const trackSelect = page.getByRole('button', { name: /^Track / }), epicSelect = page.getByRole('button', { name: /^Epic / });
  await expect(trackSelect).toContainText(track.name);
  await expect(epicSelect).toContainText(epic.title);
  await trackSelect.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#tpEpic-note')).toHaveText(`Epic cleared: “${epic.title}” is on ${track.name}, not Mobile.`);
  await expect(epicSelect).toContainText('No epic');
  await expect(trackSelect).toBeFocused();
  await expect(page.locator('.timeline')).toContainText('moved the task to Mobile');
  await expect(page.locator('.timeline')).toContainText(`removed the task from ${epic.title}`);
  const saved = await (await instance.api.get(`/api/tasks/${task.id}`)).json();
  expect(saved.epicId).toBeNull();
});

test('a checklist grows, ticks and moves by keyboard, and follows a change made elsewhere', async ({ page, instance }) => {
  const { task } = instance.projects[0];
  const checklist = async () => (await (await instance.api.get(`/api/tasks/${task.id}`)).json()).checklist;
  const saved = async () => (await checklist()).map(item => [item.title, item.done]);
  await openApp(page, instance);
  const add = page.getByLabel('Add a checklist item');
  for (const title of ['Write the copy', 'Review it']) { await add.fill(title); await add.press('Enter'); }
  await expect(page.locator('.checklist-item')).toHaveCount(2);
  await expect(add).toBeFocused();
  await page.getByLabel('Done: Write the copy').press('Space');
  await expect(page.locator('.checklist-count')).toHaveText('1/2');
  const title = page.getByRole('textbox', { name: 'Checklist item', exact: true }).last();
  await title.fill('Review the copy');
  await title.press('Enter');
  await expect.poll(saved).toEqual([['Write the copy', true], ['Review the copy', false]]);
  const grip = page.getByRole('button', { name: 'Move Review the copy', exact: true });
  await grip.press('ArrowUp');
  await expect(grip).toBeFocused();
  await expect.poll(saved).toEqual([['Review the copy', false], ['Write the copy', true]]);
  // Another person ticks the other item; the page and the Board card show it.
  const other = (await checklist()).find(item => item.title === 'Review the copy');
  await command(instance.writer, 'task.checklist.update', { itemId: other.id, done: true }, other.revision);
  await expect(page.getByLabel('Done: Review the copy')).toBeChecked();
  await expect(page.locator('.checklist-count')).toHaveText('2/2');
  await page.getByRole('button', { name: 'Back to Board' }).click();
  await expect(page.locator(`[data-task="${task.taskKey}"] .card-checklist`)).toHaveText('2/2');
});

test('a refused checklist tick goes back in place, and the description being typed keeps its text and focus', async ({ page, instance, allowedConsoleErrors }) => {
  const { task } = instance.projects[0];
  await command(instance.api, 'task.checklist.add', { taskId: task.id, title: 'Build' });
  await openApp(page, instance);
  const box = page.getByLabel('Done: Build'), description = page.locator('#task-description');
  // The server refuses the tick once the person types in the description again.
  allowedConsoleErrors.push(/400 .*\/api\/commands$/);
  let refuse;
  const typed = new Promise(resolve => { refuse = resolve; });
  await page.route('**/api/commands', async route => {
    await typed;
    await route.fulfill({ status: 400, json: { error: { code: 'validation_failed', message: 'The tick was refused.', details: { field: 'done' } } } });
  });
  await box.check();
  await description.click();
  await page.keyboard.type('Typed meanwhile');
  const editor = await description.elementHandle();
  const read = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${task.id}`);
  refuse();
  await read;
  await expect(box).not.toBeChecked();
  await expect(page.locator('.checklist-count')).toHaveText('0/1');
  // The read that puts the checklist right draws nothing else of the page again.
  expect(await editor.evaluate(element => [element.isConnected, element === document.activeElement, element.value])).toEqual([true, true, 'Typed meanwhile']);
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
  // New tasks go to the top, so the first one ends past the Board's first page.
  let task;
  for (let i = 0; i < 52; i++) {
    const [created] = (await command(instance.api, 'task.create', { projectId: project.id, epicId: epic.id, title: `Pagination ${i}` })).entities;
    task ??= created;
  }
  await openApp(page, instance, `task/${task.taskKey}`);
  await page.locator('#attIn').setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('retained') });
  await expect(page.locator('.attachment-title')).toHaveCount(1);
  await page.locator('#cmtIn').fill('Retained comment');
  await page.locator('#cmtIn').press('Enter');
  await expect(page.locator('.comment-row')).toHaveCount(1);
  await page.locator('.nav-item[title=Board]').click();
  await expect(page.locator('.board')).toBeVisible();
  await expect.poll(() => page.evaluate(id => DATA.tasks.some(t => t.internalId === id), task.id)).toBe(false);
  await page.evaluate(key => location.hash = `#/task/${key}`, task.taskKey);
  await expect(page.locator('.attachment-title')).toHaveCount(1);
  await expect(page.locator('.comment-row')).toContainText('Retained comment');
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
  await expect(page.locator('.comment-row')).toHaveCount(50);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Load older activity' }).click();
    await expect(page.locator('.comment-row')).toHaveCount(i === 0 ? 100 : 105);
  }
  // Background refresh retains the already loaded history window.
  await page.evaluate(() => OneloopCollaboration.loadTaskPage(App.context().taskId));
  await expect(page.locator('.comment-row')).toHaveCount(105);
  expect(await page.evaluate(() => window.invalidAnimations)).toBe(0);
  // A new page starts a fresh window for the independent node/listener budget.
  await page.reload();
  await waitForLiveChannel(page);
  await expect(page.locator('.comment-row')).toHaveCount(50);
  const liveComment = async i => {
    await command(instance.writer, 'discussion.comment.create', { taskId: task.id, content: `Live comment ${i}`, mentions: [] });
    await expect(page.locator('.timeline')).toContainText(`Live comment ${i}`);
  };
  // The first live comment arrives after the event stream's opening
  // reconciliation, which may legitimately reload the feed.
  await liveComment(0);
  // Only a row that changed is drawn again. Its time label changes by
  // itself, from "just now" to "1m ago" 30 s after its comment, which a slow
  // run reaches; the row drawn then is the one to watch.
  const key = await page.locator('.comment-row').last().getAttribute('data-feed-key');
  const watched = page.locator(`.comment-row[data-feed-key="${key}"]`), label = el => el.querySelector('time').textContent;
  let row = await watched.elementHandle();
  for (let i = 1; i < 20; i++) {
    const before = await row.evaluate(label);
    await liveComment(i);
    if (await row.evaluate(el => el.isConnected)) continue;
    row = await watched.elementHandle();
    expect(await row.evaluate(label), 'a row is drawn again only for a new time label').not.toBe(before);
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
  await expect(page.locator('.comment-row')).toHaveCount(50);
  await expect(page.locator('.timeline')).not.toContainText('Comment 0');
  await page.getByRole('button', { name: 'Load older activity' }).hover();
  await page.mouse.down();
  // The live update refreshes the timeline between press and release.
  await command(instance.writer, 'discussion.comment.create', { taskId: task.id, content: 'Live during the click', mentions: [] });
  await expect(page.locator('.timeline')).toContainText('Live during the click');
  await page.mouse.up();
  await expect(page.locator('.timeline')).toContainText('Comment 0');
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
  // The live change reads the task and its activity, which is all a new title can change.
  await expect.poll(() => reads.filter(read => read.path.startsWith('/api/activity/')).length).toBeGreaterThanOrEqual(1);
  expect(reads.filter(read => read.path.endsWith('/comments') || read.path.endsWith('/attachments'))).toEqual([]);
  expect(reads.filter(read => read.path === `/api/tasks/${task.id}`)).not.toEqual([]);
  expect(reads.filter(read => !read.background)).toEqual([]);
});

test('descriptions and comments take each paragraph\'s direction from its own text', async ({ page, instance }) => {
  const { task } = instance.projects[0];
  await command(instance.api, 'task.update', { taskId: task.id, description: 'وصف المهمة بالعربية.\nAn English line.' }, task.revision);
  // A comment's bubble is as wide as its text, so each one wraps: its last line shows the side it reads from.
  for (const content of ['تعليق باللغة العربية، هل يظهر بشكل صحيح؟ '.repeat(6).trim(), 'An English comment. '.repeat(14).trim()]) {
    await command(instance.api, 'discussion.comment.create', { taskId: task.id, content, mentions: [] });
  }
  await openApp(page, instance);
  // Where a text sits in its box: right-aligned when it reads right to left.
  const sides = locator => locator.evaluate(element => {
    const range = document.createRange(), box = element.getBoundingClientRect();
    range.selectNodeContents(element);
    return [...range.getClientRects()].map(line => Math.round(box.right - line.right) < Math.round(line.left - box.left) ? 'right' : 'left');
  });
  const lastLine = async locator => (await sides(locator)).at(-1);
  await expect.poll(() => lastLine(page.locator('.cmt-body').filter({ hasText: 'تعليق' }))).toBe('right');
  expect(await lastLine(page.locator('.cmt-body').filter({ hasText: 'An English comment.' }))).toBe('left');
  // The description's lines, as it shows them and in its editor.
  const lines = await sides(page.locator('#task-description-content p'));
  expect([lines.at(0), lines.at(-1)]).toEqual(['right', 'left']);
  await page.getByRole('button', { name: 'Edit description' }).click();
  expect(await page.locator('#task-description').evaluate(element => getComputedStyle(element).unicodeBidi)).toBe('plaintext');
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

test('Undo answers Ctrl+Z after a deletion, and a busy server leaves a way to try again', async ({ page, instance, allowedConsoleErrors }) => {
  // A live read of the open task page can still be on its way when it is deleted.
  allowedConsoleErrors.push(/404 .*\/api\/tasks\//, /503/);
  const key = instance.projects[0].task.taskKey, restores = [];
  await page.route('**/api/commands', async route => {
    const command = route.request().postDataJSON();
    if (command.operation !== 'task.restore') return route.continue();
    restores.push(command.idempotencyKey);
    if (restores.length > 1) return route.continue();
    return route.fulfill({ status: 503, headers: { 'Retry-After': '1' }, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'The server is busy' } }) });
  });
  await openApp(page, instance);
  await page.getByRole('button', { name: 'Task actions' }).click();
  await page.locator('#action-menu').getByText('Delete task').click();
  await page.locator('[data-confirm-accept]').press('Enter');
  const deleted = page.locator('#toast-region .toast').filter({ hasText: `${key} deleted` });
  await expect(deleted.getByRole('button', { name: 'Undo' })).toHaveAttribute('aria-keyshortcuts', /\+Z$/);
  await expect(page.locator(`.board .card[data-task="${key}"]`)).toHaveCount(0);
  // With a dialog open, the key belongs to the dialog.
  await page.getByRole('button', { name: 'Task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(dialog).toBeVisible();
  expect(restores).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`.board .card[data-task="${key}"]`)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  const failed = page.locator('#toast-region .toast[data-kind="error"]').filter({ hasText: 'Try the same action again' });
  await expect(failed.getByRole('button', { name: 'Undo' })).toBeVisible();
  // A busy server counts as no connection until oneloop reaches it again.
  await expect(page.locator('#toast-region')).toContainText('Connection restored');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#toast-region')).toContainText(`${key} restored`);
  await expect(page.locator(`.board .card[data-task="${key}"]`)).toBeVisible();
  expect(restores).toHaveLength(2);
  expect(restores[1]).toBe(restores[0]);
});
