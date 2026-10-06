// views/collaboration.js: comments, mentions, blocks and the discussion feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle, waitFor } = require('../support/dom.cjs');
const { installCollaborationController } = require('../../src/features/collaboration/controller.js');
const { createRecoveryController } = require('../../src/features/recovery/controller.js');
const { ApiError } = require('../../src/data/api-client.js');
const { installViewBridge } = require('../../src/app/view-bridge.js');

for(const kind of ['comment','block'])for(const state of ['active','removed','inactive'])for(const retained of [true,false])test(`${kind} editor validates ${retained?'saved':'new'} mentions when the recipient is ${state}`,async()=>{
 const saves=[];
 const t=bootApp({route:'task/BIR-079',prepare(D,w){
  w.OneloopTransport={};w.OneloopCollaboration={bind(){return {saveComment(input){saves.push(input);}};}};
  const task=D.tasks.find(item=>item.id==='BIR-079');task.internalId='task-1';
  task.comments=[{id:'retained-comment',who:D.session.userId,ts:1700000000000,text:retained?'@robin original':'Original',revision:1,mentions:retained?[{id:'robin',label:'robin',start:0,end:6}]:[]}];
  task.block={id:'retained-block',reason:retained?'@robin original':'Original',revision:1,by:D.session.userId,at:1700000000000,mentions:retained?[{kind:'user',userId:'robin',label:'@robin',startOffset:0,endOffset:6}]:[]};
 }});
 const task=t.D.tasks.find(item=>item.id==='BIR-079'),project=t.D.projects.find(item=>item.id===t.A.context().projectId);
 const invalidate=()=>{if(state==='removed')project.members=project.members.filter(member=>member.userId!=='robin');if(state==='inactive')t.D.users.find(user=>user.id==='robin').active=false;};
 const previousFormData=globalThis.FormData,previousCollab=globalThis.Collab;
 try{
  if(kind==='block'){
   globalThis.FormData=t.w.FormData;globalThis.Collab=t.w.Collab;
   installViewBridge({app:t.A,data:t.D,api:{},gateway:{execute:async(operation,payload)=>{saves.push({operation,payload});return {entities:[],events:[]};}},reads:{counts:async()=>{}},auth:{},recovery:{},reloadBootstrap:async()=>({})});
  }
  if(retained)invalidate();
  if(kind==='comment')t.A.editComment(task.id,'retained-comment');else t.A.openModal('block',task.id);
  if(!retained){if(kind==='comment')mention(t,'@rob','robin');else pickBlock(t,'@rob','robin');invalidate();}
  if(kind==='comment')typeComment(t,'@robin corrected');else typeBlock(t,'@robin corrected');
  if(kind==='comment')t.A.addComment(task.id);else saveBlockForm(t);
  await settle();
  const accepted=retained||state==='active';assert.equal(saves.length,accepted?1:0);
  if(!accepted){assert.match(t.d.querySelector(kind==='comment'?'.comment-feedback':'.block-mention-feedback').textContent,/no longer an active project member/);return;}
  if(kind==='comment'){
   assert.equal(saves[0].text,'@robin corrected');assert.equal(saves[0].commentId,'retained-comment');
   assert.deepEqual(JSON.parse(JSON.stringify(saves[0].mentions)),[{id:'robin',label:'robin',start:0,end:6}]);
  }else{
   assert.equal(saves[0].operation,'task.block.update');
   assert.deepEqual(JSON.parse(JSON.stringify(saves[0].payload)),{blockId:'retained-block',reason:'@robin corrected',mentions:[{kind:'user',userId:'robin',startOffset:0,endOffset:6,label:'@robin'}]});
  }
 }finally{globalThis.FormData=previousFormData;globalThis.Collab=previousCollab;}
});

function productionComments(commands) {
 let controller,transport;
 const comment={id:'comment-1',authorId:'taylorwu',rootId:'comment-1',content:'Original',mentions:[],createdAt:1700000000,revision:1};
 const comments=[comment,{...comment,id:'comment-2',rootId:'comment-2',content:'Other comment'}];
 const t=boot((D,w)=>{
  D.tasks.find(item=>item.id==='BIR-079').internalId='task-1';
  transport={data:D,api:{comments:async()=>({items:comments.map(item=>({...item})),nextCursor:null}),activity:async()=>({items:[],nextCursor:null})},commands,subscribe:()=>()=>{}};
  w.OneloopTransport=transport;
  controller=installCollaborationController({transport,eventSourceFactory:()=>({addEventListener(){},close(){}})});
  w.OneloopCollaboration=controller;
 });
 return {...t,controller,transport,comment,comments};
}

