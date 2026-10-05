import assert from 'node:assert/strict';
import test, {mock} from 'node:test';
import {mapInboxItem} from '../../../../src/data/inbox-mapper.js';
import {createRecoveryController} from '../../../../src/features/recovery/controller.js';
import {installCollaborationController,mapActivity,mapComment,mentionsToWire} from '../../../../src/features/collaboration/controller.js';

// The controller coalesces live reads with 60 ms timers. Tests that observe
// that coalescing drive a mocked clock and let promise chains settle between
// steps instead of sleeping.
let mockedClock=false;
function useMockedClock(){mock.timers.enable({apis:['setTimeout']});mockedClock=true;}
test.afterEach(()=>{if(mockedClock)mock.timers.reset();mockedClock=false;});
const settle=()=>new Promise((resolve)=>setImmediate(resolve));
async function delay(milliseconds){for(let elapsed=0;elapsed<milliseconds;elapsed+=10){mock.timers.tick(10);await settle();}}
const tick=()=>mockedClock?delay(1):new Promise((resolve)=>setTimeout(resolve,0));

function fixture(overrides={}){
  const data={
    session:{id:'s1',userId:'u1'},
    users:[{id:'u1',username:'taylorwu',name:'Nico'},{id:'u2',username:'bob',name:'Bob'}],
    projects:[{id:'p1',name:'Project'}],notifications:[],
    tasks:[{id:'ONE-101',internalId:'opaque-task',projectId:'p1',comments:[],activity:[]}],
    ...overrides.data,
  };
  const commandCalls=[],apiCalls=[],listeners=new Set(),published=[];
  const api={
    comments:async(taskId,options)=>{apiCalls.push(['comments',taskId,options]);return {items:[],nextCursor:null};},
    activity:async(projectId,options)=>{apiCalls.push(['activity',projectId,options]);return {items:[],nextCursor:null};},
    inbox:async(options)=>{apiCalls.push(['inbox',options]);return {items:[],nextCursor:null,unreadCount:0,filteredCount:0};},
    ...overrides.api,
  };
  const transport={api,data,commands:{execute:async(...args)=>{commandCalls.push(args);return {entities:[],events:[],replayed:false};}},reload:async()=>({stale:false}),publish(change){published.push(change);},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},...overrides.transport};
  const app={context:()=>({view:'task',taskId:'ONE-101',projectId:'p1'}),toast(){},openTask(){},...overrides.app};
  const pages=[],saved=[],inboxes=[];
  const facade={filter:()=>({projects:[],unread:false,archived:false}),taskPage:(...args)=>pages.push(args),commentSaved:(...args)=>saved.push(args),commentDeleted(){},inboxPage:(value)=>inboxes.push(value),feedback(){},target(){},unreadCount(){},...overrides.facade};
  const events={listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},close(){this.closed=true;}};
  const controller=installCollaborationController({transport,eventSourceFactory:overrides.eventSourceFactory??(()=>events),visibility:overrides.visibility});
  controller.bind(app,{view:()=>app.context().view},facade);
  return {controller,data,transport,app,facade,events,pages,saved,inboxes,commandCalls,apiCalls,listeners,published};
}

for(const kind of ['reconcile','activity.changed'])test(`live ${kind} refreshes the project list without a selected project`,async()=>{
  useMockedClock();
  const reloads=[];
  const t=fixture({data:{projects:[]},app:{context:()=>({view:'no-projects',projectId:null})},transport:{reload:async options=>{reloads.push(options);return {stale:false};}}});
  try{
    const hint=kind==='reconcile'?{}:{projectId:'first-project',entityType:'membership',entityId:'new-member',entityRevision:1};
    for(let i=0;i<3;i++)t.events.listeners[kind==='reconcile'?'reconcile':'hint']({data:JSON.stringify({kind,...hint})});
    await delay(90);
    assert.equal(reloads.length,1);assert.equal(reloads[0].background,true);assert.equal(reloads[0].viewOnly,false);
  }finally{t.controller.dispose();}
});

test('maps opaque server entities, second timestamps and UTF-16 mention ranges exactly once',()=>{
  const text='Hi 👋 @bob';
  assert.deepEqual(mentionsToWire(text,[{id:'u2',label:'bob',start:6,end:10}]),[{kind:'user',userId:'u2',startOffset:6,endOffset:10,label:'@bob'}]);
  const comment=mapComment({id:'c1',authorId:'u2',authorName:'Bob',rootId:'root',replyToId:'root',content:text,mentions:[{kind:'user',userId:'u2',startOffset:6,endOffset:10,label:'@bob'}],createdAt:10,editedAt:11,deletedAt:null,revision:3});
  assert.equal(comment.ts,10_000);assert.equal(comment.editedAt,11_000);assert.equal(comment.parentId,'root');assert.equal(comment.mentions[0].label,'bob');
  const inbox=mapInboxItem({id:'n1',eventType:'discussion.mention',actorName:'Bob',actorUserId:'u2',projectId:'p1',taskId:'opaque-task',taskKey:'ONE-101',taskTitle:'Review',destinationAvailable:true,createdAt:12,readAt:null,archivedAt:null});
  assert.equal(inbox.actorId,'u2');assert.equal(inbox.taskId,'opaque-task');assert.equal(inbox.taskKey,'ONE-101');assert.equal(inbox.createdAt,12_000);
});

