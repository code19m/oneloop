// The Roadmap: summary, zoom, tracks and the epic drawer.
import { test, expect, openApp, holdResponses, command, useTheme } from '../support/test.mjs';

test('Roadmap shows its summary without work counters', { tag: '@smoke' }, async ({ page, instance }) => {
  await useTheme(page, 'dark');
  await openApp(page, instance, 'roadmap');
  await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
  const summary = page.getByRole('group', { name: 'Roadmap summary' });
  await expect(summary).toContainText(/Tracks.*Epics.*Milestones/);
  await expect(summary).not.toContainText(/Open|Done|live/i);
  await expect(page.locator('#rmScroll')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('Roadmap spacing and zoom preserve readable rows and the shell', async ({ page, instance, browserName, allowedConsoleErrors }, testInfo) => {
  const { project, track } = instance.projects[0];
  for (let i = 0; i < 4; i++) await command(instance.api, 'epic.create', { projectId: project.id, trackId: track.id, title: `Overlapping epic ${i}`, startDate: '2026-09-24', endDate: '2026-10-24' });
  await openApp(page, instance, 'roadmap');
  expect(await page.evaluate(() => Uploads.limits)).toEqual({ file: 25 * 1024 * 1024, avatar: 5 * 1024 * 1024, count: 25 });
  const beforeSpacing = Number(await page.locator('#rmScroll').getAttribute('data-bar-height'));
  // WCAG text spacing, as a stylesheet: the app's policy refuses inline style elements.
  await page.route('**/e2e-text-spacing.css', route => route.fulfill({ contentType: 'text/css', body: '* { line-height:1.5 !important; letter-spacing:.12em !important; word-spacing:.16em !important; }' }));
  await page.addStyleTag({ url: `${instance.url}/e2e-text-spacing.css` });
  await expect.poll(async () => Number(await page.locator('#rmScroll').getAttribute('data-bar-height'))).toBeGreaterThan(beforeSpacing);
  const geometry = await page.locator('.bar').evaluateAll(bars => bars.map(bar => ({ h: bar.clientHeight, sh: bar.scrollHeight, top: bar.offsetTop, bottom: bar.offsetTop + bar.offsetHeight })));
  expect(geometry.length).toBeGreaterThan(3);
  for (const bar of geometry) expect(bar.sh).toBeLessThanOrEqual(bar.h);
  const sorted = geometry.sort((a, b) => a.top - b.top);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i].top).toBeGreaterThanOrEqual(sorted[i - 1].bottom + 7);
  await page.evaluate(() => {
    window.originalSidebar = document.querySelector('.sidebar');
    window.originalScroll = document.getElementById('rmScroll');
    window.originalBar = document.querySelector('.bar');
    window.initialWidth = window.originalBar.offsetWidth;
    for (let i = 0; i < 5; i++) window.originalScroll.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, clientX: 800, bubbles: true, cancelable: true }));
  });
  // The zoom resizes the Roadmap in place: the same scroller and bars, wider, inside the same shell.
  await expect.poll(() => page.evaluate(() => window.originalBar.offsetWidth > window.initialWidth)).toBe(true);
  const unchanged = () => page.evaluate(() => document.getElementById('rmScroll') === window.originalScroll && window.originalBar.isConnected && document.querySelector('.sidebar') === window.originalSidebar);
  expect(await unchanged()).toBe(true);
  // Month cells follow the zoom through CSS: each spans its days times the pixels per day.
  const months = await page.locator('.rm-month-grid .rm-month').evaluateAll(cells => cells.map(cell => [cell.getBoundingClientRect().width, Number(cell.style.getPropertyValue('--n')) * Number(cell.parentElement.style.getPropertyValue('--ppd'))]));
  expect(months.length).toBeGreaterThan(0);
  for (const [width, expected] of months) expect(Math.abs(width - expected)).toBeLessThan(1);
  // Playwright's WebKit screenshots insert a style element to sync animations, which the policy refuses.
  if (browserName === 'webkit') allowedConsoleErrors.push(/Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/);
  for (const theme of ['light', 'dark']) {
    await page.mouse.move(1, 1);
    await page.keyboard.press('Escape');
    await page.evaluate(theme => { App.setTheme(theme); const sc = document.getElementById('rmScroll'); sc.scrollLeft = 0; sc.dispatchEvent(new Event('scroll')); }, theme);
    expect(await page.locator('.rail-cell').first().evaluate(el => getComputedStyle(el).backdropFilter)).toBe('none');
    await page.screenshot({ path: testInfo.outputPath(`roadmap-${theme}.png`), animations: 'disabled' });
  }
  // Long after the gesture ended, the Roadmap was still never rebuilt.
  expect(await unchanged()).toBe(true);
});

