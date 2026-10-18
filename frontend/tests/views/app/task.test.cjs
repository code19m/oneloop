// views/app.js: the task page, its dialogs, save feedback and activity feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, source, waitFor, settle } = require('../../support/dom.cjs');

/** A task page whose toasts are recorded as notices. */
function taskPage(options) {
  const t = bootApp({ route: 'task/BIR-079', ...options });
  const notices = [];
  t.A.toast = (text, kind = 'success') => notices.push({ text, kind });
  return { ...t, notices };
}
const event=target=>({target,preventDefault(){}});
function block(t,mode,reason){t.A.openModal(mode,'BIR-079');const form=t.d.querySelector('.modal form');form.querySelector('[name=reason]').value=reason;t.A.saveBlock(event(form),'BIR-079',mode);}

const accept = (t, entities = []) => { t.commands.at(-1).resolve({ entities, events: [] }); return settle(); };
const sent = t => t.commands.map(command => [command.operation, command.payload]);

test('a task without an epic opens on its track, and its Epic says No epic', () => {
 const t = bootApp({ route: 'task/BIR-500', prepare: D => {
  D.tasks.push({ id: 'BIR-500', internalId: 'loose', projectId: 'p1', trackId: 't2', epicId: null, title: 'Loose task', desc: '', detailsLoaded: true, state: 'planning', assignees: [], created: Date.now(), revision: 1 });
 } });
 assert.equal(t.A.context().view, 'task');
 assert.equal(t.d.querySelector('.tp-title').value, 'Loose task');
 assert.equal(t.d.querySelector('#select-tpEpic .sel-label').textContent, 'No epic');
});

test('field saves show a quiet Saved status once accepted, and a block needs a reason', async () => {
 const t=taskPage(),task=t.D.tasks.find(x=>x.id==='BIR-079'),status=()=>t.d.querySelector('.task-save-status').textContent;
 t.A.updTask(task.id,'title','Changed title');await accept(t,[{entityType:'task',id:task.internalId,title:'Changed title',revision:2}]);assert.equal(status(),'Saved');assert.equal(t.notices.length,0);
 t.d.querySelector('.tp-title').dispatchEvent(new t.w.Event('input',{bubbles:true}));assert.equal(status(),'');
 const button=t.d.querySelector('[data-action="popMulti"][data-args*=\'"tpAssign"\']');t.A.popMulti({currentTarget:button,preventDefault(){}},'tpAssign');t.d.querySelector('[data-v="robin"]').click();
 assert.deepEqual(sent(t).at(-1),['task.update',{taskId:task.internalId,assigneeIds:['robin']}]);await accept(t,[{entityType:'task',id:task.internalId,assigneeIds:['robin'],revision:3}]);assert.equal(status(),'Saved');assert.equal(t.notices.length,0);
 const count=t.commands.length;block(t,'block','');assert.equal(t.commands.length,count);assert.match(t.d.querySelector('.modal').textContent,/Explain what is preventing progress/);assert.equal(t.notices.length,0);
});

test('attachment actions announce changes, stay quiet on cancel or no change and report stale permissions', async () => {
 const file=(id,overrides={})=>({id,name:`${id}.txt`,size:1,mediaType:'text/plain',previewKind:'text',isEphemeral:false,uploadedBy:'taylorwu',uploadedAt:1,lastAccessedAt:1,state:'available',revision:1,...overrides});
 const t=taskPage(),task=t.D.tasks.find(x=>x.id==='BIR-079');t.answer('attachments',{items:[file('one'),file('two')]});await settle();
 const answer=(method,value)=>{t.answer(method,value);return settle();};
 t.A.setAttachmentTemporary(task.id,'one',true);await answer('updateAttachment',file('one',{isEphemeral:true,revision:2}));assert.equal(t.notices.at(-1).text,'Attachment marked temporary');assert(!task.attachments[1].ephemeral);
 let count=t.notices.length;t.A.setAttachmentTemporary(task.id,'one',true);assert.equal(t.notices.length,count);assert.equal(t.calls.filter(call=>call.method==='updateAttachment').length,1);
 t.A.delAttachment(task.id,0);t.d.querySelector('[data-confirm-cancel]').click();assert.equal(t.notices.length,count);assert.equal(t.calls.filter(call=>call.method==='deleteAttachment').length,0);
 t.A.delAttachment(task.id,0);t.d.querySelector('[data-confirm-accept]').click();await answer('deleteAttachment',{});assert.equal(t.notices.at(-1).text,'Attachment deleted');
 assert.equal(task.attachments.length,1);t.A.delAttachment(task.id,0);t.D.users.find(u=>u.id==='taylorwu').admin=false;t.D.projects[0].members.find(m=>m.userId==='taylorwu').permissions=[];t.d.querySelector('[data-confirm-accept]').click();assert.equal(t.notices.at(-1).kind,'error');assert.equal(t.calls.filter(call=>call.method==='deleteAttachment').length,1);
});

test('the deadline field saves on blur and rejects invalid text, and task actions follow permissions', async () => {
 const t=taskPage(),task=t.D.tasks.find(x=>x.id==='BIR-079'),field=()=>t.d.getElementById('tpDl-input');
 // A save draws the page again, so each step finds the field anew.
 let input=field();input.value='2026-09-01';t.A.dateBlur(event(input),'tpDl');assert.deepEqual(sent(t),[['task.update',{taskId:task.internalId,deadline:'2026-09-01'}]]);await accept(t,[{entityType:'task',id:task.internalId,deadline:'2026-09-01',revision:2}]);assert.equal(task.deadline,'2026-09-01');assert(!t.d.querySelector('.date-display'));assert.equal(field().value,'2026-09-01');
 input=field();input.value='bad';t.A.dateBlur(event(input),'tpDl');assert.equal(t.commands.length,1);assert.equal(input.getAttribute('aria-invalid'),'true');
 input=field();input.value='';t.A.dateBlur(event(input),'tpDl');assert.deepEqual(sent(t)[1],['task.update',{taskId:task.internalId,deadline:null}]);await accept(t,[{entityType:'task',id:task.internalId,deadline:null,revision:3}]);assert.equal(task.deadline,null);assert.equal(field().value,'');
 const actions=t.d.querySelector('.task-actions-button');t.A.taskActions({currentTarget:actions},task.id);assert(t.d.querySelector('.menu').textContent.includes('Delete task'));t.A.menuAction(0);assert(t.d.querySelector('.confirmation-layer').textContent.includes('Delete task?'));t.d.querySelector('[data-confirm-cancel]').click();assert(t.D.tasks.includes(task));assert.equal(t.commands.length,2);
 t.D.users.find(u=>u.id==='taylorwu').admin=false;t.D.projects[0].members.find(m=>m.userId==='taylorwu').permissions=[];t.A.refresh();assert(!t.d.querySelector('.task-actions-button'));t.A.taskActions({currentTarget:actions},task.id);assert(!t.d.querySelector('.menu'));
});

