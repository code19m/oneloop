// views/app.js: project access, users, settings, profile and storage administration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../../support/dom.cjs');
const { installViewBridge } = require('../../../src/app/view-bridge.js');

test('Settings can page through the directory and add an eligible account from a later page',async()=>{
 const t=bootApp({route:'settings',prepare(D){D.users=D.users.filter(user=>user.id===D.session.userId);D.adminUsers={ids:[],loaded:false,nextCursor:null};}});
 const requests=[],commands=[];
 const api={users:async({afterUsername})=>{
  requests.push(afterUsername);
  return afterUsername?{users:[{id:'last',username:'zulu',displayName:'Zulu',isActive:true,isAdmin:false,revision:1}],nextCursor:null}:{users:Array.from({length:50},(_,i)=>({id:`u${i}`,username:`account${i}`,displayName:`Account ${i}`,isActive:false,isAdmin:false,revision:1})),nextCursor:'account49'};
 }};
 const bridge=installViewBridge({app:t.A,data:t.D,api,reads:{cancel(){}},gateway:{execute:async(operation,payload)=>{commands.push([operation,payload]);return {entities:[],events:[]};}},auth:{},recovery:{},reloadBootstrap:async()=>({})});
 await bridge.loadCurrentRoute();
 const more=[...t.d.querySelectorAll('button')].find(button=>button.textContent==='Load more users');assert(more,'Settings exposes the next account page even if the first has no eligible users');
 assert(!t.d.querySelector('.settings').textContent.includes('No users to add'),'a partial directory is not exhaustive');
 t.A.loadMoreUsers();await settle();
 assert.deepEqual(requests,[undefined,'account49']);
 const trigger=t.d.getElementById('select-addMember');t.A.popSelect({preventDefault(){},currentTarget:trigger},'addMember');
 const search=t.d.querySelector('.pop-search');search.value='Zulu';search.dispatchEvent(new t.w.Event('input',{bubbles:true}));
 t.d.querySelector('.pop-opt').click();await settle();
 assert.deepEqual(commands,[['membership.add',{projectId:t.A.context().projectId,userId:'last',manageRoadmap:false,manageBoard:false}]]);
});

/** Boot the views; `prepare(D, w)` edits the projection before they load. */
const boot = (route = 'board', { readOnly = false, stored, prepare } = {}) => bootApp({ route, stored, prepare: (D, w) => {
  prepare?.(D, w);
  if (readOnly) D.users.find(u => u.id === D.session.userId).admin = false;
} });

/** A projection with a second project the viewer cannot access. */
function withSecretProject(user = 'blairq', route = 'task/BIR-079', prepare = () => {}) {
  return bootApp({ route, media: () => true, scripts: ['theme', 'data', 'motion', 'vendor/js-sha256/sha256', 'activity', 'recovery', 'uploads', 'collaboration', 'app'], prepare: D => {
    D.session.userId = user; const p = D.projects.find(item => item.id === 'p2'); p.name = 'Secret project'; p.members = [];
    D.tracks.push({ id: 'secret-track', projectId: p.id, name: 'Secret track', order: 1 }); D.epics.push({ id: 'secret-epic', trackId: 'secret-track', title: 'Secret epic', state: 'active', start: '2026-01-01', end: '2026-12-01', done: 0, total: 1 });
    D.tasks.push({ id: 'SEC-001', epicId: 'secret-epic', title: 'Secret task', state: 'planning', created: Date.now(), attachments: [{ id: 'secret-file', name: 'private.png', size: 10, previewKind: 'image', url: 'blob:private' }] });
    D.tasks.find(t => t.id === 'BIR-079').attachments = [{ id: 'member-file', name: 'member.png', size: 10, previewKind: 'image', url: 'blob:member' }]; prepare(D);
  } });
}

const layout = w => { w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 500, width: 300, height: 500 }); };
/** Boot with a fixed layout; `prepare` runs just before collaboration.js, to replace its transport. */
const bootWithTransport = (route, prepare) => bootApp({ route, media: () => true, setup: layout, beforeScript: (name, w) => { if (name === 'collaboration') prepare?.(w); } });

