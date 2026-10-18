import assert from 'node:assert/strict';
import test,{beforeEach} from 'node:test';
import {createRequire} from 'node:module';
import {installViewBridge} from '../../../src/app/view-bridge.js';
import {createCommandGateway} from '../../../src/data/command-gateway.js';
import {ApiError} from '../../../src/data/api-client.js';
import {savedDoneOrder,saveDoneOrder} from '../../../src/data/done-order.js';
import {useGlobals,deferred,settle,tick,waitFor} from '../../support/helpers.cjs';

const {JSDOM}=createRequire(import.meta.url)('../../support/dom.cjs');
/* global document, location -- useGlobals below sets them for each test. */

// The bridge finds forms and fields in the page's document, so each test gets a page of its own.
beforeEach((t)=>{
  const {window}=new JSDOM('<!doctype html><body></body>',{url:'http://localhost/'});
  useGlobals(t,{document:window.document,location:window.location,FormData:window.FormData,Event:window.Event});
});

/** A form in the page, holding `html`; with `dialog`, inside an open dialog. */
function form(html,{dialog=false}={}){
  const element=document.createElement('form');element.innerHTML=html;
  if(dialog){const modal=document.createElement('div');modal.className='modal';modal.append(element);document.body.append(modal);}
  else document.body.append(element);
  return element;
}
/** Text inputs named and filled after `values`. */
const inputs=values=>Object.entries(values).map(([name,value])=>`<input name="${name}" value="${value}">`).join('');
/** The event of submitting `element`. */
const submit=element=>({target:element,preventDefault(){}});

/** Recovery with a connection and no conflicts; a test replaces what it needs. */
const quietRecovery={ensureOnline:()=>true,connection:'live',whenOnline(){},trackUnsaved(){},trackWrite(){},hasUnsavedInput:()=>false,revisionKey:()=>null,expectedRevision:(_key,fallback)=>fallback,finishRevision(){},isRevisionConflict:()=>false,async resolveConflict(){return {handled:false};},async handleCommandFailure(){},refreshFailed(){},isSavingTask:()=>false,clearPageError(){},beginRouteLoad(){}};

function fixture(context,overrides={}){
  const opened=[],calls=[],paints=[],toasts=[],saved=[];let closed=0;
  // The views' methods the bridge calls. Background and dialog-aware repaints count as whole repaints.
  const app={context:()=>context,openPeek(){},openModal(){},prepareBlock:()=>({mentions:[]}),openTask(id){opened.push(id);},refresh(){paints.push('all');},refreshBackground(){paints.push('all');},refreshAfterDialog(){paints.push('all');},refreshBoard(){paints.push('board');},refreshProfileAccess(options){if(!options)paints.push('profile-access');},
    refreshCounts(){},refreshEpic(){},refreshPool(){},refreshRoadmap(){},refreshTaskDrafts(){},refreshTaskHeader(){},refreshUsers(){},redrawDialog(){},showBlocked(){},togglePoolDescription(){},fieldError(){},isRendering:()=>false,validateFormDates:()=>true,signOutText:()=>'End your current browser session.',
    acceptMoreUsers(){},acceptMoreBoard(){},closeOverlays(){closed++;},selectProject(){},pageAfterSwitch:()=>context.view,nav(){},toast(...args){toasts.push(args);},noteTaskSaved(id){saved.push(id);},confirm(){},showTemporaryPassword(){},offerUndo(text,restore,{kind='success'}={}){toasts.push([text,kind,{action:{label:'Undo',run:()=>restore(message=>this.offerUndo(message,restore,{kind:'error'}))}}]);},...overrides.app};
  const data={session:{id:'s1',userId:'u1'},users:[],projects:[{id:'p1',members:[]}],tracks:[],epics:[],milestones:[],tasks:[],pool:[],browserSessions:[],appGrants:[],adminUsers:{loaded:false,ids:[],nextCursor:null}};
  const reads={
    async task(id){calls.push(['task',id]);const task={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1};data.tasks.push(task);return {stale:false,task};},
    async counts(id){calls.push(['counts',id]);},async board(){},adoptBoard:()=>false,async roadmap(){},async pool(){},cancel(){},async epic(){},async moreEpicTasks(){},async moreEpicActivity(){},
    ...overrides.reads,
  };
  const bridge=installViewBridge({app,data,reads,api:overrides.api??{},gateway:{hasUncertain:()=>false,...overrides.gateway},auth:overrides.auth??{},recovery:{...quietRecovery,...overrides.recovery},reloadBootstrap:overrides.reloadBootstrap??(async()=>({}))});
  return {app,data,reads,bridge,opened,calls,paints,toasts,saved,get closed(){return closed;}};
}

test('a task hash is read before the shell decides it is missing, and drawn again only when the page does not show it yet',async()=>{
  for(const [view,pageError,opened] of [['notfound',null,['ONE-1']],['task','loading',['ONE-1']],['task',null,[]]]){
    location.hash='#/task/ONE-1';
    const state=fixture({view,taskId:'ONE-1',projectId:'p1',board:{}},{recovery:{pageError}});
    await state.bridge.loadCurrentRoute();
    assert.deepEqual(state.calls,[['task','ONE-1'],['counts','p1']]);
    assert.deepEqual(state.opened,opened,`${view}, ${pageError}`);
  }
});

test('a session with a temporary password loads no page, as it has no project until the password changes',async()=>{
  for(const [hash,page] of [['#/board',{view:'board'}],['#/task/ONE-1',{view:'notfound',taskId:'ONE-1'}]]){
    location.hash=hash;
    const context={projectId:null,board:{},...page},boards=[];
    const state=fixture(context,{reads:{async board(projectId){boards.push(projectId);return {stale:false};}}});
    state.data.session.temporary=true;
    await state.bridge.loadCurrentRoute({reuseBootstrap:true});
    assert.deepEqual([...boards,...state.calls],[],hash);
  }
  // Once the password changes, the route loads the Board of the project the workspace opened.
  location.hash='#/board';
  const boards=[],state=fixture({view:'board',projectId:'p1',board:{}},{reads:{async board(projectId){boards.push(projectId);return {stale:false};}}});
  await state.bridge.loadCurrentRoute({reuseBootstrap:true});
  assert.deepEqual(boards,['p1']);
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

test('typed text saves on the revision its editor was focused at, and an assignee pick on the revision the page shows',async()=>{
  const sent=[];let finished='';
  const gateway={execute:async(_operation,payload,input)=>{sent.push([Object.keys(payload).find(key=>key!=='taskId'),input.expectedRevision]);return {entities:[],events:[]};}};
  // The editor was focused at revision 1; live data has moved the task to revision 2 since.
  const recovery={revisionKey:()=> 'task:opaque-1',expectedRevision:()=>1,captureEditor:()=>null,finishRevision:(key)=>{finished=key;}};
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway,recovery});
  state.data.tasks.push({id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:2,title:'Title',assignees:[]});
  await state.bridge.setAssignees('ONE-1',['u2']);
  state.app.updTask('ONE-1','title','Typed title');await settle();
  assert.deepEqual(sent,[['assigneeIds',2],['title',1]]);assert.equal(finished,'task:opaque-1');
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
  acknowledge(0);await settle();
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
  await settle();
  assert.equal(state.data.tasks[0].title,fail?'First title':latest);
  if(fail){assert.deepEqual(state.saved,[]);assert.equal(state.toasts[0][1],'error');}
  else{assert(state.saved.length>0);assert.deepEqual(state.toasts,[]);}
});

test('a title cut at its length limit keeps whole characters',async()=>{
  const payloads=[];
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1'},{gateway:{execute:async(_operation,payload)=>{payloads.push(payload);return {entities:[],events:[]};}}});
  state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',revision:1,title:'Original'});
  state.app.updTask('ONE-1','title','A'.repeat(139)+'😀');await settle();
  assert.equal(payloads[0].title,'A'.repeat(139));
});

