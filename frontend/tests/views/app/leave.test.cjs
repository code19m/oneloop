// views/app.js with the recovery controller and the view bridge: oneloop asks
// before typed text would be lost, and reloads after an update only when the
// person chose that.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle, waitFor } = require('../../support/dom.cjs');
const { installViewBridge } = require('../../../src/app/view-bridge.js');

/** Whether the browser would ask before the tab leaves oneloop. */
function leaveWarns(t) { const event = new t.w.Event('beforeunload', { cancelable: true }); t.w.dispatchEvent(event); return event.defaultPrevented; }
/** Whether moving to another page of oneloop would ask first. */
const pageWarns = t => t.w.Recovery.hasUnsavedInput({ leaving: false });
const type = (element, value) => { element.focus(); element.value = value; };
/**
 * What the app runs: the view bridge with the real recovery controller. The
 * gateway records each command and leaves it running, unless a test gives its
 * own. The bridge watches the document it runs in, as in a browser.
 */
function withBridge(t, { reloadBootstrap = async () => ({ stale: false }), gateway } = {}) {
  const commands = [];
  gateway ??= { execute: (operation, payload) => new Promise((resolve, reject) => { commands.push({ operation, payload, resolve, reject }); }), hasPending: () => false };
  const previous = globalThis.document; globalThis.document = t.d;
  try {
    const bridge = installViewBridge({ app: t.A, data: t.D, api: {}, reads: { cancel() {} }, gateway, auth: {}, recovery: t.w.Recovery, reloadBootstrap });
    return { ...t, bridge, commands };
  } finally { globalThis.document = previous; }
}
const ask = t => t.d.querySelector('.confirmation-layer [role="alertdialog"]');

test('an unsent comment makes leaving warn, and a clean page leaves quietly', () => {
  const t = bootApp({ route: 'task/BIR-079' });
  assert.equal(leaveWarns(t), false);
  type(t.d.getElementById('cmtIn'), 'Half a thought');
  assert.equal(leaveWarns(t), true); assert.equal(pageWarns(t), true);
  t.A.refresh();
  assert.equal(t.d.getElementById('cmtIn').value, 'Half a thought');
  assert.equal(leaveWarns(t), true, 'the text still counts after the page redraws it');
  type(t.d.getElementById('cmtIn'), '');
  assert.equal(leaveWarns(t), false);
});

test('a dialog counts what was typed into it until it closes', () => {
  const t = bootApp({ route: 'roadmap' });
  t.A.openModal('epic');
  assert.equal(pageWarns(t), false, 'an untouched dialog');
  type(t.d.querySelector('.modal [name="title"]'), 'Payment retries');
  assert.equal(pageWarns(t), true);
  t.A.closeOverlays();
  assert.equal(leaveWarns(t), false);
});

test('search boxes and fields that saved when they lost focus never count', async () => {
  const board = bootApp({ route: 'board' });
  type(board.d.querySelector('[data-board-search]'), 'payment');
  assert.equal(leaveWarns(board), false, 'the Board search');
  const settings = withBridge(bootApp({ route: 'settings', actions: true }));
  type(settings.d.getElementById('member-search'), 'robin');
  assert.equal(leaveWarns(settings), false, 'the member search');
  const name = settings.d.querySelector('.project-fields [name="name"]');
  type(name, 'Renamed project');
  assert.equal(leaveWarns(settings), true, 'a name still being typed');
  name.blur(); await settle();
  assert.deepEqual(settings.commands.map(command => command.operation), ['project.update']);
  assert.equal(name.value, 'Renamed project');
  assert.equal(leaveWarns(settings), false, 'the name saved when it lost focus');
  name.focus();
  assert.equal(leaveWarns(settings), false, 'focusing it again without typing');
});

test('an untouched New user or Edit user dialog leaves quietly; a ticked checkbox counts', () => {
  const t = bootApp({ route: 'users' });
  for (const id of [undefined, 'robin']) {
    t.A.openModal('user', id);
    assert.equal(leaveWarns(t), false, id ? 'Edit user' : 'New user');
    t.d.querySelector('.modal [name="admin"]').click();
    assert.equal(leaveWarns(t), true, 'the person changed Admin');
    t.A.closeOverlays();
  }
});

