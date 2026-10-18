// The Roadmap: each track's lane of work, zoom and scales, tracks, keys and the epic drawer.
import { test, expect, openApp, holdResponses, command, useTheme } from '../support/test.mjs';

/** The date `offset` days from today, as the API takes it. */
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** The seeded track's lane. */
const laneOf = (page, name) => page.locator('.lane').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('each track\'s lane shows its work, and a teammate\'s changes reach it', { tag: '@smoke' }, async ({ page, instance }) => {
  await useTheme(page, 'dark');
  const { track, epic, task } = instance.projects[0];
  await openApp(page, instance, 'roadmap');
  await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
  const lane = laneOf(page, track.name);
  await expect(lane.locator('.lane-figure')).toHaveText('1 planned');
  // The seeded epic has only an undated plan: its header alone, after Today.
  await expect(lane.locator(`.rt-epic-label[data-epic="${epic.id}"]`)).toHaveText(`${epic.title}0/1`);
  await expect(page.locator('.rt-stat-late')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  // A teammate starts the task, late: it shows as a bar with the error icon, and the header counts it.
  const [moved] = (await command(instance.writer, 'task.move', { taskId: task.id, status: 'in_progress' }, task.revision)).entities;
  const [dated] = (await command(instance.writer, 'task.update', { taskId: task.id, deadline: day(-2) }, moved.revision)).entities;
  const bar = lane.locator(`.rt-bar[data-task="${task.taskKey}"]`);
  await expect(bar).toHaveClass(/rt-late/);
  await expect(bar.locator('.rt-icon-late')).toBeVisible();
  await expect(lane.locator('.lane-figure')).toHaveText('1 in progress');
  await expect(page.getByRole('button', { name: /^Overdue: 1 task/ })).toBeVisible();
  // A rename reads only the task it names, with the lanes' counts, and the lane changes in place.
  const reads = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/events')) reads.push(url); });
  await page.evaluate(() => { window.shownScroller = document.getElementById('rmScroll'); });
  await command(instance.writer, 'task.update', { taskId: task.id, title: 'Renamed by a teammate' }, dated.revision);
  await expect(bar.locator('.rt-title')).toHaveText('Renamed by a teammate');
  expect(reads.map(url => [url.pathname, url.searchParams.get('tasks')])).toEqual([[`/api/projects/${task.projectId}/roadmap/lanes`, task.id]]);
  expect(await page.evaluate(() => document.getElementById('rmScroll') === window.shownScroller)).toBe(true);
});

test('an epic created on the Roadmap shows at once with its dates and its progress', async ({ page, instance }) => {
  await openApp(page, instance, 'roadmap');
  await page.getByRole('button', { name: 'Epic', exact: true }).click();
  const dialog = page.locator('.modal');
  await dialog.locator('[name="title"]').fill('Fresh epic');
  await dialog.getByRole('button', { name: /^Track / }).click();
  await page.locator('.pop-opt').filter({ hasText: instance.projects[0].track.name }).click();
  await dialog.locator('[data-date-key="mStart"] .date-text').fill(day(3));
  await dialog.locator('[data-date-key="mEnd"] .date-text').fill(day(30));
  await dialog.getByRole('button', { name: 'Create epic', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Its own hint brings no Roadmap read, so the counts come with the result.
  const header = page.locator('.rt-epic-label').filter({ hasText: 'Fresh epic' });
  await expect(header).toContainText('0/0');
  await expect(header.locator('.rt-epic-dates')).toBeVisible();
});

test('a zoom keeps the Roadmap in place, months follow it, and both themes draw', async ({ page, instance, browserName, allowedConsoleErrors }, testInfo) => {
  const { project, track } = instance.projects[0];
  for (let i = 0; i < 3; i++) {
    const [made] = (await command(instance.api, 'task.create', { projectId: project.id, trackId: track.id, title: `Work ${i}`, deadline: day(10 + i * 3) })).entities;
    await command(instance.api, 'task.move', { taskId: made.id, status: 'in_progress' }, made.revision);
  }
  await openApp(page, instance, `roadmap/${project.id}?scale=months`);
  await expect(page.locator('.rt-bar')).toHaveCount(3);
  await page.evaluate(() => {
    window.originalSidebar = document.querySelector('.sidebar');
    window.originalScroll = document.getElementById('rmScroll');
    window.originalLane = document.querySelector('.lane');
    window.initialWidth = document.querySelector('.rm-canvas').offsetWidth;
    for (let i = 0; i < 5; i++) window.originalScroll.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, clientX: 800, bubbles: true, cancelable: true }));
  });
  // The zoom redraws the marks in place: the same scroller and lanes, wider, inside the same shell.
  await expect.poll(() => page.evaluate(() => document.querySelector('.rm-canvas').offsetWidth > window.initialWidth)).toBe(true);
  const unchanged = () => page.evaluate(() => document.getElementById('rmScroll') === window.originalScroll && window.originalLane.isConnected && document.querySelector('.sidebar') === window.originalSidebar);
  expect(await unchanged()).toBe(true);
  await expect(page.locator('.rt-bar')).toHaveCount(3);
  // Month lines follow the zoom through CSS: each sits at its day times the pixels per day.
  const lines = await page.locator('.rm-month-line').evaluateAll(cells => cells.map(cell => [cell.offsetLeft, Number(getComputedStyle(cell).getPropertyValue('--rm-rail').trim().replace('px', '')) + Number(cell.style.getPropertyValue('--d')) * Number(cell.parentElement.style.getPropertyValue('--ppd'))]));
  expect(lines.length).toBeGreaterThan(0);
  for (const [left, expected] of lines) expect(Math.abs(left - expected)).toBeLessThan(1);
  // Playwright's WebKit screenshots insert a style element to sync animations, which the policy refuses.
  if (browserName === 'webkit') allowedConsoleErrors.push(/Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/);
  for (const theme of ['light', 'dark']) {
    await page.mouse.move(1, 1);
    await page.keyboard.press('Escape');
    await page.evaluate(theme => App.setTheme(theme), theme);
    expect(await page.locator('.rail-cell').first().evaluate(el => getComputedStyle(el).backdropFilter)).toBe('none');
    await page.screenshot({ path: testInfo.outputPath(`roadmap-${theme}.png`), animations: 'disabled' });
  }
  // Long after the gesture ended, the Roadmap was still never rebuilt.
  expect(await unchanged()).toBe(true);
});

