import assert from 'node:assert/strict';
import test from 'node:test';
import {createProjectionReload,routeScope} from '../../../src/app/projection-reload.js';
import {createBootstrapController} from '../../../src/data/bootstrap-controller.js';
import {createReadController} from '../../../src/data/read-controller.js';
import {createLegacyData,hydrateLegacyData} from '../../../src/data/projection-store.js';
import {ApiError} from '../../../src/data/api-client.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async check=>{while(!check())await new Promise(resolve=>setTimeout(resolve,1));};
const projection=(projectId,extra={})=>({timeZone:projectId,session:{userId:'u1',isAdmin:true},users:[{id:'u1',name:'Owner',isAdmin:true,isActive:true}],
  projects:[{id:'p1',name:'One',taskPrefix:'ONE',revision:1},{id:'p2',name:'Two',taskPrefix:'TWO',revision:1}],memberships:[],
  tracks:[{id:'t1',projectId,name:'Track',position:1,revision:1}],epics:[{id:'e1',projectId,trackId:'t1',title:'Epic',startDate:'2026-01-01',state:'active',position:1,revision:1}],
  milestones:[],tasks:[],selectedProjectId:projectId,view:'roadmap',...extra});
const view=(id,projectId='p1')=>({id,projectId,epicId:'e1',taskKey:id.toUpperCase(),title:id,description:'',status:'planning',position:1,createdAt:1,updatedAt:1,revision:1,assigneeIds:[],activeBlock:null});

/** A page with held API calls and the real bootstrap and read controllers. */
function page(context){
  const data=createLegacyData();hydrateLegacyData(data,projection(context.projectId));
  const calls=[],held=name=>(...args)=>new Promise((resolve,reject)=>calls.push({name,args,options:args.at(-1),resolve,reject}));
  const api={bootstrap:held('bootstrap'),task:held('task'),epicTasks:held('epicTasks'),epicActivity:held('epicActivity')};
  const bootstrap=createBootstrapController({api,data}),reads=createReadController({api,data});
  const app={context:()=>context,refresh(){},refreshCounts(){},refreshBackground(){},refreshRoadmap(){},updateDocumentTitle(){}};
  const recovery={refreshSucceeded(){},refreshFailed(){},handleRouteError(){}};
  const reload=createProjectionReload({data,bootstrap,reads,getApp:()=>app,getBridge:()=>null,getRecovery:()=>recovery,location:{get hash(){return context.hash??'#/roadmap';}}});
  return {data,calls,bootstrap,reads,reload,next:name=>calls.find(call=>call.name===name&&!call.done&&(call.done=true))};
}

test('a live refresh lets the task someone is opening load, then refreshes it',async()=>{
  const t=page({view:'task',taskId:'ONE-2',projectId:'p1',hash:'#/task/ONE-2'});
  const opening=t.reads.task('ONE-2'),live=t.reload({background:true});
  await tick();
  assert.deepEqual(t.calls.map(call=>call.name),['task'],'the refresh waits for the task read');
  assert.equal(t.calls[0].options.signal.aborted,false);
  t.next('task').resolve(view('one-2'));
  assert.equal((await opening).stale,false);
  await until(()=>t.calls.length===2);
  const bootstrap=t.next('bootstrap');assert.equal(bootstrap.options.taskId,'ONE-2');
  bootstrap.resolve(projection('p1',{view:'task',tasks:[view('one-2')]}));
  assert.equal((await live).stale,false);
});

test('a live refresh of the old project waits for a project switch and then lets it stand',async()=>{
  const context={view:'board',projectId:'p1',board:{}};const t=page(context);
  const switching=t.bootstrap.load({projectId:'p2',view:'board'}),live=t.reload({background:true,projectId:'p1',viewOnly:true,hints:[{entityType:'epic'}]});
  await tick();
  assert.equal(t.calls.length,1);assert.equal(t.calls[0].options.signal.aborted,false);
  t.next('bootstrap').resolve(projection('p2',{view:'board'}));
  assert.equal((await switching).stale,false);context.projectId='p2';
  assert.equal((await live).stale,true);
  assert.equal(t.calls.length,1,'no refresh of the project left behind');assert.equal(t.data.timeZone,'p2');
});

test('a live refresh without a project refreshes the project chosen meanwhile',async()=>{
  const context={view:'roadmap',projectId:'p1'};const t=page(context);
  const switching=t.bootstrap.load({projectId:'p2',view:'roadmap'}),live=t.reload({background:true});
  await tick();t.next('bootstrap').resolve(projection('p2'));await switching;context.projectId='p2';
  await until(()=>t.calls.length===2);const refresh=t.next('bootstrap');assert.equal(refresh.options.projectId,'p2');
  refresh.resolve(projection('p2'));assert.equal((await live).stale,false);assert.equal(t.data.timeZone,'p2');
});

test('a refresh with the epic drawer open reads the drawer tasks again',async()=>{
  const t=page({view:'roadmap',projectId:'p1',peek:'e1'});
  const live=t.reload({background:true});
  await until(()=>t.calls.length===1);t.next('bootstrap').resolve(projection('p1'));
  await until(()=>t.calls.length===3);
  t.next('epicTasks').resolve({items:[view('t1'),view('t2')],nextCursor:null,total:2});
  t.next('epicActivity').resolve({items:[],nextCursor:null});
  assert.equal((await live).stale,false);
  assert.deepEqual(t.data.epicPageInfo.e1.taskIds,['t1','t2']);
});

test('a refresh of an account page reloads the pages already shown',async()=>{
  const requests=[],context={view:'users',projectId:'p1'};
  const data=createLegacyData();hydrateLegacyData(data,projection('p1'));
  const bootstrap={idle:async()=>{},load:async()=>({stale:false})},reads={idle:async()=>{}};
  const bridge={loadCurrentRoute:async options=>{requests.push(options);return {stale:false};}};
  const reload=createProjectionReload({data,bootstrap,reads,getApp:()=>({context:()=>context,updateDocumentTitle(){}}),getBridge:()=>bridge,getRecovery:()=>({refreshSucceeded(){}}),location:{hash:'#/users'}});
  await reload({background:true});
  assert.deepEqual(requests,[{refresh:true}]);
});

test('the route decides the bootstrap view',()=>{
  assert.deepEqual(routeScope('#/task/ONE-1',null),{taskId:'ONE-1',view:'task'});
  assert.deepEqual(routeScope('#/board',{context:()=>({board:{search:'x'}})}),{view:'metadata'});
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
