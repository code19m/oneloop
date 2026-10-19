// Startup, sign-in, upgrades and navigation between routes.
import { test, expect, openApp, signIn, expectSignedIn, holdResponses, command } from '../support/test.mjs';

test('cold startup stays neutral and sign-in does not depend on previews', { tag: '@smoke' }, async ({ page, instance }) => {
  const optional = [];
  await page.route(/\/(vendor\/(marked|dompurify|katex|cdn-assets\/highlight)|styles\/markdown-preview\.css)/, route => {
    optional.push(route.request().url());
    return route.abort();
  });
  const identity = await holdResponses(page, '**/api/auth/me');
  try {
    const document = await page.goto(instance.url + '/#/roadmap', { waitUntil: 'commit' });
    expect(document.headers()['cross-origin-opener-policy']).toBe('same-origin');
    await identity.started;
    await expect(page.locator('.startup-status')).toBeVisible();
    await expect(page.locator('.loading-state')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toHaveCount(0);
  } finally { await identity.release(); }
  await expect(page.locator('input[name="username"]')).toBeVisible();
  await signIn(page, instance);
  await expect(page.locator('#rmScroll')).toBeVisible();
  expect(optional).toEqual([]);
  const bootstrap = await holdResponses(page, '**/api/bootstrap**');
  try {
    await page.reload({ waitUntil: 'commit' });
    await bootstrap.started;
    await expect(page.locator('.startup-status')).toBeVisible();
    await expect(page.locator('.loading-state')).toHaveCount(0);
  } finally { await bootstrap.release(); }
  await expect(page.locator('#rmScroll')).toBeVisible();
  expect(optional).toEqual([]);
});

test('the theme follows the device until someone picks one', async ({ page, instance }) => {
  const shown = () => page.evaluate(() => document.documentElement.dataset.theme);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(instance.url);
  await expect(page.locator('input[name="username"]')).toBeVisible();
  expect(await shown()).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(shown).toBe('light');
  await page.evaluate(() => Theme.set('dark'));
  await page.reload();
  await expect(page.locator('input[name="username"]')).toBeVisible();
  expect(await shown()).toBe('dark');
});

test('signing in again in the same tab keeps the project you chose', async ({ page, instance }) => {
  const [, second] = instance.projects;
  const switcher = page.locator('.switcher-btn'), cards = page.locator('.board .card');
  await openApp(page, instance, 'board');
  await switcher.click();
  await page.locator('#project-switcher-menu').getByRole('button', { name: second.project.name }).click();
  await expect(cards).toContainText(second.task.title);
  await page.evaluate(() => App.logout());
  await page.locator('.confirmation-layer').getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, instance);
  await expect(switcher).toHaveAccessibleName(`Project: ${second.project.name}`);
  await expect(cards).toContainText(second.task.title);
  await page.getByRole('button', { name: 'Task', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New task' }).getByRole('textbox', { name: 'Title' })).toBeVisible();
});

test('Sign out signs out the other open tabs at once, and they forget their project', async ({ page, context, instance }) => {
  const [, second] = instance.projects;
  await openApp(page, instance, `board/${second.project.id}`);
  const other = await context.newPage();
  await other.goto(`${instance.url}/#/roadmap/${second.project.id}`);
  await expectSignedIn(other);
  await page.evaluate(() => App.logout());
  await page.locator('.confirmation-layer').getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(other.locator('input[name="username"]')).toBeVisible();
  await expect(other).toHaveURL(`${instance.url}/#/roadmap`);
  // Signed out on purpose, as in the tab that signed out: no session ended by itself.
  await expect(other.locator('.auth-notice')).toHaveCount(0);
});

test('Sign out keeps what was typed in the other open tabs for the same person', async ({ page, context, instance }) => {
  const [first] = instance.projects;
  await openApp(page, instance, `board/${first.project.id}`);
  const other = await context.newPage();
  await other.goto(`${instance.url}/#/task/${first.task.taskKey}`);
  await expectSignedIn(other);
  await other.locator('#cmtIn').fill('Typed in the other tab');
  await page.evaluate(() => App.logout());
  // Nothing is typed in this tab, so its question warns of nothing.
  const question = page.locator('.confirmation-layer');
  await expect(question).toContainText('End your current browser session.');
  await expect(question).not.toContainText('will be lost');
  await question.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(other.locator('input[name="username"]')).toBeVisible();
  await expect(other.locator('.auth-notice')).toHaveCount(0);
  await signIn(other, instance);
  await expectSignedIn(other);
  // The tab forgot its address, so the comment waits until its task opens again.
  await other.evaluate(key => { location.hash = `#/task/${key}`; }, first.task.taskKey);
  await expect(other.locator('#cmtIn')).toHaveValue('Typed in the other tab');
});

test('a hidden tab ends its session when someone else signs in from another tab, and keeps what was typed for its person', async ({ page, context, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/status of 401/);
  // A background tab tells the page only through document.visibilityState.
  await context.addInitScript(() => {
    let state = 'visible';
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => state === 'hidden' });
    window.showTab = visible => { state = visible ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
  });
  await openApp(page, instance, `task/${instance.projects[0].task.taskKey}`);
  await page.locator('#cmtIn').fill('Typed by the owner');
  await page.evaluate(() => window.showTab(false));
  // In another tab of this browser, the owner signs out and the writer signs in.
  expect((await context.request.post(`${instance.url}/api/auth/logout`, { headers: { Origin: instance.url } })).ok()).toBeTruthy();
  await context.addCookies((await instance.writer.storageState()).cookies);
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.evaluate(() => window.showTab(true));
  await expect(page.locator('.auth-notice')).toHaveText('Your session ended. Sign in again to keep what you typed.');
  await expect(page.getByText('Smoke Writer')).toHaveCount(0);
  await expect(page.locator('#cmtIn')).toHaveCount(0);
  expect(await page.evaluate(() => window.DATA.session)).toBeNull();
  expect(writes).toEqual([]);
  // The owner signs in again here and gets their text back.
  await signIn(page, instance);
  await expect(page.locator('#cmtIn')).toHaveValue('Typed by the owner');
});

test('a module loading failure offers a startup retry', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/api-client\.js/, /Loading failed for the module/);
  await page.route('**/src/data/api-client.js', route => route.abort());
  await page.goto(instance.url);
  await expect(page.getByRole('heading', { name: 'Could not start oneloop' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('sign-in errors describe and focus the field; session limits focus their heading', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/401 .*\/api\/auth\/login\b/, /409 .*\/api\/auth\/login\b/);
  await page.goto(instance.url);
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Username' }).fill(instance.username);
  const password = page.locator('[name="password"]');
  await password.fill('Incorrect password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(password).toBeFocused();
  await expect(password).toHaveAccessibleDescription('Incorrect username or password.');
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  for (let i = 0; i < 9; i++) expect((await instance.api.post('/api/auth/login', { data: { username: instance.username, password: instance.password } })).ok()).toBeTruthy();
  await password.fill(instance.password);
  const limitResponse = page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.status() === 409);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await (await limitResponse).json()).error.details.timeZone).toBe('UTC');
  const heading = page.getByRole('heading', { name: 'Session limit reached' });
  await expect(heading).toBeFocused();
  await expect(page.getByRole('region', { name: 'Session limit reached' })).toBeVisible();
});

