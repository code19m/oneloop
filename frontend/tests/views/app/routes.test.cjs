// views/app.js: addresses, the projects they name, and history.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle, waitFor } = require('../../support/dom.cjs');

/** Press the browser's Back and wait for the page it goes to. */
async function back(t) { const before = t.w.location.href; t.w.history.back(); await waitFor(() => t.w.location.href !== before, 'Back changed the page'); await settle(); }

test('an address from before projects had one gets the project on screen in place', () => {
  for (const [route, address] of [['', '#/roadmap/p1'], ['board', '#/board/p1'], ['roadmap', '#/roadmap/p1'], ['settings', '#/settings/p1'], ['knowledge', '#/knowledge/p1/tree']]) {
    const t = bootApp({ route });
    assert.equal(t.w.location.hash, address, route); assert.equal(t.w.history.length, 1, route);
  }
});

test('an address that names a project you can\'t open says Page not found, with a way back to your Board', () => {
  for (const route of ['board/missing', 'roadmap/p2', 'settings/p2']) {
    const t = bootApp({ route, prepare: D => { D.session.userId = 'robin'; } });
    assert.equal(t.d.querySelector('.page-error h2').textContent, 'Page not found', route);
    assert.equal(t.d.querySelector('.page-error [data-action="nav"]').textContent, 'Back to Board', route);
    assert.equal(t.w.location.hash, `#/${route}`, 'the address stays');
  }
});

test('a project switch is a history entry that keeps the page, and is remembered with the person who made it', () => {
  const t = bootApp({ route: 'roadmap/p1' });
  t.A.selectProject('p2');
  assert.equal(t.w.location.hash, '#/roadmap/p2'); assert.equal(t.w.history.length, 2);
  assert.deepEqual(JSON.parse(t.w.localStorage.getItem('oneloop.project')), { userId: 'taylorwu', projectId: 'p2' });
});

test('after a sign-out on purpose, the address keeps only the page, so the next person starts from their own project', () => {
  for (const [route, address] of [['board/p1?search=reader&track=t1', '#/board'], ['task/BIR-079', '#/board'], ['knowledge/p1/tree/guides', '#/knowledge']]) {
    const t = bootApp({ route });
    // Another tab signed out while this one had a dialog open.
    t.A.openModal('project');
    t.A.clearAddress();
    assert.equal(t.w.location.hash, address, route); assert.equal(t.w.history.length, 1, 'in place');
    // The next sign-in asks for no project of the person before, and the Board's search is empty.
    assert.equal(JSON.stringify(t.module('src/app/projection-reload.js').routeScope(t.w.location.hash, t.A)), JSON.stringify({ view: address === '#/board' ? 'board' : 'metadata' }), route);
    assert.equal(t.A.context().board.search, ''); assert.equal(t.A.context().board.trackIds.length, 0);
    assert.equal(t.A.context().modal, null, 'the dialog does not open again for the next person');
  }
});

test('creating a project, or losing the one on screen, takes one history entry, so Back returns to the page before', async () => {
  const created = bootApp({ route: 'board/p1', api: { command: async () => ({ entities: [{ entityType: 'project', id: 'p9', name: 'Atlas', taskPrefix: 'ATL', revision: 1 }], events: [] }) } });
  created.A.openModal('project');
  const form = created.d.querySelector('.modal form');
  form.querySelector('[name="name"]').value = 'Atlas'; form.querySelector('[name="key"]').value = 'ATL';
  created.A.saveProjectNew({ target: form, preventDefault() {} }); await settle();
  assert.equal(created.w.location.hash, '#/roadmap/p9'); assert.equal(created.w.history.length, 2);
  assert.equal(created.d.querySelector('.modal'), null);
  await back(created);
  assert.equal(created.w.location.hash, '#/board/p1');
  const lost = bootApp({ route: 'roadmap/p2' });
  lost.D.projects.splice(lost.D.projects.findIndex(project => project.id === 'p2'), 1);
  lost.module('src/features/recovery/controller.js').leaveUnavailableProject(lost.D, lost.A, { projectId: 'p2', view: 'roadmap' }, 'oneloop');
  assert.equal(lost.w.location.hash, '#/board/p1'); assert.equal(lost.w.history.length, 2);
  await back(lost);
  assert.equal(lost.w.location.hash, '#/roadmap/p2');
});