test('a permission checkbox saves when it changes, so it never counts, also while it has focus', async () => {
  const t = withBridge(bootApp({ route: 'settings', actions: true }));
  const box = t.d.querySelector('.member-access-row input[type="checkbox"][data-autosave]:not(:checked)');
  box.focus(); box.click(); await settle();
  assert.deepEqual(t.commands.map(command => command.operation), ['membership.update']);
  assert.equal(t.d.activeElement, box);
  assert.equal(leaveWarns(t), false);
});

/** Type a deadline on the task page and press Enter, as a person does. */
function enterDeadline(t, value) {
  const deadline = t.d.getElementById('tpDl-input');
  type(deadline, value);
  t.A.dateKey({ key: 'Enter', target: deadline, preventDefault() {}, stopPropagation() {} }, 'tpDl');
  return deadline;
}
/** Leave the deadline field with Tab, which saves it. */
const tabAway = (t, deadline) => { deadline.blur(); t.A.dateBlur({ target: deadline }, 'tpDl'); };
const deadlines = t => t.commands.map(command => [command.operation, command.payload.deadline]);

test('a deadline saved with Enter counts as saved once the server accepts it, though it keeps focus', async () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' })), task = t.D.tasks.find(item => item.id === 'BIR-079');
  const deadline = enterDeadline(t, '2026-12-24');
  await settle();
  assert.deepEqual(deadlines(t), [['task.update', '2026-12-24']]);
  assert.equal(pageWarns(t), true, 'not saved until the server answers');
  Object.assign(task, { deadline: '2026-12-24', revision: task.revision + 1 });
  t.commands[0].resolve({ entities: [{ id: task.internalId, revision: task.revision }], events: [] }); await settle();
  assert.equal(t.d.activeElement, deadline);
  assert.equal(leaveWarns(t), false);
  tabAway(t, deadline); await settle();
  assert.equal(t.commands.length, 1, 'leaving the field does not save the same date again');
});

test('a deadline whose save fails keeps counting, and Tab sends it again', async () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' }));
  const deadline = enterDeadline(t, '2026-12-24');
  await settle();
  t.commands[0].reject(new t.w.TestApiError('down', { status: 503, code: 'unavailable' })); await settle();
  assert.equal(deadline.value, '2026-12-24', 'the field keeps the typed date');
  assert.equal(pageWarns(t), true); assert.equal(leaveWarns(t), true);
  tabAway(t, deadline); await settle();
  assert.deepEqual(deadlines(t), [['task.update', '2026-12-24'], ['task.update', '2026-12-24']]);
});

test('a deadline typed offline is refused at once, keeps counting, and Tab sends it once online', async () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' }));
  t.w.Recovery.observeResponse({ ok: false, error: new t.w.TestApiError('Network', { code: 'network_error' }) });
  const deadline = enterDeadline(t, '2026-12-24');
  await settle();
  assert.deepEqual(t.commands, [], 'nothing is sent');
  assert.match(t.d.getElementById('toast-region').textContent, /Reconnect before making this change\./);
  assert.equal(deadline.value, '2026-12-24'); assert.equal(pageWarns(t), true);
  t.w.Recovery.observeResponse({ ok: true }); assert.equal(t.w.Recovery.connection, 'live');
  tabAway(t, deadline); await settle();
  assert.deepEqual(deadlines(t), [['task.update', '2026-12-24']]);
});

test('a comment that is being sent does not count, and counts again if the send fails', async () => {
  let finish;
  const t = bootApp({ route: 'task/BIR-079', prepare(_D, w) {
    w.OneloopTransport = {};
    w.OneloopCollaboration = { bind() { return { saveComment(input) { return new Promise(resolve => { finish = saved => { if (!saved) input.unsent(); resolve(saved); }; }); } }; } };
  } });
  type(t.d.getElementById('cmtIn'), 'On its way');
  assert.equal(pageWarns(t), true);
  t.A.addComment('BIR-079');
  assert.equal(t.d.getElementById('cmtIn').value, '', 'the text left the box as it was sent');
  assert.equal(pageWarns(t), false, 'the comment is being sent');
  finish(false); await settle();
  assert.equal(t.d.getElementById('cmtIn').value, 'On its way', 'a send that failed brings it back');
  assert.equal(pageWarns(t), true, 'the person keeps the text of a send that failed');
});

