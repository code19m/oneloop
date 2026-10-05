// views/app.js: keyboard focus across dialogs, drawers, menus and refreshes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('../../support/dom.cjs');

// Every element reports the same box, so geometry-based focus code has a layout.
const layout = w => { w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 500, width: 300, height: 500 }); };
const boot = (route = 'board') => bootApp({ route, media: () => true, setup: layout });
const key = (t, name, shiftKey = false) => t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }));

test('the task dialog labels its fields, traps focus and returns it to its trigger', () => {
  const t=boot();
  const trigger=t.d.querySelector('.topbar button[onclick="App.openModal(\'task\')"]');
  assert(trigger);trigger.focus();t.A.openModal('task');
  let modal=t.d.querySelector('.modal');assert.equal(modal.getAttribute('role'),'dialog');assert.equal(modal.getAttribute('aria-modal'),'true');
  assert.equal(t.d.activeElement,modal.querySelector('input[name="title"]'));
  assert(t.d.querySelector('.main').inert);assert(t.d.querySelector('.sidebar').inert);
  for(const label of ['Title','Description','Deadline','Epic','Assignees']){
    const field=[...modal.querySelectorAll('.field')].find(el=>el.querySelector('label')?.textContent.includes(label));
    assert(field,label);const visibleLabel=field.querySelector('label');
    assert(visibleLabel.htmlFor,label);assert.equal(field.querySelector(`#${visibleLabel.htmlFor}`)?.labels?.[0],visibleLabel,label);
  }
  const ids=[...t.d.querySelectorAll('[id]')].map(el=>el.id);assert.equal(new Set(ids).size,ids.length);
  const first=modal.querySelector('input[name="title"]');first.focus();key(t,'Tab',true);
  assert(modal.contains(t.d.activeElement));
  const last=modal.querySelector('.modal-actions button:last-child');last.focus();key(t,'Tab');assert(modal.contains(t.d.activeElement));
  key(t,'Escape');assert.equal(t.d.querySelector('.modal'),null);assert.equal(t.d.activeElement.getAttribute('onclick'),trigger.getAttribute('onclick'));
  assert.equal(t.d.querySelector('.main').inert,false);
});

test('a confirmation over a dialog returns focus to the field, and closing without a trigger keeps focus', () => {
  const t=boot();t.A.openModal('task');const title=t.d.querySelector('.modal input[name="title"]');title.focus();
  t.A.confirm({title:'Nested check',text:'Keep editing?',action:'Continue',confirm(){}});
  assert(t.d.getElementById('app').inert);assert.equal(t.d.activeElement.closest('.confirmation-layer')?.className,'confirmation-layer');
  t.d.querySelector('[data-confirm-cancel]').click();
  assert(!t.d.getElementById('app').inert);assert(t.d.querySelector('.main').inert);
  assert.equal(t.d.activeElement,title);
  t.d.querySelector('.topbar button[onclick="App.openModal(\'task\')"]').remove();
  key(t,'Escape');assert.equal(t.d.querySelector('.modal'),null);assert.notEqual(t.d.activeElement,t.d.body);
});

test('dialogs over the epic drawer restore focus one layer at a time', () => {
  const t=boot('roadmap'),epic=t.d.querySelector('[data-epic]');epic.focus();t.A.openPeek(epic.dataset.epic);
  const edit=[...t.d.querySelectorAll('.peek button')].find(button=>button.textContent.trim()==='Edit epic');assert(edit);edit.focus();
  t.A.openModal('epic',epic.dataset.epic);
  let modal=t.d.querySelector('.modal');assert(t.d.querySelector('.peek').inert);assert.equal(t.d.activeElement,modal.querySelector('input[name="title"]'));
  key(t,'Tab',true);assert(modal.contains(t.d.activeElement));
  key(t,'Escape');assert.equal(t.d.querySelector('.modal'),null);assert(t.d.querySelector('.peek'));assert(!t.d.querySelector('.peek').inert);
  assert.equal(t.d.activeElement.textContent.trim(),'Edit epic');
  key(t,'Escape');assert.equal(t.d.querySelector('.peek'),null);assert.equal(t.d.activeElement.dataset.epic,epic.dataset.epic);
});

test('closing an editor after losing permission keeps focus inside the drawer', () => {
  const t=boot('roadmap'),epic=t.d.querySelector('[data-epic]');t.A.openPeek(epic.dataset.epic);
  const edit=[...t.d.querySelectorAll('.peek button')].find(button=>button.textContent.trim()==='Edit epic');edit.focus();t.A.openModal('epic',epic.dataset.epic);
  const actor=t.D.users.find(user=>user.id===t.D.session.userId);actor.admin=false;
  const membership=t.D.projects[0].members.find(member=>member.userId===actor.id);membership.permissions=[];
  key(t,'Escape');assert.equal(t.d.querySelector('.modal'),null);assert(t.d.querySelector('.peek').contains(t.d.activeElement));
  assert(!t.d.activeElement.closest('[inert]'));
});