test('new tasks and Pool promotions send their deadline and assignees and validate both', () => {
 const t=taskPage(),existing=t.D.tasks.find(x=>x.id==='BIR-079'),created=existing.created;
 assert(!t.d.querySelector('[data-date-key="tpStart"]'));assert.match(t.d.querySelector('.task-created-at').firstChild.textContent,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);assert.equal(t.A.updTask(existing.id,'created',created+1),false);assert.equal(existing.created,created);assert.equal(t.A.updTask(existing.id,'start','2026-01-01'),false);assert.equal(t.commands.length,0);
 const fill=(deadline,assignee)=>{const form=t.d.querySelector('.modal form');form.querySelector('[name="epicId"]').value='e4';const input=form.querySelector('.date-text');input.value=deadline;const button=form.querySelector('[data-filter-key="mTaskAssignees"]');t.A.popMulti({currentTarget:button,preventDefault(){}},'mTaskAssignees');t.d.querySelector(`[data-v="${assignee}"]`).click();t.d.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return form;};
 t.A.openModal('task');let form=fill('2026-10-15','robin');form.querySelector('[name="title"]').value='Assigned at creation';t.A.saveTask(event(form));
 assert.deepEqual(sent(t),[['task.create',{projectId:'p1',epicId:'e4',title:'Assigned at creation',description:'',deadline:'2026-10-15',assigneeIds:['robin']}]]);t.A.closeOverlays();
 t.A.openModal('task');form=fill('2026-99-99','robin');form.querySelector('[name="title"]').value='Invalid';t.A.saveTask(event(form));assert.equal(t.commands.length,1);assert(t.d.querySelector('.date-error'));form.querySelector('.date-text').value='';t.D.users.find(u=>u.id==='robin').active=false;t.A.saveTask(event(form));assert.equal(t.commands.length,1);assert(t.d.querySelector('.modal').textContent.includes('no longer available'));t.D.users.find(u=>u.id==='robin').active=true;t.A.closeOverlays();
 // The title and description the person left as the item had them follow the item.
 t.A.openModal('pool');t.A.promotePool('pl1');form=fill('2026-11-01','taylorwu');const item=t.D.pool.find(x=>x.id==='pl1');assert.equal(form.querySelector('[name="title"]').value,item.title);assert.equal(form.querySelector('[name="desc"]').value,item.desc);t.A.saveTask(event(form));
 assert.deepEqual(sent(t)[1],['pool.promote',{poolItemId:'pl1',epicId:'e4',deadline:'2026-11-01',assigneeIds:['taylorwu']}]);
});

test('new epics require an explicit track', async () => {
 const t=taskPage();t.A.openModal('epic');let form=t.d.querySelector('.modal form');assert.equal(form.querySelector('[name="trackId"]').value,'');assert(form.textContent.includes('Choose a track'));form.querySelector('[name="title"]').value='Explicit track';t.A.saveEpic(event(form),'');assert.equal(t.commands.length,0);assert(form.textContent.includes('Choose a track.'));
 form.querySelector('[name="trackId"]').value='t1';t.A.saveEpic(event(form),'');assert.deepEqual([t.commands[0].operation,t.commands[0].payload.trackId,t.commands[0].payload.title],['epic.create','t1','Explicit track']);
 await accept(t,[{entityType:'epic',id:'e-new',projectId:'p1',trackId:'t1',title:'Explicit track',startDate:'2026-10-01',state:'planning',position:20,revision:1}]);t.A.openModal('epic','e-new');assert.equal(t.d.querySelector('[name="trackId"]').value,'t1');
});

test('comment readers measure every body at its natural height, never folded to zero', () => {
  const { w, d } = bootApp({ route: 'task/BIR-079', media: () => false });
  const task = w.DATA.tasks.find(item => item.id === 'BIR-079');
  task.comments = Array.from({ length: 3 }, (_, i) => ({ id: `perf-${i}`, who: w.DATA.session.userId, ts: Date.now() + i, text: 'Long comment', mentions: [] }));
  let reads = 0;
  Object.defineProperty(w.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
    if (this.matches('.comment-body-content')) { reads++; const bodies = [...d.querySelectorAll('.comment-body-content')]; assert.ok(bodies.every(body => ['', 'auto'].includes(body.style.height)), 'every body is unfolded before the first measurement'); return 500; }
    return 0;
  } });
  w.App.refresh(); assert.ok(reads > 0);
});

// The browser keeps the reader's place only when the comments above it already have their folded height.
test('a redraw folds long comments before it puts the task page\'s scroll position back', () => {
  const { w, d } = bootApp({ route: 'task/BIR-079', media: () => false });
  w.DATA.tasks.find(item => item.id === 'BIR-079').comments = Array.from({ length: 3 }, (_, i) => ({ id: `long-${i}`, who: w.DATA.session.userId, ts: Date.now() + i, text: 'Long comment', mentions: [] }));
  Object.defineProperty(w.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.matches('.comment-body-content') ? 500 : 0; } });
  w.App.refresh();
  d.querySelector('.task-page').scrollTop = 900;
  const scrollTop = Object.getOwnPropertyDescriptor(w.Element.prototype, 'scrollTop');
  let heights;
  Object.defineProperty(w.Element.prototype, 'scrollTop', { configurable: true, get: scrollTop.get, set(value) {
    if (this.matches('.task-page') && value === 900) heights ??= [...d.querySelectorAll('.comment-body-content')].map(body => body.style.height);
    scrollTop.set.call(this, value);
  } });
  w.App.refresh();
  assert.deepEqual(heights, ['240px', '240px', '240px']);
});

