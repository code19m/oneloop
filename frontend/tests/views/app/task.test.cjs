// views/app.js: the task page, its dialogs, save feedback and activity feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, settle } = require('../../support/dom.cjs');
const { installViewBridge } = require('../../../src/app/view-bridge.js');

/** Boot the views; `prepare(D, w)` edits the projection before they load. */
const boot = (route = 'board', { stored, prepare } = {}) => bootApp({ route, stored, prepare });

/** A task page whose toasts are recorded as notices. */
function taskPage() {
  const t = bootApp({ route: 'task/BIR-079' });
  const notices = [];
  t.A.toast = (text, kind = 'success') => notices.push({ text, kind });
  return { ...t, notices };
}
const event=target=>({target,preventDefault(){}});
function block(t,mode,reason){t.A.openModal(mode,'BIR-079');const form=t.d.querySelector('.modal form');form.querySelector('[name=reason]').value=reason;t.A.saveBlock(event(form),'BIR-079',mode);}

test('field saves show a quiet Saved status and block actions announce once', () => {
 const t=taskPage(),task=t.D.tasks.find(x=>x.id==='BIR-079'),status=()=>t.d.querySelector('.task-save-status').textContent;
 t.A.updTask(task.id,'title','Changed title');assert.equal(status(),'Saved');assert.equal(t.notices.length,0);
 // No-op command feedback is covered by view-bridge tests against the production command gateway.
 t.A.updTask(task.id,'state','progress');assert.equal(status(),'Saved');
 t.d.querySelector('.tp-title').dispatchEvent(new t.w.Event('input',{bubbles:true}));assert.equal(status(),'');
 t.A.updTask(task.id,'deadline','bad');assert.equal(status(),'');assert(t.d.querySelector('.date-error'));
 const button=t.d.querySelector('[onclick*="tpAssign"]');t.A.popMulti({currentTarget:button,preventDefault(){}},'tpAssign');t.d.querySelector('[data-v="robin"]').click();assert.equal(status(),'Saved');assert.equal(t.notices.length,0);
 block(t,'block','');assert.equal(t.notices.length,0);block(t,'block','Waiting');assert.equal(t.notices.at(-1).text,'Task blocked');
 const count=t.notices.length;block(t,'block','Waiting');assert.equal(t.notices.length,count);block(t,'block','Waiting for review');assert.equal(t.notices.at(-1).text,'Block reason updated');
 block(t,'completeBlocked','Ready');assert.equal(t.notices.at(-1).text,'Task unblocked and completed');assert.equal(task.state,'done');assert.equal(t.notices.length,count+2);
});


test('attachment actions announce changes, stay quiet on cancel or no change and report stale permissions', () => {
 const t=taskPage(),task=t.D.tasks.find(x=>x.id==='BIR-079');task.attachments=[{id:'one',name:'one.txt',size:1},{id:'two',name:'two.txt',size:1}];t.A.refresh();
 t.A.setAttachmentTemporary(task.id,'one',true);assert.equal(t.notices.at(-1).text,'Attachment marked temporary');assert(!task.attachments[1].ephemeral);let count=t.notices.length;t.A.setAttachmentTemporary(task.id,'one',true);assert.equal(t.notices.length,count);
 t.A.delAttachment(task.id,0);t.d.querySelector('[data-confirm-cancel]').click();assert.equal(t.notices.length,count);t.A.delAttachment(task.id,0);t.d.querySelector('[data-confirm-accept]').click();assert.equal(t.notices.at(-1).text,'Attachment deleted');
 assert.equal(task.attachments.length,1);t.A.delAttachment(task.id,0);t.D.users.find(u=>u.id==='taylorwu').admin=false;t.D.projects[0].members.find(m=>m.userId==='taylorwu').permissions=[];t.d.querySelector('[data-confirm-accept]').click();assert.equal(t.notices.at(-1).kind,'error');assert.notEqual(task.attachments[0].state,'removed');
});

test('deleting a comment announces once and deleting it again reports an error', () => {
 const t=taskPage(),task=t.D.tasks.find(x=>x.id==='BIR-079');task.comments=[{id:'test-comment',who:'taylorwu',text:'Hello',ts:Date.now(),mentions:[],attachments:[]}];t.A.refresh();t.A.deleteComment(task.id,'test-comment');t.d.querySelector('[data-confirm-accept]').click();assert.equal(t.notices.at(-1).text,'Comment deleted');t.A.deleteComment(task.id,'test-comment');assert.equal(t.notices.at(-1).kind,'error');
});