test('Weeks, Months and Quarters zoom the Roadmap in place and keep today in view', async ({ page, instance }) => {
  await openApp(page, instance, 'roadmap');
  const scale = page.getByRole('group', { name: 'Timeline scale' });
  await expect(scale.getByRole('button', { name: 'Months' })).toHaveAttribute('aria-pressed', 'true');
  const todayShows = async () => {
    const [pill, view] = await Promise.all([page.locator('.today-pill').boundingBox(), page.locator('#rmScroll').boundingBox()]);
    return pill.x >= view.x && pill.x + pill.width <= view.x + view.width;
  };
  await scale.getByRole('button', { name: 'Weeks' }).click();
  await expect(scale.getByRole('button', { name: 'Weeks' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.rm-month-grid .rm-week').first()).toBeVisible();
  expect(await todayShows()).toBe(true);
  await page.keyboard.press('q');
  await expect(scale.getByRole('button', { name: 'Quarters' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(todayShows).toBe(true);
});

test('a teammate renaming a task updates the open epic drawer', async ({ page, instance }) => {
  const { epic, task } = instance.projects[0];
  await openApp(page, instance, 'roadmap');
  await page.locator(`[data-epic="${epic.id}"]`).press('Enter');
  const rows = page.locator('.peek .task-row');
  await expect(rows).toContainText(task.title);
  await command(instance.writer, 'task.update', { taskId: task.id, title: 'Renamed by a teammate' }, task.revision);
  await expect(rows).toContainText('Renamed by a teammate');
});

test('track keyboard/menu moves and pointer Board/track drags save and cancel', async ({ page, instance }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { project, track, task } = instance.projects[0];
  const [second] = (await command(instance.api, 'track.create', { projectId: project.id, name: 'Second track' })).entities;
  const [third] = (await command(instance.api, 'track.create', { projectId: project.id, name: 'Third track' })).entities;
  await openApp(page, instance, 'roadmap');
  const order = () => page.locator('.lane').evaluateAll(els => els.map(el => el.dataset.track));
  const settled = () => expect.poll(() => page.evaluate(() => !!App._roadmapMovePending)).toBe(false);
  const grip = page.getByRole('button', { name: `Reorder ${track.name}`, exact: true });
  await grip.press('ArrowDown');
  await expect(grip).toBeFocused();
  await expect.poll(order).toEqual([second.id, track.id, third.id]);
  await settled();
  await page.getByRole('button', { name: `Manage ${track.name} track`, exact: true }).click();
  await page.getByRole('button', { name: 'Move to bottom', exact: true }).click();
  await expect.poll(order).toEqual([second.id, third.id, track.id]);
  await expect(grip).toBeFocused();
  await settled();
  const source = await grip.boundingBox(), target = await page.locator(`[data-track="${second.id}"] .lane-head`).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 100, target.y + 4, { steps: 8 });
  await expect(page.locator('#dropInd')).toBeVisible();
  await page.mouse.up();
  await expect.poll(order).toEqual([track.id, second.id, third.id]);
  await settled();
  const server = await (await instance.api.get(`/api/projects/${project.id}/roadmap`)).json();
  expect(server.tracks.map(t => t.id)).toEqual([track.id, second.id, third.id]);
  await page.evaluate(() => App.nav('board'));
  await expect(page.locator('.card')).toHaveCount(1);
  const drag = async (cancel = false) => {
    const card = await page.locator(`[data-task="${task.taskKey}"]`).boundingBox(), column = await page.locator('[data-col="review"] .col-cards').boundingBox();
    await page.mouse.move(card.x + card.width / 2, card.y + 30);
    await page.mouse.down();
    await page.mouse.move(column.x + column.width / 2, column.y + 30, { steps: 8 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  await drag(true);
  await expect(page.locator('[data-col="planning"] .card')).toHaveCount(1);
  await expect(page.locator('.drag-preview,#dropInd')).toHaveCount(0);
  await drag();
  await expect(page.locator('[data-col="review"] .card')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => !!App._boardMovePending)).toBe(false);
  expect((await (await instance.api.get(`/api/tasks/${task.taskKey}`)).json()).status).toBe('in_review');
});

test('late epic reads keep drawer focus and unsent editor text', async ({ page, instance }) => {
  const { project, epic: source } = instance.projects[0];
  await openApp(page, instance, 'board');
  const roadmapRead = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/roadmap`));
  const countRead = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/counts`));
  await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
  await Promise.all([roadmapRead, countRead]);
  const epic = page.locator(`[data-epic="${source.id}"]`), drawer = page.locator('.peek');
  const pattern = `**/api/epics/${source.id}/tasks?*`;
  const first = await holdResponses(page, pattern);
  try {
    await epic.press('Enter');
    await first.started;
    const close = drawer.getByRole('button', { name: 'Close epic' }), del = drawer.getByRole('button', { name: 'Delete', exact: true });
    await expect(close).toBeFocused();
    await close.press('Shift+Tab');
    await expect(del).toBeFocused();
    await first.release();
    await expect.poll(() => page.evaluate(id => window.DATA.epicPageInfo[id]?.loaded, source.id)).toBe(true);
    await expect(del).toBeFocused();
  } finally { await first.release(); }
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  await page.evaluate(() => { const refresh = App.refreshEpic; window.epicRefreshCount = 0; App.refreshEpic = (...args) => { window.epicRefreshCount++; return refresh(...args); }; });
  const second = await holdResponses(page, pattern);
  try {
    await epic.press('Enter');
    await second.started;
    await drawer.getByRole('button', { name: 'Edit epic' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit epic' }), title = dialog.getByRole('textbox', { name: 'Title' });
    await title.fill('Unsent epic title');
    await title.evaluate(el => el.setSelectionRange(5, 5));
    const original = await title.elementHandle(), before = await page.evaluate(() => window.epicRefreshCount);
    await second.release();
    await expect.poll(() => page.evaluate(() => window.epicRefreshCount)).toBeGreaterThan(before);
    await expect(title).toBeFocused();
    await expect(title).toHaveValue('Unsent epic title');
    expect(await original.evaluate(el => el.isConnected)).toBe(true);
    expect(await title.evaluate(el => el.selectionStart)).toBe(5);
  } finally { await second.release(); }
});
