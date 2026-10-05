import assert from 'node:assert/strict';
import test from 'node:test';
import {installViewBridge} from '../../../src/app/view-bridge.js';
import {createCommandGateway} from '../../../src/data/command-gateway.js';
import {ApiError} from '../../../src/data/api-client.js';

function fixture(context,overrides={}){
  const opened=[],calls=[],paints=[],toasts=[],saved=[];let closed=0;
  const app={context:()=>context,openPeek(){},openTask(id){opened.push(id);},moveTaskOrder(){},refresh(){paints.push('all');},refreshBoard(){paints.push('board');},refreshProfileAccess(options){if(!options)paints.push('profile-access');},acceptMoreUsers(){},acceptMoreBoard(){},closeOverlays(){closed++;},selectProject(){},nav(){},toast(...args){toasts.push(args);},noteTaskSaved(id){saved.push(id);},confirm(){},showTemporaryPassword(){},...overrides.app};
  const data={session:{id:'s1',userId:'u1'},users:[],projects:[{id:'p1',members:[]}],tracks:[],epics:[],milestones:[],tasks:[],pool:[],browserSessions:[],appGrants:[],adminUsers:{loaded:false,ids:[],nextCursor:null}};
  const reads={
    async task(id){calls.push(['task',id]);const task={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1};data.tasks.push(task);return {stale:false,task};},
    async counts(id){calls.push(['counts',id]);},async board(){},async roadmap(){},async pool(){},cancel(){},async epic(){},async moreEpicTasks(){},async moreEpicActivity(){},
    ...overrides.reads,
  };
  const bridge=installViewBridge({app,data,reads,api:overrides.api??{},gateway:overrides.gateway??{},auth:overrides.auth??{},recovery:overrides.recovery??{},reloadBootstrap:overrides.reloadBootstrap??(async()=>({}))});
  return {app,data,reads,bridge,opened,calls,paints,toasts,saved,get closed(){return closed;}};
}

test('an unloaded valid task hash is fetched before the shell decides it is missing',async()=>{
  const previous=globalThis.location;globalThis.location={hash:'#/task/ONE-1'};
  try{
    const state=fixture({view:'notfound',taskId:'ONE-1',projectId:'p1',board:{}});
    await state.bridge.loadCurrentRoute();
    assert.deepEqual(state.calls,[['task','ONE-1'],['counts','p1']]);
    assert.deepEqual(state.opened,['ONE-1']);
  }finally{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;}
});

test('a live refresh of Profile, Users and Settings reads passively, and a visit does not',async()=>{
  for(const view of ['profile','users','settings']){
    const reads=[];
    const answer=(name,body)=>async(options={})=>{reads.push([name,options.background]);return body;};
    const api={sessions:answer('sessions',{sessions:[]}),connectedApps:answer('apps',{apps:[]}),users:answer('users',{users:[],nextCursor:null})};
    const state=fixture({view,projectId:'p1',board:{}},{api});
    await state.bridge.loadCurrentRoute({refresh:true,background:true});
    const live=reads.splice(0);
    await state.bridge.loadCurrentRoute();
    assert.deepEqual(live,view==='profile'?[['sessions',true],['apps',true]]:[['users',true]],view);
    assert.deepEqual(reads,view==='profile'?[['sessions',false],['apps',false]]:[['users',false]],view);
  }
});

test('a save uses the editor focus revision even after live data advances',async()=>{
  let options,finished='';
  const gateway={execute:async(_operation,_payload,input)=>{options=input;return {entities:[],events:[]};}};
  const recovery={revisionKey:()=> 'task:opaque-1',expectedRevision:()=>1,captureEditor:()=>null,finishRevision:(key)=>{finished=key;}};
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway,recovery});
  state.data.tasks.push({id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:2,assignees:[]});
  await state.bridge.invoke('task.assignees',{taskId:'ONE-1',assigneeIds:['u2']});
  assert.equal(options.expectedRevision,1);assert.equal(finished,'task:opaque-1');
});

for(const [latest,fail] of [['Newest title',false],['Original title',false],['First title',false],['Unsaved title',true]])test(`task autosave coalesces pending titles through the acknowledged revision: ${latest}`,async()=>{
  let gateway;
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1'}, {gateway:{execute:(...args)=>gateway.execute(...args)}});
  state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',revision:1,title:'Original title'});
  const requests=[],pending=[];
  gateway=createCommandGateway({data:state.data,api:{command:command=>{requests.push(command);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}}});
  const acknowledge=(index)=>pending[index].resolve({entities:[{entityType:'task',id:'t1',title:requests[index].payload.title,revision:index+2}],events:[]});
  state.app.updTask('ONE-1','title','First title');
  state.app.updTask('ONE-1','title','Intermediate title');
  state.app.updTask('ONE-1','title',latest);
  assert.equal(requests.length,1);
  acknowledge(0);await new Promise(setImmediate);
  if(latest==='First title'){
    assert.equal(requests.length,1,'a duplicate latest value needs no second write');
    assert(state.saved.length>0);assert.deepEqual(state.paints,['all']);return;
  }
  assert.deepEqual(state.saved,[],'the earlier response must not report the latest value saved');
  assert.deepEqual(state.paints,[],'an intermediate value must not replace the latest input');
  assert.equal(requests.length,2);
  assert.equal(requests[1].payload.title,latest);
  assert.equal(requests[1].expectedRevision,2);
  assert.notEqual(requests[0].idempotencyKey,requests[1].idempotencyKey);
  if(fail)pending[1].reject(new ApiError('Connection lost',{code:'network_error',uncertain:true}));else acknowledge(1);
  await new Promise(setImmediate);
  assert.equal(state.data.tasks[0].title,fail?'First title':latest);
  if(fail){assert.deepEqual(state.saved,[]);assert.equal(state.toasts[0][1],'error');}
  else{assert(state.saved.length>0);assert.deepEqual(state.toasts,[]);}
});

