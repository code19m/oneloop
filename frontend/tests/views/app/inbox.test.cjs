// views/app.js: the Inbox page and its notification states.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle, waitFor } = require('../../support/dom.cjs');
const { hydrateLegacyData } = require('../../../src/data/projection-store.js');

test('Inbox rows keep the actor, time and read state of their read through later bootstraps', async () => {
 const t = boot();
 t.answer('inbox', inboxPage([notice('n1', { createdAt: 1700000000 }), notice('n2', { createdAt: 1700000001, readAt: 1700000002 })])); await settle();
 const rows = () => [...t.d.querySelectorAll('[data-notification-id]')].map(row => [row.dataset.notificationId, row.querySelector('.inbox-event strong').textContent, row.querySelector('time').getAttribute('datetime'), row.classList.contains('read')]);
 const expected = [['n2', 'Robin Vale', '2023-11-14T22:13:21.000Z', true], ['n1', 'Robin Vale', '2023-11-14T22:13:20.000Z', false]];
 assert.deepEqual(rows(), expected);
 // Every bootstrap names its page; none of them carries Inbox rows.
 for (const view of ['metadata', 'board']) {
  const projection = { view, session: { userId: 'taylorwu' }, users: [{ id: 'taylorwu', displayName: 'Taylor', isAdmin: true, isActive: true }, { id: 'robin', displayName: 'Robin Vale', isActive: true }], projects: [{ id: 'p1', name: 'Birch Grove', taskPrefix: 'BIR', revision: 1 }], inboxUnreadCount: 1 };
  hydrateLegacyData(t.D, projection); t.runtime.publish({ type: 'bootstrap', projection }); t.A.refresh();
  assert.deepEqual(rows(), expected);
 }
});

const layout = w => { w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 500, width: 300, height: 500 }); };
/** Boot with a fixed layout; `prepare` runs just before collaboration.js, to replace the collaboration controller. */
const boot = (route = 'inbox', prepare, options) => bootApp({ route, media: () => true, setup: layout, beforeScript: (name, w) => { if (name === 'collaboration') prepare?.(w); }, ...options });

const seconds = milliseconds => Math.floor(milliseconds / 1000);
/** A notification as the server lists it. */
const notice = (id, overrides = {}) => ({ id, eventType: 'task.assigned', actorUserId: 'robin', actorName: 'Robin Vale', projectId: 'p1', projectName: 'Birch Grove', taskId: 'bir-064', taskKey: 'BIR-064', taskTitle: 'Recurring reading reminder dates', destinationAvailable: true, createdAt: seconds(Date.now()), readAt: null, archivedAt: null, ...overrides });
/** One Inbox page as the server answers it. */
const inboxPage = (items, unreadCount = items.filter(item => !item.readAt).length) => ({ items, nextCursor: null, unreadCount, filteredCount: items.length });
/** The filter of the Inbox read the page sent last. */
const lastFilter = t => { const { projectIds, unreadOnly, archived } = t.calls.filter(call => call.method === 'inbox').at(-1).args[0]; return { projectIds: [...projectIds], unreadOnly, archived }; };

test('the Inbox groups notifications by day and filters unread rows in place', async () => {
  const t = bootApp({ route: 'inbox', actions: true });
  const rows = [notice('n1'), notice('n2', { readAt: seconds(Date.now()) }), notice('n3', { createdAt: seconds(Date.now() - 3 * 864e5) })];
  t.answer('inbox', inboxPage(rows)); await settle();
  assert.equal(t.d.querySelectorAll('.inbox-row').length, 3); assert.equal(t.d.querySelectorAll('.inbox-row.unread').length, 2);
  assert(t.d.querySelector('.inbox-task-title').textContent.includes('reminder')); assert(t.d.querySelectorAll('.inbox-group-heading').length >= 2);
  const page = t.d.querySelector('.inbox-page'), list = t.d.querySelector('.inbox-list'), controls = t.d.querySelector('.inbox-controls');
  t.A.inboxFilter('unread', true);
  assert.deepEqual(lastFilter(t), { projectIds: [], unreadOnly: true, archived: false });
  t.answer('inbox', inboxPage([rows[0], rows[2]])); await settle();
  assert.equal(t.d.querySelector('.inbox-page'), page); assert.equal(t.d.querySelector('.inbox-list'), list); assert.equal(t.d.querySelector('.inbox-controls'), controls); assert.equal(list.querySelectorAll('.inbox-row').length, 2);
  // Click the button, so its rewritten action runs, not just the method.
  const unread = t.d.querySelector('.inbox-unread-filter');
  for (const pressed of [false, true]) { unread.click(); assert.equal(lastFilter(t).unreadOnly, pressed); t.answer('inbox', inboxPage(rows)); await settle(); assert.equal(unread.getAttribute('aria-pressed'), String(pressed)); }
  assert(t.d.querySelector('.inbox-row-footer .inbox-time')); assert(t.d.querySelector('.inbox-row-footer .inbox-row-actions').textContent.includes('Mark read')); assert(t.d.querySelector('.inbox-row-footer .inbox-row-actions').textContent.includes('Archive'));
});

