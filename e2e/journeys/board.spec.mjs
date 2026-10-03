// The Board: columns, filters, creation, moves and paint budgets.
import { readFileSync } from 'node:fs';
import { test, expect, openApp, holdResponses, command } from '../support/test.mjs';

test('Board keeps its filter controls and task columns', { tag: '@smoke' }, async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
  await expect(page.getByLabel('Search tasks')).toBeVisible();
  await expect(page.locator('[data-filter-key="fTrack"]')).toContainText('All tracks');
  await expect(page.locator('.board .col')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('on narrow screens the toolbar stays centered and the first column keeps its gutter', async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  for (const width of [390, 600, 852]) {
    await page.setViewportSize({ width, height: 800 });
    // Column snapping must stop at the board's padding, not at its scroll edge.
    await expect.poll(() => page.evaluate(() => {
      const board = document.querySelector('.board');
      return document.querySelector('.board .col').getBoundingClientRect().left - board.getBoundingClientRect().left;
    }), `${width}: first column gutter`).toBeGreaterThanOrEqual(12);
    const toolbar = await page.evaluate(() => {
      const bar = document.querySelector('.page-header > .topbar');
      const header = document.querySelector('.page-header').getBoundingClientRect();
      const control = document.querySelector('.board-filters > *').getBoundingClientRect();
      return { overflows: bar.scrollWidth > bar.clientWidth, scrollbar: bar.offsetHeight - bar.clientHeight, above: control.top - header.top, below: header.bottom - control.bottom };
    });
    expect(toolbar.overflows, `${width}: the toolbar scrolls sideways`).toBe(true);
    expect(toolbar.scrollbar, `${width}: no scrollbar takes height from the toolbar`).toBe(0);
    expect(Math.abs(toolbar.above - toolbar.below), `${width}: controls are vertically centered`).toBeLessThanOrEqual(1);
  }
});

test('track filters open, select and close with the keyboard', async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  const filter = page.locator('[data-filter-key="fTrack"]');
  await filter.click();
  const menu = page.locator('.pop');
  await expect(menu).toBeVisible();
  const firstOption = menu.locator('.pop-opt').first();
  await firstOption.click();
  await expect(firstOption).toHaveAttribute('aria-pressed', 'true');
  await expect(filter).not.toContainText('All tracks');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(filter).toBeFocused();
});

// Only selected reads are delayed; authentication, commands and live events are real.
test('creation stays single while its post-save read is delayed', { tag: '@smoke' }, async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  await expect(page.locator('.board .card')).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Task', exact: true }).click();
  const modal = page.locator('.modal');
  await modal.locator('input[name="title"]').fill('Create once through delayed loading');
  await expect(modal.getByRole('button', { name: /^Epic / })).toContainText('Choose an epic');
  await modal.getByRole('button', { name: /^Epic / }).click();
  await page.locator('.pop-opt').filter({ hasText: instance.projects[0].epic.title }).click();
  const reads = await holdResponses(page, '**/api/bootstrap**');
  const accepted = await holdResponses(page, '**/api/commands');
  let creates = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/commands') && request.postDataJSON()?.operation === 'task.create') creates++;
  });
  try {
    await modal.getByRole('button', { name: 'Create task', exact: true }).click();
    await accepted.started;
    await expect(modal.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
    await modal.locator('input[name="title"]').press('Enter');
    await modal.locator('input[name="title"]').press('Enter');
    expect(creates).toBe(1);
    await accepted.release();
    await reads.started;
    await expect(modal).toBeHidden();
  } finally { await accepted.release(); await reads.release(); }
  await expect(modal).toBeHidden();
  const body = await (await instance.api.get(`/api/projects/${instance.projects[0].project.id}/board?status=planning`)).json();
  expect(body.items.filter(task => task.title === 'Create once through delayed loading')).toHaveLength(1);
});

test('Board search coalesces typing and unchanged refresh avoids geometry work', async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  await expect(page.locator('.board .card').first()).toBeVisible();
  const requests = [];
  page.on('request', request => { if (new URL(request.url()).searchParams.has('search')) requests.push(request.url()); });
  const search = page.getByPlaceholder('Search tasks');
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1_000);
  await search.pressSequentially('seeded');
  await page.clock.runFor(200);
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator('.board .card')).toHaveCount(1);
  await page.clock.runFor(250);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get('search')).toBe('seeded');
  const reads = await page.evaluate(() => {
    const original = Element.prototype.getBoundingClientRect;
    let reads = 0;
    Element.prototype.getBoundingClientRect = function () { reads++; return original.call(this); };
    try { for (let i = 0; i < 5; i++) App.refreshBoard(); return reads; } finally { Element.prototype.getBoundingClientRect = original; }
  });
  expect(reads).toBe(0);
  await search.fill('absent');
  await search.press('Enter');
  await expect(page.getByRole('heading', { name: 'No matching tasks' })).toBeVisible();
  await search.fill('');
  await page.clock.runFor(200);
  await expect(page.locator('.board .card')).toHaveCount(1);
});