test('a title cut at its length limit keeps whole characters',async()=>{
  const payloads=[];
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1'},{gateway:{execute:async(_operation,payload)=>{payloads.push(payload);return {entities:[],events:[]};}}});
  state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',revision:1,title:'Original'});
  state.app.updTask('ONE-1','title','A'.repeat(139)+'😀');await new Promise(setImmediate);
  assert.equal(payloads[0].title,'A'.repeat(139));
});

test('a task draft is dropped when someone else signs in after the session ended',async()=>{
  const pending=[];
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1'},{gateway:{execute:()=>new Promise((_resolve,reject)=>pending.push(reject))}});
  state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',revision:3,title:'Saved title'});
  state.app.updTask('ONE-1','title','Typed title');
  assert.deepEqual(state.bridge.taskDraft('t1','title'),{value:'Typed title',unsaved:false});
  const person=state.data.session;state.data.session=null;
  pending[0](new ApiError('Authentication is required',{status:401,code:'unauthorized'}));await new Promise(setImmediate);
  state.data.session={id:'s2',userId:'u2'};
  assert.equal(state.bridge.taskDraft('t1','title'),null,'someone else never sees it');
  state.data.session={...person,id:'s3'};
  assert.equal(state.bridge.taskDraft('t1','title'),null,'it was dropped when someone else signed in');
});

test('a task draft survives the end of a session for the same person',async()=>{
  const pending=[],sent=[];
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1'},{gateway:{execute:(_operation,payload,options)=>{sent.push([payload.title,options.expectedRevision]);return new Promise((_resolve,reject)=>pending.push(reject));}}});
  state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',revision:3,title:'Saved title'});
  state.app.updTask('ONE-1','title','Typed title');
  const person=state.data.session;state.data.session=null;
  pending[0](new ApiError('Authentication is required',{status:401,code:'unauthorized'}));await new Promise(setImmediate);
  state.data.session={...person,id:'s2'};
  assert.deepEqual(state.bridge.taskDraft('t1','title'),{value:'Typed title',unsaved:true});
  state.app.saveTaskDraft('ONE-1','title');
  assert.deepEqual(sent,[['Typed title',3],['Typed title',3]],'Save sends it again from the revision it was typed on');
});

test('project autosave keeps the latest name while an earlier name is saving',async()=>{
  let gateway;
  const state=fixture({view:'settings',projectId:'p1'}, {gateway:{execute:(...args)=>gateway.execute(...args)}});
  Object.assign(state.data.projects[0],{revision:1,name:'Original'});
  const requests=[],pending=[];
  gateway=createCommandGateway({data:state.data,api:{command:command=>{requests.push(command);return new Promise(resolve=>pending.push(resolve));}}});
  state.app.updateProjectField({name:'name',value:'First'});
  state.app.updateProjectField({name:'name',value:'Latest'});
  pending[0]({entities:[{entityType:'project',id:'p1',name:'First',revision:2}],events:[]});await new Promise(setImmediate);
  assert.equal(requests.length,2);assert.equal(requests[1].payload.name,'Latest');assert.equal(requests[1].expectedRevision,2);
  pending[1]({entities:[{entityType:'project',id:'p1',name:'Latest',revision:3}],events:[]});await new Promise(setImmediate);
  assert.equal(state.data.projects[0].name,'Latest');assert(!state.toasts.some(([,kind])=>kind==='error'));
});

test('a profile response from an ended session cannot repopulate private access data',async()=>{
  let resolveSessions,resolveApps;
  const sessions=new Promise((resolve)=>{resolveSessions=resolve;}),apps=new Promise((resolve)=>{resolveApps=resolve;});
  const context={view:'profile',projectId:'p1',board:{}};
  const state=fixture(context,{api:{sessions:()=>sessions,connectedApps:()=>apps}});
  state.data.browserSessions.push({id:'old'});state.data.appGrants.push({id:'old'});
  const loading=state.bridge.loadCurrentRoute();
  state.data.session=null;state.data.browserSessions.length=0;state.data.appGrants.length=0;
  resolveSessions({sessions:[{id:'leaked',clientName:'Browser',createdAt:1,lastActivityAt:1,current:false}]});
  resolveApps({apps:[{id:'leaked',clientName:'Client',createdAt:1,expiresAt:2,projects:[],scopes:[]}]});
  await loading;
  assert.deepEqual(state.data.browserSessions,[]);assert.deepEqual(state.data.appGrants,[]);
});

test('an admin-list response cannot mutate or repaint a page that has been left',async()=>{
  let resolveUsers;const users=new Promise((resolve)=>{resolveUsers=resolve;});
  const context={view:'users',projectId:'p1',board:{}};
  const state=fixture(context,{api:{users:()=>users}});
  const loading=state.bridge.loadCurrentRoute();context.view='board';
  resolveUsers({users:[{id:'u2',username:'member',displayName:'Member',isAdmin:false,isActive:true,mustChangePassword:false,revision:1}],nextCursor:null});
  await loading;
  assert.equal(state.data.adminUsers.loaded,false);assert.deepEqual(state.data.adminUsers.ids,[]);assert.equal(state.data.users.length,0);
});