const conflict=()=>new ApiError('Comment changed; latest revision is 2',{status:409,code:'revision_conflict'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const conflictButton=(t,label)=>[...t.d.querySelectorAll('[data-recovery-conflict] button')].find(button=>button.textContent===label);

test('Use latest accepts comment text, mentions and revision when Save changes had focus',async()=>{
 const requests=[];
 const t=productionComments({execute:async(_operation,payload,options)=>{
  requests.push({payload,revision:options.expectedRevision});
  if(options.expectedRevision!==t.comment.revision)throw conflict();
  Object.assign(t.comment,{content:payload.content,mentions:payload.mentions,revision:t.comment.revision+1});
  return {entities:[{...t.comment}],events:[]};
 }});
 await settle();const previous=globalThis.OneloopRecovery;globalThis.OneloopRecovery=t.w.Recovery;
 try{
  t.A.editComment('BIR-079','comment-1');typeComment(t,'My draft');
  const mentions=[{kind:'user',userId:'robin',startOffset:7,endOffset:13,label:'@robin'}];
  Object.assign(t.comment,{content:'Remote @robin',mentions,revision:2});await t.controller.loadTaskPage('BIR-079');
  t.d.querySelector('.comment-composer-actions button').focus();t.A.addComment('BIR-079');await settle();
  const latest=conflictButton(t,'Use latest');assert(latest);latest.click();await settle();
  assert.equal(t.d.getElementById('cmtIn').value,'Remote @robin');
  t.A.addComment('BIR-079');await settle();
  assert.deepEqual(requests.map(request=>request.revision),[1,2]);
  assert.equal(requests[1].payload.content,'Remote @robin');assert.deepEqual(Array.from(requests[1].payload.mentions),mentions);
  assert.equal(t.comment.content,'Remote @robin');
 }finally{globalThis.OneloopRecovery=previous;t.controller.dispose();}
});

for(const phase of ['response','read','choice','latest-read','retry'])for(const newer of phase==='retry'?['editor','typing','session']:['editor','typing'])test(`comment conflict preserves newer ${newer} during ${phase}`,async()=>{
 const write=deferred(),read=deferred(),retry=deferred(),requests=[];let writes=0;
 const t=productionComments({execute:(_operation,payload,options)=>{requests.push({payload,options});return ++writes===1?write.promise:retry.promise;}});
 await settle();const previous=globalThis.OneloopRecovery;globalThis.OneloopRecovery=t.w.Recovery;
 try{
  t.A.editComment('BIR-079','comment-1');typeComment(t,'Submitted c1 draft').focus();t.A.addComment('BIR-079');
  Object.assign(t.comment,{content:'Remote c1 edit',revision:2});
  if(phase==='read')t.transport.api.comments=()=>read.promise;
  if(phase!=='response'){write.reject(conflict());await settle();}
  if(phase==='latest-read'){
   t.transport.api.comments=()=>read.promise;
   const latest=conflictButton(t,'Use latest');assert(latest);latest.click();await settle();
  }
  if(phase==='retry'){const mine=conflictButton(t,'Keep my changes');assert(mine);mine.click();await settle();assert.equal(writes,2);}
  if(newer!=='typing'){t.A.cancelCommentMode('BIR-079');t.A.editComment('BIR-079','comment-2');}
  if(newer==='session'){
   t.D.session={...t.D.session,id:'next-session'};
   Object.assign(t.D.tasks.find(task=>task.id==='BIR-079').comments.find(comment=>comment.id==='comment-1'),{text:'Next session version',revision:10});
  }
  const text=newer!=='typing'?'Unsent c2 draft':'Newer c1 typing',input=typeComment(t,text);
  input.focus();input.setSelectionRange(2,5);input.dispatchEvent(new t.w.Event('input',{bubbles:true}));
  if(phase==='response')write.reject(conflict());
  if(phase==='read'||phase==='latest-read')read.resolve({items:t.comments.map(item=>({...item})),nextCursor:null});
  if(phase==='retry')retry.resolve({entities:[{...t.comment,content:'Submitted c1 draft',revision:3}],events:[]});
  await settle();await settle();
  assert.equal(t.d.getElementById('cmtIn'),input);assert.equal(input.value,text);
  assert.equal(t.d.activeElement,input);assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,5);
  assert.equal(t.d.querySelector('[data-recovery-conflict]'),null);
  assert.equal(writes,phase==='retry'?2:1);
  if(newer==='session')assert.equal(t.D.tasks.find(task=>task.id==='BIR-079').comments.find(comment=>comment.id==='comment-1').text,'Next session version');
  if(phase==='latest-read'){
   t.A.addComment('BIR-079');assert.equal(requests.at(-1).options.expectedRevision,1,'the older acceptance cannot rebase newer typing');
   retry.resolve({entities:[{...t.comment,content:text,revision:3}],events:[]});await settle();
  }
 }finally{globalThis.OneloopRecovery=previous;t.controller.dispose();}
});

test('an open comment edit conflicts against its original revision after a live refresh',async()=>{
 const requests=[],reviews=[];
 const t=productionComments({execute:async(_operation,payload,options)=>{
  requests.push(options.expectedRevision);
  if(options.expectedRevision!==t.comment.revision)throw new ApiError('record changed; latest revision is 2',{status:409,code:'revision_conflict'});
  Object.assign(t.comment,{content:payload.content,revision:3});return {entities:[t.comment],events:[]};
 }});
 await settle();
 const previous=globalThis.OneloopRecovery;
 globalThis.OneloopRecovery=createRecoveryController({data:t.D,getApp:()=>t.A,documentObject:null,windowObject:null,presentConflict:async input=>{reviews.push(input.latestValue);return 'cancelled';}});
 try{
  t.A.editComment('BIR-079','comment-1');typeComment(t,'My local edit');
  Object.assign(t.comment,{content:'Remote edit',revision:2});await t.controller.loadTaskPage('BIR-079');
  t.A.addComment('BIR-079');await settle();
  assert.deepEqual(requests,[1]);assert.deepEqual(reviews,['Remote edit']);
  assert.equal(t.comment.content,'Remote edit');assert.equal(t.d.getElementById('cmtIn').value,'My local edit');
 }finally{globalThis.OneloopRecovery=previous;t.controller.dispose();}
});

for(const next of ['typing','reply','edit','reopen'])test(`comment completion preserves a newer ${next} draft and focus`,async()=>{
 let release;
 const t=productionComments({execute:()=>new Promise(resolve=>{release=resolve;})});
 await settle();
 if(next==='reopen')t.A.editComment('BIR-079','comment-1');
 typeComment(t,'Submitted draft');t.A.addComment('BIR-079');
 if(next==='reply')t.A.replyComment('BIR-079','comment-1');
 if(next==='edit')t.A.editComment('BIR-079','comment-1');
 if(next==='reopen'){t.A.cancelCommentMode('BIR-079');t.A.editComment('BIR-079','comment-1');}
 const input=typeComment(t,next==='reopen'?'Submitted draft':'New unsent draft');input.focus();input.setSelectionRange(2,5);
 release({entities:[{...t.comment,id:'saved',rootId:'saved',content:'Submitted draft'}],events:[{}]});await settle();
 assert.equal(t.d.getElementById('cmtIn'),input);assert.equal(input.value,next==='reopen'?'Submitted draft':'New unsent draft');
 assert.equal(t.d.activeElement,input);assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,5);
 assert(t.D.tasks.find(item=>item.id==='BIR-079').comments.some(item=>item.id==='saved'));
 t.controller.dispose();
});

test('a comment edit typed after Save saves over that acknowledged save',async()=>{
 const requests=[];let release;
 const t=productionComments({execute:(_operation,payload,options)=>{
  requests.push(options.expectedRevision);
  if(options.expectedRevision!==t.comment.revision)return Promise.reject(conflict());
  Object.assign(t.comment,{content:payload.content,revision:t.comment.revision+1});
  const saved={entities:[{...t.comment}],events:[{}]};
  return requests.length===1?new Promise(resolve=>{release=()=>resolve(saved);}):Promise.resolve(saved);
 }});
 await settle();
 try{
  t.A.editComment('BIR-079','comment-1');typeComment(t,'First edit');t.A.addComment('BIR-079');
  const input=typeComment(t,'First edit, continued');
  release();await settle();await settle();
  assert.equal(t.d.getElementById('cmtIn'),input);assert.equal(input.value,'First edit, continued');
  t.A.addComment('BIR-079');await settle();await settle();
  assert.deepEqual(requests,[1,2]);assert.equal(t.comment.content,'First edit, continued');
 }finally{t.controller.dispose();}
});

