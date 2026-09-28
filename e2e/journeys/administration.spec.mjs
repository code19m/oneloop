// Users, project access and the signed-in user's profile.
import { test, expect, openApp, holdResponses, failUntilRetry, command } from '../support/test.mjs';

const modal = page => page.locator('.modal');

test('temporary passwords stay readable and copyable after creation and reset', { tag: '@smoke' }, async ({ page, instance }) => {
  await openApp(page, instance, 'users');
  const username = 'temp_user_' + 'x'.repeat(22);
  await page.getByRole('button', { name: 'New user', exact: true }).click();
  await modal(page).locator('input[name="username"]').fill(username);
  await modal(page).locator('input[name="name"]').fill('Temporary Password Review');
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  const password = modal(page).locator('#tmpPw');
  await expect(modal(page).getByRole('heading', { name: 'Temporary password', exact: true })).toBeVisible();
  await expect(modal(page).locator('.temporary-password-meta strong')).toHaveText(username);
  const original = await password.textContent();
  expect(original.length).toBeGreaterThan(32);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.App.setTheme(theme), theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(modal(page).getByRole('button', { name: 'Copy temporary password', exact: true })).toBeVisible();
      const bounds = await modal(page).evaluate(element => {
        const box = element.getBoundingClientRect(), code = element.querySelector('#tmpPw').getBoundingClientRect(), button = element.querySelector('.pw-box button').getBoundingClientRect();
        return { overflow: element.scrollWidth > element.clientWidth, inside: code.left >= box.left && code.right <= button.left && button.right <= box.right, viewport: box.left >= 0 && box.right <= innerWidth };
      });
      expect(bounds).toEqual({ overflow: false, inside: true, viewport: true });
      await expect(password).toHaveText(original);
    }
  }
  // Keep clipboard verification inside this disposable browser context.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.testCopiedPassword = value; } } }));
  await modal(page).getByRole('button', { name: 'Copy temporary password', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testCopiedPassword)).toBe(original);
  await modal(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(password).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('.user-row').filter({ hasText: username }).click();
  await modal(page).getByRole('button', { name: 'Reset password', exact: true }).click();
  await page.locator('[data-confirm-accept]').click();
  await expect(modal(page).getByRole('heading', { name: 'Temporary password', exact: true })).toBeVisible();
  await expect(modal(page).locator('.temporary-password-meta strong')).toHaveText(username);
  await expect(password).not.toHaveText(original);
});

test('a duplicate username gets inline corrective feedback and keeps the form', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/409 .*\/api\/users\b/);
  await openApp(page, instance, 'users');
  await page.getByRole('button', { name: 'New user', exact: true }).click();
  await modal(page).locator('[name="username"]').fill(instance.username);
  await modal(page).locator('[name="name"]').fill('Keep entered name');
  await modal(page).getByRole('button', { name: 'Create user', exact: true }).click();
  await expect(modal(page)).toContainText('This username is already in use. Choose another.');
  await expect(modal(page).locator('[name="name"]')).toHaveValue('Keep entered name');
  await expect(modal(page).locator('[name="username"]')).toHaveAttribute('aria-invalid', 'true');
});

