// Accessibility: automated scans, keyboard focus, announcements and layouts.
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { test, expect, openApp, command, useTheme, holdResponses } from '../support/test.mjs';

// Scan the entire page, including contrast and landmarks. Do not suppress rules.
async function scan(page, label) {
  const result = await new AxeBuilder({ page }).analyze();
  const failures = result.violations.filter(item => ['serious', 'critical'].includes(item.impact));
  expect(failures.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })), label).toEqual([]);
}

for (const theme of ['light', 'dark']) {
  test(`views and open controls have no serious accessibility violations (${theme})`, { tag: theme === 'light' ? '@smoke' : [] }, async ({ page, instance }) => {
    test.setTimeout(90_000);
    page.setDefaultTimeout(10_000);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await useTheme(page, theme);
    await page.goto(instance.url);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await scan(page, 'login');
    await openApp(page, instance, 'board');
    await page.evaluate(value => Theme.set(value), theme);
    await scan(page, 'Board');
    await page.getByRole('button', { name: 'Task', exact: true }).click();
    const task = page.getByRole('dialog', { name: 'New task' });
    await expect(task).toBeVisible();
    await scan(page, 'New task');
    await task.getByRole('button', { name: 'Open deadline calendar' }).click();
    await expect(page.getByRole('dialog', { name: 'Deadline calendar' })).toBeVisible();
    await scan(page, 'Date picker');
    await page.keyboard.press('Escape');
    await task.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: /^Pool(?: |$)/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, 'Pool');
    await page.keyboard.press('Escape');
    for (const route of ['roadmap', `task/${instance.projects[0].task.taskKey}`, 'knowledge', 'inbox', 'settings']) {
      await page.evaluate(value => { location.hash = `#/${value}`; }, route);
      await expect.poll(() => page.evaluate(() => App.context().view)).toBe(route.startsWith('task/') ? 'task' : route);
      await scan(page, route);
    }
  });
}