test('epic drawer refreshes keep focus, counts and unsent edits', () => {
  const t=boot('roadmap'),epic=t.d.querySelector('[data-epic]');t.A.openPeek(epic.dataset.epic);
  const peek=t.d.querySelector('.peek'),del=[...peek.querySelectorAll('button')].find(button=>button.textContent.trim()==='Delete');del.focus();
  (t.D.epicPageInfo ||= {})[epic.dataset.epic]={taskIds:[],tasksTotal:37,tasksCursor:null,activityCursor:null,loaded:true};
  t.A.refreshEpic();assert.equal(t.d.querySelector('.peek'),peek);assert.equal(t.d.activeElement,del);
  assert.equal(peek.querySelector('[data-epic-task-total]').textContent,'37');
  t.A.refresh();assert.equal(t.d.activeElement.textContent.trim(),'Delete');
  const edit=[...t.d.querySelector('.peek').querySelectorAll('button')].find(button=>button.textContent.trim()==='Edit epic');edit.focus();t.A.openModal('epic',epic.dataset.epic);
  const title=t.d.querySelector('.modal input[name="title"]');title.value='Unsent epic title';title.focus();
  t.A.refreshEpic();assert.equal(t.d.activeElement,title);assert.equal(title.value,'Unsent epic title');assert(t.d.querySelector('.peek').inert);
});

test('a full refresh keeps the dialog caret position', () => {
  const t=boot('roadmap'),epic=t.d.querySelector('[data-epic]');t.A.openModal('epic',epic.dataset.epic);
  const title=t.d.querySelector('.modal input[name="title"]');title.focus();title.setSelectionRange(3,3);
  t.A.refresh();const current=t.d.querySelector('.modal input[name="title"]');
  assert.equal(t.d.activeElement,current);assert.equal(current.selectionStart,3);assert.equal(current.selectionEnd,3);
});

test('navigation and sign-out dismiss open confirmations', () => {
  const t=boot();t.A.openModal('task');t.A.confirm({title:'Leave?',text:'An open check',action:'Continue',confirm(){}});
  assert(t.d.querySelector('.confirmation-layer'));t.A.nav('profile');
  assert.equal(t.d.querySelector('.confirmation-layer'),null);assert(!t.d.getElementById('app').inert);assert(t.d.querySelector('.profile-access'));
  t.A.confirm({title:'Session check',text:'Open',action:'Continue',confirm(){}});t.D.session=null;t.A.refresh();
  assert.equal(t.d.querySelector('.confirmation-layer'),null);assert(!t.d.getElementById('app').inert);assert(t.d.querySelector('.auth-card'));
});

test('the epic drawer is a modal dialog that returns focus to its bar', () => {
  const t=boot('roadmap'),epic=t.d.querySelector('[data-epic]');epic.focus();t.A.openPeek(epic.dataset.epic);
  const peek=t.d.querySelector('.peek');assert.equal(peek.getAttribute('role'),'dialog');assert.equal(t.d.activeElement,peek.querySelector('button'));
  assert(t.d.querySelector('.main').inert);key(t,'Escape');assert.equal(t.d.activeElement.dataset.epic,epic.dataset.epic);
});

test('select popups return focus to their trigger', () => {
  const t=boot();t.A.openModal('task');const btn=t.d.querySelector('.modal .field .sel-btn');assert(btn);
  btn.focus();t.A.popSelect({currentTarget:btn,preventDefault(){}},'mEpic');assert(t.d.querySelector('.pop-search'));
  key(t,'Escape');assert.equal(t.d.activeElement,btn);
  t.A.popSelect({currentTarget:btn,preventDefault(){}},'mEpic');t.d.querySelector('.pop-opt').click();assert.equal(t.d.activeElement,btn);
});

test('Pool refreshes keep unsent capture text and row focus', () => {
  const t=boot();t.A.openModal('pool');const input=t.d.getElementById('poolAdd');input.value='Unsent title';input.focus();
  const item=t.D.pool.find(p=>p.scope==='mine'),row=t.d.querySelector(`[data-pool-item="${item.id}"]`);
  t.A.editPoolDescription({currentTarget:row.querySelector('.pool-note-toggle'),stopPropagation(){}},item.id);
  item.desc='New server note';t.A.refreshPool({completeItemId:item.id});
  assert.equal(t.d.getElementById('poolAdd').value,'Unsent title');assert(t.d.querySelector(`[data-pool-item="${item.id}"]`).textContent.includes('New server note'));
  assert(t.d.activeElement.classList.contains('pool-note-toggle'));
  const other=t.D.pool.find(p=>p.scope==='mine'&&p!==item);t.D.pool=t.D.pool.filter(p=>p!==other);t.A.refreshPool();assert.equal(t.d.getElementById('poolAdd').value,'Unsent title');
});