test('epic, milestone and task descriptions share bounded readers and editors that keep their scroll position', () => {
 const t=bootApp({route:'roadmap',prepare:D=>{D.epics[0].desc='## Goal\n\n<script>unsafe</script>\n'+('A long epic description.\n'.repeat(50));D.milestones[0].desc='A milestone goal.\n'.repeat(25);}});
 // The epic's description shows as Markdown, read-only, as a task's does.
 t.A.openPeek(t.D.epics[0].id);let reader=t.d.querySelector('.description-content');assert.equal(reader.querySelector('.markdown-body h2').textContent,'Goal');assert(!reader.querySelector('script'));assert(!reader.hasAttribute('data-action'));Object.defineProperty(reader,'scrollHeight',{value:1600});t.w.innerHeight=1000;t.A.sizeDescription();assert.equal(reader.style.height,'240px');assert(t.d.querySelector('.peek-description').classList.contains('is-collapsed'));
 t.A.toggleDescription(t.d.querySelector('.peek-description .description-toggle'));assert.equal(reader.style.height,'800px');assert.equal(reader.style.overflowY,'auto');assert(!t.d.querySelector('.peek-description').classList.contains('is-collapsed'));reader.scrollTop=130;t.A.sizeDescription();assert.equal(reader.scrollTop,130);
 for(const [kind,id] of [['epic',t.D.epics[0].id],['milestone',t.D.milestones[0].id],['task',null]]){t.A.closeOverlays();t.A.openModal(kind,id);const input=t.d.querySelector('[data-description-editor]');assert(input);assert(t.d.querySelector('.modal .optional-mark'));assert(!t.d.querySelector('.modal .description-toggle'));Object.defineProperty(input,'scrollHeight',{value:1600});t.A.sizeDescriptionEditors();assert.equal(input.style.height,'320px');assert.equal(input.style.overflowY,'auto');input.scrollTop=180;t.A.sizeDescriptionEditors();assert.equal(input.scrollTop,180);t.w.innerHeight=500;t.A.sizeDescriptionEditors();assert.equal(input.style.height,'200px');t.w.innerHeight=1000;}
 t.A.closeOverlays();t.A.openTask('BIR-079');const input=t.d.querySelector('#task-description');Object.defineProperty(input,'scrollHeight',{value:1600});t.A.sizeDescription();assert.equal(input.style.height,'240px');t.A.expandDescription();assert.equal(input.style.height,'800px');t.A.toggleDescription();assert.equal(input.style.height,'240px');
});

/** A task page whose BIR-079 has `desc` as its saved description, with the app's view actions. */
const describedTask = (desc, options = {}) => taskPage({ actions: true, ...options, prepare: (D, w) => { D.tasks.find(item => item.id === 'BIR-079').desc = desc; options.prepare?.(D, w); } });
const click = (t, element) => element.dispatchEvent(new t.w.MouseEvent('click', { bubbles: true, cancelable: true }));

test('a description shows as Markdown, and a click on its text opens the editor, at the end where the browser can\'t place the caret', () => {
  const source = '## Plan\n\n- [ ] Write **tests**\n\nSee BIR-064 and XYZ-001, `BIR-065` and [the guide](https://example.invalid/guide).\nA new line, as the text has it.';
  const t = describedTask(source), reader = () => t.d.getElementById('task-description-content');
  assert.equal(t.d.getElementById('task-description'), null, 'no editor until the person opens it');
  assert.equal(reader().querySelector('.markdown-body h2').textContent, 'Plan');
  assert(reader().querySelector('p br'), 'a line break in the text is a line break');
  assert.equal(reader().querySelector('input[type=checkbox]').disabled, true, 'task lists stay read-only');
  assert.deepEqual([...reader().querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href'), link.className]),
    [['BIR-064', '#/task/BIR-064', 'task-key-link'], ['the guide', 'https://example.invalid/guide', '']], 'keys of projects the person can see link to their tasks; other keys and code stay text');
  // A click on a link follows it, and one that ends a selection keeps it.
  t.w.addEventListener('click', event => event.preventDefault(), { once: true });
  click(t, reader().querySelector('a[href^="https:"]'));
  t.w.getSelection().selectAllChildren(reader().querySelector('h2')); click(t, reader().querySelector('h2'));
  assert.equal(t.d.getElementById('task-description'), null);
  t.w.getSelection().removeAllRanges(); click(t, reader().querySelector('strong'));
  const editor = t.d.getElementById('task-description');
  assert.equal(t.d.activeElement, editor); assert.equal(editor.value, source); assert.equal(editor.selectionStart, source.length);
  assert.equal(t.d.querySelector('.description-edit').hidden, true, 'Edit hides while the editor is open');
  // Leaving the unchanged text shows it again, with nothing to save.
  editor.blur();
  assert.equal(t.d.getElementById('task-description'), null); assert(reader().querySelector('.markdown-body'));
  assert.equal(t.d.querySelector('.description-edit').hidden, false); assert.equal(t.commands.length, 0);
});

test('a click on the description puts the caret where it landed, and a double-click selects that word', () => {
  const t = describedTask('## Plan\n\nWrite **tests** before the code.'), strong = t.d.querySelector('#task-description-content strong');
  // jsdom lays nothing out, so the browser's answer for the point is given: in "tests", after "te".
  t.d.caretPositionFromPoint = () => ({ offsetNode: strong.firstChild, offset: 2 });
  strong.dispatchEvent(new t.w.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  const editor = t.d.getElementById('task-description');
  assert.equal(t.d.activeElement, editor);
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [19, 19]);
  // The editor took the text's place under the pointer before the second press.
  const press = new t.w.MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
  editor.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  assert.equal(editor.value.slice(editor.selectionStart, editor.selectionEnd), 'tests');
});

test('Escape and Ctrl+Enter save the description, which shows again once saved, and give focus to Edit', async () => {
  for (const [index, init] of [{ key: 'Escape' }, { key: 'Enter', ctrlKey: true }].entries()) {
    const t = describedTask('Saved text'), task = t.D.tasks.find(item => item.id === 'BIR-079');
    click(t, t.d.querySelector('.description-edit'));
    const editor = t.d.getElementById('task-description');
    assert.equal(t.d.activeElement, editor, 'Edit opens the editor');
    editor.value = `Changed ${index}`; editor.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    const key = new t.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); editor.dispatchEvent(key);
    assert(key.defaultPrevented);
    assert.deepEqual(sent(t), [['task.update', { taskId: task.internalId, description: `Changed ${index}` }]]);
    assert.equal(t.d.activeElement, t.d.querySelector('.description-edit'));
    assert.equal(t.d.getElementById('task-description').value, `Changed ${index}`, 'the editor stays while its save is on its way');
    await accept(t, [{ entityType: 'task', id: task.internalId, description: `Changed ${index}`, revision: 2 }]);
    assert.equal(t.d.getElementById('task-description'), null);
    assert.equal(t.d.getElementById('task-description-content').textContent.trim(), `Changed ${index}`);
    assert.equal(t.d.activeElement, t.d.querySelector('.description-edit'), 'Edit keeps focus');
  }
});

