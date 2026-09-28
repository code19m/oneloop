import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError,createApiClient} from '../../../../src/data/api-client.js';
import {createRequire} from 'node:module';
import {createRecoveryController,isRevisionConflict,leaveUnavailableProject,presentDomConflict} from '../../../../src/features/recovery/controller.js';
const {JSDOM}=createRequire(import.meta.url)('../../../support/dom.cjs');

function fixture(overrides={}){
  const data={session:{id:'s1',userId:'u1'},tasks:[]};
  const app={toasts:[],refreshes:0,context:()=>({view:'board',projectId:'p1'}),refresh(){this.refreshes++;},toast(...args){this.toasts.push(args);}};
  let expires=0,reloads=0;
  const controller=createRecoveryController({
    data,api:{request:async()=>({}),...overrides.api},gateway:{invalidate(){},...overrides.gateway},getApp:()=>app,getAuth:()=>({expire(){expires++;}}),
    reload:async()=>{reloads++;return {};},presentConflict:overrides.presentConflict,
    setTimer:overrides.setTimer??(()=>0),clearTimer:()=>{},online:overrides.online??(()=>true),
    documentObject:null,windowObject:overrides.windowObject??null,locationObject:{hash:'#/task/ONE-1'},random:()=>0,
  });
  return {controller,data,app,get expires(){return expires;},get reloads(){return reloads;}};
}

test('production controller implements the complete legacy recovery facade',()=>{
  const state=fixture();
  for(const name of ['errorHtml','connectionHtml','ensureOnline','enforceSession','sessionActive','loginAtLimit','recentAuth','retryLoad','reconnect','clearPageError','consumeReturn','copyReference','blockDrag','bind'])assert.equal(typeof state.controller[name],'function',name);
});

test('recognizes only actionable revision conflicts',()=>{
  assert.equal(isRevisionConflict(new ApiError('record changed since revision 1; latest revision is 2',{status:409,code:'conflict'})),true);
  assert.equal(isRevisionConflict(new ApiError('user is already a member',{status:409,code:'conflict'})),false);
  assert.equal(isRevisionConflict(new ApiError('record changed',{status:400,code:'conflict'})),false);
});

test('conflict review can use latest without writing or retry mine at the latest revision',async()=>{
  let latest={revision:4,title:'Latest'},retried=null;
  const first=fixture({presentConflict:async()=> 'latest'});
  const error=new ApiError('record changed; latest revision is 4',{status:409,code:'conflict'});
  const accepted=await first.controller.resolveConflict({error,reloadLatest:async()=>{},latestEntity:()=>latest,retry:async(revision)=>{retried=revision;},target:{latestValue:(entity)=>entity.title},myValue:'Mine'});
  assert.deepEqual(accepted,{handled:true,saved:false,latest});assert.equal(retried,null);

  const second=fixture({presentConflict:async({latestValue,myValue})=>{assert.equal(latestValue,'Latest');assert.equal(myValue,'Mine');return 'mine';}});
  const kept=await second.controller.resolveConflict({error,reloadLatest:async()=>{},latestEntity:()=>latest,retry:async(revision)=>{retried=revision;return {revision:5};},target:{latestValue:(entity)=>entity.title},myValue:'Mine'});
  assert.equal(retried,4);assert.equal(kept.saved,true);assert.deepEqual(kept.result,{revision:5});
});

test('ordinary API 401 expires the in-memory session flow without touching login failures',()=>{
  const state=fixture();
  state.controller.observeResponse({ok:false,path:'/api/tasks/t1',error:new ApiError('Sign in',{status:401,code:'unauthorized'})});
  assert.equal(state.expires,1);assert.equal(state.controller.expired,true);
  state.controller.observeResponse({ok:false,path:'/api/auth/login',error:new ApiError('Wrong password',{status:401,code:'unauthorized'})});
  assert.equal(state.expires,1);
});

test('live-channel loss allows writes while API loss blocks them and reconnects with a read',async()=>{
  const state=fixture();
  state.controller.liveDisconnected();
  assert.equal(state.controller.connection,'reconnecting');assert.equal(state.controller.ensureOnline(),true);
  state.controller.observeResponse({ok:false,path:'/api/projects/p1/roadmap',error:new ApiError('Network',{code:'network_error'})});
  assert.equal(state.controller.connection,'offline');assert.equal(state.controller.ensureOnline(),false);
  await state.controller.reconnect();
  assert.equal(state.controller.connection,'reconnecting');assert.equal(state.reloads,1);
});

