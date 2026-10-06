// views/app.js: in-place refreshes keep titles, focus, input and loaded feeds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../../support/dom.cjs');
const { installViewBridge } = require('../../../src/app/view-bridge.js');
const { createCommandGateway } = require('../../../src/data/command-gateway.js');
const { ApiError } = require('../../../src/data/api-client.js');

for(const replacement of [null,'modal','drawer'])test(`epic reopening updates its own drawer and preserves a replacement ${replacement||'none'}`,async()=>{
 const t=bootApp({route:'roadmap'}),epic=t.D.epics.find(item=>item.state==='done'&&item.end),previous=globalThis.document;
 globalThis.document=t.d;let release;
 const api={command:()=>new Promise(resolve=>{release=resolve;})};
 const gateway=createCommandGateway({api,data:t.D});
 installViewBridge({app:t.A,data:t.D,api,gateway,reads:{epic:async()=>{}},auth:{},recovery:{},reloadBootstrap:async()=>({})});
 try{
  t.A.openPeek(epic.id);await settle();assert.equal(t.d.querySelector('.peek .chip').textContent,'done');
  t.A.reopenEpic(epic.id);assert(release);
  let input,drawer;
  if(replacement){
   if(replacement==='drawer')t.A.openPeek(t.D.epics.find(item=>item.id!==epic.id).id);
   drawer=t.d.querySelector('.peek');t.A.openModal('task');input=t.d.querySelector('.modal [name="title"]');
   input.value='Next draft';input.focus();input.setSelectionRange(2,5);
  }
  release({entities:[{entityType:'epic',id:epic.id,state:'planning',revision:(epic.revision??1)+1}],events:[]});await settle();
  if(replacement){
   assert.equal(t.d.querySelector('.peek'),drawer);assert.equal(t.d.querySelector('.modal [name="title"]'),input);
   assert.equal(input.value,'Next draft');assert.equal(t.d.activeElement,input);assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,5);
  }else{
   assert.equal(t.d.querySelector('.peek .chip').textContent,'planning');
   assert.equal(t.d.querySelector('.peek-actions button').textContent,'Mark as done');
  }
 }finally{globalThis.document=previous;}
});

test('selecting another project from a task leaves its route and displays the selected Board',async()=>{
 const t=bootApp({route:'task/BIR-079'}),previous=globalThis.location;
 globalThis.location=t.w.location;
 const destination=t.D.projects.find(project=>project.id!==t.A.context().projectId),taskReads=[],boards=[];
 const bridge=installViewBridge({app:t.A,data:t.D,api:{},gateway:{},auth:{},recovery:{},reloadBootstrap:async()=>({}),reads:{cancel(){},task:async id=>{taskReads.push(id);return {};},board:async id=>{boards.push(id);return {};},counts:async()=>{}}});
 try{
  await bridge.invoke('workspace.select',{projectId:destination.id});
  assert.equal(t.w.location.hash,'#/board');assert.equal(t.A.context().view,'board');assert.equal(t.A.context().projectId,destination.id);
  assert.equal(t.d.querySelector('.task-page'),null);assert(t.d.querySelector('.board'));
  assert.deepEqual(boards,[destination.id]);assert.deepEqual(taskReads,[]);
 }finally{globalThis.location=previous;}
});

