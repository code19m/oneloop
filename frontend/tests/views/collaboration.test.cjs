// views/collaboration.js: comments, mentions, blocks and the discussion feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle, waitFor } = require('../support/dom.cjs');
const { createRecoveryController } = require('../../src/features/recovery/controller.js');
const { ApiError } = require('../../src/data/api-client.js');

// Comments and blocks share one membership check: a new mention needs an active member, a saved one is kept.
// One case per outcome: an active member for blocks (new comment mentions are sent below), removed and
// inactive members, and a saved mention of a member who left.
for(const [kind,state,retained] of [['comment','removed',false],['comment','inactive',false],['comment','removed',true],['block','active',false],['block','removed',false],['block','removed',true]])test(`${kind} editor validates ${retained?'saved':'new'} mentions when the recipient is ${state}`,async()=>{
 const t=bootApp({route:'task/BIR-079',prepare(D){
  const task=D.tasks.find(item=>item.id==='BIR-079');task.internalId='task-1';
  task.comments=[{id:'retained-comment',who:D.session.userId,ts:1700000000000,text:retained?'@robin original':'Original',revision:1,mentions:retained?[{id:'robin',label:'robin',start:0,end:6}]:[]}];
  task.block={id:'retained-block',reason:retained?'@robin original':'Original',revision:1,by:D.session.userId,at:1700000000000,mentions:retained?[{kind:'user',userId:'robin',label:'@robin',startOffset:0,endOffset:6}]:[]};
 }});
 const task=t.D.tasks.find(item=>item.id==='BIR-079'),project=t.D.projects.find(item=>item.id===t.A.context().projectId);
 const invalidate=()=>{if(state==='removed')project.members=project.members.filter(member=>member.userId!=='robin');if(state==='inactive')t.D.users.find(user=>user.id==='robin').active=false;};
 if(retained)invalidate();
 if(kind==='comment')t.A.editComment(task.id,'retained-comment');else t.A.openModal('block',task.id);
 if(!retained){if(kind==='comment')mention(t,'@rob','robin');else pickBlock(t,'@rob','robin');invalidate();}
 if(kind==='comment')typeComment(t,'@robin corrected');else typeBlock(t,'@robin corrected');
 if(kind==='comment')t.A.addComment(task.id);else saveBlockForm(t);
 await settle();
 const accepted=retained||state==='active';assert.equal(t.commands.length,accepted?1:0);
 if(!accepted){assert.match(t.d.querySelector(kind==='comment'?'.comment-feedback':'.block-mention-feedback').textContent,/no longer an active project member/);return;}
 const mentions=[{kind:'user',userId:'robin',startOffset:0,endOffset:6,label:'@robin'}];
 if(kind==='comment')assert.deepEqual([t.commands[0].operation,t.commands[0].payload],['discussion.comment.edit',{commentId:'retained-comment',content:'@robin corrected',mentions}]);
 else assert.deepEqual([t.commands[0].operation,t.commands[0].payload],['task.block.update',{blockId:'retained-block',reason:'@robin corrected',mentions}]);
});

/** A task page with two comments, whose commands `execute` answers, by default never. */
function productionComments(execute=()=>new Promise(()=>{})) {
 const comment={id:'comment-1',authorId:'taylorwu',rootId:'comment-1',content:'Original',mentions:[],createdAt:1700000000,revision:1};
 const comments=[comment,{...comment,id:'comment-2',rootId:'comment-2',content:'Other comment'}];
 const t=bootApp({route:'task/BIR-079',prepare:D=>{D.tasks.find(item=>item.id==='BIR-079').internalId='task-1';},api:{
  command:command=>execute(command.operation,command.payload,{expectedRevision:command.expectedRevision}),
  comments:async()=>({items:comments.map(item=>({...item})),nextCursor:null}),activity:async()=>({items:[],nextCursor:null}),
 }});
 return {...t,controller:t.w.OneloopCollaboration,comment,comments};
}