test('live-channel reconnects use bounded scheduled attempts rather than retrying writes',()=>{
  const timers=[];let reconnects=0;
  const state=fixture({setTimer:(callback,delay)=>{timers.push({callback,delay});return timers.length;}});
  state.controller.liveDisconnected(()=>reconnects++);
  assert.equal(state.controller.connection,'reconnecting');assert.ok(timers[0].delay>=900&&timers[0].delay<=1_100);
  timers[0].callback();assert.equal(reconnects,1);
});

test('route failures select contextual shell states without replacing loaded data',()=>{
  const state=fixture();const project={id:'p1'};state.data.projects=[project];
  state.controller.handleRouteError(new ApiError('Forbidden',{status:403,code:'forbidden'}));
  assert.equal(state.controller.pageError,'403');assert.strictEqual(state.data.projects[0],project);
  state.controller.clearPageError();
  state.controller.handleRouteError(new ApiError('Missing',{status:404,code:'not_found'}));
  assert.equal(state.controller.pageError,'404');
});

test('a passive current-view probe detects access loss even when no SSE recipient hint arrives',async()=>{
  const timers=[];
  const state=fixture({
    api:{counts:async()=>{throw new ApiError('Forbidden',{status:403,code:'forbidden'});}},
    setTimer:(callback)=>{timers.push(callback);return timers.length;},
  });
  state.app.context=()=>({view:'roadmap',projectId:'p1'});
  state.controller.bind(state.app,{refresh:()=>state.app.refresh()});
  await timers[0]();
  assert.equal(state.controller.pageError,null);assert.equal(state.reloads,1);
});

test('an open editor keeps its focus-time revision across a live projection refresh',()=>{
  const root={},listeners={};
  const documentObject={addEventListener:(name,listener)=>{listeners[name]=listener;},querySelectorAll:()=>[root]};
  const task={id:'ONE-1',internalId:'opaque-1',revision:1};
  const data={session:{id:'s1',userId:'u1'},tasks:[task],projects:[],tracks:[],epics:[],milestones:[],pool:[]};
  const app={context:()=>({view:'task',taskId:'ONE-1',projectId:'p1'}),refresh(){}};
  const controller=createRecoveryController({data,api:{},gateway:{},getApp:()=>app,getAuth:()=>null,reload:async()=>{},setTimer:()=>0,clearTimer:()=>{},online:()=>true,documentObject,windowObject:null,locationObject:{hash:'#/task/ONE-1'}});
  controller.bind(app,{refresh(){}});
  const target={closest:(selector)=>selector.includes('.task-page')?root:null};
  listeners.focusin({target});
  const key=controller.revisionKey(task);
  task.revision=2;
  listeners.focusin({target});
  assert.equal(controller.expectedRevision(key,task.revision),1);
  controller.finishRevision(key);
  assert.equal(controller.expectedRevision(key,task.revision),2);
});

test('origin rejection is not treated as permission loss or session expiry',async()=>{
  const state=fixture(),error=new ApiError('Open the configured address.',{status:403,code:'invalid_origin'});
  await state.controller.handleCommandFailure(error);
  assert.equal(state.controller.handleRouteError(error),false);
  assert.equal(state.reloads,0);assert.equal(state.expires,0);assert.equal(state.app.refreshes,0);
  state.controller.dispose();
});

test('responses and command failures from an expired session cannot expire its replacement',async()=>{
  const state=fixture();const oldContext=state.controller.requestContext();
  state.controller.observeResponse({ok:false,path:'/api/tasks/t1',requestContext:oldContext,error:new ApiError('Expired',{status:401})});
  assert.equal(state.expires,1);
  state.data.session={id:'s2',userId:'u1'};state.data.projects=[{id:'new-project'}];state.controller.sessionChanged(state.data.session);
  const staleError=new ApiError('Old session',{status:401,requestContext:oldContext});
  state.controller.observeResponse({ok:false,path:'/api/commands',requestContext:oldContext,error:staleError});
  await state.controller.handleCommandFailure(staleError);
  assert.equal(state.expires,1);assert.equal(state.controller.expired,false);assert.equal(state.data.projects[0].id,'new-project');
  state.controller.observeResponse({ok:false,path:'/api/tasks/t1',requestContext:state.controller.requestContext(),error:new ApiError('Current session expired',{status:401})});
  assert.equal(state.expires,2);
});