test('the Inbox project filter asks for the chosen projects and keeps its picker open', async () => {
  const t = bootApp({ route: 'inbox' });
  t.answer('inbox', inboxPage([notice('n1')])); await settle();
  const selector = t.d.querySelector('[data-filter-key="inboxProjects"]');
  t.w.App.popMulti({ preventDefault() {}, currentTarget: selector }, 'inboxProjects');
  const pick = id => t.d.querySelector('.pop-opt[data-v="' + id + '"]').click();
  pick('p2'); assert.equal(t.d.querySelector('[data-filter-key="inboxProjects"]'), selector); assert(selector.textContent.includes('oneloop')); assert.deepEqual(lastFilter(t).projectIds, ['p2']); assert(t.d.querySelector('.pop'));
  pick('p1'); assert(selector.textContent.includes('2 projects')); assert.deepEqual(lastFilter(t).projectIds, ['p2', 'p1']); assert.equal(t.d.querySelectorAll('.pop-opt[aria-pressed="true"]').length, 2); assert.equal(t.d.querySelector('.sidebar .project-name').textContent, 'Birch Grove');
  pick('p2'); assert(selector.textContent.includes('Birch Grove')); assert.deepEqual(lastFilter(t).projectIds, ['p1']);
  t.d.querySelector('.pop-foot button').click(); assert(selector.textContent.includes('All projects')); assert.deepEqual(lastFilter(t).projectIds, []); assert.equal(t.d.querySelectorAll('.pop-opt[aria-pressed="true"]').length, 0); assert(t.d.querySelector('.pop'));
  t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(t.d.activeElement, selector);
});

test('opening a notification scrolls only the task page and targets its comment', async () => {
  const t = bootApp({ route: 'inbox' });
  t.answer('inbox', inboxPage([notice('n1', { eventType: 'discussion.mention', commentId: 'bir-064-comment-1' })])); await settle();
  const jumpScrollers = [];
  t.w.HTMLElement.prototype.scrollTo = function () { jumpScrollers.push(this); };
  t.w.HTMLElement.prototype.scrollIntoView = function () { throw new Error('Task jumps must not scroll ancestor containers'); };
  t.w.App.openNotification('n1');
  assert.deepEqual([t.commands[0].operation, t.commands[0].payload], ['inbox.markRead', { notificationId: 'n1' }]);
  t.commands[0].resolve({ entities: [], events: [] }); await settle();
  assert.equal(t.w.location.hash, '#/task/BIR-064'); assert(t.d.querySelector('[data-comment="bir-064-comment-1"]'));
  assert(jumpScrollers.length > 0); assert(jumpScrollers.every(el => el.classList.contains('task-page')));
});

test('Storage shows the capacity meter, instance totals and a row per project', async () => {
  const projects = [{ projectId: 'p1', projectName: 'Birch Grove', fileCount: 2, bytes: 2048 }, { projectId: 'p2', projectName: 'oneloop', fileCount: 1, bytes: 1024 }];
  const t = bootApp({ route: 'storage', api: { storageUsage: async () => ({ budgetBytes: 10 * 1024 ** 3, highWatermarkBytes: 8 * 1024 ** 3, lowWatermarkBytes: 7 * 1024 ** 3, usedBytes: 3072, permanentBytes: 3072, temporaryBytes: 0, cleanedRecords: 0, reservedBytes: 0, projects, recentCleanup: [] }) } });
  await settle();
  assert(t.d.querySelector('.storage-capacity')); assert.equal(Number(t.d.querySelector('[role=meter]').getAttribute('aria-valuenow')), 3072);
  assert(t.d.querySelector('.storage-capacity').textContent.includes('10 GiB')); assert(t.d.querySelector('.storage-cleanup button').disabled); assert.equal(t.d.querySelectorAll('.storage-project-row').length, projects.length);
});

test('Inbox actions keep focus on the acted-on row or bulk control', async () => {
  const t = boot('inbox');
  t.answer('inbox', inboxPage([notice('n1')])); await settle();
  const row = t.d.querySelector('[data-notification-id]'), open = row.querySelector('.inbox-open'); open.focus();
  t.A.setNotificationRead('n1', false); t.commands[0].resolve({ entities: [], events: [] });
  // A change reads the Inbox again a moment later and draws it in place.
  await waitFor(() => t.calls.some(call => call.method === 'inbox' && !call.settled), 'the Inbox is read again');
  t.answer('inbox', inboxPage([notice('n1', { readAt: seconds(Date.now()) })], 0)); await settle();
  assert(t.d.querySelector('[data-notification-id="n1"]').classList.contains('read'));
  assert.equal(t.d.activeElement.closest('[data-notification-id]')?.dataset.notificationId, 'n1'); assert(t.d.activeElement.classList.contains('inbox-open'));
  const bulk = [...t.d.querySelectorAll('.inbox-bulk button')].find(button => !button.disabled); assert(bulk); bulk.focus(); t.A.inboxBulk('archive');
  assert.notEqual(t.d.activeElement, t.d.body);
});