const conflict=()=>new ApiError('Comment changed; latest revision is 2',{status:409,code:'revision_conflict'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const conflictButton=(t,label)=>[...t.d.querySelectorAll('[data-recovery-conflict] button')].find(button=>button.textContent===label);

test('Use latest accepts comment text, mentions and revision when Save changes had focus',async()=>{
 const requests=[];
 const t=productionComments(async(_operation,payload,options)=>{
  requests.push({payload,revision:options.expectedRevision});
  if(options.expectedRevision!==t.comment.revision)throw conflict();
  Object.assign(t.comment,{content:payload.content,mentions:payload.mentions,revision:t.comment.revision+1});
  return {entities:[{...t.comment}],events:[]};
 });
 await settle();
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
 }finally{t.controller.dispose();}
});

for(const phase of ['response','read','choice','latest-read','retry'])for(const newer of phase==='retry'?['editor','typing','session']:['editor','typing'])test(`comment conflict preserves newer ${newer} during ${phase}`,async()=>{
 const write=deferred(),read=deferred(),retry=deferred(),requests=[];let writes=0;
 const t=productionComments((_operation,payload,options)=>{requests.push({payload,options});return ++writes===1?write.promise:retry.promise;});
 await settle();
 try{
  t.A.editComment('BIR-079','comment-1');typeComment(t,'Submitted c1 draft').focus();t.A.addComment('BIR-079');
  Object.assign(t.comment,{content:'Remote c1 edit',revision:2});
  if(phase==='read')t.api.comments=()=>read.promise;
  if(phase!=='response'){write.reject(conflict());await settle();}
  if(phase==='latest-read'){
   t.api.comments=()=>read.promise;
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
 }finally{t.controller.dispose();}
});

test('an open comment edit conflicts against its original revision after a live refresh',async()=>{
 const requests=[],reviews=[];
 const t=productionComments(async(_operation,payload,options)=>{
  requests.push(options.expectedRevision);
  if(options.expectedRevision!==t.comment.revision)throw new ApiError('record changed; latest revision is 2',{status:409,code:'revision_conflict'});
  Object.assign(t.comment,{content:payload.content,revision:3});return {entities:[t.comment],events:[]};
 });
 await settle();
 const previous=globalThis.Recovery;
 globalThis.Recovery=createRecoveryController({data:t.D,getApp:()=>t.A,documentObject:null,windowObject:null,presentConflict:async input=>{reviews.push(input.latestValue);return 'cancelled';}});
 try{
  t.A.editComment('BIR-079','comment-1');typeComment(t,'My local edit');
  Object.assign(t.comment,{content:'Remote edit',revision:2});await t.controller.loadTaskPage('BIR-079');
  t.A.addComment('BIR-079');await settle();
  assert.deepEqual(requests,[1]);assert.deepEqual(reviews,['Remote edit']);
  assert.equal(t.comment.content,'Remote edit');assert.equal(t.d.getElementById('cmtIn').value,'My local edit');
 }finally{t.controller.dispose();}
});

for(const next of ['typing','reply','edit','reopen'])test(`comment completion preserves a newer ${next} draft and focus`,async()=>{
 let release;
 const t=productionComments(()=>new Promise(resolve=>{release=resolve;}));
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
 const t=productionComments((_operation,payload,options)=>{
  requests.push(options.expectedRevision);
  if(options.expectedRevision!==t.comment.revision)return Promise.reject(conflict());
  Object.assign(t.comment,{content:payload.content,revision:t.comment.revision+1});
  const saved={entities:[{...t.comment}],events:[{}]};
  return requests.length===1?new Promise(resolve=>{release=()=>resolve(saved);}):Promise.resolve(saved);
 });
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

/** Boot a task page; `prepare` edits the projection before the views load. Activity reads find nothing new. */
function boot(prepare, route = 'task/BIR-079') {
  return bootApp({ route, prepare: prepare || undefined, api: { activity: async () => ({ items: [], nextCursor: null }) } });
}
const sent=t=>t.commands.map(command=>[command.operation,command.payload]);
/** The server saves the last comment command, as comment `id` when it is new. */
function acceptComment(t,id){
 const command=t.commands.at(-1),task=t.D.tasks.find(x=>x.id==='BIR-079'),editing=command.operation==='discussion.comment.edit';
 const existing=editing?task.comments.find(c=>c.id===command.payload.commentId):null,target=task.comments.find(c=>c.id===command.payload.replyToId),commentId=existing?.id??id;
 command.resolve({entities:[{id:commentId,authorId:existing?.who??t.D.session.userId,rootId:existing?(existing.parentId??existing.id):target?(target.parentId??target.id):commentId,replyToId:existing?.replyToId??command.payload.replyToId??null,content:command.payload.content,mentions:command.payload.mentions,createdAt:Math.floor(Date.now()/1000),revision:(existing?.revision??0)+1}],events:[{}]});
 return settle();
}
/** The server accepts the last block command with this block. */
function acceptBlock(t,block){
 const task=t.D.tasks.find(x=>x.id==='BIR-079');
 t.commands.at(-1).resolve({entities:[{entityType:'taskBlock',id:'b1',taskId:task.internalId,createdBy:t.D.session.userId,createdAt:Math.floor(Date.now()/1000),revision:1,mentions:[],...block}],events:[]});
 return settle();
}
function event(form){return{target:form,preventDefault(){}}}
function block(t,mode,reason='Waiting for approval'){t.A.openModal(mode,'BIR-079');const form=t.d.querySelector('.modal form');form.querySelector('[name="reason"]').value=reason;return t.A.saveBlock(event(form),'BIR-079',mode);}
test('a block needs a reason, and blocking and unblocking and completing send what the person wrote', async () => {
 const t=boot(),task=t.D.tasks.find(t=>t.id==='BIR-079');block(t,'block','');assert.equal(t.commands.length,0);assert(t.d.querySelector('.modal .ferr'));
 block(t,'block');assert.deepEqual(sent(t),[['task.block',{taskId:task.internalId,reason:'Waiting for approval',mentions:[]}]]);
 await acceptBlock(t,{reason:'Waiting for approval'});assert.equal(task.block.reason,'Waiting for approval');assert.equal(t.d.querySelector('.task-block p').textContent,'Waiting for approval');
 block(t,'completeBlocked','Approved');assert.deepEqual(sent(t)[1],['task.unblock-and-complete',{taskId:task.internalId,resolution:'Approved'}]);
});

function typeComment(t,text){const input=t.d.getElementById('cmtIn');input.value=text;input.setSelectionRange(text.length,text.length);t.A.commentInput({currentTarget:input},'BIR-079');return input;}
function mention(t,query,option='everyone'){const input=typeComment(t,query);const items=[...t.d.querySelectorAll('[data-mention-index]')];const chosen=items.find(b=>b.textContent.includes(option));assert(chosen,'Mention option exists');chosen.click();return input;}
test('canonical task refresh preserves the open property picker', () => {
 let facade;
 const t=boot((_D,w)=>{w.OneloopCollaboration={bind(_app,_hooks,value){facade=value;return {};}};});
 const trigger=t.d.querySelector('[aria-label="Assignees"]');t.A.popMulti({currentTarget:trigger,preventDefault(){},stopPropagation(){}},'tpAssign');const option=t.d.querySelector('.pop-opt.multi');option.focus();facade.canonicalTask();assert(t.d.querySelector('.pop'),'canonical refresh keeps the open assignee picker');
});

test('a person who is not a project member cannot comment', () => {
 const t=boot(D=>{D.session.userId='blairq';D.projects[0].members=D.projects[0].members.filter(m=>m.userId!=='blairq');});assert(!t.d.getElementById('cmtIn'));assert.equal(t.A.addComment('BIR-079'),false);assert.equal(t.commands.length,0);
});

test('a comment sends the mentions it shows, and quoted or code text mentions no one', async () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079'),robin=[{kind:'user',userId:'robin',startOffset:0,endOffset:6,label:'@robin'}];
 let input=mention(t,'@rob','robin');typeComment(t,input.value+'Please check.');t.A.addComment(task.id);assert.deepEqual(t.commands[0].payload.mentions,robin);await acceptComment(t,'c1');
 t.A.editComment(task.id,'c1');input=t.d.getElementById('cmtIn');typeComment(t,input.value+' Thanks.');t.A.addComment(task.id);assert.deepEqual(sent(t)[1],['discussion.comment.edit',{commentId:'c1',content:'@robin Please check. Thanks.',mentions:robin}]);await acceptComment(t);
 t.A.editComment(task.id,'c1');typeComment(t,'`'+t.d.getElementById('cmtIn').value+'`');t.A.addComment(task.id);assert.deepEqual(t.commands[2].payload.mentions,[]);
 typeComment(t,'> @eve');assert(!t.d.querySelector('.mention-picker'));typeComment(t,'```\n@eve');assert(!t.d.querySelector('.mention-picker'));
});

test('Clean up now asks the server, and Storage is for instance administrators only', async () => {
 const usage={budgetBytes:100,highWatermarkBytes:80,lowWatermarkBytes:70,usedBytes:90,permanentBytes:0,temporaryBytes:90,cleanedRecords:0,reservedBytes:0,projects:[],recentCleanup:[]};
 const s=bootApp({route:'storage',api:{storageUsage:async()=>usage,cleanupStorage:async()=>({temporaryFilesCleaned:1,bytesReclaimed:90})}});await settle();
 const toasts=[];s.A.toast=text=>toasts.push(text);assert.equal(s.d.querySelector('.topbar h1').textContent,'Storage');s.A.cleanupStorage();await settle();await settle();assert.deepEqual(toasts,['Removed 1 temporary file (90 B)']);
 const denied=bootApp({route:'storage',prepare:D=>{D.users.find(u=>u.id==='taylorwu').admin=false;}});assert(denied.d.querySelector('.page-error').textContent.includes('Access denied'));
});

function typeBlock(t,text){const input=t.d.getElementById('block-reason');input.value=text;input.setSelectionRange(text.length,text.length);t.A.blockReasonInput({currentTarget:input},'BIR-079');return input;}
function pickBlock(t,text,who){const input=typeBlock(t,text);const option=[...t.d.querySelectorAll('[data-mention-index]')].find(b=>b.textContent.includes(who));assert(option);option.click();return input;}
function saveBlockForm(t){return t.A.saveBlock(event(t.d.querySelector('.modal form')),'BIR-079','block');}
test('a block reason sends its mention and leaves the open comment alone', async () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');typeComment(t,'Keep my open comment.');t.A.openModal('block',task.id);
 const input=pickBlock(t,'Waiting for @rob','robin');typeBlock(t,input.value+'to approve.  ');saveBlockForm(t);
 const {reason,mentions}=t.commands[0].payload;assert.equal(reason,'Waiting for @robin to approve.');assert.deepEqual(mentions,[{kind:'user',userId:'robin',startOffset:12,endOffset:18,label:'@robin'}]);
 await acceptBlock(t,{reason,mentions});assert(t.d.querySelector('.task-block .comment-mention'));assert.equal(t.d.getElementById('cmtIn').value,'Keep my open comment.');
 t.A.openModal('block',task.id);pickBlock(t,t.d.getElementById('block-reason').value+' @bla','blairq');saveBlockForm(t);
 assert.equal(t.commands[1].operation,'task.block.update');assert.deepEqual(t.commands[1].payload.mentions.map(item=>item.userId),['robin','blairq']);
});

test('a cancelled block leaves no text behind, and @everyone says how many it notifies', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');t.A.openModal('block',task.id);pickBlock(t,'@eve','everyone');assert(t.d.querySelector('.block-mention-hint').textContent.includes('2 project members'));t.A.closeOverlays();t.A.openModal('block',task.id);assert.equal(t.d.getElementById('block-reason').value,'');assert.equal(t.commands.length,0);
});

test('a block refuses a mention of someone who left, keeps its 500-character limit, and plain text mentions no one', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');t.A.openModal('block',task.id);pickBlock(t,'@rob','robin');t.D.users.find(u=>u.id==='robin').active=false;saveBlockForm(t);assert.equal(t.commands.length,0);assert(t.d.querySelector('.block-mention-feedback').textContent.includes('no longer'));
 t.D.users.find(u=>u.id==='robin').active=true;const input=typeBlock(t,'x'.repeat(494)+' @rob');const before=input.value;t.d.querySelector('[data-mention-index]').click();assert.equal(input.value,before);assert(t.d.querySelector('.block-mention-feedback').textContent.includes('too long'));
 typeBlock(t,'@robin pasted as plain text');saveBlockForm(t);assert.deepEqual(t.commands[0].payload.mentions,[]);
});