test('boot paints the Board once and overlays retain its DOM', async ({ page, context, instance }) => {
  await context.addCookies((await instance.api.storageState()).cookies);
  await page.addInitScript(() => {
    window.appPaints = 0;
    const replace = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (...nodes) { if (this.id === 'app') window.appPaints++; return replace.apply(this, nodes); };
  });
  await page.goto(instance.url + '/#/board');
  await expect(page.locator('.board .card')).toHaveCount(1);
  await page.waitForFunction(() => !!window.OneloopRuntime);
  expect(await page.evaluate(() => window.appPaints)).toBe(1);
  expect(await page.evaluate(() => {
    const rect = Element.prototype.getBoundingClientRect;
    let count = 0;
    Element.prototype.getBoundingClientRect = function () { count++; return rect.call(this); };
    try { App.refreshBoard(); return count; } finally { Element.prototype.getBoundingClientRect = rect; }
  })).toBe(0);
  await page.evaluate(() => { window.boardNode = document.querySelector('.board'); window.cardNode = document.querySelector('.card'); });
  const open = page.getByRole('button', { name: 'Task', exact: true });
  for (let index = 0; index < 3; index++) {
    await open.click();
    await expect(page.locator('.modal')).toBeVisible();
    expect(await page.locator('.main').evaluate(node => node.inert)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(open).toBeFocused();
  }
  expect(await page.evaluate(() => window.boardNode === document.querySelector('.board') && window.cardNode === document.querySelector('.card') && window.appPaints === 1)).toBe(true);
});

test('the initial Board snapshot avoids duplicate reads and reconciles a write during subscription', async ({ page, context, instance }) => {
  await context.addCookies((await instance.api.storageState()).cookies);
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(...args) { super(...args); for (const kind of ['ready', 'reconcile']) this.addEventListener(kind, () => { window.snapshotEvent ??= kind; }); }
    };
  });
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.goto(instance.url + '/#/board');
  await page.waitForFunction(() => window.snapshotEvent);
  // Seeded outbox delivery may correctly invalidate the first snapshot. Measure
  // duplicate reads only after a fresh document gets a matching handshake.
  await expect(async () => {
    requests.length = 0;
    await page.reload();
    await page.waitForFunction(() => window.snapshotEvent);
    expect(await page.evaluate(() => window.snapshotEvent)).toBe('ready');
  }).toPass({ timeout: 10_000 });
  await expect(page.locator('.board .card')).toHaveCount(1);
  expect(requests.filter(path => path === '/api/bootstrap')).toHaveLength(1);
  expect(requests.filter(path => path.endsWith('/board-view'))).toHaveLength(0);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/events*', async route => { entered(); await gate; await route.continue(); });
  try {
    await page.reload();
    await started;
    await command(instance.api, 'task.update', { taskId: instance.projects[0].task.id, title: 'Changed during subscription' }, 1);
  } finally { release(); }
  await expect(page.locator('.card-title-button')).toHaveText('Changed during subscription');
});