test('opening a comment for editing counts only once its text changes', () => {
  const t = bootApp({ route: 'task/BIR-079', prepare(D) { D.tasks.find(task => task.id === 'BIR-079').comments = [{ id: 'c1', who: D.session.userId, ts: Date.now() - 60_000, text: 'Saved text', mentions: [], parentId: null }]; } });
  t.A.editComment('BIR-079', 'c1');
  assert.equal(t.d.getElementById('cmtIn').value, 'Saved text');
  assert.equal(pageWarns(t), false);
  type(t.d.getElementById('cmtIn'), 'Saved text, edited');
  assert.equal(pageWarns(t), true);
});

test('a temporary password counts as unsaved while it shows or waits, so neither a reload after an update nor leaving loses it', () => {
  const t = bootApp({ route: 'users' });
  const user = t.D.users.find(item => item.id !== t.D.session.userId);
  assert.equal(t.w.Recovery.hasUnsavedInput(), false);
  t.A.showTemporaryPassword(user.id, 'shown-once-password');
  assert.ok(t.d.getElementById('tmpPw'));
  assert.equal(t.w.Recovery.hasUnsavedInput(), true); assert.equal(leaveWarns(t), true);
  assert.equal(pageWarns(t), false, 'another page of oneloop keeps it');
  t.A.closeOverlays();
  assert.equal(t.w.Recovery.hasUnsavedInput(), false);
  t.A.openModal('user', user.id);
  assert.equal(t.A.showTemporaryPassword(user.id, 'waiting-password', { wait: true }), true, 'its own dialog gives way at once');
  t.A.closeOverlays(); t.A.openModal('project');
  assert.equal(t.A.showTemporaryPassword(user.id, 'waiting-password', { wait: true }), false);
  assert.equal(t.w.Recovery.hasUnsavedInput(), true, 'a password waiting for another dialog counts too');
});

test('running saves, uploads and drafts count only when leaving oneloop', async () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' }));
  let finish;
  t.w.Recovery.trackWrite(new Promise(resolve => { finish = resolve; }));
  assert.equal(leaveWarns(t), true); assert.equal(pageWarns(t), false, 'a save carries on on another page');
  finish(); await settle();
  assert.equal(leaveWarns(t), false);
  t.bridge.keepTaskDraft('BIR-079', 'desc', 'A description that could not be saved');
  assert.equal(leaveWarns(t), true); assert.equal(pageWarns(t), false, 'a draft waits for the task page');
});

test('deleting a task drops its Not saved drafts, and its Undo counts as nothing unsaved', async () => {
  const page = bootApp({ route: 'task/BIR-079' }), item = page.D.tasks.find(task => task.id === 'BIR-079');
  const t = withBridge(page, { gateway: { execute: async () => ({ entities: [{ id: item.internalId, revision: 7 }], events: [] }), hasPending: () => false } });
  t.bridge.keepTaskDraft('BIR-079', 'desc', 'A description that could not be saved');
  assert.equal(leaveWarns(t), true, 'a draft waits for the task page');
  t.A.deleteTask('BIR-079');
  t.d.querySelector('[data-confirm-accept]').click();
  await waitFor(() => t.d.querySelector('.toast-action'), 'the deletion offers Undo');
  assert.equal(t.A.context().view, 'board'); assert.equal(ask(t), null, 'deleting goes to the Board without asking');
  assert.equal(leaveWarns(t), false, 'nothing of the deleted task counts');
});