test('task reconciliation uses opaque IDs, server activity and scoped refresh metadata',async()=>{
  const t=fixture({api:{
    comments:async(taskId)=>({items:[{id:'c1',projectId:'p1',taskId,authorId:'u2',authorName:'Bob',rootId:'c1',replyToId:null,content:'Hello',mentions:[],createdAt:20,editedAt:null,deletedAt:null,revision:1}],nextCursor:'comments-next'}),
    activity:async()=>({items:[
      {id:'a1',eventType:'comment.created',createdAt:19},
      {id:'a2',eventType:'comment.edited',actorUserId:'u2',actorName:'Bob',createdAt:21,metadata:{}},
    ],nextCursor:'activity-next'}),
  }});
  t.controller.beforeRender({userId:'u1',view:'task',projectId:'p1',taskId:'ONE-101'});
  t.controller.mount({view:'task',taskId:'ONE-101'});await tick();
  assert.equal(t.data.tasks[0].comments[0].id,'c1');assert.equal(t.data.tasks[0].comments[0].ts,20_000);
  assert.deepEqual(t.data.tasks[0].activity.map((item)=>item.text),['edited a comment']);
  assert.deepEqual(t.pages,[['ONE-101',{loaded:false,loading:true,error:false,hasMore:false,background:false}],['ONE-101',{loaded:true,loading:false,error:false,hasMore:true,background:false}]]);
});

test('same-second comments and projections retain server IDs through initial, appended and reconciled pages',async()=>{
  useMockedClock();
  let phase=0;
  const comment=(id)=>({id,projectId:'p1',taskId:'opaque-task',authorId:'u2',authorName:'Bob',rootId:id,replyToId:null,content:id,mentions:[],createdAt:20,editedAt:null,deletedAt:null,revision:1});
  const activity=(id)=>({id,eventType:'task.updated',actorUserId:'u2',actorName:'Bob',createdAt:20,fieldKey:'title',metadata:{}});
  const t=fixture({api:{request:async()=>({id:'opaque-task',projectId:'p1',epicId:'e1',taskKey:'ONE-101',title:'Reconciled',description:'',status:'planning',position:1,deadline:null,createdAt:20,updatedAt:20,revision:1,assigneeIds:[],activeBlock:null})}});
  const page=(items,nextCursor)=>({items,nextCursor});
  t.transport.api.comments=async(_taskId,options)=>page(phase===0?[comment('c2'),comment('c1')]:phase===1?[comment('c3')]:[comment('c4'),comment('c0')],phase===2?null:'more-comments');
  t.transport.api.activity=async(_projectId,options)=>page(phase===0?[activity('a2'),activity('a1')]:phase===1?[activity('a0')]:[activity('a3'),activity('a1')],phase===2?null:'more-activity');
  t.controller.beforeRender({userId:'u1',view:'task',projectId:'p1',taskId:'ONE-101'});
  t.controller.mount({view:'task',taskId:'ONE-101'});await tick();
  assert.deepEqual(t.data.tasks[0].comments.map((item)=>item.id),['c1','c2']);
  assert.deepEqual(t.data.tasks[0].activity.map((item)=>item.id),['a1','a2']);
  phase=1;await t.controller.moreTask('ONE-101');
  assert.deepEqual(t.data.tasks[0].comments.map((item)=>item.id),['c1','c2','c3']);
  assert.deepEqual(t.data.tasks[0].activity.map((item)=>item.id),['a0','a1','a2']);
  phase=2;t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed'})});await delay(90);
  assert.deepEqual(t.data.tasks[0].comments.map((item)=>item.id),['c0','c4']);
  assert.deepEqual(t.data.tasks[0].activity.map((item)=>item.id),['a1','a3']);
});

test('comment commands preserve canonical server content and do not publish local audit entries',async()=>{
  const t=fixture();
  t.transport.commands.execute=async(...args)=>{t.commandCalls.push(args);return {entities:[{id:'c2',projectId:'p1',taskId:'opaque-task',authorId:'u1',authorName:'Nico',rootId:'c2',replyToId:null,content:'Saved',mentions:[],createdAt:30,editedAt:null,deletedAt:null,revision:1}],events:[{id:'a2'}],replayed:false};};
  const task=t.data.tasks[0];
  assert.equal(await t.controller.saveComment({task,mode:'comment',targetId:null,commentId:null,revision:null,text:'Saved',mentions:[],interactionId:'logical-1'}),true);
  assert.equal(t.commandCalls[0][0],'discussion.comment.create');assert.equal(t.commandCalls[0][1].taskId,'opaque-task');
  assert.equal(task.comments[0].text,'Saved');assert.equal(task.activity.length,0);
  assert.equal(t.saved.length,1);assert.equal(t.saved[0][1].id,'c2');
});

test('double comment submission shares the complete interaction and publishes success once',async()=>{
  const t=fixture();let release;const pending=new Promise((resolve)=>{release=resolve;});
  t.transport.commands.execute=async(...args)=>{t.commandCalls.push(args);await pending;return {entities:[{id:'c2',projectId:'p1',taskId:'opaque-task',authorId:'u1',authorName:'Nico',rootId:'c2',replyToId:null,content:'Saved',mentions:[],createdAt:30,editedAt:null,deletedAt:null,revision:1}],events:[{id:'a2'}]};};
  const input={task:t.data.tasks[0],mode:'comment',targetId:null,commentId:null,revision:null,text:'Saved',mentions:[],interactionId:'logical-1'};
  const first=t.controller.saveComment(input),second=t.controller.saveComment(input);assert.strictEqual(first,second);release();await Promise.all([first,second]);
  assert.equal(t.commandCalls.length,1);assert.equal(t.saved.length,1);
});