test('a cancelled block edit drops its text and mentions and keeps the saved reason', async () => {
 const t=boot();t.A.openModal('block','BIR-079');pickBlock(t,'@rob','robin');assert(!t.d.querySelector('.block-discard'));t.A.closeOverlays();t.A.openModal('block','BIR-079');assert.equal(t.d.getElementById('block-reason').value,'');typeBlock(t,'A plain reason');saveBlockForm(t);await acceptBlock(t,{reason:'A plain reason'});
 t.A.openModal('block','BIR-079');pickBlock(t,t.d.getElementById('block-reason').value+' @bla','blairq');t.A.closeOverlays();t.A.openModal('block','BIR-079');assert.equal(t.d.getElementById('block-reason').value,'A plain reason');saveBlockForm(t);await settle();assert.equal(t.commands.length,1,'the unchanged reason is not sent again');
});

test('a member without Board access is offered no Block task', () => {
 const t=boot(D=>{D.session.userId='blairq';});assert(!t.d.querySelector('.block-task-action'));
});

test('comments, replies and edits drop unsent text on navigation and cancel', async () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');
 typeComment(t,'Saved comment');t.A.addComment(task.id);await acceptComment(t,'c1');
 mention(t,'@rob','robin');t.A.nav('board');t.d.querySelector('[data-confirm-accept]').click();t.A.openTask(task.id);assert.equal(t.d.getElementById('cmtIn').value,'');
 t.A.replyComment(task.id,'c1');mention(t,'@bla','blairq');t.A.cancelCommentMode(task.id);t.A.replyComment(task.id,'c1');assert.equal(t.d.getElementById('cmtIn').value,'');
 t.A.editComment(task.id,'c1');typeComment(t,'Unsent edit');t.A.cancelCommentMode(task.id);t.A.editComment(task.id,'c1');assert.equal(t.d.getElementById('cmtIn').value,'Saved comment');
});