test('a build change after reconnect offers reload without overwriting open input', async ({ page, instance }) => {
  await openApp(page, instance);
  await expect.poll(() => page.evaluate(() => !!window.ONELOOP_BUILD)).toBe(true);
  const field = page.locator('#task-description');
  await field.fill('Keep my open input');
  await page.route('**/healthz', route => route.fulfill({ json: { version: '99.0.0', revision: 'new-build' } }));
  await page.evaluate(() => OneloopRuntime.transport.publish({ type: 'live-open' }));
  await expect(page.locator('.connection-notice')).toContainText('oneloop was updated');
  await expect(field).toHaveValue('Keep my open input');
  await expect(field).toBeFocused();
});

test('the account menu shows the release version only, and a long one wraps inside the menu', async ({ page, instance }) => {
  const version = '0.1.0-rc.5.20261016120000.0123456789abcdef', revision = '5cee2010df88a8d229d0048c2a0c51ac8fb69e61';
  await page.route('**/healthz', route => route.fulfill({ json: { status: 'ok', version, revision } }));
  await openApp(page, instance, 'board');
  await page.locator('.me-chip').click();
  const menu = page.locator('.profile-menu'), shown = menu.locator('.menu-version');
  await expect(shown.locator('[aria-hidden="true"]')).toHaveText(`v${version}`);
  await expect(shown.locator('.sr-only')).toHaveText(`Version ${version}`);
  await expect(menu).not.toContainText(revision.slice(0, 8));
  expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth), 'the menu does not scroll sideways').toBe(true);
});