test('a task draft is dropped when someone else signs in after the session ended',async()=>{
  const pending=[];
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1'},{gateway:{execute:()=>new Promise((_resolve,reject)=>pending.push(reject))}});
  state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',revision:3,title:'Saved title'});
  state.app.updTask('ONE-1','title','Typed title');
  assert.deepEqual(state.bridge.taskDraft('t1','title'),{value:'Typed title',unsaved:false});
  const person=state.data.session;state.data.session=null;
  pending[0](new ApiError('Authentication is required',{status:401,code:'unauthorized'}));await settle();
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
  pending[0](new ApiError('Authentication is required',{status:401,code:'unauthorized'}));await settle();
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
  const field=form('<div class="project-fields"><input name="name" value="Original"></div>').querySelector('[name="name"]');
  field.value='First';state.app.updateProjectField(field);
  field.value='Latest';state.app.updateProjectField(field);
  pending[0]({entities:[{entityType:'project',id:'p1',name:'First',revision:2}],events:[]});await settle();
  assert.equal(requests.length,2);assert.equal(requests[1].payload.name,'Latest');assert.equal(requests[1].expectedRevision,2);
  pending[1]({entities:[{entityType:'project',id:'p1',name:'Latest',revision:3}],events:[]});await settle();
  assert.equal(state.data.projects[0].name,'Latest');assert(!state.toasts.some(([,kind])=>kind==='error'));
});

test('a profile response from an ended session cannot repopulate private access data',async()=>{
  const sessions=deferred(),apps=deferred();
  const context={view:'profile',projectId:'p1',board:{}};
  const state=fixture(context,{api:{sessions:()=>sessions.promise,connectedApps:()=>apps.promise}});
  state.data.browserSessions.push({id:'old'});state.data.appGrants.push({id:'old'});
  const loading=state.bridge.loadCurrentRoute();
  state.data.session=null;state.data.browserSessions.length=0;state.data.appGrants.length=0;
  sessions.resolve({sessions:[{id:'leaked',clientName:'Browser',createdAt:1,lastActivityAt:1,current:false}]});
  apps.resolve({apps:[{id:'leaked',clientName:'Client',createdAt:1,expiresAt:2,projects:[],scopes:[]}]});
  await loading;
  assert.deepEqual(state.data.browserSessions,[]);assert.deepEqual(state.data.appGrants,[]);
});

test('an admin-list response cannot mutate or repaint a page that has been left',async()=>{
  const users=deferred(),context={view:'users',projectId:'p1',board:{}};
  const state=fixture(context,{api:{users:()=>users.promise}});
  const loading=state.bridge.loadCurrentRoute();context.view='board';
  users.resolve({users:[{id:'u2',username:'member',displayName:'Member',isAdmin:false,isActive:true,mustChangePassword:false,revision:1}],nextCursor:null});
  await loading;
  assert.equal(state.data.adminUsers.loaded,false);assert.deepEqual(state.data.adminUsers.ids,[]);assert.equal(state.data.users.length,0);
});

test('rapid assignee toggles serialize the latest intent without an intermediate repaint',async()=>{
  const requests=[],replies=[deferred(),deferred()];
  const gateway={execute:async(operation,payload,options)=>{
    requests.push({operation,payload,options});
    return replies[requests.length-1].promise;
  }};
  const recovery={revisionKey:(item)=>`task:${item.internalId}`,expectedRevision:(_key,fallback)=>fallback,finishRevision(){},captureEditor:()=>null};
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway,recovery});
  const item={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1,assignees:[]};state.data.tasks.push(item);
  const first=state.bridge.setAssignees('ONE-1',['u2']);
  const second=state.bridge.setAssignees('ONE-1',['u2','u3']);
  assert.equal(requests.length,1);assert.deepEqual(requests[0].payload.assigneeIds,['u2']);assert.equal(requests[0].options.expectedRevision,1);
  Object.assign(item,{revision:2,assignees:['u2']});replies[0].resolve({entities:[],events:[]});
  await waitFor(()=>requests.length===2,'the newer intent is sent');
  assert.deepEqual(requests[1].payload.assigneeIds,['u2','u3']);assert.equal(requests[1].options.expectedRevision,2);
  Object.assign(item,{revision:3,assignees:['u2','u3']});replies[1].resolve({entities:[],events:[]});
  await Promise.all([first,second]);
  assert.deepEqual(item.assignees,['u2','u3']);assert.deepEqual(state.paints,[]);assert.deepEqual(state.toasts,[]);assert.deepEqual(state.saved,['ONE-1']);
});

test('unchanged assignees stay quiet without issuing a command',async()=>{
  let writes=0;const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:async()=>{writes++;return {entities:[],events:[]};}}});
  const item={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1,assignees:['u2']};state.data.tasks.push(item);
  const result=await state.bridge.setAssignees('ONE-1',['u2']);
  assert.equal(writes,0);assert.deepEqual(item.assignees,['u2']);assert.deepEqual(state.paints,[]);assert.deepEqual(state.saved,[]);assert.equal(result,undefined);
});

test('failed assignee saves retain the canonical list loaded during conflict recovery',async()=>{
  const failure=Object.assign(new Error('record changed; latest revision is 2'),{code:'revision_conflict'});
  let state;
  const reads={task:async()=>{const item=state.data.tasks[0];Object.assign(item,{revision:2,assignees:['u3']});return {stale:false,task:item};}};
  state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:async()=>{throw failure;}},reads,recovery:{isRevisionConflict:()=>false,handleCommandFailure:async()=>{}}});
  const item={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1,assignees:['u1']};state.data.tasks.push(item);
  await assert.rejects(state.bridge.setAssignees('ONE-1',['u2']),failure);
  assert.deepEqual(item.assignees,['u3']);assert.equal(item.revision,2);
});

test('an old assignee response cannot mutate a same-id task in a replacement session',async()=>{
  const reply=deferred(),state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:()=>reply.promise}});
  state.data.tasks.push({id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:1,assignees:[]});
  const pending=state.bridge.setAssignees('ONE-1',['u2']);
  const replacement={id:'ONE-1',internalId:'opaque-1',projectId:'p1',epicId:'e1',revision:8,assignees:['u9']};
  state.data.session={id:'s2',userId:'u2'};state.data.tasks.splice(0,state.data.tasks.length,replacement);reply.resolve({entities:[],events:[]});
  await pending;assert.deepEqual(replacement.assignees,['u9']);assert.equal(replacement.revision,8);
});

test('a command response from an ended session cannot close or repaint the next session',async()=>{
  const reply=deferred(),gateway={execute:()=>reply.promise};
  const context={view:'roadmap',projectId:'p1',board:{}};
  const state=fixture(context,{gateway});state.data.tracks.push({id:'track-1',projectId:'p1',name:'Old',revision:1});
  state.app.saveTrack(submit(form(inputs({name:'New'}))),'track-1');
  state.data.session={id:'s2',userId:'u2'};reply.resolve({entities:[],events:[]});
  await tick();
  assert.equal(state.closed,0);assert.deepEqual(state.paints,[]);assert.deepEqual(state.toasts,[]);
});

test('profile writes are ordered and only the latest value updates the current view',async()=>{
  const pending=[];const context={view:'profile',projectId:'p1',board:{}};
  const state=fixture(context,{api:{updateProfile:(displayName)=>new Promise((resolve)=>pending.push({displayName,resolve}))}});
  const me={id:'u1',name:'Original'};state.data.users.push(me);
  state.app.updMe('First');state.app.updMe('Second');
  await waitFor(()=>pending.length===1,'the first name is sent');
  pending[0].resolve({user:{displayName:'First',avatarUrl:null}});
  await waitFor(()=>pending.length===2,'the second name is sent after the first');
  assert.equal(me.name,'Original');assert.deepEqual(state.paints,[]);
  pending[1].resolve({user:{displayName:'Second',avatarUrl:null}});await tick();
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
  state.app.addMember('u3');await settle();
  state.app.setMemberPermission('u2','manage_board',true);await settle();
  state.app.removeMember('u2');assert.equal(confirmations.length,1);confirmations[0].confirm();
  await settle();
  assert.deepEqual(sent,['membership.add','membership.update','membership.remove']);
});