/** Boot a task page; `prepare` edits the projection before the views load. */
function boot(prepare, route = 'task/BIR-079', scenario = '') {
  return bootApp({ route, scenario, fixture: scenario === 'collaboration-demo' ? 'collaboration-demo' : undefined, prepare: prepare || undefined });
}
function event(form){return{target:form,preventDefault(){}}}
function block(t,mode,reason='Waiting for approval'){t.A.openModal(mode,'BIR-079');const form=t.d.querySelector('.modal form');form.querySelector('[name="reason"]').value=reason;return t.A.saveBlock(event(form),'BIR-079',mode);}
test('blocking lifecycle, required reason, completion confirmation, and no automatic reblocking', () => {
 const t=boot(),task=t.D.tasks.find(t=>t.id==='BIR-079');block(t,'block','');assert(!task.block);block(t,'block');assert.equal(task.block.reason,'Waiting for approval');
 t.A.updTask(task.id,'state','progress');assert(task.block);assert.equal(task.state,'progress');t.A.updTask(task.id,'state','review');assert(task.block);
 t.A.updTask(task.id,'state','done');assert.equal(task.state,'review');assert(t.d.querySelector('.modal').textContent.includes('Unblock and complete'));t.A.closeOverlays();assert(task.block);
 block(t,'completeBlocked','Approved');assert.equal(task.state,'done');assert(!task.block);assert.equal(task.blockHistory[0].resolution,'Approved');block(t,'block');assert(!task.block);
 t.A.closeOverlays();t.A.updTask(task.id,'state','planning');assert(!task.block);
});


function typeComment(t,text){const input=t.d.getElementById('cmtIn');input.value=text;input.setSelectionRange(text.length,text.length);t.A.commentInput({currentTarget:input},'BIR-079');return input;}
function mention(t,query,option='everyone'){const input=typeComment(t,query);const items=[...t.d.querySelectorAll('[data-mention-index]')];const chosen=items.find(b=>b.textContent.includes(option));assert(chosen,'Mention option exists');chosen.click();return input;}
test('canonical task refresh preserves the open property picker', () => {
 let facade;
 const t=boot((_D,w)=>{w.OneloopTransport={};w.OneloopCollaboration={bind(_app,_hooks,value){facade=value;return {};}};});
 const trigger=t.d.querySelector('[aria-label="Assignees"]');t.A.popMulti({currentTarget:trigger,preventDefault(){},stopPropagation(){}},'tpAssign');const option=t.d.querySelector('.pop-opt.multi');option.focus();facade.canonicalTask();assert(t.d.querySelector('.pop'),'canonical refresh keeps the open assignee picker');
});

test('member commenting, selected mentions only, everyone fan-out/rate limit, private inbox, threaded replies, tombstones and persisted read state', () => {
 const t=boot(D=>{D.session.userId='blairq';}),task=t.D.tasks.find(x=>x.id==='BIR-079');assert(t.w.Collab.canComment(task));assert(t.d.querySelector('.tp-title').disabled);assert(t.d.getElementById('cmtIn'));
 typeComment(t,'@robin plain text is not a mention');assert.equal(t.A.addComment(task.id),true);assert.equal(t.D.notifications.length,0);
 let input=mention(t,'@eve');typeComment(t,input.value+'Please review.');assert.equal(t.A.addComment(task.id),true);const root=task.comments.at(-1);assert.deepEqual(Array.from(t.D.notifications,n=>n.recipientId).sort(),['robin','taylorwu']);assert.equal(root.mentions[0].id,'everyone');
 input=mention(t,'@eve');typeComment(t,input.value+'Second broadcast');assert.equal(t.A.addComment(task.id),false);assert(t.d.querySelector('.comment-feedback').textContent.includes('minute'));
 const otherNotice=t.D.notifications.find(n=>n.recipientId==='taylorwu');t.A.setNotificationRead(otherNotice.id,false);assert.equal(otherNotice.readAt,null);
 t.D.session.userId='taylorwu';t.A.openTask(task.id);t.A.replyComment(task.id,root.id);typeComment(t,'I will check this.');assert.equal(t.A.addComment(task.id),true);const reply=task.comments.at(-1);assert.equal(reply.parentId,root.id);assert(t.D.notifications.some(n=>n.recipientId==='blairq'&&n.reason==='reply'));
 t.A.setNotificationRead(otherNotice.id,false);assert(otherNotice.readAt);const store=t.w.localStorage.getItem('oneloop.collaboration.v1');
 t.D.session.userId='blairq';t.A.openTask(task.id);t.A.deleteComment(task.id,root.id);t.d.querySelector('[data-confirm-accept]').click();assert(root.deleted);assert.equal(root.text,'');assert(task.comments.some(c=>c.id===reply.id));
 t.D.session.userId='taylorwu';t.A.nav('inbox');assert(t.d.querySelector('.inbox-list').textContent.includes('Comment removed'));
 const reload=boot((D,w)=>w.localStorage.setItem('oneloop.collaboration.v1',store),'inbox');assert(reload.D.notifications.find(n=>n.id===otherNotice.id).readAt);assert(reload.D.tasks.find(t=>t.id===task.id).comments.some(c=>c.id===reply.id));
});

test('non-member posting denied and cross-project inbox navigation selects the correct project', () => {
 const t=boot(D=>{D.session.userId='blairq';D.projects[0].members=D.projects[0].members.filter(m=>m.userId!=='blairq');});assert(!t.d.getElementById('cmtIn'));assert.equal(t.A.addComment('BIR-079'),false);
 const demo=boot(null,'inbox','collaboration-demo');demo.A.openNotification('demo-assignment');assert.equal(demo.w.location.hash,'#/task/ONE-101');assert.equal(demo.d.querySelector('.project-name').textContent,'oneloop');
});

