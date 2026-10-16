import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError,createApiClient} from '../../../../src/data/api-client.js';
import {createRequire} from 'node:module';
import {leaveUnavailableProject} from '../../../../src/features/recovery/controller.js';
import {createBuildMonitor} from '../../../../src/app/build-info.js';
import {deferred,settle} from '../../../support/helpers.cjs';
const {JSDOM,importModule}=createRequire(import.meta.url)('../../../support/dom.cjs');

/** A jsdom page holding `html`, with the recovery module loaded into it, as the app loads it. */
function page(html=''){
  const dom=new JSDOM(`<!doctype html><body>${html}</body>`,{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});
  return {window:dom.window,document:dom.window.document,createRecoveryController:importModule(dom,'src/features/recovery/controller.js').createRecoveryController};
}

/** The views' methods that Recovery calls, with the toasts and repaints recorded. */
const appFor=(context)=>({toasts:[],refreshes:0,context,refresh(){this.refreshes++;},toast(...args){this.toasts.push(args);},commentDraft:()=>null,restoreCommentDraft(){},noteTaskSaving(){},clearTaskSaving(){}});

function fixture(overrides={}){
  const {window,document,createRecoveryController}=page(overrides.html);
  const data={session:{id:'s1',userId:'u1'},tasks:[]};
  const app=appFor(()=>({view:'board',projectId:'p1'}));
  let expires=0,reloads=0;
  const controller=createRecoveryController({
    data,api:{me:async()=>({}),...overrides.api},gateway:{invalidate(){},hasPending:()=>false,...overrides.gateway},getApp:()=>app,getAuth:()=>({expire(){expires++;}}),
    reload:async()=>{reloads++;return {};},
    setTimer:overrides.setTimer??(()=>0),clearTimer:overrides.clearTimer??(()=>{}),online:overrides.online??(()=>true),random:()=>0,
  });
  return {controller,data,app,window,document,get expires(){return expires;},get reloads(){return reloads;}};
}

test('recognizes revision conflicts by their code, not their wording',()=>{
  const {controller}=fixture();
  assert.equal(controller.isRevisionConflict(new ApiError('record changed since revision 1; latest revision is 2',{status:409,code:'revision_conflict'})),true);
  assert.equal(controller.isRevisionConflict(new ApiError('record changed since revision 1; latest revision is 2',{status:409,code:'conflict'})),false);
  controller.dispose();
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
  state.controller.start();
  await timers[0]();
  assert.equal(state.controller.pageError,null);assert.equal(state.reloads,1);
});

