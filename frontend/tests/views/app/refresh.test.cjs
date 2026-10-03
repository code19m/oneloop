// views/app.js: in-place refreshes keep titles, focus, input and loaded feeds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('../../support/dom.cjs');

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