for(const kind of ['track','epic','milestone','unblock','task','project','user'])test(`a late ${kind} save preserves the replacement modal and all its fields`,async()=>{
 const t=bootApp({route:'roadmap'}),previous=globalThis.FormData;
 globalThis.FormData=t.w.FormData;
 let release,writes=0;
 t.D.epics.forEach(epic=>epic.projectId=t.D.tracks.find(track=>track.id===epic.trackId).projectId);
 const pending=new Promise(resolve=>{release=resolve;});
 installViewBridge({app:t.A,data:t.D,api:{updateUser:()=>{writes++;return pending;}},gateway:{execute:()=>{writes++;return pending;}},reads:{cancel(){},counts:async()=>{},board:async()=>{}},auth:{},recovery:{},reloadBootstrap:async()=>({})});
 try{
  const target=kind==='unblock'?'BIR-079':kind==='user'?'robin':null;
  t.A.openModal(kind,target);
  const form=t.d.querySelector('.modal form');assert(form,kind);
  for(const [name,value] of Object.entries({name:'Saved name',title:'Saved title',start:'2026-10-01',date:'2026-10-02',key:'NEW',trackId:t.D.tracks.find(track=>track.projectId===t.A.context().projectId).id,epicId:t.D.epics.find(epic=>epic.projectId===t.A.context().projectId&&epic.state!=='done').id})){
   const field=form.querySelector(`[name="${name}"]`);if(field)field.value=value;
  }
  const method={track:'saveTrack',epic:'saveEpic',milestone:'saveMilestone',unblock:'saveBlock',task:'saveTask',project:'saveProjectNew',user:'saveUser'}[kind];
  t.A[method]({target:form,preventDefault(){}},target,kind);
  assert.equal(writes,1,'the valid form started a save');
  t.A.closeOverlays();t.A.openModal('task');
  const next=t.d.querySelector('.modal form'),title=next.querySelector('[name="title"]'),desc=next.querySelector('[name="desc"]');
  title.value='Unsent next title';desc.value='Unsent next description';desc.focus();desc.setSelectionRange(2,6);
  release(kind==='user'?{displayName:'Saved name',isActive:true,isAdmin:false,revision:2}:{entities:[],events:[]});await settle();
  assert.equal(t.d.querySelector('.modal form'),next);assert.equal(title.value,'Unsent next title');assert.equal(desc.value,'Unsent next description');
  assert.equal(t.d.activeElement,desc);assert.equal(desc.selectionStart,2);assert.equal(desc.selectionEnd,6);
  if(kind==='track'){
   t.A.closeOverlays();t.A.openModal('track');const current=t.d.querySelector('.modal form');current.querySelector('[name="name"]').value='Another track';
   t.A.saveTrack({target:current,preventDefault(){}});await settle();assert.equal(t.d.querySelector('.modal'),null,'completion still closes its own open form');
  }
 }finally{globalThis.FormData=previous;}
});

for(const [action,mode,opener] of [['Block task','block','.block-task-action'],['Unblock task','unblock','.unblock-action'],['Edit block reason','block','.block-edit-action']])for(const replacement of [false,true])test(`${action} repaints the task page${replacement?' once a dialog opened during the save closes':''}`,async()=>{
 const t=bootApp({route:'task/BIR-079',prepare(D){
  const task=D.tasks.find(item=>item.id==='BIR-079');task.internalId='task-1';
  task.block=action==='Block task'?null:{id:'block-1',reason:'Waiting on vendor',revision:1,by:D.session.userId,at:1700000000000,mentions:[]};
 }});
 const previous={document:globalThis.document,FormData:globalThis.FormData,Collab:globalThis.Collab};
 Object.assign(globalThis,{document:t.d,FormData:t.w.FormData,Collab:t.w.Collab});
 let release;
 const accepted=command=>mode==='unblock'?{entityType:'taskBlock',id:'block-1',taskId:'task-1',resolved:true}:{entityType:'taskBlock',id:action==='Block task'?'block-2':'block-1',taskId:'task-1',reason:command.payload.reason,createdBy:t.D.session.userId,createdAt:1700000100,revision:2,mentions:[]};
 const api={command:command=>new Promise(resolve=>{release=()=>resolve({entities:[accepted(command)],events:[]});})};
 installViewBridge({app:t.A,data:t.D,api,gateway:createCommandGateway({api,data:t.D}),reads:{counts:async()=>({}),cancel(){}},auth:{},recovery:{},reloadBootstrap:async()=>({})});
 try{
  t.d.querySelector(`.task-page ${opener}`).focus();t.A.openModal(mode,'BIR-079');
  const form=t.d.querySelector('.modal form');form.querySelector('[name="reason"]').value=mode==='block'?'Waiting on legal':'';
  t.A.saveBlock({target:form,preventDefault(){}},'BIR-079',mode);assert(release,'the save started');
  let draft;
  if(replacement){t.A.closeOverlays();t.A.openModal('task');draft=t.d.querySelector('.modal [name="title"]');draft.value='Next draft';draft.focus();}
  release();await settle();await settle();
  if(replacement){
   assert.equal(t.d.querySelector('.modal [name="title"]'),draft);assert.equal(draft.value,'Next draft');
   t.A.closeOverlays();
  }
  assert.equal(t.d.querySelector('.modal'),null);
  const block=t.d.querySelector('.task-page .task-block');
  if(mode==='unblock')assert.equal(block,null);else assert.equal(block?.querySelector('p')?.textContent,'Waiting on legal');
 }finally{Object.assign(globalThis,previous);}
});

