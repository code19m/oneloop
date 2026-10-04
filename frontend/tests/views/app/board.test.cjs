// views/app.js: the Board, its filters, pagination, moves and the Pool dialog.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('../../support/dom.cjs');
const { createReadController } = require('../../../src/data/read-controller.js');

test('live Board moves keep loaded cards in position and ID order across columns',async()=>{
 const t=boot(),projectId=t.A.context().projectId;
 t.D.tasks.splice(0);t.D.projectTaskCounts={};
 const task=(id,position,status='planning')=>({id,taskKey:`BIR-${id}`,projectId,epicId:t.D.epics[0].id,title:id,status,position,revision:1,assigneeIds:[]});
 const empty={items:[],total:0,nextCursor:null},counts={planning:4,inProgress:4,inReview:0,done:0,blocked:0};
 let changed;
 const reads=createReadController({data:t.D,onBoard:()=>t.A.refreshBoard(),api:{
  boardView:async()=>({planning:{items:[task('a',10),task('b',20),task('c',30)],total:4,nextCursor:'planning-next'},inProgress:{items:[task('d',10,'in_progress'),task('e',30,'in_progress')],total:4,nextCursor:'progress-next'},inReview:empty,done:empty,counts}),
  task:async()=>changed,counts:async()=>counts,
 }});
 await reads.board(projectId);
 const cards=state=>[...t.d.querySelectorAll(`[data-col="${state}"] .card`)].map(card=>card.dataset.task);
 changed={...task('c',5),revision:2};await reads.patchBoard(projectId,{},[{entityId:'c'}]);
 assert.deepEqual(cards('planning'),['BIR-c','BIR-a','BIR-b']);
 changed={...task('a',20,'in_progress'),revision:2};await reads.patchBoard(projectId,{},[{entityId:'a'}]);
 assert.deepEqual(cards('progress'),['BIR-d','BIR-a','BIR-e']);assert.deepEqual(cards('planning'),['BIR-c','BIR-b']);
 changed={...task('d',30,'in_progress'),revision:2};await reads.patchBoard(projectId,{},[{entityId:'d'}]);
 assert.deepEqual(cards('progress'),['BIR-a','BIR-d','BIR-e']);
 changed=task('z',30,'in_progress');await reads.patchBoard(projectId,{},[{entityId:'z'}]);
 assert.deepEqual(cards('progress'),['BIR-a','BIR-d','BIR-e'],'a tied position beyond the loaded ID boundary stays unloaded');
 assert.equal(t.D.boardPageInfo.pages.planning.nextCursor,'planning-next');assert.equal(t.D.boardPageInfo.pages.progress.nextCursor,'progress-next');
});

test('Board search renders matching titles and keys with surrounding whitespace',()=>{
 const t=boot(),task=t.D.tasks.find(item=>item.id==='BIR-079');
 for(const query of [task.title,task.id])for(const padded of [query,` ${query}`,`${query} `,` \t${query} \n`]){
  t.A.setBoardQ(padded);
  assert.deepEqual([...t.d.querySelectorAll('.board .card')].map(card=>card.dataset.task),['BIR-079'],padded);
 }
});

test('live Pool content patches visible titles, descriptions and labels without losing an active draft',()=>{
 const t=boot();t.A.openModal('pool');
 const rows=[...t.d.querySelectorAll('[data-pool-item]')].slice(0,2);assert.equal(rows.length,2);
 const editing=rows[1],item=t.D.pool.find(item=>item.id===editing.dataset.poolItem);
 t.A.editPoolDescription({currentTarget:editing.querySelector('.pool-note-toggle'),stopPropagation(){}},item.id);
 const input=editing.querySelector('textarea');input.value='My unsent description';input.focus();input.setSelectionRange(2,6);
 for(const row of rows){const current=t.D.pool.find(item=>item.id===row.dataset.poolItem);current.title='Remote title';current.desc='Remote description';current.revision=2;}
 t.A.refreshPool();
 for(const row of rows){assert.equal(row.querySelector('.pool-promote').textContent,'Remote title');assert.equal(row.querySelector('.pool-description-preview').textContent,'Remote description');assert.equal(row.querySelector('.pool-delete').getAttribute('aria-label'),'Delete Remote title');}
 assert.equal(editing.querySelector('textarea'),input);assert.equal(input.value,'My unsent description');assert.equal(t.d.activeElement,input);assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,6);
 assert.equal(editing.querySelector('.pool-note-toggle').getAttribute('aria-expanded'),'true');
 t.A.cancelPoolDescription(item.id);assert.equal(editing.querySelector('.pool-description-preview').textContent,'Remote description');
});