test('late read and reconnect success cannot override a newer browser offline event',async()=>{
  let online=true,resolveProbe;
  const listeners={};
  const state=fixture({online:()=>online,windowObject:{addEventListener:(name,listener)=>listeners[name]=listener},api:{request:()=>new Promise(resolve=>resolveProbe=resolve)}});
  state.controller.bind(state.app,{});
  const oldContext=state.controller.requestContext();
  const reconnect=state.controller.reconnect();
  online=false;listeners.offline();
  state.controller.observeResponse({ok:true,path:'/api/bootstrap',requestContext:oldContext});
  resolveProbe({});await reconnect;
  assert.equal(state.controller.connection,'offline');assert.equal(state.controller.ensureOnline(),false);assert.equal(state.reloads,0);
  assert.match(state.controller.connectionHtml(),/>Offline —/);
  online=true;
  const freshReconnect=state.controller.reconnect();resolveProbe({});await freshReconnect;
  assert.equal(state.controller.connection,'live');assert.equal(state.reloads,1);
});

test('a success preceding a newer API failure cannot restore writes even while browser stays online',()=>{
  const state=fixture();const oldContext=state.controller.requestContext();
  state.controller.observeResponse({ok:false,path:'/api/bootstrap',requestContext:oldContext,error:new ApiError('Network',{code:'network_error'})});
  state.controller.observeResponse({ok:true,path:'/api/tasks/t1',requestContext:oldContext});
  assert.equal(state.controller.connection,'offline');assert.equal(state.controller.ensureOnline(),false);
  assert.match(state.controller.connectionHtml(),/Cannot reach oneloop/);
  state.controller.observeResponse({ok:true,path:'/api/auth/me',requestContext:state.controller.requestContext()});
  assert.equal(state.controller.connection,'live');
});

test('reconnect keeps service errors unavailable and retries reads until a successful response',async()=>{
  const timers=[];let attempts=0;
  const state=fixture({api:{request:async()=>{attempts++;if(attempts<3)throw new ApiError('Unavailable',{status:503});return {}; }},setTimer:(callback,delay)=>{timers.push({callback,delay});return timers.length;}});
  state.controller.observeResponse({ok:false,error:new ApiError('Network',{code:'network_error'})});
  for(let attempt=0;attempt<2;attempt++){
    await state.controller.reconnect(false);
    assert.equal(state.controller.connection,'offline');assert.equal(state.controller.ensureOnline(),false);
    assert.ok(timers.at(-1).delay<=30_000);assert.equal(state.reloads,0);
  }
  await state.controller.reconnect(false);
  assert.equal(state.controller.connection,'live');assert.equal(state.reloads,1);assert.equal(attempts,3);
});

test('body transport interruptions and deadlines block writes, while malformed JSON and cancellation do not',()=>{
  for(const code of ['network_error','timeout','invalid_response','aborted']){
    const state=fixture();state.controller.observeResponse({ok:false,error:new ApiError(code,{code,status:200})});
    assert.equal(state.controller.connection,['network_error','timeout'].includes(code)?'offline':'live');
  }
});

test('foreground placeholders wait briefly, cancel for fast loads, and match the destination',()=>{
  const timers=[];const state=fixture({setTimer:(callback,delay)=>{timers.push({callback,delay});return timers.length;}});
  state.controller.beginRouteLoad();assert.equal(state.controller.pageError,null);assert.equal(timers[0].delay,120);
  state.controller.clearPageError();timers[0].callback();assert.equal(state.controller.pageError,null);
  state.controller.beginRouteLoad();timers.at(-1).callback();assert.equal(state.controller.pageError,'loading');
  for(const [view,css] of [['board','loading-board'],['roadmap','loading-roadmap'],['task','loading-task']]){
    state.app.context=()=>({view});assert.match(state.controller.errorHtml('loading'),new RegExp(css));
  }
  state.controller.clearPageError();state.controller.beginRouteLoad();
  state.controller.handleRouteError(new ApiError('Failed',{status:503}));timers.at(-1).callback();
  assert.equal(state.controller.pageError,'503');
});


test('composed API observer and reconnect retain unavailability through service failures',async()=>{
  let controller,attempts=0,reloads=0;
  const api=createApiClient({getRequestContext:()=>controller.requestContext(),onResponse:event=>controller.observeResponse(event),fetchImpl:async()=>{
    attempts++;return attempts<3?new Response('<html>Unavailable</html>',{status:503}):Response.json({});
  }});
  controller=createRecoveryController({data:{session:{id:'s1'}},api,gateway:{},reload:async()=>{reloads++;},online:()=>true,setTimer:()=>0,clearTimer:()=>{},documentObject:null,windowObject:null});
  controller.observeResponse({ok:false,error:new ApiError('Network',{code:'network_error'})});
  for(let i=0;i<2;i++){await controller.reconnect();assert.equal(controller.connection,'offline');assert.equal(reloads,0);}
  await controller.reconnect();assert.equal(controller.connection,'live');assert.equal(reloads,1);
});

