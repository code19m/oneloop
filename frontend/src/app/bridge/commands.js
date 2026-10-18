// @ts-check

/**
 * Running one command for the view bridge: refusing it while offline,
 * resolving a revision conflict with the person, and reporting a failure
 * beside its form or as a message. Also the helpers that every saving action
 * shares.
 */

import { ApiError } from '../../data/api-client.js';
import { clientField } from '../../data/projection-store.js';
import { statusLabel, toWireScope } from '../../data/wire.js';
import {
  actionErrorFeedback,
  commandInteractionKey,
  commandIsUnchanged,
  formFieldName,
  isServerNoChange,
  validDate,
} from '../action-feedback.js';
import { presentFormError, isFormRetryPending, completeForm } from '../form-feedback.js';
import { leaveAdminPage } from '../../features/recovery/controller.js';

/** Cut at `max` UTF-16 units, as maxlength does, without splitting a surrogate pair. */
export const text = (value, max) => {
  const cut = String(value ?? '').trim().slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/** @param {import('../view-bridge.js').BridgeBase} ctx */
export function createCommands(ctx) {
  const { app, data, gateway, reads, recovery, reloadBootstrap, task, epic, track, milestone, poolItem, context, sessionScope, openModal } = ctx;

  // The values an edit dialog showed when it opened. A save sends only the
  // fields the person changed, so Keep my changes never puts back a value
  // that someone else saved in a field this person left alone.
  /** @type {{type:string,id:string,values:Record<string,unknown>}|null} */
  let dialogBase=null;
  /** @type {Record<string,(item:any)=>Record<string,unknown>>} */
  const DIALOG_VALUES={
    epic:(item)=>({trackId:item.trackId,title:text(item.title,120),description:text(item.desc,2000),startDate:item.start,endDate:item.end||null}),
    milestone:(item)=>({title:text(item.name,60),description:text(item.desc,500),milestoneDate:item.date}),
  };
  function noteDialog(type,id){const item=type==='epic'?epic(id):type==='milestone'?milestone(id):null;dialogBase=item?{type,id,values:DIALOG_VALUES[type](item)}:null;}
  /** After Use latest draws the dialog again, it shows the saved values. */
  function rebaseDialog(){if(dialogBase)noteDialog(dialogBase.type,dialogBase.id);}
  /** The fields of `values` that differ from what the dialog showed when it opened; all of them when that is unknown. */
  function changedFields(type,id,values){
    const base=dialogBase?.type===type&&dialogBase.id===id?dialogBase.values:null;
    return base?Object.fromEntries(Object.entries(values).filter(([key,value])=>(value??null)!==(base[key]??null))):values;
  }
  app.openModal=(type,id,...rest)=>{noteDialog(type,id);return openModal(type,id,...rest);};

  function fieldError(form,name,message){
    if(form?.querySelector(`[name="${name}"]`)){
      app.fieldError(form,name,message);return false;
    }
    app.toast(message,'error');return false;
  }

  function validOptionalDate(form,name,value){
    return !value||validDate(value)||fieldError(form,name,'Enter a valid date in YYYY-MM-DD format.');
  }

  function skipped(){return {entities:[],events:[],replayed:false,skipped:true};}
  function stale(result={}){return {...result,stale:true};}
  function ifCurrent(result,effect){return result?.stale?result:effect(result);}

  function latestEntity(operation,payload,original){
    if(operation.startsWith('task.block'))return data.tasks.find((item)=>item.block?.id===payload.blockId)?.block??task(payload.taskId??original?.internalId);
    if(operation.startsWith('task.checklist.')){const id=payload.itemId??payload.id;return data.tasks.flatMap((item)=>item.checklist??[]).find((item)=>item.id===id)??original;}
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
    // A checklist item names its task.
    if(operation.startsWith('task.')){const item=task(original?.taskId??payload.taskId??payload.id??original?.internalId??original?.id);if(item)await reads.task(item.internalId);return;}
    if(operation.startsWith('pool.')){await reads.pool(context().projectId,options.poolScope??toWireScope(original?.scope));return;}
    if(/^(?:epic|track|milestone)\./.test(operation)){const projectId=original?.projectId??context().projectId;if(projectId)await reads.roadmap(projectId);return;}
    await reloadBootstrap({projectId:context().projectId});app.refresh();
  }

  /** The one field a save changes, or null when it changes several. */
  function conflictField(operation,payload){
    const ignored=new Set(['taskId','epicId','trackId','milestoneId','poolItemId','blockId','itemId','projectId','userId','id','mentions']);
    // A task's track and epic are its own fields. An epic picked on another track brings its track along, and names the pick.
    const own=operation==='task.update'?['epicId' in payload?'epicId':'trackId']:[];
    const keys=Object.keys(payload).filter((key)=>own.includes(key)||!ignored.has(key));
    return keys.length===1?keys[0]:null;
  }

  /** The value of the one field a save changes, in `item`: the payload, or the entity as the client keeps it. */
  function conflictValue(operation,payload,item){
    const field=conflictField(operation,payload);
    if(!field)return undefined;
    const entityType=operation.startsWith('task.block')?'taskBlock':operation.startsWith('pool.')?'poolItem':operation.split('.')[0];
    const value=item===payload?payload[field]:item?.[clientField(entityType,field)];
    // A status, a track or an epic reads as its select names it.
    if(field==='status')return statusLabel(value);
    if(field==='trackId')return track(value)?.name??value;
    if(field==='epicId')return value?epic(value)?.title??value:'No epic';
    return value;
  }

  /** The control of a dialog's field, in the dialog as it is drawn now. */
  function dialogControl(form,field){
    const live=form?.isConnected?form:document.querySelector('.modal form');
    return live?.querySelector(`[name="${formFieldName(field)}"]`)??null;
  }

  /** What a failed save says. */
  function failureMessage(error){
    return error instanceof ApiError && error.uncertain
      ? 'The save result is unknown. Try the same action again to reconcile it safely.'
      : actionErrorFeedback(error).message;
  }

  function report(error, options = {}) {
    if(error?.oneloopReported||error?.code==='reauth_cancelled'||error?.status===401)return;
    const feedback=actionErrorFeedback(error);
    if(feedback.silent)return;
    const message = failureMessage(error);
    if(presentFormError(options.form,error,app,{message}))return;
    const field=feedback.field&&formFieldName(feedback.field);
    if(field&&options.form?.querySelector(`[name="${field}"]`)){
      app.fieldError(options.form,field,message);return;
    }
    app.toast(message, 'error');
  }

  const reportFor=(scope,options={},current=()=>true)=>(error)=>{if(sessionScope()===scope&&current())report(error,options);};
  const stillAdmin=()=>!!data.users.find((user)=>user.id===data.session?.userId)?.admin;
  /** An admin action found the person is no longer an admin: leave the admin page or dialog and say so. */
  function adminGone(){
    if(!leaveAdminPage(data,app,context()))app.toast('You no longer have admin access.','error');
    const error=new ApiError('You no longer have admin access.',{status:403,code:'forbidden'});
    /** @type {any} */(error).oneloopReported=true;return error;
  }

  // A task field save repaints in the background, so it never replaces the
  // field being edited; the status and deadline around it show at once.
  // Other changes paint at once, or, under a dialog opened while they ran,
  // when that dialog closes.
  function paintCommand(operation){
    if(context().view==='board'&&/^task\./.test(operation))app.refreshBoard();
    else if(operation==='task.update'||operation==='task.move'){app.refreshTaskHeader();app.refreshBackground();}
    else app.refreshAfterDialog();
  }

  async function run(operation, payload, entity, message, options = {}) {
    if(isFormRetryPending(options.form)){
      const error=new ApiError('Wait before trying again.',{code:'rate_limited'});
      /** @type {any} */(error).oneloopReported=true;
      throw error;
    }
    if(!recovery.ensureOnline()){
      const error=new ApiError('Reconnect before saving this change.',{code:'offline'});/** @type {any} */(error).oneloopReported=true;throw error;
    }
    const scope=sessionScope(),revisionKey=recovery.revisionKey(entity);
    if(!options.create&&!options.skipNoChange&&commandIsUnchanged(operation,payload,options.compareEntity??entity)){
      recovery.finishRevision(revisionKey);if(options.closeForm)completeForm(options.form,()=>app.closeOverlays());return skipped();
    }
    const interactionKey=options.interactionKey ?? commandInteractionKey(operation,payload,entity);
    const expectedRevision=options.create?undefined:(options.expectedRevision??recovery.expectedRevision(revisionKey,entity?.revision));
    let result;
    try {
      result = await gateway.execute(operation, payload, {
        expectedRevision,
        interactionKey,
      });
    } catch (error) {
      if(sessionScope()!==scope){recovery.finishRevision(revisionKey);return stale();}
      if(isServerNoChange(error)){recovery.finishRevision(revisionKey);if(options.closeForm)completeForm(options.form,()=>app.closeOverlays());return skipped();}
      if(recovery.isRevisionConflict(error)&&!options.create){
        // A dialog shows what the person typed until they choose. Use latest
        // shows the saved values in it: in the one field the save changes, by
        // drawing the dialog again, or as the save's `onLatest` shows them.
        // Until then, it stays on the revision it was opened at, so saving it
        // again still meets the other change.
        const dialog=!options.coalesce&&!!options.form?.closest('.modal'),showsLatest=dialog&&!options.onLatest,field=conflictField(operation,payload);
        // A picker keeps its value in a hidden input, which can't show the
        // saved value by itself; the whole dialog is drawn again instead.
        const control=showsLatest&&field?dialogControl(options.form,field):null,inPlace=!!control&&control.type!=='hidden';
        try{
          /** @type {number|undefined} */ let retriedAt;
          const resolved=await recovery.resolveConflict({
            error,
            reloadLatest:()=>reloadConflict(operation,payload,entity,options),
            latestEntity:()=>latestEntity(operation,payload,entity),
            retry:(expectedRevision)=>{retriedAt=expectedRevision;options.onRetry?.(expectedRevision);return gateway.execute(operation,payload,{expectedRevision,interactionKey});},
            target:{
              element:options.conflictElement??(inPlace?()=>dialogControl(options.form,field):undefined),
              latestValue:(item)=>conflictValue(operation,payload,item),
              ...(showsLatest&&!inPlace?{acceptLatest:()=>{rebaseDialog();app.redrawDialog();}}:{}),
            },
            myValue:conflictValue(operation,payload,payload),
            // A task field keeps the person's other fields as they are now; only a
            // dialog is restored, from the moment the conflict came back.
            snapshot:options.coalesce?false:null,
          });
          // Keep my changes saved the change on the latest revision, which the result names.
          if(resolved.saved)result={...resolved.result,retriedAt};
          else{
            if(resolved.choice==='latest'||!dialog)recovery.finishRevision(revisionKey);
            if(resolved.latest&&sessionScope()===scope)options.onLatest?.(resolved.latest);
            if(error&&typeof error==='object'){error.oneloopReported=true;error.conflictChoice=resolved.choice==='latest'?'latest':'cancelled';}
            // A prompt that closed without a choice (the page changed) still says so; a draft shows it in place.
            if(resolved.choice!=='latest'&&!options.draft&&sessionScope()===scope)app.toast('Your change was not saved. Review the latest version and try again.','error');
            throw error;
          }
        }catch(recoveryError){
          if(sessionScope()!==scope){recovery.finishRevision(revisionKey);return stale();}
          if(recoveryError===error)throw recoveryError;
          await recovery.handleCommandFailure(recoveryError);report(recoveryError);if(recoveryError&&typeof recoveryError==='object')recoveryError.oneloopReported=true;throw recoveryError;
        }
      }else{
        await recovery.handleCommandFailure(error);
        if(options.handleError?.(error)!==true)report(error,options);
        if(error&&typeof error==='object')error.oneloopReported=true;throw error;
      }
    }
    if(result?.stale||sessionScope()!==scope){recovery.finishRevision(revisionKey);return stale(result);}
    // A confirmed write stays successful even when its follow-up read fails.
    if(options.closeForm)completeForm(options.form,()=>app.closeOverlays());
    options.onAccepted?.(result);
    if (message) app.toast(message);
    recovery.finishRevision(revisionKey);
    // The accepted change paints at once; reads that follow repaint their own parts.
    if(!options.reload&&options.paint!==false)paintCommand(operation);
    const refreshContext={...context()};
    try {
      if (options.reload) {
        const loaded=await reloadBootstrap();if(loaded?.stale)return stale(result);
        const current=context();
        // An unfiltered Board shows the cards that the reload carries.
        if(current.view==='board'&&data.projects.some((item)=>item.id===current.projectId)&&!reads.adoptBoard(current.projectId,current.board)){
          if((await reads.board(current.projectId,current.board))?.stale)return stale(result);
        }
      } else if(/^task\.(?:block|unblock)/.test(operation)&&data.projects.some((item)=>item.id===context().projectId)){
        if((await reads.counts(context().projectId))?.stale)return stale(result);
      }
      if(options.poolScope&&(await reads.pool(context().projectId,options.poolScope))?.stale)return stale(result);
      if(sessionScope()!==scope){recovery.finishRevision(revisionKey);return stale(result);}
      if(options.reload&&options.paint!==false)paintCommand(operation);
      return result;
    } catch (error) {
      if(sessionScope()!==scope)return stale(result);
      const current=context();
      if(current.view===refreshContext.view&&current.projectId===refreshContext.projectId&&current.taskId===refreshContext.taskId){
        recovery.refreshFailed(error);
      }
      return {...result,refreshError:error};
    }
  }

  function fire(promise) { promise.catch(() => {}); return false; }
  /**
   * Resolves whether the server accepted a save: true once it went through, or
   * had nothing to change; false when it failed or the session ended. A date
   * field, for one, counts as saved only then.
   */
  function accepted(promise) { return promise.then((result) => !result?.stale, () => false); }
  /** Whether a save can't start now: a retry the server asked to wait for, or no connection, which `ensureOnline` says. */
  const refusedAtOnce = (form) => isFormRetryPending(form) || !recovery.ensureOnline();
  function formValues(event) { event.preventDefault(); return new FormData(event.target); }

  return { changedFields, latestEntity, fieldError, validOptionalDate, skipped, stale, ifCurrent, report, reportFor, stillAdmin, adminGone, failureMessage, paintCommand, run, fire, accepted, refusedAtOnce, formValues };
}