test('Weeks, Months and Quarters zoom the Roadmap in place and keep today in view', async ({ page, instance }) => {
  await openApp(page, instance, `roadmap/${instance.projects[0].project.id}?scale=months`);
  const scale = page.getByRole('group', { name: 'Timeline scale' });
  await expect(scale.getByRole('button', { name: 'Months' })).toHaveAttribute('aria-pressed', 'true');
  const todayShows = async () => {
    const [label, view] = await Promise.all([page.locator('.rt-today').boundingBox(), page.locator('#rmScroll').boundingBox()]);
    return label.x >= view.x && label.x + label.width <= view.x + view.width;
  };
  await scale.getByRole('button', { name: 'Weeks' }).click();
  await expect(scale.getByRole('button', { name: 'Weeks' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.rm-month-grid .rm-week').first()).toBeVisible();
  expect(await todayShows()).toBe(true);
  // Safari leaves focus on the page after a click on a button, as a click on empty space does.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('q');
  await expect(scale.getByRole('button', { name: 'Quarters' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(todayShows).toBe(true);
});

test.describe('with Reduce motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a scale change keeps today, then the focused task, where they were', async ({ page, instance }) => {
    const { project, track } = instance.projects[0];
    // A long epic leaves room to scroll on both sides of today, even at Quarters.
    await command(instance.api, 'epic.create', { projectId: project.id, trackId: track.id, title: 'Platform migration', startDate: day(-365), endDate: day(365) });
    const [made] = (await command(instance.api, 'task.create', { projectId: project.id, trackId: track.id, title: 'Holiday freeze', deadline: day(40) })).entities;
    await command(instance.api, 'task.move', { taskId: made.id, status: 'in_progress' }, made.revision);
    await openApp(page, instance, `roadmap/${project.id}?scale=months`);
    const scale = page.getByRole('group', { name: 'Timeline scale' });
    const left = locator => locator.evaluate(element => element.getBoundingClientRect().left);
    const keeps = async (measure, label) => {
      const before = await measure();
      for (const name of ['Weeks', 'Quarters', 'Months']) {
        await scale.getByRole('button', { name }).click();
        await expect(scale.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
        expect(Math.abs(await measure() - before), `${label} after ${name}`).toBeLessThanOrEqual(2);
      }
    };
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await keeps(() => left(page.locator('.rt-today')), 'today');
    const bar = page.locator(`.rt-bar[data-task="${made.taskKey}"]`);
    await bar.focus();
    await keeps(() => left(page.locator(`.rt-bar[data-task="${made.taskKey}"]`)), 'the focused task');
  });
});

test('the keyboard reaches each lane\'s grip, menu and timeline, moves along it, opens a task, and steps through what is overdue', async ({ page, instance }) => {
  const { project, track, task } = instance.projects[0];
  const [late] = (await command(instance.api, 'task.create', { projectId: project.id, trackId: track.id, title: 'Late work', deadline: day(-3) })).entities;
  await command(instance.api, 'task.move', { taskId: late.id, status: 'in_progress' }, late.revision);
  await command(instance.api, 'task.update', { taskId: task.id, deadline: day(14) }, task.revision);
  await openApp(page, instance, `roadmap/${project.id}?scale=months`);
  const lane = laneOf(page, track.name);
  await lane.getByRole('button', { name: `Reorder ${track.name}` }).focus();
  await page.keyboard.press('Tab');
  await expect(lane.getByRole('button', { name: `Manage ${track.name} track` })).toBeFocused();
  // The timeline is one stop; it starts on the work in progress, whose card shows.
  await page.keyboard.press('Tab');
  const bar = lane.locator(`.rt-bar[data-task="${late.taskKey}"]`);
  await expect(bar).toBeFocused();
  await expect(bar).toHaveAccessibleName(/^Late work, In Progress, started .+, due .+, 3 days late$/);
  await expect(page.locator('#task-tooltip')).toContainText('3d late');
  // The lane's own work comes first, then its epic and the epic's work.
  await page.keyboard.press('End');
  await expect(lane.locator(`.rt-planned[data-task="${task.taskKey}"]`)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(lane.locator('.rt-epic-label')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(bar).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lane.getByRole('button', { name: `Manage ${track.name} track` })).toBeFocused();
  // "Overdue 1" focuses the late task and shows its card.
  await page.getByRole('button', { name: /^Overdue: 1 task/ }).click();
  await expect(bar).toBeFocused();
  await expect(page.locator('#task-tooltip')).toContainText('Late work');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tp-title')).toHaveValue('Late work');
});

test('done work of one day is a count whose list the server gives, and a teammate\'s track rename reads no lanes', async ({ page, instance }) => {
  const { project, track } = instance.projects[0];
  const shipped = [];
  for (let i = 0; i < 3; i++) {
    const [made] = (await command(instance.api, 'task.create', { projectId: project.id, trackId: track.id, title: `Shipped ${i}` })).entities;
    shipped.push((await command(instance.api, 'task.move', { taskId: made.id, status: 'done' }, made.revision)).entities[0]);
  }
  await openApp(page, instance, `roadmap/${project.id}?scale=months`);
  const lane = laneOf(page, track.name);
  // Three done today: the lanes count them, and hold none of them.
  const count = lane.locator('.rt-count-done');
  await expect(count).toHaveText('3');
  const lists = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('/roadmap/list')) lists.push(url); });
  await count.click();
  const list = page.locator('#roadmap-list');
  await expect(list.locator('.tid')).toHaveText(shipped.map(task => task.taskKey).reverse());
  expect(lists.map(url => [url.searchParams.get('track'), url.searchParams.get('kind')])).toEqual([[track.id, 'done']]);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(count).toBeFocused();
  // A teammate renames the track: the Roadmap reads its tracks, epics and milestones, a few KiB, and no lanes.
  const reads = [];
  page.on('response', async response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/events')) reads.push([url.pathname, (await response.body()).length]); });
  await command(instance.writer, 'track.update', { trackId: track.id, name: 'Renamed track' }, track.revision);
  await expect(page.getByRole('heading', { name: 'Renamed track', exact: true })).toBeVisible();
  await expect.poll(() => reads.length).toBe(1);
  expect(reads[0][0]).toBe(`/api/projects/${project.id}/roadmap`);
  expect(reads[0][1]).toBeLessThan(8 * 1024);
  // A row of the list opens its task, which the page doesn't hold, with Enter.
  await laneOf(page, 'Renamed track').locator('.rt-count-done').click();
  await list.getByRole('button', { name: new RegExp(shipped[1].taskKey) }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.tp-title')).toHaveValue('Shipped 1');
  expect(page.url()).toContain(`#/task/${shipped[1].taskKey}`);
});

test('a done dot, a plan\'s ring and Overdue\'s late plan open their task with a click or Enter', async ({ page, instance }) => {
  const { project, track } = instance.projects[0];
  const [made] = (await command(instance.api, 'task.create', { projectId: project.id, trackId: track.id, title: 'Shipped alone' })).entities;
  const [shipped] = (await command(instance.api, 'task.move', { taskId: made.id, status: 'done' }, made.revision)).entities;
  const [plan] = (await command(instance.api, 'task.create', { projectId: project.id, trackId: track.id, title: 'Missed plan', deadline: day(-9) })).entities;
  await openApp(page, instance, `roadmap/${project.id}?scale=months`);
  const lane = laneOf(page, track.name);
  // Each is drawn on its own, and its task comes once its day is read.
  const dot = lane.locator(`.rt-done[data-task="${shipped.taskKey}"]`), ring = lane.locator(`.rt-planned[data-task="${plan.taskKey}"]`);
  await dot.click();
  await expect(page.locator('.tp-title')).toHaveValue('Shipped alone');
  await page.goBack();
  await ring.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.tp-title')).toHaveValue('Missed plan');
  await page.goBack();
  // "Overdue 1" focuses the late plan, and Enter opens it.
  await page.getByRole('button', { name: /^Overdue: 1 task/ }).click();
  await expect(ring).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.tp-title')).toHaveValue('Missed plan');
});

test('a track\'s name keeps clear of its grip and ⋮ on one line, and shows in full in its tip', async ({ page, instance }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { project } = instance.projects[0], long = 'Platform and infrastructure for every region and partner';
  for (const name of ['Internationalization', 'Customer support tools', long, 'Billing', 'Data', 'Mobile']) await command(instance.api, 'track.create', { projectId: project.id, name });
  await openApp(page, instance, 'roadmap');
  // The grip and ⋮ show where the pointer or focus is.
  const names = await page.locator('.lane').evaluateAll(lanes => lanes.map(lane => {
    const name = lane.querySelector('.name'), box = name.getBoundingClientRect(), controls = lane.querySelector('.head-ctl').getBoundingClientRect(), text = document.createRange();
    text.selectNodeContents(name);
    const shown = [...text.getClientRects()].filter(line => line.bottom <= box.bottom + 1 && line.left < box.right);
    return { name: name.textContent, lines: new Set(shown.map(line => Math.round(line.top))).size, covered: box.right > controls.left };
  }));
  expect(names.length).toBe(7);
  expect(names.filter(name => name.covered || name.lines > 1)).toEqual([]);
  const tip = page.locator('#app-tip');
  await laneOf(page, long).locator('.name').hover();
  await expect(tip).toHaveText(long);
  await page.mouse.move(1, 1);
  await expect(tip).toHaveCount(0);
  // Keyboard focus reaches the grip from the ⋮ beside it.
  await laneOf(page, long).getByRole('button', { name: `Manage ${long} track` }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(laneOf(page, long).getByRole('button', { name: `Reorder ${long}` })).toBeFocused();
  await expect(tip).toHaveText(long);
  await laneOf(page, 'Billing').getByRole('button', { name: 'Manage Billing track' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(laneOf(page, 'Billing').getByRole('button', { name: 'Reorder Billing' })).toBeFocused();
  await expect(tip, 'a name that fits needs no tip').toHaveCount(0);
});

test('marks scrolled under the rail stay behind it', async ({ page, instance }) => {
  // The lanes hold still instead of sliding when the Roadmap's read draws them again.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { project, track } = instance.projects[0];
  // A long epic leaves room to scroll today under the rail.
  await command(instance.api, 'epic.create', { projectId: project.id, trackId: track.id, title: 'Platform migration', startDate: day(-365), endDate: day(365) });
  await openApp(page, instance, `roadmap/${project.id}?scale=months`);
  // Today's label and line scroll to the middle of the rail.
  const covered = await page.evaluate(() => {
    const scroll = document.getElementById('rmScroll'), label = document.querySelector('.rt-today'), rail = document.querySelector('.rm-axis .rail-cell');
    const middle = box => box.left + box.width / 2;
    scroll.scrollLeft += middle(label.getBoundingClientRect()) - middle(rail.getBoundingClientRect());
    const box = label.getBoundingClientRect(), x = middle(box), lane = document.querySelector('.lane').getBoundingClientRect();
    return [rail.contains(document.elementFromPoint(x, box.top + box.height / 2)), document.querySelector('.lane .rail-cell').contains(document.elementFromPoint(x, lane.top + lane.height / 2))];
  });
  expect(covered).toEqual([true, true]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the Roadmap header keeps Today, Milestone and Epic in view', async ({ page, instance }) => {
    await openApp(page, instance, 'roadmap');
    const header = page.locator('.topbar');
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 812 });
      for (const name of ['Today', 'Milestone', 'Epic']) {
        const box = await header.getByRole('button', { name, exact: true }).boundingBox();
        expect(box.x, `${width}: ${name}`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${width}: ${name}`).toBeLessThanOrEqual(width);
      }
    }
    // At 320 pixels only screen readers get the heading.
    await expect(header.getByRole('heading', { name: 'Roadmap', exact: true })).toBeAttached();
    // Pinch zoom, the wheel and W, M and Q still change the scale here.
    await expect(page.getByRole('group', { name: 'Timeline scale' })).toBeHidden();
  });

  test('each track\'s head sits above its lane, its 32 px grip and menu clear of its name', async ({ page, instance }) => {
    const { project } = instance.projects[0];
    for (const name of ['Platform and infrastructure for every region', 'Billing']) await command(instance.api, 'track.create', { projectId: project.id, name });
    await openApp(page, instance, 'roadmap');
    const lanes = await page.locator('.lane').evaluateAll(all => all.map(lane => {
      const head = lane.querySelector('.lane-head').getBoundingClientRect(), body = lane.querySelector('.rt-body').getBoundingClientRect();
      const name = lane.querySelector('.name').getBoundingClientRect(), grip = lane.querySelector('.grip').getBoundingClientRect();
      return { above: head.bottom <= body.top + 1, clear: name.right <= grip.left, grip: [grip.width, grip.height], fits: head.right <= innerWidth };
    }));
    expect(lanes.length).toBe(3);
    for (const lane of lanes) expect(lane).toEqual({ above: true, clear: true, grip: [32, 32], fits: true });
  });
});

test('a teammate renaming a task updates the open epic drawer', async ({ page, instance }) => {
  const { epic, task } = instance.projects[0];
  await openApp(page, instance, 'roadmap');
  await page.locator(`.rt-epic-label[data-epic="${epic.id}"]`).press('Enter');
  const rows = page.locator('.peek .task-row');
  await expect(rows).toContainText(task.title);
  await command(instance.writer, 'task.update', { taskId: task.id, title: 'Renamed by a teammate' }, task.revision);
  await expect(rows).toContainText('Renamed by a teammate');
});

test('track keyboard moves and pointer Board/track drags save and cancel', async ({ page, instance }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { project, track, task } = instance.projects[0];
  const [second] = (await command(instance.api, 'track.create', { projectId: project.id, name: 'Second track' })).entities;
  const [third] = (await command(instance.api, 'track.create', { projectId: project.id, name: 'Third track' })).entities;
  await openApp(page, instance, 'roadmap');
  const order = () => page.locator('.lane').evaluateAll(els => els.map(el => el.dataset.track));
  const settled = () => expect.poll(() => page.evaluate(() => App.context().movePending)).toBe(false);
  const grip = page.getByRole('button', { name: `Reorder ${track.name}`, exact: true });
  await grip.press('ArrowDown');
  await expect(grip).toBeFocused();
  // The only keyboard way to move a track shows its focus at full strength.
  await expect(grip).toHaveCSS('opacity', '1');
  await expect.poll(order).toEqual([second.id, track.id, third.id]);
  await settled();
  await grip.press('End');
  await expect.poll(order).toEqual([second.id, third.id, track.id]);
  await expect(grip).toBeFocused();
  await settled();
  const source = await grip.boundingBox(), target = await page.locator(`[data-track="${second.id}"] .lane-head`).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 100, target.y + 4, { steps: 8 });
  await expect(page.locator('.sort-marker')).toBeVisible();
  // The held lane dims its name, but its rail cell stays solid, so no line shows through it.
  const shown = locator => locator.evaluate(element => { let opacity = 1; for (let el = element; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity); return opacity; });
  const held = page.locator(`.lane[data-track="${track.id}"]`);
  await expect.poll(() => shown(held.locator('.lane-head'))).toBe(1);
  await expect.poll(() => shown(held.locator('.name'))).toBe(0.4);
  await page.mouse.up();
  await expect.poll(order).toEqual([track.id, second.id, third.id]);
  await expect(grip).toBeFocused();
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
  await expect.poll(() => page.evaluate(() => App.context().movePending)).toBe(false);
  expect((await (await instance.api.get(`/api/tasks/${task.taskKey}`)).json()).status).toBe('in_review');
});

test('late epic reads keep drawer focus and unsent editor text', async ({ page, instance }) => {
  const { project, epic: source } = instance.projects[0];
  await openApp(page, instance, 'board');
  const roadmapRead = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/roadmap`));
  const countRead = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/counts`));
  await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
  await Promise.all([roadmapRead, countRead]);
  const epic = page.locator(`.rt-epic-label[data-epic="${source.id}"]`), drawer = page.locator('.peek');
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