test('the deadline field saves on blur and rejects invalid text, and task actions follow permissions', () => {
 const t=taskPage(),task=t.D.tasks.find(x=>x.id==='BIR-079'),input=t.d.getElementById('tpDl-input');
 input.value='2026-09-01';t.A.dateBlur(event(input),'tpDl');assert.equal(task.deadline,'2026-09-01');assert(!t.d.querySelector('.date-display'));assert.equal(input.value,'2026-09-01');
 input.value='bad';t.A.dateBlur(event(input),'tpDl');assert.equal(task.deadline,'2026-09-01');assert.equal(input.getAttribute('aria-invalid'),'true');
 input.value='';t.A.dateBlur(event(input),'tpDl');assert.equal(task.deadline,null);assert.equal(input.value,'');
 const actions=t.d.querySelector('.task-actions-button');t.A.taskActions({currentTarget:actions},task.id);assert(t.d.querySelector('.menu').textContent.includes('Delete task'));t.A.menuAction(0);assert(t.d.querySelector('.modal').textContent.includes('Delete task?'));assert(t.D.tasks.includes(task));t.A.closeOverlays();
 t.D.users.find(u=>u.id==='taylorwu').admin=false;t.D.projects[0].members.find(m=>m.userId==='taylorwu').permissions=[];t.A.refresh();assert(!t.d.querySelector('.task-actions-button'));t.A.taskActions({currentTarget:actions},task.id);assert(!t.d.querySelector('.menu'));
});

test('new tasks and Pool promotions save their deadline and assignees and validate both', () => {
 const t=taskPage(),existing=t.D.tasks.find(x=>x.id==='BIR-079'),created=existing.created;
 assert(!t.d.querySelector('[data-date-key="tpStart"]'));assert.match(t.d.querySelector('.task-created-at').firstChild.textContent,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);assert.equal(t.A.updTask(existing.id,'created',created+1),false);assert.equal(existing.created,created);assert.equal(t.A.updTask(existing.id,'start','2026-01-01'),false);
 const fill=(deadline,assignee)=>{const form=t.d.querySelector('.modal form');form.querySelector('[name="epicId"]').value='e4';const input=form.querySelector('.date-text');input.value=deadline;const button=form.querySelector('[data-filter-key="mTaskAssignees"]');t.A.popMulti({currentTarget:button,preventDefault(){}},'mTaskAssignees');t.d.querySelector(`[data-v="${assignee}"]`).click();t.d.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return form;};
 t.A.openModal('task');let form=fill('2026-10-15','robin');form.querySelector('[name="title"]').value='Assigned at creation';const count=t.D.tasks.length;t.A.saveTask(event(form));assert.equal(t.D.tasks.length,count+1);const task=t.D.tasks.at(-1);assert.equal(task.deadline,'2026-10-15');assert.deepEqual([...task.assignees],['robin']);assert(Number.isFinite(task.created));assert(t.D.notifications.some(n=>n.taskId===task.id&&n.recipientId==='robin'&&n.reason==='assigned'));
 t.A.openModal('task');form=fill('2026-99-99','robin');form.querySelector('[name="title"]').value='Invalid';t.A.saveTask(event(form));assert.equal(t.D.tasks.length,count+1);assert(t.d.querySelector('.date-error'));form.querySelector('.date-text').value='';t.D.users.find(u=>u.id==='robin').active=false;t.A.saveTask(event(form));assert.equal(t.D.tasks.length,count+1);assert(t.d.querySelector('.modal').textContent.includes('no longer available'));t.D.users.find(u=>u.id==='robin').active=true;t.A.closeOverlays();
 t.A.openModal('pool');const item=t.D.pool.find(x=>x.id==='pl1'),title=item.title,desc=item.desc;t.A.promotePool(item.id);form=fill('2026-11-01','taylorwu');assert.equal(form.querySelector('[name="title"]').value,title);assert.equal(form.querySelector('[name="desc"]').value,desc);t.A.saveTask(event(form));const promoted=t.D.tasks.at(-1);assert.equal(promoted.deadline,'2026-11-01');assert.deepEqual([...promoted.assignees],['taylorwu']);assert.equal(promoted.desc,desc);assert(!t.D.pool.includes(item));
});

