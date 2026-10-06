// views/app.js: the Inbox page and its notification states.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../../support/dom.cjs');
const { installCollaborationController } = require('../../../src/features/collaboration/controller.js');
const { createLegacyData, hydrateLegacyData } = require('../../../src/data/projection-store.js');

test('Inbox renders its actor, time and read state through reads and full or scoped bootstraps',async()=>{
 const notice={id:'n1',eventType:'task.assigned',actorUserId:'robin',projectId:'p1',taskId:'task-1',taskKey:'BIR-079',taskTitle:'Review',destinationAvailable:true,createdAt:1700000000,readAt:null,archivedAt:null};
 const bootstrap={session:{userId:'taylorwu'},users:[{id:'taylorwu',displayName:'Taylor',isAdmin:true,isActive:true},{id:'robin',displayName:'Robin',isActive:true}],projects:[{id:'p1',name:'Project',taskPrefix:'BIR',revision:1}],notifications:[notice],inboxUnreadCount:1};
 const listeners=[];let controller;
 const t=bootApp({route:'inbox',prepare(D,w){
  const session=D.session;Object.assign(D,createLegacyData(),{session});
  hydrateLegacyData(D,bootstrap);
  const transport={data:D,api:{inbox:async()=>({items:[notice],nextCursor:null,unreadCount:1,filteredCount:1})},commands:{},subscribe(listener){listeners.push(listener);return()=>{};}};
  w.OneloopTransport=transport;controller=installCollaborationController({transport,eventSourceFactory:()=>({addEventListener(){},close(){}})});w.OneloopCollaboration=controller;
 }});
 const rendered=(time,read)=>{
  const row=t.d.querySelector('[data-notification-id="n1"]');assert(row);
  assert.equal(row.querySelector('.inbox-event strong').textContent,'Robin');
  assert.equal(row.querySelector('time').getAttribute('datetime'),time);
  assert.equal(row.classList.contains('read'),read);
  assert.equal(row.querySelector('.inbox-task-title').textContent,'Review');
 };
 try{
  await settle();rendered('2023-11-14T22:13:20.000Z',false);
  for(const projection of [{...bootstrap,notifications:[{...notice,createdAt:1700000002,readAt:1700000001}]},{...bootstrap,view:'metadata'},{...bootstrap,view:'metadata'}]){
   hydrateLegacyData(t.D,projection);for(const listener of listeners)listener({type:'bootstrap',projection});t.A.refresh();
   rendered('2023-11-14T22:13:22.000Z',true);
  }
 }finally{controller.dispose();}
});

const sampleScripts = ['theme', 'data', 'motion', 'vendor/js-sha256/sha256', 'activity', 'recovery', 'uploads', 'collaboration', 'app'];
/** The sample Inbox projection, optionally with stored collaboration state. */
const sampleInbox = (stored, options = {}) => bootApp({ route: 'inbox', fixture: 'inbox', html: '<html data-view-samples><head><meta name="theme-color"></head><body><div id="app"></div></body></html>', scripts: sampleScripts, stored: stored ? { 'oneloop.collaboration.v1': stored } : {}, ...options });

const layout = w => { w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 500, width: 300, height: 500 }); };
/** Boot with a fixed layout; `prepare` runs just before collaboration.js, to replace its transport. */
const boot = (route = 'inbox', prepare) => bootApp({ route, media: () => true, setup: layout, beforeScript: (name, w) => { if (name === 'collaboration') prepare?.(w); } });

test('the sample Inbox groups notifications and filters unread rows in place', () => {
  const t = sampleInbox(null, { actions: true });
  assert.equal(t.w.DATA.notifications.length, 9); assert.equal(t.d.querySelectorAll('.inbox-row').length, 7); assert.equal(t.d.querySelectorAll('.inbox-row.unread').length, 4);
  assert(t.d.querySelector('.inbox-task-title').textContent.includes('reminder')); assert(t.d.querySelectorAll('.inbox-group-heading').length >= 2);
  const page = t.d.querySelector('.inbox-page'), list = t.d.querySelector('.inbox-list'), controls = t.d.querySelector('.inbox-controls'), kept = t.d.querySelector('[data-notification-id="inbox-sample-v1-0"]');
  t.w.App.inboxFilter('unread', true);
  assert.equal(t.d.querySelector('.inbox-page'), page); assert.equal(t.d.querySelector('.inbox-list'), list); assert.equal(t.d.querySelector('.inbox-controls'), controls); assert.equal(t.d.querySelector('[data-notification-id="inbox-sample-v1-0"]'), kept); assert.equal(list.querySelectorAll('.inbox-row').length, 4);
  t.w.App.inboxFilter('unread', false);
  // Click the button, so its rewritten action runs, not just the method.
  const unread = t.d.querySelector('.inbox-unread-filter');
  for (let i = 0; i < 4; i++) { unread.click(); assert.equal(unread.getAttribute('aria-pressed'), String(i % 2 === 0)); assert.equal(list.querySelectorAll('[data-notification-id]').length, i % 2 === 0 ? 4 : 7); }
  assert(t.d.querySelector('.inbox-row-footer .inbox-time')); assert(t.d.querySelector('.inbox-row-footer .inbox-row-actions').textContent.includes('Mark read')); assert(t.d.querySelector('.inbox-row-footer .inbox-row-actions').textContent.includes('Archive'));
});