test('a rejected reorder after project navigation restores only its original task',async()=>{
  const context={view:'board',projectId:'p1',board:{}},failure=Object.assign(new Error('Rejected'),{code:'validation_failed'});let reject,state;
  state=fixture(context,{
    gateway:{execute:()=>new Promise((_resolve,no)=>{reject=no;})},
    app:{moveTaskOrder(id,anchor,before){const item=state.data.tasks.find((entry)=>entry.id===id),target=state.data.tasks.find((entry)=>entry.id===anchor);state.data.tasks.splice(state.data.tasks.indexOf(item),1);state.data.tasks.splice(state.data.tasks.indexOf(target)+(before?0:1),0,item);}},
  });
  const first={id:'ONE-1',internalId:'opaque-1',projectId:'p1',state:'planning',revision:1},second={id:'ONE-2',internalId:'opaque-2',projectId:'p1',state:'planning',revision:1},other={id:'TWO-1',internalId:'other-1',projectId:'p2',state:'planning',revision:1};state.data.tasks.push(first,second,other);
  state.app.moveTaskOrder(first.id,second.id,false);assert.deepEqual(state.data.tasks.map((item)=>item.id),['ONE-2','ONE-1','TWO-1']);
  const sentinel={id:'TWO-2',internalId:'other-2',projectId:'p2',state:'planning',revision:1};state.data.tasks.push(sentinel);context.projectId='p2';reject(failure);await new Promise((resolve)=>setTimeout(resolve,0));
  assert.deepEqual(state.data.tasks.map((item)=>item.id),['ONE-1','ONE-2','TWO-1','TWO-2']);assert.deepEqual(state.paints,[]);assert(state.data.tasks.includes(sentinel));
});

test('rapid assignee toggles serialize the latest intent without an intermediate repaint',async()=>{
  const requests=[];let releaseFirst,releaseSecond;
  const gateway={execute:async(operation,payload,options)=>{
    requests.push({operation,payload,options});
    return new Promise((resolve)=>{if(requests.length===1)releaseFirst=resolve;else releaseSecond=resolve;});
  }};
  const recovery={revisionKey:(item)=>`task:${item.internalId}`,expectedRevision:(_key,fallback)=>fallback,finishRevision(){},captureEditor:()=>null};
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway,recovery});
  const item={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1,assignees:[]};state.data.tasks.push(item);
  const first=state.bridge.invoke('task.assignees',{taskId:'ONE-1',assigneeIds:['u2']});
  const second=state.bridge.invoke('task.assignees',{taskId:'ONE-1',assigneeIds:['u2','u3']});
  assert.equal(requests.length,1);assert.deepEqual(requests[0].payload.assigneeIds,['u2']);assert.equal(requests[0].options.expectedRevision,1);
  Object.assign(item,{revision:2,assignees:['u2']});releaseFirst({entities:[],events:[]});
  while(requests.length<2)await new Promise((resolve)=>setTimeout(resolve,0));
  assert.deepEqual(requests[1].payload.assigneeIds,['u2','u3']);assert.equal(requests[1].options.expectedRevision,2);
  Object.assign(item,{revision:3,assignees:['u2','u3']});releaseSecond({entities:[],events:[]});
  await Promise.all([first,second]);
  assert.deepEqual(item.assignees,['u2','u3']);assert.deepEqual(state.paints,[]);assert.deepEqual(state.toasts,[]);assert.deepEqual(state.saved,['ONE-1']);
});

test('unchanged assignees stay quiet without issuing a command',async()=>{
  let writes=0;const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:async()=>{writes++;return {entities:[],events:[]};}}});
  const item={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1,assignees:['u2']};state.data.tasks.push(item);
  const result=await state.bridge.invoke('task.assignees',{taskId:'ONE-1',assigneeIds:['u2']});
  assert.equal(writes,0);assert.deepEqual(item.assignees,['u2']);assert.deepEqual(state.paints,[]);assert.deepEqual(state.saved,[]);assert.equal(result,undefined);
});

test('failed assignee saves retain the canonical list loaded during conflict recovery',async()=>{
  const failure=Object.assign(new Error('record changed; latest revision is 2'),{code:'revision_conflict'});
  let state;
  const reads={task:async()=>{const item=state.data.tasks[0];Object.assign(item,{revision:2,assignees:['u3']});return {stale:false,task:item};}};
  state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:async()=>{throw failure;}},reads,recovery:{isRevisionConflict:()=>false,handleCommandFailure:async()=>{}}});
  const item={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1,assignees:['u1']};state.data.tasks.push(item);
  await assert.rejects(state.bridge.invoke('task.assignees',{taskId:'ONE-1',assigneeIds:['u2']}),failure);
  assert.deepEqual(item.assignees,['u3']);assert.equal(item.revision,2);
});

test('an old assignee response cannot mutate a same-id task in a replacement session',async()=>{
  let release;const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:()=>new Promise((resolve)=>{release=resolve;})}});
  state.data.tasks.push({id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1,assignees:[]});
  const pending=state.bridge.invoke('task.assignees',{taskId:'ONE-1',assigneeIds:['u2']});
  const replacement={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:8,assignees:['u9']};
  state.data.session={id:'s2',userId:'u2'};state.data.tasks.splice(0,state.data.tasks.length,replacement);release({entities:[],events:[]});
  await pending;assert.deepEqual(replacement.assignees,['u9']);assert.equal(replacement.revision,8);
});