test('a title changed elsewhere waits for a press below it to end, as a longer title moves what lies below', async () => {
  const t = taskPage(), task = t.D.tasks.find(item => item.id === 'BIR-079'), title = t.d.querySelector('.tp-title'), below = t.d.querySelector('.task-activity h2');
  const pointer = type => below.dispatchEvent(new t.w.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  pointer('pointerdown');
  task.title = 'A teammate\'s much longer title, which takes more lines than the one before it'; t.A.refreshTask(task.id);
  assert.equal(title.value, 'Flexible reading schedule', 'the title keeps its place while the button is down');
  pointer('pointerup');
  await waitFor(() => title.value === task.title, 'the new title shows once the press ends');
});

test('a press below the description keeps the editor in place until the press ends, so its click lands', async () => {
  for (const changed of [false, true]) {
    const t = describedTask('One line'), task = t.D.tasks.find(item => item.id === 'BIR-079'), below = t.d.querySelector('.task-activity h2');
    const pointer = type => below.dispatchEvent(new t.w.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    t.A.editDescription(task.id);
    const editor = t.d.getElementById('task-description');
    if (changed) editor.value = 'One line, changed';
    // The press moves focus out of the editor before its click.
    pointer('pointerdown'); editor.blur();
    if (changed) await accept(t, [{ entityType: 'task', id: task.internalId, description: 'One line, changed', revision: 2 }]);
    assert.equal(t.d.getElementById('task-description'), editor, `the editor keeps its place while the button is down (changed: ${changed})`);
    pointer('pointerup'); click(t, below);
    await waitFor(() => !t.d.getElementById('task-description'), 'the description shows its text once the press ends');
    assert.equal(t.d.getElementById('task-description-content').textContent.trim(), changed ? 'One line, changed' : 'One line');
  }
});

test('Escape in an empty or emptied description keeps focus on its field, which opens it again', () => {
  for (const desc of ['', 'Saved text']) {
    const t = describedTask(desc);
    t.A.editDescription('BIR-079');
    const editor = t.d.getElementById('task-description');
    editor.value = ''; editor.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    editor.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(t.d.activeElement, t.d.getElementById('task-description'), JSON.stringify(desc));
  }
});

test('Escape while a press is still down gives focus to Edit, though the editor waits for the press to end', () => {
  const t = describedTask('One line'), below = t.d.querySelector('.task-activity h2');
  t.A.editDescription('BIR-079');
  below.dispatchEvent(new t.w.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  t.d.getElementById('task-description').dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(t.d.activeElement, t.d.querySelector('.description-edit'));
  assert(t.d.getElementById('task-description'), 'the editor keeps its place while the button is down');
});

test('a context menu or a native drag ends a press that sends no pointerup, so the description shows its text', async () => {
  for (const type of ['contextmenu', 'dragend']) {
    const t = describedTask('One line'), below = t.d.querySelector('.task-activity h2');
    t.A.editDescription('BIR-079');
    below.dispatchEvent(new t.w.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    t.d.getElementById('task-description').blur();
    assert(t.d.getElementById('task-description'), 'the editor waits while the button is down');
    below.dispatchEvent(new t.w.Event(type, { bubbles: true, cancelable: true }));
    await waitFor(() => !t.d.getElementById('task-description'), `the description shows its text after ${type}`);
  }
});

test('a description keeps its editor while a conflict question or a Not saved draft holds its text', async () => {
  const t = conflictPage({ desc: 'Their description' }), editor = () => t.d.getElementById('task-description');
  t.task.desc = 'Saved description'; t.A.refresh();
  t.A.editDescription(t.task.id);
  // As in the app, the field's blur handler saves before focus leaves it.
  editor().value = 'My description'; t.A.updTask(t.task.id, 'desc', editor().value); editor().blur();
  t.commands[0].reject(conflict(t));
  await waitFor(() => promptButton(t, 'Keep my changes'), 'the conflict prompt appears');
  assert.equal(editor().value, 'My description', 'the question stays beside the editor');
  promptButton(t, 'Keep my changes').click();
  await waitFor(() => t.commands.length === 2, 'Keep my changes saves again');
  await accept(t, [{ entityType: 'task', id: t.task.internalId, description: 'My description', revision: 3 }]);
  assert.equal(editor(), null); assert.equal(t.d.getElementById('task-description-content').textContent.trim(), 'My description');
  t.w.Recovery.observeResponse({ ok: false, error: new t.w.TestApiError('Unable to reach oneloop', { code: 'network_error' }), requestContext: t.w.Recovery.requestContext() });
  t.A.editDescription(t.task.id);
  editor().value = 'Written offline'; t.A.updTask(t.task.id, 'desc', editor().value); editor().blur(); await settle();
  t.A.refresh();
  assert.equal(editor().value, 'Written offline'); assert.match(t.d.querySelector('.task-description [data-draft-note]').textContent, /Not saved/);
});

test('read-only members read the description without Edit, and see No description when it is empty', () => {
  const readOnly = D => { D.users.find(user => user.id === 'taylorwu').admin = false; D.projects[0].members.find(member => member.userId === 'taylorwu').permissions = []; };
  const t = describedTask('Only **read**', { prepare: readOnly }), reader = t.d.getElementById('task-description-content');
  assert.equal(reader.querySelector('strong').textContent, 'read'); assert.equal(t.d.querySelector('.description-edit'), null);
  click(t, reader); assert.equal(t.d.getElementById('task-description'), null);
  const empty = describedTask('', { prepare: readOnly });
  assert.equal(empty.d.getElementById('task-description-content').textContent, 'No description'); assert.equal(empty.d.getElementById('task-description'), null);
});

test('a description shows its text while the renderer loads, and keeps it when the renderer can\'t load', async () => {
  for (const loads of [true, false]) {
    const pending = [];
    const t = describedTask('# Heading\n\nBody text', { libraries: [], setup: w => { w.document.head.append = element => pending.push(element); } });
    const reader = t.d.getElementById('task-description-content');
    assert.equal(reader.textContent, '# Heading\n\nBody text', 'the plain text shows at once');
    while (pending.length) {
      const element = pending.shift(), name = new URL(element.src || element.href).pathname.slice(1);
      if (!loads) { element.onerror(); continue; }
      if (element.tagName === 'SCRIPT') t.w.eval(source(name));
      element.onload(); await settle();
    }
    await settle();
    if (loads) assert.equal(reader.querySelector('.markdown-body h1').textContent, 'Heading');
    else { assert.equal(reader.textContent, '# Heading\n\nBody text'); assert.equal(t.d.querySelector('.task-description [role=alert]'), null, 'and no error box'); }
  }
});

test('closing the task dialog discards its unsent input without a stored draft', () => {
const {w,d,A}=bootApp({route:'board'});A.openModal('task');const form=d.querySelector('.modal form');form.querySelector('[name="title"]').value='Recover me';form.querySelector('[name="title"]').dispatchEvent(new w.Event('input',{bubbles:true}));A.closeOverlays();A.openModal('task');assert.equal(d.querySelector('.modal [name="title"]').value,'');assert.equal(w.localStorage.getItem('oneloop.drafts.v1'),null);
});

test('opaque task IDs resolve to the task page', () => {
const opaque=bootApp({route:'task/opaque-example',prepare:D=>D.tasks[0].internalId='opaque-example'});assert(opaque.d.querySelector('.topbar').textContent.includes('BIR-064'));
});

test('the activity feed loads older records a page at a time', async () => {
 const t=bootApp({route:'task/BIR-079'}),task=t.D.tasks.find(x=>x.id==='BIR-079'),rows=()=>t.d.querySelectorAll('.timeline .tl-act').length;
 const page=(from,cursor)=>({items:Array.from({length:50},(_,i)=>({id:`event-${from+i}`,eventType:'task.updated',fieldKey:'title',actorUserId:'taylorwu',createdAt:Math.floor(Date.now()/1000)-(from+i)})),nextCursor:cursor});
 t.answer('comments',{items:[],nextCursor:null});t.answer('activity',page(0,'older'));await settle();assert.equal(rows(),50);
 t.A.loadOlderActivity(task.id);assert.equal(t.calls.filter(call=>call.method==='activity').at(-1).args[1].cursor,'older');
 t.answer('activity',page(50,null));await settle();assert.equal(rows(),100);assert.equal(t.d.querySelector('[data-feed-key="load-older"]'),null);
});

test('an open task page reads its attachments, comments and activity again after a full reload of the workspace', async () => {
 const reads=[];
 const t=bootApp({route:'task/BIR-079',api:{
  attachments:async()=>{reads.push('attachments');return {items:[]};},
  comments:async()=>{reads.push('comments');return {items:[],nextCursor:null};},
  activity:async()=>{reads.push('activity');return {items:[],nextCursor:null};},
 }});
 await waitFor(()=>reads.length===3,'the page reads its lists');await settle();
 // A full reload replaces each task with one that keeps its lists, as hydrateLegacyData does, and the page draws again.
 t.D.tasks.splice(0,Infinity,...t.D.tasks.map(task=>({...task})));
 t.runtime.publish({type:'bootstrap',projection:{}});t.A.refreshBackground();await settle();
 assert.deepEqual(reads.slice(3).sort(),['activity','attachments','comments']);
});

/** A task page whose commands the test answers; reading the task again brings someone else's `latest` change. */
function conflictPage(latest = { title: 'Their title', deadline: '2026-11-30' }) {
  let task;
  const t = bootApp({
    route: 'task/BIR-079', media: () => true,
    prepare: D => { task = Object.assign(D.tasks.find(x => x.id === 'BIR-079'), { internalId: 'bir-079', projectId: 'p1', revision: 1, deadline: null }); },
    reads: { task: async () => { Object.assign(task, { revision: 2, ...latest }); t.A.refresh(); return { stale: false, task }; } },
  });
  return { ...t, task };
}

test('a title conflict keeps newer typing elsewhere and shows the title as typed beside the latest one', async () => {
  const t = conflictPage(), title = t.d.querySelector('.tp-title');
  // This page runs no view actions, so the test calls the blur's handler itself.
  title.focus(); title.value = 'My title'; title.blur(); t.A.updTask(t.task.id, 'title', title.value);
  const description = t.d.getElementById('task-description');
  description.focus(); description.value = 'Typed after the title save started'; description.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  assert.equal(t.commands.length, 1);
  t.commands[0].reject(new t.w.TestApiError('record changed; latest revision is 2', { status: 409, code: 'revision_conflict' }));
  await waitFor(() => t.d.querySelector('[data-recovery-conflict]'), 'the conflict prompt appears');
  assert.equal(t.d.getElementById('task-description').value, 'Typed after the title save started');
  assert.equal(t.d.querySelector('.tp-title').value, 'My title');
  assert.equal(t.d.getElementById('tpDl-input').value, '2026-11-30', 'other fields show the latest saved values');
  assert.match(t.d.querySelector('[data-recovery-conflict]').textContent, /Latest saved value: Their title/);
});

test('Use latest on a description shows the saved description, not the typed one', async () => {
  const t = conflictPage({ desc: 'Their description' }), description = t.d.getElementById('task-description');
  description.focus(); description.value = 'My description'; description.blur(); t.A.updTask(t.task.id, 'desc', description.value);
  t.commands[0].reject(new t.w.TestApiError('record changed; latest revision is 2', { status: 409, code: 'revision_conflict' }));
  await waitFor(() => t.d.querySelector('[data-recovery-conflict]'), 'the conflict prompt appears');
  [...t.d.querySelectorAll('[data-recovery-conflict] button')].find(button => button.textContent === 'Use latest').click();
  await waitFor(() => !t.bridge.taskDraft(t.task.internalId, 'desc'), 'the typed description is dropped');
  await settle();
  // With nothing left to save, the description shows its saved text.
  assert.equal(t.d.getElementById('task-description-content').textContent.trim(), 'Their description');
  assert.equal(t.d.querySelector('.task-description [data-draft-note]'), null);
});

test('an unsaved description stays on the page through refreshes and offers Save', async () => {
  const t = conflictPage();
  t.w.Recovery.observeResponse({ ok: false, error: new t.w.TestApiError('Unable to reach oneloop', { code: 'network_error' }), requestContext: t.w.Recovery.requestContext() });
  const description = t.d.getElementById('task-description');
  description.focus(); description.value = 'Written offline'; description.blur(); t.A.updTask(t.task.id, 'desc', description.value);
  await settle();
  t.d.querySelector('.tp-title').focus(); t.A.refresh();
  assert.equal(t.d.getElementById('task-description').value, 'Written offline');
  const note = t.d.querySelector('.task-description [data-draft-note]');
  assert.match(note.textContent, /Not saved/); assert(note.querySelector('button'));
  assert.equal(t.commands.length, 0);
});

test('a saved status shows in the header, the Status icon and Block task while Status keeps focus', async () => {
  const t = bootApp({ route: 'task/BIR-079' }), task = t.D.tasks.find(item => item.id === 'BIR-079');
  const select = t.d.getElementById('select-tpState');
  select.focus(); t.A.popSelect({ currentTarget: select, preventDefault() {} }, 'tpState');
  [...t.d.querySelectorAll('.pop-opt')].find(option => option.textContent === 'Done').click();
  assert.deepEqual([t.commands[0].operation, t.commands[0].payload.status], ['task.move', 'done']);
  t.commands[0].resolve({ entities: [{ entityType: 'task', id: task.internalId, status: 'done', revision: 2 }], events: [] }); await settle();
  assert.equal(t.d.querySelector('.task-status-chip').textContent, 'Done');
  assert.equal(select.querySelector('svg').outerHTML, t.d.querySelector('.task-status-chip svg').outerHTML, 'the Status icon is the Done ring');
  assert.equal(t.d.querySelector('.block-task-action'), null, 'a finished task offers no Block task');
  assert.equal(t.d.activeElement, select);
});

/**
 * A task page on which someone else changes BIR-079 to `fields`. A live hint
 * names the task, and the epic too when the change also moved the epic, such
 * as a first move to In Progress. The page then reads the task, or the whole
 * workspace, as boot.js wires it.
 */
function changedElsewhere(options = {}) {
  let latest = null, reload;
  const none = async () => ({ items: [], nextCursor: null });
  const t = bootApp({ route: 'task/BIR-079', actions: true, ...options, api: { task: async () => latest, comments: none, activity: none, attachments: none }, reloadBootstrap: scope => reload(scope) });
  const { replaceTaskDetail } = t.module('src/data/projection-store.js');
  const bootstrap = { idle: async () => {}, load: async () => { if (latest) replaceTaskDetail(t.D, latest); return { stale: false }; } };
  reload = t.module('src/app/projection-reload.js').createProjectionReload({ data: t.D, bootstrap, reads: t.reads, getApp: () => t.A, getBridge: () => null, getRecovery: () => t.w.Recovery, location: t.w.location });
  return { ...t, change(entityTypes, fields) {
    latest = { id: 'bir-079', taskKey: 'BIR-079', projectId: 'p1', trackId: 't1', epicId: 'e2', title: 'Flexible reading schedule', description: t.D.tasks.find(item => item.id === 'BIR-079').desc ?? '', status: 'planning', position: 1, createdAt: 1, updatedAt: 2, assigneeIds: [], activeBlock: null, revision: 2, ...fields };
    for (const entityType of entityTypes) t.events.at(-1).emit('hint', { kind: 'activity.changed', projectId: 'p1', taskId: 'bir-079', entityType, entityId: entityType === 'epic' ? 'e2' : 'bir-079', entityRevision: latest.revision });
  } };
}
const hintsOfAChange = [['task'], ['epic', 'task']];

test('a status changed elsewhere shows at once in the header and Status, while the description being typed in stays', async () => {
  for (const hints of hintsOfAChange) {
    const t = changedElsewhere(), description = t.d.getElementById('task-description'), status = t.d.getElementById('select-tpState');
    description.focus(); description.value = 'Typed while a teammate works';
    t.change(hints, { status: 'in_progress' });
    await waitFor(() => t.d.querySelector('.task-status-chip').textContent === 'In Progress', `the header shows the new status (hints: ${hints})`);
    assert.equal(status.querySelector('.sel-label').textContent, 'In Progress'); assert.equal(status.dataset.tip, 'In Progress');
    assert.equal(t.d.activeElement, description); assert.equal(description.value, 'Typed while a teammate works');
    t.A.popSelect({ currentTarget: status, preventDefault() {} }, 'tpState');
    assert.equal(t.d.querySelector('.pop-opt[aria-selected="true"]').textContent, 'In Progress', 'its list marks the new status');
  }
});

test('a description changed elsewhere shows at once while focus is elsewhere on the page, and once focus leaves its text', async () => {
  for (const hints of hintsOfAChange) {
    const t = changedElsewhere({ prepare: D => { D.tasks.find(item => item.id === 'BIR-079').desc = 'The first text'; } });
    const edit = t.d.querySelector('.description-edit'), reader = () => t.d.getElementById('task-description-content');
    edit.focus();
    t.change(hints, { description: 'Written by an agent, see BIR-064.' });
    await waitFor(() => reader().textContent.trim() === 'Written by an agent, see BIR-064.', `the description shows the new text (hints: ${hints})`);
    assert.equal(t.d.activeElement, edit);
    // Someone on a link in the text keeps their place until focus leaves the text.
    const link = reader().querySelector('a.task-key-link'); link.focus();
    t.change(hints, { description: 'Changed again', status: 'in_progress', revision: 3 });
    await waitFor(() => t.d.querySelector('.task-status-chip').textContent === 'In Progress', 'the change arrived');
    assert.equal(t.d.activeElement, link, `the link keeps focus (hints: ${hints})`); assert.match(reader().textContent, /Written by an agent/);
    edit.focus();
    await waitFor(() => reader().textContent.trim() === 'Changed again', 'the new text shows once focus leaves the text');
  }
});

test('Enter in the title leaves it, which saves it, but not while text is being composed', () => {
  const t = bootApp({ route: 'task/BIR-079', actions: true }), title = t.d.querySelector('.tp-title');
  const enter = init => { const event = new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }); title.dispatchEvent(event); return event; };
  title.focus(); title.value = 'Renamed with Enter';
  assert.equal(enter({ isComposing: true }).defaultPrevented, false); assert.equal(t.d.activeElement, title);
  assert.equal(enter().defaultPrevented, true);
  assert.notEqual(t.d.activeElement, title); assert.deepEqual(t.commands.map(command => [command.operation, command.payload.title]), [['task.update', 'Renamed with Enter']]);
});

test('a pasted line break cleans the title without splitting an emoji at its length limit', () => {
  const t = taskPage(), title = t.d.querySelector('.tp-title');
  title.focus(); title.value = ''; title.setSelectionRange(0, 0);
  const paste = new t.w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'A'.repeat(139) + '😀\n' + 'B'.repeat(10) } });
  title.dispatchEvent(paste);
  assert(paste.defaultPrevented);
  assert.equal(title.value, 'A'.repeat(139));
  assert(title.value.isWellFormed());
  title.value = 'A'.repeat(137); title.setSelectionRange(137, 137);
  const joined = new t.w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(joined, 'clipboardData', { value: { getData: () => '\t👩‍💻 x' } });
  title.dispatchEvent(joined);
  assert.equal(title.value, 'A'.repeat(137) + ' ', 'a joined emoji that does not fit stays whole');
});