test('another page asks first: Cancel keeps the text and Discard moves on', () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' }));
  type(t.d.getElementById('cmtIn'), 'Half a thought');
  t.A.nav('board');
  assert.equal(ask(t).querySelector('h2').textContent, 'Discard changes?');
  t.d.querySelector('[data-confirm-cancel]').click();
  assert.equal(t.A.context().view, 'task');
  assert.equal(t.d.getElementById('cmtIn').value, 'Half a thought');
  t.A.nav('board');
  t.d.querySelector('[data-confirm-accept]').click();
  assert.equal(t.A.context().view, 'board');
});

/** The browser's Back button, once the page has handled the change it makes. */
async function back(t) { const before = t.w.location.href; t.w.history.back(); await waitFor(() => t.w.location.href !== before || ask(t), 'Back changed the page'); await settle(); }

test('Back saves a field that saves itself before the page changes, and does not ask', async () => {
  const t = withBridge(bootApp({ route: 'board', actions: true }));
  t.A.openTask('BIR-079'); await settle();
  const description = t.d.getElementById('task-description');
  type(description, 'Typed before Back');
  await back(t);
  assert.equal(ask(t), null);
  assert.equal(t.A.context().view, 'board');
  assert.deepEqual(t.commands.map(command => [command.operation, command.payload.description]), [['task.update', 'Typed before Back']]);
});

test('Back with typed text puts the address back and asks; Discard then goes without asking again', async () => {
  const t = withBridge(bootApp({ route: 'roadmap' }));
  t.A.nav('board'); await settle();
  t.A.openTask('BIR-079'); await settle();
  type(t.d.getElementById('cmtIn'), 'Half a thought');
  await back(t);
  assert.equal(ask(t).querySelector('h2').textContent, 'Discard changes?');
  assert.equal(t.w.location.hash, '#/task/BIR-079', 'the address shows the page that still shows');
  t.d.querySelector('[data-confirm-cancel]').click();
  assert.equal(t.A.context().view, 'task'); assert.equal(t.d.getElementById('cmtIn').value, 'Half a thought');
  await back(t);
  assert(ask(t));
  t.d.querySelector('[data-confirm-accept]').click(); await settle();
  assert.equal(ask(t), null, 'Discard asks once');
  assert.equal(t.w.location.hash, '#/roadmap'); assert.equal(t.A.context().view, 'roadmap');
});

test('a link to another page with typed text asks once, and Discard follows it', async () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' }));
  type(t.d.getElementById('cmtIn'), 'Half a thought');
  const link = t.d.createElement('a'); link.href = '#/board'; link.textContent = 'Board'; t.d.querySelector('.task-page').append(link);
  link.click();
  assert.equal(ask(t).querySelector('h2').textContent, 'Discard changes?');
  t.d.querySelector('[data-confirm-accept]').click();
  await waitFor(() => t.A.context().view === 'board' || ask(t), 'the link is followed');
  assert.equal(ask(t), null, 'Discard is the only question');
  assert.equal(t.A.context().view, 'board');
});

test('a page change that follows the person\'s own change, or a clean page, never asks', () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' }));
  t.A.nav('roadmap');
  assert.equal(ask(t), null); assert.equal(t.A.context().view, 'roadmap');
  t.A.openTask('BIR-079');
  type(t.d.getElementById('cmtIn'), 'Half a thought');
  t.A.nav('board', { discard: true });
  assert.equal(ask(t), null); assert.equal(t.A.context().view, 'board');
});

test('switching projects with typed text asks first, and Cancel stays', async () => {
  const loads = [];
  const t = withBridge(bootApp({ route: 'task/BIR-079' }), { reloadBootstrap: async scope => { loads.push(scope); return { stale: false }; } });
  type(t.d.getElementById('cmtIn'), 'Half a thought');
  const switching = t.bridge.invoke('workspace.select', { projectId: 'p2' });
  await settle();
  assert(ask(t)); t.d.querySelector('[data-confirm-cancel]').click();
  assert.deepEqual(await switching, { stale: true });
  assert.deepEqual(loads, []); assert.equal(t.A.context().view, 'task');
});