test('a command response from an ended session cannot close or repaint the next session',async()=>{
  const originalFormData=globalThis.FormData;globalThis.FormData=class {constructor(form){this.fields=form.fields;}get(name){return this.fields[name]??null;}};
  let release;const gateway={execute:()=>new Promise((resolve)=>{release=resolve;})};
  const context={view:'roadmap',projectId:'p1',board:{}};
  const state=fixture(context,{gateway});state.data.tracks.push({id:'track-1',projectId:'p1',name:'Old',revision:1});
  try{
    state.app.saveTrack({preventDefault(){},target:{fields:{name:'New'}}},'track-1');
    state.data.session={id:'s2',userId:'u2'};release({entities:[],events:[]});
    await new Promise((resolve)=>setTimeout(resolve,0));
    assert.equal(state.closed,0);assert.deepEqual(state.paints,[]);assert.deepEqual(state.toasts,[]);
  }finally{globalThis.FormData=originalFormData;}
});

test('profile writes are ordered and only the latest value updates the current view',async()=>{
  const pending=[];const context={view:'profile',projectId:'p1',board:{}};
  const state=fixture(context,{api:{updateProfile:(displayName)=>new Promise((resolve)=>pending.push({displayName,resolve}))}});
  const me={id:'u1',name:'Original'};state.data.users.push(me);
  state.app.updMe('First');state.app.updMe('Second');
  while(pending.length<1)await new Promise((resolve)=>setTimeout(resolve,0));
  assert.equal(pending.length,1);pending[0].resolve({user:{displayName:'First',avatarUrl:null}});
  while(pending.length<2)await new Promise((resolve)=>setTimeout(resolve,0));
  assert.equal(me.name,'Original');assert.deepEqual(state.paints,[]);
  pending[1].resolve({user:{displayName:'Second',avatarUrl:null}});await new Promise((resolve)=>setTimeout(resolve,0));
  assert.equal(me.name,'Second');assert.deepEqual(state.paints,['all']);assert.deepEqual(state.toasts,[['Profile saved']]);
});

test('profile access loads normalized rows and updates only its section after both private reads finish',async()=>{
  const context={view:'profile',projectId:null,board:{}};
  const userAgent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36';
  const state=fixture(context,{api:{
    sessions:async()=>({sessions:[{id:'session-1',clientName:userAgent,userAgent,createdAt:1,lastActivityAt:2,current:true}]}),
    connectedApps:async()=>({apps:[]}),
  }});
  await state.bridge.loadCurrentRoute();
  assert.equal(state.data.browserSessions[0].device,'Chrome on macOS');assert.deepEqual(state.paints,['profile-access']);
});

test('routine member actions never invoke password confirmation',async()=>{
  const sent=[],confirmations=[];
  const state=fixture({view:'settings',projectId:'p1',board:{}},{
    gateway:{execute:async(operation)=>{sent.push(operation);return {entities:[],events:[]};}},
    app:{confirm:options=>confirmations.push(options)},
  });
  state.data.users.push({id:'u1',admin:true,active:true});
  // This harness deliberately provides no auth.withRecentAuth implementation.
  state.data.projects[0].members.push({userId:'u2',permissions:[],revision:1});
  state.app.addMember('u3');await new Promise(resolve=>setImmediate(resolve));
  state.app.setMemberPermission('u2','manage_board',true);await new Promise(resolve=>setImmediate(resolve));
  state.app.removeMember('u2');assert.equal(confirmations.length,1);confirmations[0].confirm();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(sent,['membership.add','membership.update','membership.remove']);
});

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('task creation stays one interaction across acceptance and a slow follow-up read',async()=>{
  const originalFormData=globalThis.FormData;
  globalThis.FormData=class {constructor(form){this.fields=form.fields;}get(name){return this.fields[name]??null;}getAll(name){return this.fields[name]??[];}};
  const write=deferred(),read=deferred();let writes=0;
  const state=fixture({view:'board',projectId:'p1',board:{},modal:{type:'task'}},{gateway:{execute:()=>{writes++;return write.promise;}},reloadBootstrap:()=>read.promise});
  state.data.epics.push({id:'e1',projectId:'p1',state:'planning'});
  const button={disabled:false},form={fields:{epicId:'e1',title:'One task'},querySelectorAll:()=>[button]},event={target:form,preventDefault(){}};
  try{
    state.app.saveTask(event);state.app.saveTask(event);
    assert.equal(writes,1);assert.equal(button.disabled,true);
    write.resolve({entities:[],events:[]});await tick();
    assert.equal(state.closed,1);
    state.app.saveTask(event);assert.equal(writes,1);
    read.resolve({stale:false});await tick();
    assert.equal(state.closed,1);assert.equal(button.disabled,false);
  }finally{globalThis.FormData=originalFormData;}
});

test('an accepted create closes successfully even when refreshing the view fails',async()=>{
  const originalFormData=globalThis.FormData;
  globalThis.FormData=class {constructor(form){this.fields=form.fields;}get(name){return this.fields[name]??null;}getAll(name){return this.fields[name]??[];}};
  const failure=new Error('Read unavailable'),refreshFailures=[];let writes=0;
  const state=fixture({view:'board',projectId:'p1',board:{},modal:{type:'task'}},{gateway:{execute:async()=>{writes++;return {entities:[],events:[]};}},reloadBootstrap:async()=>{throw failure;},recovery:{refreshFailed:error=>refreshFailures.push(error)}});
  state.data.epics.push({id:'e1',projectId:'p1',state:'planning'});
  try{
    state.app.saveTask({preventDefault(){},target:{fields:{epicId:'e1',title:'Saved task'}}});await tick();
    assert.equal(writes,1);assert.equal(state.closed,1);
    assert.deepEqual(state.toasts,[['Task created']]);assert.deepEqual(refreshFailures,[failure]);
  }finally{globalThis.FormData=originalFormData;}
});

