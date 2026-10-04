// @ts-check

import { ApiError } from '../../data/api-client.js';

const REVISION_CONFLICT = /(?:record|attachment|comment|user).*(?:changed|latest revision)|latest revision/i;
const EDITOR_ROOT = '.modal,.task-page,.peek,.settings,.workspace-page';
const EDITOR_REVISIONS = new WeakMap();

/** @param {unknown} error */
export function isRevisionConflict(error) {
  return error instanceof ApiError
    && error.status === 409
    && (error.code === 'revision_conflict' || (error.code === 'conflict' && REVISION_CONFLICT.test(error.message)));
}

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[character]);
}

/** @param {Element} root @param {Element} element */
function controlKey(root, element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const controls=[...root.querySelectorAll('input,textarea,select')].filter((item)=>item.getAttribute('name')===element.getAttribute('name'));
  const index=controls.indexOf(element);
  return element.getAttribute('name') ? `[name="${CSS.escape(element.getAttribute('name') || '')}"]:${index}` : null;
}

/** Capture open editor state only in memory for the duration of one refresh. */
export function captureOpenEditor(doc = document) {
  const active=doc.activeElement;
  const candidates=[...doc.querySelectorAll(EDITOR_ROOT)];
  const root=active?.closest?.(EDITOR_ROOT) ?? candidates.find((candidate)=>candidate.querySelector('form:focus-within')) ?? candidates.find((candidate)=>EDITOR_REVISIONS.has(candidate)) ?? null;
  if (!root) return null;
  const controls=[];
  for (const element of root.querySelectorAll('input,textarea,select')) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) continue;
    if (element instanceof HTMLInputElement && ['password','file','submit','button'].includes(element.type)) continue;
    const key=controlKey(root,element);if(!key)continue;
    controls.push({key,value:element.value,checked:element instanceof HTMLInputElement?element.checked:undefined});
  }
  const activeKey=active instanceof Element?controlKey(root,active):null;
  const selection=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement
    ? {start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection}
    : null;
  return {rootClass:[...root.classList],controls,activeKey,selection,scrollTop:root.scrollTop,revisions:[...(EDITOR_REVISIONS.get(root)?.entries?.()??[])]};
}

/** @param {ReturnType<typeof captureOpenEditor>} snapshot @param {Document} [doc] */
export function restoreOpenEditor(snapshot, doc = document) {
  if (!snapshot) return null;
  const root=[...doc.querySelectorAll(EDITOR_ROOT)].find((candidate)=>snapshot.rootClass.every((name)=>candidate.classList.contains(name)));
  if (!root) return null;
  if(snapshot.revisions?.length)EDITOR_REVISIONS.set(root,new Map(snapshot.revisions));
  const find=(key)=>{
    if(key.startsWith('#'))return root.querySelector(key);
    const match=key.match(/^\[name="(.+)"\]:(\d+)$/);if(!match)return null;
    return [...root.querySelectorAll(`[name="${match[1]}"]`)][Number(match[2])]??null;
  };
  for(const state of snapshot.controls){
    const element=find(state.key);
    if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement))continue;
    element.value=state.value;
    if(element instanceof HTMLInputElement&&state.checked!==undefined)element.checked=state.checked;
  }
  root.scrollTop=snapshot.scrollTop;
  const active=snapshot.activeKey?find(snapshot.activeKey):null;
  if(active instanceof HTMLElement){
    active.focus({preventScroll:true});
    if(snapshot.selection&&(active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement)){
      try{active.setSelectionRange(snapshot.selection.start,snapshot.selection.end,snapshot.selection.direction??undefined);}catch{}
    }
  }
  return active;
}