/** Boot the views; `prepare(D, w)` edits the projection before they load. */
const boot = (route = 'board', { readOnly = false, stored, prepare } = {}) => bootApp({ route, stored, prepare: (D, w) => {
  prepare?.(D, w);
  if (readOnly) D.users.find(u => u.id === D.session.userId).admin = false;
} });

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
/** Boot with a runtime whose commands stay pending until the test settles them. */
function withRuntime(route = 'board') {
  const calls = [], reports = [], requests = [];
  const t = bootApp({ route, beforeScript: (name, w) => {
    if (name === 'app') w.OneloopRuntime = { invoke(action, payload) { calls.push([action, payload]); const request = deferred(); requests.push(request); return request.promise; }, report(error) { reports.push(error); } };
  } });
  return { ...t, calls, reports, requests };
}
const transfer = (type, id) => ({ types: [type], getData(value) { return value === type ? id : ''; }, setData() {}, effectAllowed: '', dropEffect: '' });

/** Boot the Board with recorded animations, a fixed layout and a resolved runtime. */
function recordingBoard(reduced) {
  const animations = [];
  const t = bootApp({
    html: '<meta name="theme-color"><style>.card,.empty-note,.board-load-more,.board{opacity:1}</style><div id="app"></div>',
    media: query => reduced && query.includes('reduced-motion'),
    setup: w => {
      w.Element.prototype.animate = function () { animations.push(this); return { finished: Promise.resolve(), cancel() {} }; };
      w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 500, width: 300, height: 500 });
    },
    beforeScript: (name, w) => { if (name === 'app') w.OneloopRuntime = { invoke: () => Promise.resolve({}), report: () => {} }; },
  });
  return { ...t, animations };
}

for (const reduced of [false, true]) {
  test(`an unchanged Board refresh keeps cards, empty states, focus and Load more without motion (${reduced ? 'reduced motion' : 'motion'})`, () => {
    const t = recordingBoard(reduced);
    const projectId = t.A.context().projectId;
    t.D.tasks.forEach(task => task.state = 'planning');
    t.D.boardPageInfo = { projectId, pages: { planning: { total: 100, nextCursor: 'next' } } }; t.A.refresh();
    const board = t.d.querySelector('.board'), card = board.querySelector('.card'), title = card.querySelector('.title'), more = board.querySelector('.board-load-more');
    const empty = [...board.querySelectorAll('.empty-note')]; assert.equal(empty.length, 3);
    // Production removes inline handlers after installing their listeners.
    for (const node of [board, ...board.querySelectorAll('*')]) for (const attr of [...node.attributes]) if (attr.name.startsWith('on')) node.removeAttribute(attr.name);
    title.focus();
    const mutations = new t.w.MutationObserver(() => {}); mutations.observe(board, { subtree: true, childList: true }); t.animations.length = 0;
    for (let i = 0; i < 3; i++) t.A.refreshBoard();
    assert.deepEqual([...board.querySelectorAll('.empty-note')], empty);
    assert.equal(board.querySelector('.card'), card); assert.equal(board.querySelector('.board-load-more'), more);
    assert.equal(t.d.activeElement, title); assert.equal(mutations.takeRecords().length, 0); assert.equal(t.animations.length, 0);
    const task = t.D.tasks.find(item => item.id === card.dataset.task); task.title = 'Updated from another client';
    t.A.refreshBoard(); assert.equal(card.querySelector('.title'), title); assert.equal(title.textContent, task.title); assert.equal(t.d.activeElement, title);
    task.state = 'review'; t.A.refreshBoard(); assert.equal(board.querySelector('[data-col="review"] .card'), card);
    assert.equal(board.querySelector('[data-col="done"] .empty-note'), empty[2]);
    const user = t.D.users.find(item => item.id === t.D.session.userId); user.admin = false;
    t.D.projects.find(project => project.id === projectId).members.find(member => member.userId === user.id).permissions = [];
    t.A.refreshBoard(); assert(!board.querySelector('[data-reorderable]')); assert(!board.querySelector('.card-move'));
    t.D.tasks = []; t.A.refreshBoard(); const page = t.d.querySelector('.board-empty'); assert(page); t.animations.length = 0;
    t.A.refreshBoard(); assert.equal(t.d.querySelector('.board-empty'), page); assert.equal(t.animations.length, 0);
    mutations.disconnect();
  });
}