test('a scaled Board boots once and keeps overlays, avatars and filters bounded', async ({ page, context, instance }) => {
  test.setTimeout(90_000);
  const { project, track, epic } = instance.projects[0], epics = [epic];
  const [otherTrack] = (await command(instance.api, 'track.create', { projectId: project.id, name: 'Other track' })).entities;
  for (let i = 1; i < 12; i++) epics.push((await command(instance.api, 'epic.create', { projectId: project.id, trackId: i % 2 ? otherTrack.id : track.id, title: `Scale epic ${i}`, startDate: '2026-09-24' })).entities[0]);
  for (let i = 1; i < 200; i++) {
    const [task] = (await command(instance.api, 'task.create', { projectId: project.id, epicId: epics[i % 12].id, title: `Scale task ${i}` })).entities;
    if (i % 4) await command(instance.api, 'task.move', { taskId: task.id, status: ['planning', 'in_progress', 'in_review', 'done'][i % 4] }, task.revision);
  }
  const png = readFileSync(new URL('../../frontend/icons/favicon-32.png', import.meta.url));
  const avatar = await instance.api.put('/api/auth/avatar', { headers: { 'X-File-Size': String(png.length) }, multipart: { file: { name: 'avatar.png', mimeType: 'image/png', buffer: png } } });
  expect(avatar.ok(), await avatar.text()).toBeTruthy();
  await context.addCookies((await instance.api.storageState()).cookies);
  await page.addInitScript(() => {
    window.appPaints = 0; window.adoptGeometry = 0;
    const replace = Element.prototype.replaceChildren, rect = Element.prototype.getBoundingClientRect;
    Element.prototype.replaceChildren = function (...nodes) { if (this.id === 'app') window.appPaints++; return replace.apply(this, nodes); };
    Element.prototype.getBoundingClientRect = function () { if (new Error().stack.includes('adoptBoard')) window.adoptGeometry++; return rect.call(this); };
  });
  const requests = [];
  page.on('request', r => requests.push(new URL(r.url())));
  await page.goto(instance.url + '/#/board');
  await expect(page.locator('.board .card')).toHaveCount(200);
  await page.waitForFunction(() => !!window.OneloopRuntime);
  expect(await page.evaluate(() => ({ paints: window.appPaints, geometry: window.adoptGeometry }))).toEqual({ paints: 1, geometry: 0 });
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(r => ({ encoded: r.encodedBodySize, decoded: r.decodedBodySize, transfer: r.transferSize })));
  // The first-view transfer budget applies only when responses are compressed.
  if (resources.some(r => r.encoded > 0 && r.encoded < r.decoded)) expect(resources.reduce((sum, r) => sum + r.transfer, 0)).toBeLessThan(1.5 * 1024 * 1024);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Task', exact: true }).click();
    await expect(page.locator('.modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
  }
  expect(requests.filter(url => /\/avatar$/.test(url.pathname))).toHaveLength(1);
  await page.locator('[data-filter-key=fEpic]').click();
  await page.locator('.pop [data-v]').filter({ hasText: epic.title }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-filter-key=fTrack]').click();
  await page.locator('.pop [data-v]').filter({ hasText: 'Other track' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-filter-key=fEpic]')).toHaveClass(/empty/);
  await expect(page.locator('[data-filter-key=fEpic]')).toContainText('All epics');
  const opener = page.getByRole('button', { name: 'Task', exact: true });
  await opener.click();
  await page.evaluate(() => App.refresh());
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});

test('a card title drags to another column and remains a keyboard task link', async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  const card = page.locator('.card').first(), title = card.locator('.card-title-button'), target = page.locator('[data-col="review"]');
  const box = await title.boundingBox(), destination = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width / 2, destination.y + 70, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => ((await instance.api.get(`/api/tasks/${instance.projects[0].task.id}`)).json()).then(t => t.status)).toBe('in_review');
  await expect(page.locator('[data-col=review] .card')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => !!App._boardMovePending)).toBe(false);
  // Let the card's move animation settle, while the pointer-click guard is still active.
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await title.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.tp-title')).toBeVisible();
});

test('touch and pen grips reorder without taking away card-body scrolling', async ({ page, instance, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP supplies native touch and pen input');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page, instance, 'board');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const move = page.locator('.card-move').first();
  expect(await move.evaluate(el => getComputedStyle(el).touchAction)).toBe('none');
  expect(await page.locator('.card').evaluate(el => getComputedStyle(el).touchAction)).not.toBe('none');
  const touch = async (cancel = false) => {
    const source = await move.boundingBox(), target = await page.locator('[data-col="progress"] .col-cards').boundingBox();
    const x = source.x + source.width / 2, y = source.y + source.height / 2, tx = target.x + target.width / 2, ty = target.y + 40;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (tx - x) * i / 8, y: y + (ty - y) * i / 8 }] });
    await expect(page.locator('.drag-preview')).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  };
  await touch(true);
  await expect(page.locator('[data-col="planning"] .card')).toHaveCount(1);
  await expect(page.locator('.drag-preview')).toHaveCount(0);
  await touch();
  await expect(page.locator('[data-col="progress"] .card')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => !!App._boardMovePending)).toBe(false);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  const source = await move.boundingBox(), target = await page.locator('[data-col="review"] .col-cards').boundingBox();
  const x = source.x + source.width / 2, y = source.y + source.height / 2, tx = target.x + target.width / 2, ty = target.y + 40;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (tx - x) * i / 8, y: y + (ty - y) * i / 8, button: 'left', buttons: 1, pointerType: 'pen' });
  await expect(page.locator('.drag-preview')).toBeVisible();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  await expect(page.locator('[data-col="review"] .card')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => !!App._boardMovePending)).toBe(false);
  expect((await (await instance.api.get(`/api/tasks/${instance.projects[0].task.taskKey}`)).json()).status).toBe('in_review');
});

test.describe('with a touch screen', () => {
  test.use({ hasTouch: true });
  test('the card move target fits its row and the reported primary pointer', async ({ page, instance }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, instance, 'board');
    const size = await page.locator('.card-move').first().evaluate(el => {
      const box = el.getBoundingClientRect(), row = el.closest('.id-row').getBoundingClientRect();
      return { width: box.width, height: box.height, row: row.height, coarse: matchMedia('(pointer:coarse)').matches };
    });
    // Firefox's hasTouch emulation retains a fine primary pointer on desktop.
    const minimum = size.coarse ? 44 : 24;
    expect(size.width).toBeGreaterThanOrEqual(minimum);
    expect(size.height).toBeGreaterThanOrEqual(minimum);
    expect(size.row).toBeGreaterThanOrEqual(size.height);
  });
});
