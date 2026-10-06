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

/** A checkbox or a radio button, which changes by being ticked; its value stays the same. @param {Element} element */
const isTick = (element) => element instanceof HTMLInputElement && (element.type==='checkbox' || element.type==='radio');

/** @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} element */
function changedControl(element) {
  if (element instanceof HTMLSelectElement) return [...element.options].some((option)=>option.selected!==option.defaultSelected);
  if (isTick(element)) return /** @type {HTMLInputElement} */ (element).checked!==/** @type {HTMLInputElement} */ (element).defaultChecked;
  return element.value!==element.defaultValue;
}

/** Inputs that hold nothing to keep: passwords, files, buttons, hidden values and search boxes. */
const NOT_TYPED = new Set(['password','file','submit','button','reset','image','hidden','search']);
/** A field that saves itself when it loses focus, such as a task's title. */
const AUTOSAVE = '[data-autosave]';
/** Reload after updates, a choice each browser makes. */
const AUTO_RELOAD = 'oneloop.autoReload';
/** The versions a tab already reloaded itself for. */
const RELOADED_FOR = 'oneloop.reloadedFor';
const IDLE_BEFORE_RELOAD_MS = 60_000, AUTO_RELOAD_CHECK_MS = 30_000, HIDDEN_BUILD_CHECK_MS = 60_000;

/**
 * Whether an open editor holds text the person typed and has not saved or
 * sent: a changed field in a dialog, a drawer, the task page or a settings
 * page. A field that saves itself counts only while it has focus with a value
 * it has not saved yet; a checkbox that saves itself never counts, because it
 * saves when it changes. `skip` leaves out controls that keep their own state;
 * `roots` limits the check to some editors, such as one dialog.
 * @param {Document} doc @param {WeakMap<Element,string>} committed what each autosaved field last saved
 * @param {(element:Element)=>boolean} [skip] @param {Iterable<Element>} [roots]
 */
export function hasTypedInput(doc, committed, skip = () => false, roots = doc.querySelectorAll(EDITOR_ROOT)) {
  const active=doc.activeElement;
  for (const root of roots) for (const element of root.querySelectorAll('input,textarea,select')) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) || element.disabled || skip(element)) continue;
    if (element instanceof HTMLInputElement && NOT_TYPED.has(element.type) || !(element instanceof HTMLSelectElement) && element.readOnly) continue;
    if (!element.matches(AUTOSAVE)) { if (changedControl(element)) return true; continue; }
    if (isTick(element) || element instanceof HTMLSelectElement) continue;
    if (element===active && element.value!==(committed.get(element) ?? element.defaultValue)) return true;
  }
  return false;
}

/**
 * Capture open editor state, only in memory. With `changedOnly`, only the
 * controls the person changed, and nothing when they changed none; `skip`
 * leaves out controls that keep their own state.
 * @param {Document} [doc] @param {{changedOnly?:boolean,skip?:(element:Element)=>boolean}} [options]
 */
export function captureOpenEditor(doc = document, {changedOnly=false, skip=()=>false} = {}) {
  const active=doc.activeElement;
  const candidates=[...doc.querySelectorAll(EDITOR_ROOT)];
  const root=active?.closest?.(EDITOR_ROOT) ?? candidates.find((candidate)=>candidate.querySelector('form:focus-within')) ?? candidates.find((candidate)=>EDITOR_REVISIONS.has(candidate)) ?? null;
  if (!root) return null;
  const controls=[];
  for (const element of root.querySelectorAll('input,textarea,select')) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) continue;
    if (element instanceof HTMLInputElement && ['password','file','submit','button'].includes(element.type)) continue;
    if (skip(element) || changedOnly && !changedControl(element)) continue;
    const key=controlKey(root,element);if(!key)continue;
    controls.push({key,value:element.value,checked:element instanceof HTMLInputElement?element.checked:undefined});
  }
  if (changedOnly && !controls.length) return null;
  const activeKey=active instanceof Element?controlKey(root,active):null;
  const selection=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement
    ? {start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection}
    : null;
  return {rootClass:[...root.classList],controls,activeKey,selection,scrollTop:root.scrollTop,revisions:[...(EDITOR_REVISIONS.get(root)?.entries?.()??[])]};
}

/** The control a `controlKey` names in `root`. @param {Element} root @param {string} key */
function findControl(root, key) {
  if(key.startsWith('#'))return root.querySelector(key);
  const match=key.match(/^\[name="(.+)"\]:(\d+)$/);if(!match)return null;
  return [...root.querySelectorAll(`[name="${match[1]}"]`)][Number(match[2])]??null;
}