test('only the latest project selection may apply a completed bootstrap',async()=>{
  const first=deferred(),second=deferred(),selected=[];
  const state=fixture({view:'board',projectId:'p1',board:{}},{reloadBootstrap:({projectId})=>projectId==='p1'?first.promise:second.promise,app:{selectProject:id=>selected.push(id)}});
  const a=state.bridge.invoke('workspace.select',{projectId:'p1'});
  const b=state.bridge.invoke('workspace.select',{projectId:'p2'});
  second.resolve({stale:false});await b;first.resolve({stale:true});await a;
  assert.deepEqual(selected,['p2']);
});

test('a delayed task read cannot leave a newer Profile route',async()=>{
  const previous=globalThis.location;globalThis.location={hash:'#/task/ONE-1'};
  const taskRead=deferred(),sessions=deferred(),apps=deferred();
  const context={view:'task',taskId:'ONE-1',projectId:'p1',board:{}};
  const state=fixture(context,{reads:{task:()=>taskRead.promise},api:{sessions:()=>sessions.promise,connectedApps:()=>apps.promise}});
  try{
    const old=state.bridge.loadCurrentRoute();context.view='profile';context.taskId=null;globalThis.location.hash='#/profile';
    const next=state.bridge.loadCurrentRoute();taskRead.resolve({stale:false,task:{id:'ONE-1'}});await old;
    assert.deepEqual(state.opened,[]);
    sessions.resolve({sessions:[]});apps.resolve({apps:[]});await next;assert.deepEqual(state.opened,[]);
  }finally{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;}
});

test('Pool read actions rely on in-place read callbacks without whole-app refreshes',async()=>{
  const state=fixture({view:'board',projectId:'p1',board:{}},{reads:{pool:async()=>({stale:false}),morePool:async()=>({stale:false})}});
  await state.bridge.invoke('pool.open',{});await state.bridge.invoke('pool.select',{scope:'mine'});await state.bridge.invoke('pool.more',{scope:'mine'});
  assert.deepEqual(state.paints,[]);
});

test('a failed obsolete task read cannot put the new Profile page into an error state',async()=>{
  const previous=globalThis.location;globalThis.location={hash:'#/task/ONE-1'};
  try{
    for(const status of [403,404,500]){
      globalThis.location.hash='#/task/ONE-1';
      const taskRead=deferred(),sessions=deferred(),apps=deferred();
      const context={view:'task',taskId:'ONE-1',projectId:'p1',board:{}};
      const state=fixture(context,{reads:{task:()=>taskRead.promise},api:{sessions:()=>sessions.promise,connectedApps:()=>apps.promise}});
      const old=state.bridge.loadCurrentRoute();context.view='profile';context.taskId=null;globalThis.location.hash='#/profile';
      const next=state.bridge.loadCurrentRoute();taskRead.reject(Object.assign(new Error('Old route failed'),{status}));
      assert.deepEqual(await old,{stale:true});assert.deepEqual(state.opened,[]);
      sessions.resolve({sessions:[]});apps.resolve({apps:[]});await next;
    }
  }finally{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;}
});