test('new epics require an explicit track', () => {
 const t=taskPage(),count=t.D.epics.length;t.A.openModal('epic');let form=t.d.querySelector('.modal form');assert.equal(form.querySelector('[name="trackId"]').value,'');assert(form.textContent.includes('Choose a track'));form.querySelector('[name="title"]').value='Explicit track';t.A.saveEpic(event(form),'');assert.equal(t.D.epics.length,count);assert(form.textContent.includes('Choose a track.'));form.querySelector('[name="trackId"]').value='t1';t.A.saveEpic(event(form),'');assert.equal(t.D.epics.length,count+1);const epic=t.D.epics.at(-1);t.A.openModal('epic',epic.id);assert.equal(t.d.querySelector('[name="trackId"]').value,'t1');
});

test('comment readers reset every height before measuring any of them', () => {
  const { w, d } = bootApp({ route: 'task/BIR-079', media: () => false });
  const task = w.DATA.tasks.find(item => item.id === 'BIR-079');
  task.comments = Array.from({ length: 150 }, (_, i) => ({ id: `perf-${i}`, who: w.DATA.session.userId, ts: Date.now() + i, text: 'Long comment '.repeat(50), mentions: [] }));
  let reads = 0;
  Object.defineProperty(w.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
    if (this.matches('.comment-body-content')) { reads++; const bodies = [...d.querySelectorAll('.comment-body-content')]; assert.ok(bodies.every(body => body.style.height === '0px'), 'all height resets precede the first measurement'); return 500; }
    return 0;
  } });
  w.App.refresh(); assert.ok(reads > 0);
});

test('epic, milestone and task descriptions share bounded readers and editors that keep their scroll position', () => {
 const t=boot('roadmap',{prepare:D=>{D.epics[0].desc='<script>unsafe</script>\n'+('A long epic description.\n'.repeat(50));D.milestones[0].desc='A milestone goal.\n'.repeat(25);}});
 t.A.openPeek(t.D.epics[0].id);let reader=t.d.querySelector('.description-content');assert(reader.textContent.includes('<script>unsafe</script>'));assert(!reader.querySelector('script'));Object.defineProperty(reader,'scrollHeight',{value:1600});t.w.innerHeight=1000;t.A.sizeDescription();assert.equal(reader.style.height,'240px');assert(t.d.querySelector('.peek-description').classList.contains('is-collapsed'));
 t.A.toggleDescription(t.d.querySelector('.peek-description .description-toggle'));assert.equal(reader.style.height,'800px');assert.equal(reader.style.overflowY,'auto');assert(!t.d.querySelector('.peek-description').classList.contains('is-collapsed'));reader.scrollTop=130;t.A.sizeDescription();assert.equal(reader.scrollTop,130);
 for(const [kind,id] of [['epic',t.D.epics[0].id],['milestone',t.D.milestones[0].id],['task',null]]){t.A.closeOverlays();t.A.openModal(kind,id);const input=t.d.querySelector('[data-description-editor]');assert(input);assert(t.d.querySelector('.modal .optional-mark'));assert(!t.d.querySelector('.modal .description-toggle'));Object.defineProperty(input,'scrollHeight',{value:1600});t.A.sizeDescriptionEditors();assert.equal(input.style.height,'320px');assert.equal(input.style.overflowY,'auto');input.scrollTop=180;t.A.sizeDescriptionEditors();assert.equal(input.scrollTop,180);t.w.innerHeight=500;t.A.sizeDescriptionEditors();assert.equal(input.style.height,'200px');t.w.innerHeight=1000;}
 t.A.closeOverlays();t.A.openTask('BIR-079');const input=t.d.querySelector('#task-description');Object.defineProperty(input,'scrollHeight',{value:1600});t.A.sizeDescription();assert.equal(input.style.height,'240px');t.A.expandDescription();assert.equal(input.style.height,'800px');t.A.toggleDescription();assert.equal(input.style.height,'240px');
});