test('failed comment writes keep server data unchanged and report inline plus global feedback',async()=>{
  const toasts=[],feedback=[];const t=fixture({app:{toast:(...args)=>toasts.push(args)},facade:{feedback:(message)=>feedback.push(message)}});
  t.transport.commands.execute=async()=>{throw Object.assign(new Error('Still offline'),{code:'network_error',uncertain:true});};
  const ok=await t.controller.saveComment({task:t.data.tasks[0],mode:'comment',text:'Keep this text',mentions:[],interactionId:'failed-1'});
  assert.equal(ok,false);assert.equal(t.data.tasks[0].comments.length,0);assert.deepEqual(feedback,['Connection lost. Check your connection and try again.']);assert.deepEqual(toasts,[['Connection lost. Check your connection and try again.','error']]);
});

test('comment saves let the gateway compare changed intent instead of blindly retrying old content',async()=>{
  let retries=0,executes=0;
  const commands={
    hasUncertain:()=>true,
    retry:async()=>{retries++;throw new Error('stale content was retried');},
    execute:async(_operation,payload)=>{executes++;return {entities:[{id:'c2',projectId:'p1',taskId:'opaque-task',authorId:'u1',authorName:'Nico',rootId:'c2',replyToId:null,content:payload.content,mentions:[],createdAt:30,editedAt:null,deletedAt:null,revision:1}],events:[]};},
  };
  const t=fixture({transport:{commands}}),task=t.data.tasks[0];
  assert.equal(await t.controller.saveComment({task,mode:'comment',text:'New intent',mentions:[],interactionId:'same-editor'}),true);
  assert.equal(executes,1);assert.equal(retries,0);assert.equal(task.comments[0].text,'New intent');
});

test('an edited-comment conflict reviews the canonical value before an explicit latest-revision retry',async()=>{
  const previous=globalThis.OneloopRecovery;let commandCalls=0,reviewed='';
  try{
    const t=fixture({facade:{commentEditor:()=>({})},api:{
      comments:async()=>({items:[{id:'c1',projectId:'p1',taskId:'opaque-task',authorId:'u1',authorName:'Nico',rootId:'c1',replyToId:null,content:'Latest saved',mentions:[],createdAt:20,editedAt:21,deletedAt:null,revision:3}],nextCursor:null}),
      activity:async()=>({items:[],nextCursor:null}),
    }});
    t.data.tasks[0].comments=[{id:'c1',who:'u1',text:'Old',revision:1,ts:20_000}];
    t.transport.commands.execute=async(_operation,_payload,options)=>{
      commandCalls++;
      if(options.expectedRevision===1)throw Object.assign(new Error('record changed; latest revision is 3'),{status:409,code:'conflict'});
      assert.equal(options.expectedRevision,3);
      return {entities:[{id:'c1',projectId:'p1',taskId:'opaque-task',authorId:'u1',authorName:'Nico',rootId:'c1',replyToId:null,content:'Keep mine',mentions:[],createdAt:20,editedAt:22,deletedAt:null,revision:4}],events:[{id:'a4'}]};
    };
    globalThis.OneloopRecovery={
      isRevisionConflict:()=>true,
      async resolveConflict(input){await input.reloadLatest();const latest=input.latestEntity();reviewed=input.target.latestValue(latest);return {saved:true,result:await input.retry(latest.revision)};},
    };
    const ok=await t.controller.saveComment({task:t.data.tasks[0],mode:'edit',commentId:'c1',revision:1,text:'Keep mine',mentions:[],interactionId:'edit-conflict'});
    assert.equal(ok,true);assert.equal(reviewed,'Latest saved');assert.equal(commandCalls,2);assert.equal(t.data.tasks[0].comments[0].text,'Keep mine');
  }finally{if(previous===undefined)delete globalThis.OneloopRecovery;else globalThis.OneloopRecovery=previous;}
});

test('Inbox reads use server filters, counts and cursor pagination; bulk changes keep the same filter',async()=>{
  let page=0;const t=fixture({api:{inbox:async(options)=>{
    page++;return {items:[{id:`n${page}`,eventType:'task.assigned',actorName:'Bob',actorUserId:'u2',projectId:'p1',projectName:'Project',taskId:'opaque-task',taskKey:'ONE-101',taskTitle:'Review',destinationAvailable:true,createdAt:40-page,readAt:null,archivedAt:null}],nextCursor:page===1?'next':null,unreadCount:7,filteredCount:12};
  }}});
  const filter={projects:['p1'],unread:true,archived:false};t.facade.filter=()=>filter;
  await t.controller.loadInbox(filter);assert.equal(t.data.notifications.length,1);assert.equal(t.inboxes.at(-1).unreadCount,7);assert.equal(t.inboxes.at(-1).filteredCount,12);
  await t.controller.moreInbox(filter);assert.equal(t.data.notifications.length,2);
  assert.equal(await t.controller.bulk('read',filter),true);
  assert.equal(t.commandCalls.at(-1)[0],'inbox.bulkMarkRead');assert.deepEqual(t.commandCalls.at(-1)[1].filter,{projectIds:['p1'],unreadOnly:true,archived:false});
});