test('the comment box has no file picker, and a reply sends text only', () => {
 const t=boot(D=>{D.tasks.find(t=>t.id==='BIR-079').comments=[{id:'c1',who:'taylorwu',ts:Date.now(),text:'Existing discussion',mentions:[]}];}),task=t.D.tasks.find(t=>t.id==='BIR-079');
 assert(!t.d.querySelector('.comment-file-picker,.comment-file,[data-comment-upload]'));assert(!t.d.querySelector('.collaboration-composer input[type=file]'));
 t.A.replyComment(task.id,'c1');typeComment(t,'Text reply');t.A.addComment(task.id);assert.deepEqual(sent(t),[['discussion.comment.create',{taskId:task.internalId,content:'Text reply',replyToId:'c1',mentions:[]}]]);
});

test('Enter sends, replies and edits; Shift+Enter, composition and repeats do not; mentions are picked first; offline text stays', async () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');
 const key=(options={})=>{let prevented=false;const ev={key:'Enter',currentTarget:t.d.getElementById('cmtIn'),preventDefault(){prevented=true;},stopPropagation(){},...options};t.A.commentKey(ev);return prevented;};
 typeComment(t,'First comment');assert(key());assert.deepEqual(sent(t),[['discussion.comment.create',{taskId:task.internalId,content:'First comment',replyToId:null,mentions:[]}]]);await acceptComment(t,'c1');assert.equal(t.d.activeElement,t.d.getElementById('cmtIn'));
 typeComment(t,'Another line');assert(!key({shiftKey:true}));assert(!key({isComposing:true}));assert(!key({keyCode:229}));assert(key({repeat:true}));assert.equal(t.commands.length,1);
 typeComment(t,'   ');assert(key());assert.equal(t.commands.length,1);assert.equal(t.d.getElementById('cmtIn').value,'   ');
 typeComment(t,'@rob');assert(t.d.querySelector('.mention-picker'));assert(key());assert.equal(t.commands.length,1);assert(t.d.getElementById('cmtIn').value.startsWith('@robin '));typeComment(t,t.d.getElementById('cmtIn').value+'Please review.');assert(key());assert.equal(t.commands[1].payload.mentions[0].userId,'robin');await acceptComment(t,'c2');
 t.A.replyComment(task.id,'c1');typeComment(t,'Reply via Enter');key();assert.equal(t.commands[2].payload.replyToId,'c1');await acceptComment(t,'c3');
 t.A.editComment(task.id,'c1');typeComment(t,'Edited via Enter');key();assert.deepEqual(sent(t)[3],['discussion.comment.edit',{commentId:'c1',content:'Edited via Enter',mentions:[]}]);
 t.A.openModal('block',task.id);const reason=t.d.getElementById('block-reason');reason.value='Keep this multiline';assert(!key({currentTarget:reason,shiftKey:true}));assert.equal(t.commands.length,4);
 const offline=boot();offline.w.Recovery.observeResponse({ok:false,error:new offline.w.TestApiError('Unable to reach oneloop',{code:'network_error'})});const input=typeComment(offline,'Keep my text');offline.A.commentKey({key:'Enter',currentTarget:input,preventDefault(){}});assert.equal(offline.commands.length,0);assert.equal(offline.d.getElementById('cmtIn').value,'Keep my text');
});