/** The editor in `doc` of the same kind as one with these classes. @param {Document} doc @param {string[]} rootClass */
const sameEditor = (doc, rootClass) => [...doc.querySelectorAll(EDITOR_ROOT)].find((candidate)=>rootClass.every((name)=>candidate.classList.contains(name)));

/**
 * Put captured editor state back. With `notify`, a control whose value changes
 * reports an input event, so the page reacts as if the person typed it.
 * @param {ReturnType<typeof captureOpenEditor>} snapshot @param {Document} [doc] @param {{notify?:boolean}} [options]
 */
export function restoreOpenEditor(snapshot, doc = document, {notify=false} = {}) {
  if (!snapshot) return null;
  const root=sameEditor(doc,snapshot.rootClass);
  if (!root) return null;
  if(snapshot.revisions?.length)EDITOR_REVISIONS.set(root,new Map(snapshot.revisions));
  const find=(key)=>findControl(root,key);
  for(const state of snapshot.controls){
    const element=find(state.key);
    if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement))continue;
    const changed=element.value!==state.value||element instanceof HTMLInputElement&&state.checked!==undefined&&element.checked!==state.checked;
    element.value=state.value;
    if(element instanceof HTMLInputElement&&state.checked!==undefined)element.checked=state.checked;
    if(notify&&changed)element.dispatchEvent(new (doc.defaultView??globalThis).Event('input',{bubbles:true}));
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

/**
 * Finds a control again after a redraw replaced it: the control with its id
 * or name in the editor of the same kind.
 * @param {Element|null} element @returns {()=>Element|null}
 */
export function relocator(element) {
  const root=element?.closest?.(EDITOR_ROOT),key=root?controlKey(root,element):null;
  if(!key)return ()=>null;
  const rootClass=[...root.classList];
  return ()=>{const next=sameEditor(document,rootClass);return next?findControl(next,key):null;};
}

/** The place for a conflict prompt: beside its field, or else in the open form or page. @param {Element|null} field */
const promptHost = (field) => field?.closest('.field,.task-title-field,.tp-sec,.task-property,.pool-description-editor,.collaboration-composer') ?? document.querySelector('.modal form') ?? document.querySelector('.pool-description-editor form') ?? document.querySelector('.task-page') ?? document.querySelector('.content');

/** Conflict prompts waiting for an answer. @type {Set<{check:()=>boolean,cancel:()=>void}>} */
const openPrompts = new Set();
/** Put prompts that a redraw removed back beside their redrawn fields at once, before the page restores focus. */
export function keepConflictPrompts() { for (const prompt of [...openPrompts]) prompt.check(); }

/**
 * Ask whether to use the latest saved value or keep the person's change. A
 * redraw of the page, such as a live update, replaces the field: the prompt
 * then moves beside the field `locate` finds, until the person answers. It
 * closes without an answer when the page changes, when the field is gone or
 * can no longer be edited, or when a newer prompt replaces it.
 * @param {{target:Element|null,locate?:()=>Element|null,latestValue:unknown,myValue:unknown,snapshot?:unknown,isCurrent?:()=>boolean,updateTarget?:boolean}} input
 */
export function presentDomConflict({target,locate=()=>null,latestValue,myValue,isCurrent=()=>true,updateTarget=true}) {
  return new Promise((resolve)=>{
    if(!isCurrent()){resolve('cancelled');return;}
    for(const prompt of [...openPrompts])prompt.cancel();
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
    const parent=promptHost(target);
    parent?.append(box);
    if(!parent){resolve('cancelled');return;}
    let field=target,answered=false;
    const check=()=>{
      if(!isCurrent()){box.remove();finish('cancelled');return false;}
      if(box.isConnected)return true;
      // After Keep my changes, it shows the save until a redraw removes it.
      if(answered){finish('cancelled');return false;}
      const next=locate();
      if(!next?.isConnected||'disabled' in next&&next.disabled||'readOnly' in next&&next.readOnly){finish('cancelled');return false;}
      field=next;promptHost(next)?.append(box);
      return true;
    };
    const prompt={check,cancel:()=>{box.remove();finish('cancelled');}};
    const observer=new document.defaultView.MutationObserver(check);
    const finish=(choice)=>{answered=true;if(choice!=='mine'){observer.disconnect();document.removeEventListener('input',check);openPrompts.delete(prompt);}resolve(choice);};
    openPrompts.add(prompt);
    observer.observe(document.body,{childList:true,subtree:true});
    document.addEventListener('input',check);
    latest.addEventListener('click',()=>{if(!check())return;if(updateTarget&&latestValue!==undefined&&field&&'value' in field){field.value=latestValue==null?'':String(latestValue);field.dispatchEvent(new Event('input',{bubbles:true}));}box.remove();finish('latest');},{once:true});
    mine.addEventListener('click',()=>{if(!check())return;if(updateTarget&&myValue!==undefined&&field&&'value' in field)field.value=myValue==null?'':String(myValue);mine.disabled=true;latest.disabled=true;message.textContent='Saving your changes…';finish('mine');},{once:true});
  });
}