test('edits do not resend mentions, and quoting/code removes notification semantics', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');let input=mention(t,'@rob','robin');typeComment(t,input.value+'Please check.');assert(t.A.addComment(task.id));const comment=task.comments.at(-1);assert.equal(t.D.notifications.filter(n=>n.commentId===comment.id).length,1);
 t.A.editComment(task.id,comment.id);input=t.d.getElementById('cmtIn');typeComment(t,input.value+' Thanks.');assert(t.A.addComment(task.id));assert.equal(t.D.notifications.filter(n=>n.commentId===comment.id).length,1);
 t.A.editComment(task.id,comment.id);typeComment(t,'`'+t.d.getElementById('cmtIn').value+'`');assert(t.A.addComment(task.id));assert.equal(comment.mentions.length,0);assert.equal(t.D.notifications.filter(n=>n.commentId===comment.id).length,1);
 typeComment(t,'> @eve');assert(!t.d.querySelector('.mention-picker'));typeComment(t,'```\n@eve');assert(!t.d.querySelector('.mention-picker'));
});

test('blocking without mentions stays quiet, unblock excludes actor and Storage is instance-admin-only', () => {
 const t=boot(D=>{D.tasks.find(t=>t.id==='BIR-079').assignees=['taylorwu','robin'];});block(t,'block');block(t,'unblock');assert.deepEqual(Array.from(t.D.notifications,n=>n.reason),['unblocked']);assert(t.D.notifications.every(n=>n.recipientId==='robin'));
 const s=boot(D=>{D.storageConfig={budgetBytes:100,high:.8,low:.7};D.tasks.find(t=>t.id==='BIR-079').attachments=[{id:'old',name:'old.txt',size:90,ephemeral:true,uploadedAt:Date.now()-3*864e5,lastAccessAt:Date.now()-3*864e5}];},'storage');assert.equal(s.d.querySelector('.topbar h1').textContent,'Storage');s.A.cleanupStorage();assert(s.D.tasks.find(t=>t.id==='BIR-079').attachments.some(f=>f.state==='cleaned'));
 const denied=boot(D=>D.users.find(u=>u.id==='taylorwu').admin=false,'storage');assert(denied.d.querySelector('.page-error').textContent.includes('Access denied'));
});

function typeBlock(t,text){const input=t.d.getElementById('block-reason');input.value=text;input.setSelectionRange(text.length,text.length);t.A.blockReasonInput({currentTarget:input},'BIR-079');return input;}
function pickBlock(t,text,who){const input=typeBlock(t,text);const option=[...t.d.querySelectorAll('[data-mention-index]')].find(b=>b.textContent.includes(who));assert(option);option.click();return input;}
function saveBlockForm(t){return t.A.saveBlock(event(t.d.querySelector('.modal form')),'BIR-079','block');}
test('block mentions survive normalization, deduplicate assignees/edits, preserve the open comment, and link to resolved activity', () => {
 const t=boot(D=>D.tasks.find(x=>x.id==='BIR-079').assignees=['robin']),task=t.D.tasks.find(x=>x.id==='BIR-079');typeComment(t,'Keep my open comment.');t.A.openModal('block',task.id);
 let input=pickBlock(t,'  Waiting    for @rob','robin');typeBlock(t,input.value+' to approve.  ');assert.equal(t.D.notifications.length,0);saveBlockForm(t);
 assert.equal(task.block.reason,'Waiting for @robin to approve.');assert.equal(task.block.reason.slice(task.block.mentions[0].start,task.block.mentions[0].end),'@robin');assert.equal(t.D.notifications.length,1);assert.equal(t.D.notifications[0].reason,'block-mention');assert.equal(t.d.getElementById('cmtIn').value,'Keep my open comment.');assert(t.d.querySelector('.task-block .comment-mention'));
 t.A.openModal('block',task.id);input=t.d.getElementById('block-reason');typeBlock(t,input.value+' Updated.');saveBlockForm(t);assert.equal(t.D.notifications.length,1);
 t.A.openModal('block',task.id);input=pickBlock(t,t.d.getElementById('block-reason').value+' @bla','blairq');saveBlockForm(t);assert.equal(t.D.notifications.length,2);
 const notice=t.D.notifications.find(n=>n.recipientId==='robin'),blockId=task.block.id;block(t,'unblock','Approved');assert.equal(task.blockHistory[0].id,blockId);t.D.session.userId='robin';t.A.openNotification(notice.id);assert(!t.d.querySelector('.block-history'));const linked=t.d.querySelector(`.timeline [data-block-id="${blockId}"]`);assert(linked);assert(linked.textContent.includes('@robin'));assert.equal(t.d.activeElement,linked);assert(t.d.querySelector('.timeline').textContent.includes('Approved'));for(let i=0;i<60;i++)t.w.Activity.record(task,'system','Later event '+i,null,Date.now()+i);t.A.openNotification(notice.id);assert(t.d.querySelector(`.timeline [data-block-id="${blockId}"]`));
});

test('block cancellation/reload clears input, everyone recipients, and shared broadcast cooldown', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');t.A.openModal('block',task.id);pickBlock(t,'@eve','everyone');assert(t.d.querySelector('.block-mention-hint').textContent.includes('2 project members'));t.A.closeOverlays();t.A.openModal('block',task.id);assert.equal(t.d.getElementById('block-reason').value,'');
 const saved=t.w.localStorage.getItem('oneloop.collaboration.v1');
 const reload=boot((D,w)=>w.localStorage.setItem('oneloop.collaboration.v1',saved)),rTask=reload.D.tasks.find(x=>x.id==='BIR-079');reload.A.openModal('block',rTask.id);assert.equal(reload.d.getElementById('block-reason').value,'');pickBlock(reload,'@eve','everyone');saveBlockForm(reload);assert.equal(reload.D.notifications.length,2);assert(reload.D.notifications.every(n=>n.reason==='block-everyone'));assert(rTask.block.broadcastSent);
 mention(reload,'@eve');assert.equal(reload.A.addComment(rTask.id),false);assert(reload.d.querySelector('.comment-feedback').textContent.includes('minute'));
});

test('stale block mentions rejected, 500-character limit preserved, plain text never notifies', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');t.A.openModal('block',task.id);pickBlock(t,'@rob','robin');t.D.users.find(u=>u.id==='robin').active=false;saveBlockForm(t);assert(!task.block);assert(!t.D.notifications.length);assert(t.d.querySelector('.block-mention-feedback').textContent.includes('no longer'));
 t.D.users.find(u=>u.id==='robin').active=true;const input=typeBlock(t,'x'.repeat(494)+' @rob');const before=input.value;t.d.querySelector('[data-mention-index]').click();assert.equal(input.value,before);assert(t.d.querySelector('.block-mention-feedback').textContent.includes('too long'));
 typeBlock(t,'@robin pasted as plain text');saveBlockForm(t);assert.equal(task.block.mentions.length,0);assert(!t.D.notifications.length);
});