test('a replaced session ignores old responses even while new bootstrap is pending',()=>{
  const state=fixture(),old=state.controller.requestContext();
  state.data.session={id:'s2',userId:'u2'};
  state.controller.observeResponse({ok:false,path:'/api/commands',requestContext:old,error:new ApiError('Sign in',{status:401})});
  assert.equal(state.expires,0);assert.equal(state.data.session.id,'s2');
});

test('foreground timeout leaves an actionable error instead of a permanent skeleton',()=>{
  const timers=[];const state=fixture({setTimer:(callback,delay)=>{timers.push({callback,delay});return timers.length;}});
  state.controller.beginRouteLoad();timers[0].callback();assert.equal(state.controller.pageError,'loading');
  state.controller.handleRouteError(new ApiError('Timed out',{code:'timeout'}));
  assert.equal(state.controller.pageError,'503');assert.match(state.controller.errorHtml('503'),/Retry/);
});

test('slow task saves show localized feedback only while the same interaction is pending',()=>{
  const timers=[],shown=[],cleared=[];const state=fixture({setTimer:(callback,delay)=>{timers.push({callback,delay});return timers.length;}});
  state.app.context=()=>({view:'task',taskId:'ONE-1',projectId:'p1'});
  state.app.noteTaskSaving=(id,token)=>shown.push({id,token});state.app.clearTaskSaving=token=>cleared.push(token);
  state.controller.interactionPending('task.update:t1:title',true);
  assert.equal(timers[0].delay,300);assert.equal(shown.length,0);
  state.controller.interactionPending('task.update:t1:title',false);timers[0].callback();assert.equal(shown.length,0);
  state.controller.interactionPending('task.update:t1:description',true);timers.at(-1).callback();assert.equal(shown.length,1);
  assert.equal(state.controller.isSavingTask(),true);
  state.controller.interactionPending('task.update:t1:description',false);assert.equal(cleared.at(-1),shown[0].token);assert.equal(state.controller.isSavingTask(),false);
  state.controller.interactionPending('task.update:t1:deadline',true);state.app.context=()=>({view:'board',projectId:'p1'});timers.at(-1).callback();assert.equal(shown.length,1);
  state.controller.dispose();
});

test('background refresh feedback is scoped and clears on success without repainting content',()=>{
  const state=fixture();state.controller.refreshFailed(new ApiError('Failed',{status:500}));
  assert.match(state.controller.connectionHtml(),/Could not refresh/);assert.equal(state.app.refreshes,0);
  state.controller.refreshFailed(new ApiError('Again',{status:500}));assert.equal(state.app.refreshes,0);
  state.app.context=()=>({view:'profile'});assert.equal(state.controller.connectionHtml(),'');
  state.app.context=()=>({view:'board',projectId:'p1'});state.controller.refreshSucceeded();assert.equal(state.controller.connectionHtml(),'');
});


test('a promotion editor keeps the Pool source focus-time revision after a background replacement',()=>{
  const root={},listeners={};
  const documentObject={addEventListener:(name,listener)=>{listeners[name]=listener;},querySelectorAll:()=>[root]};
  const source={id:'pool1',revision:1};
  const data={session:{id:'s1',userId:'u1'},pool:[source]};
  const app={context:()=>({view:'board',projectId:'p1',modal:{type:'task',poolId:'pool1'}}),refresh(){}};
  const controller=createRecoveryController({data,api:{},gateway:{},getApp:()=>app,getAuth:()=>null,reload:async()=>{},setTimer:()=>0,clearTimer:()=>{},online:()=>true,documentObject,windowObject:null});
  controller.bind(app,{refresh(){}});
  const target={closest:selector=>selector==='.pool-editor'||selector.startsWith('.modal,')?root:null};
  listeners.focusin({target});data.pool=[{id:'pool1',revision:2}];listeners.focusin({target});
  assert.equal(controller.expectedRevision(controller.revisionKey(data.pool[0]),2),1);
  controller.dispose();
});

test('access reconciliation leaves a removed project and clears its route and overlays',()=>{
  for (const view of ['board','task','roadmap']) {
    for (const projects of [[],[{id:'other'}]]) {
      const calls=[];
      const app={nav:(view)=>calls.push(view),selectProject:(id)=>calls.push(id)};
      assert.equal(leaveUnavailableProject({projects},app,{projectId:'removed',view}),true);
      assert.deepEqual(calls,projects.length?['other','board']:['board']);
    }
  }
  assert.equal(leaveUnavailableProject({projects:[{id:'p1'}]},{nav:()=>assert.fail()}, {projectId:'p1',view:'task'}),false);
});