test('first read failure ends loading, Retry succeeds, and background failures keep loaded data',async()=>{
  let inboxFails=true,taskFails=true,taskAttempts=0;
  const notice={id:'n1',eventType:'task.assigned',actorName:'Bob',actorUserId:'u2',projectId:'p1',taskId:'opaque-task',taskKey:'ONE-101',taskTitle:'Review',destinationAvailable:true,createdAt:40};
  const comment={id:'c1',authorId:'u2',authorName:'Bob',rootId:'c1',content:'Saved reply',mentions:[],createdAt:20,revision:1};
  const t=fixture({api:{
    inbox:async()=>{if(inboxFails)throw new Error('Unavailable');return {items:[notice],nextCursor:null,unreadCount:1,filteredCount:1};},
    comments:async()=>{taskAttempts++;if(taskFails)throw new Error('Unavailable');return {items:[comment],nextCursor:null};},
  }});
  const filter={projects:[],unread:false,archived:false};
  await t.controller.loadInbox(filter);
  assert.equal(t.inboxes.at(-1).loading,false);assert.equal(t.inboxes.at(-1).loaded,false);assert.equal(t.inboxes.at(-1).error,true);
  assert.equal(t.data.notifications.length,0);
  inboxFails=false;await t.controller.loadInbox(filter);
  assert.equal(t.inboxes.at(-1).loaded,true);assert.equal(t.inboxes.at(-1).error,false);assert.equal(t.data.notifications[0].id,'n1');
  inboxFails=true;await t.controller.loadInbox(filter);
  assert.equal(t.inboxes.at(-1).loaded,true);assert.equal(t.inboxes.at(-1).error,true);assert.equal(t.data.notifications[0].id,'n1');
  await t.controller.loadTaskPage('ONE-101');
  assert.equal(t.pages.at(-1)[1].loaded,false);assert.equal(t.pages.at(-1)[1].loading,false);assert.equal(t.pages.at(-1)[1].error,true);
  t.controller.mount({view:'task',taskId:'ONE-101'});assert.equal(taskAttempts,1);
  taskFails=false;await t.controller.loadTaskPage('ONE-101');
  assert.equal(t.pages.at(-1)[1].loaded,true);assert.equal(t.data.tasks[0].comments[0].text,'Saved reply');
  taskFails=true;await t.controller.loadTaskPage('ONE-101');
  assert.equal(t.pages.at(-1)[1].loaded,true);assert.equal(t.pages.at(-1)[1].error,true);assert.equal(t.data.tasks[0].comments[0].text,'Saved reply');
});

test('activity mapping keeps lifecycle metadata and drops comment creation duplicates',()=>{
  assert.equal(mapActivity({eventType:'comment.replied'},[]),null);
  const event=mapActivity({id:'e1',eventType:'task.blocked',actorUserId:'u1',actorMcpGrantId:'g1',actorAppName:'Planning Assistant',createdAt:5,metadata:{blockId:'b1'}},[]);
  assert.equal(event.text,'blocked the task');assert.equal(event.blockId,'b1');assert.equal(event.ts,5000);assert.equal(event.actorAppName,'Planning Assistant');assert.equal(event.actorMcpGrantId,'g1');
  assert.equal(mapActivity({eventType:'task.assignee.added',before:null,after:'u2'},[{id:'u2',name:'Bob'}]).text,'assigned Bob');
  assert.equal(mapActivity({eventType:'task.assignee.removed',before:'u2',after:null},[{id:'u2',name:'Bob'}]).text,'unassigned Bob');
  assert.equal(mapActivity({eventType:'attachment.cleaned',createdAt:6,metadata:{name:'old.txt'}},[]).text,'Temporary file removed during storage cleanup: old.txt');
});

test('SSE reconciliation passively refreshes canonical task fields before scoped discussion data',async()=>{
  useMockedClock();
  let request;
  const canonical={id:'opaque-task',projectId:'p1',epicId:'e1',taskKey:'ONE-101',title:'Changed elsewhere',description:'',status:'in_progress',position:1,deadline:null,createdAt:1,updatedAt:2,revision:2,assigneeIds:[],activeBlock:null};
  let refreshed=0;
  const t=fixture({api:{request:async(path,options)=>{request={path,options};return canonical;}},facade:{canonicalTask:()=>refreshed++}});
  t.controller.beforeRender({userId:'u1',view:'task',projectId:'p1',taskId:'ONE-101'});
  t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed'})});await delay(90);
  assert.deepEqual(t.published,[{type:'sse',kind:'activity.changed',taskId:'ONE-101'}]);
  assert.equal(request.path,'/api/tasks/opaque-task');assert.equal(request.options.background,true);
  assert.equal(t.data.tasks[0].title,'Changed elsewhere');assert.equal(refreshed,1);
  assert.ok(t.apiCalls.some(([name,_id,options])=>name==='comments'&&options.background===true));
});

test('SSE board hints coalesce, treat null revisions as unknown and wait for optimistic motion',async()=>{
  useMockedClock();
  const context={view:'board',projectId:'p1'},reloads=[];
  const t=fixture({
    app:{context:()=>context,_boardMovePending:false},
    transport:{reload:async(options)=>{reloads.push(options);return {stale:false};}},
  });
  t.data.tasks[0].revision=2;
  t.controller.beforeRender({userId:'u1',...context});

  t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'task',entityId:'opaque-task',entityRevision:null})});
  t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'task',entityId:'opaque-task',entityRevision:null})});
  await delay(90);
  assert.equal(reloads.length,1);assert.equal(reloads[0].viewOnly,true);

  t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'task',entityId:'opaque-task',entityRevision:2})});
  await delay(90);assert.equal(reloads.length,1);

  t.app._boardMovePending=true;
  t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'task',entityId:'opaque-task',entityRevision:3})});
  await delay(90);assert.equal(reloads.length,1);
  t.data.tasks[0].revision=3;t.app._boardMovePending=false;
  await delay(90);assert.equal(reloads.length,1);
  t.controller.dispose();
});