test('obsolete demo drafts are ignored and saved block reasons remain', () => {
 const t=boot((D,w)=>w.localStorage.setItem('oneloop.drafts.v1',JSON.stringify({[JSON.stringify(['taylorwu','p1','form:block:BIR-079','reason'])]:{value:'Previous unsaved reason',at:Date.now()}})));t.A.openModal('block','BIR-079');assert.equal(t.d.getElementById('block-reason').value,'');typeBlock(t,'Updated reason');saveBlockForm(t);t.A.openModal('block','BIR-079');assert.equal(t.d.getElementById('block-reason').value,'Updated reason');t.A.closeOverlays();block(t,'unblock');t.A.openModal('block','BIR-079');assert.equal(t.d.getElementById('block-reason').value,'');
});

test('cancelled block edits discard unsaved text/tokens and keep the saved reason', () => {
 const t=boot();t.A.openModal('block','BIR-079');pickBlock(t,'@rob','robin');assert(!t.d.querySelector('.block-discard'));t.A.closeOverlays();t.A.openModal('block','BIR-079');assert.equal(t.d.getElementById('block-reason').value,'');typeBlock(t,'A plain reason');saveBlockForm(t);t.A.openModal('block','BIR-079');pickBlock(t,t.d.getElementById('block-reason').value+' @bla','blairq');t.A.closeOverlays();t.A.openModal('block','BIR-079');assert.equal(t.d.getElementById('block-reason').value,'A plain reason');saveBlockForm(t);assert.equal(t.D.notifications.length,0);
});

test('mentions do not grant permission to block a task', () => {
 const t=boot(D=>{D.session.userId='blairq';});assert(!t.d.querySelector('.block-task-action'));t.A.openModal('block','BIR-079');const form=t.d.querySelector('.modal form');form.querySelector('[name="reason"]').value='Waiting for @robin';t.A.saveBlock(event(form),'BIR-079','block');assert(!t.D.tasks.find(t=>t.id==='BIR-079').block);assert.equal(t.D.notifications.length,0);
});

test('comments/replies/edits discard unsent input on navigation, cancel and reload; posted comments persist', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');
 typeComment(t,'Saved comment');t.A.addComment(task.id);const savedComment=task.comments.at(-1);
 mention(t,'@rob','robin');const stored=t.w.localStorage.getItem('oneloop.collaboration.v1');assert(!Object.hasOwn(JSON.parse(stored),'drafts'));
 t.A.nav('board');t.A.openTask(task.id);assert.equal(t.d.getElementById('cmtIn').value,'');
 t.A.replyComment(task.id,savedComment.id);mention(t,'@bla','blairq');t.A.cancelCommentMode(task.id);t.A.replyComment(task.id,savedComment.id);assert.equal(t.d.getElementById('cmtIn').value,'');
 t.A.editComment(task.id,savedComment.id);typeComment(t,'Unsent edit');t.A.cancelCommentMode(task.id);t.A.editComment(task.id,savedComment.id);assert.equal(t.d.getElementById('cmtIn').value,'Saved comment');
 const reloaded=boot((D,w)=>w.localStorage.setItem('oneloop.collaboration.v1',stored));assert.equal(reloaded.d.getElementById('cmtIn').value,'');assert(reloaded.D.tasks.find(x=>x.id==='BIR-079').comments.some(c=>c.text==='Saved comment'));
});

test('comment attachment links/uploads removed, legacy associations cleared, task files and text replies preserved', () => {
 const t=boot(D=>{const task=D.tasks.find(t=>t.id==='BIR-079');task.attachments=[{id:'kept-file',name:'reference.txt',size:10,commentId:'legacy-comment'}];task.comments=[{id:'legacy-comment',who:'taylorwu',ts:Date.now(),text:'Existing discussion',mentions:[],attachments:['kept-file']}];}),task=t.D.tasks.find(t=>t.id==='BIR-079');
 assert(!t.d.querySelector('.comment-file-picker,.comment-file,[data-comment-upload]'));assert(!t.d.querySelector('.collaboration-composer input[type=file]'));assert.equal(task.attachments.length,1);assert.equal(task.attachments[0].commentId,undefined);assert.equal(task.comments[0].attachments,undefined);
 t.A.replyComment(task.id,'legacy-comment');typeComment(t,'Text reply');t.A.addComment(task.id);const reply=task.comments.at(-1);assert.equal(reply.text,'Text reply');assert.equal(reply.parentId,'legacy-comment');assert.equal(reply.attachments,undefined);
 t.A.editComment(task.id,reply.id);typeComment(t,'Updated reply');t.A.addComment(task.id);assert.equal(reply.text,'Updated reply');assert.equal(task.attachments.length,1);assert(!JSON.parse(t.w.localStorage.getItem('oneloop.collaboration.v1')).comments[task.id].some(c=>Object.hasOwn(c,'attachments')));
});


