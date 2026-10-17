// @ts-check

/**
 * Saves of one record run one at a time, each on the revision the one before
 * it was saved at, and a task field's text not saved yet stays as its draft.
 */

import { commandInteractionKey } from '../action-feedback.js';

/** @param {import('../view-bridge.js').BridgeBase & ReturnType<typeof import('./commands.js').createCommands>} ctx */
export function createSaves(ctx) {
  const { app, data, recovery, task, sessionScope, run, stale, paintCommand, latestEntity } = ctx;

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
    // Each checklist item saves on its own, and adds to one checklist run in order.
    if(operation.startsWith('task.checklist.'))return payload.taskId?`checklist:${payload.taskId}`:`checklistItem:${payload.itemId??payload.id}`;
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
  function paintDrafts(taskId){const item=task(taskId);if(item)app.refreshTaskDrafts(item.id);}

  function enqueue(record,operation,payload,entity,message,options){
    const scope=sessionScope(),key=`${scope}|${record}`;
    let queue=records.get(key);
    if(!queue){queue={jobs:new Map(),active:false,running:null};records.set(key,queue);}
    const jobKey=options.coalesce?commandInteractionKey(operation,payload,entity):`job:${++jobSequence}`;
    const replaced=queue.jobs.get(jobKey);
    // The base is the revision the person saw when they made this change.
    const base=options.expectedRevision??recovery.expectedRevision(recovery.revisionKey(entity),entity?.revision);
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

  // A draft lives in this tab only, so leaving oneloop before it saves loses
  // it, and so does signing out in this tab, checklist titles included.
  recovery.trackUnsaved(()=>{pruneDrafts();return drafts.size>0;},()=>drafts.clear());

  async function execute(operation, payload, entity, message, options = {}) {
    const record=options.create?null:recordOf(operation,payload);
    if(!record)return run(operation,payload,entity,message,options);
    return enqueue(record,operation,payload,entity,message,options);
  }

  return { execute, drafts, draftKey, pruneDrafts, dropDrafts, taskBusy, unsavedDraft, paintDrafts };
}
