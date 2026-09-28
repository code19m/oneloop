// The Pool: capturing ideas, editing them and promoting them to tasks.
import { test, expect, openApp, holdResponses, failUntilRetry, command } from '../support/test.mjs';

const modal = page => page.locator('.modal');

async function openPool(page, instance) {
  await openApp(page, instance, 'board');
  await page.getByRole('button', { name: /^Pool/ }).click();
  await expect(page.locator('.pool-view')).toBeVisible();
}

async function chooseEpic(page, instance) {
  await modal(page).getByRole('button', { name: /^Epic / }).click();
  await page.locator('.pop-opt').filter({ hasText: instance.projects[0].epic.title }).click();
}

/** Record the payloads of one command operation sent by the page. */
function writes(page, operation) {
  const list = [];
  page.on('request', request => { if (request.url().endsWith('/api/commands') && request.postDataJSON()?.operation === operation) list.push(request.postDataJSON()); });
  return list;
}

async function boardTitles(instance, title) {
  const board = await (await instance.api.get(`/api/projects/${instance.projects[0].project.id}/board?status=planning`)).json();
  return board.items.filter(item => item.title === title);
}

test('Pool capture submits once and keeps the next entry during its refresh', { tag: '@smoke' }, async ({ page, instance }) => {
  await openPool(page, instance);
  await expect(page.locator('.pool-list')).toContainText('Seeded Pool item');
  const input = page.getByLabel('Add pool item', { exact: true });
  const reads = await holdResponses(page, '**/api/projects/*/pool?*');
  const creates = writes(page, 'pool.create');
  try {
    await input.fill('One captured idea');
    await input.press('Enter');
    await reads.started;
    await expect(input).toHaveValue('');
    await input.fill('Next idea still being written');
    await input.press('Enter');
    expect(creates).toHaveLength(1);
    await reads.release();
    await expect(page.locator('.pool-list')).toContainText('One captured idea');
    await expect(input).toHaveValue('Next idea still being written');
    const response = await page.request.get(`${instance.url}/api/projects/${instance.projects[0].project.id}/pool?scope=personal`);
    expect((await response.json()).items.filter(item => item.title === 'One captured idea')).toHaveLength(1);
  } finally { await reads.release(); }
});

test('Pool keeps newly typed title, notes and focus when its first read finishes', async ({ page, instance }) => {
  await openApp(page, instance, 'board');
  const reads = await holdResponses(page, '**/api/projects/*/pool?*');
  try {
    await page.getByRole('button', { name: /^Pool/ }).click();
    await reads.started;
    await page.getByLabel('Add pool item', { exact: true }).fill('Still typing this Pool item');
    await page.getByRole('button', { name: 'Add description', exact: true }).click();
    await page.locator('#poolNewDesc').fill('Keep these notes while the read finishes.');
    await reads.release();
    await expect(page.locator('.pool-list')).toContainText('Seeded Pool item');
    await expect(page.locator('#poolAdd')).toHaveValue('Still typing this Pool item');
    await expect(page.locator('#poolNewDesc')).toHaveValue('Keep these notes while the read finishes.');
    await expect(page.locator('#poolNewDesc')).toBeFocused();
  } finally { await reads.release(); }
});

test('an on-demand Pool failure offers a local retry and keeps capture text', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/503 .*\/api\/projects\/[^/]+\/pool\?/);
  await failUntilRetry(page, '**/api/projects/*/pool?*', { status: 503, body: JSON.stringify({ error: { code: 'unavailable', message: 'Try again shortly' } }) });
  await openApp(page, instance, 'board');
  await page.getByRole('button', { name: /^Pool/ }).click();
  await page.locator('#poolAdd').fill('Keep this idea');
  const pool = page.locator('.pool-view');
  await expect(pool.getByRole('alert')).toContainText('Could not load items');
  await expect(pool.locator('.empty-note')).toHaveCount(0);
  await pool.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(pool.locator('.pool-row')).toHaveCount(1);
  await expect(pool.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#poolAdd')).toHaveValue('Keep this idea');
});

