import assert from 'node:assert/strict';
import test from 'node:test';
import {createProjectionReload,createSignInLoad,routeScope} from '../../../src/app/projection-reload.js';
import {createBootstrapController} from '../../../src/data/bootstrap-controller.js';
import {createReadController} from '../../../src/data/read-controller.js';
import {createLegacyData,hydrateLegacyData,mergeEpicTaskPage} from '../../../src/data/projection-store.js';
import {ApiError} from '../../../src/data/api-client.js';
import {settle,useGlobals,waitFor} from '../../support/helpers.cjs';

const projection=(projectId,extra={})=>({timeZone:projectId,session:{userId:'u1',isAdmin:true},users:[{id:'u1',name:'Owner',isAdmin:true,isActive:true}],
  projects:[{id:'p1',name:'One',taskPrefix:'ONE',revision:1},{id:'p2',name:'Two',taskPrefix:'TWO',revision:1}],memberships:[],
  tracks:[{id:'t1',projectId,name:'Track',position:1,revision:1}],epics:[{id:'e1',projectId,trackId:'t1',title:'Epic',startDate:'2026-01-01',state:'active',position:1,revision:1}],
  milestones:[],tasks:[],selectedProjectId:projectId,view:'roadmap',...extra});
const view=(id,projectId='p1')=>({id,projectId,epicId:'e1',taskKey:id.toUpperCase(),title:id,description:'',status:'planning',position:1,createdAt:1,updatedAt:1,revision:1,assigneeIds:[],activeBlock:null});

/** A page with held API calls and the real bootstrap and read controllers. */
function page(context){
  const data=createLegacyData();hydrateLegacyData(data,projection(context.projectId));
  const calls=[],waiting=[];
  const held=name=>(...args)=>new Promise((resolve,reject)=>{
    calls.push({name,args,options:args.at(-1),resolve,reject});
    for(const waiter of waiting.filter(item=>calls.length>=item.count)){waiting.splice(waiting.indexOf(waiter),1);waiter.resolve();}
  });
  const api={bootstrap:held('bootstrap'),task:held('task'),epicTasks:held('epicTasks'),epicActivity:held('epicActivity'),roadmap:held('roadmap'),boardView:held('boardView'),board:held('board')};
  const bootstrap=createBootstrapController({api,data}),reads=createReadController({api,data});
  const app={context:()=>context,refresh(){},refreshCounts(){},refreshRoadmap(){},refreshTask(){},updateDocumentTitle(){}};
  const recovery={refreshSucceeded(){},refreshFailed(){},handleRouteError(){}};
  const reload=createProjectionReload({data,bootstrap,reads,getApp:()=>app,getBridge:()=>null,getRecovery:()=>recovery,location:{get hash(){return context.hash??'#/roadmap';}}});
  return {data,calls,bootstrap,reads,reload,next:name=>calls.find(call=>call.name===name&&!call.done&&(call.done=true)),
    /** Resolves once the page has called the API `count` times. */
    called:count=>calls.length>=count?Promise.resolve():new Promise(resolve=>waiting.push({count,resolve}))};
}

test('a live refresh lets the task someone is opening load, then refreshes it',async()=>{
  const t=page({view:'task',taskId:'ONE-2',projectId:'p1',hash:'#/task/ONE-2'});
  const opening=t.reads.task('ONE-2'),live=t.reload({background:true});
  await settle();
  assert.deepEqual(t.calls.map(call=>call.name),['task'],'the refresh waits for the task read');
  assert.equal(t.calls[0].options.signal.aborted,false);
  t.next('task').resolve(view('one-2'));
  assert.equal((await opening).stale,false);
  await waitFor(()=>t.calls.length===2);
  const bootstrap=t.next('bootstrap');assert.equal(bootstrap.options.taskId,'ONE-2');
  bootstrap.resolve(projection('p1',{view:'task',tasks:[view('one-2')]}));
  assert.equal((await live).stale,false);
});