test('task creation stays one interaction across acceptance and a slow follow-up read',async()=>{
  const write=deferred(),read=deferred();let writes=0;
  const state=fixture({view:'board',projectId:'p1',board:{},modal:{type:'task'}},{gateway:{execute:()=>{writes++;return write.promise;}},reloadBootstrap:()=>read.promise});
  state.data.tracks.push({id:'t1',projectId:'p1'});
  const element=form(inputs({trackId:'t1',title:'One task'})+'<button type="submit">Save</button>'),button=element.querySelector('button'),event=submit(element);
  state.app.saveTask(event);state.app.saveTask(event);
  assert.equal(writes,1);assert.equal(button.disabled,true);
  write.resolve({entities:[],events:[]});await settle();
  assert.equal(state.closed,1);
  state.app.saveTask(event);assert.equal(writes,1);
  read.resolve({stale:false});await settle();
  assert.equal(state.closed,1);assert.equal(button.disabled,false);
});

test('a new task needs a track of its project, and an epic it names must be open and puts the task on its track',async()=>{
  const errors=[],sent=[];
  const state=fixture({view:'board',projectId:'p1',board:{},modal:{type:'task'}},{gateway:{execute:async(operation,payload)=>{sent.push([operation,payload]);return {entities:[],events:[]};}},app:{fieldError:(_form,name,message)=>errors.push([name,message])}});
  state.data.tracks.push({id:'t1',projectId:'p1',name:'Backend'},{id:'t2',projectId:'p1',name:'iOS'},{id:'other',projectId:'p2',name:'Elsewhere'});
  state.data.epics.push({id:'open',projectId:'p1',trackId:'t1',state:'planning'},{id:'closed',projectId:'p1',trackId:'t1',state:'done'});
  const create=values=>state.app.saveTask(submit(form(inputs({title:'Placed task',...values}))));
  for(const values of [{trackId:''},{trackId:'other'},{trackId:'t1',epicId:'gone'},{trackId:'t1',epicId:'closed'}])create(values);
  assert.deepEqual(errors,[
    ['trackId','Choose a track.'],['trackId','Choose a track.'],
    ['epicId','This epic is no longer available. Choose another one, or No epic.'],
    ['epicId','This epic is completed. Reopen it before adding tasks.'],
  ]);
  // The form still shows iOS, but the epic moved to Backend meanwhile: the task goes with the epic.
  create({trackId:'t2',epicId:'open'});await settle();
  assert.deepEqual(sent,[['task.create',{projectId:'p1',trackId:'t1',epicId:'open',title:'Placed task',description:'',deadline:null,assigneeIds:[]}]]);
});

test('an accepted create closes successfully even when refreshing the view fails',async()=>{
  const failure=new Error('Read unavailable'),refreshFailures=[];let writes=0;
  const state=fixture({view:'board',projectId:'p1',board:{},modal:{type:'task'}},{gateway:{execute:async()=>{writes++;return {entities:[],events:[]};}},reloadBootstrap:async()=>{throw failure;},recovery:{refreshFailed:error=>refreshFailures.push(error)}});
  state.data.tracks.push({id:'t1',projectId:'p1'});
  state.app.saveTask(submit(form(inputs({trackId:'t1',title:'Saved task'}))));await settle();
  assert.equal(writes,1);assert.equal(state.closed,1);
  assert.deepEqual(state.toasts,[['Task created']]);assert.deepEqual(refreshFailures,[failure]);
});

test('only the latest project selection may apply a completed bootstrap',async()=>{
  const first=deferred(),second=deferred(),selected=[];
  const state=fixture({view:'board',projectId:'p1',board:{}},{reloadBootstrap:({projectId})=>projectId==='p1'?first.promise:second.promise,app:{selectProject:id=>selected.push(id)}});
  const a=state.bridge.selectProject('p1');
  const b=state.bridge.selectProject('p2');
  second.resolve({stale:false});await b;first.resolve({stale:true});await a;
  assert.deepEqual(selected,['p2']);
});

test('a slow Board search, Done order or project switch marks the page busy after a moment, until its read ends',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  t.after(()=>saveDoneOrder('manual',undefined));
  const page=document.createElement('main');page.className='content';document.body.append(page);
  const starts={search:bridge=>bridge.filterBoard({search:'slow'}),'Done order':bridge=>bridge.setDoneOrder('completed'),'project switch':bridge=>bridge.selectProject('p1')};
  for(const [name,start] of Object.entries(starts))for(const ending of ['resolve','reject']){
    const read=deferred(),state=fixture({view:'board',projectId:'p1',board:{}},{reads:{board:()=>read.promise},reloadBootstrap:()=>read.promise});
    const done=start(state.bridge).catch(()=>{});await settle();
    t.mock.timers.tick(119);assert.equal(page.getAttribute('aria-busy'),null,`${name}: a quick read shows nothing`);
    t.mock.timers.tick(1);assert.equal(page.getAttribute('aria-busy'),'true',name);
    read[ending](ending==='resolve'?{stale:true}:new Error('offline'));await done;
    assert.equal(page.getAttribute('aria-busy'),null,`${name}: the busy state ends when the read does (${ending})`);
  }
});

test('a delayed task read cannot leave a newer Profile route',async()=>{
  location.hash='#/task/ONE-1';
  const taskRead=deferred(),sessions=deferred(),apps=deferred();
  const context={view:'task',taskId:'ONE-1',projectId:'p1',board:{}};
  const state=fixture(context,{reads:{task:()=>taskRead.promise},api:{sessions:()=>sessions.promise,connectedApps:()=>apps.promise}});
  const old=state.bridge.loadCurrentRoute();context.view='profile';context.taskId=null;location.hash='#/profile';
  const next=state.bridge.loadCurrentRoute();taskRead.resolve({stale:false,task:{id:'ONE-1'}});await old;
  assert.deepEqual(state.opened,[]);
  sessions.resolve({sessions:[]});apps.resolve({apps:[]});await next;assert.deepEqual(state.opened,[]);
});

test('Pool read actions rely on in-place read callbacks without whole-app refreshes',async()=>{
  const state=fixture({view:'board',projectId:'p1',board:{}},{reads:{pool:async()=>({stale:false}),morePool:async()=>({stale:false})}});
  await state.bridge.openPool();await state.bridge.selectPool('mine');await state.bridge.loadMorePool('mine');
  assert.deepEqual(state.paints,[]);
});

test('choosing a Done order saves it and reads the Board again with the same filters',async(t)=>{
  t.after(()=>saveDoneOrder('manual',undefined));
  const reads=[],board={search:'checkout',trackIds:[],epicIds:[],assigneeIds:[],blocked:false};
  const state=fixture({view:'board',projectId:'p1',board},{reads:{board:async(...args)=>{reads.push([...args,savedDoneOrder(undefined)]);return {stale:false};}}});
  await state.bridge.setDoneOrder('completed');
  assert.deepEqual(reads,[['p1',board,'completed']]);
  await state.bridge.setDoneOrder('anything');
  assert.equal(reads.at(-1)[2],'manual');
});