test('access removal asks for confirmation and sole-admin name edits keep protected flags', async ({ page, instance }) => {
  const created = await instance.api.post('/api/users', { data: { username: 'forms_member', displayName: 'Forms Member', isAdmin: false } });
  expect(created.ok()).toBeTruthy();
  const { user } = await created.json();
  await command(instance.api, 'membership.add', { projectId: instance.projects[0].project.id, userId: user.id, manageRoadmap: true, manageBoard: true });
  await openApp(page, instance, 'settings');
  const permission = page.locator('.permission-check').filter({ hasText: 'Board' }).last().locator('input');
  const permissions = [];
  page.on('request', request => { if (request.url().endsWith('/api/commands') && request.postDataJSON()?.operation === 'membership.update') permissions.push(request); });
  await permission.click();
  await expect(page.locator('[data-confirm-accept]')).toBeVisible();
  expect(permissions).toHaveLength(0);
  await page.locator('[data-confirm-cancel]').click();
  await expect(permission).toBeChecked();
  await permission.click();
  await page.locator('[data-confirm-accept]').click();
  await expect(permission).not.toBeChecked();
  expect(permissions).toHaveLength(1);
  await page.evaluate(() => window.App.nav('users'));
  await page.locator('.user-row').filter({ hasText: 'forms_member' }).click();
  let updates = 0;
  page.on('request', request => { if (request.url().includes('/api/users/') && request.method() === 'PATCH') updates++; });
  const save = () => modal(page).getByRole('button', { name: 'Save', exact: true }).click();
  await modal(page).locator('[name="active"]').uncheck();
  await save();
  await expect(page.locator('[data-confirm-accept]')).toHaveText('Deactivate user');
  expect(updates).toBe(0);
  await page.locator('[data-confirm-cancel]').click();
  await expect(modal(page).locator('[name="active"]')).not.toBeChecked();
  await save();
  await page.locator('[data-confirm-accept]').click();
  await expect(modal(page)).toHaveCount(0);
  expect(updates).toBe(1);
  await page.locator('.user-row').filter({ hasText: 'smoke_writer' }).click();
  await modal(page).locator('[name="admin"]').uncheck();
  await save();
  await expect(page.locator('[data-confirm-accept]')).toHaveText('Remove admin access');
  expect(updates).toBe(1);
  await page.locator('[data-confirm-cancel]').click();
  await save();
  await page.locator('[data-confirm-accept]').click();
  await expect(modal(page)).toHaveCount(0);
  expect(updates).toBe(2);
  await page.locator('.user-row').filter({ hasText: instance.username }).click();
  await expect(modal(page).locator('[name="admin"]')).toBeDisabled();
  await expect(modal(page).locator('[name="active"]')).toBeDisabled();
  await modal(page).locator('[name="name"]').fill('Renamed sole administrator');
  await save();
  await expect(modal(page)).toHaveCount(0);
  const directory = await (await page.request.get(`${instance.url}/api/users`)).json();
  expect(directory.users.find(user => user.username === instance.username)).toMatchObject({ displayName: 'Renamed sole administrator', isAdmin: true, isActive: true });
  const beforeNoChange = updates;
  await page.locator('.user-row').filter({ hasText: instance.username }).click();
  await save();
  await expect(modal(page)).toHaveCount(0);
  expect(updates).toBe(beforeNoChange);
});

test('an admin can recover after a member changes their own name', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/409 \(Conflict\)/);
  const self = await (await instance.writer.get('/api/auth/me')).json();
  await openApp(page, instance, 'users');
  const row = page.locator(`[data-user-id="${self.user.id}"]`);
  await expect(row).toBeVisible();
  const result = await instance.writer.patch('/api/auth/me', { data: { displayName: 'Changed by member' } });
  expect(result.ok(), await result.text()).toBeTruthy();
  await row.click();
  await modal(page).locator('input[name=name]').fill('Admin edit');
  await modal(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal(page).locator('input[name=name]')).toHaveValue('Changed by member');
  await expect(modal(page)).toContainText('Review the latest');
  await modal(page).locator('input[name=name]').fill('Reviewed admin edit');
  await modal(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row).toContainText('Reviewed admin edit');
});

test('Users directory failures stay local with a retry and no guessed count', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/500 .*\/api\/users\b/);
  await failUntilRetry(page, '**/api/users', { status: 500, body: JSON.stringify({ error: { code: 'internal_error', message: 'Fixture read failure' } }) });
  await openApp(page, instance, 'users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  await expect(page.locator('.settings [role="alert"]')).toContainText('Could not load users');
  await expect(page.locator('.users-count')).toHaveText('');
  await page.locator('.settings').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.settings [role="alert"]')).toHaveCount(0);
  await expect(page.locator('.user-row')).toHaveCount(2);
  await expect(page.locator('.users-count')).toHaveText('2');
});