test('a live refresh of the old project waits for a project switch and then lets it stand',async()=>{
  const context={view:'board',projectId:'p1',board:{}};const t=page(context);
  const switching=t.bootstrap.load({projectId:'p2',view:'board'}),live=t.reload({background:true,projectId:'p1',viewOnly:true,hints:[{entityType:'epic'}]});
  await settle();
  assert.equal(t.calls.length,1);assert.equal(t.calls[0].options.signal.aborted,false);
  t.next('bootstrap').resolve(projection('p2',{view:'board'}));
  assert.equal((await switching).stale,false);context.projectId='p2';
  assert.equal((await live).stale,true);
  assert.equal(t.calls.length,1,'no refresh of the project left behind');assert.equal(t.data.timeZone,'p2');
});

test('a live refresh without a project refreshes the project chosen meanwhile',async()=>{
  const context={view:'roadmap',projectId:'p1'};const t=page(context);
  const switching=t.bootstrap.load({projectId:'p2',view:'roadmap'}),live=t.reload({background:true});
  await settle();t.next('bootstrap').resolve(projection('p2'));await switching;context.projectId='p2';
  await waitFor(()=>t.calls.length===2);const refresh=t.next('bootstrap');assert.equal(refresh.options.projectId,'p2');
  refresh.resolve(projection('p2'));assert.equal((await live).stale,false);assert.equal(t.data.timeZone,'p2');
});

test('a refresh with the epic drawer open reads the drawer tasks again',async()=>{
  const t=page({view:'roadmap',projectId:'p1',peek:'e1'});
  const live=t.reload({background:true});
  await waitFor(()=>t.calls.length===1);t.next('bootstrap').resolve(projection('p1'));
  await waitFor(()=>t.calls.length===3);
  t.next('epicTasks').resolve({items:[view('t1'),view('t2')],nextCursor:null,total:2});
  t.next('epicActivity').resolve({items:[],nextCursor:null});
  assert.equal((await live).stale,false);
  assert.deepEqual(t.data.epicPageInfo.e1.taskIds,['t1','t2']);
});

test('a live refresh of an account page reloads the pages already shown, passively',async()=>{
  const requests=[],context={view:'users',projectId:'p1'};
  const data=createLegacyData();hydrateLegacyData(data,projection('p1'));
  const bootstrap={idle:async()=>{},load:async()=>({stale:false})},reads={idle:async()=>{}};
  const bridge={loadCurrentRoute:async options=>{requests.push(options);return {stale:false};}};
  const reload=createProjectionReload({data,bootstrap,reads,getApp:()=>({context:()=>context,updateDocumentTitle(){}}),getBridge:()=>bridge,getRecovery:()=>({refreshSucceeded(){}}),location:{hash:'#/users'}});
  await reload({background:true});await reload();
  assert.deepEqual(requests,[{refresh:true,background:true},{refresh:true,background:false}]);
});

test('a refresh that removes the shown project names it when leaving',async()=>{
  const context={view:'task',projectId:'p2',taskId:'TWO-1'},toasts=[];
  const data=createLegacyData();hydrateLegacyData(data,projection('p2'));
  const app={context:()=>context,toast:(...args)=>toasts.push(args),selectProject:id=>{context.projectId=id;},nav:view=>{context.view=view;},updateDocumentTitle(){}};
  const bootstrap={idle:async()=>{},load:async()=>{hydrateLegacyData(data,{...projection('p1'),projects:[{id:'p1',name:'One',taskPrefix:'ONE',revision:1}]});return {stale:false};}};
  const reload=createProjectionReload({data,bootstrap,reads:{idle:async()=>{}},getApp:()=>app,getBridge:()=>null,getRecovery:()=>({refreshSucceeded(){}}),location:{hash:'#/task/TWO-1'}});
  await reload({background:true});
  assert.deepEqual(context,{view:'board',projectId:'p1',taskId:'TWO-1'});
  assert.deepEqual(toasts,[['You no longer have access to Two.','info']]);
});