test('Edit epic shows the saved title in the drawer it was opened from',async()=>{
 const t=bootApp({route:'roadmap'}),previous={document:globalThis.document,FormData:globalThis.FormData};
 Object.assign(globalThis,{document:t.d,FormData:t.w.FormData});
 t.D.epics.forEach(epic=>epic.projectId=t.D.tracks.find(track=>track.id===epic.trackId).projectId);
 const epic=t.D.epics.find(item=>item.projectId===t.A.context().projectId&&item.state!=='done');
 const api={command:async command=>({entities:[{entityType:'epic',id:epic.id,title:command.payload.title,revision:(epic.revision??1)+1}],events:[]})};
 installViewBridge({app:t.A,data:t.D,api,gateway:createCommandGateway({api,data:t.D}),reads:{epic:async()=>{},cancel(){}},auth:{},recovery:{},reloadBootstrap:async()=>({})});
 try{
  t.A.openPeek(epic.id);await settle();t.A.openModal('epic',epic.id);
  const form=t.d.querySelector('.modal form');form.querySelector('[name="title"]').value='Renamed from the drawer';
  t.A.saveEpic({target:form,preventDefault(){}},epic.id);await settle();await settle();
  assert.equal(t.d.querySelector('.modal'),null);
  assert.equal(t.d.querySelector('.peek #peek-title').textContent,'Renamed from the drawer');
 }finally{Object.assign(globalThis,previous);}
});

test('the Edit epic and Edit milestone dialogs send only the fields the person changed',async()=>{
 const t=bootApp({route:'roadmap'}),previous={document:globalThis.document,FormData:globalThis.FormData};
 Object.assign(globalThis,{document:t.d,FormData:t.w.FormData});
 t.D.epics.forEach(epic=>epic.projectId=t.D.tracks.find(track=>track.id===epic.trackId).projectId);
 const epic=t.D.epics.find(item=>item.projectId===t.A.context().projectId&&item.state!=='done'),milestone=t.D.milestones[0];
 const sent=[];
 installViewBridge({app:t.A,data:t.D,api:{},gateway:{execute:async(operation,payload)=>{sent.push([operation,payload]);return {entities:[],events:[]};}},reads:{cancel(){}},auth:{},recovery:{},reloadBootstrap:async()=>({})});
 try{
  t.A.openModal('epic',epic.id);
  let form=t.d.querySelector('.modal form');form.querySelector('[name="title"]').value='Renamed in the dialog';
  t.A.saveEpic({target:form,preventDefault(){}},epic.id);await settle();
  t.A.openModal('milestone',milestone.id);
  form=t.d.querySelector('.modal form');form.querySelector('[name="desc"]').value='A new goal';
  t.A.saveMilestone({target:form,preventDefault(){}},milestone.id);await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)),[['epic.update',{epicId:epic.id,title:'Renamed in the dialog'}],['milestone.update',{milestoneId:milestone.id,description:'A new goal'}]]);
 }finally{Object.assign(globalThis,previous);}
});

test('Keep my changes closes an Unblock dialog that its conflict reload re-rendered',async()=>{
 const t=bootApp({route:'task/BIR-079',prepare(D){
  const task=D.tasks.find(item=>item.id==='BIR-079');Object.assign(task,{internalId:'task-1',revision:1});
  task.block={id:'block-1',reason:'Waiting on vendor',revision:1,by:D.session.userId,at:1700000000000,mentions:[]};
 }});
 const previous={document:globalThis.document,FormData:globalThis.FormData};
 Object.assign(globalThis,{document:t.d,FormData:t.w.FormData});
 // Someone else saved revision 2 after this page loaded revision 1.
 const task=t.D.tasks.find(item=>item.id==='BIR-079'),expected=[];let revision=2;
 const gateway={execute:async(_operation,_payload,options)=>{
  expected.push(options.expectedRevision);
  if(options.expectedRevision!==revision)throw new ApiError('record changed; latest revision is 2',{status:409,code:'revision_conflict'});
  revision=3;Object.assign(task,{block:null,revision});return {entities:[],events:[]};
 }};
 // As in production, the task read repaints the page and its open dialog.
 const reads={task:async()=>{task.revision=revision;t.A.refresh();return {};},counts:async()=>({}),cancel(){}};
 installViewBridge({app:t.A,data:t.D,api:{},gateway,reads,auth:{},recovery:t.w.Recovery,reloadBootstrap:async()=>({})});
 try{
  t.A.openModal('unblock','BIR-079');const form=t.d.querySelector('.modal form');
  t.A.saveBlock({target:form,preventDefault(){}},'BIR-079','unblock');await settle();await settle();
  assert.equal(form.isConnected,false,'the reload re-rendered the dialog');
  const keep=[...t.d.querySelectorAll('.modal [data-recovery-conflict] button')].find(button=>button.textContent==='Keep my changes');
  assert(keep,'the dialog shows the conflict');keep.click();await settle();await settle();
  assert.deepEqual(expected,[1,2]);assert.equal(t.d.querySelector('.modal'),null);
 }finally{Object.assign(globalThis,previous);}
});