test('Pool capture cannot repeat an accepted create while its read is pending or erase the next entry',async()=>{
  const previous=globalThis.document;globalThis.document={getElementById:()=>null};
  const read=deferred();let writes=0;
  const state=fixture({view:'board',projectId:'p1',poolTab:'mine',board:{}},{gateway:{execute:async()=>{writes++;return {entities:[],events:[]};}},reads:{pool:()=>read.promise}});
  const input={value:'First idea',isConnected:true};const event={key:'Enter',target:input,preventDefault(){}};
  try{
    state.app.poolKey(event);await tick();assert.equal(input.value,'');
    input.value='Next idea';state.app.poolKey(event);assert.equal(writes,1);
    read.resolve({stale:false});await tick();
    assert.equal(input.value,'Next idea');assert.deepEqual(state.paints,[]);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('a task in another project loads its parent context before opening and counts that project',async()=>{
  const previous=globalThis.location;globalThis.location={hash:'#/task/TWO-1'};
  const context={view:'notfound',taskId:'TWO-1',projectId:'p1',board:{}},roadmaps=[],counted=[];
  const task={id:'TWO-1',internalId:'t2',projectId:'p2',epicId:'e2'};
  let state;
  state=fixture(context,{
    reads:{task:async()=>({stale:false,task}),roadmap:async projectId=>{roadmaps.push(projectId);state.data.epics.push({id:'e2',trackId:'r2'});state.data.tracks.push({id:'r2',projectId:'p2'});return {stale:false};},counts:async projectId=>counted.push(projectId)},
    app:{openTask(id){assert.equal(id,'TWO-1');assert.equal(state.data.tracks[0].id,'r2');context.view='task';context.projectId='p2';}},
  });
  state.data.projects.push({id:'p2',members:[]});
  try{await state.bridge.loadCurrentRoute();assert.deepEqual(roadmaps,['p2']);assert.deepEqual(counted,['p2']);}
  finally{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;}
});


test('profile password success is announced only after completion',async()=>{
  for(const ok of [true,false,undefined]){
    const state=fixture({view:'profile',projectId:'p1'},{auth:{changePassword:async()=>ok}});
    state.app.changePassword({preventDefault(){},target:{}});await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(state.toasts,ok?[['Password changed. Other sessions and app access revoked']]:[]);
  }
});

test('epic completion describes singular and plural open tasks and retains production dismissal',async()=>{
  const previous=globalThis.document;
  globalThis.document={querySelector:()=>({isConnected:true})};
  try{
  for(const count of [1,2]){
    let dialog;
    const state=fixture({view:'roadmap',projectId:'p1'},{app:{confirm:value=>{dialog=value;}},gateway:{execute:async()=>({entities:[],events:[]})}});
    state.data.epics.push({id:'e1',projectId:'p1',revision:1});
    state.data.tasks.push(...Array.from({length:count},()=>({epicId:'e1',state:'planning'})));
    state.app.closeEpic('e1');assert.equal(dialog.text,count===1?'1 open task stays where it is.':'2 open tasks stay where they are.');
    dialog.confirm();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(state.closed,1);
  }
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('admin revision conflict reloads through the affected page and retries with its fresh revision',async()=>{
  const OriginalFormData=globalThis.FormData,fields={name:{value:'Admin edit'},admin:{checked:false},active:{checked:true}},errors=[],revisions=[];
  const form={isConnected:true,querySelector(selector){return fields[selector.match(/name="(.*?)"/)[1]];}};
  globalThis.FormData=class{get(name){return fields[name]?.value;}has(name){return !!fields[name]?.checked;}};
  try{
    const context={view:'users',modal:{type:'user',id:'u2'}};
    const state=fixture(context,{recovery:{isRevisionConflict:error=>error.code==='revision_conflict'},app:{fieldError:(_form,_name,message)=>errors.push(message)},api:{
      users:async({afterUsername})=>afterUsername?{users:[{id:'u2',username:'zeta',displayName:'Self-service name',isAdmin:false,isActive:true,revision:4}],nextCursor:null}:{users:[{id:'u1',username:'admin',displayName:'Owner',isAdmin:true,isActive:true,revision:1}],nextCursor:'admin'},
      updateUser:async(_id,input)=>{revisions.push(input.expectedRevision);if(revisions.length===1)throw Object.assign(new Error('changed'),{code:'revision_conflict'});return {displayName:input.displayName,isAdmin:false,isActive:true,revision:5};},
    }});
    state.data.users.push({id:'u1',admin:true},{id:'u2',name:'Old name',admin:false,active:true,revision:1});
    state.app.saveUser({target:form,preventDefault(){}},'u2');
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(fields.name.value,'Self-service name');assert.match(errors[0],/Review the latest/);
    assert.equal(state.data.users.find(user=>user.id==='u2').revision,4);
    fields.name.value='Reviewed edit';state.app.saveUser({target:form,preventDefault(){}},'u2');await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(revisions,[1,4]);assert.equal(state.closed,1);
  }finally{globalThis.FormData=OriginalFormData;}
});

test('opening the Pool reads both scopes side by side',async()=>{
  const requested=[],pending=[];
  const state=fixture({view:'board',projectId:'p1',board:{}},{reads:{pool:(_project,scope)=>{requested.push(scope);return new Promise(resolve=>pending.push(resolve));}}});
  const opening=state.bridge.invoke('pool.open',{});
  assert.deepEqual(requested,['personal','team'],'a slow scope does not hold up the other');
  pending[0]({stale:true});pending[1]({stale:false});
  assert.equal((await opening).stale,true);
});

test('a Users refresh reloads every page already shown',async()=>{
  const cursors=[];const context={view:'users',projectId:'p1',board:{}};
  const page=(from)=>({users:Array.from({length:50},(_,index)=>({id:`u${from+index}`,username:`user${String(from+index).padStart(3,'0')}`,displayName:`User ${from+index}`,isAdmin:false,isActive:true,revision:1})),nextCursor:from<100?`user${from+49}`:null});
  const state=fixture(context,{api:{users:async({afterUsername})=>{cursors.push(afterUsername);return page(afterUsername?Number(afterUsername.slice(4))+1:0);}}});
  await state.bridge.loadCurrentRoute();state.app.loadMoreUsers();await tick();
  assert.equal(state.data.adminUsers.ids.length,100);
  cursors.length=0;await state.bridge.loadCurrentRoute({refresh:true});
  assert.deepEqual(cursors,[undefined,'user49']);assert.equal(state.data.adminUsers.ids.length,100);
  cursors.length=0;await state.bridge.loadCurrentRoute();
  assert.deepEqual(cursors,[undefined],'opening Users again starts from the first page');
});

test('Save in Edit user finds the account after a refresh replaced its row',async()=>{
  const OriginalFormData=globalThis.FormData,fields={name:{value:'Renamed'},admin:{checked:false},active:{checked:true}},saved=[],errors=[];
  const form={isConnected:true,querySelector(selector){return fields[selector.match(/name="(.*?)"/)?.[1]];}};
  globalThis.FormData=class{get(name){return fields[name]?.value;}has(name){return !!fields[name]?.checked;}};
  try{
    const state=fixture({view:'users',modal:{type:'user',id:'u2'}},{app:{fieldError:(_form,name,message)=>errors.push([name,message])},api:{updateUser:async(id,input)=>{saved.push([id,input.displayName]);return {displayName:input.displayName,isAdmin:false,isActive:true,revision:2};}}});
    state.data.users.push({id:'u1',admin:true,active:true},{id:'u2',name:'Old name',admin:false,active:true,revision:1});
    state.app.saveUser({target:form,preventDefault(){}},'u2');
    state.data.users.splice(1,1,{id:'u2',name:'Old name',admin:false,active:true,revision:1});
    await tick();
    assert.deepEqual(saved,[['u2','Renamed']]);assert.equal(state.closed,1);assert.equal(state.data.users[1].name,'Renamed');
    state.app.saveUser({target:form,preventDefault(){}},'gone');
    assert.deepEqual(errors,[['name','This user is no longer listed. Reload Users and try again.']]);
  }finally{globalThis.FormData=OriginalFormData;}
});

/** A task page whose commands go through the real gateway and are answered one by one. */
function taskPage(overrides={}){
  let gateway;
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:(...args)=>gateway.execute(...args),hasUncertain:(...args)=>gateway.hasUncertain(...args)},...overrides});
  const item={id:'ONE-1',internalId:'t1',projectId:'p1',epicId:'e1',revision:1,title:'Title',desc:'Description',state:'planning',assignees:[]};state.data.tasks.push(item);
  const requests=[];
  gateway=createCommandGateway({data:state.data,api:{command:command=>new Promise((resolve,reject)=>requests.push({command,resolve,reject}))}});
  const accept=(index,fields={})=>requests[index].resolve({entities:[{entityType:'task',id:'t1',...fields,revision:requests[index].command.expectedRevision+1}],events:[{}]});
  return {...state,item,requests,accept};
}

test('two task fields saved close together build on each other instead of conflicting',async()=>{
  const state=taskPage();
  state.app.updTask('ONE-1','title','New title');state.app.updTask('ONE-1','desc','New description');state.app.updTask('ONE-1','state','progress');
  assert.equal(state.requests.length,1,'the next field waits for the first reply');
  state.accept(0,{title:'New title'});await tick();
  assert.equal(state.requests.length,2);assert.equal(state.requests[1].command.payload.description,'New description');assert.equal(state.requests[1].command.expectedRevision,2);
  state.accept(1,{description:'New description'});await tick();
  assert.equal(state.requests[2].command.operation,'task.move');assert.equal(state.requests[2].command.expectedRevision,3);
  state.accept(2,{status:'in_progress'});await tick();await tick();
  assert.deepEqual([state.item.title,state.item.desc,state.item.state],['New title','New description','progress']);
  assert.deepEqual(state.saved,['ONE-1'],'Saved shows once, after the last field');assert.deepEqual(state.toasts,[]);
});

const changedElsewhere=()=>new ApiError('record changed; latest revision is 2',{status:409,code:'revision_conflict'});

test('Keep my changes on one field leaves the next field to meet the other change',async()=>{
  // Keep my changes saves the title again on the latest revision, 2.
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',resolveConflict:async({retry})=>({handled:true,saved:true,result:await retry(2)}),handleCommandFailure:async()=>{}};
  const state=taskPage({recovery});
  state.app.updTask('ONE-1','title','My title');state.app.updTask('ONE-1','desc','My description');
  // Someone else changed the description at revision 2.
  state.requests[0].reject(changedElsewhere());await tick();
  assert.equal(state.requests[1].command.expectedRevision,2);
  state.accept(1,{title:'My title'});await tick();await tick();
  assert.equal(state.requests[2].command.payload.description,'My description');
  assert.equal(state.requests[2].command.expectedRevision,1,'the description was typed on revision 1, so it meets the change at 2');
});

test('a newer value of a field kept with Keep my changes saves on top of it',async()=>{
  let keep;
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',resolveConflict:({retry})=>new Promise(resolve=>{keep=async()=>resolve({handled:true,saved:true,result:await retry(2)});}),handleCommandFailure:async()=>{}};
  const state=taskPage({recovery});
  state.app.updTask('ONE-1','title','My title');
  state.requests[0].reject(changedElsewhere());await tick();
  // The person types more while the prompt shows the other title, then keeps theirs.
  state.app.updTask('ONE-1','title','My longer title');
  void keep();await tick();
  state.accept(1,{title:'My title'});await tick();await tick();
  assert.equal(state.requests[2].command.payload.title,'My longer title');
  assert.equal(state.requests[2].command.expectedRevision,3,'it builds on the kept title instead of conflicting with it');
});

test('a conflict prompt that closes without a choice keeps the typed value as Not saved',async()=>{
  const conflict=new ApiError('record changed; latest revision is 2',{status:409,code:'revision_conflict'}),drafted=[];
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',resolveConflict:async()=>({handled:true,saved:false}),handleCommandFailure:async()=>{}};
  const state=taskPage({recovery,app:{refreshTaskDrafts:id=>drafted.push(id)}});
  state.app.updTask('ONE-1','desc','My description');state.requests[0].reject(conflict);await tick();await tick();
  assert.deepEqual(state.bridge.taskDraft('t1','desc'),{value:'My description',unsaved:true});
  assert.deepEqual(drafted,['ONE-1']);assert.deepEqual(state.toasts,[],'the note on the field reports it');
  state.app.updTask('ONE-1','state','done');state.requests[1].reject(conflict);await tick();await tick();
  assert.deepEqual(state.toasts,[['Your change was not saved. Review the latest version and try again.','error']]);
  state.app.saveTaskDraft('ONE-1','desc');
  assert.equal(state.requests[2].command.payload.description,'My description');assert.equal(state.requests[2].command.expectedRevision,1,'Save keeps the revision the text was written against');
});

test('a task field edited while offline stays as typed and saves when the connection returns',async()=>{
  let online=false,reconnected;
  const recovery={ensureOnline:()=>online,whenOnline:listener=>{reconnected=listener;},handleCommandFailure:async()=>{}};
  const state=taskPage({recovery});
  state.app.updTask('ONE-1','desc','Written on the train');await tick();
  assert.equal(state.requests.length,0);
  assert.deepEqual(state.bridge.taskDraft('t1','desc'),{value:'Written on the train',unsaved:true});
  online=true;reconnected();await tick();
  assert.equal(state.requests[0].command.payload.description,'Written on the train');assert.equal(state.requests[0].command.expectedRevision,1);
  state.accept(0,{description:'Written on the train'});await tick();await tick();
  assert.equal(state.bridge.taskDraft('t1','desc'),null);assert.equal(state.item.desc,'Written on the train');
});

test('several fields edited offline save in order without conflicting with each other',async()=>{
  let online=false,reconnected;
  const state=taskPage({recovery:{ensureOnline:()=>online,whenOnline:listener=>{reconnected=listener;},handleCommandFailure:async()=>{}}});
  state.app.updTask('ONE-1','title','Offline title');state.app.updTask('ONE-1','desc','Offline description');await tick();
  online=true;reconnected();await tick();
  state.accept(0,{title:'Offline title'});await tick();await tick();
  assert.equal(state.requests[1].command.payload.description,'Offline description');assert.equal(state.requests[1].command.expectedRevision,2);
});

test('a block saved from the task page repaints before its counts read finishes',async()=>{
  const originalFormData=globalThis.FormData;globalThis.FormData=class {constructor(form){this.fields=form.fields;}get(name){return this.fields[name]??null;}};
  const counted=deferred(),closed=[];
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:async()=>({entities:[],events:[{}]})},reads:{counts:()=>counted.promise},app:{refreshAfterDialog(){state.paints.push('after-dialog');}}});
  const item={id:'ONE-1',internalId:'t1',projectId:'p1',epicId:'e1',revision:1,block:{id:'b1',reason:'Waiting',revision:1}};state.data.tasks.push(item);
  try{
    state.app.saveBlock({preventDefault(){},target:{fields:{reason:''},isConnected:true,closest:()=>null}},'ONE-1','unblock');await tick();
    assert.deepEqual(state.paints,['after-dialog'],'the page shows the change while counts load');
    counted.resolve({stale:false});await tick();assert.deepEqual(state.paints,['after-dialog']);
  }finally{globalThis.FormData=originalFormData;void closed;}
});

