// src/features/checklist/checklist.js: a task's checklist on its page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, settle } = require('../../../support/dom.cjs');

/** A checklist item as the client keeps it. */
const item = (id, title, done = false, revision = 1) => ({ id, taskId: 'bir-079', title, done, revision });

/** The page of a task whose checklist is Plan (done), Build and Ship, with toasts recorded. */
function checklistPage(options = {}) {
  const t = bootApp({ route: 'task/BIR-079', ...options, prepare(D, w) {
    Object.assign(D.tasks.find(task => task.id === 'BIR-079'), { checklist: [item('c1', 'Plan', true), item('c2', 'Build'), item('c3', 'Ship')], checklistDone: 1, checklistTotal: 3 });
    options.prepare?.(D, w);
  } });
  const notices = [];
  t.A.toast = (text, kind = 'success') => notices.push({ text, kind });
  const row = id => t.d.querySelector(`[data-checklist-item="${id}"]`);
  return {
    ...t, notices, row,
    task: t.D.tasks.find(task => task.id === 'BIR-079'),
    titles: () => [...t.d.querySelectorAll('.checklist-item')].map(entry => entry.querySelector('textarea')?.value ?? entry.querySelector('.checklist-title').textContent),
    count: () => t.d.querySelector('.checklist-count')?.textContent,
    sent: () => t.commands.map(command => [command.operation, command.payload, command.expectedRevision]),
    key: (element, key) => element.dispatchEvent(new t.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  };
}

/** What the server answers a checklist command with: the item, and the task with its whole checklist. */
function accept(t, changed, checklist) {
  const wire = checklist.map((entry, position) => ({ id: entry.id, taskId: 'bir-079', position, title: entry.title, done: entry.done, revision: entry.revision }));
  t.commands.at(-1).resolve({ entities: [{ entityType: 'checklistItem', ...changed }, { entityType: 'task', id: 'bir-079', revision: t.task.revision, checklist: wire, checklistDone: checklist.filter(entry => entry.done).length, checklistTotal: checklist.length }], events: [] });
  return settle();
}

const refuse = (t, code = 'internal') => { t.commands.at(-1).reject(new t.w.TestApiError('The change could not be saved.', { status: 500, code })); return settle(); };

test('the checklist sits between the description and the files, and readers see it without controls', () => {
  const t = checklistPage();
  const sections = [...t.d.querySelectorAll('.task-page .tp-sec')].map(section => section.classList[1]);
  assert.deepEqual(sections.slice(sections.indexOf('task-description'), sections.indexOf('task-description') + 3), ['task-description', 'task-checklist', 'task-attachments']);
  assert.equal(t.count(), '1/3'); assert.match(t.d.querySelector('.checklist-heading').textContent, /1 of 3 done/);
  assert.equal(t.d.querySelector('.checklist-progress > span').style.width, '33%');
  assert.deepEqual(t.titles(), ['Plan', 'Build', 'Ship']);
  assert(t.row('c1').classList.contains('done')); assert(t.row('c1').querySelector('[data-checklist-done]').checked);
  assert.equal(t.d.querySelectorAll('[data-checklist-grip],[data-checklist-remove]').length, 6); assert(t.d.querySelector('[data-checklist-add]'));
  // Without Board access, the items show without controls; none show no section.
  t.D.users.find(u => u.id === 'taylorwu').admin = false; t.D.projects[0].members.find(m => m.userId === 'taylorwu').permissions = []; t.A.refresh();
  assert.deepEqual(t.titles(), ['Plan', 'Build', 'Ship']);
  assert.equal(t.d.querySelectorAll('[data-checklist-grip],[data-checklist-remove],[data-checklist-add],.checklist textarea').length, 0);
  assert([...t.d.querySelectorAll('[data-checklist-done]')].every(box => box.disabled));
  t.task.checklist = []; t.A.refresh();
  assert.equal(t.d.querySelector('.task-checklist'), null);
});

test('Enter in the add field adds the item at the end, and the field is ready for the next one', async () => {
  const t = checklistPage(), field = t.d.querySelector('[data-checklist-add]');
  field.focus(); field.value = '  Review   the copy ';
  t.key(field, 'Enter');
  assert.deepEqual(t.sent(), [['task.checklist.add', { taskId: 'bir-079', title: 'Review the copy' }, undefined]]);
  assert.equal(field.value, ''); assert.equal(t.d.activeElement, field);
  await accept(t, { id: 'c4', taskId: 'bir-079', position: 3, title: 'Review the copy', done: false, revision: 1 }, [...t.task.checklist, item('c4', 'Review the copy')]);
  assert.deepEqual(t.titles(), ['Plan', 'Build', 'Ship', 'Review the copy']); assert.equal(t.count(), '1/4');
  assert.equal(t.d.activeElement, field, 'the redraw keeps focus in the field');
  // An item that can't be added comes back into the field.
  field.value = 'Publish'; t.key(field, 'Enter'); await refuse(t);
  assert.equal(field.value, 'Publish'); assert.equal(t.notices.at(-1).kind, 'error');
});

test('a tick shows at once, saves on the item\'s own revision and goes back when refused', async () => {
  const t = checklistPage(), box = () => t.row('c2').querySelector('[data-checklist-done]');
  box().click();
  assert.deepEqual(t.sent(), [['task.checklist.update', { itemId: 'c2', done: true }, 1]]);
  assert(t.row('c2').classList.contains('done')); assert.equal(t.count(), '2/3');
  assert.equal(t.w.Recovery.hasUnsavedInput({ leaving: false }), false, 'a tick saves itself');
  await refuse(t);
  assert(!t.row('c2').classList.contains('done')); assert(!box().checked); assert.equal(t.count(), '1/3');
  assert.equal(t.notices.at(-1).kind, 'error');
});

test('a title saves as it loses focus, and a refused one stays as typed until it saves', async () => {
  const t = checklistPage(), title = () => t.row('c2').querySelector('textarea');
  title().focus(); title().value = 'Build it'; title().blur();
  assert.deepEqual(t.sent(), [['task.checklist.update', { itemId: 'c2', title: 'Build it' }, 1]]);
  await refuse(t, 'network_error');
  assert.equal(title().value, 'Build it'); assert(title().hasAttribute('data-unsaved'));
  assert.equal(t.w.Recovery.hasUnsavedInput({ leaving: false }), true, 'leaving the page now would lose it');
  t.A.refresh();
  assert.equal(title().value, 'Build it', 'a redraw keeps the typed title'); assert(title().hasAttribute('data-unsaved'));
  // Leaving the field again sends it again, on the revision it was typed on.
  title().focus(); title().blur();
  assert.deepEqual(t.sent().at(-1), ['task.checklist.update', { itemId: 'c2', title: 'Build it' }, 1]);
  await accept(t, { id: 'c2', taskId: 'bir-079', position: 1, title: 'Build it', done: false, revision: 2 }, [item('c1', 'Plan', true), item('c2', 'Build it', false, 2), item('c3', 'Ship')]);
  assert.equal(title().value, 'Build it'); assert(!title().hasAttribute('data-unsaved'));
  assert.equal(t.w.Recovery.hasUnsavedInput(), false);
  // Enter saves too; an emptied title puts back the one it had.
  title().focus(); title().value = ''; t.key(title(), 'Enter');
  assert.equal(title().value, 'Build it'); assert.equal(t.commands.length, 2);
});

test('a title someone else changed meanwhile asks which one to keep', async () => {
  const t = checklistPage({ reads: { task: async () => { const latest = t.task.checklist[1]; Object.assign(latest, { title: 'Build the API', revision: 2 }); return { stale: false }; } } });
  const title = () => t.row('c2').querySelector('textarea');
  title().focus(); title().value = 'Build it'; title().blur();
  t.commands[0].reject(new t.w.TestApiError('record changed; latest revision is 2', { status: 409, code: 'revision_conflict' }));
  await waitFor(() => t.d.querySelector('.task-checklist [data-recovery-conflict]'), 'the prompt shows in the checklist');
  assert.match(t.d.querySelector('[data-recovery-conflict]').textContent, /Latest saved value: Build the API/);
  assert.equal(title().value, 'Build it', 'the field keeps what was typed');
  [...t.d.querySelectorAll('[data-recovery-conflict] button')].find(button => button.textContent === 'Keep my changes').click();
  await waitFor(() => t.commands.length === 2, 'the save goes again');
  assert.deepEqual([t.commands[1].payload, t.commands[1].expectedRevision], [{ itemId: 'c2', title: 'Build it' }, 2]);
});

test('× removes an item at once and moves focus to the next one', async () => {
  const t = checklistPage();
  t.row('c2').querySelector('[data-checklist-remove]').click();
  assert.deepEqual(t.sent(), [['task.checklist.delete', { id: 'c2' }, 1]]);
  assert.deepEqual(t.titles(), ['Plan', 'Ship']); assert.equal(t.count(), '1/2');
  assert.equal(t.d.activeElement, t.row('c3').querySelector('[data-checklist-done]'));
  await accept(t, { id: 'c2', deleted: true, revision: 2 }, [item('c1', 'Plan', true), item('c3', 'Ship')]);
  assert.deepEqual(t.titles(), ['Plan', 'Ship']);
});

test('arrow keys on a grip move its item, keep focus on the grip and say where it went', async () => {
  const t = checklistPage(), grip = () => t.row('c1').querySelector('[data-checklist-grip]');
  grip().focus(); t.key(grip(), 'ArrowUp');
  assert.equal(t.commands.length, 0, 'the first item goes no higher');
  t.key(grip(), 'ArrowDown');
  assert.deepEqual(t.sent(), [['task.checklist.move', { itemId: 'c1', afterItemId: 'c2' }, 1]]);
  assert.deepEqual(t.titles(), ['Build', 'Plan', 'Ship']); assert.equal(t.d.activeElement, grip());
  assert.equal(t.d.querySelector('[data-checklist-status]').textContent, 'Plan moved to position 2 of 3');
  await accept(t, { id: 'c1', taskId: 'bir-079', position: 1, title: 'Plan', done: true, revision: 2 }, [item('c2', 'Build'), item('c1', 'Plan', true, 2), item('c3', 'Ship')]);
  t.key(grip(), 'End');
  assert.deepEqual(t.sent().at(-1), ['task.checklist.move', { itemId: 'c1', afterItemId: 'c3' }, 2]);
  assert.deepEqual(t.titles(), ['Build', 'Ship', 'Plan']);
});

test('a change from elsewhere redraws the checklist in place and keeps the title being typed', async () => {
  const view = { id: 'bir-079', taskKey: 'BIR-079', projectId: 'p1', epicId: 'e2', title: 'Flexible reading schedule', description: '', status: 'planning', position: 1, createdAt: 1, updatedAt: 1, assigneeIds: [], activeBlock: null, revision: 1, checklistDone: 1, checklistTotal: 2,
    checklist: [{ id: 'c2', taskId: 'bir-079', position: 0, title: 'Build', done: true, revision: 2 }, { id: 'c3', taskId: 'bir-079', position: 1, title: 'Ship', done: false, revision: 1 }] };
  const t = checklistPage({ api: { task: async () => view } });
  const typing = t.row('c3').querySelector('textarea');
  typing.focus(); typing.value = 'Ship v2';
  t.events.at(-1).emit('hint', { kind: 'activity.changed', projectId: 'p1', taskId: 'bir-079', entityType: 'task', entityId: 'bir-079', entityRevision: null });
  await waitFor(() => t.titles().length === 2, 'the live read redraws the checklist'); await settle();
  assert.deepEqual(t.titles(), ['Build', 'Ship v2']); assert(t.row('c2').querySelector('[data-checklist-done]').checked);
  assert.equal(t.row('c3').querySelector('textarea'), typing); assert.equal(t.d.activeElement, typing);
  assert.equal(t.count(), '1/2');
});