test('a refresh that shows the admin role is gone leaves an admin page or dialog and says why',async()=>{
  for(const [view,modal] of [['users',null],['storage',null],['settings',null],['roadmap',{type:'user',id:'u2'}]]){
    const context={view,projectId:'p1',modal},toasts=[],calls=[];
    const data=createLegacyData();hydrateLegacyData(data,projection('p1'));
    const app={context:()=>({...context}),toast:(...args)=>toasts.push(args),nav:(next,options)=>{calls.push(['nav',next,options?.discard]);context.view=next;},closeOverlays:()=>{calls.push(['close']);context.modal=null;},updateDocumentTitle(){},refreshRoadmap(){},refreshCounts(){}};
    const bootstrap={idle:async()=>{},load:async()=>{hydrateLegacyData(data,{...projection('p1'),session:{userId:'u1',isAdmin:false},users:[{id:'u1',name:'Owner',isAdmin:false,isActive:true}]});return {stale:false};}};
    const reload=createProjectionReload({data,bootstrap,reads:{idle:async()=>{}},getApp:()=>app,getBridge:()=>({loadCurrentRoute:async()=>assert.fail('the admin page is not read again')}),getRecovery:()=>({refreshSucceeded(){}}),location:{hash:`#/${view}`}});
    await reload({background:true});
    assert.deepEqual(calls,modal?[['close']]:[['nav','board',true]],view);
    assert.deepEqual(toasts,[['You no longer have admin access.','info']],view);
  }
});

/** The browser's local storage, holding `entries`. */
function storage(entries={}){
  const values=new Map(Object.entries(entries));
  return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),values};
}

test('the address decides what the bootstrap loads, and the project on screen fills in for an address without one',()=>{
  const onScreen={context:()=>({projectId:'p1'})};
  assert.deepEqual(routeScope('#/task/ONE-1',onScreen),{taskId:'ONE-1',view:'task'});
  assert.deepEqual(routeScope('#/board/p2',onScreen),{projectId:'p2',view:'board'});
  assert.deepEqual(routeScope('#/board/p2?search=x',onScreen),{projectId:'p2',view:'metadata'},'a filtered Board reads its cards afterwards');
  assert.deepEqual(routeScope('#/roadmap/p2',onScreen),{projectId:'p2',view:'roadmap'});
  assert.deepEqual(routeScope('#/knowledge/p2/tree/guides',onScreen),{projectId:'p2',view:'metadata'});
  assert.deepEqual(routeScope('#/inbox',onScreen),{projectId:'p1',view:'metadata'});
  assert.deepEqual(routeScope('',null),{view:'roadmap'});
});

test('an unavailable destination is reported to the caller instead of the page when asked',async()=>{
  const routeErrors=[],context={view:'inbox',projectId:'p1'};
  const data=createLegacyData();hydrateLegacyData(data,projection('p1'));
  const missing=new ApiError('task not found',{status:404,code:'not_found'});
  const bootstrap={idle:async()=>{},load:async scope=>{if(scope.taskId)throw missing;return {stale:false};}};
  const reload=createProjectionReload({data,bootstrap,reads:{idle:async()=>{}},getApp:()=>({context:()=>context,refresh(){},updateDocumentTitle(){}}),getBridge:()=>null,getRecovery:()=>({handleRouteError:error=>routeErrors.push(error),refreshSucceeded(){}}),location:{hash:'#/inbox'}});
  assert.deepEqual(await reload({taskId:'gone',routeErrors:false}),{stale:false,unavailable:true});
  assert.deepEqual(routeErrors,[]);
  await reload({taskId:'gone'});assert.deepEqual(routeErrors,[missing]);
});