test('a failed obsolete task read cannot put the new Profile page into an error state',async()=>{
  for(const status of [403,404,500]){
    location.hash='#/task/ONE-1';
    const taskRead=deferred(),sessions=deferred(),apps=deferred();
    const context={view:'task',taskId:'ONE-1',projectId:'p1',board:{}};
    const state=fixture(context,{reads:{task:()=>taskRead.promise},api:{sessions:()=>sessions.promise,connectedApps:()=>apps.promise}});
    const old=state.bridge.loadCurrentRoute();context.view='profile';context.taskId=null;location.hash='#/profile';
    const next=state.bridge.loadCurrentRoute();taskRead.reject(Object.assign(new Error('Old route failed'),{status}));
    assert.deepEqual(await old,{stale:true});assert.deepEqual(state.opened,[]);
    sessions.resolve({sessions:[]});apps.resolve({apps:[]});await next;
  }
});

/** The Pool's capture field and its open notes, as the page draws them. */
function poolCapture(){
  document.body.innerHTML='<div class="pool-capture is-expanded"><input id="poolAdd"><textarea id="poolNewDesc"></textarea></div>';
  return {input:document.getElementById('poolAdd'),notes:document.getElementById('poolNewDesc')};
}

test('Enter on the empty Pool field says nothing while the item that left it is on its way',async()=>{
  const capture=poolCapture();
  const sent=deferred();
  const state=fixture({view:'board',projectId:'p1',poolTab:'mine',board:{}},{gateway:{execute:()=>sent.promise}});
  const event={key:'Enter',target:capture.input,preventDefault(){}};
  capture.input.value='Only idea';state.app.poolKey(event);state.app.poolKey(event);
  assert.deepEqual(state.toasts,[]);
  sent.resolve({entities:[],events:[]});await settle();await settle();
  state.app.poolKey(event);
  assert.deepEqual(state.toasts.at(-1),['Give the Pool item a title.','error']);
});

test('a Pool item that can\'t be added comes back once the field is free, and is added once',async()=>{
  const capture=poolCapture();
  const commands=[];let fail=true;
  const state=fixture({view:'board',projectId:'p1',poolTab:'mine',board:{}},{gateway:{execute:async(_operation,payload,options)=>{commands.push([payload.title,options.interactionKey]);if(fail&&payload.title==='First idea')throw new ApiError('Unable to reach oneloop',{code:'network_error',uncertain:true});return {entities:[],events:[]};}}});
  const event={key:'Enter',target:capture.input,preventDefault(){}};
  capture.input.value='First idea';capture.notes.value='Its notes';state.app.poolKey(event);
  capture.input.value='Typed meanwhile';await settle();await settle();
  assert.equal(capture.input.value,'Typed meanwhile','the item waits while the field is in use');
  state.app.poolKey(event);await settle();await settle();
  assert.deepEqual([capture.input.value,capture.notes.value],['First idea','Its notes'],'it comes back once the field is free');
  fail=false;state.app.poolKey(event);await settle();
  assert.deepEqual(commands.map(([title])=>title),['First idea','Typed meanwhile','First idea']);
  assert.equal(commands[2][1],commands[0][1],'sent again with its key, so an unknown result can\'t add it twice');
  assert.equal(capture.input.value,'');
});

test('a task in another project loads its parent context before opening and counts that project',async()=>{
  location.hash='#/task/TWO-1';
  const context={view:'notfound',taskId:'TWO-1',projectId:'p1',board:{}},roadmaps=[],counted=[];
  const task={id:'TWO-1',internalId:'t2',projectId:'p2',epicId:'e2'};
  let state;
  state=fixture(context,{
    reads:{task:async()=>({stale:false,task}),roadmap:async projectId=>{roadmaps.push(projectId);state.data.epics.push({id:'e2',trackId:'r2'});state.data.tracks.push({id:'r2',projectId:'p2'});return {stale:false};},counts:async projectId=>counted.push(projectId)},
    app:{openTask(id){assert.equal(id,'TWO-1');assert.equal(state.data.tracks[0].id,'r2');context.view='task';context.projectId='p2';}},
  });
  state.data.projects.push({id:'p2',members:[]});
  await state.bridge.loadCurrentRoute();assert.deepEqual(roadmaps,['p2']);assert.deepEqual(counted,['p2']);
});


test('profile password success is announced only after completion',async()=>{
  for(const ok of [true,false,undefined]){
    const state=fixture({view:'profile',projectId:'p1'},{auth:{changePassword:async()=>ok}});
    state.app.changePassword(submit(form('')));await tick();
    assert.deepEqual(state.toasts,ok?[['Password changed. Other sessions and app access revoked']]:[]);
  }
});

test('epic completion describes singular and plural open tasks and closes the drawer',async()=>{
  for(const count of [1,2]){
  document.body.innerHTML='<div class="peek"></div>';
  let dialog;
  const state=fixture({view:'roadmap',projectId:'p1'},{app:{confirm:value=>{dialog=value;}},gateway:{execute:async()=>({entities:[],events:[]})}});
  state.data.epics.push({id:'e1',projectId:'p1',revision:1});
  state.data.tasks.push(...Array.from({length:count},()=>({epicId:'e1',state:'planning'})));
  state.app.closeEpic('e1');assert.equal(dialog.text,count===1?'1 open task stays where it is.':'2 open tasks stay where they are.');
  dialog.confirm();await tick();assert.equal(state.closed,1);
  }
});

/** The Edit user dialog, with its name typed. */
const userDialog=name=>form(`<input name="name" value="${name}"><input type="checkbox" name="admin"><input type="checkbox" name="active" checked>`,{dialog:true});

test('admin revision conflict reloads through the affected page and retries with its fresh revision',async()=>{
  const errors=[],revisions=[],dialog=userDialog('Admin edit'),name=dialog.querySelector('[name="name"]');
  const context={view:'users',modal:{type:'user',id:'u2'}};
  const state=fixture(context,{recovery:{isRevisionConflict:error=>error.code==='revision_conflict'},app:{fieldError:(_form,_name,message)=>errors.push(message)},api:{
    users:async({afterUsername})=>afterUsername?{users:[{id:'u2',username:'zeta',displayName:'Self-service name',isAdmin:false,isActive:true,revision:4}],nextCursor:null}:{users:[{id:'u1',username:'admin',displayName:'Owner',isAdmin:true,isActive:true,revision:1}],nextCursor:'admin'},
    updateUser:async(_id,input)=>{revisions.push(input.expectedRevision);if(revisions.length===1)throw Object.assign(new Error('changed'),{code:'revision_conflict'});return {displayName:input.displayName,isAdmin:false,isActive:true,revision:5};},
  }});
  state.data.users.push({id:'u1',admin:true},{id:'u2',name:'Old name',admin:false,active:true,revision:1});
  state.app.saveUser(submit(dialog),'u2');
  await tick();
  assert.equal(name.value,'Self-service name');assert.match(errors[0],/Review the latest/);
  assert.equal(state.data.users.find(user=>user.id==='u2').revision,4);
  name.value='Reviewed edit';state.app.saveUser(submit(dialog),'u2');await tick();
  assert.deepEqual(revisions,[1,4]);assert.equal(state.closed,1);
});

test('opening the Pool reads both scopes side by side',async()=>{
  const requested=[],pending=[];
  const state=fixture({view:'board',projectId:'p1',board:{}},{reads:{pool:(_project,scope)=>{requested.push(scope);return new Promise(resolve=>pending.push(resolve));}}});
  const opening=state.bridge.openPool();
  assert.deepEqual(requested,['personal','team'],'a slow scope does not hold up the other');
  pending[0]({stale:true});pending[1]({stale:false});
  assert.equal((await opening).stale,true);
});

test('a Users refresh reloads every page already shown',async()=>{
  const cursors=[];const context={view:'users',projectId:'p1',board:{}};
  const page=(from)=>({users:Array.from({length:50},(_,index)=>({id:`u${from+index}`,username:`user${String(from+index).padStart(3,'0')}`,displayName:`User ${from+index}`,isAdmin:false,isActive:true,revision:1})),nextCursor:from<100?`user${from+49}`:null});
  const state=fixture(context,{api:{users:async({afterUsername})=>{cursors.push(afterUsername);return page(afterUsername?Number(afterUsername.slice(4))+1:0);}}});
  await state.bridge.loadCurrentRoute();state.app.loadMoreUsers();await settle();
  assert.equal(state.data.adminUsers.ids.length,100);
  cursors.length=0;await state.bridge.loadCurrentRoute({refresh:true});
  assert.deepEqual(cursors,[undefined,'user49']);assert.equal(state.data.adminUsers.ids.length,100);
  cursors.length=0;await state.bridge.loadCurrentRoute();
  assert.deepEqual(cursors,[undefined],'opening Users again starts from the first page');
});