test('SSE reconciliation reloads metadata on task routes and ignores unrelated task hints',async()=>{
  useMockedClock();
  const context={view:'task',taskId:'ONE-101',projectId:'p1'},reloads=[];
  const t=fixture({
    app:{context:()=>context},
    transport:{reload:async(options)=>{reloads.push(options);return {stale:false};}},
  });
  t.controller.beforeRender({userId:'u1',...context});
  t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'task',entityId:'other-task',taskId:'other-task',entityRevision:2})});
  await tick();assert.equal(reloads.length,0);assert.equal(t.apiCalls.length,0);

  t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'epic',entityId:'e1',entityRevision:2})});
  await delay(90);
  assert.equal(reloads.length,1);assert.equal(reloads[0].background,true);
  assert.ok(t.apiCalls.some(([name])=>name==='comments'));

  t.events.listeners.reconcile({data:JSON.stringify({kind:'reconcile'})});
  await delay(90);
  assert.equal(reloads.length,2);
  t.controller.dispose();
});

test('a session change cancels queued projection reconciliation',async()=>{
  useMockedClock();
  const context={view:'board',projectId:'p1'},reloads=[];
  const t=fixture({app:{context:()=>context},transport:{reload:async(options)=>{reloads.push(options);return {stale:false};}}});
  t.controller.beforeRender({userId:'u1',...context});
  t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'task',entityId:'opaque-task',entityRevision:2})});
  t.data.session={id:'s2',userId:'u2'};for(const listener of t.listeners)listener({type:'auth'});
  await delay(90);assert.deepEqual(reloads,[]);
  t.controller.dispose();
});

test('SSE lifecycle reports live-channel recovery without treating a healthy API as offline',async()=>{
  const lifecycle=[];let expired=0;
  const previous=globalThis.OneloopRecovery;
  globalThis.OneloopRecovery={liveConnected:()=>lifecycle.push('connected'),liveDisconnected:()=>lifecycle.push('disconnected'),sessionExpired:()=>{expired++;return true;}};
  try{
    const t=fixture({api:{request:async()=>{throw Object.assign(new Error('Ended'),{status:401});}}});
    t.events.listeners.open({});
    t.events.listeners.error({});await tick();
    assert.deepEqual(lifecycle,['connected','disconnected']);assert.equal(expired,1);
  }finally{if(previous===undefined)delete globalThis.OneloopRecovery;else globalThis.OneloopRecovery=previous;}
});

test('task access loss delegates to the shell state without a stale project toast',async()=>{
  useMockedClock();
  const previous=globalThis.OneloopRecovery,states=[],toasts=[];
  globalThis.OneloopRecovery={handleRouteError:(error,options)=>states.push([error.status,options.background])};
  try{
    const t=fixture({api:{request:async()=>{throw Object.assign(new Error('project was not found'),{status:404,code:'not_found'});}},app:{toast:(...args)=>toasts.push(args)}});
    t.controller.beforeRender({userId:'u1',view:'task',projectId:'p1',taskId:'ONE-101'});
    t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed'})});await delay(90);
    assert.deepEqual(states,[[404,true]]);assert.deepEqual(toasts,[]);
  }finally{if(previous===undefined)delete globalThis.OneloopRecovery;else globalThis.OneloopRecovery=previous;}
});

test('older activity does not restart exhausted comments and retains reply context/counts',async()=>{
  const root={id:'root',rootId:'root',authorId:'u1',createdAt:1,content:null,deletedAt:2,revision:2};
  const reply={id:'reply',rootId:'root',replyToId:'root',authorId:'u2',createdAt:100,content:'Recent reply',revision:1};
  let commentsCalls=0,activityCalls=0;
  const t=fixture({api:{
    comments:async()=>{commentsCalls++;return {items:[reply],context:[root],replyCounts:{root:80},nextCursor:null};},
    activity:async(_id,options)=>{activityCalls++;return {items:[{id:options.cursor?'old':'new',eventType:'task.updated',createdAt:options.cursor?10:110}],nextCursor:options.cursor?null:'older-activity'};},
  }});
  t.controller.beforeRender({userId:'u1',view:'task',projectId:'p1',taskId:'ONE-101'});
  t.controller.mount({view:'task',taskId:'ONE-101'});await tick();
  await t.controller.moreTask('ONE-101');
  assert.equal(commentsCalls,1);assert.equal(activityCalls,2);
  assert.deepEqual(t.data.tasks[0].comments.map(item=>item.id),['root','reply']);
  assert.equal(t.data.tasks[0].comments[0].replyCount,80);
  assert.equal(t.data.tasks[0].comments[0].deleted,true);
  assert.equal(t.pages.at(-1)[1].hasMore,false);
  t.controller.dispose();
});

test('block activity retains reasons and resolutions after the resolved-block panel is gone',()=>{
  assert.equal(mapActivity({eventType:'task.blocked',after:{reason:'Waiting for approval'},createdAt:1}).text,'blocked the task: Waiting for approval');
  assert.equal(mapActivity({eventType:'task.block.reason.updated',after:{reason:'Waiting for documents'},createdAt:2}).text,'edited the block reason: Waiting for documents');
  assert.equal(mapActivity({eventType:'task.unblocked',after:{resolution:'Approved'},createdAt:3}).text,'unblocked the task: Approved');
});