test('contextual comment actions, one inline editor, reply composer dismissal, reply-to references, edit cancellation and ownership checks', async () => {
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
 t.A.addComment(task.id);assert.deepEqual(t.commands[0].payload,{taskId:task.internalId,content:'Keep this open',replyToId:'thread-reply',mentions:[]});await acceptComment(t,'saved-reply');assert.equal(task.comments.at(-1).parentId,'thread-root');assert.equal(task.comments.at(-1).replyToId,'thread-reply');assert(!t.d.querySelector('.thread-composer'));assert(input().closest('.comment-composer-home'));assert.equal(t.d.activeElement.dataset.comment,task.comments.at(-1).id);const savedReply=t.d.activeElement;assert(savedReply.classList.contains('comment-save-focus'));input().focus();assert(!savedReply.classList.contains('comment-save-focus'));assert(t.d.querySelector('#toast-region').textContent.includes('Reply added'));assert.equal(t.d.querySelector('.comment-feedback').textContent,'');assert.equal(input().value,'');assert.equal(toggle().getAttribute('aria-expanded'),'true');
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

test('Enter submits block, edit, unblock and completion, picks mentions first, and is guarded against Shift, composition and repeats', async () => {
 const t=bootApp({route:'task/BIR-079',actions:true}),task=t.D.tasks.find(x=>x.id==='BIR-079');let input;
 const open=mode=>{t.A.openModal(mode,task.id);const form=t.d.querySelector('form[data-block-action]');input=form.querySelector('textarea');return form;};
 const key=(options={})=>{const ev={currentTarget:input,key:'Enter',defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...options};t.A.commentKey(ev);return ev;};
 open('block');key();assert.equal(t.commands.length,0);assert(t.d.querySelector('.ferr'));
 typeBlock(t,'Waiting');assert(!key({shiftKey:true}).defaultPrevented);assert(!key({isComposing:true}).defaultPrevented);assert(!key({keyCode:229}).defaultPrevented);assert(key({repeat:true}).defaultPrevented);assert.equal(t.commands.length,0);
 typeBlock(t,'Waiting for @rob');key();assert.equal(t.commands.length,0);assert(input.value.includes('@robin'));key();assert.equal(t.commands[0].operation,'task.block');assert.equal(t.commands[0].payload.mentions[0].userId,'robin');await acceptBlock(t,{reason:'Waiting for @robin'});
 open('block');typeBlock(t,'Updated reason');key();assert.deepEqual([t.commands[1].operation,t.commands[1].payload.reason],['task.block.update','Updated reason']);await acceptBlock(t,{reason:'Updated reason',revision:2});
 open('unblock');input.value='Resolved';assert(!key({shiftKey:true}).defaultPrevented);assert.equal(t.commands.length,2);key();assert.deepEqual(sent(t)[2],['task.unblock',{taskId:task.internalId,resolution:'Resolved'}]);
 t.commands[2].resolve({entities:[{entityType:'taskBlock',id:'b1',taskId:task.internalId,resolved:true}],events:[]});await settle();assert.equal(task.block,null);
 open('block');typeBlock(t,'Final check');key();await acceptBlock(t,{id:'b2',reason:'Final check'});open('completeBlocked');input.value='All checks passed';key();assert.deepEqual(sent(t)[4],['task.unblock-and-complete',{taskId:task.internalId,resolution:'All checks passed'}]);
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
  w.OneloopCollaboration={bind(_app,_hooks,value){facade=value;return {saveComment(input){return new Promise(resolve=>sends.push({input,resolve}));}};}};
 }});
 const task=t.D.tasks.find(item=>item.id==='BIR-079');
 return {...t,task,sends,
  /** The server saves send `index`, and the page hears of it. */
  save(index){const {input,resolve}=sends[index],comment={id:`saved-${index}`,who:t.D.session.userId,ts:Date.now(),text:input.text,mentions:input.mentions,parentId:null,revision:1};(task.comments??=[]).push(comment);facade.commentSaved(task.id,comment,{mode:input.mode,targetId:input.targetId,interactionId:input.interactionId,changed:true});resolve(true);},
  /** Send `index` can't be saved, with `error`: by default a refusal. */
  fail(index,error=new ApiError('Too many requests',{status:429,code:'rate_limited'})){const {input,resolve}=sends[index];input.unsent(error);resolve(false);},
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

test('a comment whose result is unknown is never joined to new text; it comes back alone, so it is saved once',async()=>{
 const t=sendingComments();
 typeComment(t,'First comment');t.A.addComment('BIR-079');
 typeComment(t,'Second comment');
 t.fail(0,new ApiError('Unable to reach oneloop',{code:'network_error',uncertain:true}));await settle();
 assert.equal(t.d.getElementById('cmtIn').value,'Second comment','the first may be saved already, so it stays out of this one');
 assert.equal(t.w.Recovery.hasUnsavedInput(),true,'leaving oneloop would lose it');
 t.A.addComment('BIR-079');assert.equal(t.sends[1].input.text,'Second comment');
 t.save(1);await settle();
 assert.equal(t.d.getElementById('cmtIn').value,'First comment','it comes back alone once the box is empty');
 t.A.addComment('BIR-079');
 assert.equal(t.sends[2].input.text,'First comment');
 assert.equal(t.sends[2].input.interactionId,t.sends[0].input.interactionId,'sent again with its interaction, so the server adds it once');
});

test('a comment that fails after its writer left the task page comes back when they return',async()=>{
 const t=sendingComments();
 typeComment(t,'Sent before leaving');t.A.addComment('BIR-079');
 t.A.nav('board');t.fail(0);await settle();
 t.A.openTask('BIR-079');await settle();
 assert.equal(t.d.getElementById('cmtIn').value,'Sent before leaving');
});

test('Enter on the box its comment just left says nothing',async()=>{
 const t=sendingComments();
 typeComment(t,'On its way');t.A.addComment('BIR-079');t.A.addComment('BIR-079');
 assert.equal(t.sends.length,1);assert.equal(t.d.querySelector('.comment-feedback').textContent,'');
 t.save(0);await settle();t.A.addComment('BIR-079');
 assert.equal(t.d.querySelector('.comment-feedback').textContent,'Write a comment first.','with nothing on its way, an empty box is a mistake');
});

test('a deleted comment offers Undo, which brings its text back',async()=>{
 const requests=[];
 const t=productionComments(async(operation,payload,options)=>{
  requests.push([operation,payload.commentId,options.expectedRevision]);
  const deleted=operation==='discussion.comment.delete';
  Object.assign(t.comment,{content:deleted?null:'Original',deletedAt:deleted?1700000100:null,revision:options.expectedRevision+1});
  return {entities:[{...t.comment}],events:[]};
 });
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

test('a tab whose live updates a newer tab took says so, and Resume takes them back', () => {
 const t=bootApp({route:'board'}),notice=()=>t.d.querySelector('#app .connection-notice span')?.textContent??null;
 t.events[0].emit('replaced');
 assert.equal(notice(),'Live updates are paused in this tab.');
 t.d.querySelector('#app .connection-notice button').click();
 assert.equal(t.events.length,2,'Resume opens a new stream');
 t.events[1].emit('open');
 assert.equal(notice(),null);
});

test('a block reason with extra spaces keeps its mention where the reason shows it', () => {
 const t=boot(),task=t.D.tasks.find(x=>x.id==='BIR-079');t.A.openModal('block',task.id);
 const input=pickBlock(t,'  Waiting    for @rob','robin');typeBlock(t,input.value+'to approve.  ');saveBlockForm(t);
 const {reason,mentions}=t.commands[0].payload;assert.equal(reason,'Waiting    for @robin to approve.');
 assert.deepEqual(mentions,[{kind:'user',userId:'robin',startOffset:15,endOffset:21,label:'@robin'}]);
});