test('an unresolved task uses its layout while loading and only shows a confirmed 404', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/404 .*\/api\/tasks\//);
  await openApp(page, instance, 'board');
  const task = instance.projects[1].task;
  const pending = await holdResponses(page, `**/api/tasks/${task.taskKey}`);
  try {
    await page.evaluate(key => { location.hash = `#/task/${key}`; }, task.taskKey);
    await pending.started;
    await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toHaveCount(0);
    await expect(page.locator('.loading-task')).toBeVisible();
    await expect(page.locator('.loading-state')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toBeVisible();
  } finally { await pending.release(); }
  await expect(page.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(task.title);
  await page.evaluate(() => { location.hash = '#/task/%E0%A4%A'; });
  await expect(page.locator('.page-error .error-code')).toHaveText('404');
  await expect(page).toHaveURL(/#\/task\/%E0%A4%A$/);
  await page.evaluate(() => { location.hash = '#/task/UNKNOWN-999'; });
  await expect(page.locator('.page-error .error-code')).toHaveText('404');
  await expect(page.getByRole('heading', { name: 'Page not found', exact: true }).first()).toBeVisible();
  await expect(page.locator('.loading-task')).toHaveCount(0);
});

test('a response the test holds is the answer the page gets when it is released', async ({ page, instance }) => {
  const { task } = instance.projects[1];
  await openApp(page, instance, 'board');
  const held = await holdResponses(page, `**/api/tasks/${task.taskKey}`);
  const answer = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${task.taskKey}`));
  try {
    await page.evaluate(key => { location.hash = `#/task/${key}`; }, task.taskKey);
    await held.started;
    // The task changes after the server answered the held read.
    await command(instance.api, 'task.update', { taskId: task.id, title: 'Changed after the answer' }, task.revision);
  } finally { await held.release(); }
  expect((await (await answer).json()).title).toBe(task.title);
});

test('a delayed task destination cannot reopen after the user returns to Board', async ({ page, instance }) => {
  await openApp(page, instance);
  const secondary = instance.projects[1];
  const reads = await holdResponses(page, `**/api/tasks/${secondary.task.taskKey}`);
  try {
    await page.evaluate(key => { location.hash = `#/task/${key}`; }, secondary.task.taskKey);
    await reads.started;
    await page.locator('.nav-item[title="Board"]').click();
    const board = new RegExp(`#/board/${instance.projects[0].project.id}$`);
    await expect(page).toHaveURL(board);
    await reads.release();
    await expect(page).toHaveURL(board);
    await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
    await expect(page.locator('.task-page')).toHaveCount(0);
    await expect(page).toHaveTitle(/Board · .* · oneloop/);
  } finally { await reads.release(); }
});

test('a sidebar click still navigates when a render lands between press and release', async ({ page, instance }) => {
  await openApp(page, instance);
  const board = await page.locator('.nav-item[title="Board"]').boundingBox();
  await page.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
  await page.mouse.down();
  // Background work, such as the route-loading indicator, renders at any moment.
  await page.evaluate(() => window.App.refresh());
  await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(`#/board/${instance.projects[0].project.id}$`));
  await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
});

