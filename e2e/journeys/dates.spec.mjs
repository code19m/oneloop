// Dates, deadlines and the instance time zone.
import { test, expect, openApp, signIn, expectSignedIn, command } from '../support/test.mjs';

const modal = page => page.locator('.modal');

/** Serve API responses with a Date header taken from the browser's controlled clock. */
async function serverDateFromBrowserClock(page) {
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/events') { await route.continue(); return; }
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), date: await page.evaluate(() => new Date().toUTCString()) } });
  });
}

test('visible dates block invalid submissions and keep valid or cleared values', async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  const sent = operation => {
    const list = [];
    page.on('request', request => { if (request.url().endsWith('/api/commands') && request.postDataJSON()?.operation === operation) list.push(request.postDataJSON()); });
    return list;
  };
  const tasks = sent('task.create'), epics = sent('epic.create'), milestones = sent('milestone.create');
  await page.getByRole('button', { name: 'Task', exact: true }).click();
  await modal(page).locator('[name="title"]').fill('Date validated task');
  await modal(page).getByRole('button', { name: /^Epic / }).click();
  await page.locator('.pop-opt').filter({ hasText: instance.projects[0].epic.title }).click();
  const deadline = modal(page).locator('[data-date-key="mTaskDeadline"] .date-text');
  for (const invalid of ['2026-02-31', '2026-02']) {
    await deadline.fill(invalid);
    const visible = await deadline.inputValue();
    await modal(page).getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(deadline).toHaveAttribute('aria-invalid', 'true');
    expect(tasks).toHaveLength(0);
    await expect(deadline).toHaveValue(visible);
  }
  await deadline.fill('2026-10-15');
  await deadline.press('Tab');
  await deadline.fill('');
  await modal(page).getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(modal(page)).toHaveCount(0);
  expect(tasks[0].payload.deadline).toBeNull();
  await Promise.all([page.waitForResponse(response => response.url().includes('/roadmap') && response.ok()), page.locator('.nav-item[title="Roadmap"]').click()]);
  await page.getByRole('button', { name: 'Epic', exact: true }).click();
  await modal(page).locator('[name="title"]').fill('Date validated epic');
  await modal(page).getByRole('button', { name: /^Track / }).click();
  await page.locator('.pop-opt').filter({ hasText: instance.projects[0].track.name }).click();
  const start = modal(page).locator('[data-date-key="mStart"] .date-text'), end = modal(page).locator('[data-date-key="mEnd"] .date-text');
  for (const invalid of ['', '2026-02-31']) {
    await start.fill(invalid);
    await modal(page).getByRole('button', { name: 'Create epic', exact: true }).click();
    await expect(start).toHaveAttribute('aria-invalid', 'true');
    expect(epics).toHaveLength(0);
  }
  await start.fill('2026-10-15');
  await end.fill('2026-10-14');
  await modal(page).getByRole('button', { name: 'Create epic', exact: true }).click();
  expect(epics).toHaveLength(0);
  await expect(modal(page).locator('.date-text[aria-invalid="true"]')).not.toHaveCount(0);
  await end.fill('');
  await modal(page).getByRole('button', { name: 'Create epic', exact: true }).click();
  await expect(modal(page)).toHaveCount(0);
  expect(epics[0].payload).toMatchObject({ startDate: '2026-10-15', endDate: null });
  await page.getByRole('button', { name: 'Milestone', exact: true }).click();
  await modal(page).locator('[name="name"]').fill('Date validated milestone');
  const date = modal(page).locator('.date-text');
  await date.fill('2026-02-31');
  await modal(page).locator('[name="name"]').press('Enter');
  await expect(date).toHaveAttribute('aria-invalid', 'true');
  expect(milestones).toHaveLength(0);
  await date.fill('2026-11-12');
  await modal(page).locator('button[type="submit"]').click();
  await expect(modal(page)).toHaveCount(0);
  expect(milestones[0].payload.milestoneDate).toBe('2026-11-12');
});

test('instance midnight keeps the sign-in form and active task input', async ({ page, instance }) => {
  await page.clock.install({ time: new Date('2026-09-27T23:59:40Z') });
  await page.goto(instance.url);
  const username = page.locator('[name=username]');
  await username.fill('unfinished');
  await page.clock.fastForward(70_000);
  await expect(username).toHaveValue('unfinished');
  await expect(username).toBeFocused();
  await signIn(page, instance);
  await expectSignedIn(page);
  await page.goto(`${instance.url}/#/task/${instance.projects[0].task.taskKey}`);
  await expect(page.locator('.tp-title')).toBeVisible();
  const description = page.locator('#task-description');
  await description.fill('Midnight input');
  await page.clock.fastForward(86_400_000);
  await expect(description).toHaveValue('Midnight input');
  await expect(description).toBeFocused();
});