test('Board text search coalesces typing, respects composition, flushes Enter or clear and cancels on navigation', t => {
  const board = recordingBoard(true), calls = [];
  board.w.OneloopRuntime.invoke = (action, query) => { calls.push({ action, query }); return Promise.resolve({}); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  board.A.setBoardQ('composing', { isComposing: true }); t.mock.timers.tick(220); assert.equal(calls.length, 0);
  for (const text of ['s', 'se', 'see', 'seed']) { board.A.setBoardQ(text, { isComposing: false }); t.mock.timers.tick(40); }
  assert.equal(calls.length, 0); t.mock.timers.tick(200); assert.equal(calls.length, 1); assert.equal(calls[0].query.search, 'seed');
  board.A.setBoardQ('flush', { isComposing: false }); board.A.boardSearchKey({ key: 'Enter', preventDefault() {} }); assert.equal(calls.length, 2);
  t.mock.timers.tick(220); assert.equal(calls.length, 2);
  board.A.setBoardQ('', { isComposing: false }); assert.equal(calls.length, 3);
  board.A.setBoardQ('abandoned', { isComposing: false }); board.A.nav('profile'); t.mock.timers.tick(220); assert.equal(calls.length, 3);
  t.mock.timers.reset();
});

test('a blocked card describes its block reason', () => {
  const { w, d } = bootApp({ media: () => true });
  const task = w.DATA.tasks.find(item => item.state !== 'done');
  task.block = { reason: 'Waiting for books', by: w.DATA.users[0].id, at: Date.now() }; w.App.refreshBoard();
  const card = [...d.querySelectorAll('.card')].find(c => c.dataset.task === task.id), button = card.querySelector('.title');
  assert.match(d.getElementById(button.getAttribute('aria-describedby')).textContent, /Waiting for books/);
});

test('accepting another Board page appends cards and leaves loaded cards and columns untouched', () => {
  const { w, d } = bootApp({ media: () => true });
  const task = w.DATA.tasks.find(item => item.state !== 'done');
  for (let i = 0; i < 120; i++) w.DATA.tasks.push({ ...task, id: 'EXTRA-' + i, title: 'Extra task ' + i, assignees: [] });
  w.App.refreshBoard();
  const column = d.querySelector(`[data-col="${task.state}"]`), oldCards = [...column.querySelectorAll('.card')], otherColumns = [...d.querySelectorAll('.col')].filter(el => el !== column);
  const observers = oldCards.map(card => { const observer = new w.MutationObserver(() => {}); observer.observe(card, { attributes: true, childList: true, subtree: true, characterData: true }); return observer; });
  w.App.acceptMoreBoard(task.state);
  assert.equal(column.querySelectorAll('.card').length, 100);
  assert.deepEqual([...column.querySelectorAll('.card')].slice(0, oldCards.length), oldCards);
  for (const observer of observers) { assert.equal(observer.takeRecords().length, 0); observer.disconnect(); }
  assert(otherColumns.every(item => item.isConnected));
});

test('Board columns page at 50 cards and load more on demand', () => {
 const t=boot('board',{prepare:D=>{
  for(let i=0;i<60;i++)D.tasks.push({id:'BIR-page-'+i,epicId:'e2',state:'planning',title:'Paged task '+i,created:Date.now()});
 }});
 assert.equal(t.d.querySelectorAll('[data-col="planning"] .col-cards > .card').length,50);
 const count=Number(t.d.querySelector('[data-col="planning"] .row1 .mono').textContent);assert(count>50);
 t.A.loadMoreBoard('planning');assert.equal(t.d.querySelectorAll('[data-col="planning"] .col-cards > .card').length,count);
});

test('compact deadlines show the year when it differs and expose the complete date', () => {
 const t=boot('board',{prepare:(D,w)=>{
  const year=new w.Date().getFullYear();
  D.tasks.find(task=>task.id==='BIR-079').deadline=`${year-1}-09-26`;
 }});
 const chip=t.d.querySelector('[data-task="BIR-079"] .dl'),year=new t.w.Date().getFullYear();
 assert(chip.textContent.includes(String(year-1)));assert.equal(chip.title,`Deadline ${year-1}-09-26`);
 t.D.tasks.find(task=>task.id==='BIR-079').deadline=`${year+1}-09-26`;t.A.refreshBoard();
 assert(t.d.querySelector('[data-task="BIR-079"] .dl').textContent.includes(String(year+1)));
});

test('multi-select filters keep keyboard position through toggles and return focus on Escape', () => {
 const t=boot('board'),trigger=t.d.querySelector('[onclick*="fTrack"]');
 t.A.popMulti({preventDefault(){},currentTarget:trigger},'fTrack');
 const key=value=>t.d.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
 key('ArrowDown');const value=t.d.activeElement.dataset.v;assert(value);
 key('Enter');assert.equal(t.d.activeElement.dataset.v,value);assert.equal(t.d.activeElement.getAttribute('aria-pressed'),'true');assert(t.d.querySelector('.pop'));
 key(' ');assert.equal(t.d.activeElement.dataset.v,value);assert.equal(t.d.activeElement.getAttribute('aria-pressed'),'false');
 key('Escape');assert(!t.d.querySelector('.pop'));assert.equal(t.d.activeElement,trigger);
});

test('Pool does not keep unsent entries across tabs or reopening', () => {
 const t=boot();t.A.openModal('pool');t.d.getElementById('poolAdd').value='Unsent My item';t.A.setPoolTab('project');assert.equal(t.d.getElementById('poolAdd').value,'');t.A.setPoolTab('mine');assert.equal(t.d.getElementById('poolAdd').value,'');t.d.getElementById('poolAdd').value='Unsent again';t.A.closeOverlays();t.A.openModal('pool');assert.equal(t.d.getElementById('poolAdd').value,'');
});

test('Pool descriptions are optional, cancel cleanly, move into promotion and respect stale permissions', () => {
 const t=boot('board');t.A.openModal('pool');let input=t.d.getElementById('poolAdd');input.value='Idea with context';t.A.togglePoolDescription();const notes=t.d.getElementById('poolNewDesc');notes.value='First line\n<example> & details';const beforeCount=t.D.pool.length;let prevented=false;const enter=extra=>t.A.poolDescriptionKey({key:'Enter',currentTarget:notes,preventDefault(){prevented=true;},...extra});enter({shiftKey:true});assert(!prevented);enter({isComposing:true});assert.equal(t.D.pool.length,beforeCount);enter({});assert(prevented);assert(!t.d.querySelector('.pool-description-actions').textContent.includes('Enter'));
 const item=t.D.pool.find(p=>p.title==='Idea with context');assert.equal(item.desc,'First line\n<example> & details');assert.equal(input.value,'');assert.equal(t.d.getElementById('poolNewDesc').value,'');assert(!t.d.querySelector('.pool-capture').classList.contains('is-expanded'));
 const row=()=>t.d.querySelector(`[data-pool-item="${item.id}"]`);assert(row().querySelector('.pool-description-preview').textContent.includes('<example>'));assert.equal(row().querySelectorAll('.act>button').length,3);
 t.A.editPoolDescription({currentTarget:row().querySelector('.pool-note-toggle'),stopPropagation(){}},item.id);let form=row().querySelector('form');form.querySelector('textarea').value='Saved context';t.A.poolDescriptionKey({key:'Enter',currentTarget:form.querySelector('textarea'),preventDefault(){}},item.id);assert.equal(item.desc,'Saved context');
 t.A.editPoolDescription({currentTarget:row().querySelector('.pool-note-toggle'),stopPropagation(){}},item.id);row().querySelector('textarea').value='Discard this';t.A.cancelPoolDescription(item.id);assert.equal(item.desc,'Saved context');
 t.A.togglePoolDescription();t.d.getElementById('poolNewDesc').value='Unsent context';t.A.setPoolTab('project');t.A.setPoolTab('mine');assert.equal(t.d.getElementById('poolNewDesc').value,'');assert(!t.d.querySelector('.pool-capture').classList.contains('is-expanded'));
 t.A.promotePool(item.id);assert.equal(t.d.querySelector('.pool-editor [name=desc]').value,'Saved context');t.A.returnToPool();assert(t.D.pool.includes(item));assert.equal(item.desc,'Saved context');
 t.A.promotePool(item.id);form=t.d.querySelector('.pool-editor form');form.querySelector('[name=epicId]').value=t.D.epics.find(e=>e.state!=='done').id;t.A.saveTask({target:form,preventDefault(){}});assert(!t.D.pool.includes(item));assert.equal(t.D.tasks.find(task=>task.title==='Idea with context').desc,'Saved context');
 const locked=boot('board');locked.A.openModal('pool');locked.A.setPoolTab('project');const team=locked.D.pool.find(p=>p.scope==='project');let teamRow=locked.d.querySelector(`[data-pool-item="${team.id}"]`);locked.A.editPoolDescription({currentTarget:teamRow.querySelector('.pool-note-toggle'),stopPropagation(){}},team.id);const teamForm=teamRow.querySelector('form');teamForm.querySelector('textarea').value='Not authorized';locked.D.users.find(u=>u.id==='taylorwu').admin=false;locked.D.projects[0].members.find(m=>m.userId==='taylorwu').permissions=[];locked.A.savePoolDescription({target:teamForm,preventDefault(){}},team.id);assert(!team.desc);locked.A.closeOverlays();locked.A.openModal('pool');locked.A.setPoolTab('project');assert(locked.d.querySelector('.pool-capture').hidden);
});

test('a Board move paints at once, sends one optimistic command and skips a no-op repeat', async () => {
  const t=withRuntime('board'),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block),original=task.state;
  t.A._drag={kind:'task',id:task.id,offsetX:0,offsetY:0};t.A._dropBefore=null;
  t.A.dropTask({preventDefault(){},clientX:0,clientY:0,dataTransfer:transfer('text/task',task.id)},'progress');
  assert.equal(task.state,'progress');assert(t.d.querySelector(`[data-col="progress"] [data-task="${task.id}"]`));
  assert.equal(t.calls.length,1);assert.equal(t.calls[0][0],'task.move');assert.equal(t.calls[0][1].optimistic,true);assert.ok(t.A._boardMovePending);
  t.requests[0].resolve({});await tick();assert.equal(t.A._boardMovePending,false);

  const calls=t.calls.length;t.A._drag={kind:'task',id:task.id};t.A._dropBefore=task.id;
  t.A.dropTask({preventDefault(){},clientX:0,clientY:0,dataTransfer:transfer('text/task',task.id)},'progress');
  assert.equal(t.calls.length,calls);
  assert.notEqual(original,task.state);
});

