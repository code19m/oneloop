// @ts-check

/** The view bridge's task actions: fields saved from the task page, new tasks and Pool promotions, blocks, deletion and Undo. */

import { toWireScope, toWireStatus } from '../../data/wire.js';
import { retryableFailure, validDate } from '../action-feedback.js';
import { isFormRetryPending, completeForm } from '../form-feedback.js';
import { text } from './commands.js';

const BLOCK_MESSAGES = Object.freeze({
  'task.block':'Task blocked', 'task.block.update':'Block reason updated',
  'task.unblock':'Task unblocked', 'task.unblock-and-complete':'Task unblocked and completed',
});

/** @param {import('../view-bridge.js').BridgeContext} ctx */
export function installTasks(ctx) {
  const { app, data, gateway, reads, recovery, task, poolItem, context, sessionScope, nav, execute, fire, accepted, refusedAtOnce, formValues, fieldError, validOptionalDate, skipped, ifCurrent, failureMessage, drafts, draftKey, pruneDrafts, dropDrafts, taskBusy, unsavedDraft, paintDrafts } = ctx;
  const assigneeSaves=new Map();
  const pendingTaskForms = new WeakSet();
  let promotionSource=null;

  function noteTaskSaved(result,id){const item=task(id);if(!result?.stale&&!result?.skipped&&!recovery.isSavingTask()&&!(item&&(taskBusy(item.internalId)||unsavedDraft(item.internalId))))app.noteTaskSaved(id);return result;}
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

  /**
   * Save a task field from the task page. A title or description keeps a draft until it is saved.
   * @param {any} item @param {string} field @param {any} value @param {{base?:number}} [options]
   */
  function saveTaskField(item,field,value,{base}={}){
    const form=document.querySelector('.task-page');
    // A field without a draft, such as the deadline or the status, is refused at
    // once when it can't be sent, so its caller keeps it unsaved. A title or
    // description goes on: its draft keeps a refused value and sends it later.
    if(field==='state'&&refusedAtOnce(null))return false;
    // A blocked task is completed with its block resolved, as on the Board.
    // Status shows the saved status again behind the dialog, which opens once
    // the Status menu has returned focus, so it takes focus and gives it back.
    if(field==='state'&&value==='done'&&item.block){app.refresh();queueMicrotask(()=>app.openModal('completeBlocked',item.id));return false;}
    if(field==='state')return accepted(execute('task.move',{taskId:item.internalId,status:toWireStatus(value)},item,null,{reload:true,coalesce:true}).then((result)=>noteTaskSaved(result,item.id)));
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
    }else if(refusedAtOnce(form))return false;
    return accepted(execute('task.update',{taskId:item.internalId,[names[field]]:next},item,null,{form,coalesce:true,expectedRevision:base,draft,draftValue:next,conflictElement:()=>document.querySelector(field==='desc'?'#task-description':field==='title'?'.task-title-field textarea':`[name="${field}"]`)}).then((result)=>noteTaskSaved(result,item.id)));
  }
  function retryDrafts(){
    for(const draft of [...drafts.values()]){
      const item=task(draft.taskId);
      if(item&&draft.unsaved&&draft.retryOnline&&drafts.get(draftKey(draft.taskId,draft.field))===draft)saveTaskField(item,draft.field,draft.value,{base:draft.base});
    }
  }
  recovery.whenOnline(retryDrafts);

  app.updTask = (id, field, value) => {
    if(app.isRendering())return false;
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
    if(pendingTaskForms.has(event.target)||app.validateFormDates(event.target)===false)return false;
    const form=event.target,values=formValues(event),modal=context().modal,interactionKey=`task-form:${modal?.poolId||'new'}`;
    const uncertainSource=modal?.poolId&&gateway.hasUncertain(interactionKey)&&promotionSource?.id===modal.poolId&&promotionSource?.scope===sessionScope()?promotionSource.entity:null;
    const source=uncertainSource||(modal?.poolId?poolItem(modal.poolId):null);
    if(modal?.poolId&&!source)return fieldError(form,'title','This Pool item is no longer available. Return to Pool to continue.');
    if(source&&!uncertainSource)promotionSource={id:source.id,scope:sessionScope(),entity:{...source,revision:recovery.expectedRevision(recovery.revisionKey(source),source.revision)}};
    const payload={projectId:context().projectId,epicId:String(values.get('epicId')||''),title:text(values.get('title'),140),description:text(values.get('desc'),4000),deadline:values.get('deadline')||null,assigneeIds:[...new Set(values.getAll('assignees').map(String))]};
    if(!payload.title)return fieldError(form,'title','Give the task a title.');
    const destination=data.epics.find((entry)=>entry.id===payload.epicId&&entry.projectId===payload.projectId);
    if(!destination)return fieldError(form,'epicId','Choose an epic.');
    if(destination.state==='done')return fieldError(form,'epicId','This epic is completed. Reopen it before adding tasks.');
    if(!validOptionalDate(form,'deadline',payload.deadline))return false;
    const project=data.projects.find((entry)=>entry.id===payload.projectId),eligible=new Set((project?.members??[]).map((member)=>member.userId));
    if(payload.assigneeIds.some((id)=>!eligible.has(id)||data.users.find((user)=>user.id===id)?.active===false))return fieldError(form,'assignees','Choose active project members. A selected person is no longer available.');
    const operation=source?'pool.promote':'task.create';
    // Text the person left as the Pool item had it follows the item, so Keep
    // my changes never puts back a title or description changed meanwhile.
    const ownTitle=payload.title!==text(modal?.title,140),ownDescription=payload.description!==text(modal?.desc,4000);
    const body=source?{poolItemId:source.id,epicId:payload.epicId,...(ownTitle?{title:payload.title}:{}),...(ownDescription?{description:payload.description}:{}),deadline:payload.deadline,assigneeIds:payload.assigneeIds}:payload;
    pendingTaskForms.add(form);
    const buttons=/** @type {HTMLButtonElement[]} */([...form.querySelectorAll('button[type="submit"],input[type="submit"]')]);
    const disabled=buttons.map(button=>button.disabled);
    buttons.forEach(button=>button.disabled=true);
    // A promotion that meets a change to its Pool item builds on the item's
    // latest revision, and Use latest fills in the item's text. The Pool shows
    // again afterwards, so its page is read again after the reload.
    const promotion=source?{
      poolScope:toWireScope(source.scope),
      onRetry:(/** @type {number} */ revision)=>{if(promotionSource?.id===source.id)promotionSource.entity.revision=revision;},
      onLatest:(/** @type {any} */ latest)=>{
        if(context().modal?.poolId!==source.id)return;
        const editor=form.isConnected?form:document.querySelector('.pool-editor form');
        for(const [name,value] of [['title',latest.title],['desc',latest.desc??latest.description??'']]){
          const input=/** @type {HTMLInputElement|null} */(editor?.querySelector(`[name="${name}"]`));if(input){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}
        }
        // Focusing the retained editor records the newly accepted source revision.
        /** @type {HTMLElement|null} */(editor?.querySelector('[name="title"]'))?.focus({preventScroll:true});
      },
    }:{};
    return fire(execute(operation,body,source,source?'Task planning':'Task created',{
      create:!source,reload:true,interactionKey,form,...promotion,
      onAccepted:()=>{if(promotionSource?.id===source?.id)promotionSource=null;completeForm(form,()=>app.closeOverlays());},
    }).finally(()=>{
      pendingTaskForms.delete(form);
      if(!isFormRetryPending(form))buttons.forEach((button,index)=>button.disabled=disabled[index]);
    }));
  };
  app.deleteTask = (id) => {const item=task(id);if(!item)return;app.confirm({title:'Delete task?',text:`${item.id} will be deleted with its comments and files. You can undo this right after.`,action:'Delete task',confirm:()=>fire(execute('task.delete',{id:item.internalId},item,null,{reload:true,onAccepted:()=>{dropDrafts(item.internalId);nav('board');}}).then((result)=>ifCurrent(result,()=>undoTaskDeletion(item,result))))});};
  // Undo restores the task at the revision its deletion left. A restore that
  // fails in a way worth trying again offers Undo again; a retry after an
  // unknown result keeps the restore's key, so it applies once.
  function undoTaskDeletion(item,result){
    const revision=result?.entities?.find((entity)=>entity?.id===item.internalId)?.revision;
    if(!Number.isSafeInteger(revision)){app.toast(`${item.id} deleted`,'success');return;}
    app.offerUndo(`${item.id} deleted`,(again)=>{
      if(recovery.connection==='offline'){again('Reconnect before making this change.');return;}
      fire(execute('task.restore',{id:item.internalId},item,`${item.id} restored`,{reload:true,expectedRevision:revision,handleError:(error)=>{if(!retryableFailure(error))return false;again(failureMessage(error));return true;}}));
    });
  }

  app.saveBlock=(event,id,mode)=>{
    const form=event.target,values=formValues(event),item=task(id);if(!item)return false;const reason=text(values.get('reason'),500);
    if(mode==='block'&&!reason)return fieldError(form,'reason','Explain what is preventing progress.');
    let operation,payload;
    const prepared=mode==='block'&&app.prepareBlock(item,String(values.get('reason')||''),reason);
    if(mode==='block'&&!prepared)return false;
    if(mode==='block'&&item.block){operation='task.block.update';payload={blockId:item.block.id,reason,mentions:prepared.mentions||[]};}
    else if(mode==='block'){operation='task.block';payload={taskId:item.internalId,reason,mentions:prepared.mentions||[]};}
    else {operation=mode==='completeBlocked'?'task.unblock-and-complete':'task.unblock';payload={taskId:item.internalId,resolution:reason||null};}
    const revisionEntity=operation==='task.block.update'?item.block:item;
    return fire(execute(operation,payload,revisionEntity,BLOCK_MESSAGES[operation],{form,closeForm:true}));
  };

  return {
    /** The unsaved value of a task field, which the task page shows instead of the saved one. */
    taskDraft(taskId,field){pruneDrafts();const draft=drafts.get(draftKey(taskId,field));return draft?{value:draft.value,unsaved:draft.unsaved}:null;},
    /** Keep typed text that cannot be saved now, such as after edit rights ended, as a Not saved draft. */
    keepTaskDraft(taskId,field,value){
      const item=task(taskId),max={title:140,desc:4000}[field];if(!item||!max)return;
      const next=text(value,max);if(next===(field==='title'?item.title:item.desc??''))return;
      pruneDrafts();
      drafts.set(draftKey(item.internalId,field),{taskId:item.internalId,field,value:next,base:recovery.expectedRevision(recovery.revisionKey(item),item.revision),scope:sessionScope(),unsaved:true,retryOnline:false});
    },
    /** @param {string} taskId @param {string[]} assigneeIds */
    async setAssignees(taskId,assigneeIds){const item=task(taskId);if(!item)return skipped();return saveAssignees(item,assigneeIds);},
    /**
     * Move a task to `status`, at `position` or before or after another task.
     * An `optimistic` move already shows, so it paints nothing and says nothing.
     * @param {{taskId:string,status:string,position?:number,beforeTaskId?:string,afterTaskId?:string,optimistic?:boolean}} move
     */
    async moveTask(move){const item=task(move.taskId),body={taskId:item.internalId,status:toWireStatus(move.status)};for(const key of ['position','beforeTaskId','afterTaskId'])if(move[key]!==undefined)body[key]=move[key];return execute('task.move',body,item,move.optimistic?null:'Task moved',{skipNoChange:!!move.optimistic,paint:!move.optimistic});},
  };
}