test('Save in Edit user finds the account after a refresh replaced its row',async()=>{
  const saved=[],errors=[],dialog=userDialog('Renamed');
  const state=fixture({view:'users',modal:{type:'user',id:'u2'}},{app:{fieldError:(_form,name,message)=>errors.push([name,message])},api:{updateUser:async(id,input)=>{saved.push([id,input.displayName]);return {displayName:input.displayName,isAdmin:false,isActive:true,revision:2};}}});
  state.data.users.push({id:'u1',admin:true,active:true},{id:'u2',name:'Old name',admin:false,active:true,revision:1});
  state.app.saveUser(submit(dialog),'u2');
  state.data.users.splice(1,1,{id:'u2',name:'Old name',admin:false,active:true,revision:1});
  await settle();
  assert.deepEqual(saved,[['u2','Renamed']]);assert.equal(state.closed,1);assert.equal(state.data.users[1].name,'Renamed');
  state.app.saveUser(submit(dialog),'gone');
  assert.deepEqual(errors,[['name','This user is no longer listed. Reload Users and try again.']]);
});

test('Save in Edit user after the admin role is gone says so and leaves Users, instead of doing nothing',async()=>{
  const saved=[],navigated=[],dialog=userDialog('Renamed');
  const state=fixture({view:'users',modal:{type:'user',id:'u2'}},{app:{nav:(view)=>navigated.push(view)},api:{updateUser:async(id,input)=>{saved.push([id,input.displayName]);return {};}}});
  state.data.users.push({id:'u1',admin:false,active:true},{id:'u2',name:'Old name',admin:false,active:true,revision:1});
  state.app.saveUser(submit(dialog),'u2');await settle();
  assert.deepEqual(saved,[],'nothing is sent');
  assert.equal(state.closed,1);assert.deepEqual(navigated,['board']);
  assert.deepEqual(state.toasts,[['You no longer have admin access.','info']]);
});