/** @param {{target:Element|null,latestValue:unknown,myValue:unknown,snapshot?:unknown,isCurrent?:()=>boolean,updateTarget?:boolean}} input */
export function presentDomConflict({target,latestValue,myValue,isCurrent=()=>true,updateTarget=true}) {
  return new Promise((resolve)=>{
    if(!isCurrent()){resolve('cancelled');return;}
    document.querySelectorAll('.save-feedback[data-recovery-conflict]').forEach((element)=>element.remove());
    const box=document.createElement('div');box.className='save-feedback';box.dataset.recoveryConflict='true';box.setAttribute('role','alert');
    const message=document.createElement('span');
    const value=latestValue == null||latestValue===''?'Empty':String(latestValue);
    const copy=(expanded)=>latestValue===undefined?'Changed elsewhere. Review the latest version or keep your changes.':`Changed elsewhere. Latest saved value: ${expanded||value.length<=200?value:value.slice(0,200)+'…'}`;
    message.textContent=copy(false);
    const expand=document.createElement('button');expand.type='button';expand.className='btn quiet';expand.textContent='Show all';expand.hidden=latestValue===undefined||value.length<=200;
    expand.setAttribute('aria-expanded','false');
    expand.addEventListener('click',()=>{const expanded=expand.getAttribute('aria-expanded')!=='true';expand.setAttribute('aria-expanded',String(expanded));expand.textContent=expanded?'Show less':'Show all';message.textContent=copy(expanded);});
    const latest=document.createElement('button');latest.type='button';latest.className='btn quiet';latest.textContent='Use latest';
    const mine=document.createElement('button');mine.type='button';mine.className='btn quiet';mine.textContent='Keep my changes';
    box.append(message,expand,latest,mine);
    const parent=target?.closest('.field,.task-title-field,.tp-sec,.task-property,.pool-description-editor,.collaboration-composer') ?? document.querySelector('.modal form') ?? document.querySelector('.pool-description-editor form') ?? document.querySelector('.task-page') ?? document.querySelector('.content');
    parent?.append(box);
    if(!parent){resolve('cancelled');return;}
    const check=()=>{if(!box.isConnected||!isCurrent()){box.remove();finish('cancelled');return false;}return true;};
    const observer=new document.defaultView.MutationObserver(check);
    const finish=(choice)=>{if(choice!=='mine'){observer.disconnect();document.removeEventListener('input',check);}resolve(choice);};
    observer.observe(document.body,{childList:true,subtree:true});
    document.addEventListener('input',check);
    latest.addEventListener('click',()=>{if(!check())return;if(updateTarget&&latestValue!==undefined&&target&&'value' in target){target.value=latestValue==null?'':String(latestValue);target.dispatchEvent(new Event('input',{bubbles:true}));}box.remove();finish('latest');},{once:true});
    mine.addEventListener('click',()=>{if(!check())return;if(updateTarget&&myValue!==undefined&&target&&'value' in target)target.value=myValue==null?'':String(myValue);mine.disabled=true;latest.disabled=true;message.textContent='Saving your changes…';finish('mine');},{once:true});
  });
}

/**
 * Production recovery state. It observes transport outcomes but never retries a
 * write. Reconciliation is read-only and preserves the currently open editor.
 */