test('a completed epic action cannot dismiss a dialog opened above its still-mounted drawer',async()=>{
 const t=bootApp({route:'roadmap',prepare(D){D.tasks=[];}}),previous=globalThis.document;
 globalThis.document=t.d;
 let release;
 installViewBridge({app:t.A,data:t.D,api:{},gateway:{execute:()=>new Promise(resolve=>{release=resolve;})},reads:{epic:async()=>{}},auth:{},recovery:{},reloadBootstrap:async()=>({})});
 try{
  const epic=t.D.epics.find(item=>item.state!=='done');t.A.openPeek(epic.id);const drawer=t.d.querySelector('.peek');
  t.A.closeEpic(epic.id);assert(release);t.A.openModal('task');assert(drawer.isConnected);
  const input=t.d.querySelector('.modal [name="title"]');input.value='Next task draft';input.focus();
  release({entities:[],events:[]});await settle();
  assert.equal(t.d.querySelector('.modal [name="title"]'),input);assert.equal(input.value,'Next task draft');assert.equal(t.d.activeElement,input);
 }finally{globalThis.document=previous;}
});

const layout = w => { w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 500, width: 300, height: 500 }); };
/** Boot with a fixed layout; `prepare` runs just before collaboration.js, to replace its transport. */
const boot = (route = 'task/BIR-079', prepare) => bootApp({ route, media: () => true, setup: layout, beforeScript: (name, w) => { if (name === 'collaboration') prepare?.(w); } });

test('document titles follow the view and the account menu keeps unsaved profile input', () => {
  const t=boot(),task=t.D.tasks.find(task=>task.id==='BIR-079');
  assert.equal(t.d.title,`${task.id} · ${task.title} · oneloop`);
  task.title='Updated task';t.A.updateDocumentTitle();assert.equal(t.d.title,'BIR-079 · Updated task · oneloop');
  t.A.nav('profile');assert.equal(t.d.title,'Profile · oneloop');
  const input=t.d.querySelector('.settings input[name="name"]'),chip=t.d.querySelector('.me-chip');input.value='Unsaved name';chip.focus();t.A.userMenu({currentTarget:chip});
  assert.equal(t.d.querySelector('.menu button'),t.d.activeElement);assert.equal(t.d.querySelector('.settings input[name="name"]'),input);assert.equal(input.value,'Unsaved name');
  t.d.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(t.d.activeElement,chip);assert.equal(t.d.querySelector('.menu'),null);
  t.A.nav('board');assert.equal(t.d.title,'Board · Birch Grove · oneloop');t.D.session=null;t.A.refresh();assert.equal(t.d.title,'oneloop');
});

test('renders keep an unchanged sidebar, so a click that spans one still lands', () => {
  const t=boot('roadmap'),sidebar=t.d.querySelector('.sidebar'),board=sidebar.querySelector('.nav-item[title="Board"]');
  board.focus();t.A.refresh();
  assert.equal(t.d.querySelector('.sidebar'),sidebar,'an unchanged sidebar is kept');
  assert.equal(t.d.activeElement,board,'focus stays on the same control');
  t.A.nav('board');
  assert.notEqual(t.d.querySelector('.sidebar'),sidebar,'a changed sidebar is replaced');
  assert(t.d.querySelector('.sidebar .nav-item[title="Board"]').classList.contains('on'));
});

test('Roadmap refreshes keep focus on the focused epic or milestone', () => {
  const t=boot('roadmap');
  for(const selector of ['[data-epic]','[data-milestone]']){
    const item=t.d.querySelector(selector);assert(item,selector);item.focus();const key=selector==='[data-epic]'?'epic':'milestone',id=item.dataset[key];
    t.A.refreshRoadmap();assert.equal(t.d.activeElement.dataset[key],id);
  }
});