test('members see only their projects, files and routes; secret tasks, epics and attachments stay hidden', () => {
 const t=withSecretProject();assert(t.d.querySelector('.tp-title'));t.A.projectMenu({currentTarget:t.d.querySelector('.switcher-btn')});assert(!t.d.querySelector('.menu').textContent.includes('Secret project'));t.A.closeOverlays();
 t.A.previewAttachment('BIR-079','member-file');assert(t.d.querySelector('.file-dialog'));t.d.querySelector('[data-file-close]').click();assert.equal(t.A.setAttachmentTemporary('BIR-079','member-file',true),false);
 let prevented=false;assert.equal(t.A.downloadAttachment({preventDefault(){prevented=true;}},'SEC-001','secret-file'),false);assert(prevented);t.A.previewAttachment('SEC-001','secret-file');assert(!t.d.querySelector('.file-dialog'));t.A.openPeek('secret-epic');assert(!t.d.querySelector('.peek'));
 t.A.openTask('SEC-001');assert(t.d.querySelector('.page-error'));assert(!t.d.querySelector('.tp-title'));assert(!t.d.querySelector('#app').textContent.includes('Secret task'));
});

test('direct routes to a hidden task are denied to members but open for administrators', () => {
 const t=withSecretProject('blairq','task/SEC-001');assert(t.d.querySelector('.page-error'));assert(!t.d.querySelector('.tp-title'));
 const admin=withSecretProject('taylorwu','task/SEC-001');assert.equal(admin.d.querySelector('.tp-title').value,'Secret task');admin.A.previewAttachment('SEC-001','secret-file');assert(admin.d.querySelector('.file-dialog'));
});

test('losing membership closes previews, redacts Inbox rows and leaves account pages usable', () => {
 const t=withSecretProject();t.D.notifications.push({id:'retained',eventId:'old',recipientId:'blairq',actorId:'taylorwu',projectId:'p1',taskId:'BIR-079',reason:'assigned',createdAt:Date.now()});
 t.A.previewAttachment('BIR-079','member-file');t.D.projects[0].members=t.D.projects[0].members.filter(m=>m.userId!=='blairq');t.A.refresh();assert(!t.d.querySelector('.file-dialog'));assert(!t.d.querySelector('.tp-title'));
 t.A.nav('inbox');const page=t.d.querySelector('.inbox-page');assert(page);assert(page.textContent.includes('Task unavailable'));assert(!page.textContent.includes('Birch Grove'));assert(!page.textContent.includes('BIR-079'));assert(!page.textContent.includes('Flexible reading'));
 t.A.openNotification('retained');assert(!t.d.querySelector('.tp-title'));t.A.nav('roadmap');assert(t.d.querySelector('.page-empty').textContent.includes('No projects available'));t.A.openModal('pool');assert(!t.d.querySelector('.modal'));t.A.nav('profile');assert(t.d.querySelector('[name="name"]'));
});

test('ending the session closes open previews and the task page', () => {
 const t=withSecretProject();t.A.previewAttachment('BIR-079','member-file');assert(t.d.querySelector('.file-dialog'));t.D.session=null;t.A.refresh();assert(!t.d.querySelector('.file-dialog'));assert(!t.d.querySelector('.tp-title'));
});

test('unknown routes show a page error and keep their address', () => {
const missing=boot('missing');assert(missing.d.querySelector('.page-error').textContent.includes('Page not found'));assert.equal(missing.w.location.hash,'#/missing');
const bad=boot('task/BAD');assert(bad.d.querySelector('.page-error'));assert.equal(bad.w.location.hash,'#/task/BAD');
});

test('Users is admin-only in navigation and at its direct route', () => {
const {w,d,A}=boot('users',{prepare:D=>{D.users.find(u=>u.id===D.session.userId).admin=false;}});assert(d.querySelector('.page-error').textContent.includes('Access denied'));assert(!d.querySelector('.user-row'));assert.equal(w.location.hash,'#/users');A.userMenu({currentTarget:d.querySelector('.me-chip')});assert(!d.querySelector('.profile-menu').textContent.includes('Users'));
});