test('an open editor keeps its focus-time revision across a live projection refresh',()=>{
  const {window,document,createRecoveryController}=page('<div class="task-page"><textarea class="tp-title"></textarea></div>');
  const task={id:'ONE-1',internalId:'opaque-1',revision:1};
  const data={session:{id:'s1',userId:'u1'},tasks:[task],projects:[],tracks:[],epics:[],milestones:[],pool:[]};
  const app=appFor(()=>({view:'task',taskId:'ONE-1',projectId:'p1'}));
  const controller=createRecoveryController({data,api:{},gateway:{},getApp:()=>app,getAuth:()=>null,reload:async()=>{},setTimer:()=>0,clearTimer:()=>{},online:()=>true});
  controller.start();
  const focus=()=>document.querySelector('.tp-title').dispatchEvent(new window.FocusEvent('focusin',{bubbles:true}));
  focus();
  const key=controller.revisionKey(task);
  task.revision=2;
  focus();
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
  const state=fixture({online:()=>online,api:{me:()=>new Promise(resolve=>resolveProbe=resolve)}});
  state.controller.start();
  const oldContext=state.controller.requestContext();
  const reconnect=state.controller.reconnect();
  online=false;state.window.dispatchEvent(new state.window.Event('offline'));
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

test('a reconnect that finds someone else signed in ends this person\'s session and reads nothing of theirs',async()=>{
  const state=fixture({api:{me:async()=>({user:{id:'u2'},sessionId:'s9'})}});
  state.controller.observeResponse({ok:false,error:new ApiError('Network',{code:'network_error'})});
  await state.controller.reconnect();
  assert.equal(state.expires,1);assert.equal(state.controller.expired,true);assert.equal(state.reloads,0);
});

test('a reconnect reads again only for the person the tab shows',async()=>{
  const same=fixture({api:{me:async()=>({user:{id:'u1'},sessionId:'s2'})}});
  await same.controller.reconnect();
  assert.equal(same.expires,0);assert.equal(same.reloads,1,'the same person keeps working, on their new session');
  const signedOut=fixture({api:{me:async()=>({user:{id:'u2'},sessionId:'s9'})}});signedOut.data.session=null;
  await signedOut.controller.reconnect();
  assert.equal(signedOut.expires,0);assert.equal(signedOut.reloads,0,'another person\'s sign-in loads nothing into a signed-out tab');
});

test('reconnect keeps service errors unavailable and retries reads until a successful response',async()=>{
  const timers=[];let attempts=0;
  const state=fixture({api:{me:async()=>{attempts++;if(attempts<3)throw new ApiError('Unavailable',{status:503});return {}; }},setTimer:(callback,delay)=>{timers.push({callback,delay});return timers.length;}});
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
  controller=page().createRecoveryController({data:{session:{id:'s1'}},api,gateway:{},reload:async()=>{reloads++;},online:()=>true,setTimer:()=>0,clearTimer:()=>{}});
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
  const {window,document,createRecoveryController}=page('<div class="modal"><div class="pool-editor"><form><input name="title"></form></div></div>');
  const source={id:'pool1',revision:1};
  const data={session:{id:'s1',userId:'u1'},pool:[source]};
  const app=appFor(()=>({view:'board',projectId:'p1',modal:{type:'task',poolId:'pool1'}}));
  const controller=createRecoveryController({data,api:{},gateway:{},getApp:()=>app,getAuth:()=>null,reload:async()=>{},setTimer:()=>0,clearTimer:()=>{},online:()=>true});
  controller.start();
  const focus=()=>document.querySelector('[name="title"]').dispatchEvent(new window.FocusEvent('focusin',{bubbles:true}));
  focus();data.pool=[{id:'pool1',revision:2}];focus();
  assert.equal(controller.expectedRevision(controller.revisionKey(data.pool[0]),2),1);
  controller.dispose();
});

test('access reconciliation leaves a removed project and clears its route and overlays',()=>{
  for (const view of ['board','task','roadmap']) {
    for (const projects of [[],[{id:'other'}]]) {
      const calls=[],toasts=[];
      const app={nav:(view)=>calls.push(view),selectProject:(id)=>calls.push(id),toast:(...args)=>toasts.push(args)};
      assert.equal(leaveUnavailableProject({projects},app,{projectId:'removed',view},'Customer portal'),true);
      assert.deepEqual(calls,projects.length?['other','board']:['board']);
      assert.deepEqual(toasts,[['You no longer have access to Customer portal.','info']],'the page says why it changed');
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
  assert.match(state.controller.connectionHtml(),/oneloop was updated\. The page reloads by itself when nothing you typed would be lost\./);
  state.controller.clearPageError();state.controller.sessionChanged(state.data.session);
  assert.match(state.controller.connectionHtml(),/Reload now/);assert.equal(state.app.refreshes,0);assert.equal(state.controller.ensureOnline(),true);
});


test('forced password sessions neither schedule nor run project access probes',async()=>{
  const timers=[];let probes=0;
  const state=fixture({api:{counts:async()=>{probes++;}},setTimer:callback=>{timers.push(callback);return timers.length;}});
  state.app.context=()=>({view:'roadmap',projectId:'p1'});
  state.data.session.temporary=true;state.controller.start();state.controller.sessionChanged(state.data.session);
  assert.equal(timers.length,0);
  state.data.session.temporary=false;state.controller.sessionChanged(state.data.session);
  assert.equal(timers.length,1);await timers[0]();assert.equal(probes,1);
  state.data.session.temporary=true;await timers[1]();assert.equal(probes,1);
  state.controller.dispose();
});

test('access probes wait while live updates are open or the tab is hidden',async()=>{
  const timers=[];let probes=0,visibility='visible';
  const state=fixture({api:{counts:async()=>{probes++;}},setTimer:callback=>{timers.push(callback);return timers.length;}});
  Object.defineProperty(state.document,'visibilityState',{configurable:true,get:()=>visibility});
  state.controller.start();
  state.controller.liveConnected();await timers.at(-1)();
  assert.equal(probes,0,'the live stream reports lost access');
  state.controller.livePaused(()=>{});await timers.at(-1)();
  assert.equal(probes,1,'a newer tab took the live stream');
  state.controller.liveDisconnected();visibility='hidden';await timers.at(-1)();
  assert.equal(probes,1,'a hidden tab reconciles when it shows again');
  visibility='visible';await timers.at(-1)();
  assert.equal(probes,2);
  state.controller.dispose();
});

test('access probes go on after the server could not be reached',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const answer=deferred();let probes=0;
  const state=fixture({api:{me:()=>answer.promise,counts:async()=>{probes++;}},setTimer:setTimeout,clearTimer:clearTimeout});
  state.controller.start();
  // The server stops answering, and is still down when the next probe is due.
  state.controller.observeResponse({ok:false,error:new ApiError('Network',{code:'network_error'})});
  t.mock.timers.tick(30_000);await settle();
  assert.equal(probes,0,'an unreachable server is not probed');
  // It answers the reconnect.
  answer.resolve({});await settle();
  t.mock.timers.tick(30_000);await settle();
  assert.equal(probes,1,'the next probe runs on time');
  state.controller.dispose();
});

test('idle Board and Roadmap access probes only read counts',async()=>{
  for(const view of ['board','roadmap']){
    const timers=[],calls=[];
    const state=fixture({api:{counts:async(...args)=>calls.push(args)},setTimer:callback=>{timers.push(callback);return timers.length;}});
    state.app.context=()=>({view,projectId:'p1'});
    state.controller.start();await timers[0]();
    assert.deepEqual(structuredClone(calls),[['p1',{background:true}]]);state.controller.dispose();
  }
});

/**
 * A page that learns about an update, with storage, visibility and a clock
 * the test controls. `stores` is the tab's storage, which a reload keeps; a
 * reload is counted, since jsdom can't run one. The page checks the server's
 * version the way the app does, with the build monitor; `server` is the
 * version the server answers with. `html` is what the page shows.
 */
function updatable({hidden=false,stores={session:new Map()},html=''}={}){
  const timers=new Map(),listeners={};let clock=0,next=0,reloads=0,saving=false,checks=0,visibility=hidden?'hidden':'visible';
  const storage=map=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>{map.set(key,String(value));},removeItem:key=>{map.delete(key);}});
  const {window,document,createRecoveryController}=page(html);
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
  const windowObject={sessionStorage:storage(stores.session),location:{hash:'',reload:()=>{reloads++;}},requestAnimationFrame:callback=>callback(),addEventListener:(type,listener)=>{(listeners[type]??=[]).push(listener);},removeEventListener(){}};
  const app=appFor(()=>({view:'board',projectId:'p1'}));
  let server=oldVersion;
  const monitor=createBuildMonitor({fetchBuild:async()=>{checks++;return server;},onInitial(){},onUpdate:value=>controller.buildChanged(value)});
  const controller=createRecoveryController({data:{session:{id:'s1',userId:'u1'}},api:{counts:async()=>({})},gateway:{hasPending:()=>saving,invalidate(){}},getApp:()=>app,
    setTimer:(callback,delay)=>{timers.set(++next,{callback,at:clock+delay});return next;},clearTimer:id=>{timers.delete(id);},now:()=>clock,windowObject,
    checkBuild:()=>monitor.check()});
  controller.start();
  const fire=type=>document.dispatchEvent(new window.Event(type));
  return {controller,stores,monitor,document,toasts:app.toasts,get reloads(){return reloads;},get checks(){return checks;},set saving(value){saving=value;},set server(value){server=value;},fire,
    /** The tab hides, or shows again. */
    show(visible){visibility=visible?'visible':'hidden';fire('visibilitychange');},
    /** The page goes away, as a browser takes it, such as for a reload: first pagehide, then it hides. */
    leave(){for(const listener of listeners.pagehide??[])listener({persisted:false});visibility='hidden';fire('visibilitychange');},
    /** The page comes back from the browser's back-forward cache. */
    restore(){visibility='visible';fire('visibilitychange');for(const listener of listeners.pageshow??[])listener({persisted:true});},
    /** Move the clock on, run the timers that are due, and let the checks they start finish. */
    async advance(ms){clock+=ms;for(const [id,timer] of [...timers].sort((a,b)=>a[1].at-b[1].at))if(timer.at<=clock&&timers.delete(id))timer.callback();await settle();}};
}
const newVersion={version:'0.2.0',revision:'b2'},oldVersion={version:'0.1.0',revision:'a1'};

test('a hidden tab asks the server for its version every minute and reloads once no save is running',async()=>{
  const page=updatable();await page.monitor.check();
  page.show(false);page.saving=true;
  await page.advance(60_000);
  assert.equal(page.checks,2);assert.equal(page.reloads,0,'nothing changed yet');
  page.server=newVersion;
  await page.advance(59_000);assert.equal(page.checks,2);
  await page.advance(1_000);
  assert.equal(page.checks,3);assert.equal(page.reloads,0,'a save is still running');
  page.saving=false;page.controller.interactionPending('task.update:t1:title',false);
  assert.equal(page.reloads,1);
});

test('a tab that shows again counts as activity, so the person who comes back is not reloaded at once',async()=>{
  const page=updatable();await page.monitor.check();
  page.show(false);await page.advance(30_000);
  page.server=newVersion;
  // They come back before the next check; the live connection opens and checks.
  page.show(true);await page.monitor.check();
  assert.equal(page.reloads,0,'not in front of the person');
  await page.advance(4*60_000+59_000);assert.equal(page.reloads,0);
  await page.advance(60_000);
  assert.equal(page.reloads,1,'five minutes without activity');
});

test('a tab that is shown reloads only after five minutes without activity',()=>{
  const page=updatable();
  page.controller.buildChanged(newVersion);
  page.advance(4*60_000);page.fire('keydown');page.advance(4*60_000);
  assert.equal(page.reloads,0,'the person typed four minutes ago');
  page.advance(60_000);
  assert.equal(page.reloads,1);
});

test('unsaved input keeps an updated tab from reloading until it is gone',()=>{
  const page=updatable({hidden:true});let draft=true;
  page.controller.trackUnsaved(()=>draft);
  page.controller.buildChanged(newVersion);page.advance(5*60_000);
  assert.equal(page.reloads,0);
  draft=false;page.advance(30_000);
  assert.equal(page.reloads,1);
});

test('a dialog, drawer, menu, preview, confirmation, Undo offer or drag keeps an updated tab from reloading until it is gone',()=>{
  for(const html of ['<div class="modal"></div>','<div class="peek"></div>','<div class="menu"></div>','<div class="pop"></div>','<div class="file-overlay"></div>','<div class="confirmation-layer"></div>','<button class="toast-action">Undo</button>','drag']){
    const page=updatable({hidden:true,html:html==='drag'?'':html});
    if(html==='drag')page.document.body.classList.add('is-dragging');
    page.controller.buildChanged(newVersion);page.advance(60_000);
    assert.equal(page.reloads,0,html);
    page.document.body.replaceChildren();page.document.body.classList.remove('is-dragging');page.advance(30_000);
    assert.equal(page.reloads,1,html);
  }
});

test('a tab reloads by itself once for each version, so servers that disagree cannot make it loop',()=>{
  const first=updatable({hidden:true});
  first.controller.buildChanged(newVersion);first.controller.buildChanged(newVersion);first.fire('visibilitychange');
  assert.equal(first.reloads,1,'once per page');
  // The reloaded page met a server that still runs the old version, then the new one again.
  const second=updatable({hidden:true,stores:first.stores});second.controller.buildChanged(oldVersion);
  assert.equal(second.reloads,1);
  const third=updatable({hidden:true,stores:first.stores});third.controller.buildChanged(newVersion);third.advance(10*60_000);
  assert.equal(third.reloads,0);assert.match(third.controller.connectionHtml(),/Reload/);
});

test('only a reload the tab made by itself makes the next page say oneloop was updated, once',()=>{
  const automatic=updatable({hidden:true});automatic.controller.buildChanged(newVersion);
  assert.equal(automatic.reloads,1);
  assert.deepEqual(updatable({stores:automatic.stores}).toasts,[['oneloop was updated','info']]);
  assert.deepEqual(updatable({stores:automatic.stores}).toasts,[],'only the first page after the reload');
  // Reload now, and the browser's own reload: the page hides on its way out.
  const reloadNow=updatable();reloadNow.controller.buildChanged(newVersion);reloadNow.controller.activateNotice();reloadNow.leave();
  assert.equal(reloadNow.reloads,1,'Reload now reloads once');assert.deepEqual(updatable({stores:reloadNow.stores}).toasts,[]);
  const browser=updatable();browser.controller.buildChanged(newVersion);browser.leave();
  assert.equal(browser.reloads,0,'the browser reloads');assert.deepEqual(updatable({stores:browser.stores}).toasts,[]);
});

test('a page back from the browser\'s back-forward cache reloads by itself again',()=>{
  const page=updatable();page.controller.buildChanged(newVersion);
  page.leave();assert.equal(page.reloads,0);
  page.restore();page.show(false);
  assert.equal(page.reloads,1);
});

/**
 * A task page with a conflict over its description: Recovery reads the
 * latest saved value and asks the person in its prompt. `answer` resolves
 * with the outcome; `retried` lists the revisions Keep my changes saved at.
 */
function conflictPage(latestValue='theirs'){
  const section='<section class="tp-sec"><textarea id="task-description">mine</textarea></section>';
  const state=fixture({html:`<main class="content"><div class="task-page">${section}</div></main>`}),{document}=state,retried=[];
  const field=()=>document.getElementById('task-description');
  const review=()=>state.controller.resolveConflict({
    error:new ApiError('record changed; latest revision is 2',{status:409,code:'revision_conflict'}),
    reloadLatest:async()=>{},latestEntity:()=>({desc:latestValue,revision:2}),retry:async(revision)=>{retried.push(revision);return {};},
    target:{element:field,latestValue:(entity)=>entity.desc},myValue:'mine',
  });
  const prompt=()=>document.querySelector('[data-recovery-conflict]');
  const button=(label)=>[...prompt().querySelectorAll('button')].find(item=>item.textContent===label);
  /** The page draws the task again, as a live update does; `readonly` once edit rights end. */
  const redraw=(readonly=false)=>{document.querySelector('.task-page').innerHTML=readonly?section.replace('<textarea','<textarea readonly'):section;};
  return {...state,field,review,prompt,button,redraw,retried};
}

test('a conflict prompt stays beside its field and shows a long latest value only on demand',async()=>{
  const value='<script>do not execute</script>'+' saved'.repeat(80),t=conflictPage(value);
  const answer=t.review();await settle();
  assert.equal(t.prompt().closest('.tp-sec'),t.field().closest('.tp-sec'));assert.equal(t.document.querySelectorAll('script').length,0);
  assert.ok(t.prompt().querySelector('span').textContent.length<260);
  const show=t.button('Show all');show.click();assert.ok(t.prompt().textContent.includes(value));assert.equal(show.getAttribute('aria-expanded'),'true');
  t.button('Use latest').click();
  assert.deepEqual({...await answer},{handled:true,saved:false,latest:{desc:value,revision:2},choice:'latest'});
  assert.equal(t.field().value,value);assert.equal(t.prompt(),null);assert.deepEqual(t.retried,[]);
});

test('a conflict prompt closes without an answer when its field goes, or can no longer be edited',async()=>{
  for(const readonly of [false,true]){
    const t=conflictPage(),answer=t.review();await settle();
    if(readonly)t.redraw(true);else t.document.querySelector('.task-page').remove();
    assert.deepEqual({...await answer},{handled:true,saved:false});assert.equal(t.prompt(),null);
  }
});

test('a newer conflict prompt replaces one still waiting, which closes without an answer',async()=>{
  const t=conflictPage(),first=t.review();await settle();
  const second=t.review();await settle();
  assert.deepEqual({...await first},{handled:true,saved:false});
  assert.equal(t.document.querySelectorAll('[data-recovery-conflict]').length,1);
  t.button('Keep my changes').click();
  assert.equal((await second).saved,true);assert.deepEqual(t.retried,[2]);
});

test('after Keep my changes, a redraw removes the saving note instead of bringing it back',async()=>{
  const t=conflictPage(),answer=t.review();await settle();
  t.button('Keep my changes').click();
  assert.equal((await answer).saved,true);assert.match(t.prompt().textContent,/Saving your changes/);
  t.redraw();await settle();
  assert.equal(t.prompt(),null);
});