test('the task feed shows load states, refreshes in place and ignores unmounted or stale callbacks', () => {
  const t=boot('task/BIR-079',w=>{w.OneloopTransport={};w.OneloopCollaboration={bind(_app,_hooks,facade){w.testFacade=facade;return {mount(){}};}};}),task=t.D.tasks.find(item=>item.id==='BIR-079');
  assert(t.d.querySelector('.timeline').textContent.includes('Loading activity'));
  t.w.testFacade.taskPage(task.id,{loaded:false,loading:false,error:true,hasMore:false,background:false});assert(t.d.querySelector('.timeline').textContent.includes('Could not load activity'));assert(t.d.querySelector('.timeline button')?.textContent.includes('Retry'));
  t.w.testFacade.taskPage(task.id,{loaded:true,loading:false,error:false,hasMore:false,background:false});assert(t.d.querySelector('.timeline').textContent.includes('No activity yet'));
  task.comments=[{id:'root',who:'robin',ts:1000,text:'First note',mentions:[],parentId:null},{id:'reply',who:'taylorwu',ts:2000,text:'First reply',mentions:[],parentId:'root',replyToId:'root'}];task.activity=[];t.A.refresh();
  let toggle=t.d.querySelector('[data-reply-root="root"]');assert(toggle);toggle.focus();
  t.w.testFacade.taskPage(task.id,{loaded:true,loading:false,error:false,hasMore:false,background:true});
  assert.equal(t.d.activeElement,toggle);assert.equal(t.d.querySelector('[data-reply-root="root"]'),toggle);
  let serializations=0;task.comments.toJSON=()=>{serializations++;return [...task.comments];};
  task.comments[1].text='Changed reply';t.w.testFacade.taskPage(task.id,{loaded:true,loading:false,error:false,hasMore:false,background:true});
  toggle=t.d.querySelector('[data-reply-root="root"]');assert.equal(t.d.activeElement,toggle);assert(t.d.querySelector('[data-comment="reply"]').textContent.includes('Changed reply'));
  assert.equal(serializations,1,'one feed serialization per callback');
  t.A.nav('board');serializations=0;t.w.testFacade.taskPage(task.id,{loaded:true});assert.equal(serializations,0,'unmounted feeds are not serialized');
  t.A.openTask(task.id);assert(t.d.querySelector('[data-comment="reply"]').textContent.includes('Changed reply'));
  const other=t.D.tasks.find(item=>item.id!==task.id);t.A.openTask(other.id);serializations=0;t.w.testFacade.taskPage(task.id,{loaded:true});assert.equal(serializations,0,'stale task callbacks do not replace the mounted snapshot');
});

test('count refreshes keep the focused task description', () => {
  const t=boot(),input=t.d.getElementById('task-description');
  input.value='Keep this unsent task description';input.focus();
  t.D.projectTaskCounts||={};t.D.projectTaskCounts[t.A.context().projectId]={open:99,done:1,blocked:2};
  t.A.refreshCounts();
  assert.equal(t.d.getElementById('task-description'),input);assert.equal(t.d.activeElement,input);
  assert.equal(input.value,'Keep this unsent task description');assert.equal(t.d.querySelector('.sidebar .nav-item[title="Board"] .end').textContent,'99');
});

test('a full refresh keeps an unsaved title with its focus and selection', () => {
  const { w, d } = bootApp({ route: 'task/BIR-079', media: () => true });
  const field = d.querySelector('.tp-title'); field.focus(); field.value = 'Unsaved title during refresh'; field.setSelectionRange(3, 9);
  w.App.refresh();
  assert.equal(d.activeElement, d.querySelector('.tp-title')); assert.equal(d.activeElement.value, field.value); assert.equal(d.activeElement.selectionStart, 3); assert.equal(d.activeElement.selectionEnd, 9);
});

test('the epic drawer chart draws no NaN bars for an ongoing epic without history', () => {
  const { w, d } = bootApp({ route: 'task/BIR-079', media: () => true });
  const ongoing = w.DATA.epics.find(epic => !epic.end); ongoing.weekly = [0, 0, 0, 0]; w.App.openPeek(ongoing.id);
  for (const rect of d.querySelectorAll('.peek svg rect')) { assert.notEqual(rect.getAttribute('height'), 'NaN'); assert.notEqual(rect.getAttribute('y'), 'NaN'); }
});

test('searchable selects expose combobox roles and stay open through a deferred background refresh', async t => {
  const { w, d } = bootApp({ route: 'task/BIR-079', media: () => true });
  const trigger = d.querySelector('#select-tpEpic'); w.App.popSelect({ preventDefault() {}, currentTarget: trigger }, 'tpEpic');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true'); assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox');
  const search = d.querySelector('[role=combobox]'), list = d.querySelector('[role=listbox]');
  assert(search); assert.equal(search.getAttribute('aria-controls'), list.id);
  assert(d.getElementById(search.getAttribute('aria-activedescendant'))); assert(list.querySelector('[aria-selected=true]'));
  // Background renders retry every 100 ms while a picker is open.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  w.App.refreshBackground(); t.mock.timers.tick(350);
  t.mock.timers.reset();
  assert.equal(d.querySelector('[role=combobox]'), search);
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