test('row actions open the right editor, Pool promotion keeps its title and navigation dismisses stale overlays', () => {
const {w,d,A,D}=boot('roadmap');A.openPeek(D.epics.find(e=>e.title==='Reading summaries').id);assert(d.querySelector('.peek'));A.nav('users');assert(!d.querySelector('.peek'));w.eval(d.querySelector('.user-row').getAttribute('onclick'));assert(d.querySelector('.modal').textContent.includes('Edit user'));A.nav('board');assert(!d.querySelector('.modal'));A.openModal('pool');w.Function('event',d.querySelector('.pool-promote').getAttribute('onclick'))(new w.Event('click'));assert.equal(d.querySelector('.modal input[name="title"]').value,'Date pickers');w.location.hash='#/profile';w.dispatchEvent(new w.HashChangeEvent('hashchange'));assert(!d.querySelector('.modal'));assert.equal(d.querySelector('.topbar h1').textContent,'Profile');
});

test('a reserved task prefix is rejected inline and a new prefix keeps the old one reserved', () => {
const {d,A,D}=boot('settings');const prefix=d.querySelector('[name="key"]');prefix.value='ONE';A.updateProjectField(prefix);assert.equal(D.projects[0].key,'BIR');assert(d.querySelector('.ferr'));prefix.value='NEW';A.updateProjectField(prefix);assert.equal(D.prefixRegistry.BIR,'p1');assert.equal(D.prefixRegistry.NEW,'p1');
});

test('Users pages load 50 at a time and project Settings keep member access separate', () => {
 const t=boot('users',{prepare:D=>{
  for(let i=0;i<110;i++)D.users.push({id:'page-user-'+i,name:'Page user '+i,active:true,admin:false});
 }});
 assert.equal(t.d.querySelectorAll('.user-row').length,50);
 t.A.loadMoreUsers();assert.equal(t.d.querySelectorAll('.user-row').length,100);
 t.A.userMenu({currentTarget:t.d.querySelector('.me-chip')});assert(t.d.querySelector('.profile-menu').textContent.includes('Users'));
 t.A.nav('settings');assert(!t.d.querySelector('.topbar .seg'));assert(t.d.querySelector('.member-access-list'));
});

test('routine membership grants need no confirmation while sensitive actions reuse a thirty-minute confirmation', () => {
const t=boot('settings');
 const member=t.D.projects[0].members.find(member=>member.userId!==t.D.session.userId&&!t.D.users.find(user=>user.id===member.userId)?.admin);
 member.permissions=[];t.A.setMemberPermission(member.userId,'manage_board',true);
 assert(!t.d.querySelector('.reauth-layer'));assert(member.permissions.includes('manage_board'));
 t.D.session.authenticatedAt=Date.now()-20*60e3;t.A.deleteProject();
 assert(!t.d.querySelector('.reauth-layer'));assert(t.d.querySelector('#confirmation-match'));
});

test('Enter in the profile name saves through the blur path', () => {
 const t=boot('profile'),name=t.d.querySelector('input[name=name]');name.onblur=()=>t.A.updMe(name.value);name.focus();name.value='Taylor Updated';let prevented=false;t.w.Function('event',name.getAttribute('onkeydown')).call(name,{key:'Enter',preventDefault(){prevented=true;}});assert(prevented);assert.equal(t.D.users.find(u=>u.id==='taylorwu').name,'Taylor Updated');
});

test('both password forms require five Unicode characters and accept spaces and long passwords', () => {
for(const method of ['setPassword','changePassword']){
 const t=boot('profile');
  const submit=(password)=>{const form=t.d.querySelector('.settings form');form.querySelector('[name="cur"]').value='current';form.querySelector('[name="pw"]').value=password;form.querySelector('[name="pw2"]').value=password;t.A[method]({target:form,preventDefault(){}});};
  for(const password of ['1234','😀😀😀😀']){submit(password);assert(t.d.querySelector('.ferr')?.textContent.includes('at least 5 characters'));}
  for(const password of ['12345','😀😀😀😀😀','     ','x'.repeat(8192)]){submit(password);assert(!t.d.querySelector('.ferr'));}
}
});

