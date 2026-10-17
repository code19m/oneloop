// src/features/checklist/checklist.js: a task's checklist on its page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, settle } = require('../../../support/dom.cjs');

/** A checklist item as the client keeps it. */
const item = (id, title, done = false, revision = 1) => ({ id, taskId: 'bir-079', title, done, revision });

/** The page of a task whose checklist is Plan (done), Build and Ship, with toasts recorded. */
function checklistPage(options = {}) {
  const t = bootApp({ route: 'task/BIR-079', ...options, prepare(D, w) {
    Object.assign(D.tasks.find(task => task.id === 'BIR-079'), { checklist: [item('c1', 'Plan', true), item('c2', 'Build'), item('c3', 'Ship')], checklistDone: 1, checklistTotal: 3, checklistVersion: 0 });
    options.prepare?.(D, w);
  } });
  const notices = [];
  t.A.toast = (text, kind = 'success') => notices.push({ text, kind });
  const row = id => t.d.querySelector(`[data-checklist-item="${id}"]`);
  return {
    ...t, notices, row,
    // The server's checklist version, which each saved change raises.
    server: { version: 0 },
    task: t.D.tasks.find(task => task.id === 'BIR-079'),
    titles: () => [...t.d.querySelectorAll('.checklist-item')].map(entry => entry.querySelector('textarea')?.value ?? entry.querySelector('.checklist-title').textContent),
    count: () => t.d.querySelector('.checklist-count')?.textContent,
    sent: () => t.commands.map(command => [command.operation, command.payload, command.expectedRevision]),
    key: (element, key) => element.dispatchEvent(new t.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  };
}

/** The task as the server sends it, with `checklist` and the checklist `version`. */
const taskView = (checklist, version) => ({
  id: 'bir-079', taskKey: 'BIR-079', projectId: 'p1', epicId: 'e2', title: 'Flexible reading schedule', description: '', status: 'planning', position: 1, createdAt: 1, updatedAt: 1, assigneeIds: [], activeBlock: null, revision: 1,
  checklist: checklist.map((entry, position) => ({ id: entry.id, taskId: 'bir-079', position, title: entry.title, done: entry.done, revision: entry.revision })),
  checklistDone: checklist.filter(entry => entry.done).length, checklistTotal: checklist.length, checklistVersion: version,
});

/** What the server answers a checklist command with: the item, and the task with its whole checklist at the next version. */
function accept(t, changed, checklist) {
  t.server.version += 1;
  t.commands.at(-1).resolve({ entities: [{ entityType: 'checklistItem', ...changed }, { entityType: 'task', ...taskView(checklist, t.server.version), revision: t.task.revision }], events: [] });
  return settle();
}

/** Send the live hint of a change to the task's checklist, at checklist `version`, as another tab's change does. */
const hint = (t, version) => t.events.at(-1).emit('hint', { kind: 'activity.changed', projectId: 'p1', taskId: 'bir-079', entityType: 'checklist', entityId: 'bir-079', entityRevision: version });

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

test('Cmd/Ctrl+S saves a title in place, and the next save still meets a change from elsewhere', async () => {
  let reads = 0;
  // Someone else renames the item after the shortcut saved it.
  const elsewhere = taskView([item('c1', 'Plan', true), item('c2', 'Build the API', false, 3), item('c3', 'Ship')], 2);
  const t = checklistPage({ api: { task: async () => { reads += 1; return elsewhere; } } }), title = t.row('c2').querySelector('textarea');
  title.focus(); title.value = 'Build it'; title.setSelectionRange(3, 3);
  title.dispatchEvent(new t.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 's', code: 'KeyS' }));
  assert.deepEqual(t.sent(), [['task.checklist.update', { itemId: 'c2', title: 'Build it' }, 1]]);
  assert.equal(t.d.activeElement, title); assert.equal(title.selectionStart, 3);
  assert.equal(t.w.Recovery.hasUnsavedInput({ leaving: false }), false, 'the shortcut counts as saved');
  await accept(t, { id: 'c2', taskId: 'bir-079', position: 1, title: 'Build it', done: false, revision: 2 }, [item('c1', 'Plan', true), item('c2', 'Build it', false, 2), item('c3', 'Ship')]);
  hint(t, 2); await waitFor(() => reads === 1, 'the live read lands'); await settle();
  title.value = 'Build it now'; t.key(title, 'Enter');
  assert.equal(t.commands.at(-1).expectedRevision, 2, 'built on the revision the shortcut saved, so the rename comes up');
});