test('the Inbox project filter keeps notifications for removed tasks in their project', () => {
  const t = sampleInbox();
  const list = t.d.querySelector('.inbox-list'), selector = t.d.querySelector('[data-filter-key="inboxProjects"]');
  t.w.DATA.notifications.push({ id: 'multi-project-fixture', recipientId: 'taylorwu', actorId: 'robin', projectId: 'p2', taskId: 'ONE-removed', reason: 'assigned', createdAt: Date.now(), readAt: null, archivedAt: null });
  t.w.App.popMulti({ preventDefault() {}, currentTarget: selector }, 'inboxProjects');
  const pick = id => t.d.querySelector('.pop-opt[data-v="' + id + '"]').click();
  pick('p2'); assert.equal(t.d.querySelector('[data-filter-key="inboxProjects"]'), selector); assert(selector.textContent.includes('oneloop')); assert.equal(list.querySelectorAll('[data-notification-id]').length, 1); assert(t.d.querySelector('.pop'));
  pick('p1'); assert(selector.textContent.includes('2 projects')); assert.equal(list.querySelectorAll('[data-notification-id]').length, 8); assert.equal(t.d.querySelectorAll('.pop-opt[aria-pressed="true"]').length, 2); assert.equal(t.d.querySelector('.sidebar .project-name').textContent, 'Birch Grove');
  pick('p2'); assert(selector.textContent.includes('Birch Grove')); assert.equal(list.querySelectorAll('[data-notification-id]').length, 7);
  t.d.querySelector('.pop-foot button').click(); assert(selector.textContent.includes('All projects')); assert.equal(list.querySelectorAll('[data-notification-id]').length, 8); assert.equal(t.d.querySelectorAll('.pop-opt[aria-pressed="true"]').length, 0); assert(t.d.querySelector('.pop'));
  t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(t.d.activeElement, selector);
});

test('Inbox read and archive state persists, and bulk archive leaves archived rows alone', () => {
  const first = sampleInbox();
  first.w.App.setNotificationRead('inbox-sample-v1-0', false); first.w.App.archiveNotification('inbox-sample-v1-0');
  const t = sampleInbox(first.w.localStorage.getItem('oneloop.collaboration.v1'));
  assert.equal(t.w.DATA.notifications.length, 9); assert(t.w.DATA.notifications.find(n => n.id === 'inbox-sample-v1-0').archivedAt); assert.equal(t.d.querySelectorAll('.inbox-row').length, 6);
  t.w.App.inboxFilter('archived', true); assert.equal(t.d.querySelectorAll('.inbox-row').length, 3); assert(!t.d.querySelector('.inbox-bulk').textContent.includes('Restore'));
  const archivedBefore = t.w.DATA.notifications.filter(n => n.archivedAt).length;
  t.w.App.inboxBulk('archive'); assert.equal(t.w.DATA.notifications.filter(n => n.archivedAt).length, archivedBefore);
  t.w.App.archiveNotification('inbox-sample-v1-0'); assert.equal(t.w.DATA.notifications.filter(n => n.archivedAt).length, archivedBefore - 1);
  t.w.App.inboxFilter('projects', ['p2']); assert(t.d.querySelector('.inbox-empty')); assert(t.d.querySelector('.inbox-bulk button').disabled);
});

test('opening a notification scrolls only the task page and targets its comment', () => {
  const t = sampleInbox();
  const jumpScrollers = [];
  t.w.HTMLElement.prototype.scrollTo = function () { jumpScrollers.push(this); };
  t.w.HTMLElement.prototype.scrollIntoView = function () { throw new Error('Task jumps must not scroll ancestor containers'); };
  t.w.App.openNotification('inbox-sample-v1-1');
  assert(jumpScrollers.length > 0); assert(jumpScrollers.every(el => el.classList.contains('task-page'))); assert.equal(t.w.location.hash, '#/task/BIR-064'); assert(t.d.querySelector('[data-comment="inbox-sample-v1-1-comment"]'));
});