for (const view of ['board', 'task']) {
  test(`losing membership on the ${view} loads another project, then reaches no projects`, async ({ page, instance, allowedConsoleErrors }) => {
    // Revoked resources intentionally become indistinguishable from missing ones.
    const projects = instance.projects.map(item => item.project.id).join('|');
    const tasks = instance.projects.map(item => item.task.id).join('|');
    allowedConsoleErrors.push(
      new RegExp(`404 .*\\/api\\/bootstrap\\?projectId=(?:${projects})&`),
      new RegExp(`404 .*\\/api\\/tasks\\/(?:${tasks})\\/attachments`),
    );
    const directory = await (await instance.writer.get('/api/users')).json();
    const owner = directory.users.find(user => user.id === instance.identity.user.id);
    const demoted = await instance.writer.patch(`/api/users/${owner.id}`, { data: {
      displayName: owner.displayName, isAdmin: false, isActive: true, expectedRevision: owner.revision,
    } });
    expect(demoted.ok(), await demoted.text()).toBeTruthy();
    await openApp(page, instance);
    if (view === 'board') await page.locator('.nav-item[title="Board"]').click();
    const [primary, secondary] = instance.projects;
    await expect(page).toHaveTitle(view === 'board' ? `Board · ${primary.project.name} · oneloop` : `${primary.task.taskKey} · ${primary.task.title} · oneloop`);
    // The Board read started by navigation can reach the server after revocation.
    // Allow only that project's protected read; all recovery assertions still run.
    allowedConsoleErrors.push(new RegExp(`404 .*\\/api\\/projects\\/${primary.project.id}\\/board-view\\?limit=50$`));
    await command(instance.writer, 'membership.remove', { projectId: primary.project.id, userId: owner.id }, 1);
    await expect(page).toHaveTitle(`Board · ${secondary.project.name} · oneloop`, { timeout: 5_000 });
    await expect(page.locator('.board')).toContainText(secondary.task.title);
    await expect(page.locator('.sidebar')).not.toContainText(primary.project.name);
    await expect(page.locator('.task-page')).toHaveCount(0);
    await expect(page.locator('.page-error')).toHaveCount(0);
    await command(instance.writer, 'membership.remove', { projectId: secondary.project.id, userId: owner.id }, 1);
    await expect(page.getByRole('heading', { name: 'No projects available' })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.sidebar')).not.toContainText(secondary.project.name);
    await expect(page.locator('.board')).toHaveCount(0);
    await expect(page.locator('.page-error')).toHaveCount(0);
  });
}

test('a wrong current password keeps the account signed in and the profile form open', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/400 .*\/api\/auth\/change-password\b/);
  await openApp(page, instance, 'profile');
  await expect(page).toHaveTitle('Profile · oneloop');
  await page.locator('input[name="cur"]').fill('a deliberately incorrect password');
  await page.locator('input[name="pw"]').fill('a candidate replacement password');
  await page.locator('input[name="pw2"]').fill('a candidate replacement password');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.locator('.settings')).toContainText(/current password.*incorrect|incorrect.*current password/i);
  await expect(page.locator('.settings')).toBeVisible();
  await expect(page.locator('input[name="username"]')).toHaveCount(0);
  expect((await page.request.get(`${instance.url}/api/auth/me`)).ok()).toBeTruthy();
});

test('late Profile access reads keep password input focus and caret', async ({ page, instance }) => {
  const delayed = await holdResponses(page, '**/api/auth/sessions');
  try {
    await openApp(page, instance, 'profile');
    await delayed.started;
    const password = page.locator('[name="pw"]');
    await password.fill('Unsent password remains here');
    await password.evaluate(input => input.setSelectionRange(4, 9));
    await delayed.release();
    await expect(page.locator('.profile-access [data-access-loading]')).toHaveCount(0);
    await expect(password).toHaveValue('Unsent password remains here');
    await expect(password).toBeFocused();
    expect(await password.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([4, 9]);
  } finally { await delayed.release(); }
});

test('revoking another session refreshes access and keeps the open password form', async ({ page, instance, playwright }) => {
  const extra = await playwright.request.newContext({ baseURL: instance.url, extraHTTPHeaders: { Origin: instance.url } });
  try {
    expect((await extra.post('/api/auth/login', { data: { username: instance.username, password: instance.password } })).ok()).toBeTruthy();
    const sessions = await (await extra.get('/api/auth/sessions')).json();
    const session = sessions.sessions.find(item => item.current);
    await openApp(page, instance, 'profile');
    const row = page.locator(`[data-session-id="${session.id}"]`);
    await expect(row).toBeVisible();
    await expect(page.getByText('Loading access…', { exact: true })).toHaveCount(0);
    await page.locator('[name="pw"]').fill('Unsent while revoking access');
    await row.getByRole('button').click();
    await page.locator('[data-confirm-cancel]').click();
    await expect(row).toBeVisible();
    await expect(page.locator('[name="pw"]')).toHaveValue('Unsent while revoking access');
    const delayed = await holdResponses(page, '**/api/auth/sessions');
    try {
      await row.getByRole('button').click();
      await page.locator('[data-confirm-accept]').click();
      await delayed.started;
      await page.locator('[name="pw"]').focus();
      await delayed.release();
      await expect(row).toHaveCount(0);
      await expect(page.locator('[name="pw"]')).toHaveValue('Unsent while revoking access');
      await expect(page.locator('[name="pw"]')).toBeFocused();
    } finally { await delayed.release(); }
  } finally { await extra.dispose(); }
});