test('failed discussion loading after navigation cannot replace the current page',async()=>{
  const previous=globalThis.OneloopRecovery,errors=[],toasts=[];let rejectComments;
  globalThis.OneloopRecovery={handleRouteError:error=>errors.push(error)};
  const t=fixture({api:{comments:()=>new Promise((_resolve,reject)=>{rejectComments=reject;})},app:{toast:message=>toasts.push(message)}});
  try{
    t.controller.beforeRender({userId:'u1',view:'task',projectId:'p1',taskId:'ONE-101'});
    const pending=t.controller.loadTaskPage('ONE-101');
    t.controller.beforeRender({userId:'u1',view:'profile',projectId:'p1'});
    rejectComments(Object.assign(new Error('No longer visible'),{status:403}));
    assert.deepEqual(await pending,{stale:true});assert.deepEqual(errors,[]);assert.deepEqual(toasts,[]);
    assert.equal(t.pages.length,1);assert.equal(t.pages[0][1].loading,true);
  }finally{t.controller.dispose();globalThis.OneloopRecovery=previous;}
});

test('task and Inbox hint bursts share reads and retain one follow-up during a slow read',async()=>{
  useMockedClock();
  let release,commentReads=0,inboxReads=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const t=fixture({api:{comments:async()=>{commentReads++;if(commentReads===1)await gate;return {items:[],nextCursor:null};},inbox:async()=>{inboxReads++;return {items:[],nextCursor:null,unreadCount:0};}}});
  t.controller.beforeRender({userId:'u1',view:'task',projectId:'p1',taskId:'ONE-101'});
  const taskHint=()=>t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',taskId:'opaque-task',entityType:'comment'})});
  const inboxHint=()=>t.events.listeners.hint({data:JSON.stringify({kind:'inbox.changed'})});
  for(let i=0;i<20;i++){taskHint();inboxHint();}
  await delay(90);assert.equal(commentReads,1);assert.equal(inboxReads,1);
  for(let i=0;i<20;i++)taskHint();
  await delay(90);assert.equal(commentReads,1);
  release();await delay(90);assert.equal(commentReads,2);
  assert.equal(t.apiCalls.filter(([kind])=>kind==='activity').length,2);
  t.controller.dispose();
});

test('Inbox avatars use the immutable server identity and never guess from names',()=>{
  const first=mapInboxItem({id:'one',actorName:'Same name',actorUserId:'alice'});
  const second=mapInboxItem({id:'two',actorName:'Same name',actorUserId:'bob'});
  assert.equal(first.actorId,'alice');assert.equal(second.actorId,'bob');
  assert.equal(mapInboxItem({id:'legacy',actorName:'Same name'}).actorId,null);
  assert.equal(mapInboxItem({id:'unavailable',actorName:null,actorUserId:null}).actorId,null);
});

test('block Inbox wording distinguishes direct and broadcast mentions and keeps legacy rows readable',()=>{
  for(const [eventType,reason] of [
    ['task.block.mentioned','block-mention'],['task.block.everyone','block-everyone'],
    ['task.blocked','blocked'],['task.block.reason.updated','block-mention'],
  ])assert.equal(mapInboxItem({id:'block-item',eventType,blockId:'episode',destinationAvailable:true}).reason,reason);
});

test('a replacement task projection reloads discussion rather than trusting an old loaded marker',async()=>{
  const t=fixture();t.controller.mount({view:'task',taskId:'ONE-101'});await tick();assert.equal(t.apiCalls.length,2);
  t.data.tasks[0]={...t.data.tasks[0],comments:[],activity:[]};t.controller.mount({view:'task',taskId:'ONE-101'});await tick();assert.equal(t.apiCalls.length,4);
  t.controller.dispose();
});


test('hidden tabs release SSE slots and resume without a stale bootstrap cursor',async()=>{
  useMockedClock();
  const visibility=new EventTarget();visibility.visibilityState='hidden';
  const streams=[];
  const t=fixture({visibility,eventSourceFactory:url=>{
    const stream={url,listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},close(){this.closed=true;}};
    streams.push(stream);return stream;
  }});
  try{
    t.data.syncCursor='old-snapshot';
    assert.equal(streams.length,0);
    visibility.visibilityState='visible';visibility.dispatchEvent(new Event('visibilitychange'));
    assert.equal(streams.length,1);assert.equal(streams[0].url,'/api/events');
    visibility.visibilityState='hidden';visibility.dispatchEvent(new Event('visibilitychange'));
    assert.equal(streams[0].closed,true);
    streams[0].listeners.hint({data:'{"kind":"inbox.changed"}'});
    assert.equal(t.published.length,0);
    visibility.visibilityState='visible';visibility.dispatchEvent(new Event('visibilitychange'));
    assert.equal(streams.length,2);
    streams[1].listeners.reconcile({data:'{"kind":"reconcile"}'});await delay(90);
    assert.ok(t.apiCalls.some(([kind])=>kind==='inbox'));
    t.data.session=null;for(const fn of t.listeners)fn({type:'bootstrap'});
    assert.equal(streams[1].closed,true);
    visibility.dispatchEvent(new Event('visibilitychange'));assert.equal(streams.length,2);
  }finally{t.controller.dispose();}
  visibility.dispatchEvent(new Event('visibilitychange'));assert.equal(streams.length,2);
});

test('discussion hints skip unrelated views but refresh the visible Inbox across project context',async()=>{
  useMockedClock();
  for(const view of ['board','roadmap','profile','users','settings','storage','inbox']){
    const reloads=[];let inboxReads=0;
    const t=fixture({app:{context:()=>({view,projectId:'other'})},transport:{reload:async scope=>{reloads.push(scope);return {}; }},api:{inbox:async()=>{inboxReads++;return {items:[],nextCursor:null};}}});
    t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',entityType:'comment',projectId:'p1'})});
    t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',entityType:'attachment',projectId:'p1'})});
    await delay(80);assert.equal(reloads.length,0,view);assert.equal(inboxReads,view==='inbox'?1:0,view);t.controller.dispose();
  }
});