test('Storage shows the capacity meter, instance totals and a row per project', () => {
  const t = sampleInbox();
  t.w.App.nav('storage');
  assert(t.d.querySelector('.storage-capacity')); assert.equal(Number(t.d.querySelector('[role=meter]').getAttribute('aria-valuenow')), t.w.Uploads.usage());
  assert(t.d.querySelector('.storage-capacity').textContent.includes('10 GiB')); assert(t.d.querySelector('.storage-cleanup button').disabled); assert.equal(t.d.querySelectorAll('.storage-project-row').length, t.w.DATA.projects.length);
});

test('Inbox actions keep focus on the acted-on row or bulk control', () => {
  const t=boot('inbox');
  t.D.notifications.push({id:'test-notice',eventId:'test-event',recipientId:'taylorwu',actorId:'robin',projectId:'p1',taskId:'BIR-079',reason:'assigned',createdAt:Date.now(),readAt:null,archivedAt:null});t.A.refresh();
  const row=t.d.querySelector('[data-notification-id]');assert(row);
  const open=row.querySelector('.inbox-open');open.focus();t.A.setNotificationRead(row.dataset.notificationId,false);
  assert.equal(t.d.activeElement.closest('[data-notification-id]')?.dataset.notificationId,row.dataset.notificationId);
  assert(t.d.activeElement.classList.contains('inbox-open'));
  const bulk=[...t.d.querySelectorAll('.inbox-bulk button')].find(button=>!button.disabled);assert(bulk);bulk.focus();t.A.inboxBulk('read');
  assert.notEqual(t.d.activeElement,t.d.body);
});

test('the Inbox page shows load states and updates in place without losing focus', () => {
  const fixtureNow=Date.now();
  const t=boot('inbox',w=>{w.Date.now=()=>fixtureNow;w.OneloopTransport={};w.OneloopCollaboration={bind(_app,_hooks,facade){w.testFacade=facade;return {mount(){}};}};});
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

test('large Inbox appends retain rows/focus without clones or row layout; reconciliation changes only affected rows', () => {
  // Noon in the fixture's Asia/Tashkent zone keeps all 1,050 notices, one a second, on one day.
  const fixtureNow=Date.UTC(2026,0,15,7);
  const t=boot('inbox',w=>{w.Date.now=()=>fixtureNow;w.OneloopTransport={};w.OneloopCollaboration={bind(_app,_hooks,facade){w.testFacade=facade;return {mount(){}};}};});
  const notice=(index)=>({id:'scale-'+index,actorId:'robin',projectId:'p1',taskId:'BIR-079',reason:'assigned',createdAt:fixtureNow-index*1000,readAt:null,archivedAt:null,destinationAvailable:true});
  t.D.notifications=Array.from({length:1000},(_,index)=>notice(index));
  t.w.testFacade.inboxPage({loaded:true,loading:false,nextCursor:'more',filteredCount:1050,unreadCount:1050});
  const first=t.d.querySelector('[data-notification-id]'),open=first.querySelector('.inbox-open');
  open.focus();let clones=0,rects=0;
  const clone=t.w.Element.prototype.cloneNode,rect=t.w.Element.prototype.getBoundingClientRect;
  t.w.Element.prototype.cloneNode=function(...args){clones++;return clone.apply(this,args);};
  t.w.Element.prototype.getBoundingClientRect=function(){if(this.matches('.inbox-row'))rects++;return rect.call(this);};
  const more=t.d.querySelector('.inbox-load-more');t.w.testFacade.inboxBusy(true);assert.equal(more.disabled,true);
  const items=Array.from({length:50},(_,index)=>notice(index+1000));t.D.notifications.push(...items);
  t.w.testFacade.inboxPage({loaded:true,loading:false,append:true,items,nextCursor:'last',filteredCount:1050,unreadCount:1050});
  assert.equal(t.d.querySelectorAll('.inbox-row').length,1050);assert.equal(t.d.querySelectorAll('.inbox-group-heading').length,1);
  assert.equal(t.d.querySelector('[data-notification-id]'),first);assert.equal(t.d.activeElement,open);
  assert.equal(clones,0);assert.equal(rects,0);assert.equal(more.disabled,false);
  const unchanged=t.d.querySelectorAll('.inbox-row')[500],unchangedOpen=unchanged.querySelector('.inbox-open');
  t.D.notifications[0].readAt=fixtureNow;t.w.testFacade.inboxPage({loaded:true,loading:false,nextCursor:'last',filteredCount:1050,unreadCount:1049});
  assert.equal(t.d.querySelectorAll('.inbox-row')[500],unchanged);assert.equal(unchanged.querySelector('.inbox-open'),unchangedOpen);
  assert.ok(first.classList.contains('read'));assert.equal(rects,0);assert.ok(clones<10,'no per-row clones on a single-row state update');
});