test.describe('with an instance time zone ahead of the browser', () => {
  test.use({ instanceTimeZone: 'Pacific/Kiritimati', timezoneId: 'America/Los_Angeles' });
  test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

  test('instance midnight updates dates without submitting or replacing task input', async ({ page, instance }) => {
    const { task } = instance.projects[0];
    await command(instance.api, 'task.update', { taskId: task.id, deadline: '2026-09-27' }, task.revision);
    await page.clock.install({ time: new Date('2026-09-27T09:58:00Z') });
    await page.clock.pauseAt(new Date('2026-09-27T09:59:00Z'));
    await serverDateFromBrowserClock(page);
    await openApp(page, instance, 'board');
    await expect(page.locator('.card .dl')).not.toHaveClass(/late/);
    await expect(page.locator('.card .dl')).toHaveText('Sep 27');
    await expect(page.locator('.card .dl')).toHaveAttribute('data-tip', 'Deadline 2026-09-27');
    await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
    await expect(page.locator('.today-pill')).toHaveText('Sep 27');
    await page.evaluate(key => App.openTask(key), task.taskKey);
    await expect(page.locator('.tp-title')).toBeVisible();
    await page.getByRole('button', { name: 'Open deadline calendar' }).click();
    await expect(page.locator('.cal-d.today')).toHaveAttribute('data-d', '2026-09-27');
    await page.keyboard.press('Escape');
    const posts = [];
    page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
    const title = page.locator('.tp-title');
    await title.fill('Keep my unsaved midnight edit');
    await page.clock.fastForward(61_000);
    await expect(title).toHaveValue('Keep my unsaved midnight edit');
    await expect(title).toBeFocused();
    await expect(page.locator('.task-overdue')).toBeVisible();
    expect(posts).toEqual([]);
    await expect(page.locator('[data-date-key=tpDl] .date-text')).toHaveValue('2026-09-27');
    // Remove the unsaved edit before deliberate navigation (blur is an accepted save).
    await title.fill(task.title);
    await page.getByRole('button', { name: 'Open deadline calendar' }).click();
    await expect(page.locator('.cal-d.today')).toHaveAttribute('data-d', '2026-09-28');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
    await expect(page.locator('.today-pill')).toHaveText('Sep 28');
  });

  test('midnight hydrates visible epic throughput without periodic projection probes', async ({ page, instance }) => {
    await page.clock.install({ time: new Date('2026-09-27T09:58:00Z') });
    await page.clock.pauseAt(new Date('2026-09-27T09:59:00Z'));
    await serverDateFromBrowserClock(page);
    await openApp(page, instance, 'roadmap');
    await page.locator('[data-epic]').first().click();
    await expect(page.locator('[data-epic-throughput]')).toBeVisible();
    let reads = 0;
    await page.route('**/api/projects/*/roadmap', async route => {
      reads++;
      const response = await route.fetch(), body = await response.json();
      for (const epic of body.epics) { epic.completedThisWeek = 17; epic.weeklyCompletions = [0, 0, 0, 0, 0, 0, 17]; }
      await route.fulfill({ response, json: body, headers: { ...response.headers(), date: await page.evaluate(() => new Date().toUTCString()) } });
    });
    await page.clock.fastForward(61_000);
    await expect(page.locator('[data-epic-throughput]')).toContainText('17 closed this week');
    expect(reads).toBe(1);
    await page.clock.fastForward(31_000);
    expect(reads).toBe(1);
  });

  test('an unsupported browser time zone uses a visible, consistent UTC fallback', async ({ page, instance }) => {
    await page.addInitScript(() => {
      const Native = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function (locale, options) { if (options?.timeZone === 'Pacific/Kiritimati') throw new RangeError('Unsupported fixture zone'); return new Native(locale, options); };
    });
    await openApp(page, instance, 'board');
    await expect(page.locator('.board .card')).toHaveCount(1);
    await expect(page.locator('[data-announce=polite]')).toContainText('Times and Today are shown in UTC');
    expect(await page.evaluate(() => OneloopTime.instant('2026-09-27T09:59:00Z'))).toBe('2026-09-27 09:59:00');
  });

  test('Today follows server time when the device clock is days behind', { tag: '@smoke' }, async ({ page, instance }) => {
    await page.clock.install({ time: new Date('2026-09-20T08:59:00Z') });
    await page.clock.pauseAt(new Date('2026-09-20T09:00:00Z'));
    await page.route('**/api/**', async route => {
      if (new URL(route.request().url()).pathname === '/api/events') { await route.continue(); return; }
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), date: 'Sun, 27 Sep 2026 09:00:00 GMT' } });
    });
    await openApp(page, instance, 'roadmap');
    await expect(page.locator('.today-pill')).toHaveText('Sep 27');
    await page.getByRole('button', { name: 'Epic', exact: true }).click();
    await expect(page.locator('.modal input[name="start"]')).toHaveValue('2026-09-27');
  });
});