test('project Settings bound member rows, update loading state in place and search all members', () => {
  const { w, d } = bootApp({ route: 'settings', media: () => true });
  const project = w.DATA.projects.find(p => p.id === w.App.context().projectId);
  for (let i = 0; i < 205; i++) { const id = 'member-' + i; w.DATA.users.push({ id, name: 'Member ' + i, username: id, active: true, admin: false }); project.members.push({ userId: id, permissions: [] }); }
  w.App.refreshUsers(); assert.equal(d.querySelectorAll('.member-access-row').length, 100);
  const row = d.querySelector('.member-access-row'); w.DATA.adminUsers = { loading: true }; w.App.refreshUsers({ loadingOnly: true });
  assert.equal(d.querySelector('.member-access-row'), row); assert.equal(d.querySelector('.member-access-list').getAttribute('aria-busy'), 'true');
  d.querySelector('[data-more-members]').click(); assert.equal(d.querySelectorAll('.member-access-row').length, 200);
  const search = d.querySelector('[data-member-search]'); search.value = 'member-204'; search.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(d.querySelectorAll('.member-access-row').length, 1); assert.match(d.querySelector('.member-access-row').textContent, /Member 204/);
});

test('Storage failures offer a local Retry and keep loaded usage after a background failure', async () => {
  let fail=true,listener;
  const t=bootWithTransport('storage',w=>{w.OneloopTransport={api:{uploadAttachment(){},storageUsage:async()=>{if(fail)throw Error('Unavailable');return {budgetBytes:1000,usedBytes:125,pendingDeletionBytes:25,highWatermarkBytes:800,lowWatermarkBytes:700,permanentBytes:100,temporaryBytes:0,projects:[],recentCleanup:[],cleanedRecords:0,reservedBytes:0};}},subscribe(fn){listener=fn;return()=>{};}};w.OneloopCollaboration={bind(){return {mount(){}};}};});
  await new Promise(resolve=>setTimeout(resolve,0));assert(t.d.querySelector('.storage-page [role="alert"]')?.textContent.includes('Could not load storage usage'));
  fail=false;await t.A.retryStorageUsage();assert(t.d.querySelector('.storage-amount')?.textContent.includes('125 B'));assert(t.d.querySelector('.storage-breakdown').textContent.includes('Pending deletion'));assert(!t.d.querySelector('.storage-breakdown').textContent.includes('Other usage'));
  fail=true;listener({type:'sse'});await new Promise(resolve=>setTimeout(resolve,0));assert(t.d.querySelector('.storage-amount'));assert(t.d.querySelector('.storage-page [role="alert"]')?.textContent.includes('Could not refresh storage usage'));
});

test('temporary passwords show the account, copy exactly, report clipboard failures and clear on session change', async () => {
  const t=bootWithTransport('users'),user={id:'opaque-account-id',username:'review_member',name:'Review Member',active:true};
  t.D.users.push(user);
  const password='A'.repeat(80)+'-example';
  const messages=[],copies=[];
  t.A.toast=(...args)=>messages.push(args);
  Object.defineProperty(t.w.navigator,'clipboard',{configurable:true,value:{writeText:async value=>copies.push(value)}});
    t.A.showTemporaryPassword(user.id,password);
    assert.equal(t.d.querySelector('.temporary-password-meta strong').textContent,user.username);
    assert(!t.d.querySelector('.modal').textContent.includes(user.id));
    assert.equal(t.d.getElementById('tmpPw').textContent,password);
    assert(!t.d.querySelector('[aria-label="Copy temporary password"]').getAttribute('onclick').includes(password));
    await t.A.copyTemporaryPassword();assert.deepEqual(copies,[password]);assert.deepEqual(messages,[['Copied']]);
    t.w.navigator.clipboard.writeText=async()=>{throw Error('Clipboard denied');};
    await t.A.copyTemporaryPassword();assert.equal(messages.length,2);assert.equal(messages[1][1],'error');assert(messages[1][0].includes('copy it manually'));
    assert.equal(t.d.getElementById('tmpPw').textContent,password);
    let finish;t.w.navigator.clipboard.writeText=()=>new Promise(resolve=>{finish=resolve;});
    const pending=t.A.copyTemporaryPassword();t.A.closeOverlays();finish();await pending;assert.equal(messages.length,2);
    t.A.showTemporaryPassword('missing-account',password);assert.equal(t.d.querySelector('.temporary-password-meta strong').textContent,'Account');
    const session=t.D.session;t.D.session=null;t.A.refresh();t.D.session=session;t.A.refresh();
    assert.equal(t.A.context().modal,null);assert.equal(t.d.getElementById('tmpPw'),null);
    t.A.showTemporaryPassword(user.id,password);t.D.session={...session,id:'replacement-session'};t.A.refresh();
    assert.equal(t.A.context().modal,null);assert.equal(t.d.getElementById('tmpPw'),null);
});