/** @typedef {{data:any,api:any,gateway:any,getApp?:()=>any,getAuth?:()=>any,reload?:(scope?:Record<string,unknown>)=>Promise<any>,presentConflict?:(input:{target:Element|null,latestValue:unknown,myValue:unknown,snapshot?:unknown,isCurrent?:()=>boolean,updateTarget?:boolean})=>Promise<string>,setTimer?:Function,clearTimer?:Function,random?:()=>number,online?:()=>boolean,windowObject?:Window|null,documentObject?:Document|null}} RecoveryOptions */
/** @param {RecoveryOptions} options */
export function createRecoveryController({
  data, api, gateway, getApp = () => null, getAuth = () => null,
  reload = async (_scope={}) => ({}),
  presentConflict = presentDomConflict,
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
  random = Math.random,
  online = () => globalThis.navigator?.onLine !== false,
  windowObject = globalThis.window,
  documentObject = globalThis.document,
}) {
  let hooks=null,pageError=null,pageReference=null,expired=false;
  let apiReachable=online(),liveReachable=true,reconnectAttempt=0,reconnectTimer=null,liveAttempt=0,liveTimer=null,reconcilePromise=null,accessTimer=null;
  let bound=false,disposed=false;
  let sessionGeneration=0,connectivityGeneration=0,reconnectGeneration=0;
  let routeLoadingTimer=null,routeLoadingGeneration=0;
  const pendingEditors=new Map();
  const pendingSaves=new Map();
  let refreshFailureScope=null,updatedBuild=false;

  function entityKey(entity){
    if(!entity)return null;
    const owningTask=data.tasks?.find((item)=>item.block===entity);
    if(owningTask)return `taskBlock:${entity.id}`;
    if(data.tasks?.includes(entity))return `task:${entity.internalId??entity.id}`;
    for(const [type,collection] of [['project',data.projects],['track',data.tracks],['epic',data.epics],['milestone',data.milestones],['pool',data.pool]])if(collection?.includes(entity))return `${type}:${entity.id}`;
    return entity.id?`entity:${entity.id}`:null;
  }

  function focusedEntity(target){
    const context=getApp()?.context?.();if(!context)return null;
    const poolId=target?.closest?.('[data-pool-item]')?.dataset?.poolItem;
    if(poolId)return data.pool?.find((item)=>item.id===poolId)??null;
    const modal=context.modal;
    if(modal?.poolId&&target?.closest?.('.pool-editor'))return data.pool?.find((item)=>item.id===modal.poolId)??null;
    if(modal?.id){
      if(['block','unblock','completeBlocked'].includes(modal.type)){const item=data.tasks?.find((task)=>task.id===modal.id||task.internalId===modal.id);return modal.type==='block'&&item?.block?item.block:item;}
      const collection={epic:data.epics,track:data.tracks,milestone:data.milestones}[modal.type];
      if(collection)return collection.find((item)=>item.id===modal.id)??null;
    }
    if(target?.closest?.('.task-page'))return data.tasks?.find((item)=>item.id===context.taskId||item.internalId===context.taskId)??null;
    if(target?.closest?.('.project-fields'))return data.projects?.find((item)=>item.id===context.projectId)??null;
    return null;
  }

  function rememberEditorRevision(event){
    const root=event.target?.closest?.(EDITOR_ROOT),entity=focusedEntity(event.target),key=entityKey(entity);
    if(!root||!key||!Number.isSafeInteger(entity?.revision))return;
    let revisions=EDITOR_REVISIONS.get(root);if(!revisions){revisions=new Map();EDITOR_REVISIONS.set(root,revisions);}
    if(!revisions.has(key))revisions.set(key,entity.revision);
  }

  function expectedRevision(entityOrKey,fallback){
    const key=typeof entityOrKey==='string'?entityOrKey:entityKey(entityOrKey);if(!key)return fallback??entityOrKey?.revision;
    for(const root of documentObject?.querySelectorAll?.(EDITOR_ROOT)??[]){const revision=EDITOR_REVISIONS.get(root)?.get(key);if(Number.isSafeInteger(revision))return revision;}
    return fallback??entityOrKey?.revision;
  }

  function finishRevision(entityOrKey){
    const key=typeof entityOrKey==='string'?entityOrKey:entityKey(entityOrKey);if(!key)return;
    for(const root of documentObject?.querySelectorAll?.(EDITOR_ROOT)??[])EDITOR_REVISIONS.get(root)?.delete(key);
  }

  const requestContext=()=>({sessionGeneration,connectivityGeneration,sessionId:data.session?.id??null,userId:data.session?.userId??null});
  const currentSession=(context)=>!context||(context.sessionGeneration===sessionGeneration
    &&(!Object.hasOwn(context,'sessionId')||context.sessionId===(data.session?.id??null))
    &&(!Object.hasOwn(context,'userId')||context.userId===(data.session?.userId??null)));
  const currentConnection=(context)=>!context||context.connectivityGeneration===connectivityGeneration;
  const connection=()=>apiReachable?'live': 'offline';
  const visibleConnection=()=>!apiReachable?'offline':liveReachable?'live':'reconnecting';
  const renderPreservingEditor=()=>{
    const snapshot=documentObject?(captureOpenEditor(documentObject)??[...pendingEditors.values()].at(-1)??null):null;
    if(hooks?.refresh)hooks.refresh();else getApp()?.refresh?.();
    if(snapshot&&documentObject)restoreOpenEditor(snapshot,documentObject);
  };
  const setConnectivity=(nextApi,nextLive=liveReachable)=>{
    const previous=visibleConnection();
    if(apiReachable!==nextApi)connectivityGeneration++;
    apiReachable=nextApi;liveReachable=nextLive;
    const next=visibleConnection();if(previous===next)return;
    updateNotice();
    if(next==='live'&&previous==='offline')getApp()?.toast?.('Connection restored','info');
  };

  function viewScope(){
    const context=getApp()?.context?.()??{};
    return JSON.stringify([data.session?.id,context.view,context.projectId,context.taskId]);
  }

  function notice(){
    const state=visibleConnection();
    if(state==='offline')return {text:online()?'Cannot reach oneloop — changes are not being saved':'Offline — changes are not being saved',action:'reconnect',label:'Reconnect'};
    if(state==='reconnecting')return {text:'Reconnecting to live updates…',action:'reconnect',label:'Reconnect'};
    if(updatedBuild)return {text:'oneloop was updated. Reload when you are ready; reloading discards unsaved input.',action:'reloadClient',label:'Reload'};
    if(refreshFailureScope===viewScope())return {text:'Could not refresh this view.',action:'retryRefresh',label:'Retry'};
    return null;
  }

  let announcedNotice = '';
  function announceNotice(state) {
    if (!documentObject?.body) return;
    let region = documentObject.getElementById('connection-announcer');
    if (!region) {
      region = documentObject.createElement('div'); region.id = 'connection-announcer'; region.className = 'sr-only';
      region.setAttribute('role','status'); region.setAttribute('aria-live','polite'); region.setAttribute('aria-atomic','true');
      documentObject.body.append(region);
    }
    const text = state?.text || '';
    if (announcedNotice === text) return;
    announcedNotice = text; region.textContent = '';
    const target = region;
    (windowObject?.requestAnimationFrame?.bind(windowObject) || (fn=>setTimer(fn,0)))(()=>{if(!disposed && announcedNotice===text)target.textContent=text;});
  }

  function connectionHtml(){
    const state=notice(); announceNotice(state);
    return state?`<div class="connection-notice"><span>${state.text}</span><button class="btn quiet" onclick="Recovery.activateNotice()">${state.label}</button></div>`:'';
  }

  function updateNotice(){
    const state=notice(); announceNotice(state);
    const main=documentObject?.querySelector?.('#app .main');
    if(!main)return;
    let element=main.querySelector('.connection-notice');
    if(!state){element?.remove();return;}
    if(element?.querySelector('span')?.textContent===state.text)return;
    if(!element){
      element=documentObject.createElement('div');element.className='connection-notice';
      element.toggleAttribute('inert',!!main.querySelector('.content')?.hasAttribute('inert'));
      const copy=documentObject.createElement('span');
      const button=documentObject.createElement('button');button.type='button';button.className='btn quiet';
      button.addEventListener('click',activateNotice);
      element.append(copy,button);main.querySelector('.page-header')?.after(element);
    }
    element.querySelector('span').textContent=state.text;
    const button=element.querySelector('button');button.textContent=state.label;
  }

  function activateNotice(){
    const state=notice();if(!state)return;
    if(state.action==='reloadClient')controller.reloadClient();
    else if(state.action==='reconnect')reconnect();
    else reconcile({background:true});
  }

  function refreshFailed(error){
    if(!currentSession(error?.requestContext)||['aborted','invalid_origin'].includes(error?.code))return;
    if([401,403,404].includes(error?.status)){handleRouteError(error,{background:true});return;}
    refreshFailureScope=viewScope();updateNotice();
  }

  function refreshSucceeded(){refreshFailureScope=null;updateNotice();}

  function interactionPending(key,pending){
    if(!pending){
      const state=pendingSaves.get(key);
      if(state){clearTimer(state.timer);getApp()?.clearTaskSaving?.(state.token);pendingSaves.delete(key);}
      pendingEditors.delete(key);return;
    }
    const snapshot=documentObject?captureOpenEditor(documentObject):null;
    if(snapshot)pendingEditors.set(key,snapshot);
    const context=getApp()?.context?.();
    if(context?.view!=='task'||!key.startsWith('task.'))return;
    const scope=viewScope(),token={},taskId=context.taskId;
    const timer=setTimer(()=>{
      if(!disposed&&viewScope()===scope&&pendingSaves.get(key)?.token===token)getApp()?.noteTaskSaving?.(taskId,token);
    },300);
    pendingSaves.set(key,{timer,token});
  }

  function clearPendingSaves(){for(const key of pendingSaves.keys())interactionPending(key,false);}

  async function reconcile(scope={}) {
    if(reconcilePromise)return reconcilePromise;
    const background=scope.background!==false;
    reconcilePromise=Promise.resolve(reload({...scope,background})).catch((error)=>{
      handleRouteError(error,{background});return {error};
    }).finally(()=>{reconcilePromise=null;});
    return reconcilePromise;
  }

  async function probeAccess() {
    if(disposed||!data?.session||data.session.temporary||!apiReachable)return;
    const context=getApp()?.context?.();if(!context)return;
    try{
      if(context.view==='task'&&context.taskId){
        const task=data.tasks?.find((item)=>item.id===context.taskId||item.internalId===context.taskId);
        if(task)await api.task(task.internalId,{background:true});
      }else if(['roadmap','board'].includes(context.view)&&context.projectId)await api.counts(context.projectId,{background:true});
    }catch(error){
      if(error instanceof ApiError&&[403,404].includes(error.status)){
        await reconcile();
      }
    }finally{scheduleAccessProbe();}
  }
  function scheduleAccessProbe(){clearTimer(accessTimer);if(disposed||!data?.session||data.session.temporary)return;accessTimer=setTimer(probeAccess,30_000);}

  async function reconnect(manual=true) {
    clearTimer(reconnectTimer);if(manual)reconnectAttempt=0;
    if(disposed)return;
    if(!online()){setConnectivity(false);scheduleReconnect();return;}
    const attempt=++reconnectGeneration;
    const context=requestContext();
    try{
      await api.request('/api/auth/me',{background:true});
      if(disposed||attempt!==reconnectGeneration||!currentSession(context)||!online())return;
      // The shared response observer may already have restored the connection.
      if(!currentConnection(context))return;
      reconnectAttempt=0;setConnectivity(true);await reconcile();
    }catch(error){
      if(disposed||attempt!==reconnectGeneration||!currentSession(context))return;
      if(error instanceof ApiError&&error.status===401){sessionExpired();return;}
      if(!currentConnection(context))return;
      if(error?.code==='aborted')return;
      setConnectivity(false);scheduleReconnect();
    }
  }
  function scheduleReconnect(){
    if(disposed)return;
    clearTimer(reconnectTimer);
    const delay=Math.min(1000*(2**reconnectAttempt),30_000)*(0.9+random()*0.2);reconnectAttempt++;
    reconnectTimer=setTimer(()=>reconnect(false),delay);
  }

  function sessionExpired() {
    if(expired||!data?.session)return false;
    expired=true;sessionGeneration++;reconnectGeneration++;gateway?.invalidate?.();getAuth()?.expire?.();return true;
  }

  function observeResponse(event) {
    if(disposed||!event||!currentSession(event.requestContext))return;
    const error=event.error;
    if(!event.ok&&error instanceof ApiError&&error.status===401&&data?.session&&!String(event.path).startsWith('/api/auth/login'))sessionExpired();
    if(!currentConnection(event.requestContext))return;
    if(event.ok){
      if(online()&&!apiReachable){
        reconnectAttempt=0;clearTimer(reconnectTimer);setConnectivity(true);reconcile();
      }
      return;
    }
    if(error instanceof ApiError&&(['network_error','timeout'].includes(error.code)||[502,503,504].includes(error.status))){
      // Invalidate earlier results even if an earlier failure already blocked writes.
      connectivityGeneration++;
      setConnectivity(false);scheduleReconnect();
    }
  }

  function cancelRouteLoading() {
    routeLoadingGeneration++;
    clearTimer(routeLoadingTimer);routeLoadingTimer=null;
  }

  function beginRouteLoad() {
    cancelRouteLoading();
    const generation=routeLoadingGeneration;
    pageReference=null;
    routeLoadingTimer=setTimer(()=>{
      if(disposed||generation!==routeLoadingGeneration)return;
      pageError='loading';renderPreservingEditor();
    },120);
  }

  function handleRouteError(error,{background=false}={}) {
    if(!currentSession(error?.requestContext)||error?.code==='aborted'||error?.code==='invalid_origin')return false;
    if(error instanceof ApiError&&error.status===401){sessionExpired();return true;}
    if(error instanceof ApiError&&['network_error','timeout'].includes(error.code)){
      if(!background){cancelRouteLoading();pageError='503';pageReference=null;renderPreservingEditor();}
      return true;
    }
    if(background&&!(error instanceof ApiError&&[403,404].includes(error.status)))return false;
    cancelRouteLoading();
    if(error instanceof ApiError&&error.status===403)pageError='403';
    else if(error instanceof ApiError&&error.status===404)pageError='404';
    else if(error instanceof ApiError&&[502,503,504].includes(error.status))pageError='503';
    else pageError='500';
    pageReference=String(error?.message??'').match(/reference:\s*([a-zA-Z0-9-]+)/)?.[1]??null;
    renderPreservingEditor();return true;
  }

  async function handleCommandFailure(error) {
    if(!currentSession(error?.requestContext)||error?.code==='invalid_origin')return;
    if(error instanceof ApiError&&[403,404].includes(error.status))await reconcile();
    if(error instanceof ApiError&&error.status===401)sessionExpired();
  }

  async function resolveConflict({error,reloadLatest,latestEntity,retry,target=null,myValue,snapshot=null,isCurrent=()=>true}) {
    if(!isRevisionConflict(error))return {handled:false};
    const scope=viewScope(),current=()=>scope===viewScope()&&isCurrent();
    if(!current())return {handled:true,saved:false};
    snapshot=snapshot??(documentObject?captureOpenEditor(documentObject):null);
    await reloadLatest();
    if(!current())return {handled:true,saved:false};
    const restored=snapshot&&documentObject?restoreOpenEditor(snapshot,documentObject):null;
    const entity=latestEntity();
    if(!entity){pageError='404';renderPreservingEditor();return {handled:true,saved:false};}
    const latestValue=target?.latestValue?.(entity);
    const chosen=await presentConflict({target:target?.element?.()??restored,latestValue,myValue:myValue??target?.myValue,snapshot,isCurrent:current,updateTarget:!target?.acceptLatest});
    if(chosen==='cancelled'||!current())return {handled:true,saved:false};
    if(chosen!=='mine'){
      await reloadLatest();
      if(!current())return {handled:true,saved:false};
      const latest=latestEntity();
      if(latest)target?.acceptLatest?.(latest);
      return {handled:true,saved:false,latest};
    }
    try{const result=await retry(entity.revision);return {handled:true,saved:true,result,stale:!current()};}
    catch(retryError){if(!current())return {handled:true,saved:false};documentObject?.querySelectorAll?.('.save-feedback[data-recovery-conflict]')?.forEach?.((element)=>element.remove());handleCommandFailure(retryError);throw retryError;}
  }

  function errorHtml(code) {
    if(code==='loading'){
      const context=getApp()?.context?.();
      const view=context?.view==='notfound'&&context.taskId?'task':context?.view;
      if(view==='board')return `<div class="loading-board" role="status" aria-label="Loading Board">${Array.from({length:4},()=>'<div class="loading-column"><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div>').join('')}</div>`;
      if(view==='roadmap')return `<div class="loading-roadmap" role="status" aria-label="Loading Roadmap"><div class="skeleton skeleton-heading"></div>${Array.from({length:3},()=>'<div class="loading-roadmap-row"><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-card"></div></div>').join('')}</div>`;
      if(view==='task')return '<div class="loading-task" role="status" aria-label="Loading task"><div class="skeleton skeleton-heading"></div><div class="loading-task-columns"><div class="loading-task-main"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div><div class="loading-task-properties"><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-heading"></div></div></div></div>';
      return '<div class="loading-state" role="status" aria-label="Loading"><div></div><div></div><div></div><span class="sr-only">Loading</span></div>';
    }
    const variants={404:['Page not found','The page or item may have been removed.'],403:['Access denied','You don’t have permission to view this page.'],500:['Could not load this page','Something went wrong. Please try again.'],503:['Service unavailable','The server is temporarily unavailable.']};
    const [title,copy]=variants[code]??variants[500];
    return `<section class="page-error"><span class="error-code">${escapeHtml(code)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p><div class="error-actions">${['500','503'].includes(code)?'<button class="btn primary" onclick="Recovery.retryLoad()">Retry</button>':''}<button class="btn quiet" onclick="App.nav('board')">Back to Board</button>${pageReference?'<button class="btn quiet" onclick="Recovery.copyReference()">Copy error reference</button>':''}</div></section>`;
  }

  const controller={
    get pageError(){return pageError;},get pageReference(){return pageReference;},get connection(){return visibleConnection();},get expired(){return expired;},scenario:'',
    requestContext,isRevisionConflict,observeResponse,handleRouteError,handleCommandFailure,resolveConflict,sessionExpired,
    errorHtml,
    captureEditor:()=>documentObject?captureOpenEditor(documentObject):null,
    restoreEditor:(snapshot)=>snapshot&&documentObject?restoreOpenEditor(snapshot,documentObject):null,
    revisionKey:entityKey,expectedRevision,finishRevision,
    interactionPending,refreshFailed,refreshSucceeded,isSavingTask:()=>pendingSaves.size>0,
    sessionActive:(session)=>session?.revokedAt==null,
    enforceSession:()=>false,
    ensureOnline(){if(connection()!=='offline')return true;getApp()?.toast?.('Reconnect before making this change.','error');return false;},
    connectionHtml,
    activateNotice,
    buildChanged(){updatedBuild=true;updateNotice();},
    reloadClient(){windowObject?.location.reload();},
    reconnect,
    // The SSE reconcile event owns the post-reconnect refresh.
    liveConnected(){liveAttempt=0;clearTimer(liveTimer);setConnectivity(apiReachable,true);},
    liveDisconnected(reconnectLive){
      setConnectivity(apiReachable,false);clearTimer(liveTimer);
      if(typeof reconnectLive==='function'){
        const delay=Math.min(1000*(2**liveAttempt),30_000)*(0.9+random()*0.2);liveAttempt++;
        liveTimer=setTimer(()=>{if(!disposed&&data?.session)reconnectLive();},delay);
      }
    },
    beginRouteLoad,
    clearPageError(){cancelRouteLoading();clearPendingSaves();refreshFailureScope=null;updateNotice();pageError=null;pageReference=null;},
    consumeReturn(){return null;},
    retryLoad(){beginRouteLoad();reconcile({background:false}).then((result)=>{cancelRouteLoading();if(!result?.error){pageError=null;renderPreservingEditor();}});},
    retryRefresh:()=>reconcile({background:true}),
    copyReference(){if(!pageReference)return;globalThis.navigator?.clipboard?.writeText(pageReference).then(()=>getApp()?.toast?.('Error reference copied'),()=>getApp()?.toast?.('Could not copy reference','error'));},
    blockDrag(){if(connection()!=='offline')return false;getApp()?.toast?.('Move was not saved. Try again.','error');return true;},
    recentAuth(run){return getAuth()?.withRecentAuth?.(run);},
    loginAtLimit(_user,complete){complete();return false;},
    bind(nextApp,nextHooks){hooks=nextHooks;if(!bound){bound=true;scheduleAccessProbe();documentObject?.addEventListener?.('focusin',rememberEditorRevision,true);windowObject?.addEventListener?.('offline',()=>{connectivityGeneration++;reconnectGeneration++;setConnectivity(false);scheduleReconnect();});windowObject?.addEventListener?.('online',()=>reconnect(true));}return controller;},
    sessionChanged(session){cancelRouteLoading();clearPendingSaves();refreshFailureScope=null;sessionGeneration++;reconnectGeneration++;clearTimer(reconnectTimer);if(session){expired=false;pageError=null;pageReference=null;setConnectivity(online(),liveReachable);scheduleAccessProbe();}else{pendingEditors.clear();clearTimer(accessTimer);}},
    dispose(){disposed=true;cancelRouteLoading();clearPendingSaves();pendingEditors.clear();clearTimer(reconnectTimer);clearTimer(liveTimer);clearTimer(accessTimer);},
  };
  return Object.freeze(controller);
}

/** Leave an inaccessible project after an authoritative metadata refresh.
 * @param {any} data @param {any} app @param {any} previous
 */
export function leaveUnavailableProject(data, app, previous) {
  if (!previous?.projectId || !['roadmap','board','task'].includes(previous.view)
      || data.projects.some((project) => project.id === previous.projectId)) return false;
  if(data.projects.length)app.selectProject(data.projects[0].id);
  app.nav('board');
  return true;
}