test('a new project opens after a re-render of its dialog but not after the dialog closed',async()=>{
  const originalFormData=globalThis.FormData;globalThis.FormData=class {constructor(form){this.fields=form.fields;}get(name){return this.fields[name]??null;}};
  try{
    for(const closed of [false,true]){
      const selected=[],navigated=[],background=[],modal={dataset:{openGeneration:'7'}},rerendered={dataset:{openGeneration:'7'}};
      const form={fields:{name:'Atlas',key:'ATL'},isConnected:false,closest:()=>modal,ownerDocument:{querySelector:selector=>selector==='.modal'&&!closed?rerendered:null}};
      const state=fixture({view:'roadmap',projectId:'p1',board:{}},{gateway:{execute:async()=>({entities:[{entityType:'project',id:'p9'}],events:[]})},app:{selectProject:id=>selected.push(id),nav:view=>navigated.push(view),refreshBackground:()=>background.push(true)}});
      state.app.saveProjectNew({preventDefault(){},target:form});await tick();await tick();
      assert.deepEqual([selected,navigated,background.length],closed?[[],[],1]:[['p9'],['roadmap'],0]);
    }
  }finally{globalThis.FormData=originalFormData;}
});

test('permission changes for two members save side by side',async()=>{
  let gateway;const requests=[];
  const state=fixture({view:'settings',projectId:'p1',board:{}},{gateway:{execute:(...args)=>gateway.execute(...args)}});
  gateway=createCommandGateway({data:state.data,api:{command:command=>new Promise(resolve=>requests.push({command,resolve}))}});
  state.data.users.push({id:'u1',admin:true,active:true});
  state.data.projects[0].members.push({userId:'alice',permissions:[],revision:1},{userId:'bob',permissions:[],revision:1});
  state.app.setMemberPermission('alice','manage_board',true);state.app.setMemberPermission('bob','manage_board',true);await tick();
  assert.deepEqual(requests.map(request=>request.command.payload.userId),['alice','bob']);
  for(const request of requests)request.resolve({entities:[{entityType:'membership',projectId:'p1',userId:request.command.payload.userId,manageBoard:true,manageRoadmap:false,revision:2}],events:[{}]});
  await tick();await tick();
  assert.deepEqual(state.toasts,[['Access updated'],['Access updated']]);
  assert.deepEqual(state.data.projects[0].members.map(member=>member.permissions),[['manage_board'],['manage_board']]);
});

test('a value typed while a failing save ran is the one kept as Not saved',async()=>{
  const state=taskPage({recovery:{handleCommandFailure:async()=>{}}});
  state.app.updTask('ONE-1','desc','First text');state.app.updTask('ONE-1','desc','Second text');
  state.requests[0].reject(new ApiError('Unable to reach oneloop',{code:'network_error',uncertain:true}));await tick();await tick();
  assert.equal(state.requests.length,1,'the newer value waits for the connection');
  assert.deepEqual(state.bridge.taskDraft('t1','desc'),{value:'Second text',unsaved:true});
});