test('an avatar larger than the server takes is refused before it is sent, and a refusal by size says the limit',async()=>{
  const sent=[];let answer;
  const state=fixture({view:'profile',projectId:'p1',board:{}},{api:{uploadAvatar:async(file)=>{sent.push(file.size);throw answer;}}});
  state.data.users.push({id:'u1',name:'Me',admin:false,active:true});state.data.limits={maxAvatarBytes:5*1024*1024};
  const input=(size)=>({files:[{size}],value:'picked'});
  const big=input(6*1024*1024);state.app.setAvatar(big);await settle();
  assert.deepEqual(sent,[]);assert.equal(big.value,'','the same image can be picked again');
  answer=new ApiError('The request exceeds the size limit',{status:413,code:'request_too_large'});state.app.setAvatar(input(4*1024*1024));await settle();await settle();
  answer=new ApiError('invalid avatar: must be a PNG, JPEG or WebP image',{status:400,code:'validation_failed',details:{field:'avatar',message:'must be a PNG, JPEG or WebP image'}});state.app.setAvatar(input(1024));await settle();await settle();
  assert.deepEqual(state.toasts,[['Use an image of at most 5 MiB.','error'],['Use an image of at most 5 MiB.','error'],['The avatar must be a PNG, JPEG or WebP image.','error']]);
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

test('an epic chosen on the task page from another track moves the task there with it',async()=>{
  const state=taskPage();
  state.item.trackId='t1';
  state.data.epics.push({id:'e1',projectId:'p1',trackId:'t1',state:'active'},{id:'elsewhere',projectId:'p1',trackId:'t2',state:'planning'});
  state.app.updTask('ONE-1','epicId','elsewhere');
  assert.deepEqual(state.requests[0].command.payload,{taskId:'t1',epicId:'elsewhere',trackId:'t2'});
  state.accept(0,{trackId:'t2',epicId:'elsewhere'});await settle();
  state.app.updTask('ONE-1','epicId','e1');
  assert.deepEqual(state.requests[1].command.payload,{taskId:'t1',epicId:'e1',trackId:'t1'});
  state.accept(1,{trackId:'t1',epicId:'e1'});await settle();
  // The same track's epic needs no track.
  state.data.epics.push({id:'beside',projectId:'p1',trackId:'t1',state:'active'});
  state.app.updTask('ONE-1','epicId','beside');
  assert.deepEqual(state.requests[2].command.payload,{taskId:'t1',epicId:'beside'});
});

test('the task page moves a task only to a track of its project',async()=>{
  const state=taskPage();
  state.data.tracks.push({id:'t2',projectId:'p1'},{id:'other',projectId:'p2'});
  for(const trackId of ['gone','other'])assert.equal(state.app.updTask('ONE-1','trackId',trackId),false);
  assert.deepEqual(state.toasts,[['This track is no longer available. Choose another one.','error'],['This track is no longer available. Choose another one.','error']]);
  state.app.updTask('ONE-1','trackId','t2');
  assert.deepEqual(state.requests.map(request=>request.command.payload),[{taskId:'t1',trackId:'t2'}]);
});

test('two task fields saved close together build on each other instead of conflicting',async()=>{
  const state=taskPage();
  state.app.updTask('ONE-1','title','New title');state.app.updTask('ONE-1','desc','New description');state.app.updTask('ONE-1','state','progress');
  assert.equal(state.requests.length,1,'the next field waits for the first reply');
  state.accept(0,{title:'New title'});await settle();
  assert.equal(state.requests.length,2);assert.equal(state.requests[1].command.payload.description,'New description');assert.equal(state.requests[1].command.expectedRevision,2);
  state.accept(1,{description:'New description'});await settle();
  assert.equal(state.requests[2].command.operation,'task.move');assert.equal(state.requests[2].command.expectedRevision,3);
  state.accept(2,{status:'in_progress'});await settle();await settle();
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
  state.requests[0].reject(changedElsewhere());await settle();
  assert.equal(state.requests[1].command.expectedRevision,2);
  state.accept(1,{title:'My title'});await settle();await settle();
  assert.equal(state.requests[2].command.payload.description,'My description');
  assert.equal(state.requests[2].command.expectedRevision,1,'the description was typed on revision 1, so it meets the change at 2');
});

test('a newer value of a field kept with Keep my changes saves on top of it',async()=>{
  let keep;
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',resolveConflict:({retry})=>new Promise(resolve=>{keep=async()=>resolve({handled:true,saved:true,result:await retry(2)});}),handleCommandFailure:async()=>{}};
  const state=taskPage({recovery});
  state.app.updTask('ONE-1','title','My title');
  state.requests[0].reject(changedElsewhere());await settle();
  // The person types more while the prompt shows the other title, then keeps theirs.
  state.app.updTask('ONE-1','title','My longer title');
  void keep();await settle();
  state.accept(1,{title:'My title'});await settle();await settle();
  assert.equal(state.requests[2].command.payload.title,'My longer title');
  assert.equal(state.requests[2].command.expectedRevision,3,'it builds on the kept title instead of conflicting with it');
});

test('a conflict prompt that closes without a choice keeps the typed value as Not saved',async()=>{
  const conflict=new ApiError('record changed; latest revision is 2',{status:409,code:'revision_conflict'}),drafted=[];
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',resolveConflict:async()=>({handled:true,saved:false}),handleCommandFailure:async()=>{}};
  const state=taskPage({recovery,app:{refreshTaskDrafts:id=>drafted.push(id)}});
  state.app.updTask('ONE-1','desc','My description');state.requests[0].reject(conflict);await settle();await settle();
  assert.deepEqual(state.bridge.taskDraft('t1','desc'),{value:'My description',unsaved:true});
  assert.deepEqual(drafted,['ONE-1']);assert.deepEqual(state.toasts,[],'the note on the field reports it');
  state.app.updTask('ONE-1','state','done');state.requests[1].reject(conflict);await settle();await settle();
  assert.deepEqual(state.toasts,[['Your change was not saved. Review the latest version and try again.','error']]);
  state.app.saveTaskDraft('ONE-1','desc');
  assert.equal(state.requests[2].command.payload.description,'My description');assert.equal(state.requests[2].command.expectedRevision,1,'Save keeps the revision the text was written against');
});

test('a Not saved field edited again still saves from the revision it was typed on',async()=>{
  // The prompt closed without a choice after reading someone else's revision 2.
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',resolveConflict:async()=>{Object.assign(state.item,{revision:2,desc:'Their description'});return {handled:true,saved:false};},handleCommandFailure:async()=>{}};
  const state=taskPage({recovery});
  state.app.updTask('ONE-1','desc','My description');state.requests[0].reject(changedElsewhere());await settle();await settle();
  assert.deepEqual(state.bridge.taskDraft('t1','desc'),{value:'My description',unsaved:true});
  // The field shows the draft, never their text. The person adds to it.
  state.app.updTask('ONE-1','desc','My description, longer');await settle();
  assert.equal(state.requests[1].command.expectedRevision,1,'it still meets their change');
});

test('text kept when edit rights ended saves from its revision after they come back',async()=>{
  let remembered=1;
  const recovery={revisionKey:()=>'task:t1',expectedRevision:(_key,latest)=>remembered??latest,handleCommandFailure:async()=>{}};
  const state=taskPage({recovery});
  state.bridge.keepTaskDraft('ONE-1','title','Typed before rights ended');
  // Someone else saved revision 2, and the page that remembered revision 1 is gone.
  Object.assign(state.item,{revision:2,title:'Their title'});remembered=undefined;
  state.app.updTask('ONE-1','title','Typed before rights ended, and more');await settle();
  assert.equal(state.requests[0].command.expectedRevision,1);
});

/** An open dialog's form with text inputs filled after `values`. */
const dialogForm=values=>form(inputs(values),{dialog:true});
const epicDialog=()=>dialogForm({trackId:'r1',title:'Epic',desc:'My description',start:'2026-01-01',end:''});
function epicPage(recovery,gateway,app={}){
  const state=fixture({view:'roadmap',projectId:'p1',board:{}},{recovery,gateway,app});
  state.data.tracks.push({id:'r1',projectId:'p1'});state.data.epics.push({id:'e1',projectId:'p1',trackId:'r1',title:'Epic',desc:'',start:'2026-01-01',end:null,revision:1});
  return state;
}

test('Use latest in a dialog that saves several fields draws it again from the saved values',async()=>{
  const redrawn=[],finished=[];
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',revisionKey:()=>'epic:e1',finishRevision:key=>finished.push(key),handleCommandFailure:async()=>{},
    resolveConflict:async({target})=>{assert.equal(target.element,undefined,'no one field can show the saved values');target.acceptLatest({});return {handled:true,saved:false,choice:'latest'};}};
  const state=epicPage(recovery,{execute:async()=>{throw changedElsewhere();}},{redrawDialog:()=>redrawn.push(true)});
  state.app.saveEpic(submit(epicDialog()),'e1');await settle();await settle();
  assert.deepEqual(redrawn,[true]);assert.deepEqual(finished,['epic:e1'],'the dialog now shows the latest revision');
});

/** A conflict prompt answered with Keep my changes, which saves again at the latest revision. */
const keepMine=()=>({isRevisionConflict:error=>error.code==='revision_conflict',revisionKey:()=>'record',expectedRevision:(_key,latest)=>latest,finishRevision(){},handleCommandFailure:async()=>{},
  resolveConflict:async({retry})=>({handled:true,saved:true,result:await retry(2)})});
/** A gateway whose first save meets someone else's change. */
const conflictOnce=(sent)=>({execute:async(_operation,payload,options)=>{sent.push(payload);if(sent.length===1)throw changedElsewhere();return {entities:[],events:[]};}});

test('Keep my changes in Edit epic saves only the fields the person changed, so a teammate\'s new dates stay',async()=>{
  const sent=[],state=epicPage(keepMine(),conflictOnce(sent));
  state.app.openModal('epic','e1');
  // A teammate moves the epic while the dialog is open; it still shows the old dates.
  Object.assign(state.data.epics[0],{start:'2026-02-01',end:'2026-03-01',revision:2});
  state.app.saveEpic(submit(dialogForm({trackId:'r1',title:'Renamed epic',desc:'',start:'2026-01-01',end:''})),'e1');await settle();await settle();
  assert.deepEqual(sent,[{epicId:'e1',title:'Renamed epic'},{epicId:'e1',title:'Renamed epic'}]);
});

test('Keep my changes in Edit milestone saves only the fields the person changed, so a teammate\'s new date stays',async()=>{
  const sent=[],state=fixture({view:'roadmap',projectId:'p1',board:{}},{recovery:keepMine(),gateway:conflictOnce(sent)});
  state.data.milestones.push({id:'m1',projectId:'p1',name:'Launch',desc:'Ship it',date:'2026-11-10',revision:1});
  state.app.openModal('milestone','m1');
  Object.assign(state.data.milestones[0],{date:'2026-12-24',revision:2});
  state.app.saveMilestone(submit(dialogForm({name:'Public launch',desc:'Ship it',date:'2026-11-10'})),'m1');await settle();await settle();
  assert.deepEqual(sent,[{milestoneId:'m1',title:'Public launch'},{milestoneId:'m1',title:'Public launch'}]);
});

test('a Pool promotion sends the item\'s title and description only when the person changed them',async()=>{
  const sent=[],state=fixture({view:'board',projectId:'p1',board:{},modal:{type:'task',poolId:'i1',title:'Idea',desc:'Notes'}},{recovery:keepMine(),gateway:conflictOnce(sent)});
  state.data.pool.push({id:'i1',projectId:'p1',scope:'project',title:'Idea',desc:'Notes',revision:1});state.data.tracks.push({id:'t1',projectId:'p1'});state.data.epics.push({id:'e1',projectId:'p1',trackId:'t1',state:'planning'});
  state.app.saveTask(submit(dialogForm({trackId:'t1',epicId:'e1',title:'Idea',desc:'My own notes',deadline:'2026-12-01'})));await settle();await settle();
  assert.deepEqual(sent.map(payload=>Object.keys(payload).sort()),[['assigneeIds','deadline','description','epicId','poolItemId','trackId'],['assigneeIds','deadline','description','epicId','poolItemId','trackId']]);
});

test('a conflict over a dialog\'s date draws the dialog again, since its picker can\'t show the saved date by itself',async()=>{
  let target;const redrawn=[];
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',revisionKey:()=>'epic:e1',finishRevision(){},handleCommandFailure:async()=>{},resolveConflict:async(input)=>{target=input.target;return {handled:true,saved:false};}};
  const state=epicPage(recovery,{execute:async()=>{throw changedElsewhere();}},{redrawDialog:()=>redrawn.push(true)});
  state.app.openModal('epic','e1');
  // Its date picker keeps the date in a hidden input.
  state.app.saveEpic(submit(form(inputs({trackId:'r1',title:'Epic',desc:'',end:''})+'<input type="hidden" name="start" value="2026-01-05">',{dialog:true})),'e1');await settle();await settle();
  assert.equal(target.element,undefined,'no field shows the saved date by itself');
  assert.equal(target.latestValue({start:'2026-02-01'}),'2026-02-01','the prompt still names the saved date');
  target.acceptLatest();
  assert.deepEqual(redrawn,[true]);
});

test('a conflict over a milestone\'s name shows the saved name',async()=>{
  let target;
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',revisionKey:()=>'milestone:m1',finishRevision(){},handleCommandFailure:async()=>{},resolveConflict:async(input)=>{target=input.target;return {handled:true,saved:false};}};
  const state=fixture({view:'roadmap',projectId:'p1',board:{}},{recovery,gateway:{execute:async()=>{throw changedElsewhere();}}});
  const milestone={id:'m1',projectId:'p1',name:'Launch',desc:'',date:'2026-11-10',revision:1};state.data.milestones.push(milestone);
  state.app.openModal('milestone','m1');
  state.app.saveMilestone(submit(dialogForm({name:'Public launch',desc:'',date:'2026-11-10'})),'m1');await settle();await settle();
  assert.equal(target.latestValue({...milestone,name:'Beta launch'}),'Beta launch');
});

test('a dialog whose conflict prompt closed without a choice saves again from the revision it was opened at',async()=>{
  const remembered=new Map([['epic:e1',1]]),sent=[];
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',revisionKey:()=>'epic:e1',expectedRevision:(key,latest)=>remembered.get(key)??latest,finishRevision:key=>remembered.delete(key),handleCommandFailure:async()=>{},
    resolveConflict:async()=>{state.data.epics[0].revision=2;return {handled:true,saved:false};}};
  const state=epicPage(recovery,{execute:async(_operation,_payload,options)=>{sent.push(options.expectedRevision);throw changedElsewhere();}});
  const dialog=epicDialog();
  state.app.saveEpic(submit(dialog),'e1');await settle();await settle();
  state.app.saveEpic(submit(dialog),'e1');await settle();await settle();
  assert.deepEqual(sent,[1,1],'the dialog still shows the typed values, so it meets the other change again');
});