test('a full refresh of the Board uses the cards its bootstrap carries, unless a column shows more than its first page',async()=>{
  const empty={nextCursor:null,total:0};
  const boardProjection=()=>projection('p1',{view:'board',boardPages:{planning:{nextCursor:'page-2',total:2},inProgress:empty,inReview:empty,done:empty},tasks:[view('t1')]});
  for(const deeper of [false,true]){
    const t=page({view:'board',projectId:'p1',board:{},hash:'#/board'});
    hydrateLegacyData(t.data,boardProjection());t.reads.adoptBoard('p1');
    if(deeper){const more=t.reads.moreBoard('planning');await t.called(1);t.next('board').resolve({items:[view('t2')],nextCursor:null,total:2});await more;}
    const live=t.reload({background:true}),before=t.calls.length;
    await t.called(before+1);t.next('bootstrap').resolve(boardProjection());await settle();
    assert.deepEqual(t.calls.slice(before).map(call=>call.name),deeper?['bootstrap','boardView']:['bootstrap']);
    if(deeper){
      t.next('boardView').resolve({planning:{items:[view('t1')],nextCursor:'page-2',total:2},inProgress:{items:[],...empty},inReview:{items:[],...empty},done:{items:[],...empty},counts:{}});
      await t.called(before+3);t.next('board').resolve({items:[view('t2')],nextCursor:null,total:2});
    }
    assert.equal((await live).stale,false);
    assert.deepEqual(t.data.tasks.map(task=>task.internalId),deeper?['t1','t2']:['t1']);
  }
});

/** A sign-in of `person` on a page that shows `context`; the bootstrap records each load and answers with `answer`. */
function signInPage(context,answer=async()=>({stale:false}),person='u1'){
  const loads=[],bootstrap={load:async scope=>{loads.push(scope);return answer(scope);}};
  const signIn=createSignInLoad({bootstrap,api:{},data:{session:{id:'s1',userId:person}},getApp:()=>context&&{context:()=>context},location:{get hash(){return context?.hash??'#/board';}}});
  return {signIn,loads};
}

/** A first visit to the Board with the real bootstrap controller; `answer` answers each bootstrap read. */
function firstVisit(answer){
  const data=createLegacyData(),reads=[];
  const api={bootstrap:async scope=>{reads.push(scope);return answer(reads.length);}};
  const signIn=createSignInLoad({bootstrap:createBootstrapController({api,data}),api,data,getApp:()=>null,location:{hash:'#/board'}});
  return {data,reads,signIn};
}

test('the first load after the session check uses the read that started with it',async()=>{
  const t=firstVisit(()=>projection('p1',{view:'board'}));
  t.signIn.prefetch();
  t.data.session={id:'s1',userId:'u1'};
  assert.equal((await t.signIn.load()).stale,false);
  assert.deepEqual(t.reads,[{view:'board'}]);
  assert.equal(t.data.bootstrapView,'board');
});

test('a session change drops the read that started with the session check',async()=>{
  // Someone who must change their password: the server refuses the first read.
  const t=firstVisit(count=>{if(count===1)throw new ApiError('Change your password first',{status:412,code:'precondition_failed'});return projection('p1',{view:'board'});});
  t.signIn.prefetch();
  t.data.session={id:'s1',userId:'u1',temporary:true};t.signIn.sessionChanged(t.data.session);
  t.data.session={id:'s1',userId:'u1'};
  assert.equal((await t.signIn.load()).stale,false);
  assert.equal(t.reads.length,2);
});

test('signing in again loads the project the address names, or else the one on screen',async()=>{
  for(const [hash,projectId] of [['#/board/p2','p2'],['#/inbox','p1']]){
    const {signIn,loads}=signInPage({view:'board',projectId:'p1',board:{},hash});
    signIn.sessionChanged();
    await signIn.load();
    assert.deepEqual(loads.map(scope=>scope.projectId),[projectId],hash);
  }
});

test('a first sign-in loads the default project',async()=>{
  const {signIn,loads}=signInPage(null);
  signIn.sessionChanged();
  await signIn.load();
  assert.deepEqual(loads,[{view:'board'}]);
});

test('a project the account can no longer open loads the default project, and a task only metadata',async()=>{
  const gone=new ApiError('project not found',{status:404,code:'not_found'});
  const board=signInPage({view:'board',projectId:'p2',board:{},hash:'#/board/p2'},async scope=>{if(scope.projectId)throw gone;return {stale:false};});
  board.signIn.sessionChanged();await board.signIn.load();
  assert.deepEqual(board.loads,[{projectId:'p2',view:'board'},{view:'board'}]);
  const task=signInPage({view:'task',projectId:'p2',taskId:'TWO-1',hash:'#/task/TWO-1'},async scope=>{if(scope.taskId)throw gone;return {stale:false};});
  task.signIn.sessionChanged();await task.signIn.load();
  assert.deepEqual(task.loads,[{taskId:'TWO-1',view:'task'},{view:'metadata'}]);
});