test('text typed into a task field when edit rights end stays as Not saved, readable and saved again once rights return', () => {
  const t = conflictPage();
  const actor = t.D.users.find(user => user.id === t.D.session.userId), membership = t.D.projects[0].members.find(member => member.userId === actor.id);
  const description = t.d.getElementById('task-description');
  description.focus(); description.value = 'Typed while access changed';
  actor.admin = false; const permissions = membership.permissions; membership.permissions = [];
  t.A.refreshBackground();
  let field = t.d.getElementById('task-description'), note = t.d.querySelector('.task-description [data-draft-note]');
  assert.equal(field.value, 'Typed while access changed');
  assert.equal(field.readOnly, true); assert.equal(field.disabled, false);
  assert.equal(note?.getAttribute('role'), 'alert'); assert.equal(note.textContent, 'Not saved. You no longer have permission to edit this task.');
  assert.equal(t.d.activeElement, field, 'focus stays on the text');
  t.A.refresh();
  assert.equal(t.d.getElementById('task-description').value, 'Typed while access changed', 'a later refresh keeps it');
  actor.admin = true; membership.permissions = permissions; t.A.refresh();
  field = t.d.getElementById('task-description'); note = t.d.querySelector('.task-description [data-draft-note]');
  assert.equal(field.readOnly, false); assert.equal(field.value, 'Typed while access changed');
  assert.match(note.textContent, /^Not saved/); assert(note.querySelector('button'));
  t.A.saveTaskDraft(t.task.id, 'desc');
  assert.deepEqual(t.commands.map(command => [command.operation, command.payload.description, command.expectedRevision]), [['task.update', 'Typed while access changed', 1]]);
});