test('a Pool promotion whose conflict prompt closed without a choice saves again from the revision it was opened at',async()=>{
  const remembered=new Map([['pool:i1',1]]),sent=[];
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',revisionKey:()=>'pool:i1',expectedRevision:(key,latest)=>remembered.get(key)??latest,finishRevision:key=>remembered.delete(key),handleCommandFailure:async()=>{},
    resolveConflict:async()=>{state.data.pool[0].revision=2;return {handled:true,saved:false};}};
  const state=fixture({view:'board',projectId:'p1',board:{},modal:{type:'task',poolId:'i1'}},{recovery,gateway:{execute:async(_operation,_payload,options)=>{sent.push(options.expectedRevision);throw changedElsewhere();}}});
  state.data.pool.push({id:'i1',projectId:'p1',scope:'project',title:'Idea',desc:'',revision:1});state.data.tracks.push({id:'t1',projectId:'p1'});
  const dialog=dialogForm({trackId:'t1',title:'Idea',desc:'My notes',deadline:''}),promote=()=>state.app.saveTask(submit(dialog));
  promote();await settle();await settle();promote();await settle();await settle();
  assert.deepEqual(sent,[1,1],'the dialog still shows the typed text, so it meets the change to the item again');
});

test('a block reason conflict shows the saved reason in the reason field',async()=>{
  const dialog=form('<textarea name="reason">My reason</textarea>',{dialog:true}),control=dialog.querySelector('textarea');let target;
  const recovery={isRevisionConflict:error=>error.code==='revision_conflict',handleCommandFailure:async()=>{},resolveConflict:async(input)=>{target=input.target;return {handled:true,saved:false};}};
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{recovery,gateway:{execute:async()=>{throw changedElsewhere();}}});
  const block={id:'b1',reason:'Their reason',revision:2};state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',epicId:'e1',revision:1,block});
  state.app.saveBlock(submit(dialog),'ONE-1','block');await settle();await settle();
  assert.equal(target.element(),control);assert.equal(target.latestValue(block),'Their reason');assert.equal(target.acceptLatest,undefined);
});

test('a task field edited while offline stays as typed and saves when the connection returns',async()=>{
  let online=false,reconnected;
  const recovery={ensureOnline:()=>online,whenOnline:listener=>{reconnected=listener;},handleCommandFailure:async()=>{}};
  const state=taskPage({recovery});
  state.app.updTask('ONE-1','desc','Written on the train');await settle();
  assert.equal(state.requests.length,0);
  assert.deepEqual(state.bridge.taskDraft('t1','desc'),{value:'Written on the train',unsaved:true});
  online=true;reconnected();await settle();
  assert.equal(state.requests[0].command.payload.description,'Written on the train');assert.equal(state.requests[0].command.expectedRevision,1);
  state.accept(0,{description:'Written on the train'});await settle();await settle();
  assert.equal(state.bridge.taskDraft('t1','desc'),null);assert.equal(state.item.desc,'Written on the train');
});

test('several fields edited offline save in order without conflicting with each other',async()=>{
  let online=false,reconnected;
  const state=taskPage({recovery:{ensureOnline:()=>online,whenOnline:listener=>{reconnected=listener;},handleCommandFailure:async()=>{}}});
  state.app.updTask('ONE-1','title','Offline title');state.app.updTask('ONE-1','desc','Offline description');await settle();
  online=true;reconnected();await settle();
  state.accept(0,{title:'Offline title'});await settle();await settle();
  assert.equal(state.requests[1].command.payload.description,'Offline description');assert.equal(state.requests[1].command.expectedRevision,2);
});

test('a block saved from the task page repaints before its counts read finishes',async()=>{
  const counted=deferred();
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:async()=>({entities:[],events:[{}]})},reads:{counts:()=>counted.promise},app:{refreshAfterDialog(){state.paints.push('after-dialog');}}});
  const item={id:'ONE-1',internalId:'t1',projectId:'p1',epicId:'e1',revision:1,block:{id:'b1',reason:'Waiting',revision:1}};state.data.tasks.push(item);
  state.app.saveBlock(submit(form(inputs({reason:''}))),'ONE-1','unblock');await settle();
  assert.deepEqual(state.paints,['after-dialog'],'the page shows the change while counts load');
  counted.resolve({stale:false});await settle();assert.deepEqual(state.paints,['after-dialog']);
});

test('a new project opens after a re-render of its dialog but not after the dialog closed',async()=>{
  for(const closed of [false,true]){
    document.body.replaceChildren();
    const navigated=[],background=[],dialog=dialogForm({name:'Atlas',key:'ATL'}),modal=dialog.closest('.modal');modal.dataset.openGeneration='7';
    const state=fixture({view:'roadmap',projectId:'p1',board:{}},{gateway:{execute:async()=>({entities:[{entityType:'project',id:'p9'}],events:[]})},app:{nav:(view,options)=>navigated.push([view,options?.projectId]),refreshBackground:()=>background.push(true)}});
    state.app.saveProjectNew(submit(dialog));
    // While it saves, the dialog draws again, with its open generation, or closes.
    modal.remove();
    if(!closed)document.body.insertAdjacentHTML('beforeend','<div class="modal" data-open-generation="7"></div>');
    await settle();await settle();
    assert.deepEqual([navigated,background.length],closed?[[],1]:[[['roadmap','p9']],0]);
  }
});

test('permission changes for two members save side by side',async()=>{
  let gateway;const requests=[];
  const state=fixture({view:'settings',projectId:'p1',board:{}},{gateway:{execute:(...args)=>gateway.execute(...args)}});
  gateway=createCommandGateway({data:state.data,api:{command:command=>new Promise(resolve=>requests.push({command,resolve}))}});
  state.data.users.push({id:'u1',admin:true,active:true});
  state.data.projects[0].members.push({userId:'alice',permissions:[],revision:1},{userId:'bob',permissions:[],revision:1});
  state.app.setMemberPermission('alice','manage_board',true);state.app.setMemberPermission('bob','manage_board',true);await settle();
  assert.deepEqual(requests.map(request=>request.command.payload.userId),['alice','bob']);
  for(const request of requests)request.resolve({entities:[{entityType:'membership',projectId:'p1',userId:request.command.payload.userId,manageBoard:true,manageRoadmap:false,revision:2}],events:[{}]});
  await settle();await settle();
  assert.deepEqual(state.toasts,[['Access updated'],['Access updated']]);
  assert.deepEqual(state.data.projects[0].members.map(member=>member.permissions),[['manage_board'],['manage_board']]);
});

