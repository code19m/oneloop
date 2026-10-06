// @ts-check

import { ApiError } from '../data/api-client.js';
import { mergeAdminUsersPage, wireStatus } from '../data/projection-store.js';
import { saveDoneOrder } from '../data/done-order.js';
import {
  actionErrorFeedback,
  commandInteractionKey,
  commandIsUnchanged,
  formFieldName,
  isServerNoChange,
  validDate,
} from './action-feedback.js';
import { sessionBrowserLabel, sessionDeviceLabel } from '../auth/session-label.js';
import { presentFormError, isFormRetryPending, completeForm } from './form-feedback.js';

/** The server's username order: SQLite's binary collation, not the browser's locale. */
const compareUsernames = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
/** Cut at `max` UTF-16 units, as maxlength does, without splitting a surrogate pair. */
const text = (value, max) => {
  const cut = String(value ?? '').trim().slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/** @param {{app:import('../data/contracts.js').LegacyApp,data:import('../data/contracts.js').LegacyData,gateway:import('../data/contracts.js').CommandGateway,api:import('../data/contracts.js').ApiClient,auth:any,reads:any,recovery:any,reloadBootstrap:Function}} options */
export function installViewBridge({ app, data, gateway, auth, api, reads, recovery, reloadBootstrap }) {
  const task = (id) => data.tasks.find((item) => item.id === id || item.internalId === id);
  const epic = (id) => data.epics.find((item) => item.id === id);
  const track = (id) => data.tracks.find((item) => item.id === id);
  const milestone = (id) => data.milestones.find((item) => item.id === id);
  const poolItem = (id) => data.pool.find((item) => item.id === id);
  const context = () => app.context();
  const sessionScope=()=>`${data.session?.id??''}:${data.session?.userId??''}`;
  let usersAfter=null,usersDepth=1;
  const assigneeSaves=new Map();
  const pendingTaskForms = new WeakSet();
  let promotionSource=null;
  const pendingPoolCaptures = new WeakSet();
  let projectGeneration = 0;
  let usersGeneration=0,profileGeneration=0,routeGeneration=0,profileNameGeneration=0,avatarGeneration=0;
  let usersController=null,profileController=null;
  /** @type {Promise<unknown>} */ let profileNameQueue=Promise.resolve();
  /** @type {Promise<unknown>} */ let avatarQueue=Promise.resolve();
  let profileNameQueueScope='',avatarQueueScope='';
  const openPeek=app.openPeek.bind(app);
  const moveTaskOrder=app.moveTaskOrder.bind(app);
  const nav=app.nav.bind(app);

  function fieldError(form,name,message){
    if(form&&typeof form.querySelector==='function'&&form.querySelector(`[name="${name}"]`)){
      app.fieldError?.(form,name,message);return false;
    }
    app.toast(message,'error');return false;
  }

  function validOptionalDate(form,name,value){
    return !value||validDate(value)||fieldError(form,name,'Enter a valid date in YYYY-MM-DD format.');
  }

  function skipped(){return {entities:[],events:[],replayed:false,skipped:true};}
  function stale(result={}){return {...result,stale:true};}
  function ifCurrent(result,effect){return result?.stale?result:effect(result);}
  function noteTaskSaved(result,id){const item=task(id);if(!result?.stale&&!result?.skipped&&!recovery?.isSavingTask?.()&&!(item&&(taskBusy(item.internalId)||unsavedDraft(item.internalId))))app.noteTaskSaved?.(id);return result;}
  const sameAssignees=(left,right)=>left.length===right.length&&left.every((id)=>right.includes(id));

  function saveAssignees(item,assigneeIds){
    const id=item.internalId,scope=sessionScope(),key=`${scope}:${id}`,desired=[...new Set(assigneeIds.map(String))];
    let state=assigneeSaves.get(key);
    if(!state){state={desired,persisted:[...(item.assignees??[])],running:false,promise:null};assigneeSaves.set(key,state);}
    state.desired=desired;item.assignees=[...desired];
    if(state.running)return state.promise;
    state.running=true;
    state.promise=(async()=>{
      let changed=false;
      try{
        while(!sameAssignees(state.persisted,state.desired)){
          const target=[...state.desired],current=task(id);if(sessionScope()!==scope||!current)break;
          const comparison={...current,assignees:[...state.persisted]};
          const result=await execute('task.update',{taskId:id,assigneeIds:target},current,null,{compareEntity:comparison,paint:false});
          if(result?.stale)break;
          changed ||= !result?.skipped;state.persisted=target;
          if(task(id))task(id).assignees=[...state.desired];
        }
        if(changed&&sessionScope()===scope&&sameAssignees(state.persisted,state.desired))noteTaskSaved({},task(id)?.id??item.id);
      }catch(error){
        if(sessionScope()===scope){
          let restored=false;
          try{restored=!(await reads.task(id))?.stale;}catch{}
          if(sessionScope()===scope&&!restored){const current=task(id);if(current){current.assignees=[...state.persisted];app.refresh();}}
        }
        throw error;
      }finally{state.running=false;if(assigneeSaves.get(key)===state)assigneeSaves.delete(key);}
    })();
    return state.promise;
  }

  function latestEntity(operation,payload,original){
    if(operation.startsWith('task.block'))return data.tasks.find((item)=>item.block?.id===payload.blockId)?.block??task(payload.taskId??original?.internalId);
    if(operation.startsWith('task.'))return task(payload.taskId??payload.id??original?.internalId);
    if(operation.startsWith('epic.'))return epic(payload.epicId??payload.id??original?.id);
    if(operation.startsWith('track.'))return track(payload.trackId??payload.id??original?.id);
    if(operation.startsWith('milestone.'))return milestone(payload.milestoneId??payload.id??original?.id);
    if(operation.startsWith('pool.'))return poolItem(payload.poolItemId??payload.id??original?.id);
    if(operation.startsWith('project.'))return data.projects.find((item)=>item.id===(payload.projectId??original?.id));
    if(operation.startsWith('membership.'))return data.projects.find((item)=>item.id===payload.projectId)?.members.find((item)=>item.userId===payload.userId);
    return original;
  }

  async function reloadConflict(operation,payload,original,options){
    if(operation.startsWith('task.')){const item=task(payload.taskId??payload.id??original?.internalId??original?.id);if(item)await reads.task(item.internalId);return;}
    if(operation.startsWith('pool.')){await reads.pool(context().projectId,options.poolScope??(original?.scope==='project'?'team':'personal'));return;}
    if(/^(?:epic|track|milestone)\./.test(operation)){const projectId=original?.projectId??context().projectId;if(projectId)await reads.roadmap(projectId);return;}
    await reloadBootstrap({projectId:context().projectId});app.refresh();
  }

  /** The one field a save changes, or null when it changes several. */
  function conflictField(payload){
    const ignored=new Set(['taskId','epicId','trackId','milestoneId','poolItemId','blockId','projectId','userId','id','mentions']);
    const keys=Object.keys(payload).filter((key)=>!ignored.has(key));
    return keys.length===1?keys[0]:null;
  }

  function conflictValue(operation,payload,item){
    const field=conflictField(payload);
    const aliases={description:'desc',startDate:'start',endDate:'end',milestoneDate:'date',taskPrefix:'key',status:'state',assigneeIds:'assignees'};
    if(!field)return undefined;
    if(item===payload)return payload[field];
    return item?.[aliases[field]??field];
  }

  /** The control of a dialog's field, in the dialog as it is drawn now. */
  function dialogControl(form,field){
    const live=form?.isConnected?form:globalThis.document?.querySelector?.('.modal form');
    return live?.querySelector?.(`[name="${formFieldName(field)}"]`)??null;
  }

  function report(error, options = {}) {
    if(error?.oneloopReported||error?.code==='reauth_cancelled'||error?.status===401)return;
    const feedback=actionErrorFeedback(error);
    if(feedback.silent)return;
    const message = error instanceof ApiError && error.uncertain
      ? 'The save result is unknown. Try the same action again to reconcile it safely.'
      : error instanceof ApiError && (error.code === 'revision_conflict'||(error.status===409&&/record changed/i.test(error.message)))
      ? 'This item changed elsewhere. Review the latest version before saving again.'
      : feedback.message;
    if(presentFormError(options.form,error,app,{message}))return;
    const field=feedback.field&&formFieldName(feedback.field);
    if(field&&options.form&&typeof options.form.querySelector==='function'&&options.form.querySelector(`[name="${field}"]`)){
      app.fieldError?.(options.form,field,message);return;
    }
    app.toast(message, 'error');
  }

  const reportFor=(scope,options={},current=()=>true)=>(error)=>{if(sessionScope()===scope&&current())report(error,options);};

  // A task field save repaints in the background, so it never replaces the
  // field being edited. Other changes paint at once, or, under a dialog opened
  // while they ran, when that dialog closes.
  function paintCommand(operation){
    if(context().view==='board'&&/^task\./.test(operation))app.refreshBoard();
    else if(operation==='task.update'||operation==='task.move')(app.refreshBackground??app.refresh)();
    else (app.refreshAfterDialog??app.refresh)();
  }

  // Saves of one record run one at a time, and each builds on the revision the
  // previous save was acknowledged at. Two fields saved close together never
  // conflict with each other, while a change made by someone else still does.
  // A newer value of an autosaved field replaces its queued value.
  /** @type {Map<string,{jobs:Map<string,any>,active:boolean,running:Promise<void>|null}>} */
  const records=new Map();
  /** Revisions this browser moved a record to, by the revision each save was based on. */
  /** @type {Map<string,Map<number,number>>} */
  const acknowledged=new Map();
  // A task field value that is not saved yet. The task page shows it instead of
  // the saved value, so a refresh never replaces what the person typed, and
  // offers Save when the save failed.
  /** @type {Map<string,{taskId:string,field:string,value:string,base:number|undefined,scope:string,unsaved:boolean,retryOnline:boolean}>} */
  const drafts=new Map();
  let jobSequence=0;
  const RECORD_FIELDS={task:'taskId',epic:'epicId',track:'trackId',milestone:'milestoneId',pool:'poolItemId',project:'projectId'};
  function recordOf(operation,payload){
    if(operation.startsWith('task.block.'))return payload.blockId?`taskBlock:${payload.blockId}`:null;
    const type=operation.split('.')[0];
    if(type==='membership')return payload.projectId&&payload.userId?`membership:${payload.projectId}:${payload.userId}`:null;
    const id=payload[RECORD_FIELDS[type]]??payload.id;
    return id?`${type}:${id}`:null;
  }
  // Drafts belong to one person: they survive the end of a session and come
  // back when the same person signs in again; anyone else never sees them.
  const draftKey=(taskId,field)=>`${data.session?.userId??''}|${taskId}|${field}`;
  function pruneDrafts(){if(!data.session)return;const scope=`${data.session.userId}|`;for(const key of drafts.keys())if(!key.startsWith(scope))drafts.delete(key);}
  /** Forget the drafts of a task the person deleted: they can't be saved, and Undo brings back the saved task. */
  function dropDrafts(taskId){for(const [key,draft] of drafts)if(draft.taskId===taskId)drafts.delete(key);}
  // A save the end of a session cut off leaves its draft Not saved.
  function unsaved(draft){if(draft&&sessionScope()!==draft.scope)draft.unsaved=true;}
  const taskBusy=(taskId)=>{const queue=records.get(`${sessionScope()}|task:${taskId}`);return !!queue&&(queue.active||queue.jobs.size>0);};
  const unsavedDraft=(taskId)=>[...drafts.values()].some(draft=>draft.taskId===taskId&&draft.unsaved&&drafts.get(draftKey(taskId,draft.field))===draft);
  function paintDrafts(taskId){const item=task(taskId);if(item)app.refreshTaskDrafts?.(item.id);}

  function enqueue(record,operation,payload,entity,message,options){
    const scope=sessionScope(),key=`${scope}|${record}`;
    let queue=records.get(key);
    if(!queue){queue={jobs:new Map(),active:false,running:null};records.set(key,queue);}
    const jobKey=options.coalesce?commandInteractionKey(operation,payload,entity):`job:${++jobSequence}`;
    const replaced=queue.jobs.get(jobKey);
    // The base is the revision the person saw when they made this change.
    const base=options.expectedRevision??recovery?.expectedRevision?.(recovery?.revisionKey?.(entity),entity?.revision)??entity?.revision;
    const job={jobKey,operation,payload,entity,message,options,base,waiters:replaced?.waiters??[],carry:replaced?.carry??null};
    const done=new Promise((resolve,reject)=>job.waiters.push({resolve,reject}));
    queue.jobs.set(jobKey,job);
    queue.running??=drain(queue,key,scope);
    return done;
  }

  async function drain(queue,key,scope){
    let chain=acknowledged.get(key);if(!chain){chain=new Map();acknowledged.set(key,chain);}
    try{
      while(queue.jobs.size){
        const [jobKey,job]=queue.jobs.entries().next().value;queue.jobs.delete(jobKey);
        const draft=job.options.draft?drafts.get(job.options.draft):null;
        if(sessionScope()!==scope){unsaved(draft);for(const waiter of job.waiters)waiter.resolve(stale());continue;}
        let base=job.base;while(chain.has(base))base=chain.get(base);
        const current=latestEntity(job.operation,job.payload,job.entity)??job.entity;
        queue.active=true;
        try{
          const result=await run(job.operation,job.payload,current,job.options.coalesce?null:job.message,{...job.options,expectedRevision:base,paint:job.options.coalesce?false:job.options.paint});
          queue.active=false;
          const saved=result?.entities?.find(item=>item.id===(current?.internalId??current?.id))?.revision;
          // Keep my changes saved on top of someone else's revision. Only that
          // revision leads to the save, so other fields typed before it still
          // meet the other person's change.
          const from=result?.retriedAt??base;
          if(!result?.stale&&!result?.skipped&&Number.isSafeInteger(from)&&Number.isSafeInteger(saved)&&saved!==from)chain.set(from,saved);
          const carry=!result?.stale&&!result?.skipped?result:job.carry;
          const newer=queue.jobs.get(jobKey);
          // A newer value of this field is still queued: its callers learn the outcome together.
          // After Keep my changes, it builds on the revision the person chose to keep their value over.
          if(newer&&!result?.stale){if(Number.isSafeInteger(result?.retriedAt))newer.base=result.retriedAt;newer.waiters.unshift(...job.waiters);newer.carry=carry;continue;}
          const outcome=result?.stale||!carry?result:carry;
          if(result?.stale)unsaved(draft);
          if(draft&&!result?.stale&&drafts.get(job.options.draft)===draft&&draft.value===job.options.draftValue){drafts.delete(job.options.draft);paintDrafts(draft.taskId);}
          if(job.options.coalesce&&carry&&!outcome?.stale){
            if(job.options.paint!==false&&!carry.refreshError)paintCommand(job.operation);
            if(job.message)app.toast(job.message);
          }
          for(const waiter of job.waiters)waiter.resolve(outcome);
        }catch(error){
          queue.active=false;
          // A newer queued value of the field is not sent after a failure; its draft keeps it.
          const newer=queue.jobs.get(jobKey);if(newer){queue.jobs.delete(jobKey);job.waiters.push(...newer.waiters);}
          const latest=job.options.draft?drafts.get(job.options.draft):null;
          unsaved(latest);
          if(latest&&sessionScope()===scope){
            if(/** @type {any} */(error)?.conflictChoice==='latest')drafts.delete(job.options.draft);
            else Object.assign(latest,{unsaved:true,base:latest.base??job.base,retryOnline:['offline','network_error','timeout'].includes(/** @type {any} */(error)?.code)});
            paintDrafts(latest.taskId);
          }
          for(const waiter of job.waiters)waiter.reject(error);
        }
      }
    }finally{queue.active=false;queue.running=null;if(records.get(key)===queue&&!queue.jobs.size)records.delete(key);}
  }

  /**
   * Save a task field from the task page. A title or description keeps a draft until it is saved.
   * @param {any} item @param {string} field @param {any} value @param {{base?:number}} [options]
   */
  function saveTaskField(item,field,value,{base}={}){
    const form=globalThis.document?.querySelector?.('.task-page');
    if(field==='state')return fire(execute('task.move',{taskId:item.internalId,status:wireStatus(value)},item,null,{reload:true,coalesce:true}).then((result)=>noteTaskSaved(result,item.id)));
    const names={title:'title',desc:'description',deadline:'deadline',epicId:'epicId'};
    if(!names[field])return false;
    const next=field==='deadline'?(value||null):text(value,field==='title'?140:4000);
    if(field==='title'&&!next)return fieldError(form,'title','Enter a task title.');
    if(field==='deadline'&&next&&!validDate(next)){app.toast('Enter a valid deadline in YYYY-MM-DD format.','error');return false;}
    if(field==='epicId'&&!data.epics.some((entry)=>entry.id===next&&entry.projectId===item.projectId&&entry.state!=='done')){app.toast('Choose an open epic. Completed epics must be reopened first.','error');return false;}
    let draft;pruneDrafts();
    if(field==='title'||field==='desc'){
      draft=draftKey(item.internalId,field);
      const previous=drafts.get(draft);
      // The field shows a Not saved draft instead of newer saved text, so text
      // typed over it still builds on the revision the draft was typed on.
      if(previous?.unsaved)base??=previous.base;
      if(next===(field==='title'?item.title:item.desc??'')&&!previous)draft=undefined;
      else{drafts.set(draft,{taskId:item.internalId,field,value:next,base,scope:sessionScope(),unsaved:false,retryOnline:false});if(previous?.unsaved)paintDrafts(item.internalId);}
    }
    return fire(execute('task.update',{taskId:item.internalId,[names[field]]:next},item,null,{form,coalesce:true,expectedRevision:base,draft,draftValue:next,conflictElement:()=>globalThis.document?.querySelector(field==='desc'?'#task-description':field==='title'?'.task-title-field textarea':`[name="${field}"]`)}).then((result)=>noteTaskSaved(result,item.id)));
  }
  function retryDrafts(){
    for(const draft of [...drafts.values()]){
      const item=task(draft.taskId);
      if(item&&draft.unsaved&&draft.retryOnline&&drafts.get(draftKey(draft.taskId,draft.field))===draft)saveTaskField(item,draft.field,draft.value,{base:draft.base});
    }
  }
  recovery?.whenOnline?.(retryDrafts);
  // A draft lives in this tab only, so leaving oneloop before it saves loses it.
  recovery?.trackUnsaved?.(()=>{pruneDrafts();return drafts.size>0;});

  // Another page discards text typed into this one, so ask first. Drafts and
  // saves that are running carry on, so they don't count.
  const losesInput=()=>!!recovery?.hasUnsavedInput?.({leaving:false});
  /** @param {()=>void} leave @param {()=>void} [stay] */
  const askToDiscard=(leave,stay)=>app.askToDiscard(leave,stay);
  /** Resolves whether the page may change. */
  const mayLeavePage=()=>losesInput()?new Promise((resolve)=>askToDiscard(()=>resolve(true),()=>resolve(false))):Promise.resolve(true);
  // A page change someone asks for, from the sidebar, a menu or a back button.
  // One that must happen, such as leaving a project that is gone, passes
  // `discard`; one that follows the person's own change, such as deleting a
  // task, calls `nav` directly. Neither asks.
  app.nav=(view,options)=>{
    if(options?.discard||!losesInput())return nav(view);
    askToDiscard(()=>nav(view));
  };
  globalThis.document?.addEventListener?.('click',(event)=>{
    const link=/** @type {Element|null} */(event.target)?.closest?.('a[href^="#/"]');
    if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||!losesInput())return;
    event.preventDefault();
    askToDiscard(()=>app.followAddress(link.getAttribute('href')));
  },true);

  async function execute(operation, payload, entity, message, options = {}) {
    const record=options.create?null:recordOf(operation,payload);
    if(!record)return run(operation,payload,entity,message,options);
    return enqueue(record,operation,payload,entity,message,options);
  }

  async function run(operation, payload, entity, message, options = {}) {
    if(isFormRetryPending(options.form)){
      const error=new ApiError('Wait before trying again.',{code:'rate_limited'});
      /** @type {any} */(error).oneloopReported=true;
      throw error;
    }
    if(recovery?.ensureOnline&&!recovery.ensureOnline()){
      const error=new ApiError('Reconnect before saving this change.',{code:'offline'});/** @type {any} */(error).oneloopReported=true;throw error;
    }
    const scope=sessionScope(),revisionKey=recovery?.revisionKey?.(entity);
    if(!options.create&&!options.skipNoChange&&commandIsUnchanged(operation,payload,options.compareEntity??entity)){
      recovery?.finishRevision?.(revisionKey);if(options.closeForm)completeForm(options.form,()=>app.closeOverlays());return skipped();
    }
    const interactionKey=options.interactionKey ?? commandInteractionKey(operation,payload,entity);
    const expectedRevision=options.create?undefined:(options.expectedRevision??recovery?.expectedRevision?.(revisionKey,entity?.revision)??entity?.revision);
    let result;
    try {
      result = await gateway.execute(operation, payload, {
        expectedRevision,
        interactionKey,
      });
    } catch (error) {
      if(sessionScope()!==scope){recovery?.finishRevision?.(revisionKey);return stale();}
      if(isServerNoChange(error)){recovery?.finishRevision?.(revisionKey);if(options.closeForm)completeForm(options.form,()=>app.closeOverlays());return skipped();}
      if(recovery?.isRevisionConflict?.(error)&&!options.create){
        // A dialog shows what the person typed until they choose. Use latest
        // shows the saved values in it: in the one field the save changes, or
        // by drawing the dialog again (a Pool promotion fills in the item's
        // text below). Until then, it stays on the revision it was opened at,
        // so saving it again still meets the other change.
        const dialog=!options.coalesce&&!!options.form?.closest?.('.modal'),showsLatest=dialog&&operation!=='pool.promote',field=conflictField(payload);
        try{
          /** @type {number|undefined} */ let retriedAt;
          const resolved=await recovery.resolveConflict({
            error,
            reloadLatest:()=>reloadConflict(operation,payload,entity,options),
            latestEntity:()=>latestEntity(operation,payload,entity),
            retry:(expectedRevision)=>{retriedAt=expectedRevision;if(operation==='pool.promote'&&promotionSource?.id===payload.poolItemId)promotionSource.entity.revision=expectedRevision;return gateway.execute(operation,payload,{expectedRevision,interactionKey});},
            target:{
              element:options.conflictElement??(showsLatest&&field?()=>dialogControl(options.form,field):undefined),
              latestValue:(item)=>conflictValue(operation,payload,item),
              ...(showsLatest&&!field?{acceptLatest:()=>app.redrawDialog?.()}:{}),
            },
            myValue:conflictValue(operation,payload,payload),
            // A task field keeps the person's other fields as they are now; only a
            // dialog is restored, from the moment the conflict came back.
            snapshot:options.coalesce?false:null,
          });
          // Keep my changes saved the change on the latest revision, which the result names.
          if(resolved.saved)result={...resolved.result,retriedAt};
          else{
            if(resolved.choice==='latest'||!dialog)recovery?.finishRevision?.(revisionKey);
            if(operation==='pool.promote'&&resolved.latest&&sessionScope()===scope&&context().modal?.poolId===payload.poolItemId){
              const form=options.form?.isConnected?options.form:globalThis.document?.querySelector('.pool-editor form');
              for(const [name,value] of [['title',resolved.latest.title],['desc',resolved.latest.desc??resolved.latest.description??'']]){
                const input=form?.querySelector(`[name="${name}"]`);if(input){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}
              }
              // Focusing the retained editor records the newly accepted source revision.
              form?.querySelector('[name="title"]')?.focus({preventScroll:true});
            }
            if(error&&typeof error==='object'){error.oneloopReported=true;error.conflictChoice=resolved.choice==='latest'?'latest':'cancelled';}
            // A prompt that closed without a choice (the page changed) still says so; a draft shows it in place.
            if(resolved.choice!=='latest'&&!options.draft&&sessionScope()===scope)app.toast('Your change was not saved. Review the latest version and try again.','error');
            throw error;
          }
        }catch(recoveryError){
          if(sessionScope()!==scope){recovery?.finishRevision?.(revisionKey);return stale();}
          if(recoveryError===error)throw recoveryError;
          await recovery?.handleCommandFailure?.(recoveryError);report(recoveryError);if(recoveryError&&typeof recoveryError==='object')recoveryError.oneloopReported=true;throw recoveryError;
        }
      }else{
        await recovery?.handleCommandFailure?.(error);
        if(options.handleError?.(error)!==true)report(error,options);
        if(error&&typeof error==='object')error.oneloopReported=true;throw error;
      }
    }
    if(result?.stale||sessionScope()!==scope){recovery?.finishRevision?.(revisionKey);return stale(result);}
    // A confirmed write stays successful even when its follow-up read fails.
    if(options.closeForm)completeForm(options.form,()=>app.closeOverlays());
    options.onAccepted?.(result);
    if (message) app.toast(message);
    recovery?.finishRevision?.(revisionKey);
    // The accepted change paints at once; reads that follow repaint their own parts.
    if(!options.reload&&options.paint!==false)paintCommand(operation);
    const refreshContext={...context()};
    try {
      if (options.reload) {
        const loaded=await reloadBootstrap();if(loaded?.stale)return stale(result);
        const current=context();
        if(data.projects.some((item)=>item.id===current.projectId)){
          const projected=current.view==='board'?await reads.board(current.projectId,current.board):null;
          if(projected?.stale)return stale(result);
        }
      } else if(/^task\.(?:block|unblock)/.test(operation)&&data.projects.some((item)=>item.id===context().projectId)){
        if((await reads.counts(context().projectId))?.stale)return stale(result);
      }
      if(options.poolScope&&(await reads.pool(context().projectId,options.poolScope))?.stale)return stale(result);
      if(sessionScope()!==scope){recovery?.finishRevision?.(revisionKey);return stale(result);}
      if(options.reload&&options.paint!==false)paintCommand(operation);
      return result;
    } catch (error) {
      if(sessionScope()!==scope)return stale(result);
      const current=context();
      if(current.view===refreshContext.view&&current.projectId===refreshContext.projectId&&current.taskId===refreshContext.taskId){
        if(recovery?.refreshFailed)recovery.refreshFailed(error);
        else app.toast('Saved, but the view could not refresh. Try refreshing again.','error');
      }
      return {...result,refreshError:error};
    }
  }

  function fire(promise) { promise.catch(() => {}); return false; }
  function formValues(event) { event?.preventDefault?.(); return new FormData(event.target); }

  app.login = (event) => {
    const fields=formValues(event), form=event.target;
    return fire(auth.login({username:text(fields.get('username'),32).toLowerCase(),password:String(fields.get('password')||'')},form));
  };
  app.logout = () => app.confirm({title:'Sign out?',text:app.signOutText(),action:'Sign out',confirm:()=>fire(auth.logout().catch(report))});
  app.setPassword = (event) => { event.preventDefault();if(recovery?.ensureOnline&&!recovery.ensureOnline())return false; return fire(auth.setTemporaryPassword(event.target).catch(error=>report(error,{form:event.target}))); };
  app.changePassword = (event) => { event.preventDefault();if(recovery?.ensureOnline&&!recovery.ensureOnline())return false; return fire(auth.changePassword(event.target).then((/** @type {boolean|undefined} */ ok)=>{if(ok)app.toast('Password changed. Other sessions and app access revoked');}).catch(error=>report(error,{form:event.target}))); };
  app.updMe = (value) => {
    const displayName=text(value,80),form=globalThis.document?.querySelector?.('.settings');if(!displayName)return fieldError(form,'name','Enter your full name.');
    const me=data.users.find((item)=>item.id===data.session?.userId);if(me?.name===displayName)return false;if(recovery?.ensureOnline&&!recovery.ensureOnline())return false;
    const scope=sessionScope(),generation=++profileNameGeneration;
    if(profileNameQueueScope!==scope){profileNameQueueScope=scope;profileNameQueue=Promise.resolve();}
    const request=profileNameQueue.catch(()=>{}).then(async()=>{
      if(sessionScope()!==scope)return stale();
      const response=await api.updateProfile(displayName);
      if(sessionScope()!==scope||generation!==profileNameGeneration||!data.users.includes(me))return stale();
      me.name=response.user.displayName;me.avatar=response.user.avatarUrl??me.avatar;
      if(context().view==='profile'){app.refresh();app.toast('Profile saved');}
      return response;
    });
    profileNameQueue=request;recovery?.trackWrite?.(request);return fire(request.catch(reportFor(scope,{form},()=>generation===profileNameGeneration)));
  };
  app.setAvatar=(input)=>{
    const file=input.files?.[0],me=data.users.find((item)=>item.id===data.session?.userId);if(!file||!me)return;
    const scope=sessionScope(),generation=++avatarGeneration;
    if(avatarQueueScope!==scope){avatarQueueScope=scope;avatarQueue=Promise.resolve();}
    const request=avatarQueue.catch(()=>{}).then(async()=>{
      if(sessionScope()!==scope)return stale();
      const response=await api.uploadAvatar(file);
      if(sessionScope()!==scope||generation!==avatarGeneration||!data.users.includes(me))return stale();
      me.avatar=response.avatarUrl;if(context().view==='profile'){app.refresh();app.toast('Avatar updated');}return response;
    });
    avatarQueue=request;recovery?.trackWrite?.(request);return fire(request.catch(reportFor(scope,{},()=>generation===avatarGeneration)));
  };
  app.removeAvatar=()=>{
    const me=data.users.find((item)=>item.id===data.session?.userId);if(!me)return false;
    return app.confirm({title:'Remove avatar?',text:'Your account will use its default avatar.',action:'Remove avatar',confirm:()=>{
      const scope=sessionScope(),generation=++avatarGeneration;
      if(avatarQueueScope!==scope){avatarQueueScope=scope;avatarQueue=Promise.resolve();}
      const request=avatarQueue.catch(()=>{}).then(async()=>{
        if(sessionScope()!==scope)return stale();await api.removeAvatar();
        if(sessionScope()!==scope||generation!==avatarGeneration||!data.users.includes(me))return stale();
        me.avatar=null;if(context().view==='profile'){app.refresh();app.toast('Avatar removed');}return {};
      });
      avatarQueue=request;recovery?.trackWrite?.(request);return fire(request.catch(reportFor(scope,{},()=>generation===avatarGeneration)));
    }});
  };
  app.revokeSession = (id) => app.confirm({title:'Revoke session?',text:'This browser will need to sign in again.',action:'Revoke session',confirm:()=>fire(auth.revokeSession(id).then(()=>loadProfileAccess()).catch(report))});
  app.revokeOtherSessions = () => app.confirm({title:'Sign out other sessions?',text:'All other browser sessions will end.',action:'Sign out other sessions',confirm:()=>fire(auth.revokeOtherSessions().then(()=>loadProfileAccess()).catch(report))});
  app.revokeAppAccess=(id)=>app.confirm({title:'Revoke connected app?',text:'The app will lose its authorized access.',action:'Revoke access',confirm:()=>fire(api.revokeConnectedApp(id).then(()=>loadProfileAccess()).catch(report))});
  /** @param {any} error @param {string} scope @param {string} id @param {HTMLFormElement|null} form */
  async function recoverUser(error,scope,id,form=null) {
    if(sessionScope()!==scope)return;
    if(!recovery?.isRevisionConflict?.(error))return report(error,{form});
    const result=await loadUsers(false,id);
    if(result.stale||sessionScope()!==scope)return;
    if(result.error)return report(result.error,{form});
    const latest=data.users.find(user=>user.id===id);
    if(form?.isConnected&&context().modal?.type==='user'&&context().modal?.id===id&&latest){
      for(const [name,value] of Object.entries({name:latest.name,admin:latest.admin,active:latest.active})){
        const input=form.querySelector(/** @type {'input'} */(`[name="${name}"]`));
        if(input){if(name==='name')input.value=String(value);else input.checked=!!value;}
      }
      fieldError(form,'name','This user changed. Review the latest values and save again.');
    }else app.toast('This user changed. Review the latest values and try again.','error');
  }
  app.saveUser=(event,id)=>{
    if(recovery?.ensureOnline&&!recovery.ensureOnline()){event?.preventDefault?.();return false;}
    const form=event.target,values=formValues(event),displayName=text(values.get('name'),80),scope=sessionScope();
    if(!displayName)return fieldError(form,'name','Give the user a name.');
    if(id){
      const item=data.users.find((entry)=>entry.id===id);if(!item)return fieldError(form,'name','This user is no longer listed. Reload Users and try again.');
      const isAdmin=form.querySelector?.('[name="admin"]')?.disabled?item.admin:values.has('admin'),isActive=form.querySelector?.('[name="active"]')?.disabled?item.active:values.has('active');
      if(item.name===displayName&&item.admin===isAdmin&&item.active===isActive){app.closeOverlays();return false;}
      const sensitive=item.admin!==isAdmin||item.active!==isActive;
      const expectedRevision=item.revision;
      // A refresh may replace the cached row, so look the account up by id.
      const save=()=>{
        if(sessionScope()!==scope||!data.users.some(user=>user.id===id)||!data.users.find(user=>user.id===data.session?.userId)?.admin)return Promise.resolve();
        return api.updateUser(id,{displayName,isAdmin,isActive,expectedRevision}).then((user)=>{
        const latest=data.users.find(entry=>entry.id===id);
        if(sessionScope()!==scope||!latest)return;
        Object.assign(latest,{name:user.displayName,admin:user.isAdmin,active:user.isActive,revision:user.revision});completeForm(form,()=>app.closeOverlays());app.refreshUsers?.();app.toast('User saved');
        });
      };
      const apply=()=>fire((sensitive?auth.withRecentAuth(save):save()).catch((/** @type {any} */ error)=>recoverUser(error,scope,id,form)));
      if(item.active&&!isActive)return app.confirm({title:'Deactivate user?',text:`${item.name} will lose access, including existing sessions and connected apps.${item.admin&&!isAdmin?' Admin access will also be removed.':''}`,action:'Deactivate user',confirm:apply});
      if(item.admin&&!isAdmin)return app.confirm({title:'Remove admin access?',text:`${item.name} will keep only their project permissions.`,action:'Remove admin access',confirm:apply});
      return apply();
    }
    const username=text(values.get('username'),32).toLowerCase();
    if(!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username))return fieldError(form,'username','Use 3–32 lowercase letters, numbers, dots, dashes, or underscores.');
    const create=()=>api.createUser({username:text(values.get('username'),32),displayName,isAdmin:values.has('admin')}).then(({user,temporaryPassword})=>{
      if(sessionScope()!==scope)return;
      const account=mapAccount(user);
      if(data.adminUsers.loaded){
        // Users list in the server's username order, a page at a time. A new
        // account joins only the loaded range; otherwise its own page brings it.
        const name=(id)=>data.users.find((item)=>item.id===id)?.username??'',last=name(data.adminUsers.ids.at(-1));
        if(!data.adminUsers.nextCursor||compareUsernames(account.username,last)<0){
          mergeAdminUsersPage(data,[account],{append:true,nextCursor:data.adminUsers.nextCursor});
          data.adminUsers.ids.sort((left,right)=>compareUsernames(name(left),name(right)));
        }else data.users.push(account);
      }
      else data.users.push(account);
      app.refreshUsers?.();
      // The password is shown once, so a closed dialog must not lose it.
      if(!completeForm(form,()=>app.showTemporaryPassword(user.id,temporaryPassword))&&app.showTemporaryPassword(user.id,temporaryPassword,{wait:true})===false)app.toast('User created. Its temporary password appears when this dialog closes.');
    });
    return fire((values.has('admin')?auth.withRecentAuth(create):create()).catch(reportFor(scope,{form})));
  };
  app.resetPassword=(id)=>{const scope=sessionScope();return app.confirm({title:'Reset password?',text:'Existing sessions and connected app access will be revoked.',action:'Reset password',confirm:()=>fire(auth.withRecentAuth(()=>api.resetUserPassword(id)).then(({temporaryPassword})=>{if(sessionScope()===scope&&app.showTemporaryPassword(id,temporaryPassword,{wait:true})===false)app.toast('Password reset. The temporary password appears when this dialog closes.');}).catch((/** @type {any} */ error)=>recoverUser(error,scope,id)))});};

  app.updTask = (id, field, value) => {
    if(app.isRendering?.())return false;
    const item=task(id);if(!item)return false;
    return saveTaskField(item,field,value);
  };
  app.saveTaskDraft=(id,field)=>{
    const item=task(id),draft=item&&drafts.get(draftKey(item.internalId,field));
    if(!draft?.unsaved)return false;
    return saveTaskField(item,field,draft.value,{base:draft.base});
  };
  app.saveTask = (event) => {
    event.preventDefault();
    if(pendingTaskForms.has(event.target)||app.validateFormDates?.(event.target)===false)return false;
    const form=event.target,values=formValues(event),modal=context().modal,interactionKey=`task-form:${modal?.poolId||'new'}`;
    const uncertainSource=modal?.poolId&&gateway.hasUncertain?.(interactionKey)&&promotionSource?.id===modal.poolId&&promotionSource?.scope===sessionScope()?promotionSource.entity:null;
    const source=uncertainSource||(modal?.poolId?poolItem(modal.poolId):null);
    if(modal?.poolId&&!source)return fieldError(form,'title','This Pool item is no longer available. Return to Pool to continue.');
    if(source&&!uncertainSource)promotionSource={id:source.id,scope:sessionScope(),entity:{...source,revision:recovery?.expectedRevision?.(recovery?.revisionKey?.(source),source.revision)??source.revision}};
    const payload={projectId:context().projectId,epicId:String(values.get('epicId')||''),title:text(values.get('title'),140),description:text(values.get('desc'),4000),deadline:values.get('deadline')||null,assigneeIds:[...new Set(values.getAll('assignees').map(String))]};
    if(!payload.title)return fieldError(form,'title','Give the task a title.');
    const destination=data.epics.find((entry)=>entry.id===payload.epicId&&entry.projectId===payload.projectId);
    if(!destination)return fieldError(form,'epicId','Choose an epic.');
    if(destination.state==='done')return fieldError(form,'epicId','This epic is completed. Reopen it before adding tasks.');
    if(!validOptionalDate(form,'deadline',payload.deadline))return false;
    const project=data.projects.find((entry)=>entry.id===payload.projectId),eligible=new Set((project?.members??[]).map((member)=>member.userId));
    if(payload.assigneeIds.some((id)=>!eligible.has(id)||data.users.find((user)=>user.id===id)?.active===false))return fieldError(form,'assignees','Choose active project members. A selected person is no longer available.');
    const operation=source?'pool.promote':'task.create';
    const body=source?{poolItemId:source.id,epicId:payload.epicId,title:payload.title,description:payload.description,deadline:payload.deadline,assigneeIds:payload.assigneeIds}:payload;
    pendingTaskForms.add(form);
    const buttons=Array.from(form.querySelectorAll?.('button[type="submit"],input[type="submit"]')??[]);
    const disabled=buttons.map(button=>button.disabled);
    buttons.forEach(button=>button.disabled=true);
    return fire(execute(operation,body,source,source?'Task planning':'Task created',{
      create:!source,reload:true,interactionKey,form,
      onAccepted:()=>{if(promotionSource?.id===source?.id)promotionSource=null;completeForm(form,()=>app.closeOverlays());},
    }).finally(()=>{
      pendingTaskForms.delete(form);
      if(!isFormRetryPending(form))buttons.forEach((button,index)=>button.disabled=disabled[index]);
    }));
  };
  app.deleteTask = (id) => {const item=task(id);if(!item)return;app.confirm({title:'Delete task?',text:`${item.id} will be deleted with its comments and files. You can undo this right after.`,action:'Delete task',confirm:()=>fire(execute('task.delete',{id:item.internalId},item,null,{reload:true,onAccepted:()=>{dropDrafts(item.internalId);nav('board');}}).then((result)=>ifCurrent(result,()=>undoTaskDeletion(item,result))))});};
  // Undo restores the task at the revision its deletion left.
  function undoTaskDeletion(item,result){
    const revision=result?.entities?.find((entity)=>entity?.id===item.internalId)?.revision;
    app.toast(`${item.id} deleted`,'success',Number.isSafeInteger(revision)?{action:{label:'Undo',run:()=>fire(execute('task.restore',{id:item.internalId},item,`${item.id} restored`,{reload:true,expectedRevision:revision}))}}:{});
  }
  app.moveTaskOrder = (id,anchor,before) => {
    const item=task(id),target=task(anchor);if(!item||!target||app._boardMovePending)return false;
    const projectId=item.projectId,scope=sessionScope(),projectTasks=data.tasks.filter((entry)=>entry.projectId===projectId),index=projectTasks.indexOf(item),previousBefore=index>0?projectTasks[index-1]:null,previousAfter=projectTasks[index+1]||null,revision=item.revision;
    const pending={};app._boardMovePending=pending;moveTaskOrder(id,anchor,before);
    const request=execute('task.move',{taskId:item.internalId,status:wireStatus(item.state),[before?'beforeTaskId':'afterTaskId']:target.internalId},item,null,{skipNoChange:true,paint:false})
      .catch((error)=>{if(!error?.uncertain&&sessionScope()===scope&&data.tasks.includes(item)&&item.revision===revision){const current=data.tasks.indexOf(item);data.tasks.splice(current,1);if(previousAfter&&data.tasks.includes(previousAfter))data.tasks.splice(data.tasks.indexOf(previousAfter),0,item);else if(previousBefore&&data.tasks.includes(previousBefore))data.tasks.splice(data.tasks.indexOf(previousBefore)+1,0,item);else data.tasks.splice(Math.min(current,data.tasks.length),0,item);if(context().view==='board'&&context().projectId===projectId)app.refreshBoard?.();}throw error;})
      .finally(()=>{if(app._boardMovePending===pending)app._boardMovePending=false;});
    return fire(request);
  };

  app.saveEpic = (event,id) => {
    event.preventDefault();if(app.validateFormDates?.(event.target)===false)return false;
    const form=event.target,values=formValues(event), item=id?epic(id):null;
    const base={trackId:String(values.get('trackId')||''),title:text(values.get('title'),120),description:text(values.get('desc'),2000),startDate:String(values.get('start')||''),endDate:values.get('end')||null};
    if(!base.title)return fieldError(form,'title','Give the epic a title.');
    if(!data.tracks.some((entry)=>entry.id===base.trackId&&entry.projectId===context().projectId))return fieldError(form,'trackId','Choose a track.');
    if(!validDate(base.startDate))return fieldError(form,'start','Enter a valid start date in YYYY-MM-DD format.');
    if(!validOptionalDate(form,'end',base.endDate))return false;
    if(base.endDate&&base.endDate<base.startDate)return fieldError(form,'end','End date cannot be before the start date.');
    return fire(execute(item?'epic.update':'epic.create',item?{epicId:item.id,...base}:{projectId:context().projectId,...base},item,item?'Epic updated':'Epic created',{create:!item,form,closeForm:true}));
  };
  app.closeEpic=(id)=>{const item=epic(id);if(!item)return;const open=data.tasks.filter((entry)=>entry.epicId===id&&entry.state!=='done').length;const confirm=()=>fire(execute('epic.complete',{id:item.id},item,'Epic marked as done',{form:globalThis.document?.querySelector('.modal,.peek'),closeForm:true}));if(open)app.confirm({title:'Open tasks remain',text:`${open} open task${open===1?' stays where it is':'s stay where they are'}.`,action:'Mark as done',confirm});else confirm();};
  app.reopenEpic=(id)=>{const item=epic(id);if(item)return fire(execute('epic.reopen',{id:item.id},item,'Epic reopened'));};
  app.deleteEpic=(id)=>{const item=epic(id);if(!item)return;app.confirm({title:'Delete epic?',text:`“${item.title}” will be removed.`,action:'Delete epic',confirm:()=>fire(execute('epic.delete',{id:item.id},item,'Epic deleted',{form:globalThis.document?.querySelector('.modal,.peek'),closeForm:true}))});};
  app.openPeek=(id)=>{if(!epic(id))return;openPeek(id);return fire(reads.epic(id).catch(report));};
  app.loadMoreEpicTasks=(id)=>fire(reads.moreEpicTasks(id).catch(report));
  app.loadMoreEpicActivity=(id)=>fire(reads.moreEpicActivity(id).catch(report));

  app.saveTrack=(event,id)=>{const form=event.target,values=formValues(event),item=id?track(id):null,name=text(values.get('name'),60);if(!name)return fieldError(form,'name','Give the track a name.');return fire(execute(item?'track.update':'track.create',item?{trackId:item.id,name}:{projectId:context().projectId,name,description:''},item,item?'Track renamed':'Track created',{create:!item,form,closeForm:true}));};
  app.deleteTrack=(id)=>{const item=track(id);if(!item)return;app.confirm({title:'Delete track?',text:`“${item.name}” will be removed.`,action:'Delete track',confirm:()=>fire(execute('track.delete',{id:item.id},item,'Track deleted',{form:globalThis.document?.querySelector('.modal,.peek'),closeForm:true}))});};
  app.saveMilestone=(event,id)=>{event.preventDefault();if(app.validateFormDates?.(event.target)===false)return false;const form=event.target,values=formValues(event),item=id?milestone(id):null,base={title:text(values.get('name'),60),description:text(values.get('desc'),500),milestoneDate:String(values.get('date')||'')};if(!base.title)return fieldError(form,'name','Give the milestone a name.');if(!validDate(base.milestoneDate))return fieldError(form,'date','Enter a valid date in YYYY-MM-DD format.');return fire(execute(item?'milestone.update':'milestone.create',item?{milestoneId:item.id,...base}:{projectId:context().projectId,...base},item,item?'Milestone updated':'Milestone created',{create:!item,form,closeForm:true}));};
  app.deleteMilestone=(id)=>{const item=milestone(id);if(!item)return;app.confirm({title:'Delete milestone?',text:`“${item.name}” will be removed.`,action:'Delete',confirm:()=>fire(execute('milestone.delete',{id:item.id},item,'Milestone deleted',{form:globalThis.document?.querySelector('.modal,.peek'),closeForm:true}))});};

  app.saveBlock=(event,id,mode)=>{
    const form=event.target,values=formValues(event),item=task(id);if(!item)return false;const reason=text(values.get('reason'),500);
    if(mode==='block'&&!reason)return fieldError(form,'reason','Explain what is preventing progress.');
    let operation,payload;
    const prepared=mode==='block'&&globalThis.Collab?.prepareBlock?.(item,String(values.get('reason')||''),reason);
    if(mode==='block'&&!prepared)return false;
    if(mode==='block'&&item.block){operation='task.block.update';payload={blockId:item.block.id,reason,mentions:prepared.mentions||[]};}
    else if(mode==='block'){operation='task.block';payload={taskId:item.internalId,reason,mentions:prepared.mentions||[]};}
    else {operation=mode==='completeBlocked'?'task.unblock-and-complete':'task.unblock';payload={taskId:item.internalId,resolution:reason||null};}
    const revisionEntity=operation==='task.block.update'?item.block:item;
    return fire(execute(operation,payload,revisionEntity,mode==='block'?'Task blocked':'Task unblocked',{form,closeForm:true}));
  };

  app.poolKey=(event)=>{
    if(event.key!=='Enter'||event.shiftKey||event.isComposing||event.repeat)return;
    event.preventDefault();
    const input=event.target;
    if(pendingPoolCaptures.has(input))return false;
    const enteredTitle=input.value,title=text(enteredTitle,140);
    if(!title){app.toast('Give the Pool item a title.','error');return false;}
    const notes=/** @type {HTMLTextAreaElement|null} */(document.getElementById('poolNewDesc'));
    const description=notes?.value||'',scope=context().poolTab==='project'?'team':'personal';
    pendingPoolCaptures.add(input);
    return fire(execute('pool.create',{projectId:context().projectId,scope,title,description:text(description,2000)},null,'Pool item added',{
      create:true,paint:false,interactionKey:'pool:create',poolScope:scope,
      onAccepted:()=>{
        if(input.isConnected!==false&&input.value===enteredTitle)input.value='';
        if(notes?.isConnected&&notes.value===description)notes.value='';
      },
    }).finally(()=>pendingPoolCaptures.delete(input)));
  };
  app.savePoolDescription=(event,id)=>{const form=event.target,values=formValues(event),item=poolItem(id);if(!item)return false;return fire(execute('pool.update',{poolItemId:item.id,description:text(values.get('desc'),2000)},item,'Description saved',{poolScope:item.scope==='project'?'team':'personal',form,paint:false,onAccepted:()=>completeForm(form,()=>app.refreshPool?.({completeItemId:id}))}));};
  app.delPool=(event,id)=>{event?.stopPropagation?.();const item=poolItem(id);if(!item)return;app.confirm({title:'Delete Pool item?',text:item.title,action:'Delete item',confirm:()=>fire(execute('pool.delete',{id:item.id},item,'Pool item deleted',{poolScope:item.scope==='project'?'team':'personal',paint:false,onAccepted:()=>app.refreshPool?.()}))});};

  app.saveProjectNew=(event)=>{
    const form=event.target,values=formValues(event),name=text(values.get('name'),60),taskPrefix=text(values.get('key'),4).toUpperCase(),scope=sessionScope();if(!name)return fieldError(form,'name','The project needs a name.');if(!/^[A-Z0-9]{2,4}$/.test(taskPrefix))return fieldError(form,'key','Use 2–4 letters or digits.');
    // The new project opens only while its dialog is still the open one; a re-render keeps it open.
    const open=()=>completeForm(form,()=>{});
    return fire(execute('project.create',{name,taskPrefix},null,'Project created',{create:true,form,paint:false}).then((result)=>ifCurrent(result,async()=>{if(!open()){(app.refreshBackground??app.refresh)();return;}const created=result.entities?.find((entity)=>entity.entityType==='project');if(created?.id){await reloadBootstrap({projectId:created.id});if(sessionScope()!==scope||!open())return;app.selectProject(created.id);}if(sessionScope()===scope)nav('roadmap');})));
  };
  app.updateProjectField=(input)=>{const item=data.projects.find((entry)=>entry.id===context().projectId);if(!item||!['name','key'].includes(input.name))return false;const form=input.closest?.('.project-fields'),field=input.name==='key'?'taskPrefix':'name',value=field==='taskPrefix'?text(input.value,4).toUpperCase():text(input.value,60);if(field==='name'&&!value)return fieldError(form,'name','The project needs a name.');if(field==='taskPrefix'&&!/^[A-Z0-9]{2,4}$/.test(value))return fieldError(form,'key','Use 2–4 letters or digits.');input.value=value;return fire(execute('project.update',{projectId:item.id,[field]:value},item,'Project updated',{form,coalesce:true}));};
  app.addMember=(userId)=>fire(execute('membership.add',{projectId:context().projectId,userId,manageRoadmap:false,manageBoard:false},null,'Member added',{create:true}).catch(report));
  app.setMemberPermission=(userId,permission,enabled,input)=>{
    if(!['manage_roadmap','manage_board'].includes(permission))return false;
    const project=data.projects.find((item)=>item.id===context().projectId),membership=project?.members.find((item)=>item.userId===userId),scope=sessionScope();
    if(!membership||membership.permissions.includes(permission)===enabled)return false;
    // Keep the displayed permission authoritative until the confirmation is accepted.
    if(!enabled&&input)input.checked=true;
    const apply=()=>{
      if(sessionScope()!==scope||context().projectId!==project.id||!data.users.find(user=>user.id===data.session?.userId)?.admin)return false;
      const latest=project.members.find(item=>item.userId===userId);if(!latest)return false;
      const current=new Set(latest.permissions);enabled?current.add(permission):current.delete(permission);
      // A change that fails shows the saved permission again.
      return fire(execute('membership.update',{projectId:project.id,userId,manageRoadmap:current.has('manage_roadmap'),manageBoard:current.has('manage_board')},latest,'Access updated').catch(error=>{report(error);if(sessionScope()===scope)app.refreshUsers?.();}));
    };
    if(!enabled)return app.confirm({title:'Remove permission?',text:`${data.users.find(user=>user.id===userId)?.name||userId} will lose permission to manage ${permission==='manage_board'?'Board':'Roadmap'} in ${project.name}.`,action:'Remove permission',confirm:apply});
    return apply();
  };
  function showMemberOpenWork(project,userId,count=null){const user=data.users.find((item)=>item.id===userId),who=user?.name||userId;app.showBlocked?.('Member has open work',count?`Reassign ${count} unfinished task${count===1?'':'s'} before removing ${who} from this project.`:`Reassign this member’s unfinished tasks before removing ${who} from this project.`);}
  app.removeMember=(userId)=>{const project=data.projects.find((item)=>item.id===context().projectId),membership=project?.members.find((item)=>item.userId===userId);if(!membership)return;const assigned=data.tasks.filter((item)=>item.projectId===project.id&&item.state!=='done'&&(item.assignees||[]).includes(userId));if(assigned.length){showMemberOpenWork(project,userId,assigned.length);return false;}app.confirm({title:'Remove member?',text:'They will lose access to this project.',action:'Remove member',confirm:()=>fire(execute('membership.remove',{projectId:project.id,userId},membership,'Member removed',{handleError:(error)=>{if(!['member_has_open_tasks','precondition_failed'].includes(error?.code))return false;showMemberOpenWork(project,userId);return true;}}).catch(report))});};
  app.deleteProject=()=>{const item=data.projects.find((entry)=>entry.id===context().projectId);if(!item)return;app.confirm({title:'Delete project?',text:'This permanently removes the project and all of its work.',action:'Delete project',match:item.name,confirm:()=>fire(auth.withRecentAuth(()=>execute('project.delete',{projectId:item.id,confirmedName:item.name},item,'Project deleted')).then((result)=>ifCurrent(result,()=>nav('roadmap'))).catch(report))});};

  const mapAccount=(user)=>({id:user.id,username:user.username,name:user.displayName,admin:user.isAdmin,active:user.isActive,mustChange:user.mustChangePassword,avatar:user.avatarUrl??null,revision:user.revision});
  /**
   * A refresh with `keepDepth` reloads as many pages as were loaded, so the list keeps its place.
   * A `background` (live) refresh is passive: it never counts as the person using the session.
   */
  async function loadUsers(append=false,throughUser=/** @type {string|null} */(null),{keepDepth=false,background=false}={}){
    const generation=++usersGeneration,expectedSession=sessionScope();usersController?.abort();usersController=new AbortController();
    const depth=keepDepth&&data.adminUsers.loaded?usersDepth:1;
    data.adminUsers.loading=true;data.adminUsers.error=null;app.refreshUsers?.({loadingOnly:true});
    let response,pages=1;
    try{
      response=await api.users({afterUsername:append?usersAfter:undefined,background,signal:usersController.signal});
      while((throughUser&&!response.users.some((/** @type {any} */ user)=>user.id===throughUser)||pages<depth)&&response.nextCursor){
        if(generation!==usersGeneration||expectedSession!==sessionScope())return {stale:true};
        const page=await api.users({afterUsername:response.nextCursor,background,signal:usersController.signal});
        response={...page,users:[...response.users,...page.users]};pages++;
      }
    }
    catch(error){if(generation!==usersGeneration||error?.code==='aborted'||expectedSession!==sessionScope()||!['users','settings'].includes(context().view))return {stale:true};data.adminUsers.loading=false;data.adminUsers.error='Could not load users.';app.refreshUsers?.();return {error};}
    if(generation!==usersGeneration||expectedSession!==sessionScope()||!['users','settings'].includes(context().view))return {stale:true};
    const mapped=response.users.map(mapAccount);usersAfter=Object.hasOwn(response,'nextCursor')?response.nextCursor:(mapped.length===50?mapped.at(-1).username:null);usersDepth=append?usersDepth+1:pages;mergeAdminUsersPage(data,mapped,{append,nextCursor:usersAfter});data.adminUsers.loading=false;data.adminUsers.error=null;append?app.acceptMoreUsers():app.refreshUsers?.();return {stale:false};
  }
  app.retryUsers=()=>fire(loadUsers(false).catch(report));
  app.loadMoreUsers=()=>{if(usersAfter&&!data.adminUsers.loading)return fire(loadUsers(true).catch(report));};

  app.retryProfileAccess=()=>fire(loadProfileAccess().catch(report));
  async function loadProfileAccess({background=false}={}){
    const generation=++profileGeneration,expectedSession=sessionScope();profileController?.abort();profileController=new AbortController();
    let sessionResponse,appResponse;
    app.refreshProfileAccess?.({loading:true});
    try{[sessionResponse,appResponse]=await Promise.all([api.sessions({signal:profileController.signal,background}),api.connectedApps({signal:profileController.signal,background})]);}
    catch(error){if(generation!==profileGeneration||error?.code==='aborted'||expectedSession!==sessionScope()||context().view!=='profile')return {stale:true};app.refreshProfileAccess?.({error:'Could not load account access. Try again.'});return {error};}
    if(generation!==profileGeneration||expectedSession!==sessionScope()||context().view!=='profile')return {stale:true};
    const userId=data.session?.userId;
    data.browserSessions.splice(0,data.browserSessions.length,...sessionResponse.sessions.map((session)=>({id:session.id,userId,device:sessionDeviceLabel(session),browser:sessionBrowserLabel(session),ip:session.clientIp||null,createdAt:session.createdAt*1000,lastActiveAt:session.lastActivityAt*1000,current:session.current,revokedAt:null})));
    data.appGrants.splice(0,data.appGrants.length,...appResponse.apps.map((grant)=>({id:grant.id,userId,clientName:grant.clientName,protocol:'MCP',authorizedAt:grant.createdAt*1000,lastUsedAt:grant.lastUsedAt?grant.lastUsedAt*1000:null,expiresAt:grant.expiresAt*1000,revokedAt:null,access:(grant.projects||[]).map((projectId)=>({projectId,permissions:(grant.scopes||[]).map((scope)=>scope==='project_read'?'read':scope)}))})));
    app.refreshProfileAccess?.();
    return {stale:false};
  }

  /** A `background` (live) load reads passively, so it never keeps an idle session open. */
  async function loadCurrentRoute({reuseBootstrap=false,refresh=false,background=false}={}){
    const generation=++routeGeneration,current={...context()},expectedSession=sessionScope();
    if(!data.session)return;
    const routeHash=globalThis.location?.hash;
    const stillCurrent=()=>generation===routeGeneration&&expectedSession===sessionScope()&&routeHash===globalThis.location?.hash;
    if(!['users','settings'].includes(current.view)){usersGeneration++;usersController?.abort();}
    if(current.view!=='profile'){profileGeneration++;profileController?.abort();}
    try{
      if(current.view==='board'){if(!reuseBootstrap||!reads.adoptBoard?.(current.projectId,current.board))await reads.board(current.projectId,current.board,{skipUnchanged:true,background});}
      else if(current.view==='roadmap'&&current.projectId){if(!reuseBootstrap)await reads.roadmap(current.projectId,{background});}
      else if(current.taskId&&routeHash?.startsWith('#/task/')){
        if(reuseBootstrap&&task(current.taskId)?.detailsLoaded){
          if(current.view!=='task'){recovery?.clearPageError?.();app.openTask(task(current.taskId).id);}
          return {stale:false};
        }
        if(!task(current.taskId)||task(current.taskId)?.detailsLoaded===false)recovery?.beginRouteLoad?.();
        const loaded=await reads.task(current.taskId);
        if(!stillCurrent())return {stale:true};
        if(!loaded?.stale&&loaded?.task){
          const parent=epic(loaded.task.epicId);
          if(!parent||!track(parent.trackId)){
            const roadmap=await reads.roadmap(loaded.task.projectId);
            if(!stillCurrent()||roadmap?.stale)return {stale:true};
          }
          recovery?.clearPageError?.();app.openTask(loaded.task.id);
        }
      }
      else if(current.view==='users'||current.view==='settings')await loadUsers(false,null,{keepDepth:refresh,background});
      else if(current.view==='profile')await loadProfileAccess({background});
      if(!stillCurrent())return {stale:true};
      const projectId=context().projectId;
      if(!reuseBootstrap&&(['roadmap','task','knowledge'].includes(current.view)||routeHash?.startsWith('#/task/'))&&data.projects.some((item)=>item.id===projectId))await reads.counts(projectId,{background});
      return {stale:!stillCurrent()};
    }catch(error){
      if(!stillCurrent())return {stale:true};
      throw error;
    }
  }

  return Object.freeze({
    /** The unsaved value of a task field, which the task page shows instead of the saved one. */
    taskDraft(taskId,field){pruneDrafts();const draft=drafts.get(draftKey(taskId,field));return draft?{value:draft.value,unsaved:draft.unsaved}:null;},
    /** Keep typed text that cannot be saved now, such as after edit rights ended, as a Not saved draft. */
    keepTaskDraft(taskId,field,value){
      const item=task(taskId),max={title:140,desc:4000}[field];if(!item||!max)return;
      const next=text(value,max);if(next===(field==='title'?item.title:item.desc??''))return;
      pruneDrafts();
      drafts.set(draftKey(item.internalId,field),{taskId:item.internalId,field,value:next,base:recovery?.expectedRevision?.(recovery?.revisionKey?.(item),item.revision)??item.revision,scope:sessionScope(),unsaved:true,retryOnline:false});
    },
    async invoke(action,payload){
      if(action==='date.rollover')return reads.roadmap(context().projectId,{background:true}).catch((/** @type {any} */ error)=>{recovery?.refreshFailed?.(error);throw error;});
      if(action==='task.assignees'){const item=task(payload.taskId);if(!item)return skipped();return saveAssignees(item,payload.assigneeIds);}
      if(action==='task.move'){const item=task(payload.taskId),body={taskId:item.internalId,status:wireStatus(payload.status)};for(const key of ['position','beforeTaskId','afterTaskId'])if(payload[key]!==undefined)body[key]=payload[key];return execute('task.move',body,item,payload.optimistic?null:'Task moved',{skipNoChange:!!payload.optimistic,paint:!payload.optimistic});}
      if(action==='track.reorder'){const item=track(payload.trackId);return execute('track.reorder',{trackId:item.id,position:payload.position},item,payload.optimistic?null:'Track reordered',{skipNoChange:!!payload.optimistic,paint:!payload.optimistic});}
      if(action==='board.doneOrder'){saveDoneOrder(payload.order==='completed'?'completed':'manual');return reads.board(context().projectId,context().board);}
      if(action==='board.filter'){
        const result=await reads.board(context().projectId,payload,{skipUnchanged:true});
        const empty=!payload.search&&!payload.blocked&&!(payload.trackIds||[]).length&&!(payload.epicIds||[]).length&&!(payload.assigneeIds||[]).length;
        if(empty&&!result.stale)app.refresh();
        return result;
      }
      if(action==='board.more'){const result=await reads.moreBoard(payload.status);if(!result.stale)app.acceptMoreBoard(payload.status);return result;}
      if(action==='pool.open'){
        const projectId=context().projectId;
        const results=await Promise.all(['personal','team'].map(scope=>reads.pool(projectId,scope)));
        return {stale:results.some(result=>result?.stale)||context().projectId!==projectId};
      }
      if(action==='pool.select')return reads.pool(context().projectId,payload.scope==='project'?'team':'personal');
      if(action==='pool.more')return reads.morePool(context().projectId,payload.scope==='project'?'team':'personal');
      if(action==='workspace.select'){
        if(!await mayLeavePage())return {stale:true};
        const generation=++projectGeneration,scope=sessionScope();
        routeGeneration++;
        const loaded=await reloadBootstrap({projectId:payload.projectId,taskId:undefined,view:context().view==='roadmap'?'roadmap':['board','task'].includes(context().view)?'board':'metadata'});
        if(loaded?.stale||generation!==projectGeneration||scope!==sessionScope())return {stale:true};
        app.selectProject(payload.projectId);
        return loadCurrentRoute({reuseBootstrap:true});
      }
      throw new TypeError(`Unknown production action: ${action}`);
    },
    loadCurrentRoute,
    report,
  });
}