test('closing the task dialog discards its unsent input without a stored draft', () => {
const {w,d,A}=boot();A.openModal('task');const form=d.querySelector('.modal form');form.querySelector('[name="title"]').value='Recover me';form.querySelector('[name="title"]').dispatchEvent(new w.Event('input',{bubbles:true}));A.closeOverlays();A.openModal('task');assert.equal(d.querySelector('.modal [name="title"]').value,'');assert.equal(w.localStorage.getItem('oneloop.drafts.v1'),null);
});

test('opaque task IDs resolve to the task page', () => {
const opaque=boot('task/opaque-example',{prepare:D=>D.tasks[0].internalId='opaque-example'});assert(opaque.d.querySelector('.topbar').textContent.includes('BIR-064'));
});

test('the activity feed loads older records in batches', () => {
const x=boot('task/BIR-079');const task=x.D.tasks.find(t=>t.id==='BIR-079');task.activity=Array.from({length:120},(_,i)=>({who:'taylorwu',text:'Event '+i,ts:Date.now()-i*1000}));x.A.openTask(task.id);assert.equal(x.d.querySelectorAll('.timeline .tl-act').length,50);x.A.loadOlderActivity(task.id);assert.equal(x.d.querySelectorAll('.timeline .tl-act').length,100);
});

/** The task page wired to the production bridge, with commands answered by the test. */
function productionTaskPage() {
  const t = bootApp({ route: 'task/BIR-079', media: () => true });
  const task = t.D.tasks.find(x => x.id === 'BIR-079');
  Object.assign(task, { internalId: 'bir-079', projectId: 'p1', revision: 1, deadline: null });
  const requests = [];
  const gateway = { execute: (operation, payload, options) => new Promise((resolve, reject) => requests.push({ operation, payload, options, resolve, reject })) };
  const reads = { task: async () => { Object.assign(task, { revision: 2, title: 'Their title', deadline: '2026-11-30' }); t.A.refresh(); return { stale: false, task }; }, counts: async () => ({}), cancel() {} };
  const bridge = installViewBridge({ app: t.A, data: t.D, api: {}, reads, gateway, auth: {}, recovery: t.w.Recovery, reloadBootstrap: async () => ({}) });
  t.w.OneloopRuntime = bridge;
  return { ...t, task, requests, bridge };
}

test('a title conflict keeps newer typing elsewhere and shows the title as typed beside the latest one', async () => {
  const t = productionTaskPage(), title = t.d.querySelector('.tp-title');
  // Inline handlers do not run in this harness, so blur calls the handler itself.
  title.focus(); title.value = 'My title'; title.blur(); t.A.updTask(t.task.id, 'title', title.value);
  const description = t.d.getElementById('task-description');
  description.focus(); description.value = 'Typed after the title save started'; description.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  assert.equal(t.requests.length, 1);
  t.requests[0].reject(new t.w.TestApiError('record changed; latest revision is 2', { status: 409, code: 'revision_conflict' }));
  await waitFor(() => t.d.querySelector('[data-recovery-conflict]'), 'the conflict prompt appears');
  assert.equal(t.d.getElementById('task-description').value, 'Typed after the title save started');
  assert.equal(t.d.querySelector('.tp-title').value, 'My title');
  assert.equal(t.d.getElementById('tpDl-input').value, '2026-11-30', 'other fields show the latest saved values');
  assert.match(t.d.querySelector('[data-recovery-conflict]').textContent, /Latest saved value: Their title/);
});

test('an unsaved description stays on the page through refreshes and offers Save', async () => {
  const t = productionTaskPage();
  t.w.Recovery.observeResponse({ ok: false, error: new t.w.TestApiError('Unable to reach oneloop', { code: 'network_error' }), requestContext: t.w.Recovery.requestContext() });
  const description = t.d.getElementById('task-description');
  description.focus(); description.value = 'Written offline'; description.blur(); t.A.updTask(t.task.id, 'desc', description.value);
  await settle();
  t.d.querySelector('.tp-title').focus(); t.A.refresh();
  assert.equal(t.d.getElementById('task-description').value, 'Written offline');
  const note = t.d.querySelector('.task-description [data-draft-note]');
  assert.match(note.textContent, /Not saved/); assert(note.querySelector('button'));
  assert.equal(t.requests.length, 0);
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
  const t = productionTaskPage();
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
  assert.deepEqual(t.requests.map(request => [request.operation, request.payload.description, request.options.expectedRevision]), [['task.update', 'Typed while access changed', 1]]);
});