test('the Inbox page shows load states and updates in place without losing focus', () => {
  const fixtureNow=Date.now();
  const t=boot('inbox',w=>{w.Date.now=()=>fixtureNow;w.OneloopCollaboration={bind(_app,_hooks,facade){w.testFacade=facade;return {mount(){}};}};});
  assert(t.d.querySelector('.inbox-empty')?.textContent.includes('Loading notifications'));
  t.w.testFacade.inboxPage({loaded:false,loading:false,error:true,filteredCount:0,unreadCount:0,nextCursor:null});assert(t.d.querySelector('.inbox-empty')?.textContent.includes('Could not load notifications'));
  const loaded={loaded:true,loading:false,error:false,filteredCount:0,unreadCount:0,nextCursor:null};t.w.testFacade.inboxPage(loaded);
  const empty=t.d.querySelector('.inbox-empty');assert(empty);t.w.testFacade.inboxPage(loaded);assert.equal(t.d.querySelector('.inbox-empty'),empty);
  t.D.notifications.push({id:'n1',actorId:'robin',actorName:'Robin',projectId:'p1',projectName:'Birch Grove',taskId:'BIR-079',taskTitle:'Review',taskKey:'BIR-079',reason:'assigned',destinationAvailable:true,createdAt:Date.now(),readAt:null,archivedAt:null});
  t.w.testFacade.inboxPage({...loaded,filteredCount:1,unreadCount:1});const open=t.d.querySelector('.inbox-open'),bulk=t.d.querySelector('.inbox-bulk button');
  for(const node of [open,bulk])for(const name of ['data-action','data-args'])node.removeAttribute(name);
  t.w.testFacade.inboxPage({...loaded,filteredCount:1,unreadCount:1});assert.equal(t.d.querySelector('.inbox-open'),open,'open control');assert.equal(t.d.querySelector('.inbox-bulk button'),bulk,'bulk control');
  open.focus();t.D.notifications[0].readAt=Date.now();
  t.w.testFacade.inboxPage({...loaded,filteredCount:1,unreadCount:0});assert.equal(t.d.activeElement,t.d.querySelector('.inbox-open'));
});

test('Inbox appends retain rows/focus without clones or row layout; reconciliation changes only affected rows', () => {
  // Noon in the fixture's Asia/Tashkent zone keeps all notices, one a second, on one day. 25 rows are
  // enough: cloning or measuring each row would break the counts below as it would with 1,000.
  const fixtureNow=Date.UTC(2026,0,15,7);
  const t=boot('inbox',w=>{w.Date.now=()=>fixtureNow;w.OneloopCollaboration={bind(_app,_hooks,facade){w.testFacade=facade;return {mount(){}};}};});
  const notice=(index)=>({id:'scale-'+index,actorId:'robin',projectId:'p1',taskId:'BIR-079',reason:'assigned',createdAt:fixtureNow-index*1000,readAt:null,archivedAt:null,destinationAvailable:true});
  t.D.notifications=Array.from({length:20},(_,index)=>notice(index));
  t.w.testFacade.inboxPage({loaded:true,loading:false,nextCursor:'more',filteredCount:25,unreadCount:25});
  const first=t.d.querySelector('[data-notification-id]'),open=first.querySelector('.inbox-open');
  open.focus();let clones=0,rects=0;
  const clone=t.w.Element.prototype.cloneNode,rect=t.w.Element.prototype.getBoundingClientRect;
  t.w.Element.prototype.cloneNode=function(...args){clones++;return clone.apply(this,args);};
  t.w.Element.prototype.getBoundingClientRect=function(){if(this.matches('.inbox-row'))rects++;return rect.call(this);};
  const more=t.d.querySelector('.inbox-load-more');t.w.testFacade.inboxBusy(true);assert.equal(more.disabled,true);
  const items=Array.from({length:5},(_,index)=>notice(index+20));t.D.notifications.push(...items);
  t.w.testFacade.inboxPage({loaded:true,loading:false,append:true,items,nextCursor:'last',filteredCount:25,unreadCount:25});
  assert.equal(t.d.querySelectorAll('.inbox-row').length,25);assert.equal(t.d.querySelectorAll('.inbox-group-heading').length,1);
  assert.equal(t.d.querySelector('[data-notification-id]'),first);assert.equal(t.d.activeElement,open);
  assert.equal(clones,0);assert.equal(rects,0);assert.equal(more.disabled,false);
  const unchanged=t.d.querySelectorAll('.inbox-row')[12],unchangedOpen=unchanged.querySelector('.inbox-open');
  t.D.notifications[0].readAt=fixtureNow;t.w.testFacade.inboxPage({loaded:true,loading:false,nextCursor:'last',filteredCount:25,unreadCount:24});
  assert.equal(t.d.querySelectorAll('.inbox-row')[12],unchanged);assert.equal(unchanged.querySelector('.inbox-open'),unchangedOpen);
  assert.ok(first.classList.contains('read'));assert.equal(rects,0);assert.ok(clones<10,'no per-row clones on a single-row state update');
});
