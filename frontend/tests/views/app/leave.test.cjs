// views/app.js with the recovery controller and the view bridge: oneloop asks
// before typed text would be lost.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../../support/dom.cjs');
const { installViewBridge } = require('../../../src/app/view-bridge.js');

/** Whether the browser would ask before the tab leaves oneloop. */
function leaveWarns(t) { const event = new t.w.Event('beforeunload', { cancelable: true }); t.w.dispatchEvent(event); return event.defaultPrevented; }
/** Whether moving to another page of oneloop would ask first. */
const pageWarns = t => t.w.Recovery.hasUnsavedInput({ leaving: false });
const type = (element, value) => { element.focus(); element.value = value; };
/** The production page changes: the view bridge with the real recovery controller. */
function withBridge(t, { reloadBootstrap = async () => ({ stale: false }) } = {}) {
  const bridge = installViewBridge({ app: t.A, data: t.D, api: {}, reads: { cancel() {} }, gateway: {}, auth: {}, recovery: t.w.Recovery, reloadBootstrap });
  return { ...t, bridge };
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

test('search boxes and fields that saved when they lost focus never count', () => {
  const board = bootApp({ route: 'board' });
  type(board.d.querySelector('[data-board-search]'), 'payment');
  assert.equal(leaveWarns(board), false, 'the Board search');
  const settings = bootApp({ route: 'settings' });
  type(settings.d.getElementById('member-search'), 'robin');
  assert.equal(leaveWarns(settings), false, 'the member search');
  const name = settings.d.querySelector('.project-fields [name="name"]');
  type(name, 'Renamed project');
  assert.equal(leaveWarns(settings), true, 'a name still being typed');
  name.blur();
  assert.equal(name.value, 'Renamed project');
  assert.equal(leaveWarns(settings), false, 'the name saved when it lost focus');
  name.focus();
  assert.equal(leaveWarns(settings), false, 'focusing it again without typing');
});

test('opening a comment for editing counts only once its text changes', () => {
  const t = bootApp({ route: 'task/BIR-079', prepare(D) { D.tasks.find(task => task.id === 'BIR-079').comments = [{ id: 'c1', who: D.session.userId, ts: Date.now() - 60_000, text: 'Saved text', mentions: [], parentId: null }]; } });
  t.A.editComment('BIR-079', 'c1');
  assert.equal(t.d.getElementById('cmtIn').value, 'Saved text');
  assert.equal(pageWarns(t), false);
  type(t.d.getElementById('cmtIn'), 'Saved text, edited');
  assert.equal(pageWarns(t), true);
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