test('disclosure controls expose names, expansion and keyboard focus', async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  await expect(page.locator('.switcher-btn')).toHaveAccessibleName('Project: Browser primary');
  const filter = page.locator('[data-filter-key]').first();
  await expect(filter).toHaveAttribute('aria-expanded', 'false');
  await filter.click();
  await expect(filter).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(`[id="${await filter.getAttribute('aria-controls')}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(filter).toBeFocused();
  await expect(filter).toHaveAttribute('aria-expanded', 'false');
  const profile = page.locator('.me-chip');
  await profile.focus();
  await page.keyboard.press('Enter');
  await expect(profile).not.toHaveAttribute('aria-haspopup');
  await expect(profile).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#action-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(profile).toBeFocused();
  await page.locator('.card').first().click();
  await expect(page.getByRole('button', { name: 'Back to Board', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Drag & drop or browse files', exact: true })).toBeVisible();
  const title = page.locator('.tp-title');
  await title.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(title).toBeFocused();
  expect(await title.evaluate(el => getComputedStyle(el).outlineWidth)).toBe('2px');
  await page.evaluate(() => { window.DATA.session.authenticatedAt = 0; window.OneloopRecovery.recentAuth(() => {}).catch(() => {}); });
  await expect(page.getByRole('dialog', { name: 'Confirm your identity', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'Confirm your identity' }).getByRole('button', { name: 'Cancel' }).click();
});

// Exercise the rendered client, including its legacy bridge overrides.
test('dialogs, drawer, menu and searchable selector keep keyboard focus', async ({ page, instance }) => {
  const { project, track } = instance.projects[0];
  for (let i = 0; i < 8; i++) await command(instance.api, 'epic.create', { projectId: project.id, trackId: track.id, title: `Keyboard choice ${i}`, startDate: '2026-09-24' });
  await openApp(page, instance, 'board');
  const newTask = page.getByRole('button', { name: 'Task', exact: true });
  await newTask.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  const title = dialog.getByRole('textbox', { name: 'Title', exact: true });
  const description = dialog.getByRole('textbox', { name: /Description/ });
  await expect(title).toBeFocused();
  await expect(description).toBeVisible();
  expect(await dialog.locator('label').filter({ hasText: 'Title' }).first().getAttribute('for')).toBe(await title.getAttribute('id'));
  expect(await dialog.locator('label').filter({ hasText: 'Description' }).first().getAttribute('for')).toBe(await description.getAttribute('id'));
  expect(await dialog.evaluate(() => ({
    shell: document.querySelector('.main').inert,
    sidebar: document.querySelector('.sidebar').inert,
    duplicates: [...document.querySelectorAll('[id]')].map(el => el.id).filter((id, index, all) => all.indexOf(id) !== index),
  }))).toEqual({ shell: true, sidebar: true, duplicates: [] });
  await title.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Create task' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(title).toBeFocused();
  await dialog.getByRole('button', { name: /^Epic / }).click();
  const search = page.locator('.pop-search');
  await expect(search).toBeFocused();
  await search.press('Escape');
  const epicTrigger = dialog.getByRole('button', { name: /^Epic / });
  await expect(epicTrigger).toBeFocused();
  await epicTrigger.click();
  await search.fill('Keyboard choice 3');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(epicTrigger).toBeFocused();
  await expect(dialog.locator('input[name="epicId"]')).not.toHaveValue('');
  await epicTrigger.click();
  await search.press('Tab');
  await expect(page.locator('.pop')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Assignees' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(newTask).toBeFocused();

  const roadmapRead = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/roadmap`));
  const countRead = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/counts`));
  await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
  await Promise.all([roadmapRead, countRead]);
  const epic = page.locator('[data-epic]').first();
  await expect(epic).toBeVisible();
  await epic.press('Enter');
  const drawer = page.locator('.peek');
  await expect(drawer).toHaveAttribute('role', 'dialog');
  await expect(drawer.getByRole('button', { name: 'Close epic' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(drawer.locator('button').last()).toBeFocused();
  const edit = drawer.getByRole('button', { name: 'Edit epic' });
  await edit.click();
  const epicDialog = page.getByRole('dialog', { name: 'Edit epic' });
  await expect(epicDialog.getByRole('textbox', { name: 'Title' })).toBeFocused();
  expect(await drawer.evaluate(el => el.inert)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(epicDialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(epicDialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(epic).toBeFocused();

  const account = page.locator('.me-chip');
  await account.focus();
  await account.press('Enter');
  await expect(page.locator('.menu button').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.menu')).toHaveCount(0);
});

test('landmarks, Board context, field descriptions and move focus survive navigation', async ({ page, instance }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { task } = instance.projects[0];
  await openApp(page, instance, 'board');
  // Change the deadline once the page is live, so its refresh finishes before keyboard checks.
  await command(instance.api, 'task.update', { taskId: task.id, deadline: '2020-01-01' }, task.revision);
  await expect(page.locator('.dl.late')).toContainText('Overdue');
  await expect(page.getByRole('main')).toHaveCount(1);
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  for (const name of ['Planning', 'In Progress', 'In Review', 'Done']) await expect(page.getByRole('region', { name, exact: true }).getByRole('heading', { name, exact: true })).toBeVisible();
  const title = page.locator('.card-title-button').first();
  await expect(title).toHaveAccessibleDescription(new RegExp(`${task.taskKey}.*Planning.*Due 2020-01-01.*Overdue`));
  await title.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.topbar h1')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Properties', level: 2 })).toBeVisible();
  await page.evaluate(() => App.nav('board'));
  await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeFocused();
  const move = page.getByRole('button', { name: `Move ${task.taskKey}`, exact: true });
  await move.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Move to In Progress', exact: true }).click();
  await expect(move).toBeFocused();
  await expect(page.locator('[data-announce="polite"]')).toContainText(`${task.taskKey} moved to In Progress`);
  await expect.poll(() => page.evaluate(() => !!App._boardMovePending)).toBe(false);
  await expect(page.locator('[data-col="progress"] .card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' }), field = dialog.getByRole('textbox', { name: 'Title', exact: true });
  await field.evaluate(el => { const hint = document.createElement('span'); hint.id = 'existing-help'; hint.textContent = 'Existing help'; el.parentNode.append(hint); el.setAttribute('aria-describedby', hint.id); });
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(field).toHaveAccessibleDescription('Existing help This field is required.');
  await field.fill('A title');
  await expect(field).toHaveAccessibleDescription('Existing help');
  await expect(field).not.toHaveAttribute('aria-invalid');
  // The dialog holds typed text, so Escape asks first.
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: /^Pool(?: |$)/ }).click();
  await expect(page.getByRole('dialog', { name: 'Pool', exact: true })).toBeVisible();
});

test('Blocked reasons and comment times add no Tab stops, and keep their details for every reader', async ({ page, instance }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { task } = instance.projects[0];
  await command(instance.api, 'task.block', { taskId: task.id, reason: 'Waiting for the API', mentions: [] }, task.revision);
  await command(instance.api, 'discussion.comment.create', { taskId: task.id, content: 'A comment with a time', mentions: [] });
  await openApp(page, instance, 'board');
  const title = page.locator('.card-title-button'), tooltip = page.getByRole('tooltip');
  await expect(title).toHaveAccessibleDescription(/Blocked: Waiting for the API — Smoke Owner · /);
  await page.locator('.card .card-move').focus();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.card')), 'the badge is no Tab stop').toBe(false);
  await page.locator('.card .blocked-badge').hover();
  await expect(tooltip).toHaveText(/^Waiting for the API — Smoke Owner · /);
  for (const theme of ['light', 'dark']) {
    // Reduce motion still gives each color change 0.01ms, so scan once the new colors have painted.
    await page.evaluate(value => { Theme.set(value); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, theme);
    await scan(page, `Blocked tooltip (${theme})`);
  }
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  // Keyboard users without a screen reader see the reason on the title instead.
  await page.locator('.card .card-move').focus();
  await page.keyboard.press('Tab');
  await expect(title).toBeFocused();
  await expect(tooltip).toHaveText(/^Waiting for the API — Smoke Owner · /);
  await expect(title).toHaveAccessibleDescription(/^[^]*Blocked: Waiting for the API[^]*$/);
  expect((await title.getAttribute('aria-describedby')).split(' ')).not.toContain('app-tip');
  await title.press('Enter');
  const comment = page.locator('[data-comment]');
  await expect(comment.getByRole('group')).toHaveAccessibleName(/^Smoke Owner \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  await comment.locator('.comment-menu-button').focus();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.cmt-head')), 'the time is no Tab stop').toBe(false);
});

test('a focused file name keeps its tip while the task page scrolls, and the tip does not repeat the name', async ({ page, instance }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  const name = `quarterly-report-${'forecast-'.repeat(12)}.txt`;
  const response = await instance.api.post(`/api/tasks/${instance.projects[0].task.id}/attachments`, {
    headers: { 'Idempotency-Key': randomUUID(), 'X-File-Size': '12' },
    multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from('Hello world!') } },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await openApp(page, instance);
  const title = page.locator('.attachment-title'), tooltip = page.getByRole('tooltip');
  // Keyboard focus: WebKit's Tab skips links, so a key press comes first.
  await page.locator('.attachment-thumbnail').focus();
  await page.keyboard.press('Shift');
  await title.focus();
  await expect(tooltip).toHaveText(name);
  await expect(title).toHaveAccessibleName(name);
  await expect(title).toHaveAccessibleDescription('');
  const gap = async () => (await tooltip.boundingBox()).y - (await title.boundingBox()).y;
  const [before, top] = [await gap(), (await title.boundingBox()).y];
  await page.locator('.task-page').evaluate(element => element.scrollBy({ top: 40, behavior: 'instant' }));
  await expect.poll(async () => (await title.boundingBox()).y, { message: 'the page scrolled' }).toBeLessThan(top - 20);
  await expect.poll(async () => Math.abs(await gap() - before), { message: 'the tip moves with its link' }).toBeLessThanOrEqual(1);
});

test('a slow task load and a live update keep focus on the task heading', async ({ page, instance }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { task } = instance.projects[0];
  await openApp(page, instance, 'board');
  // A busy server: the task read outlasts the 120 ms before the loading skeleton shows.
  const read = await holdResponses(page, url => url.pathname === `/api/tasks/${task.taskKey}`);
  await page.locator('.card-title-button').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.topbar h1')).toBeFocused();
  await read.started;
  await expect(page.locator('.loading-task')).toBeVisible();
  await command(instance.writer, 'task.update', { taskId: task.id, deadline: '2030-01-02' }, task.revision);
  await read.release();
  await expect(page.locator('#tpDl-input')).toHaveValue('2030-01-02');
  await expect(page.locator('.topbar h1')).toBeFocused();
});

test('page headings and the main area take focus without drawing a focus ring', async ({ page, instance }) => {
  const outline = locator => locator.evaluate(el => getComputedStyle(el).outlineStyle);
  await openApp(page, instance, 'roadmap');
  const heading = page.getByRole('heading', { name: 'Roadmap', exact: true });
  await expect(heading).toBeFocused();
  expect(await outline(heading)).toBe('none');
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  expect(await outline(page.getByRole('main'))).toBe('none');
  // Controls keep their keyboard focus ring.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)).not.toBe('none');
});

test('the drawer contains focus through rerenders and returns it on close', async ({ page, instance }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await openApp(page, instance, 'board');
  const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
  await toggle.click();
  await expect.poll(() => page.evaluate(() => !!document.activeElement.closest('.sidebar'))).toBe(true);
  expect(await page.locator('main').evaluate(el => el.inert)).toBe(true);
  const roadmap = page.getByRole('button', { name: 'Roadmap', exact: true });
  await roadmap.focus();
  await page.evaluate(() => App.refresh());
  await expect(roadmap).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i < 6 ? 'Tab' : 'Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('.sidebar,.menu-btn'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  expect(await page.locator('main').evaluate(el => el.inert)).toBe(false);
  await toggle.click();
  await page.locator('.side-scrim').click({ position: { x: 700, y: 100 } });
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
  await expect(page.locator('.topbar h1')).toBeFocused();
});

test('announcers persist across renders and stay exposed during confirmation', async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  await page.evaluate(() => {
    window.originalAnnouncer = document.querySelector('[data-announce="polite"]');
    window.originalConnection = document.getElementById('connection-announcer');
    App.toast('First accessible update');
  });
  await expect(page.locator('[data-announce="polite"]')).toHaveText('First accessible update');
  await page.evaluate(() => { App.refresh(); App.confirm({ title: 'Confirm test', text: 'Keep the current task?', action: 'Keep', confirm() {} }); App.toast('Update during confirmation'); });
  await expect(page.locator('[data-announce="polite"]')).toHaveText('Update during confirmation');
  expect(await page.evaluate(() => document.querySelector('[data-announce="polite"]') === window.originalAnnouncer && !window.originalAnnouncer.closest('[inert]'))).toBe(true);
  await page.locator('[data-confirm-cancel]').click();
  await page.evaluate(() => Recovery.buildChanged());
  await expect(page.locator('#connection-announcer')).toContainText('oneloop was updated');
  await page.evaluate(() => App.refresh());
  expect(await page.evaluate(() => document.getElementById('connection-announcer') === window.originalConnection)).toBe(true);
});

test('forced colors keep selection and keyboard option outlines', async ({ page, instance, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit does not emulate forced colors');
  await page.emulateMedia({ forcedColors: 'active' });
  await openApp(page, instance);
  await page.locator('#select-tpState').click();
  await page.keyboard.press('ArrowDown');
  const option = page.locator('.pop-opt.focus');
  await expect(option).toHaveCount(1);
  expect(await option.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  expect(await page.locator('.nav-item.on').evaluate(el => getComputedStyle(el).forcedColorAdjust)).toBe('none');
});

const fileNames = [
  'contract-v1-review-notes-final.txt',
  'contract-v2-review-notes-final.txt',
  `quarterly-report-${'forecast-'.repeat(12)}.txt`,
  'contract-v3-source-archive.bin',
];

for (const theme of ['light', 'dark']) {
  test(`Inbox controls and long file names stay usable from phone to desktop widths (${theme})`, async ({ page, instance }) => {
    for (const name of fileNames) {
      const response = await instance.api.post(`/api/tasks/${instance.projects[0].task.id}/attachments`, {
        headers: { 'Idempotency-Key': randomUUID(), 'X-File-Size': '12' },
        multipart: { file: { name, mimeType: name.endsWith('.bin') ? 'application/octet-stream' : 'text/plain', buffer: Buffer.from('Hello world!') } },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    await openApp(page, instance, 'inbox');
    await page.evaluate(value => window.App.setTheme(value), theme);
    const closeSidebarOnNarrowViews = async width => {
      if (width > 768) return;
      await page.evaluate(() => window.App.toggleSidebar(false));
      await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    };
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${instance.url}/#/inbox`);
      await expect(page.locator('.inbox-page')).toBeVisible();
      await closeSidebarOnNarrowViews(width);
      const projectFilter = page.locator('.inbox-filter-group .sel-btn');
      const unread = page.locator('.inbox-unread-filter');
      await expect(projectFilter).toBeVisible();
      await expect(unread).toBeVisible();
      for (const control of [projectFilter, unread]) {
        const rect = await control.boundingBox();
        expect(rect.x, `${width}: control left`).toBeGreaterThanOrEqual(2);
        expect(rect.x + rect.width, `${width}: control right`).toBeLessThanOrEqual(width - 2);
        await control.click();
        await expect(control).toBeFocused();
        if (control === projectFilter) await page.keyboard.press('Escape');
      }
      await page.goto(`${instance.url}/#/task/${instance.projects[0].task.taskKey}`);
      await expect(page.locator('.task-page')).toBeVisible();
      await closeSidebarOnNarrowViews(width);
      const cards = page.locator('.attachment-card');
      await expect(cards).toHaveCount(fileNames.length);
      for (let index = 0; index < fileNames.length; index += 1) {
        const card = cards.nth(index);
        await expect(card.locator('.attachment-title')).toHaveAttribute('data-tip', fileNames[index]);
        await expect(card.locator('.file-download')).toBeVisible();
        await expect(card.locator('.file-remove')).toBeVisible();
        await expect(card.locator('.retention-switch')).toBeVisible();
        const bounds = await card.evaluate(element => {
          const box = selector => { const rect = element.querySelector(selector).getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, width: rect.width }; };
          return { title: box('.attachment-title'), actions: box('.attachment-actions'), download: box('.file-download'), remove: box('.file-remove') };
        });
        expect(bounds.title.left).toBeGreaterThanOrEqual(0);
        expect(bounds.title.right).toBeLessThanOrEqual(width);
        expect(bounds.download.right).toBeLessThanOrEqual(width);
        expect(bounds.remove.right).toBeLessThanOrEqual(width);
        if (width <= 390) {
          expect(bounds.title.width, `${width}: ${fileNames[index]}`).toBeGreaterThan(110);
          expect(bounds.actions.top).toBeGreaterThan(bounds.title.top);
        } else if (width === 1440) {
          expect(Math.abs(bounds.actions.top - bounds.title.top)).toBeLessThan(40);
        }
      }
      await expect(cards.nth(3)).toContainText('Download only');
    }
  });
}