test('Discard works while offline, because nothing changes on the server', () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' }));
  t.w.Recovery.observeResponse({ ok: false, error: new t.w.TestApiError('Network', { code: 'network_error' }) });
  assert.equal(t.w.Recovery.connection, 'offline');
  type(t.d.getElementById('cmtIn'), 'Half a thought');
  t.A.nav('board');
  t.d.querySelector('[data-confirm-accept]').click();
  assert.equal(t.A.context().view, 'board');
});

test('Sign out says that typed text will be lost, only when there is some', () => {
  const t = withBridge(bootApp({ route: 'task/BIR-079' }));
  t.A.logout();
  assert.equal(ask(t).querySelector('p').textContent, 'End your current browser session.');
  t.d.querySelector('[data-confirm-cancel]').click();
  type(t.d.getElementById('cmtIn'), 'Half a thought');
  t.A.logout();
  assert.equal(ask(t).querySelector('p').textContent, 'End your current browser session. Text you typed and have not saved will be lost.');
});

test('Escape on a dialog with typed text asks first; a clean dialog closes at once', () => {
  const t = bootApp({ route: 'roadmap' });
  const escape = () => t.d.activeElement.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  t.A.openModal('epic');
  escape();
  assert.equal(t.d.querySelector('.modal'), null, 'nothing typed');
  t.A.openModal('epic');
  type(t.d.querySelector('.modal [name="title"]'), 'Payment retries');
  escape();
  assert.equal(ask(t).querySelector('p').textContent, 'Text you typed in this dialog will be lost.');
  t.d.querySelector('[data-confirm-cancel]').click();
  assert.equal(t.d.querySelector('.modal [name="title"]').value, 'Payment retries');
  escape();
  t.d.querySelector('[data-confirm-accept]').click();
  assert.equal(t.d.querySelector('.modal'), null);
});

test('Escape in a dialog\'s date field undoes the typed date first, then reaches the dialog', () => {
  const t = bootApp({ route: 'roadmap' });
  t.A.openModal('milestone');
  const date = t.d.querySelector('.modal .date-text'), saved = date.value;
  // A browser runs the field's own key handler before the page's.
  date.addEventListener('keydown', event => t.A.dateKey(event, 'mDate'));
  const escape = () => date.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  type(date, '2031-01-0');
  escape();
  assert.equal(date.value, saved); assert(t.d.querySelector('.modal'), 'the first Escape undoes the typing');
  escape();
  assert.equal(t.d.querySelector('.modal'), null, 'the next one closes the dialog');
});

test('Reload after updates is a choice in the account menu, which stays open', () => {
  const t = bootApp({ route: 'board' });
  t.A.userMenu({ currentTarget: t.d.querySelector('.me-chip') });
  const toggle = () => t.d.querySelector('[data-auto-reload]');
  assert.equal(toggle().textContent, 'Reload after updates'); assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  t.A.toggleAutoReload();
  assert.equal(toggle().getAttribute('aria-pressed'), 'true'); assert(t.d.querySelector('.profile-menu'), 'the menu stays open');
  assert.equal(t.w.localStorage.getItem('oneloop.autoReload'), 'on'); assert.equal(t.w.Recovery.autoReload, true);
  t.A.toggleAutoReload();
  assert.equal(toggle().getAttribute('aria-pressed'), 'false'); assert.equal(t.w.localStorage.getItem('oneloop.autoReload'), null);
});

test('the account menu follows Reload after updates when another tab changes it', () => {
  const t = bootApp({ route: 'board' });
  t.A.userMenu({ currentTarget: t.d.querySelector('.me-chip') });
  const toggle = () => t.d.querySelector('[data-auto-reload]');
  // Another tab of the same browser turns it on: this tab hears of it through storage.
  t.w.localStorage.setItem('oneloop.autoReload', 'on');
  t.w.dispatchEvent(new t.w.StorageEvent('storage', { key: 'oneloop.autoReload', newValue: 'on' }));
  assert.equal(toggle().getAttribute('aria-pressed'), 'true'); assert(toggle().querySelector('.menu-check svg'));
  t.w.localStorage.clear();
  t.w.dispatchEvent(new t.w.StorageEvent('storage', { key: null }));
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
});