test('Back to Board still goes to the Board when a change made elsewhere draws the task page between press and release', async ({ page, instance }) => {
  await openApp(page, instance);
  const back = await page.getByRole('button', { name: 'Back to Board' }).boundingBox();
  await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
  await page.mouse.down();
  // A live update draws the page in the background, which waits for no field there now.
  await page.evaluate(() => window.App.refreshBackground());
  await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(`#/board/${instance.projects[0].project.id}$`));
  await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
});

test('keyboard menus, refresh focus and titles stay contextual across navigation', async ({ page, instance }) => {
  const primary = instance.projects[0], secondary = instance.projects[1];
  await openApp(page, instance);
  await expect(page).toHaveTitle(`${primary.task.taskKey} · ${primary.task.title} · oneloop`);
  const actions = page.getByRole('button', { name: 'Task actions', exact: true });
  await actions.focus();
  await actions.press('Enter');
  await expect(page.locator('.comment-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toBeFocused();
  await page.locator('.nav-item[title="Board"]').click();
  await expect(page).toHaveTitle(`Board · ${primary.project.name} · oneloop`);
  const search = page.getByLabel('Search tasks', { exact: true });
  await search.fill('UIA');
  await expect(search).toBeFocused();
  // Trigger a genuine other-client change and let the live view reconcile.
  await command(instance.writer, 'task.update', { taskId: primary.task.id, description: 'Changed by another client' }, primary.task.revision);
  await expect.poll(async () => page.evaluate(id => window.DATA.tasks.find(task => task.internalId === id)?.revision, primary.task.id)).toBeGreaterThan(primary.task.revision);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('UIA');
  await page.locator('.switcher-btn').click();
  await page.locator('.project-option').filter({ hasText: secondary.project.name }).click();
  await expect(page).toHaveTitle(`Board · ${secondary.project.name} · oneloop`);
  await expect(page.locator('.board')).toContainText(secondary.task.title);
  await expect(page.locator('.board')).not.toContainText(primary.task.title);
});

test('the address keeps the project through a refresh, Back and Forward, and a new tab opens the project switched to last', async ({ page, context, instance }) => {
  const [first, second] = instance.projects;
  const titles = target => target.locator('.board .card-title-button');
  await openApp(page, instance, 'board');
  await expect(page).toHaveURL(`${instance.url}/#/board/${first.project.id}`);
  await page.locator('.switcher-btn').click();
  await page.locator('#project-switcher-menu').getByRole('button', { name: second.project.name }).click();
  await expect(page).toHaveURL(`${instance.url}/#/board/${second.project.id}`);
  await page.reload();
  await expect(page.locator('.switcher-btn')).toHaveAccessibleName(`Project: ${second.project.name}`);
  await expect(titles(page)).toHaveText([second.task.title]);
  await page.goBack();
  await expect(titles(page)).toHaveText([first.task.title]);
  await page.goForward();
  await expect(titles(page)).toHaveText([second.task.title]);
  // An address from before projects had one opens the project this browser switched to last.
  const tab = await context.newPage();
  await tab.goto(`${instance.url}/#/board`);
  await expect(tab).toHaveURL(`${instance.url}/#/board/${second.project.id}`);
  await expect(titles(tab)).toHaveText([second.task.title]);
});

test('choosing another project on Page not found opens its page of that kind with one request', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/404 .*\/api\/bootstrap\?/);
  const [, second] = instance.projects;
  const shown = {
    board: page.locator('.board .card-title-button').filter({ hasText: second.task.title }),
    // The epic's task counts come with the project, so no Roadmap read follows.
    roadmap: page.locator('.rt-epic-label[data-epic]').filter({ hasText: second.epic.title }).filter({ hasText: '0/1' }),
  };
  for (const kind of ['board', 'roadmap']) {
    await openApp(page, instance, `${kind}/no-such-project`);
    await expect(page.locator('.page-error .error-code')).toHaveText('404');
    // The project's reads, without the live stream or session checks, which run at any moment.
    const requests = [], record = request => { const url = new URL(request.url()); if (url.pathname === '/api/bootstrap' || url.pathname.startsWith('/api/projects/')) requests.push(url); };
    page.on('request', record);
    await page.locator('.switcher-btn').click();
    await page.locator('#project-switcher-menu').getByRole('button', { name: second.project.name }).click();
    await expect(page).toHaveURL(`${instance.url}/#/${kind}/${second.project.id}`);
    await expect(shown[kind]).toBeVisible();
    page.off('request', record);
    expect(requests.map(url => [url.pathname, url.searchParams.get('projectId'), url.searchParams.get('view')]), kind).toEqual([['/api/bootstrap', second.project.id, kind]]);
  }
});