test('HTML gateway outages block writes and render service unavailable without losing uncertain outcomes',async()=>{
  const {createApiClient}=await import('../../../../src/data/api-client.js');
  for(const status of [502,503,504]){
    const state=fixture();
    const api=createApiClient({fetchImpl:async()=>new Response('<html>Bad gateway</html>',{status}),onResponse:event=>state.controller.observeResponse(event)});
    let error;try{await api.request('/api/commands',{method:'POST',body:{}});}catch(value){error=value;}
    assert.equal(error.status,status);assert.equal(error.uncertain,true);
    assert.equal(state.controller.connection,'offline');assert.equal(state.controller.ensureOnline(),false);
    state.controller.handleRouteError(error);assert.equal(state.controller.pageError,'503');
    state.controller.dispose();
  }
});

test('an upgrade notice remains until reload without clearing input or disabling accepted work',()=>{
  const state=fixture();state.controller.buildChanged();
  assert.match(state.controller.connectionHtml(),/oneloop was updated/);
  state.controller.clearPageError();state.controller.sessionChanged(state.data.session);
  assert.match(state.controller.connectionHtml(),/Reload/);assert.equal(state.app.refreshes,0);assert.equal(state.controller.ensureOnline(),true);
});


test('forced password sessions neither schedule nor run project access probes',async()=>{
  const timers=[];let probes=0;
  const state=fixture({api:{counts:async()=>{probes++;}},setTimer:callback=>{timers.push(callback);return timers.length;}});
  state.app.context=()=>({view:'roadmap',projectId:'p1'});
  state.data.session.temporary=true;state.controller.bind(state.app,{});state.controller.sessionChanged(state.data.session);
  assert.equal(timers.length,0);
  state.data.session.temporary=false;state.controller.sessionChanged(state.data.session);
  assert.equal(timers.length,1);await timers[0]();assert.equal(probes,1);
  state.data.session.temporary=true;await timers[1]();assert.equal(probes,1);
  state.controller.dispose();
});

test('idle Board and Roadmap access probes only read counts',async()=>{
  for(const view of ['board','roadmap']){
    const timers=[],calls=[];
    const state=fixture({api:{counts:async(...args)=>calls.push(args)},setTimer:callback=>{timers.push(callback);return timers.length;}});
    state.app.context=()=>({view,projectId:'p1'});
    state.controller.bind(state.app,{refresh:()=>state.app.refresh()});await timers[0]();
    assert.deepEqual(calls,[['p1',{background:true}]]);state.controller.dispose();
  }
});

test('blur conflict stays beside its field and reveals long latest values on demand',async()=>{
  const dom=new JSDOM('<main class="content"><div class="task-page"><section class="tp-sec"><textarea id="description">mine</textarea></section></div></main>');
  const previous=globalThis.document,previousEvent=globalThis.Event;globalThis.document=dom.window.document;globalThis.Event=dom.window.Event;
  try{
    const field=document.querySelector('textarea');
    const value='<script>do not execute</script>'+ ' saved'.repeat(80);
    const pending=presentDomConflict({target:field,latestValue:value,myValue:'mine'});
    const box=document.querySelector('[data-recovery-conflict]');assert.equal(box.parentElement,field.parentElement);assert.equal(document.querySelectorAll('script').length,0);
    assert.ok(box.querySelector('span').textContent.length<260);
    const show=[...box.querySelectorAll('button')].find(button=>button.textContent==='Show all');show.click();assert.ok(box.textContent.includes(value));assert.equal(show.getAttribute('aria-expanded'),'true');
    [...box.querySelectorAll('button')].find(button=>button.textContent==='Use latest').click();assert.equal(await pending,'latest');assert.equal(field.value,value);assert.equal(document.querySelector('[data-recovery-conflict]'),null);
  }finally{globalThis.document=previous;globalThis.Event=previousEvent;dom.window.close();}
});

test('removing an unresolved editor cancels its prompt without retaining a draft',async()=>{
  const dom=new JSDOM('<div class="task-page"><textarea>mine</textarea></div>');const previous=globalThis.document;globalThis.document=dom.window.document;
  try{const pending=presentDomConflict({target:document.querySelector('textarea'),latestValue:'latest',myValue:'mine'});document.body.replaceChildren();assert.equal(await pending,'cancelled');}
  finally{globalThis.document=previous;dom.window.close();}
});