const conflict = t => new t.w.TestApiError('record changed; latest revision is 2', { status: 409, code: 'revision_conflict' });
const promptButton = (t, label) => [...t.d.querySelectorAll('[data-recovery-conflict] button')].find(button => button.textContent === label);
/** Save `value` into a task field, as its blur does, and answer the save with a conflict. */
async function conflictOn(t, field, value) {
  field.focus(); field.value = value; field.blur(); t.A.updTask(t.task.id, field.id === 'task-description' ? 'desc' : 'title', value);
  t.commands[0].reject(conflict(t));
  await waitFor(() => promptButton(t, 'Use latest'), 'the conflict prompt appears');
}

test('a live redraw keeps the conflict prompt beside the redrawn field until the person answers it', async () => {
  const t = conflictPage({ desc: 'Their description' }), description = t.d.getElementById('task-description');
  await conflictOn(t, description, 'My description');
  const prompt = t.d.querySelector('[data-recovery-conflict]'), keep = promptButton(t, 'Keep my changes');
  keep.focus();
  // A teammate's change arrives and the task page draws again.
  t.A.refresh(); await settle();
  assert.notEqual(t.d.getElementById('task-description'), description, 'the field was drawn again');
  assert.equal(t.d.querySelector('.task-description [data-recovery-conflict]'), prompt, 'the prompt is beside the new field');
  assert.equal(t.d.activeElement, keep, 'and keeps focus on its button');
  assert.equal(t.d.querySelector('.task-description [data-draft-note]'), null, 'no Not saved note while it waits');
  keep.click();
  await waitFor(() => t.commands.length === 2, 'Keep my changes saves again');
  assert.equal(t.commands[1].payload.description, 'My description'); assert.equal(t.commands[1].expectedRevision, 2);
});

