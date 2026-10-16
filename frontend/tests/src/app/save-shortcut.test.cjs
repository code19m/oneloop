// src/app/save-shortcut.js: Cmd/Ctrl+S saves what is being edited and never downloads the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../../support/dom.cjs');

/** Press Ctrl+S, or the key `init` names, on `target`, and say whether the browser's own action was prevented. */
function press(t, target, init = { ctrlKey: true, key: 's', code: 'KeyS' }) {
  const event = new t.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
const sent = t => t.commands.map(command => [command.operation, command.payload]);
const taskPage = options => bootApp({ route: 'task/BIR-079', actions: true, ...options });

test('Cmd/Ctrl+S saves a field that saves itself at once, and keeps focus and the caret there', async () => {
  const t = taskPage(), title = t.d.querySelector('.tp-title');
  title.focus(); title.value = 'Saved with the shortcut'; title.setSelectionRange(5, 5);
  assert.equal(press(t, title), true);
  assert.deepEqual(sent(t), [['task.update', { taskId: 'bir-079', title: 'Saved with the shortcut' }]]);
  assert.equal(t.d.activeElement, title); assert.equal(title.selectionStart, 5);
  t.commands[0].resolve({ entities: [{ entityType: 'task', id: 'bir-079', title: 'Saved with the shortcut', revision: 2 }], events: [] }); await settle();
  const description = t.d.getElementById('task-description');
  description.focus(); description.value = 'Written with another keyboard';
  // Command and the key in the S place of a keyboard without Latin letters.
  assert.equal(press(t, description, { metaKey: true, key: 'ы', code: 'KeyS' }), true);
  await settle();
  assert.deepEqual(sent(t).at(-1), ['task.update', { taskId: 'bir-079', description: 'Written with another keyboard' }]);
  assert.equal(t.d.activeElement, description, 'the description stays open');
  assert.equal(press(t, description, { ctrlKey: true, shiftKey: true, key: 'S', code: 'KeyS' }), false, 'other shortcuts stay the browser\'s');
  assert.equal(t.commands.length, 2);
});

test('in a dialog or a comment being edited, Cmd/Ctrl+S does what the primary button does', async () => {
  const t = taskPage({ prepare: D => { D.tasks.find(item => item.id === 'BIR-079').comments = [{ id: 'c1', who: 'taylorwu', ts: Date.now(), text: 'First thought', mentions: [], revision: 1 }]; } });
  t.A.openModal('task');
  const form = t.d.querySelector('.modal form'), title = form.querySelector('[name="title"]');
  title.value = 'Created with the shortcut'; form.querySelector('[name="epicId"]').value = 'e4'; title.focus();
  assert.equal(press(t, title), true);
  assert.deepEqual(sent(t).map(([operation, payload]) => [operation, payload.title]), [['task.create', 'Created with the shortcut']]);
  t.A.closeOverlays();
  t.A.editComment('BIR-079', 'c1');
  const comment = t.d.getElementById('cmtIn');
  comment.value = 'Second thought'; comment.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  assert.equal(press(t, comment), true);
  await settle();
  assert.deepEqual(sent(t).map(([operation]) => operation), ['task.create', 'discussion.comment.edit']);
});

test('Cmd/Ctrl+S never sends a new comment or a Pool item, and does nothing when nothing is being edited', () => {
  const t = taskPage(), comment = t.d.getElementById('cmtIn');
  comment.focus(); comment.value = 'Sent only with Enter';
  assert.equal(press(t, comment), true);
  assert.equal(comment.value, 'Sent only with Enter');
  t.A.openModal('pool');
  const item = t.d.getElementById('poolAdd'); item.focus(); item.value = 'An idea';
  assert.equal(press(t, item), true);
  t.A.closeOverlays(); t.d.activeElement.blur();
  assert.equal(press(t, t.d.body), true);
  assert.deepEqual(t.commands, []);
});

test('with nothing being edited, Cmd/Ctrl+S saves a task field marked Not saved again, as its Save button does', async () => {
  const t = taskPage(), description = t.d.getElementById('task-description');
  description.focus(); description.value = 'Kept when the save failed'; description.blur();
  t.commands[0].reject(new t.w.TestApiError('Something went wrong', { status: 500, code: 'internal_error' }));
  await settle();
  assert.match(t.d.querySelector('.task-description [data-draft-note]').textContent, /Not saved/);
  assert.equal(press(t, t.d.body), true);
  assert.deepEqual(sent(t), [['task.update', { taskId: 'bir-079', description: 'Kept when the save failed' }], ['task.update', { taskId: 'bir-079', description: 'Kept when the save failed' }]]);
});