/**
 * Production recovery state. It observes transport outcomes but never retries a
 * write. Reconciliation is read-only and preserves the currently open editor.
 */
/** @typedef {{data:any,api:any,gateway:any,getApp?:()=>any,getAuth?:()=>any,reload?:(scope?:Record<string,unknown>)=>Promise<any>,presentConflict?:(input:{target:Element|null,locate?:()=>Element|null,latestValue:unknown,myValue:unknown,snapshot?:unknown,isCurrent?:()=>boolean,updateTarget?:boolean})=>Promise<string>,checkBuild?:()=>unknown,setTimer?:Function,clearTimer?:Function,random?:()=>number,online?:()=>boolean,now?:()=>number,windowObject?:Window|null,documentObject?:Document|null}} RecoveryOptions */
/** @param {RecoveryOptions} options */
export function createRecoveryController({
  data, api, gateway, getApp = () => null, getAuth = () => null,
  reload = async (_scope={}) => ({}),
  presentConflict = presentDomConflict,
  checkBuild = () => {},
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
  random = Math.random,
  online = () => globalThis.navigator?.onLine !== false,
  now = () => Date.now(),
  windowObject = globalThis.window,
  documentObject = globalThis.document,
}) {
  let hooks=null,pageError=null,pageReference=null,expired=false;
  // What the person was typing when their session ended, kept in memory for their next sign-in.
  /** @type {{userId:string,hash:string,editor:ReturnType<typeof captureOpenEditor>,comment:any}|null} */
  let resume=null;
  let apiReachable=online(),liveReachable=true,reconnectAttempt=0,reconnectTimer=null,liveAttempt=0,liveTimer=null,reconcilePromise=null,accessTimer=null;
  let bound=false,disposed=false;
  let sessionGeneration=0,connectivityGeneration=0,reconnectGeneration=0;
  let routeLoadingTimer=null,routeLoadingGeneration=0;
  const pendingEditors=new Map();
  const pendingSaves=new Map();
  let refreshFailureScope=null,updatedBuild=false;
  /** @type {Set<()=>void>} */ const onlineListeners=new Set();
  // What each autosaved field last saved: when it lost focus, or when a key such as Enter saved it.
  /** @type {WeakMap<Element,string>} */ const committed=new WeakMap();
  /** @type {Set<()=>boolean>} */ const unsavedChecks=new Set();
  let writes=0;
  /** @type {{version:string,revision:string}|null} */ let newBuild=null;
  let autoReloaded=false,autoReloadTimer=null,hiddenCheckTimer=null,lastActivity=now();

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

  /** @param {any} target a field, or anything else an event targets */
  function rememberCommitted(target){
    if(target?.matches?.(AUTOSAVE)&&typeof target.value==='string')committed.set(target,target.value);
  }

  /**
   * Whether leaving now would lose text the person typed. Another page of
   * oneloop loses only what open editors and the comment box hold; drafts and
   * running saves carry on. Leaving oneloop (`leaving`) also loses drafts not
   * saved yet, saves and uploads still running, and text kept for the next
   * sign-in.
   */
  function hasUnsavedInput({leaving=true}={}){
    // The comment box keeps its text across redraws, so it answers for itself.
    if(documentObject&&hasTypedInput(documentObject,committed,(element)=>element.id==='cmtIn'))return true;
    // A comment being sent is on its way; it counts again if the send fails.
    const comment=getApp()?.commentDraft?.();
    if(comment&&!comment.sending)return true;
    return leaving&&(!!resume||writes>0||!!gateway?.hasPending?.()||[...unsavedChecks].some((check)=>check()));
  }

  function warnBeforeUnload(event){
    if(!hasUnsavedInput())return;
    // The browser shows its own prompt; returnValue is for older browsers.
    event.preventDefault();event.returnValue=true;
  }

  /** Browser storage, which privacy settings can turn off. @param {'localStorage'|'sessionStorage'} kind */
  function storage(kind){try{return windowObject?.[kind]??null;}catch{return null;}}
  function autoReloadOn(){try{return storage('localStorage')?.getItem(AUTO_RELOAD)==='on';}catch{return false;}}
  /** @returns {string[]} */
  function reloadedFor(){try{const list=JSON.parse(storage('sessionStorage')?.getItem(RELOADED_FOR)??'[]');return Array.isArray(list)?list:[];}catch{return [];}}
  const noteActivity=()=>{lastActivity=now();};

  /**
   * After an update, a browser with Reload after updates on reloads at the
   * first moment nothing would be lost: no unsaved input, and the tab is
   * hidden or the person has been idle for a minute. Until then it checks
   * again every 30 seconds, when the tab hides and when a save settles. A tab
   * reloads by itself once per page load and once per version, so servers
   * that disagree about the version can't make it loop.
   */
  /**
   * A hidden tab closes its live connection, whose opening is when a page
   * compares its version with the server's. So with Reload after updates on,
   * a hidden tab asks the server every minute instead, until it learns of an
   * update.
   */
  function scheduleHiddenCheck(){
    clearTimer(hiddenCheckTimer);hiddenCheckTimer=null;
    const checking=()=>!disposed&&!updatedBuild&&autoReloadOn()&&documentObject?.visibilityState==='hidden';
    if(!checking())return;
    hiddenCheckTimer=setTimer(()=>{
      hiddenCheckTimer=null;
      if(checking())Promise.resolve().then(checkBuild).catch(()=>{}).finally(scheduleHiddenCheck);
    },HIDDEN_BUILD_CHECK_MS);
  }

  /** Another tab of this browser changed Reload after updates, or cleared storage. @param {{key:string|null}} event */
  function storageChanged(event){
    if(event.key!==AUTO_RELOAD&&event.key!==null)return;
    scheduleHiddenCheck();reloadWhenSafe();getApp()?.autoReloadChanged?.();
  }

  /** A tab that shows again counts as activity, so a person who comes back is never reloaded at once. */
  function visibilityChanged(){
    if(documentObject?.visibilityState!=='hidden')noteActivity();
    scheduleHiddenCheck();reloadWhenSafe();
  }

  function reloadWhenSafe(){
    clearTimer(autoReloadTimer);autoReloadTimer=null;
    if(disposed||!updatedBuild||autoReloaded||!autoReloadOn())return;
    const version=newBuild?`${newBuild.version}+${newBuild.revision}`:'';
    if(reloadedFor().includes(version))return;
    const away=documentObject?.visibilityState==='hidden'||now()-lastActivity>=IDLE_BEFORE_RELOAD_MS;
    if(!away||hasUnsavedInput()){autoReloadTimer=setTimer(reloadWhenSafe,AUTO_RELOAD_CHECK_MS);return;}
    autoReloaded=true;
    try{storage('sessionStorage')?.setItem(RELOADED_FOR,JSON.stringify([...reloadedFor(),version].slice(-10)));}catch{}
    controller.reloadClient();
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
    const restored=apiReachable&&previous==='offline';
    const next=visibleConnection();if(previous===next)return;
    updateNotice();
    if(next==='live'&&previous==='offline')getApp()?.toast?.('Connection restored','info');
    if(restored)for(const listener of [...onlineListeners])queueMicrotask(listener);
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
    return state?`<div class="connection-notice"><span>${state.text}</span><button class="btn quiet" data-action="Recovery.activateNotice">${state.label}</button></div>`:'';
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
      pendingEditors.delete(key);reloadWhenSafe();return;
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
      const answer=await api.request('/api/auth/me',{background:true});
      if(disposed||attempt!==reconnectGeneration||!currentSession(context)||!online())return;
      // The shared response observer may already have restored the connection.
      if(!currentConnection(context))return;
      reconnectAttempt=0;setConnectivity(true);
      if(ownsAnswer(answer?.user?.id))await reconcile();
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

  /**
   * The server answered for `userId`, the person the browser's session cookie
   * names. Tabs share that cookie, so it changes when someone signs in in
   * another tab. Whether the answer is for the person this tab shows: when it
   * names someone else, this person's session has ended here, as after a 401,
   * and nothing of the new person's comes into the tab. A tab where no one is
   * signed in owns no answer.
   * @param {unknown} userId
   */
  function ownsAnswer(userId){
    if(!data?.session)return false;
    if(typeof userId!=='string'||!userId||userId===data.session.userId)return true;
    sessionExpired();return false;
  }

  function sessionExpired() {
    if(expired||!data?.session)return false;
    // The comment composer keeps its own draft, with its reply target and mentions.
    const editor=documentObject?captureOpenEditor(documentObject,{changedOnly:true,skip:(element)=>element.id==='cmtIn'}):null,comment=getApp()?.commentDraft?.()??null;
    resume=editor||comment?{userId:data.session.userId,hash:windowObject?.location?.hash??'',editor,comment}:null;
    expired=true;sessionGeneration++;reconnectGeneration++;gateway?.invalidate?.();getAuth()?.expire?.();return true;
  }

  /**
   * After the same person signs in again, put back what they typed once the
   * page they left shows its editor. Another person, or another page, drops it.
   */
  function resumeEditing() {
    const next=resume;if(!next||!data?.session||data.session.temporary)return false;
    if(data.session.userId!==next.userId||(windowObject?.location?.hash??'')!==next.hash){resume=null;return false;}
    if(next.editor&&![...documentObject?.querySelectorAll?.(EDITOR_ROOT)??[]].some((candidate)=>next.editor.rootClass.every((name)=>candidate.classList.contains(name))))return false;
    resume=null;
    if(next.comment)getApp()?.restoreCommentDraft?.(next.comment);
    if(next.editor&&documentObject)restoreOpenEditor(next.editor,documentObject,{notify:true});
    return true;
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
    const field=target?.element?.()??restored;
    const chosen=await presentConflict({target:field,locate:target?.element??relocator(field),latestValue,myValue:myValue??target?.myValue,snapshot,isCurrent:current,updateTarget:!target?.acceptLatest});
    if(chosen==='cancelled'||!current())return {handled:true,saved:false};
    if(chosen!=='mine'){
      await reloadLatest();
      if(!current())return {handled:true,saved:false};
      const latest=latestEntity();
      if(latest)target?.acceptLatest?.(latest);
      return {handled:true,saved:false,latest,choice:'latest'};
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
    return `<section class="page-error"><span class="error-code">${escapeHtml(code)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p><div class="error-actions">${['500','503'].includes(code)?'<button class="btn primary" data-action="Recovery.retryLoad">Retry</button>':''}<button class="btn quiet" data-action="nav" data-args='["board"]'>Back to Board</button>${pageReference?'<button class="btn quiet" data-action="Recovery.copyReference">Copy error reference</button>':''}</div></section>`;
  }

  const controller={
    get pageError(){return pageError;},get pageReference(){return pageReference;},get connection(){return visibleConnection();},get expired(){return expired;},scenario:'',
    /**
     * Whether typed text waits for the person's next sign-in: what an editor
     * held when the session ended, or, while no one is signed in, anything
     * else kept for them, such as a draft or a comment that wasn't saved.
     */
    get keepsInput(){return !!resume||!data?.session&&[...unsavedChecks].some((check)=>check());},
    resumeEditing,
    requestContext,isRevisionConflict,observeResponse,handleRouteError,handleCommandFailure,resolveConflict,sessionExpired,ownsAnswer,
    errorHtml,
    captureEditor:()=>documentObject?captureOpenEditor(documentObject):null,
    keepPrompts:keepConflictPrompts,
    restoreEditor:(snapshot)=>snapshot&&documentObject?restoreOpenEditor(snapshot,documentObject):null,
    revisionKey:entityKey,expectedRevision,finishRevision,
    interactionPending,refreshFailed,refreshSucceeded,isSavingTask:()=>pendingSaves.size>0,
    sessionActive:(session)=>session?.revokedAt==null,
    enforceSession:()=>false,
    ensureOnline(){if(connection()!=='offline')return true;getApp()?.toast?.('Reconnect before making this change.','error');return false;},
    connectionHtml,
    activateNotice,
    /** Run `listener` each time saving works again after the connection was lost. */
    whenOnline(listener){onlineListeners.add(listener);return ()=>onlineListeners.delete(listener);},
    hasUnsavedInput,
    /** A field that saves itself saved its value without losing focus, such as a date saved with Enter. @param {Element} element */
    markSaved(element){rememberCommitted(element);},
    /** Whether one editor, such as a dialog, holds text the person typed. @param {Element} root */
    hasTypedInputIn(root){return !!documentObject&&hasTypedInput(documentObject,committed,()=>false,[root]);},
    /** Count what `check` reports, such as drafts not saved yet, when someone leaves oneloop. */
    trackUnsaved(check){unsavedChecks.add(check);return ()=>unsavedChecks.delete(check);},
    /** Count a save or upload that is not a command until it settles. */
    trackWrite(promise){writes++;Promise.resolve(promise).catch(()=>{}).finally(()=>{writes--;});return promise;},
    /** The server runs another version than this page; `build` is that version. */
    buildChanged(build){updatedBuild=true;newBuild=build??null;updateNotice();reloadWhenSafe();},
    /** Whether this browser reloads by itself after an update. */
    get autoReload(){return autoReloadOn();},
    setAutoReload(on){try{if(on)storage('localStorage')?.setItem(AUTO_RELOAD,'on');else storage('localStorage')?.removeItem(AUTO_RELOAD);}catch{}scheduleHiddenCheck();reloadWhenSafe();},
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
    bind(nextApp,nextHooks){hooks=nextHooks;if(!bound){bound=true;scheduleAccessProbe();documentObject?.addEventListener?.('focusin',rememberEditorRevision,true);documentObject?.addEventListener?.('focusout',(event)=>rememberCommitted(event.target),true);windowObject?.addEventListener?.('beforeunload',warnBeforeUnload);for(const type of ['pointerdown','pointermove','keydown','wheel','touchstart'])documentObject?.addEventListener?.(type,noteActivity,{capture:true,passive:true});documentObject?.addEventListener?.('visibilitychange',visibilityChanged);windowObject?.addEventListener?.('storage',storageChanged);scheduleHiddenCheck();windowObject?.addEventListener?.('offline',()=>{connectivityGeneration++;reconnectGeneration++;setConnectivity(false);scheduleReconnect();});windowObject?.addEventListener?.('online',()=>reconnect(true));}return controller;},
    sessionChanged(session){cancelRouteLoading();clearPendingSaves();refreshFailureScope=null;sessionGeneration++;reconnectGeneration++;clearTimer(reconnectTimer);if(session){if(resume&&resume.userId!==session.userId)resume=null;expired=false;pageError=null;pageReference=null;setConnectivity(online(),liveReachable);scheduleAccessProbe();}else{pendingEditors.clear();clearTimer(accessTimer);}},
    dispose(){disposed=true;resume=null;cancelRouteLoading();clearPendingSaves();pendingEditors.clear();unsavedChecks.clear();windowObject?.removeEventListener?.('beforeunload',warnBeforeUnload);windowObject?.removeEventListener?.('storage',storageChanged);clearTimer(autoReloadTimer);clearTimer(hiddenCheckTimer);clearTimer(reconnectTimer);clearTimer(liveTimer);clearTimer(accessTimer);},
  };
  return Object.freeze(controller);
}

/**
 * Leave an admin page or dialog after an authoritative refresh shows that the
 * person is no longer an admin, and say why. Nothing typed there can be saved
 * any more, so this never asks first.
 * @param {any} data @param {any} app @param {any} previous the page and dialog shown before the refresh
 */
export function leaveAdminPage(data, app, previous) {
  const person = data.users?.find((user) => user.id === data.session?.userId);
  if (!person || person.admin) return false;
  const page = ['users','storage','settings'].includes(previous?.view), dialog = ['user','project','knowledge','temppw'].includes(previous?.modal?.type);
  if (!page && !dialog) return false;
  if (dialog) app.closeOverlays?.();
  if (page) app.nav('board', { discard: true });
  app.toast?.('You no longer have admin access.', 'info');
  return true;
}

/** Leave an inaccessible project after an authoritative metadata refresh, and say why.
 * @param {any} data @param {any} app @param {any} previous @param {string} [name] the project's name before the refresh
 */
export function leaveUnavailableProject(data, app, previous, name) {
  if (!previous?.projectId || !['roadmap','board','task'].includes(previous.view)
      || data.projects.some((project) => project.id === previous.projectId)) return false;
  if(data.projects.length)app.selectProject(data.projects[0].id);
  // Nothing typed there can be saved any more, so this never asks first.
  app.nav('board',{discard:true});
  app.toast?.(name?`You no longer have access to ${name}.`:'You no longer have access to that project.','info');
  return true;
}