test('a link into another project loads that project first, showing the Board skeleton until it lands', async ({ page, instance }) => {
  const [first, second] = instance.projects;
  const titles = page.locator('.board .card-title-button');
  await openApp(page, instance, 'board');
  await expect(titles).toHaveText([first.task.title]);
  await page.evaluate(id => { location.hash = `#/knowledge/${id}`; }, second.project.id);
  await expect(page.locator('.switcher-btn')).toHaveAccessibleName(`Project: ${second.project.name}`);
  await page.locator('.nav-item[title="Board"]').click();
  await expect(titles).toHaveText([second.task.title]);
  await page.goBack();
  const bootstrap = await holdResponses(page, '**/api/bootstrap**');
  try {
    await page.goBack();
    await bootstrap.started;
    await expect(page.locator('.board .loading-board')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No tasks yet' })).toHaveCount(0);
  } finally { await bootstrap.release(); }
  await expect(titles).toHaveText([first.task.title]);
});

test('members navigate every accessible project and see all Inbox project choices', async ({ page, instance, playwright }) => {
  const created = await instance.api.post('/api/users', { data: { username: 'regular_member', displayName: 'Regular member', isAdmin: false } });
  expect(created.ok()).toBeTruthy();
  const { user, temporaryPassword } = await created.json();
  for (const { project } of instance.projects) await command(instance.api, 'membership.add', { projectId: project.id, userId: user.id, manageRoadmap: false, manageBoard: true });
  const member = await playwright.request.newContext({ baseURL: instance.url, extraHTTPHeaders: { Origin: instance.url } });
  const password = 'regular password';
  try {
    expect((await member.post('/api/auth/login', { data: { username: 'regular_member', password: temporaryPassword } })).ok()).toBeTruthy();
    expect((await member.post('/api/auth/change-password', { data: { currentPassword: temporaryPassword, newPassword: password } })).ok()).toBeTruthy();
    await openApp(page, { ...instance, username: 'regular_member', password }, 'board');
    await page.locator('.switcher-btn').click();
    await expect(page.locator('#project-switcher-menu button')).toHaveCount(2);
    await page.locator('#project-switcher-menu button').filter({ hasText: 'Browser secondary' }).click();
    await expect(page.locator('.card-title-button')).toHaveText('UIB seeded task');
    await page.evaluate(() => App.nav('inbox'));
    await page.locator('.inbox-filter-group .sel-btn').click();
    await expect(page.locator('.pop-opt').filter({ hasText: 'Browser primary' })).toBeVisible();
    await expect(page.locator('.pop-opt').filter({ hasText: 'Browser secondary' })).toBeVisible();
  } finally { await member.dispose(); }
});