test('a value typed while a failing save ran is the one kept as Not saved',async()=>{
  const state=taskPage({recovery:{handleCommandFailure:async()=>{}}});
  state.app.updTask('ONE-1','desc','First text');state.app.updTask('ONE-1','desc','Second text');
  state.requests[0].reject(new ApiError('Unable to reach oneloop',{code:'network_error',uncertain:true}));await settle();await settle();
  assert.equal(state.requests.length,1,'the newer value waits for the connection');
  assert.deepEqual(state.bridge.taskDraft('t1','desc'),{value:'Second text',unsaved:true});
});

/** A task page whose deletion succeeds and whose restores answer as `restore` says. */
function deletedTask(restore,recovery={}){
  const commands=[];let gateway;
  const api={command:async(command)=>{commands.push(command);if(command.operation==='task.restore')return restore(commands.filter(item=>item.operation==='task.restore').length);return {entities:[{entityType:'task',id:'t1',projectId:'p1',deleted:true,revision:4}],events:[]};}};
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway:{execute:(...args)=>gateway.execute(...args)},app:{confirm(options){options.confirm();}},recovery:{handleCommandFailure:async()=>{},...recovery}});
  gateway=createCommandGateway({api,data:state.data});
  state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',revision:3});
  const restores=()=>commands.filter(item=>item.operation==='task.restore');
  return {state,restores};
}

test('a task Undo that meets a busy server offers Undo again, which restores the task with the same key',async()=>{
  const {state,restores}=deletedTask((tries)=>{if(tries===1)throw new ApiError('Busy',{status:503,code:'unavailable',uncertain:true});return {entities:[],events:[]};});
  state.app.deleteTask('ONE-1');
  await waitFor(()=>state.toasts.some(([text])=>text==='ONE-1 deleted'));
  state.toasts.at(-1)[2].action.run();
  await waitFor(()=>state.toasts.at(-1)[1]==='error');
  const [message,,options]=state.toasts.at(-1);
  assert.match(message,/unknown/);assert.equal(options.action.label,'Undo');
  options.action.run();
  await waitFor(()=>state.toasts.some(([text])=>text==='ONE-1 restored'));
  assert.equal(restores().length,2);assert.equal(restores()[1].idempotencyKey,restores()[0].idempotencyKey,'an unknown result is reconciled, never applied twice');
});

test('a task Undo the server can no longer apply is only reported, and one without a connection waits for it',async()=>{
  const final=deletedTask(()=>{throw new ApiError('task can no longer be restored',{status:412,code:'precondition_failed'});});
  final.state.app.deleteTask('ONE-1');
  await waitFor(()=>final.state.toasts.some(([text])=>text==='ONE-1 deleted'));
  final.state.toasts.at(-1)[2].action.run();
  await waitFor(()=>final.state.toasts.at(-1)[1]==='error');
  assert.equal(final.state.toasts.at(-1)[2],undefined,'nothing to try again');
  const offline=deletedTask(()=>({entities:[],events:[]}),{connection:'offline'});
  offline.state.app.deleteTask('ONE-1');
  await waitFor(()=>offline.state.toasts.some(([text])=>text==='ONE-1 deleted'));
  offline.state.toasts.at(-1)[2].action.run();
  assert.deepEqual(offline.state.toasts.at(-1).slice(0,2),['Reconnect before making this change.','error']);
  assert.equal(offline.state.toasts.at(-1)[2].action.label,'Undo');assert.equal(offline.restores().length,0);
});

test('deleting an epic says its tasks stay on its track, reads them again and offers Undo, which restores the epic',async()=>{
  const commands=[];let confirmation,reloads=0;
  const gateway={execute:async(operation,payload,input)=>{commands.push([operation,payload,input.expectedRevision]);return operation==='epic.delete'?{entities:[{entityType:'epic',id:'e1',projectId:'p1',deleted:true,revision:2}],events:[]}:{entities:[],events:[]};}};
  const state=fixture({view:'roadmap',projectId:'p1'},{gateway,app:{confirm(options){confirmation=options;}},reloadBootstrap:async()=>{reloads++;return {};}});
  state.data.tracks.push({id:'t1',projectId:'p1',name:'Backend'});
  state.data.epics.push({id:'e1',projectId:'p1',trackId:'t1',title:'Payments',revision:1});
  state.app.deleteEpic('e1');
  assert.equal(confirmation.text,'“Payments” will be deleted. Its tasks stay on Backend without an epic. You can undo this right after.');
  confirmation.confirm();
  await waitFor(()=>state.toasts.length);
  const [text,kind,options]=state.toasts.at(-1);
  assert.deepEqual([text,kind,options.action.label],['Epic deleted','success','Undo']);
  options.action.run();
  await waitFor(()=>state.toasts.length>=2);
  assert.deepEqual(commands,[['epic.delete',{id:'e1'},1],['epic.restore',{id:'e1'},2]]);
  assert.deepEqual(state.toasts.at(-1),['Epic restored']);
  assert.equal(reloads,2,'the tasks the epic left, and took back, are read again');
});

test('an epic moved to another track reads its tasks again, and an epic renamed does not',async()=>{
  let reloads=0;const sent=[];
  const state=fixture({view:'roadmap',projectId:'p1'},{gateway:{execute:async(operation,payload)=>{sent.push(payload);return {entities:[],events:[]};}},reloadBootstrap:async()=>{reloads++;return {};}});
  state.data.tracks.push({id:'t1',projectId:'p1',name:'Backend'},{id:'t2',projectId:'p1',name:'Design'});
  state.data.epics.push({id:'e1',projectId:'p1',trackId:'t1',title:'Payments',desc:'',start:'2026-01-01',end:null,revision:1});
  const save=(values)=>state.app.saveEpic(submit(form(inputs({title:'Payments',desc:'',start:'2026-01-01',end:'',...values}))),'e1');
  save({trackId:'t1',title:'Payments v2'});await settle();
  assert.equal(reloads,0);
  save({trackId:'t2'});await settle();
  assert.equal(sent.at(-1).trackId,'t2');assert.equal(reloads,1);
});

test('a deleted task offers Undo, which restores it at the revision its deletion left',async()=>{
  const commands=[];let confirmation;
  const gateway={execute:async(operation,payload,input)=>{commands.push([operation,payload,input.expectedRevision]);return operation==='task.delete'?{entities:[{entityType:'task',id:'t1',projectId:'p1',deleted:true,revision:4}],events:[]}:{entities:[],events:[]};}};
  const state=fixture({view:'task',taskId:'ONE-1',projectId:'p1',board:{}},{gateway,app:{confirm(options){confirmation=options;}}});
  state.data.tasks.push({id:'ONE-1',internalId:'t1',projectId:'p1',revision:3});
  state.app.deleteTask('ONE-1');
  assert.match(confirmation.text,/You can undo this right after/);
  confirmation.confirm();
  await waitFor(()=>state.toasts.length);
  const [text,kind,options]=state.toasts.at(-1);
  assert.deepEqual([text,kind,options.action.label],['ONE-1 deleted','success','Undo']);
  options.action.run();
  await waitFor(()=>state.toasts.length>=2);
  assert.deepEqual(commands,[['task.delete',{id:'t1'},3],['task.restore',{id:'t1'},4]]);
  assert.deepEqual(state.toasts.at(-1),['ONE-1 restored']);
});