test('Pool save and deletion keep unrelated capture while updating only the saved row', async ({ page, instance }) => {
  const [entry] = (await command(instance.api, 'pool.create', { projectId: instance.projects[0].project.id, scope: 'personal', title: 'Edit this row', description: 'Old notes' })).entities;
  await openPool(page, instance);
  const row = page.locator(`[data-pool-item="${entry.id}"]`);
  await row.locator('.pool-note-toggle').click();
  await row.locator('textarea').fill('Saved row notes');
  await page.locator('#poolAdd').fill('Unsubmitted capture');
  await page.getByRole('button', { name: 'Add description', exact: true }).click();
  await page.locator('#poolNewDesc').fill('Unsubmitted capture notes');
  const delayed = await holdResponses(page, '**/api/projects/*/pool?*');
  try {
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await delayed.started;
    await page.locator('#poolNewDesc').focus();
    await delayed.release();
    await expect(row.locator('.pool-description-preview')).toHaveText('Saved row notes');
    await expect(row.locator('textarea')).toHaveCount(0);
    await expect(page.locator('#poolNewDesc')).toBeFocused();
  } finally { await delayed.release(); }
  await expect(page.locator('#poolAdd')).toHaveValue('Unsubmitted capture');
  await expect(page.locator('#poolNewDesc')).toHaveValue('Unsubmitted capture notes');
  await row.locator('.pool-delete').click();
  await page.locator('[data-confirm-cancel]').click();
  await expect(row).toBeVisible();
  await row.locator('.pool-delete').click();
  await page.locator('[data-confirm-accept]').click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('#poolAdd')).toHaveValue('Unsubmitted capture');
  await expect(page.locator('#poolNewDesc')).toHaveValue('Unsubmitted capture notes');
});

test('My and Team promotion send the source revision and edited task text', async ({ page, instance }) => {
  const project = instance.projects[0];
  const entries = [];
  for (const scope of ['personal', 'team']) entries.push((await command(instance.api, 'pool.create', { projectId: project.project.id, scope, title: `Promote ${scope}`, description: 'Captured description' })).entities[0]);
  await openPool(page, instance);
  const sent = writes(page, 'pool.promote');
  for (const [index, entry] of entries.entries()) {
    await page.locator(`[data-pool-tab="${index ? 'project' : 'mine'}"]`).click();
    const row = page.locator(`[data-pool-item="${entry.id}"]`);
    await row.locator('.pool-promote').click();
    await chooseEpic(page, instance);
    await modal(page).locator('[name="title"]').fill(`Edited ${entry.title}`);
    await modal(page).locator('[name="desc"]').fill(`Edited ${entry.description}`);
    await modal(page).getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(page.locator('.pool-view')).toBeVisible();
    await expect(row).toHaveCount(0);
    expect(sent[index].expectedRevision).toBe(entry.revision);
    expect(sent[index].payload).toMatchObject({ title: `Edited ${entry.title}`, description: `Edited ${entry.description}` });
  }
  for (const entry of entries) expect(await boardTitles(instance, `Edited ${entry.title}`)).toHaveLength(1);
});

test('Pool promotion resolves a stale source without losing edits', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/409 .*\/api\/commands\b/);
  const [stale] = (await command(instance.api, 'pool.create', { projectId: instance.projects[0].project.id, scope: 'personal', title: 'Stale promotion source' })).entities;
  await openPool(page, instance);
  await page.locator(`[data-pool-item="${stale.id}"] .pool-promote`).click();
  await chooseEpic(page, instance);
  await modal(page).locator('[name="title"]').fill('Preserved edited conflict title');
  await modal(page).locator('[name="desc"]').fill('Preserved edited conflict notes');
  const attempts = writes(page, 'pool.promote');
  await command(instance.api, 'pool.update', { poolItemId: stale.id, title: 'Remote source title', description: 'Changed remotely' }, stale.revision);
  await page.evaluate(() => window.Recovery.reconnect());
  await expect.poll(() => page.evaluate(id => window.DATA.pool.find(item => item.id === id)?.revision, stale.id)).toBe(2);
  await expect(modal(page).locator('[name="title"]')).toHaveValue('Preserved edited conflict title');
  await modal(page).locator('[name="title"]').press('Enter');
  await expect(page.getByRole('button', { name: 'Keep my changes', exact: true })).toBeVisible();
  await expect(modal(page).locator('[name="title"]')).toHaveValue('Preserved edited conflict title');
  await expect(modal(page).locator('[name="desc"]')).toHaveValue('Preserved edited conflict notes');
  await page.getByRole('button', { name: 'Keep my changes', exact: true }).click();
  await expect(page.locator('.pool-view')).toBeVisible();
  await expect(page.locator(`[data-pool-item="${stale.id}"]`)).toHaveCount(0);
  expect(attempts.map(item => item.expectedRevision)).toEqual([1, 2]);
  expect(attempts.every(item => item.payload.title === 'Preserved edited conflict title' && item.payload.description === 'Preserved edited conflict notes')).toBeTruthy();
  expect(await boardTitles(instance, 'Preserved edited conflict title')).toHaveLength(1);
});