test('Enter sends/replies/edits, Shift+Enter and composition are preserved, mentions select first, repeats do not duplicate, and failed sends retain input', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');
 const key=(options={})=>{let prevented=false;const ev={key:'Enter',currentTarget:t.d.getElementById('cmtIn'),preventDefault(){prevented=true;},stopPropagation(){},...options};t.A.commentKey(ev);return prevented;};
 typeComment(t,'First comment');assert(key());assert.equal(task.comments.length,1);assert.equal(task.comments[0].text,'First comment');assert.equal(t.d.activeElement,t.d.getElementById('cmtIn'));
 typeComment(t,'Another line');assert(!key({shiftKey:true}));assert(!key({isComposing:true}));assert(!key({keyCode:229}));assert(key({repeat:true}));assert.equal(task.comments.length,1);
 typeComment(t,'   ');assert(key());assert.equal(task.comments.length,1);assert.equal(t.d.getElementById('cmtIn').value,'   ');
 typeComment(t,'@rob');assert(t.d.querySelector('.mention-picker'));assert(key());assert.equal(task.comments.length,1);assert(t.d.getElementById('cmtIn').value.startsWith('@robin '));typeComment(t,t.d.getElementById('cmtIn').value+'Please review.');assert(key());assert.equal(task.comments.length,2);assert.equal(task.comments[1].mentions[0].id,'robin');
 const root=task.comments[0];t.A.replyComment(task.id,root.id);typeComment(t,'Reply via Enter');key();assert.equal(task.comments.at(-1).parentId,root.id);
 t.A.editComment(task.id,root.id);typeComment(t,'Edited via Enter');key();assert.equal(root.text,'Edited via Enter');assert.equal(task.comments.length,3);
 t.A.openModal('block',task.id);const reason=t.d.getElementById('block-reason');reason.value='Keep this multiline';assert(!key({currentTarget:reason,shiftKey:true}));assert(!task.block);
 const offline=boot(null,'task/BIR-079','offline'),offlineTask=offline.D.tasks.find(x=>x.id==='BIR-079');offline.w.dispatchEvent(new offline.w.Event('offline'));const input=typeComment(offline,'Keep my text');offline.A.commentKey({key:'Enter',currentTarget:input,preventDefault(){}});assert.equal(offlineTask.comments?.length||0,0);assert.equal(offline.d.getElementById('cmtIn').value,'Keep my text');
});


test('contextual comment actions, one inline editor, reply composer dismissal, reply-to references, edit cancellation and ownership checks', () => {
 const t=boot(D=>{D.tasks.find(x=>x.id==='BIR-079').comments=[
  {id:'thread-root',who:'robin',ts:Date.now()-30000,text:'Please review the reminder edge cases.',replyCount:80},
  {id:'thread-reply',who:'taylorwu',ts:Date.now()-20000,text:'Checking February.',parentId:'thread-root',replyToId:'thread-root'},
  {id:'thread-followup',who:'blairq',ts:Date.now()-10000,text:'The fixture is ready.',parentId:'thread-root',replyToId:'thread-reply'}
 ];}),task=t.D.tasks.find(x=>x.id==='BIR-079');
 const root=()=>t.d.querySelector('[data-comment="thread-root"]'),input=()=>t.d.getElementById('cmtIn'),toggle=()=>t.d.querySelector('[data-reply-root="thread-root"]');
 assert(root().querySelector('.reply-action svg'));assert(!root().querySelector('.comment-actions').textContent.includes('Delete'));assert(toggle().textContent.includes('2 of 80 replies'));assert(t.d.querySelector('.reply-reference'));
 t.A.commentMenu({currentTarget:root().querySelector('.comment-menu-button')},task.id,'thread-root');assert.equal(t.d.querySelector('.menu button').textContent.trim(),'Edit');assert.equal(t.d.querySelector('.menu button.danger').textContent.trim(),'Delete');t.A.menuAction(0);assert(input().closest('[data-comment="thread-root"]'));assert.equal(input().value,'Please review the reminder edge cases.');t.A.cancelCommentMode(task.id);
 t.A.replyComment(task.id,'thread-reply');assert(input().closest('.thread-composer'));assert.equal(t.d.querySelectorAll('#cmtIn').length,1);assert.equal(t.d.querySelector('.comment-composer-home').textContent,'');assert(t.d.querySelector('.reply-context-quote').textContent.includes('Checking February'));
 typeComment(t,'Keep this open');t.A.toggleReplies(task.id,'thread-root');assert.equal(toggle().getAttribute('aria-expanded'),'false');assert(!input().closest('[inert]'));assert.equal(input().value,'Keep this open');t.A.replyComment(task.id,'thread-reply');assert.equal(input().value,'Keep this open');
 assert(t.A.addComment(task.id));assert.equal(task.comments.at(-1).parentId,'thread-root');assert.equal(task.comments.at(-1).replyToId,'thread-reply');assert(!t.d.querySelector('.thread-composer'));assert(input().closest('.comment-composer-home'));assert.equal(t.d.activeElement.dataset.comment,task.comments.at(-1).id);const savedReply=t.d.activeElement;assert(savedReply.classList.contains('comment-save-focus'));input().focus();assert(!savedReply.classList.contains('comment-save-focus'));assert(t.d.querySelector('#toast-region').textContent.includes('Reply added'));assert.equal(t.d.querySelector('.comment-feedback').textContent,'');assert.equal(input().value,'');assert.equal(toggle().getAttribute('aria-expanded'),'true');
 t.A.cancelCommentMode(task.id);assert(input().closest('.comment-composer-home'));assert.equal(t.d.querySelectorAll('#cmtIn').length,1);
 t.A.editComment(task.id,'thread-reply');assert(input().closest('[data-comment="thread-reply"]'));assert(toggle().disabled);typeComment(t,'Unsaved edit');t.A.cancelCommentMode(task.id);assert.equal(task.comments.find(c=>c.id==='thread-reply').text,'Checking February.');assert(!toggle().disabled);
 t.A.jumpToComment(task.id,'thread-followup');assert.equal(t.d.activeElement.dataset.comment,'thread-followup');
 t.D.users.find(u=>u.id==='taylorwu').admin=false;t.A.refresh();assert(!root().querySelector('.comment-menu-button'));assert(t.d.querySelector('[data-comment="thread-reply"] .comment-menu-button'));t.A.commentMenu({currentTarget:root()},task.id,'thread-root');assert(!t.d.querySelector('.menu'));
});

test('long comments use the description reader while retaining mention markup', () => {
 const text=`Opening context for @robin.\n\n${'More implementation detail that keeps the comment readable. '.repeat(28)}`,mention='@robin',start=text.indexOf(mention),t=boot(D=>{D.tasks.find(x=>x.id==='BIR-079').comments=[{id:'long-root',who:'taylorwu',ts:Date.now(),text,mentions:[{id:'robin',label:'robin',start,end:start+mention.length}]}];}),body=t.d.querySelector('[data-comment="long-root"] .comment-body-content'),toggle=t.d.querySelector('[data-comment="long-root"] .description-toggle');
 assert.equal(body.getAttribute('role'),'group');assert.equal(body.getAttribute('tabindex'),null);
 for(const id of body.getAttribute('aria-labelledby').split(' '))assert(t.d.getElementById(id));
 Object.defineProperty(body,'scrollHeight',{configurable:true,value:520});t.A.toggleCommentText('BIR-079','long-root');assert.equal(toggle.hidden,false);assert.equal(toggle.textContent,'Show less');assert.equal(toggle.getAttribute('aria-expanded'),'true');assert(body.querySelector('.comment-mention'));assert.equal(body.style.height,'520px');
 t.A.toggleCommentText('BIR-079','long-root');assert.equal(toggle.textContent,'Show more');assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(body.style.height,'240px');assert.equal(body.getAttribute('tabindex'),'0');assert(body.closest('.comment-reading').classList.contains('is-collapsed'));
});