test('a new tab opens the project its person switched to last, and never another person\'s',async t=>{
  useGlobals(t,{localStorage:storage({'oneloop.project':JSON.stringify({userId:'u1',projectId:'p2'})})});
  for(const person of ['u1','u2']){
    // Each read answers with its own project, for the person signing in.
    const visit=firstVisit(count=>projection(count===1?'p2':'p1',{session:{userId:person,isAdmin:true},users:[{id:person,name:person,isAdmin:true,isActive:true}]}));
    visit.signIn.prefetch();
    visit.data.session={id:'s1',userId:person};
    await visit.signIn.load();
    // Before the session is known, the read asks for the last switch; only its own person gets it.
    assert.deepEqual(visit.reads.map(scope=>[scope.projectId??null,scope.view]),person==='u1'?[['p2','board']]:[['p2','board'],[null,'board']],person);
    assert.equal(visit.data.timeZone,person==='u1'?'p2':'p1',`${person} sees the project of the read for them`);
  }
});

test('a remembered project that is gone opens the default project and is forgotten, but only by its person',async t=>{
  const remembered=storage({'oneloop.project':JSON.stringify({userId:'u1',projectId:'p2'})});useGlobals(t,{localStorage:remembered});
  const gone=new ApiError('project not found',{status:404,code:'not_found'});
  const other=signInPage({view:'board',projectId:null,board:{},hash:'#/board/p2'},async scope=>{if(scope.projectId)throw gone;return {stale:false};},'u2');
  await other.signIn.load();
  assert.equal(remembered.values.has('oneloop.project'),true,'someone else who can\'t open it leaves the switch alone');
  const {signIn,loads}=signInPage(null,async scope=>{if(scope.projectId)throw gone;return {stale:false};});
  await signIn.load();
  assert.deepEqual(loads,[{projectId:'p2',view:'board'},{view:'board'}]);
  assert.equal(remembered.values.has('oneloop.project'),false);
});

// Without the drawer read, the fourth call never comes and the test times out.
test('a live task change re-reads the open epic drawer with the Roadmap, after a Load more someone started',{timeout:5_000},async()=>{
  const t=page({view:'roadmap',projectId:'p1',peek:'e1'});
  mergeEpicTaskPage(t.data,'e1',[view('t1'),view('t2')],{nextCursor:'after-t2',total:3});
  const more=t.reads.moreEpicTasks('e1');
  const live=t.reload({background:true,projectId:'p1',viewOnly:true,hints:[{entityType:'task',entityId:'t1'}]});
  await settle();
  const loading=t.next('epicTasks');assert.equal(loading.options.cursor,'after-t2');
  assert.deepEqual(t.calls.map(call=>call.name),['epicTasks'],'the live read waits for Load more');
  loading.resolve({items:[view('t3')],nextCursor:null,total:3});
  assert.equal((await more).stale,false);assert.equal(loading.options.signal.aborted,false,'Load more is never cancelled');
  await t.called(4);
  assert.deepEqual(t.calls.map(call=>call.name).sort(),['epicActivity','epicTasks','epicTasks','roadmap'],'the Roadmap and the drawer are read again');
  t.next('roadmap').resolve(projection('p1'));
  const drawer=t.next('epicTasks');assert.equal(drawer.options.cursor,undefined,'the drawer reads its tasks again from the first');
  drawer.resolve({items:[{...view('t1'),title:'Renamed by a teammate'},view('t2'),view('t3')],nextCursor:null,total:3});
  t.next('epicActivity').resolve({items:[],nextCursor:null});
  assert.equal((await live).stale,false);
  assert.deepEqual(t.data.epicPageInfo.e1.taskIds,['t1','t2','t3'],'as many tasks as the drawer showed');
  assert.equal(t.data.tasks.find(task=>task.internalId==='t1').title,'Renamed by a teammate');
});