test('after a redraw, Use latest shows the latest value in the redrawn field', async () => {
  const t = conflictPage({ title: 'Their title' });
  await conflictOn(t, t.d.querySelector('.tp-title'), 'My title');
  t.A.refresh(); await settle();
  promptButton(t, 'Use latest').click();
  await waitFor(() => !t.bridge.taskDraft(t.task.internalId, 'title'), 'the typed title is dropped');
  assert.equal(t.d.querySelector('.tp-title').value, 'Their title');
  assert.equal(t.d.querySelector('[data-recovery-conflict]'), null);
});

test('leaving the task page still closes the prompt, and the change waits there as Not saved', async () => {
  const t = conflictPage({ desc: 'Their description' });
  await conflictOn(t, t.d.getElementById('task-description'), 'My description');
  t.A.nav('board'); await settle();
  assert.equal(t.d.querySelector('[data-recovery-conflict]'), null);
  t.A.openTask(t.task.id); await settle();
  assert.equal(t.d.getElementById('task-description').value, 'My description');
  assert.match(t.d.querySelector('.task-description [data-draft-note]').textContent, /Not saved/);
});

test('Ctrl+Z runs the newest Undo while its message shows, and leaves typing in a text field alone', async () => {
  const t = bootApp({ route: 'task/BIR-079' });
  const runs = [];
  t.A.offerUndo('First deleted', () => runs.push('first'));
  await waitFor(() => t.d.querySelector('[data-announce="polite"]').textContent === 'First deleted. Press Control+Z to undo.', 'the message says how to undo');
  t.A.offerUndo('Second deleted', () => runs.push('second'));
  const press = (target, init = { ctrlKey: true }) => { const event = new t.w.KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true, ...init }); target.dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(press(t.d.getElementById('cmtIn')), false, 'in a text field the key undoes typing');
  assert.equal(press(t.d.body, { ctrlKey: true, shiftKey: true }), false);
  assert.deepEqual(runs, []);
  t.A.openModal('task'); t.d.querySelector('.modal button').focus();
  assert.equal(press(t.d.activeElement), false, 'a dialog is open');
  t.A.closeOverlays();
  assert.deepEqual(runs, []);
  assert.equal(press(t.d.body), true); assert.deepEqual(runs, ['second']);
  assert.equal(press(t.d.body, { ctrlKey: true, key: 'y', code: 'KeyZ' }), false, 'Ctrl+Y on a German keyboard is no Undo'); assert.deepEqual(runs, ['second']);
  assert.equal(press(t.d.body, { metaKey: true, key: 'я', code: 'KeyZ' }), true, 'the key in the Z place works without Latin letters'); assert.deepEqual(runs, ['second', 'first']);
  assert.equal(press(t.d.body), false, 'no Undo is left');
  assert.equal(t.d.querySelector('.toast-action'), null);
  t.A.offerUndo('Third deleted', () => {});
  assert.equal(t.d.querySelector('.toast-action').getAttribute('aria-keyshortcuts'), 'Control+Z');
});