test('a rejected Board move rolls back its card', async () => {
  const t=withRuntime('board'),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block),original=task.state;
  t.A._drag={kind:'task',id:task.id,offsetX:0,offsetY:0};t.A._dropBefore=null;
  t.A.dropTask({preventDefault(){},clientX:0,clientY:0,dataTransfer:transfer('text/task',task.id)},'review');
  assert.equal(task.state,'review');t.requests[0].reject(Object.assign(new Error('Rejected'),{code:'validation_failed'}));await tick();await tick();
  assert.equal(task.state,original);assert.equal(t.reports.length,1);
});

test('an uncertain Board move keeps its new column', async () => {
  const t=withRuntime('board'),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block);
  t.A._drag={kind:'task',id:task.id,offsetX:0,offsetY:0};t.A._dropBefore=null;
  t.A.dropTask({preventDefault(){},clientX:0,clientY:0,dataTransfer:transfer('text/task',task.id)},'progress');
  t.requests[0].reject(Object.assign(new Error('Unknown outcome'),{uncertain:true}));await tick();await tick();
  assert.equal(task.state,'progress');
});

test('a rejected move after switching projects restores only its own card and counts', async () => {
  const t=withRuntime('board'),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block),original=task.state;
  t.D.projectTaskCounts||={};t.D.projectTaskCounts.p1={planning:5,progress:1,review:1,done:1,blocked:0,open:7};
  t.D.projectTaskCounts.p2={planning:9,progress:8,review:7,done:6,blocked:5,open:24};
  t.A._drag={kind:'task',id:task.id,offsetX:0,offsetY:0};t.A._dropBefore=null;
  t.A.dropTask({preventDefault(){},clientX:0,clientY:0,dataTransfer:transfer('text/task',task.id)},'progress');
  const sentinel={id:'ONE-999',internalId:'p2-sentinel',projectId:'p2',epicId:'p2-epic',title:'Keep me',state:'planning',order:0,revision:1};t.D.tasks.push(sentinel);
  const p2Counts={...t.D.projectTaskCounts.p2};t.A.selectProject('p2');
  t.requests[0].reject(Object.assign(new Error('Rejected'),{code:'validation_failed'}));await tick();await tick();
  assert.equal(t.A.context().projectId,'p2');assert(t.D.tasks.includes(sentinel));assert.deepEqual(t.D.projectTaskCounts.p2,p2Counts);assert.equal(task.state,original);
});

test('a move rejected after the session changed does not roll back the new session', async () => {
  const t=withRuntime('board'),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block);
  t.A._drag={kind:'task',id:task.id,offsetX:0,offsetY:0};t.A._dropBefore=null;
  t.A.dropTask({preventDefault(){},clientX:0,clientY:0,dataTransfer:transfer('text/task',task.id)},'progress');
  t.D.session={...t.D.session,id:'replacement-session'};
  t.requests[0].reject(Object.assign(new Error('Old session rejected'),{code:'validation_failed'}));await tick();await tick();
  assert.equal(task.state,'progress');
});