test('a change from elsewhere waits for a press on the checklist to end', async () => {
  const view = taskView([item('c3', 'Ship'), item('c1', 'Plan', true), item('c2', 'Build')], 1);
  const t = checklistPage({ api: { task: async () => view } });
  t.row('c2').querySelector('[data-checklist-remove]').dispatchEvent(new t.w.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  hint(t, 1);
  await waitFor(() => t.task !== t.D.tasks.find(entry => entry.id === 'BIR-079'), 'the live read lands'); await settle();
  assert.deepEqual(t.titles(), ['Plan', 'Build', 'Ship'], 'rows stay under the pointer');
  t.w.dispatchEvent(new t.w.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
  await waitFor(() => t.titles()[0] === 'Ship', 'the change shows once the press ends');
  assert.deepEqual(t.titles(), ['Ship', 'Plan', 'Build']);
});

test('changes from elsewhere during one press patch the checklist once, when it ends', async () => {
  const t = checklistPage(), patches = [], patch = t.A.refreshTaskChecklist;
  t.A.refreshTaskChecklist = id => { patches.push(id); patch(id); };
  t.row('c2').querySelector('[data-checklist-remove]').dispatchEvent(new t.w.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  t.A.refreshTask('BIR-079'); t.A.refreshTask('BIR-079');
  assert.deepEqual(patches, [], 'nothing moves while the button is down');
  t.w.dispatchEvent(new t.w.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
  await waitFor(() => patches.length > 0, 'the press ends'); await settle();
  assert.deepEqual(patches, ['BIR-079']);
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

test('a row dragged by its grip moves there, and its grip keeps focus', async () => {
  const t = checklistPage(), grip = () => t.row('c1').querySelector('[data-checklist-grip]'), zone = t.d.querySelector('.task-checklist');
  const pointer = (type, target, x, y) => { const event = new t.w.Event(type, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y })) Object.defineProperty(event, key, { value }); target.dispatchEvent(event); };
  zone.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 500 });
  [...zone.querySelectorAll('[data-checklist-item]')].forEach((row, i) => { row.getBoundingClientRect = () => ({ left: 0, right: 600, top: 100 + i * 100, bottom: 190 + i * 100, width: 600, height: 90 }); });
  pointer('pointerdown', grip(), 20, 120);
  // WebKit moves focus off a pressed button, as here to the page.
  t.d.getElementById('main').focus();
  pointer('pointermove', t.d, 20, 370); pointer('pointerup', t.d, 20, 370);
  assert.deepEqual(t.sent(), [['task.checklist.move', { itemId: 'c1', afterItemId: 'c3' }, 1]]);
  assert.deepEqual(t.titles(), ['Build', 'Ship', 'Plan']);
  assert.equal(t.d.activeElement, grip());
});

test('a change from elsewhere redraws the checklist in place and keeps the title being typed', async () => {
  const view = taskView([item('c2', 'Build', true, 2), item('c3', 'Ship')], 2);
  const t = checklistPage({ api: { task: async () => view } });
  const typing = t.row('c3').querySelector('textarea');
  typing.focus(); typing.value = 'Ship v2';
  hint(t, 2);
  await waitFor(() => t.titles().length === 2, 'the live read redraws the checklist'); await settle();
  assert.deepEqual(t.titles(), ['Build', 'Ship v2']); assert(t.row('c2').querySelector('[data-checklist-done]').checked);
  assert.equal(t.row('c3').querySelector('textarea'), typing); assert.equal(t.d.activeElement, typing);
  assert.equal(t.count(), '1/2');
});

test('a read that left before a tick never draws the old checklist again', async () => {
  let reads = 0;
  // Every read of the task answers as the server had it before the tick.
  const before = taskView([item('c1', 'Plan', true), item('c2', 'Build'), item('c3', 'Ship')], 0);
  const t = checklistPage({ api: {
    task: async () => { reads += 1; return before; },
    comments: async () => ({ items: [], nextCursor: null }), activity: async () => ({ items: [], nextCursor: null }), attachments: async () => ({ items: [] }),
  } });
  // Someone else changes another field of the task, so the page reads it.
  const lands = async count => { t.events.at(-1).emit('hint', { kind: 'activity.changed', projectId: 'p1', taskId: 'bir-079', entityType: 'task', entityId: 'bir-079', entityRevision: count + 1 }); await waitFor(() => reads === count, 'the live read lands'); await settle(); };
  const ticked = () => t.row('c2').classList.contains('done') && t.row('c2').querySelector('[data-checklist-done]').checked;
  t.row('c2').querySelector('[data-checklist-done]').click();
  await lands(1);
  assert(ticked(), 'while the tick is on its way'); assert.equal(t.count(), '2/3');
  await accept(t, { id: 'c2', taskId: 'bir-079', position: 1, title: 'Build', done: true, revision: 2 }, [item('c1', 'Plan', true), item('c2', 'Build', true, 2), item('c3', 'Ship')]);
  await lands(2);
  assert(ticked(), 'after the tick is saved'); assert.equal(t.count(), '2/3');
});

test('quick moves save each one, from the order the page shows, in the order they were made', async () => {
  const t = checklistPage({ prepare: D => { const task = D.tasks.find(entry => entry.id === 'BIR-079'); task.checklist.push(item('c4', 'Tell')); task.checklistTotal = 4; } });
  const grip = id => t.row(id).querySelector('[data-checklist-grip]');
  const moved = (revision, ...ids) => ids.map(id => ({ c1: item('c1', 'Plan', true, revision), c2: item('c2', 'Build'), c3: item('c3', 'Ship'), c4: item('c4', 'Tell') })[id]);
  grip('c1').focus();
  t.key(grip('c1'), 'ArrowDown'); t.key(grip('c1'), 'ArrowDown');
  // The first move's answer comes back before the third press.
  await accept(t, { id: 'c1', taskId: 'bir-079', position: 1, title: 'Plan', done: true, revision: 2 }, moved(2, 'c2', 'c1', 'c3', 'c4'));
  assert.deepEqual(t.titles(), ['Build', 'Ship', 'Plan', 'Tell'], 'the answer to the first move keeps the second');
  t.key(grip('c1'), 'ArrowDown');
  await accept(t, { id: 'c1', taskId: 'bir-079', position: 2, title: 'Plan', done: true, revision: 3 }, moved(3, 'c2', 'c3', 'c1', 'c4'));
  await accept(t, { id: 'c1', taskId: 'bir-079', position: 3, title: 'Plan', done: true, revision: 4 }, moved(4, 'c2', 'c3', 'c4', 'c1'));
  assert.deepEqual(t.sent(), [['c2', 1], ['c3', 2], ['c4', 3]].map(([after, revision]) => ['task.checklist.move', { itemId: 'c1', afterItemId: after }, revision]));
  assert.deepEqual(t.titles(), ['Build', 'Ship', 'Tell', 'Plan']);
  // A move of another item waits for the answer to the one before it.
  t.key(grip('c2'), 'ArrowDown'); t.key(grip('c4'), 'ArrowUp');
  assert.deepEqual(t.titles(), ['Ship', 'Tell', 'Build', 'Plan']);
  assert.equal(t.commands.length, 4);
  await accept(t, { id: 'c2', taskId: 'bir-079', position: 1, title: 'Build', done: false, revision: 2 }, [item('c3', 'Ship'), item('c2', 'Build', false, 2), item('c4', 'Tell'), item('c1', 'Plan', true, 4)]);
  assert.deepEqual(t.sent().slice(3), [['task.checklist.move', { itemId: 'c2', afterItemId: 'c3' }, 1], ['task.checklist.move', { itemId: 'c4', beforeItemId: 'c2' }, 1]]);
});

test('a checklist change reads only the task on the pages that show it, and nothing in the tab that made it', async t => {
  const tasks = [];
  const elsewhere = taskView([item('c1', 'Plan', true), item('c2', 'Build', true, 2), item('c3', 'Ship', true, 2)], 2);
  const page = checklistPage({ api: { task: async id => { tasks.push(id); return elsewhere; } } });
  // The page's first reads land; any later read of its comments, activity or files waits here.
  for (const [method, value] of [['comments', { items: [], nextCursor: null }], ['activity', { items: [], nextCursor: null }], ['attachments', { items: [] }]]) page.answer(method, value);
  await settle();
  const opened = page.calls.length;
  const reads = () => [...tasks.map(() => 'task'), ...page.calls.slice(opened).filter(call => call.method !== 'command').map(call => call.method)];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const live = async version => { hint(page, version); for (let step = 0; step < 4; step++) { t.mock.timers.tick(100); await settle(); } };
  // This tab ticks Build: the command's answer brings the version that its own hint names.
  page.row('c2').querySelector('[data-checklist-done]').click();
  await accept(page, { id: 'c2', taskId: 'bir-079', position: 1, title: 'Build', done: true, revision: 2 }, [item('c1', 'Plan', true), item('c2', 'Build', true, 2), item('c3', 'Ship')]);
  await live(1);
  assert.deepEqual(reads(), [], 'the tab that made the change reads nothing');
  // Another tab ticks Ship.
  await live(2);
  assert.deepEqual(reads(), ['task']);
  assert.equal(page.count(), '3/3');
  t.mock.timers.reset();
});