test('task hints still reconcile Board and skip account views',async()=>{
  useMockedClock();
  for(const view of ['board','profile','users','settings','storage','inbox']){
    const reloads=[];const t=fixture({app:{context:()=>({view,projectId:'p1'})},transport:{reload:async scope=>{reloads.push(scope);return {};}}});
    t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'task',entityId:'opaque-task',entityRevision:2})});
    await delay(80);assert.equal(reloads.length,view==='board'?1:0,view);if(view==='board')assert.equal(reloads[0].hints[0].entityId,'opaque-task');t.controller.dispose();
  }
});

test('Inbox entry and invalidations refresh all three loaded pages including old excerpts',async()=>{
  useMockedClock();
  let version=0,reads=0,view='inbox';
  const t=fixture({app:{context:()=>({view,projectId:'p1'})},api:{inbox:async options=>{reads++;const n=Number(options.cursor??0);return {items:[{id:`n${n}`,createdAt:100-n,eventType:'discussion.mention',excerpt:version?'Updated':'Secret'}],nextCursor:n<3?String(n+1):null,filteredCount:4,unreadCount:4};}}});
  t.controller.beforeRender(t.app.context());t.controller.mount(t.app.context());await tick();
  await t.controller.moreInbox(t.facade.filter());await t.controller.moreInbox(t.facade.filter());
  assert.equal(t.data.notifications.length,3);version=1;
  t.events.listeners.hint({data:JSON.stringify({kind:'inbox.changed'})});await delay(90);
  assert.equal(t.data.notifications.length,3);assert.ok(t.data.notifications.every(item=>item.excerpt==='Updated'));
  const before=reads;t.controller.mount(t.app.context());await tick();assert.equal(reads,before,'ordinary renders do not refetch');
  view='board';t.controller.beforeRender(t.app.context());view='inbox';t.controller.beforeRender(t.app.context());t.controller.mount(t.app.context());await tick();assert.equal(reads,before+3,'entry revalidates retained pages');
  await t.controller.moreInbox(t.facade.filter());assert.equal(t.data.notifications.length,4);t.controller.dispose();
});

test('three task feed pages and deep cursors survive live comments and local saves',async()=>{
  useMockedClock();
  let edited=false;const cursors=[];
  const comment=(id,ts,text=id)=>({id,rootId:id,authorId:'u1',content:text,createdAt:ts,revision:1});
  const t=fixture({api:{
    comments:async(_id,options)=>{cursors.push(options.cursor);const n=Number(options.cursor??0);return {items:[comment(`c${n}`,100-n)],nextCursor:n<3?String(n+1):null};},
    activity:async(_id,options)=>{const n=Number(options.cursor??0);return {items:[{id:`a${n}`,eventType:'comment.edited',actorUserId:'u1',createdAt:100-n,metadata:{}}],nextCursor:n<3?String(n+1):null};},
    request:async()=>({items:[comment('c2',98,edited?'Updated':'Original')]}),
  }});
  t.controller.beforeRender(t.app.context());await t.controller.loadTaskPage('ONE-101');await t.controller.moreTask('ONE-101');await t.controller.moreTask('ONE-101');
  edited=true;t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',taskId:'opaque-task',entityType:'comment',entityId:'c2'})});await delay(90);
  assert.deepEqual(t.data.tasks[0].comments.map(item=>item.id),['c2','c1','c0']);assert.equal(t.data.tasks[0].comments[0].text,'Updated');assert.equal(t.data.tasks[0].activity.length,3);
  await t.controller.moreTask('ONE-101');assert.equal(cursors.at(-1),'3');assert.equal(t.data.tasks[0].comments.length,4);t.controller.dispose();
});

test('own Inbox action and its immediate hint share a refresh',async()=>{
  const t=fixture({app:{context:()=>({view:'inbox',projectId:'p1'})}});
  t.transport.commands.execute=async()=>{t.events.listeners.hint({data:JSON.stringify({kind:'inbox.changed'})});return {};};
  await t.controller.setRead('notice',false);
  assert.equal(t.apiCalls.filter(([kind])=>kind==='inbox').length,1);t.controller.dispose();
});

test('a reconnect refresh walks the saved task-feed depth and scrubs older rows',async()=>{
  useMockedClock();
  let version=0;const requests=[];
  const t=fixture({api:{comments:async(_id,options)=>{const n=Number(options.cursor??0);requests.push(n);return {items:[{id:`c${n}`,rootId:`c${n}`,authorId:'u1',createdAt:100-n,content:version?'Reconciled':'Old'}],nextCursor:n<4?String(n+1):null};}}});
  t.controller.beforeRender(t.app.context());await t.controller.loadTaskPage('ONE-101');await t.controller.moreTask('ONE-101');await t.controller.moreTask('ONE-101');
  version=1;requests.length=0;t.events.listeners.reconcile({data:'{}',type:'reconcile'});await delay(90);
  assert.deepEqual(requests,[0,1,2]);assert.equal(t.data.tasks[0].comments.length,3);assert.ok(t.data.tasks[0].comments.every(item=>item.text==='Reconciled'));t.controller.dispose();
});