test('Profile access refreshes keep the password field and focus', () => {
  const t=boot('profile'),input=t.d.querySelector('input[name="pw"]');input.value='not submitted';input.focus();
  t.A.refreshProfileAccess({loading:true});assert.equal(input.value,'not submitted');assert.equal(t.d.activeElement,input);
  t.A.refreshProfileAccess();assert.equal(input.value,'not submitted');assert.equal(t.d.activeElement,input);
});

test('a same-route hash change keeps Board search focus while other routes still navigate', () => {
  const t=boot('task/BIR-079');t.A.nav('board');
  const boardURL=t.w.location.href,search=t.d.querySelector('[aria-label="Search tasks"]');search.value='UIA';search.focus();
  t.w.dispatchEvent(new t.w.HashChangeEvent('hashchange',{newURL:boardURL}));
  assert.equal(t.d.activeElement,search);assert.equal(t.d.querySelector('[aria-label="Search tasks"]'),search);
  t.A.refreshBoard();assert.equal(t.d.activeElement,search);
  t.w.location.hash='#/profile';t.w.dispatchEvent(new t.w.HashChangeEvent('hashchange',{newURL:t.w.location.href}));
  assert(t.d.querySelector('.profile-access'),'external hash should still navigate');
});

test('epic drawer tasks are ordered by their numeric keys', () => {
  const t=boot('roadmap'),epic=t.D.epics[0];
  t.D.tasks=t.D.tasks.filter(task=>task.epicId!==epic.id);
  for(const id of ['AAA-1000','OLD-101','NEW-5000'])t.D.tasks.push({id,epicId:epic.id,projectId:epic.projectId,title:id,state:'planning',assignees:[],created:Date.now()});
  t.A.openPeek(epic.id);
  assert.deepEqual([...t.d.querySelectorAll('.peek .task-row .tid')].map(el=>el.textContent),['OLD-101','AAA-1000','NEW-5000']);
});

test('menus and selectors expose names, expansion and controlled regions', () => {
  const t=boot(),project=t.d.querySelector('.switcher-btn'),multi=t.d.querySelector('[data-filter-key]');
  assert.equal(project.getAttribute('aria-label'),'Project: '+t.D.projects.find(p=>p.id===t.A.context().projectId).name);
  assert.equal(multi.getAttribute('aria-expanded'),'false');t.A.popMulti({preventDefault(){},currentTarget:multi},multi.dataset.filterKey);
  assert.equal(multi.getAttribute('aria-expanded'),'true');assert(t.d.getElementById(multi.getAttribute('aria-controls')));
  key(t,'Escape');assert.equal(multi.getAttribute('aria-expanded'),'false');assert.equal(t.d.activeElement,multi);
  const profile=t.d.querySelector('.me-chip');profile.focus();t.A.userMenu({currentTarget:profile});
  assert.equal(profile.getAttribute('aria-haspopup'),null);assert.equal(profile.getAttribute('aria-expanded'),'true');assert(t.d.getElementById(profile.getAttribute('aria-controls')));
  key(t,'Escape');assert.equal(profile.getAttribute('aria-expanded'),'false');
  t.A.confirm({title:'Delete project',text:'Confirm',match:'Birch Grove',action:'Delete',confirm(){}});
  const input=t.d.getElementById('confirmation-match');assert.equal(input.getAttribute('aria-label'),null);assert.equal(input.getAttribute('placeholder'),null);assert.equal(input.labels[0].textContent,'Type Birch Grove to confirm');
});

test('permission checkboxes and task controls have descriptive labels', () => {
  const t=boot('settings');
  for(const input of t.d.querySelectorAll('.permission-check input')){
    const name=input.closest('.member-access-row').querySelector('.member-person b').textContent;
    assert.equal(input.getAttribute('aria-label'),`${name}: manage ${input.closest('label').textContent.trim()}`);
  }
  t.A.openTask('BIR-079');assert.equal(t.d.querySelector('[title="Back to Board"]').getAttribute('aria-label'),'Back to Board');
  assert.equal(t.d.querySelector('.attachment-dropzone').getAttribute('aria-label'),'Drag & drop or browse files');
});

test('a full render keeps focus on the epic drawer close button, not its scrim', () => {
  const t=boot('roadmap');t.A.openPeek(t.D.epics[0].id);
  const close=()=>t.d.querySelector('.peek [aria-label="Close epic"]');
  close().focus();assert.equal(t.d.activeElement,close());
  t.A.refresh();
  assert.equal(t.d.activeElement,close());
});

test('a track menu opened from the keyboard sits at its button', () => {
  const t=boot('roadmap'),kebab=t.d.querySelector('.lane[data-track] .kebab');
  kebab.getBoundingClientRect=()=>({x:600,y:200,left:600,top:200,right:620,bottom:220,width:20,height:20});
  // A click from the keyboard reports no pointer position.
  kebab.focus();t.A.trackMenu({currentTarget:kebab,clientX:0,clientY:0,stopPropagation(){}},kebab.closest('.lane').dataset.track);
  const menu=t.d.querySelector('#overlay-root > .menu');
  assert.equal(menu.style.left,'620px');assert.equal(menu.style.top,'224px');
});