test('an Undo that fails in a way worth trying again offers Undo again, while the server can still restore', () => {
  const t = bootApp({ route: 'board' });
  let tries = 0;
  t.A.offerUndo('WEB-1 deleted', again => { tries++; again('The service is temporarily unavailable. Try again in 1 second.'); });
  t.d.querySelector('#toast-region .toast-action').click();
  const failed = () => [...t.d.querySelectorAll('#toast-region .toast[data-toast-id]')].at(-1);
  assert.equal(failed().dataset.kind, 'error'); assert.match(failed().textContent, /temporarily unavailable/);
  failed().querySelector('.toast-action').click();
  assert.equal(tries, 2, 'the person tried again');
  // Five minutes after the deletion the server can't restore it, so a failure is only reported.
  const now = t.w.Date.now; t.w.Date.now = () => now() + 5 * 60_000;
  failed().querySelector('.toast-action').click();
  assert.equal(tries, 3); assert.equal(failed().querySelector('.toast-action'), null);
});

test('a message with an action runs it once and closes, and never merges with another', () => {
  const t = bootApp({ route: 'board' });
  const runs = [];
  t.A.toast('Comment deleted', 'success', { action: { label: 'Undo', run: () => runs.push('first') } });
  t.A.toast('Comment deleted', 'success', { action: { label: 'Undo', run: () => runs.push('second') } });
  const toasts = [...t.d.querySelectorAll('#toast-region .toast')];
  assert.equal(toasts.length, 2, 'each deletion keeps its own Undo');
  const undo = toasts[0].querySelector('.toast-action');
  assert.equal(undo.firstChild.textContent, 'Undo'); assert.equal(undo.querySelector('kbd').getAttribute('aria-hidden'), 'true');
  undo.click(); undo.click();
  assert.deepEqual(runs, ['first']);
  assert.equal(t.d.querySelectorAll('#toast-region .toast[data-toast-id]').length, 1);
});

test('a block save announces what changed', async () => {
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').block = { id: 'b1', reason: 'Waiting', revision: 1, by: 'taylorwu', at: Date.now(), mentions: [] }; } });
  const notices = []; t.A.toast = text => notices.push(text);
  for (const [mode, reason] of [['block', 'Waiting for review'], ['completeBlocked', 'Reviewed']]) {
    t.A.openModal(mode, 'BIR-079'); const form = t.d.querySelector('.modal form'); form.querySelector('[name=reason]').value = reason;
    t.A.saveBlock({ target: form, preventDefault() {} }, 'BIR-079', mode);
    t.commands.at(-1).resolve({ entities: [], events: [] }); await settle();
  }
  assert.deepEqual(t.commands.map(command => command.operation), ['task.block.update', 'task.unblock-and-complete']);
  assert.deepEqual(notices, ['Block reason updated', 'Task unblocked and completed']);
});

test('Done in Status on a blocked task asks to unblock and complete it, as the Board does', async () => {
  const t = bootApp({ route: 'task/BIR-079', prepare: D => { D.tasks.find(item => item.id === 'BIR-079').block = { id: 'b1', reason: 'Waiting', revision: 1, by: 'taylorwu', at: Date.now(), mentions: [] }; } });
  const select = t.d.getElementById('select-tpState');
  t.A.popSelect({ currentTarget: select, preventDefault() {} }, 'tpState');
  [...t.d.querySelectorAll('.pop-opt')].find(option => option.textContent === 'Done').click();
  await settle();
  assert.equal(t.commands.length, 0, 'the server refuses to complete a blocked task');
  assert(t.d.querySelector('.modal').textContent.includes('Unblock and complete'));
  assert.equal(t.d.activeElement, t.d.querySelector('.modal [name="reason"]'), 'the dialog starts in its resolution field');
  t.A.closeOverlays(); await settle();
  assert.equal(t.d.querySelector('#select-tpState .sel-label').textContent, 'Planning', 'Status still shows the saved status');
  assert.equal(t.d.activeElement, t.d.getElementById('select-tpState'), 'closing the dialog returns focus to Status');
});

test('task keys keep linking to their tasks after their project\'s prefix changes', () => {
  const t = describedTask('See BIR-064, and the task after it.');
  // An admin changes the prefix; the change's answer names the one before.
  t.module('src/data/projection-store.js').reconcileCommandResult(t.D, { entities: [{ entityType: 'project', id: 'p1', projectId: 'p1', name: 'Birch Grove', taskPrefix: 'NEW', earlierPrefixes: ['BIR'], revision: 2 }] });
  t.A.refresh();
  const links = [...t.d.querySelectorAll('#task-description-content a')].map(link => [link.textContent, link.getAttribute('href')]);
  assert.deepEqual(links, [['BIR-064', '#/task/BIR-064']]);
});