test('successive Board hints serialize while the first reconciliation is slow',async()=>{
  useMockedClock();
  let release;const gate=new Promise(resolve=>{release=resolve;}),reloads=[];
  const t=fixture({app:{context:()=>({view:'board',projectId:'p1'})},transport:{reload:async scope=>{reloads.push(scope);if(reloads.length===1)await gate;return {};}}});
  const hint=id=>t.events.listeners.hint({data:JSON.stringify({kind:'activity.changed',projectId:'p1',entityType:'task',entityId:id,entityRevision:2})});
  hint('first');await delay(80);hint('second');await delay(80);assert.equal(reloads.length,1);
  release();await delay(80);assert.equal(reloads.length,2);assert.equal(reloads[1].hints[0].entityId,'second');t.controller.dispose();
});


test('Inbox append only publishes its fetched page and uses a busy control before reads',async()=>{
  const busy=[];
  const t=fixture({facade:{inboxBusy:value=>busy.push(value)},api:{inbox:async options=>({items:[{id:options.cursor?'older':'first',createdAt:100,eventType:'task.assigned'}],nextCursor:options.cursor?null:'next',unreadCount:2,filteredCount:2})}});
  const filter=t.facade.filter();await t.controller.loadInbox(filter);
  t.inboxes.length=0;
  await t.controller.moreInbox(filter);
  assert.deepEqual(busy,[true]);assert.equal(t.inboxes.length,1);
  assert.deepEqual(t.inboxes[0].items.map(item=>item.id),['older']);
  assert.deepEqual(t.data.notifications.map(item=>item.id),['first','older']);t.controller.dispose();
});


test('SSE open plus reconcile performs one reload after reconnect',async()=>{
  useMockedClock();
  let reloads=0;const sources=[],timers=[];
  const t=fixture({app:{context:()=>({view:'board',projectId:'p1'})},api:{request:async()=>({})},transport:{reload:async()=>{reloads++;return {stale:false};}},eventSourceFactory:url=>{const source={url,listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},close(){}};sources.push(source);return source;}});
  const previous=globalThis.OneloopRecovery;
  const recovery=createRecoveryController({data:t.data,api:t.transport.api,gateway:{},getApp:()=>t.app,getAuth:()=>null,reload:t.transport.reload,setTimer:callback=>{timers.push(callback);return timers.length;},clearTimer(){},online:()=>true,documentObject:null,windowObject:null});
  globalThis.OneloopRecovery=recovery;
  try{
    sources[0].listeners.error();await tick();timers.at(-1)();
    assert.equal(sources.length,2);assert.equal(sources[1].url,'/api/events');
    sources[1].listeners.open();sources[1].listeners.reconcile({data:'{}'});
    await delay(100);assert.equal(reloads,1);assert.equal(t.apiCalls.filter(call=>call[0]==='inbox').length,1);
  }finally{t.controller.dispose();recovery.dispose();globalThis.OneloopRecovery=previous;}
});

test('temporary sessions open no event stream until password completion',()=>{
  let streams=0;
  const t=fixture({data:{session:{id:'s1',userId:'u1',temporary:true}},eventSourceFactory:()=>{streams++;return {addEventListener(){},close(){}};}});
  assert.equal(streams,0,'no initial stream for temporary session');
  t.data.session.temporary=false;for(const listener of t.listeners)listener({type:'session'});assert.equal(streams,1);
  t.controller.dispose();
});

test('a second Save of an edited comment waits for the first reply and builds on its revision',async()=>{
  const t=fixture(),pending=[];t.data.tasks[0].comments=[{id:'c1',who:'u1',text:'Old',revision:1,ts:20_000}];
  t.transport.commands.execute=(_operation,payload,options)=>new Promise(resolve=>pending.push({payload,options,resolve}));
  const reply=(index)=>pending[index].resolve({entities:[{id:'c1',projectId:'p1',taskId:'opaque-task',authorId:'u1',authorName:'Nico',rootId:'c1',replyToId:null,content:pending[index].payload.content,mentions:[],createdAt:20,editedAt:22,deletedAt:null,revision:pending[index].options.expectedRevision+1}],events:[{id:`a${index}`}]});
  const edit=(text,interactionId)=>t.controller.saveComment({task:t.data.tasks[0],mode:'edit',commentId:'c1',revision:1,text,mentions:[],interactionId});
  const first=edit('First','i1'),second=edit('Second','i2'),third=edit('Third','i3');
  assert.equal(pending.length,1,'later Saves wait for the first reply');
  reply(0);while(pending.length<2)await tick();
  assert.equal(pending[1].payload.content,'Third');assert.equal(pending[1].options.expectedRevision,2);
  reply(1);assert.deepEqual(await Promise.all([first,second,third]),[true,true,true]);
  assert.equal(pending.length,2);assert.equal(t.data.tasks[0].comments[0].text,'Third');
});

test('opening an Inbox item whose task was deleted keeps the Inbox and says so',async()=>{
  const toasts=[],routeErrors=[],opened=[];let inboxReads=0;
  const t=fixture({
    app:{context:()=>({view:'inbox'}),toast:(...args)=>toasts.push(args),openTask:id=>opened.push(id)},
    api:{inbox:async()=>{inboxReads++;return {items:[],nextCursor:null,unreadCount:0,filteredCount:0};}},
    transport:{reload:async scope=>{if(scope.routeErrors!==false){routeErrors.push('404');return {stale:false};}return {stale:false,unavailable:true};}},
  });
  try{
    await t.controller.openNotification({id:'n1',readAt:1,destinationAvailable:true,taskId:'gone-task'});
    assert.deepEqual(routeErrors,[],'the page does not turn into Page not found');
    assert.deepEqual(toasts,[['This item is no longer available','info']]);assert.deepEqual(opened,[]);
    assert.equal(inboxReads,1,'the Inbox reloads so the item shows as unavailable');
  }finally{t.controller.dispose();}
});
