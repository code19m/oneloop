// views/app.js: the Board, its filters, pagination, moves and the Pool dialog.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, withRuntime, transfer, settle, tick, deferred } = require('../../support/dom.cjs');
const { createReadController } = require('../../../src/data/read-controller.js');
const { normalizeBoardFilters } = require('../../../src/data/board-filters.js');

test('live Board moves keep loaded cards in position and ID order across columns',async()=>{
 const t=bootApp({route:'board'}),projectId=t.A.context().projectId;
 t.D.tasks.splice(0);t.D.projectTaskCounts={};
 const task=(id,position,status='planning')=>({id,taskKey:`BIR-${id}`,projectId,trackId:t.D.epics[0].trackId,epicId:t.D.epics[0].id,title:id,status,position,revision:1,assigneeIds:[]});
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

test('a Done order chosen in another tab leaves this tab\'s Board taking live changes', async () => {
  const t = bootApp({ route: 'board' }), projectId = t.A.context().projectId;
  t.D.tasks.splice(0); t.D.projectTaskCounts = {};
  // The page's own read controller, which reads the order from this window's storage.
  const { createReadController } = t.module('src/data/read-controller.js');
  const task = (id, position) => ({ id, taskKey: `BIR-${id}`, projectId, trackId: t.D.epics[0].trackId, epicId: t.D.epics[0].id, title: id, status: 'planning', position, revision: 1, assigneeIds: [] });
  const empty = { items: [], total: 0, nextCursor: null };
  let changed;
  const reads = createReadController({ data: t.D, onBoard: () => t.A.refreshBoard(), api: {
    boardView: async () => ({ planning: { items: [task('a', 1024)], total: 1, nextCursor: null }, inProgress: empty, inReview: empty, done: empty, counts: { planning: 1, inProgress: 0, inReview: 0, done: 0, blocked: 0 } }),
    task: async () => changed, counts: async () => ({ planning: 2, inProgress: 0, inReview: 0, done: 0, blocked: 0 }),
  } });
  await reads.board(projectId);
  // Another tab of this browser turns Newest first on, as its toggle saves it.
  t.w.localStorage.setItem('oneloop.doneOrder', 'completed');
  changed = task('b', 0);
  await reads.patchBoard(projectId, {}, [{ entityId: 'b' }]);
  assert.deepEqual([...t.d.querySelectorAll('[data-col="planning"] .card')].map(card => card.dataset.task), ['BIR-b', 'BIR-a']);
});

test('Board search renders matching titles and keys with surrounding whitespace',()=>{
 const t=bootApp({route:'board'}),task=t.D.tasks.find(item=>item.id==='BIR-079');
 for(const query of [task.title,task.id])for(const padded of [query,` ${query}`,`${query} `,` \t${query} \n`]){
  t.A.setBoardQ(padded);
  assert.deepEqual([...t.d.querySelectorAll('.board .card')].map(card=>card.dataset.task),['BIR-079'],padded);
 }
});

test('the Board shows its loading skeleton, not No tasks yet, until its first read lands',()=>{
 const t=bootApp({route:'board',prepare:D=>{D.tasks.splice(0);D.boardPageInfo=null;}});
 assert(t.d.querySelector('.board .loading-board'));assert(!t.d.querySelector('.board .page-empty'));
 t.D.boardPageInfo={projectId:t.A.context().projectId,filters:{},pages:{}};t.A.refreshBoard();
 assert.equal(t.d.querySelector('.board .page-empty h2').textContent,'No tasks yet');assert(!t.d.querySelector('.board .loading-board'));
});

test('after a link to a task, the Board shows its loading skeleton, not that one task, until its first read lands',()=>{
 // The link loads that task and no Board.
 const t=bootApp({route:'task/BIR-079',prepare:D=>{D.tasks.splice(0,Infinity,...D.tasks.filter(task=>task.id==='BIR-079'));D.boardPageInfo=null;}});
 t.A.nav('board');
 assert(t.d.querySelector('.board .loading-board'));assert(!t.d.querySelector('.board .card'));
 t.D.boardPageInfo={projectId:t.A.context().projectId,filters:{},pages:{}};t.A.refreshBoard();
 assert(t.d.querySelector('.board .card[data-task="BIR-079"]'));assert(!t.d.querySelector('.board .loading-board'));
});

test('live Pool content patches visible titles, descriptions and labels without losing an active draft',()=>{
 const t=bootApp({route:'board'});t.A.openModal('pool');
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

/** The Board with its saving runtime functions held until the test settles them. */
const heldBoard = () => withRuntime('board', ['moveTask', 'moveTrack', 'setDoneOrder', 'filterBoard', 'loadMoreBoard']);

/** Boot the Board with recorded animations, a fixed layout and a runtime whose actions succeed at once. */
function recordingBoard(reduced) {
  const animations = [];
  const t = bootApp({
    html: '<meta name="theme-color"><style>.card,.empty-note,.board-load-more,.board{opacity:1}</style><div id="app"></div>',
    media: query => reduced && query.includes('reduced-motion'), layout: true,
    setup: w => { w.Element.prototype.animate = function () { animations.push(this); return { finished: Promise.resolve(), cancel() {} }; }; },
  });
  t.w.OneloopRuntime = { ...t.w.OneloopRuntime, ...Object.fromEntries(['moveTask', 'setDoneOrder', 'filterBoard', 'loadMoreBoard'].map(name => [name, () => Promise.resolve({})])), report: () => {} };
  return { ...t, animations };
}

// With motion on, so no animation proves the refresh changed nothing; reduced motion only turns animation off.
test('an unchanged Board refresh keeps cards, empty states, focus and Load more without motion', () => {
  const t = recordingBoard(false);
  const projectId = t.A.context().projectId;
  t.D.tasks.forEach(task => task.state = 'planning');
  t.D.boardPageInfo = { projectId, pages: { planning: { total: 100, nextCursor: 'next' } } }; t.A.refresh();
  const board = t.d.querySelector('.board'), card = board.querySelector('.card'), title = card.querySelector('.title'), more = board.querySelector('.board-load-more');
  const empty = [...board.querySelectorAll('.empty-note')]; assert.equal(empty.length, 3);
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

test('Board text search coalesces typing, respects composition, flushes Enter or clear and cancels on navigation', t => {
  const board = recordingBoard(true), calls = [];
  board.w.OneloopRuntime = { ...board.w.OneloopRuntime, filterBoard(query) { calls.push({ query }); return Promise.resolve({}); } };
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

test('Clear filters keeps No matching tasks until the Board read lands, then empties the search box and every filter menu', async () => {
  // Board reads wait for the test, which answers as the server does: a search loads only the cards that match.
  const reads = [];
  const t = bootApp({ route: 'board', reads: { board: (_projectId, filters) => { const read = deferred(); reads.push({ filters, read }); return read.promise; } } });
  const all = [...t.D.tasks], trigger = () => t.d.querySelector('[data-action="popMulti"][data-args*=\'"fTrack"\']');
  const answer = async () => {
    for (const { filters, read } of reads.splice(0)) {
      t.D.tasks.splice(0, Infinity, ...(filters.search ? [] : all)); t.D.boardPageInfo = { projectId: t.A.context().projectId, filters: normalizeBoardFilters(filters), pages: {} };
      t.A.refreshBoard(); read.resolve({ stale: false });
    }
    await settle();
  };
  const heading = () => t.d.querySelector('.board .page-empty h2')?.textContent;
  await answer();
  t.A.popMulti({ preventDefault() {}, currentTarget: trigger() }, 'fTrack');
  for (const key of ['ArrowDown', 'Enter', 'Escape']) t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await answer();
  t.A.setBoardQ('no task has this title'); await answer();
  assert.equal(heading(), 'No matching tasks'); assert.doesNotMatch(trigger().textContent, /All tracks/);
  t.A.clearBoardFilters();
  assert.equal(heading(), 'No matching tasks', 'the empty search result stays until the cards arrive');
  await answer();
  assert(t.d.querySelector('.board .card')); assert.match(trigger().textContent, /All tracks/); assert.equal(t.d.querySelector('.board-search').value, '');
});

test('a Board address shows its filters, and values the project no longer has are dropped before the Board is read', async () => {
  // A deleted track, a person who is no longer active, and an epic outside the chosen track.
  const t = bootApp({ route: 'board/p1?search=reader&track=t2,gone&epic=e1&assignee=danaell,none,robin' });
  assert.equal(t.w.location.hash, '#/board/p1?search=reader&track=t2&assignee=none,robin');
  assert.equal(t.w.history.length, 1, 'the address changes in place');
  assert.equal(t.d.querySelector('.board-search').value, 'reader');
  assert.deepEqual([...t.d.querySelectorAll('[data-filter-key] .sel-label')].map(label => label.textContent), ['Web Apps', 'All epics', '2 assignees']);
  await t.bridge.loadCurrentRoute();
  // The page's arrays belong to its window, so they compare as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(t.reads.calls.filter(([name]) => name === 'board').map(([, projectId, filters]) => [projectId, filters]))),
    [['p1', { trackIds: ['t2'], epicIds: [], assigneeIds: ['__unassigned__', 'robin'], search: 'reader', blocked: false }]]);
});

test('No epic in the epic filter shows the tasks without an epic, in the address and in the Board read', async () => {
  const t = bootApp({ route: 'board/p1?epic=none', prepare: D => {
    D.tasks.push({ id: 'BIR-500', internalId: 'loose', projectId: 'p1', trackId: 't2', epicId: null, title: 'Loose task', state: 'planning', assignees: [], created: Date.now(), revision: 1 });
    // The cards loaded are those of a Board read for the filter.
    D.boardPageInfo = { projectId: 'p1', filters: normalizeBoardFilters({ epicIds: ['none'] }), pages: {} };
  } });
  assert.equal(t.w.location.hash, '#/board/p1?epic=none');
  assert.equal(t.d.querySelector('[data-filter-key="fEpic"] .sel-label').textContent, 'No epic');
  assert.deepEqual([...t.d.querySelectorAll('.board .card')].map(card => card.dataset.task), ['BIR-500']);
  await t.bridge.loadCurrentRoute();
  assert.deepEqual(JSON.parse(JSON.stringify(t.reads.calls.filter(([name]) => name === 'board').map(([, , filters]) => filters.epicIds))), [['none']]);
});

test('a filter or search change rewrites the Board address in place, so Back leaves the Board, and Clear filters empties its query', t => {
  const board = bootApp({ route: 'board/p1' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  board.A.setBlockedFilter(board.d.querySelector('.blocked-filter'));
  assert.equal(board.w.location.hash, '#/board/p1?blocked=1');
  const search = board.d.querySelector('.board-search');
  search.focus(); search.value = 'reader'; board.A.setBoardQ('reader', { isComposing: false });
  assert.equal(board.w.location.hash, '#/board/p1?blocked=1', 'the search waits for its pause');
  t.mock.timers.tick(180);
  assert.equal(board.w.location.hash, '#/board/p1?search=reader&blocked=1');
  // A live update draws the page again, and typing goes on in the search box.
  board.A.refreshBackground();
  assert.equal(board.d.activeElement, board.d.querySelector('.board-search')); assert.equal(board.d.activeElement.value, 'reader');
  board.A.clearBoardFilters();
  assert.equal(board.w.location.hash, '#/board/p1');
  assert.equal(board.w.history.length, 1);
  t.mock.timers.reset();
});

test('Back to a Board address with other filters shows the placeholder, not No matching tasks, until their read lands', async () => {
  // The cards on screen were read for the first track only; reads wait for the test.
  const reads = [], cards = () => [...t.d.querySelectorAll('.board .card')].map(card => card.dataset.task);
  const onTrack = (_D, track) => all.filter(task => task.trackId === track);
  let all;
  const t = bootApp({ route: 'board/p1?track=t1', reads: { board: (_projectId, filters) => { const read = deferred(); reads.push({ filters, read }); return read.promise; } }, prepare: D => {
    all = [...D.tasks]; D.tasks.splice(0, Infinity, ...onTrack(D, 't1'));
    D.boardPageInfo = { projectId: 'p1', filters: normalizeBoardFilters({ trackIds: ['t1'] }), pages: {} };
  } });
  assert(cards().length, 'the first track\'s cards show');
  t.w.location.hash = '#/board/p1?track=t2';
  t.w.dispatchEvent(new t.w.HashChangeEvent('hashchange', { newURL: t.w.location.href }));
  assert(t.d.querySelector('.board .loading-board'), 'the placeholder shows');
  assert.equal(t.d.querySelector('.board .page-empty'), null, 'and not No matching tasks');
  const loading = t.bridge.loadCurrentRoute(); await settle();
  const [{ filters, read }] = reads;
  t.D.tasks.splice(0, Infinity, ...onTrack(t.D, 't2')); t.D.boardPageInfo = { projectId: 'p1', filters: normalizeBoardFilters(filters), pages: {} };
  t.A.refreshBoard(); read.resolve({ stale: false }); await loading;
  const second = new Set(onTrack(t.D, 't2').map(task => task.id));
  assert(cards().length && cards().every(id => second.has(id)), 'the second track\'s cards show');
});

test('a Load more page that lands after the search changed draws nothing, and the search\'s read then draws its cards', async () => {
  // Reads wait for the test.
  const pages = [], reads = [];
  const t = bootApp({ route: 'board', reads: {
    moreBoard: () => { const page = deferred(); pages.push(page); return page.promise; },
    board: (_projectId, filters) => { const read = deferred(); reads.push({ filters, read }); return read.promise; },
  } });
  t.A.loadMoreBoard('planning'); await settle();
  // The search changes at once; its read waits for a pause in typing.
  t.A.setBoardQ('reader', { isComposing: false });
  pages[0].resolve({ stale: false, done: true }); await settle();
  assert.doesNotMatch(t.d.getElementById('toast-region').textContent, /could not be completed/);
  t.A.boardSearchKey({ key: 'Enter', isComposing: false, keyCode: 13, preventDefault() {} }); await settle();
  const [{ filters, read }] = reads;
  t.D.boardPageInfo = { projectId: 'p1', filters: normalizeBoardFilters(filters), pages: {} };
  t.A.refreshBoard(); read.resolve({ stale: false }); await settle();
  const titles = [...t.d.querySelectorAll('.board .card .card-title-button')].map(title => title.textContent);
  assert(titles.length && titles.every(title => /reader/i.test(title)), 'the search\'s cards show');
});

test('after Load more, a search typed and erased before its read keeps every loaded card', async () => {
  // Planning holds more than its first page; Load more brings the last page.
  const t = bootApp({ route: 'board', prepare: D => {
    for (let index = 0; index < 60; index++) D.tasks.push({ id: `BIR-${900 + index}`, internalId: `more-${index}`, projectId: 'p1', trackId: 't1', epicId: 'e1', state: 'planning', title: `More work ${index}`, order: 1000 + index, assignees: [], created: Date.now(), revision: 1, comments: [], attachments: [], activity: [] });
    D.boardPageInfo = { projectId: 'p1', filters: {}, pages: { planning: { nextCursor: 'next', total: 0 } } };
  } });
  const planning = () => t.d.querySelectorAll('[data-col="planning"] .card').length, loaded = t.D.tasks.filter(task => task.projectId === 'p1' && task.state === 'planning').length;
  assert.equal(planning(), 50);
  t.D.boardPageInfo.pages.planning.nextCursor = null;
  t.A.loadMoreBoard('planning'); await settle();
  assert.equal(planning(), loaded);
  t.A.setBoardQ('e', { isComposing: false });
  t.A.setBoardQ('', { isComposing: false }); await settle();
  assert.equal(planning(), loaded, 'the cards Load more showed stay');
});

test('a blocked card describes its block reason', () => {
  const { w, d } = bootApp({ media: () => true });
  const task = w.DATA.tasks.find(item => item.state !== 'done');
  task.block = { reason: 'Waiting for books', by: w.DATA.users[0].id, at: Date.now() }; w.App.refreshBoard();
  const card = [...d.querySelectorAll('.card')].find(c => c.dataset.task === task.id), button = card.querySelector('.title');
  assert.match(d.getElementById(button.getAttribute('aria-describedby')).textContent, /Waiting for books/);
});

test('a click on a card opens its task, and one on its Move button opens only the menu', () => {
  const t = bootApp({ actions: true });
  const card = t.d.querySelector('.card[data-task]'), id = card.dataset.task;
  card.querySelector('.card-move').click();
  assert.equal(t.A.context().view, 'board');
  assert(t.d.querySelector('#overlay-root > .menu').textContent.includes('Move to'));
  assert.equal(t.d.activeElement, t.d.querySelector('#overlay-root > .menu button'));
  t.A.closeOverlays();
  card.querySelector('.card-title-button').click();
  assert.deepEqual([t.A.context().view, t.A.context().taskId], ['task', id]);
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

test('compact deadlines show the year when it differs and expose the complete date', () => {
 const t=bootApp({route:'board',prepare:(D,w)=>{
  const year=new w.Date().getFullYear();
  D.tasks.find(task=>task.id==='BIR-079').deadline=`${year-1}-09-26`;
 }});
 const chip=t.d.querySelector('[data-task="BIR-079"] .dl'),year=new t.w.Date().getFullYear();
 assert(chip.textContent.includes(String(year-1)));assert.equal(chip.dataset.tip,`Deadline ${year-1}-09-26`);
 t.D.tasks.find(task=>task.id==='BIR-079').deadline=`${year+1}-09-26`;t.A.refreshBoard();
 assert(t.d.querySelector('[data-task="BIR-079"] .dl').textContent.includes(String(year+1)));
});

test('a card counts its checklist after the created date, green once every item is done', () => {
 const t=bootApp({route:'board',prepare:D=>{Object.assign(D.tasks.find(task=>task.id==='BIR-079'),{checklistDone:2,checklistTotal:5});}});
 const task=t.D.tasks.find(item=>item.id==='BIR-079'),card=()=>t.d.querySelector('[data-task="BIR-079"]'),count=()=>card().querySelector('.card-checklist');
 assert.equal(count().previousElementSibling,card().querySelector('.card-created'));
 assert.equal(count().textContent,'2/5');assert(count().querySelector('svg'));assert(!count().classList.contains('complete'));
 assert.equal(count().dataset.tip,'Checklist: 2 of 5 done');
 assert.match(t.d.getElementById(card().querySelector('.title').getAttribute('aria-describedby')).textContent,/Checklist 2 of 5 done/);
 task.checklistDone=5;t.A.refreshBoard();
 assert.equal(count().textContent,'5/5');assert(count().classList.contains('complete'));
 Object.assign(task,{checklistDone:0,checklistTotal:0});t.A.refreshBoard();
 assert.equal(count(),null);
});

test('multi-select filters keep keyboard position through toggles, name the choice and return focus on Escape', () => {
 const t=bootApp({route:'board'}),trigger=t.d.querySelector('[data-action="popMulti"][data-args*=\'"fTrack"\']');
 assert.match(trigger.textContent,/All tracks/);
 t.A.popMulti({preventDefault(){},currentTarget:trigger},'fTrack');
 const key=value=>t.d.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
 key('ArrowDown');const value=t.d.activeElement.dataset.v;assert(value);
 key('Enter');assert.equal(t.d.activeElement.dataset.v,value);assert.equal(t.d.activeElement.getAttribute('aria-pressed'),'true');assert(t.d.querySelector('.pop'));
 assert.doesNotMatch(trigger.textContent,/All tracks/,'the trigger names the chosen track');
 key(' ');assert.equal(t.d.activeElement.dataset.v,value);assert.equal(t.d.activeElement.getAttribute('aria-pressed'),'false');
 key('Escape');assert(!t.d.querySelector('.pop'));assert.equal(t.d.activeElement,trigger);
});

test('Pool Load more reads the next page once per click, before and after the list repaints', () => {
 const t=bootApp({route:'board',actions:true}),projectId=t.A.context().projectId;
 t.D.poolPageInfo[`${projectId}:mine`]={nextCursor:'next',total:30,loaded:true};
 t.A.openModal('pool');
 const more=()=>t.d.querySelectorAll('.pool-load-more'),reads=()=>t.reads.calls.filter(call=>call[0]==='morePool').length;
 assert.equal(more().length,1);more()[0].click();assert.equal(reads(),1);
 // The fake read repaints the open list in place, which rebuilds the button.
 assert.equal(more().length,1);more()[0].click();assert.equal(reads(),2);
 t.D.poolPageInfo[`${projectId}:mine`].nextCursor=null;t.A.refreshPool();assert.equal(more().length,0);
});

test('Pool does not keep unsent entries across tabs or reopening', () => {
 const t=bootApp({route:'board'});t.A.openModal('pool');t.d.getElementById('poolAdd').value='Unsent My item';t.A.setPoolTab('project');assert.equal(t.d.getElementById('poolAdd').value,'');t.A.setPoolTab('mine');assert.equal(t.d.getElementById('poolAdd').value,'');t.d.getElementById('poolAdd').value='Unsent again';t.A.closeOverlays();t.A.openModal('pool');assert.equal(t.d.getElementById('poolAdd').value,'');
});

test('Pool descriptions are optional, cancel cleanly, move into promotion and respect stale permissions', async () => {
 const t=bootApp({route:'board'}),sent=()=>t.commands.map(command=>[command.operation,command.payload]);t.A.openModal('pool');let input=t.d.getElementById('poolAdd');input.value='Idea with context';t.A.togglePoolDescription();const notes=t.d.getElementById('poolNewDesc');notes.value='First line\n<example> & details';let prevented=false;const enter=extra=>t.A.poolDescriptionKey({key:'Enter',currentTarget:notes,preventDefault(){prevented=true;},...extra});enter({shiftKey:true});assert(!prevented);enter({isComposing:true});assert.deepEqual(sent(),[]);enter({});assert(prevented);assert(!t.d.querySelector('.pool-description-actions').textContent.includes('Enter'));
 assert.deepEqual(sent(),[['pool.create',{projectId:'p1',scope:'personal',title:'Idea with context',description:'First line\n<example> & details'}]]);assert.equal(input.value,'');assert.equal(t.d.getElementById('poolNewDesc').value,'');
 assert(!t.d.querySelector('.pool-capture').classList.contains('is-expanded'),'the description closes for the next item');assert.equal(t.d.activeElement,input);
 t.commands[0].resolve({entities:[{entityType:'poolItem',id:'pl-new',projectId:'p1',scope:'personal',ownerUserId:'taylorwu',title:'Idea with context',description:'First line\n<example> & details',createdAt:Math.floor(Date.now()/1000),revision:1}],events:[]});await settle();
 const item=t.D.pool.find(p=>p.id==='pl-new'),row=()=>t.d.querySelector(`[data-pool-item="${item.id}"]`);assert(row().querySelector('.pool-description-preview').textContent.includes('<example>'));assert.equal(row().querySelectorAll('.act>button').length,3);
 t.A.editPoolDescription({currentTarget:row().querySelector('.pool-note-toggle'),stopPropagation(){}},item.id);let form=row().querySelector('form');form.querySelector('textarea').value='Saved context';t.A.poolDescriptionKey({key:'Enter',currentTarget:form.querySelector('textarea'),preventDefault(){}},item.id);
 assert.deepEqual(sent()[1],['pool.update',{poolItemId:item.id,description:'Saved context'}]);t.commands[1].resolve({entities:[{entityType:'poolItem',id:item.id,description:'Saved context',revision:2}],events:[]});await settle();assert.equal(item.desc,'Saved context');
 t.A.editPoolDescription({currentTarget:row().querySelector('.pool-note-toggle'),stopPropagation(){}},item.id);row().querySelector('textarea').value='Discard this';t.A.cancelPoolDescription(item.id);assert.equal(item.desc,'Saved context');assert.equal(t.commands.length,2);
 t.A.togglePoolDescription();t.d.getElementById('poolNewDesc').value='Unsent context';t.A.setPoolTab('project');t.A.setPoolTab('mine');assert.equal(t.d.getElementById('poolNewDesc').value,'');assert(!t.d.querySelector('.pool-capture').classList.contains('is-expanded'));
 t.A.promotePool(item.id);assert.equal(t.d.querySelector('.pool-editor [name=desc]').value,'Saved context');t.A.returnToPool();assert(t.D.pool.includes(item));assert.equal(item.desc,'Saved context');
 // Text left as the item has it follows the item, so the promotion sends neither title nor description.
 t.A.promotePool(item.id);form=t.d.querySelector('.pool-editor form');form.querySelector('[name=trackId]').value='t1';t.A.saveTask({target:form,preventDefault(){}});
 assert.deepEqual(sent()[2],['pool.promote',{poolItemId:item.id,trackId:'t1',deadline:null,assigneeIds:[]}]);
 const locked=bootApp({route:'board'});locked.D.users.find(u=>u.id==='taylorwu').admin=false;locked.D.projects[0].members.find(m=>m.userId==='taylorwu').permissions=[];locked.A.openModal('pool');locked.A.setPoolTab('project');assert(locked.d.querySelector('.pool-capture').hidden);
});

test('a Pool item turned into a task reads the Board and the Pool once, and the hints of the change read nothing more', async t => {
  // Each tab records its reloads; the bootstrap carries the Board's cards, as a real one does.
  const tab = () => { const reloads = []; return { reloads, ...bootApp({ route: 'board', reads: { adoptBoard: () => true }, reloadBootstrap: async scope => { reloads.push(scope ?? {}); return { stale: false }; } }) }; };
  const acting = tab(), other = tab();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  acting.A.openModal('pool'); acting.A.setPoolTab('project'); acting.reads.calls.length = 0;
  acting.A.promotePool('pl3');
  const form = acting.d.querySelector('.pool-editor form'); form.querySelector('[name=trackId]').value = 't1';
  acting.A.saveTask({ target: form, preventDefault() {} });
  const task = { id: 'promoted', taskKey: 'BIR-200', projectId: 'p1', trackId: 't1', epicId: null, title: 'Branch map overview', description: '', status: 'planning', position: -1024, createdAt: 1, updatedAt: 1, revision: 1, assigneeIds: [], activeBlock: null };
  acting.commands[0].resolve({ entities: [{ entityType: 'task', ...task }, { entityType: 'poolItem', id: 'pl3', projectId: 'p1', deleted: true, revision: 2, promoted: true }], events: [] });
  await settle(); await settle();
  // The hints of the change: the new task and the Pool item it came from.
  for (const { events } of [acting, other]) {
    events.at(-1).emit('hint', { kind: 'activity.changed', projectId: 'p1', taskId: 'promoted', entityType: 'task', entityId: 'promoted', entityRevision: 1 });
    events.at(-1).emit('hint', { kind: 'activity.changed', projectId: 'p1', entityType: 'pool_item', entityId: 'pl3', entityRevision: 2 });
  }
  t.mock.timers.tick(200); await settle();
  assert.deepEqual(acting.reloads, [{}], 'the promotion reloads once, and its own hints read nothing');
  assert.deepEqual(acting.reads.calls, [['pool', 'p1', 'team']], 'the Pool that shows again reads its page');
  assert(acting.d.querySelector('.pool-view:not([hidden])'));
  assert.deepEqual(other.reloads.map(scope => scope.background), [true], 'another tab reads once');
  t.mock.timers.reset();
});

/** Drop task `id` into `column`, above card `before` or at the end, as a finished drag does. */
function dropCard(t, id, column, before = null) {
  Object.assign(t.module('views/app/drag.js').drag, { item: { id, offsetX: 0, offsetY: 0 }, before });
  t.A.dropTask({ preventDefault() {}, clientX: 0, clientY: 0, dataTransfer: transfer('text/task', id) }, column);
}

test('a Board move paints at once, sends one optimistic command and skips a no-op repeat', async () => {
  const t=heldBoard(),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block),original=task.state;
  dropCard(t,task.id,'progress');
  assert.equal(task.state,'progress');assert(t.d.querySelector(`[data-col="progress"] [data-task="${task.id}"]`));
  assert.equal(t.calls.length,1);assert.equal(t.calls[0][0],'moveTask');assert.equal(t.calls[0][1].optimistic,true);assert.ok(t.A.context().movePending);
  t.requests[0].resolve({});await tick();assert.equal(t.A.context().movePending,false);

  const calls=t.calls.length;
  dropCard(t,task.id,'progress',task.id);
  assert.equal(t.calls.length,calls);
  assert.notEqual(original,task.state);
});

test('a newest-first Done takes a finished card on top and offers no reordering', async () => {
  const t=heldBoard(),projectId=t.A.context().projectId;
  t.module('src/data/done-order.js').saveDoneOrder('completed');
  t.D.boardPageInfo={projectId,filters:{doneOrder:'completed'},pages:{}};t.A.refreshBoard();
  const done=()=>[...t.d.querySelectorAll('[data-col="done"] .card')].map(card=>card.dataset.task);
  assert.equal(t.d.querySelector('[data-col="done"] .done-order').getAttribute('aria-pressed'),'true');
  const before=done(),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block);
  dropCard(t,task.id,'done',before.at(-1));
  assert.deepEqual(done(),[task.id,...before]);
  assert.deepEqual(t.calls.map(([action,payload])=>[action,payload.position,payload.beforeTaskId]),[['moveTask',0,undefined]],'the card goes to the top of the manual order too');
  t.requests[0].resolve({});await tick();
  const card=[...t.d.querySelectorAll('[data-col="done"] .card')][1];
  t.A.taskMoveMenu({currentTarget:card.querySelector('.card-move'),stopPropagation(){}},card.dataset.task);
  const labels=[...t.d.querySelectorAll('.menu button')].map(button=>button.textContent);
  assert(labels.includes('Move to Planning'));assert(!labels.includes('Move up')&&!labels.includes('Move down'));
  t.A.closeOverlays();
  dropCard(t,before[0],'done');
  assert.equal(t.calls.length,1,'reordering Done sends nothing');
  assert.equal(t.d.querySelector('[data-col="done"] .done-order').dataset.action,'toggleDoneOrder');
  t.A.toggleDoneOrder();
  assert.equal(JSON.stringify(t.calls.at(-1)),JSON.stringify(['setDoneOrder','manual']));
});

test('the manual Done order keeps the drop position and reordering', () => {
  const t=heldBoard();
  assert.equal(t.d.querySelector('[data-col="done"] .done-order').getAttribute('aria-pressed'),'false');
  const done=[...t.d.querySelectorAll('[data-col="done"] .card')].map(card=>card.dataset.task),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block);
  dropCard(t,task.id,'done',done.at(-1));
  assert.equal(t.calls[0][1].beforeTaskId,t.D.tasks.find((item)=>item.id===done.at(-1)).internalId);
});

test('the Newest first toggle has its name as a tooltip and shows a new choice before the Board reads it', () => {
  const t=heldBoard(),toggle=t.d.querySelector('[data-col="done"] .done-order');
  assert.equal(toggle.getAttribute('aria-label'),'Newest first');assert.equal(toggle.dataset.tip,'Newest first');
  t.A.toggleDoneOrder(toggle);
  assert.equal(JSON.stringify(t.calls.at(-1)),JSON.stringify(['setDoneOrder','completed']));
  assert.equal(toggle.getAttribute('aria-pressed'),'true','the read is still on its way');
});

test('a rejected Board move rolls back its card', async () => {
  const t=heldBoard(),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block),original=task.state;
  dropCard(t,task.id,'review');
  assert.equal(task.state,'review');t.requests[0].reject(Object.assign(new Error('Rejected'),{code:'validation_failed'}));await tick();await tick();
  assert.equal(task.state,original);assert.equal(t.reports.length,1);
});

test('an uncertain Board move keeps its new column', async () => {
  const t=heldBoard(),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block);
  dropCard(t,task.id,'progress');
  t.requests[0].reject(Object.assign(new Error('Unknown outcome'),{uncertain:true}));await tick();await tick();
  assert.equal(task.state,'progress');
});

test('a rejected move after switching projects restores only its own card and counts', async () => {
  const t=heldBoard(),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block),original=task.state;
  t.D.projectTaskCounts||={};t.D.projectTaskCounts.p1={planning:5,progress:1,review:1,done:1,blocked:0,open:7};
  t.D.projectTaskCounts.p2={planning:9,progress:8,review:7,done:6,blocked:5,open:24};
  dropCard(t,task.id,'progress');
  const sentinel={id:'ONE-999',internalId:'p2-sentinel',projectId:'p2',epicId:'p2-epic',title:'Keep me',state:'planning',order:0,revision:1};t.D.tasks.push(sentinel);
  const p2Counts={...t.D.projectTaskCounts.p2};t.A.selectProject('p2');
  t.requests[0].reject(Object.assign(new Error('Rejected'),{code:'validation_failed'}));await tick();await tick();
  assert.equal(t.A.context().projectId,'p2');assert(t.D.tasks.includes(sentinel));assert.deepEqual(t.D.projectTaskCounts.p2,p2Counts);assert.equal(task.state,original);
});

test('a rejected reorder after switching projects restores only its own card', async () => {
  const t=heldBoard(),column=t.D.tasks.filter((item)=>item.projectId==='p1'&&item.state==='planning');
  const [first,second]=column,ids=()=>t.D.tasks.filter((item)=>item.projectId==='p1').map((item)=>item.id),original=ids();
  t.A.moveTaskOrder(first.id,second.id,false);
  assert.deepEqual(t.calls.map(([name,move])=>[name,move.afterTaskId,move.optimistic]),[['moveTask',second.internalId,true]]);
  assert.ok(ids().indexOf(first.id)>ids().indexOf(second.id));
  const sentinel={id:'ONE-999',internalId:'p2-sentinel',projectId:'p2',epicId:'p2-epic',title:'Keep me',state:'planning',order:0,revision:1};t.D.tasks.push(sentinel);
  t.A.selectProject('p2');let refreshed=0;const refreshBoard=t.A.refreshBoard;t.A.refreshBoard=(...args)=>{refreshed++;return refreshBoard(...args);};
  t.requests[0].reject(Object.assign(new Error('Rejected'),{code:'validation_failed'}));await tick();await tick();
  assert.deepEqual(ids(),original);assert(t.D.tasks.includes(sentinel));assert.equal(refreshed,0);assert.equal(t.reports.length,1);
});

test('a move rejected after the session changed does not roll back the new session', async () => {
  const t=heldBoard(),task=t.D.tasks.find((item)=>item.state==='planning'&&!item.block);
  dropCard(t,task.id,'progress');
  t.D.session={...t.D.session,id:'replacement-session'};
  t.requests[0].reject(Object.assign(new Error('Old session rejected'),{code:'validation_failed'}));await tick();await tick();
  assert.equal(task.state,'progress');
});

/** A Board whose Done column has `count` loaded cards, and more on the server when `more` is set. */
function longDone(count, more) {
  const t = heldBoard(), projectId = t.A.context().projectId;
  const template = t.D.tasks.find(item => item.state === 'done' && item.projectId === projectId) || t.D.tasks.find(item => item.state === 'done');
  t.D.tasks = t.D.tasks.filter(item => item.state !== 'done');
  for (let i = 0; i < count; i++) t.D.tasks.push({ ...template, id: `DONE-${100 + i}`, internalId: `done-${i}`, title: `Done ${i}`, block: null, assignees: [] });
  t.D.boardPageInfo = { projectId, filters: {}, pages: { done: { total: count + (more ? 20 : 0), nextCursor: more ? 'more' : null } } };
  t.A.refresh();
  const doneCards = () => [...t.d.querySelectorAll('[data-col="done"] .card')].map(card => card.dataset.task);
  return { ...t, doneCards };
}
const chooseMenuItem = (t, label) => { const button = [...t.d.querySelectorAll('#overlay-root > .menu button')].find(item => item.textContent.trim() === label); t.A.menuAction(JSON.parse(button.dataset.args)[0]); };

test('Move to puts the card at the top of its new column, in view and focused', () => {
  // A long column that doesn't show its end, and one whose 50 cards fill the first page exactly.
  for (const [count, more] of [[60, true], [50, false]]) {
    const t = longDone(count, more), task = t.D.tasks.find(item => item.state === 'planning' && !item.block), shown = t.doneCards();
    assert.equal(shown.length, 50);
    const move = t.d.querySelector(`[data-task="${task.id}"] .card-move`); move.focus();
    t.A.taskMoveMenu({ currentTarget: move, stopPropagation() {} }, task.id); chooseMenuItem(t, 'Move to Done');
    assert.deepEqual(t.calls.map(([action, payload]) => [action, payload.status, payload.position, payload.afterTaskId]), [['moveTask', 'done', 0, undefined]], `${count} cards`);
    assert.deepEqual(t.doneCards(), [task.id, ...shown], `${count} cards: every card Done showed stays, below the moved card`);
    assert.equal(t.d.activeElement.closest('.card')?.dataset.task, task.id); assert(t.d.activeElement.classList.contains('card-move'));
  }
});

test('a card moved to the top of a column stays first when a live change sorts the column again', async () => {
  const t = bootApp({ route: 'board' }), projectId = t.A.context().projectId;
  t.D.tasks.splice(0); t.D.projectTaskCounts = {};
  const task = (id, position, status, title = id) => ({ id, taskKey: `BIR-${id}`, projectId, trackId: t.D.epics[0].trackId, epicId: t.D.epics[0].id, title, status, position, revision: 1, assigneeIds: [] });
  const empty = { items: [], total: 0, nextCursor: null }, counts = { planning: 1, inProgress: 2, inReview: 0, done: 0, blocked: 0 };
  let changed;
  // The column's first card sits above 1024, as after older cards moved on.
  const reads = createReadController({ data: t.D, onBoard: () => t.A.refreshBoard(), api: {
    boardView: async () => ({ planning: { items: [task('a', 1024, 'planning')], total: 1, nextCursor: null }, inProgress: { items: [task('b', 4096, 'in_progress'), task('c', 5120, 'in_progress')], total: 2, nextCursor: null }, inReview: empty, done: empty, counts }),
    task: async () => changed, counts: async () => counts,
  } });
  await reads.board(projectId);
  const cards = () => [...t.d.querySelectorAll('[data-col="progress"] .card')].map(card => card.dataset.task);
  const move = t.d.querySelector('[data-task="BIR-a"] .card-move'); move.focus();
  t.A.taskMoveMenu({ currentTarget: move, stopPropagation() {} }, 'BIR-a'); chooseMenuItem(t, 'Move to In Progress');
  assert.deepEqual(cards(), ['BIR-a', 'BIR-b', 'BIR-c']);
  // The server puts the card a gap above the first one.
  t.commands[0].resolve({ entities: [{ entityType: 'task', ...task('a', 3072, 'in_progress'), revision: 2 }], events: [] }); await settle();
  changed = { ...task('c', 5120, 'in_progress', 'Renamed elsewhere'), revision: 2 };
  await reads.patchBoard(projectId, {}, [{ entityId: 'c' }]);
  assert.deepEqual(cards(), ['BIR-a', 'BIR-b', 'BIR-c']);
});

test('a card dropped below a long column follows its last shown card and stays drawn', () => {
  const t = longDone(60, true), task = t.D.tasks.find(item => item.state === 'planning' && !item.block), shown = t.doneCards();
  dropCard(t,task.id,'done');
  assert.equal(t.calls[0][1].afterTaskId, t.D.tasks.find(item => item.id === shown.at(-1)).internalId);
  assert.deepEqual(t.doneCards(), [...shown, task.id]);
});

test('dragging selected text never drags a card, and outside a card it stays a text drag', () => {
  const t = bootApp({ route: 'board' });
  // Firefox starts the drag of selected text from its text node.
  const drag = node => { const event = new t.w.Event('dragstart', { bubbles: true, cancelable: true }); node.dispatchEvent(event); return event.defaultPrevented; };
  const text = root => { const walker = t.d.createTreeWalker(root, t.w.NodeFilter.SHOW_TEXT); for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue.trim()) return node; };
  assert.equal(drag(text(t.d.querySelector('.board .card[data-task]'))), true, 'a card moves only with the pointer code');
  assert.equal(drag(text(t.d.querySelector('.topbar h1'))), false);
});

test('the click that ends a card drag never opens the card, however late it comes', () => {
  const t = bootApp({ route: 'board', actions: true });
  t.d.elementFromPoint = () => null;
  const card = t.d.querySelector('.board .card[data-task]');
  const pointer = (type, x) => card.dispatchEvent(new t.w.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, pointerType: 'mouse', clientX: x, clientY: 10 }));
  const click = () => card.dispatchEvent(new t.w.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  pointer('pointerdown', 10); pointer('pointermove', 40);
  assert.ok(t.module('views/app/drag.js').drag.item, 'the drag started');
  pointer('pointerup', 40);
  // Firefox clicks only after the drop's redraw, which a busy page can take a second to finish.
  const now = t.w.Date.now; t.w.Date.now = () => now() + 1000;
  click();
  assert.equal(t.w.location.hash, '#/board/p1');
  // The next press forgets the drag, so a plain click opens the card.
  pointer('pointerdown', 10); pointer('pointerup', 10); click();
  assert.equal(t.w.location.hash, `#/task/${card.dataset.task}`);
});