test('comment readers disconnect when task scope is left', () => {
 const observers=[],t=boot((D,w)=>{w.ResizeObserver=class{constructor(callback){this.callback=callback;this.targets=[];observers.push(this);}observe(target){this.targets.push(target);}disconnect(){this.disconnected=true;}};D.tasks.find(x=>x.id==='BIR-079').comments=[{id:'observer-comment',who:'taylorwu',ts:Date.now(),text:'A comment'}];}),commentObserver=observers.findLast(observer=>observer.targets.some(target=>target.classList?.contains('comment-reading')));
 assert(commentObserver);assert(!commentObserver.disconnected);t.w.Collab.beforeRender({userId:null,projectId:null,view:'auth',taskId:null});assert(commentObserver.disconnected);
});

test('same-timestamp activity, root comments and replies use stable IDs for chronological order', () => {
 const t=boot(D=>{const task=D.tasks.find(x=>x.id==='BIR-079');task.activity=[
  {id:'activity-b',who:'robin',ts:100,text:'attached brief.pdf'},
  {id:'activity-a',who:'robin',ts:100,text:'created the task'},
 ];task.comments=[
  {id:'comment-b',who:'robin',ts:100,text:'Second root'},
  {id:'comment-a',who:'robin',ts:100,text:'First root'},
  {id:'reply-b',who:'blairq',ts:100,text:'Second reply',parentId:'comment-a',replyToId:'comment-a'},
  {id:'reply-a',who:'blairq',ts:100,text:'First reply',parentId:'comment-a',replyToId:'comment-a'},
 ];}),task=t.D.tasks.find(x=>x.id==='BIR-079');
 assert.deepEqual([...t.d.querySelectorAll('[data-feed-key]')].map(el=>el.dataset.feedKey),['activity-activity-a','activity-activity-b','comment-comment-a','comment-comment-b']);
 t.A.toggleReplies(task.id,'comment-a');assert.deepEqual([...t.d.querySelectorAll('[data-thread-root="comment-a"] [data-comment]')].map(el=>el.dataset.comment),['reply-a','reply-b']);
});

test('comment/reply edit consolidation, reverts, unchanged saves, content fingerprints, fixed windows and editor isolation', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079'),base=t.w.Date.now();let now=base;t.w.Date.now=()=>now;
 task.activity=[];task.comments=[{id:'dedup-root',who:'taylorwu',ts:base,text:'Original',mentions:[]},{id:'dedup-reply',who:'taylorwu',ts:base+1,text:'Reply original',mentions:[],parentId:'dedup-root',replyToId:'dedup-root'}];t.A.refresh();
 const edit=(id,text)=>{t.A.editComment(task.id,id);typeComment(t,text);assert(t.A.addComment(task.id));};
 edit('dedup-root','Original');assert.equal(task.activity.length,0);assert.equal(task.comments[0].editedAt,undefined);
 edit('dedup-root','First edit');now+=1000;edit('dedup-root','Second edit');assert.equal(t.w.Activity.visible(task.activity).length,1);assert.equal(task.activity.length,2);assert.match(task.activity[0].change.before,/^[a-f0-9]{64}$/);assert(!JSON.stringify(task.activity).includes('Original'));
 now+=1000;edit('dedup-root','Original');assert.equal(t.w.Activity.visible(task.activity).length,0);assert.equal(task.activity.length,3);
 const editedAt=task.comments[0].editedAt,notifications=t.D.notifications.length;edit('dedup-root','Original');assert.equal(task.activity.length,3);assert.equal(task.comments[0].editedAt,editedAt);assert.equal(t.D.notifications.length,notifications);
 now+=1000;edit('dedup-root','Another edit');edit('dedup-reply','Reply edited');assert.equal(t.w.Activity.visible(task.activity).length,2);edit('dedup-reply','Reply original');assert.equal(t.w.Activity.visible(task.activity).length,1);
 now=base+300001;edit('dedup-root','Original');assert.equal(t.w.Activity.visible(task.activity).length,2);
 t.D.users.find(u=>u.id==='robin').admin=true;t.D.session.userId='robin';t.A.refresh();edit('dedup-root','Moderator edit');assert.equal(t.w.Activity.visible(task.activity).length,3);
});

test('Enter submits block/edit/unblock/completion, mentions select first, Shift/IME/repeat guards and failed-submit input preservation', () => {
 const t=bootApp({route:'task/BIR-079',actions:true}),task=t.D.tasks.find(x=>x.id==='BIR-079');let input;
 const open=mode=>{t.A.openModal(mode,task.id);const form=t.d.querySelector('form[data-block-action]');input=form.querySelector('textarea');return form;};
 const key=(options={})=>{const ev={currentTarget:input,key:'Enter',defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...options};t.A.commentKey(ev);return ev;};
 open('block');key();assert(!task.block);assert(t.d.querySelector('.ferr'));
 typeBlock(t,'Waiting');assert(!key({shiftKey:true}).defaultPrevented);assert(!key({isComposing:true}).defaultPrevented);assert(!key({keyCode:229}).defaultPrevented);assert(key({repeat:true}).defaultPrevented);assert(!task.block);
 typeBlock(t,'Waiting for @rob');key();assert(!task.block);assert(input.value.includes('@robin'));key();assert(task.block);assert.equal(task.block.mentions[0].id,'robin');
 open('block');typeBlock(t,'Updated reason');key();assert.equal(task.block.reason,'Updated reason');
 open('unblock');input.value='Resolved';assert(!key({shiftKey:true}).defaultPrevented);assert(task.block);key();assert(!task.block);assert.equal(task.blockHistory.at(-1).resolution,'Resolved');
 open('block');typeBlock(t,'Final check');key();open('completeBlocked');input.value='All checks passed';key();assert.equal(task.state,'done');assert(!task.block);
});