test('Pool promotion reconciles an uncertain result without duplicates', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/ERR_FAILED .*\/api\/commands\b/);
  const [retry] = (await command(instance.api, 'pool.create', { projectId: instance.projects[0].project.id, scope: 'team', title: 'Uncertain promotion source' })).entities;
  await openPool(page, instance);
  await page.locator('[data-pool-tab="project"]').click();
  await page.locator(`[data-pool-item="${retry.id}"] .pool-promote`).click();
  await chooseEpic(page, instance);
  await modal(page).locator('[name="title"]').fill('Single uncertain task');
  await modal(page).locator('[name="desc"]').fill('Retry keeps notes');
  const attempts = [];
  let aborted = false;
  await page.route('**/api/commands', async route => {
    const body = route.request().postDataJSON();
    if (body.operation !== 'pool.promote') return route.continue();
    attempts.push(body);
    // The first promotion reaches the server, but its response is lost.
    if (!aborted) { aborted = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await modal(page).getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(modal(page)).toContainText(/result is unknown|Connection lost/);
  await expect(modal(page).locator('[name="desc"]')).toHaveValue('Retry keeps notes');
  await page.evaluate(() => window.Recovery.reconnect());
  await modal(page).getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.locator('.pool-view')).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0].idempotencyKey).toBe(attempts[1].idempotencyKey);
  expect(await boardTitles(instance, 'Single uncertain task')).toHaveLength(1);
});

test('Use latest during an Enter promotion refreshes source text and keeps the chosen task fields', async ({ page, instance, allowedConsoleErrors }) => {
  allowedConsoleErrors.push(/409 .*\/api\/commands\b/);
  const project = instance.projects[0];
  const [source] = (await command(instance.api, 'pool.create', { projectId: project.project.id, scope: 'team', title: 'Source before editing', description: 'Source notes before editing' })).entities;
  await openPool(page, instance);
  await page.locator('[data-pool-tab="project"]').click();
  await page.locator(`[data-pool-item="${source.id}"] .pool-promote`).click();
  await chooseEpic(page, instance);
  const title = modal(page).locator('[name="title"]'), description = modal(page).locator('[name="desc"]');
  await title.fill('My draft title');
  await description.fill('My draft description');
  await modal(page).locator('.date-text').fill('2026-12-18');
  await modal(page).getByRole('button', { name: 'Assignees', exact: true }).click();
  await page.locator('.pop-opt').filter({ hasText: instance.identity.user.displayName }).click();
  await page.keyboard.press('Escape');
  const attempts = writes(page, 'pool.promote');
  await command(instance.api, 'pool.update', { poolItemId: source.id, title: 'Latest source title', description: 'Latest source notes' }, source.revision);
  await page.evaluate(() => window.Recovery.reconnect());
  await expect.poll(() => page.evaluate(id => window.DATA.pool.find(item => item.id === id)?.revision, source.id)).toBe(2);
  await expect(title).toHaveValue('My draft title');
  await title.press('Enter');
  await expect(page.getByRole('button', { name: 'Use latest', exact: true })).toBeVisible();
  expect(attempts.map(item => item.expectedRevision)).toEqual([1]);
  await page.getByRole('button', { name: 'Use latest', exact: true }).click();
  await expect(title).toHaveValue('Latest source title');
  await expect(description).toHaveValue('Latest source notes');
  await expect(title).toBeFocused();
  await expect(modal(page).locator('[name="epicId"]')).toHaveValue(project.epic.id);
  await expect(modal(page).locator('.date-text')).toHaveValue('2026-12-18');
  await expect(modal(page).locator('[name="assignees"]')).toHaveValue(instance.identity.user.id);
  expect(attempts).toHaveLength(1);
  await title.press('Enter');
  await expect(page.locator('.pool-view')).toBeVisible();
  expect(attempts.map(item => item.expectedRevision)).toEqual([1, 2]);
  expect(attempts[1].payload).toMatchObject({ title: 'Latest source title', description: 'Latest source notes', epicId: project.epic.id, deadline: '2026-12-18', assigneeIds: [instance.identity.user.id] });
  expect(await boardTitles(instance, 'Latest source title')).toHaveLength(1);
  const board = await (await instance.api.get(`/api/projects/${project.project.id}/board?status=planning`)).json();
  expect(board.items.some(item => item.title.includes('newer version is loaded'))).toBeFalsy();
});