test('blocking notifies selected mentions, never unrelated task assignees', () => {
 const t=boot(D=>D.tasks.find(x=>x.id==='BIR-079').assignees=['robin']),task=t.D.tasks.find(x=>x.id==='BIR-079');t.A.openModal('block',task.id);pickBlock(t,'Waiting on @bla','blairq');saveBlockForm(t);assert.deepEqual(Array.from(t.D.notifications,n=>n.recipientId),['blairq']);assert.equal(t.D.notifications[0].reason,'block-mention');
});

test('the feed checks posting permission once and indexes people once', () => {
  const { w, D } = bootApp({ route: 'task/BIR-079', media: () => false });
  const task = D.tasks.find(item => item.id === 'BIR-079');
  task.comments = Array.from({ length: 150 }, (_, i) => ({ id: `perf-${i}`, who: D.session.userId, ts: Date.now() + i, text: 'Long comment '.repeat(50), mentions: [] }));
  const actor = D.users.find(user => user.id === D.session.userId); actor.admin = false; actor.active = true;
  const project = D.projects.find(item => item.id === 'p1');
  let idReads = 0;
  for (let index = 0; index < 1000; index++) { const id = 'member-' + index; D.users.push({ get id() { idReads++; return id; }, active: true, name: id }); project.members.push({ userId: id, permissions: [] }); }
  const membership = project.members.find(member => member.userId === actor.id); assert.ok(membership);
  let permissionScans = 0; const some = project.members.some;
  project.members.some = function (...args) { permissionScans++; return some.apply(this, args); };
  w.Collab.feedHtml(task, 150);
  assert.equal(permissionScans, 1, 'posting permission is checked once per feed');
  assert.ok(idReads < 3000, 'people are indexed once, not scanned for each member/comment');
  project.members.splice(project.members.indexOf(membership), 1); assert.equal(w.Collab.canComment(task), false);
  project.members.push(membership); assert.equal(w.Collab.canComment(task), true);
  actor.active = false; assert.equal(w.Collab.canComment(task), false);
});

/** The task page with production comments whose sends wait for the test. */
function sendingComments(){
 const sends=[];let facade;
 const t=bootApp({route:'task/BIR-079',prepare(_D,w){
  w.OneloopTransport={};
  w.OneloopCollaboration={bind(_app,_hooks,value){facade=value;return {saveComment(input){return new Promise(resolve=>sends.push({input,resolve}));}};}};
 }});
 const task=t.D.tasks.find(item=>item.id==='BIR-079');
 return {...t,task,sends,
  /** The server saves send `index`, and the page hears of it. */
  save(index){const {input,resolve}=sends[index],comment={id:`saved-${index}`,who:t.D.session.userId,ts:Date.now(),text:input.text,mentions:input.mentions,parentId:null,revision:1};(task.comments??=[]).push(comment);facade.commentSaved(task.id,comment,{mode:input.mode,targetId:input.targetId,interactionId:input.interactionId,changed:true});resolve(true);},
  /** Send `index` can't be saved. */
  fail(index){const {input,resolve}=sends[index];input.unsent();resolve(false);},
 };
}

test('text typed after Enter is a new comment, never joined to the one being sent or sent with it again',async()=>{
 const t=sendingComments();
 mention(t,'@rob','robin');typeComment(t,t.d.getElementById('cmtIn').value+'please check');
 t.A.addComment('BIR-079');
 assert.equal(t.d.getElementById('cmtIn').value,'','the sent text left the box at once');
 typeComment(t,'Also the screenshots.');t.A.addComment('BIR-079');
 assert.deepEqual(t.sends.map(({input})=>input.text),['@robin please check','Also the screenshots.']);
 assert.equal(t.sends[0].input.mentions.length,1);assert.equal(t.sends[1].input.mentions.length,0,'only the first comment mentions Robin');
 assert.notEqual(t.sends[0].input.interactionId,t.sends[1].input.interactionId);
 typeComment(t,'A third, still typing');
 t.save(0);await settle();
 assert.equal(t.d.getElementById('cmtIn').value,'A third, still typing','a saved comment leaves what was typed since');
 assert.ok([...t.d.querySelectorAll('.cmt-body')].some(body=>body.textContent.includes('please check')),'the list shows the saved comment');
});

test('a comment that can\'t be sent comes back ahead of what was typed since, and alone it keeps its interaction',async()=>{
 const t=sendingComments();
 typeComment(t,'First thought');t.A.addComment('BIR-079');
 typeComment(t,'Second thought');t.fail(0);await settle();
 assert.equal(t.d.getElementById('cmtIn').value,'First thought\n\nSecond thought');
 typeComment(t,'');typeComment(t,'Only thought');t.A.addComment('BIR-079');
 assert.equal(t.d.getElementById('cmtIn').value,'');
 t.fail(1);await settle();
 assert.equal(t.d.getElementById('cmtIn').value,'Only thought');
 t.A.addComment('BIR-079');
 assert.equal(t.sends[2].input.text,'Only thought');
 assert.equal(t.sends[2].input.interactionId,t.sends[1].input.interactionId,'sending it again can\'t add it twice');
});

test('a deleted comment offers Undo, which brings its text back',async()=>{
 const requests=[];
 const t=productionComments({execute:async(operation,payload,options)=>{
  requests.push([operation,payload.commentId,options.expectedRevision]);
  const deleted=operation==='discussion.comment.delete';
  Object.assign(t.comment,{content:deleted?null:'Original',deletedAt:deleted?1700000100:null,revision:options.expectedRevision+1});
  return {entities:[{...t.comment}],events:[]};
 }});
 await settle();
 try{
  t.A.deleteComment('BIR-079','comment-1');
  assert.match(t.d.querySelector('#confirmation-description').textContent,/You can undo this right after/);
  t.d.querySelector('[data-confirm-accept]').click();
  await waitFor(()=>t.d.querySelector('#toast-region .toast-action'),'the deletion offers Undo');
  assert.equal(t.D.tasks.find(item=>item.id==='BIR-079').comments.find(item=>item.id==='comment-1').deleted,true);
  t.d.querySelector('#toast-region .toast-action').click();
  await waitFor(()=>t.d.querySelector('#toast-region').textContent.includes('Comment restored'),'the comment is restored');
  assert.deepEqual(requests,[['discussion.comment.delete','comment-1',1],['discussion.comment.restore','comment-1',2]]);
  assert.equal(t.D.tasks.find(item=>item.id==='BIR-079').comments.find(item=>item.id==='comment-1').text,'Original');
 }finally{t.controller.dispose();}
});
