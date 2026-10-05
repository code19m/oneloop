// @ts-check

import {secondsToMilliseconds} from '../../data/time.js';

import {refreshPageWindow} from '../../data/page-window.js';
import {replaceTaskDetail} from '../../data/projection-store.js';
import {mapActivity} from '../../data/activity-mapper.js';
import {mapInboxItem} from '../../data/inbox-mapper.js';
import {actionErrorFeedback} from '../../app/action-feedback.js';

const chronological = (left, right) => left.ts - right.ts || String(left.id ?? '').localeCompare(String(right.id ?? ''));

/** Convert the selected ranges kept by the polished composer to the API shape. */
export function mentionsToWire(text, mentions = []) {
  return mentions.map((mention) => ({
    kind: mention.id === 'everyone' ? 'everyone' : 'user',
    ...(mention.id === 'everyone' ? {} : { userId: mention.id }),
    startOffset: mention.start,
    endOffset: mention.end,
    label: text.slice(mention.start, mention.end),
  }));
}

/** @param {any} comment */
export function mapComment(comment) {
  const deleted = comment.deletedAt != null || comment.content == null;
  return {
    id: comment.id,
    who: comment.authorId,
    authorName: comment.authorName,
    ts: secondsToMilliseconds(comment.createdAt),
    editedAt: comment.editedAt == null ? null : secondsToMilliseconds(comment.editedAt),
    deletedAt: comment.deletedAt == null ? null : secondsToMilliseconds(comment.deletedAt),
    deleted,
    text: deleted ? '' : String(comment.content ?? ''),
    parentId: comment.rootId === comment.id ? null : comment.rootId,
    replyToId: comment.replyToId ?? null,
    revision: comment.revision,
    mentions: (comment.mentions ?? []).map((mention) => ({
      id: mention.kind === 'everyone' ? 'everyone' : mention.userId,
      label: String(mention.label ?? '').replace(/^@/, ''),
      start: mention.startOffset,
      end: mention.endOffset,
    })),
  };
}

export {mapActivity};


function replace(array, items) { array.splice(0, array.length, ...items); }

/**
 * Installs the production implementation before collaboration.js is evaluated.
 * The classic module still owns markup, focus, keyboard and transient editor state.
 */
export function installCollaborationController({ transport, eventSourceFactory = (url) => new EventSource(url), visibility = globalThis.document }) {
  if (!transport?.api || !transport?.commands || !transport?.data) throw new TypeError('Expected OneloopTransport');
  const data=transport.data;
  let app=null,facade=/** @type {{feedback?:(message:string)=>void,filter:()=>{projects:string[],unread:boolean,archived:boolean},inboxBusy?:(busy:boolean)=>void,inboxPage?:(meta:any)=>void,unreadCount?:(count:number)=>void,taskPage?:(id:string,meta:any)=>void,commentSaved?:(id:string,comment:any,result:any)=>void,commentAcknowledged?:(input:any,comment:any)=>void,commentEditor?:(input:any)=>HTMLTextAreaElement|null,acceptCommentLatest?:(input:any,comment:any)=>void,commentDeleted?:(id:string,commentId:string)=>void,canonicalTask?:(id:string)=>void,target?:(target:any)=>void}|null} */(null),source=null,unsubscribe=null;
  let sessionKey='',routeKey='',taskGeneration=0,inboxGeneration=0,inboxEntry=false;
  let projectReconcileTimer=null,projectReconcileProjectId=null,projectReconcileRunning=false;
  let sessionCheck=null,disposed=false;
  let taskController=null,inboxController=null;
  let taskRead=null,inboxRead=null;
  let taskPages=new Map();
  const interactions=new Map();
  const pendingProjectHints=new Map();
  const liveReads=new Map();
  const changedComments=new Set();
  function clearLiveReads(prefix=''){
    for(const [key,job] of liveReads)if(key.startsWith(prefix)){clearTimeout(job.timer);liveReads.delete(key);job.finish({stale:true});}
  }
  // One current read and one accumulated follow-up per visible task/Inbox.
  // Flags retain a stronger metadata refresh when a later hint is narrower.
  function scheduleLiveRead(key,flags,run){
    const existing=liveReads.get(key);if(existing){existing.flags|=flags;return existing.done;}
    /** @type {(result:{stale:boolean})=>void} */ let finish=()=>{};const done=new Promise(resolve=>{finish=resolve;});
    const job={flags,timer:null,done,finish};liveReads.set(key,job);
    const flush=async()=>{
      job.timer=null;const pending=job.flags;job.flags=0;
      try{await run(pending);}catch(error){if(liveReads.get(key)===job)report(error,false);}
      finally{
        if(liveReads.get(key)!==job)return;
        if(job.flags)job.timer=setTimeout(flush,60);else {liveReads.delete(key);job.finish({stale:false});}
      }
    };
    job.timer=setTimeout(flush,60);return done;
  }
  let inboxPage={key:'',nextCursor:null,unreadCount:0,filteredCount:0,loaded:false};

  const currentSession=()=>`${data.session?.id ?? ''}:${data.session?.userId ?? ''}:${!!data.session?.temporary}`;
  const currentTask=(id)=>data.tasks.find((task)=>task.id===id||task.internalId===id);
  const report=(error,inline)=>{
    if(error?.status===401)return;
    const feedback=actionErrorFeedback(error);if(feedback.silent)return;
    const message=error?.code==='revision_conflict'?'This item changed elsewhere. Review the latest version before saving again.':feedback.message||'The change could not be saved.';
    if(inline)facade?.feedback?.(message);app?.toast?.(message,'error');
  };

  async function readTask(task,options={}){
    const scope=currentSession(),route=routeKey;
    while(taskRead){await taskRead;if(disposed||scope!==currentSession()||route!==routeKey)return {stale:true};}
    const pending=performReadTask(task,options);taskRead=pending;
    try{return await pending;}finally{if(taskRead===pending)taskRead=null;}
  }

  async function performReadTask(task,{background=false,append=false,targetCommentId=null,targetCommentIds=[],targetBlockId=null,reconcile=false}={}){
    if(!task?.internalId)return {stale:true};
    const key=`${currentSession()}:${task.internalId}`,generation=++taskGeneration,expectedRoute=routeKey;
    taskController?.abort();taskController=new AbortController();
    const page={commentsCursor:null,activityCursor:null,loaded:false,...taskPages.get(task.internalId),loading:true,error:false};taskPages.set(task.internalId,page);
    if(!page.loaded&&!background)facade?.taskPage?.(task.id,{loaded:false,loading:true,error:false,hasMore:false,background});
    try{
      const [comments,activity,target,block]=await Promise.all([
        append&&page.loaded&&!page.commentsCursor?Promise.resolve({items:[],nextCursor:null}):transport.api.comments(task.internalId,{cursor:append?page.commentsCursor:undefined,limit:50,signal:taskController.signal,background}),
        append&&page.loaded&&!page.activityCursor?Promise.resolve({items:[],nextCursor:null}):transport.api.activity(task.projectId,{taskId:task.internalId,cursor:append?page.activityCursor:undefined,limit:50,signal:taskController.signal,background}),
        Promise.all([...new Set([...targetCommentIds,...(targetCommentId?[targetCommentId]:[])])].map(id=>transport.api.request(`/api/discussion/tasks/${encodeURIComponent(task.internalId)}/comments/${encodeURIComponent(id)}`,{signal:taskController.signal,background}))).then(pages=>({items:pages.flatMap(page=>page.items??[]),context:pages.flatMap(page=>page.context??[]),replyCounts:Object.assign({},...pages.map(page=>page.replyCounts))})),
        targetBlockId?transport.api.request(`/api/discussion/tasks/${encodeURIComponent(task.internalId)}/blocks/${encodeURIComponent(targetBlockId)}`,{signal:taskController.signal,background}):Promise.resolve(null),
      ]);
      if(reconcile){
        for(const [rows,depth,read] of [
          [comments,page.commentsDepth??1,cursor=>transport.api.comments(task.internalId,{cursor,limit:50,signal:taskController.signal,background})],
          [activity,page.activityDepth??1,cursor=>transport.api.activity(task.projectId,{taskId:task.internalId,cursor,limit:50,signal:taskController.signal,background})],
        ]){for(let index=1;index<depth&&rows.nextCursor;index++){const next=await read(rows.nextCursor);rows.items.push(...next.items);rows.context=[...(rows.context??[]),...(next.context??[])];rows.replyCounts={...rows.replyCounts,...next.replyCounts};rows.nextCursor=next.nextCursor;}}
      }
      if(generation!==taskGeneration||key!==`${currentSession()}:${task.internalId}`||expectedRoute!==routeKey||currentTask(task.internalId)!==task){page.loading=false;return {stale:true};}
      const commentRows=new Map([...(comments.context??[]),...(comments.items??[]),...(target?.context??[]),...(target?.items??[])].map((item)=>[item.id,item]));
      const replyCounts={...comments.replyCounts,...target?.replyCounts};
      const mappedComments=[...commentRows.values()].map((item)=>({...mapComment(item),replyCount:replyCounts[item.rootId]}));
      const activityRows=new Map([...(activity.items??[]),...(block?.items??[])].map((item)=>[item.id,item]));
      const mappedActivity=[...activityRows.values()].map((item)=>mapActivity(item,data.users)).filter(Boolean);
      if(append){
        const commentsById=new Map((task.comments??[]).map((item)=>[item.id,item]));for(const item of mappedComments)commentsById.set(item.id,item);task.comments=[...commentsById.values()].sort(chronological);
        const eventsById=new Map((task.activity??[]).map((item)=>[item.id,item]));for(const item of mappedActivity)eventsById.set(item.id,item);task.activity=[...eventsById.values()].sort(chronological);
      }else{const head=(comments.items??[]).map(mapComment);
        task.comments=refreshPageWindow(task.comments??[],head,!!comments.nextCursor,item=>item.ts);
        const byId=new Map(task.comments.map(item=>[item.id,item]));for(const item of mappedComments)byId.set(item.id,item);task.comments=[...byId.values()].sort(chronological);task.activity=refreshPageWindow(task.activity??[],mappedActivity,!!activity.nextCursor,item=>item.ts,Math.min(...(activity.items??[]).map((/** @type {{createdAt:number}} */ item)=>secondsToMilliseconds(item.createdAt)))).sort(chronological);}
      if(append){if(page.commentsCursor)page.commentsDepth=(page.commentsDepth??1)+1;if(page.activityCursor)page.activityDepth=(page.activityDepth??1)+1;}
      if(append||reconcile||!page.commentsLoaded)page.commentsCursor=comments.nextCursor??null;else if(!comments.nextCursor)page.commentsCursor=null;
      if(append||reconcile||!page.activityLoaded)page.activityCursor=activity.nextCursor??null;else if(!activity.nextCursor)page.activityCursor=null;
      page.commentsLoaded=true;page.activityLoaded=true;page.loaded=true;page.loading=false;page.error=false;page.taskRef=new WeakRef(task);taskPages.set(task.internalId,page);
      facade?.taskPage?.(task.id,{loaded:true,loading:false,error:false,hasMore:!!(page.commentsCursor||page.activityCursor),background});
      return {stale:false};
    }catch(error){
      page.loading=false;
      if(generation!==taskGeneration||key!==`${currentSession()}:${task.internalId}`||expectedRoute!==routeKey||currentTask(task.internalId)!==task||error?.code==='aborted')return {stale:true};
      page.error=true;
      facade?.taskPage?.(task.id,{loaded:page.loaded,loading:false,error:true,hasMore:!!(page.commentsCursor||page.activityCursor),background});
      if([403,404].includes(error?.status))globalThis.OneloopRecovery?.handleRouteError?.(error,{background:true});else report(error,false);
      return {stale:false,error};
    }
  }

  const filterKey=(filter)=>JSON.stringify([filter.projects??[],!!filter.unread,!!filter.archived]);
  async function readInbox(filter,options={}){
    const scope=currentSession();
    if(inboxPage.key&&inboxPage.key!==`${scope}:${filterKey(filter)}`)inboxController?.abort();
    while(inboxRead){await inboxRead;if(disposed||scope!==currentSession())return {stale:true};}
    const pending=performReadInbox(filter,options);inboxRead=pending;
    try{return await pending;}finally{if(inboxRead===pending)inboxRead=null;}
  }

  async function performReadInbox(filter,{append=false,background=false}={}){
    const key=`${currentSession()}:${filterKey(filter)}`,generation=++inboxGeneration;
    if(!append)inboxController?.abort();
    inboxController=new AbortController();inboxPage={...inboxPage,key,loading:true,error:false,loaded:inboxPage.key===key&&inboxPage.loaded};
    if(inboxPage.loaded)facade?.inboxBusy?.(true);else facade?.inboxPage?.({...inboxPage,background});
    try{
      const read=(cursor)=>transport.api.inbox({projectIds:filter.projects??[],unreadOnly:!!filter.unread,archived:!!filter.archived,cursor,limit:50,signal:inboxController.signal,background});
      const depth=!append&&inboxPage.loaded?(inboxPage.depth??1):1;
      const page=await read(append?inboxPage.nextCursor:undefined);
      let fetched=1;
      while(fetched<depth&&page.nextCursor){const next=await read(page.nextCursor);page.items.push(...next.items);page.nextCursor=next.nextCursor;fetched++;}
      if(generation!==inboxGeneration||key!==`${currentSession()}:${filterKey(facade?.filter?.()??filter)}`)return {stale:true};
      const mapped=(page.items??[]).map((item)=>mapInboxItem(item));
      if(append){const byId=new Map(data.notifications.map((item)=>[item.id,item]));for(const item of mapped)byId.set(item.id,item);replace(data.notifications,[...byId.values()]);}
      else replace(data.notifications,mapped);
      inboxPage={key,depth:append?(inboxPage.depth??1)+1:fetched,nextCursor:page.nextCursor??null,unreadCount:Number(page.unreadCount??0),filteredCount:Number(page.filteredCount??mapped.length),loaded:true,loading:false,error:false};
      data.inboxUnreadCount=inboxPage.unreadCount;
      facade?.inboxPage?.({...inboxPage,append,items:append?mapped:undefined,background});
      return {stale:false};
    }catch(error){inboxPage={...inboxPage,loading:false,error:true};if(generation!==inboxGeneration||error?.code==='aborted')return {stale:true};facade?.inboxPage?.({...inboxPage,background});report(error,false);return {stale:false,error};}
  }

  async function execute(operation,payload,options={}){
    const expectedSession=currentSession();
    // The gateway owns uncertain reconciliation. It retries only an identical
    // intent and discards an older uncertain command when the payload changed.
    const result=await transport.commands.execute(operation,payload,options);
    if(expectedSession!==currentSession())return {stale:true,result};
    return {stale:false,result};
  }

  async function performSaveComment(input,acknowledged={revision:null}){
    const expectedTask=app?.context?.().taskId,expectedSession=currentSession();
    const editing=input.mode==='edit',operation=editing?'discussion.comment.edit':'discussion.comment.create';
    const payload=editing?{commentId:input.commentId,content:input.text,mentions:mentionsToWire(input.text,input.mentions)}:{taskId:input.task.internalId,content:input.text,replyToId:input.mode==='reply'?input.targetId:null,mentions:mentionsToWire(input.text,input.mentions)};
    const isCurrent=()=>currentSession()===expectedSession&&app?.context?.().taskId===expectedTask&&!!facade?.commentEditor?.(input);
    let response,notifyEditor=true;
    try{
      response=await execute(operation,payload,{expectedRevision:editing?input.revision:undefined,interactionKey:`${operation}:${input.commentId??input.task.internalId}:${input.interactionId}`});
    }catch(error){
      if(editing&&globalThis.OneloopRecovery?.isRevisionConflict?.(error)){
        if(!isCurrent())return false;
        try{
          const resolved=await globalThis.OneloopRecovery.resolveConflict({
            error,
            reloadLatest:()=>readTask(currentTask(input.task.internalId),{background:true}),
            latestEntity:()=>currentTask(input.task.internalId)?.comments?.find((item)=>item.id===input.commentId),
            retry:(expectedRevision)=>execute(operation,payload,{expectedRevision,interactionKey:`${operation}:${input.commentId}:${input.interactionId}`}),
            target:{element:()=>facade?.commentEditor?.(input),latestValue:(item)=>item.text,acceptLatest:(item)=>facade?.acceptCommentLatest?.(input,item)},myValue:input.text,snapshot:false,isCurrent,
          });
          if(!resolved.saved)return false;response=resolved.result;notifyEditor=!resolved.stale;
        }catch(retryError){if(isCurrent())report(retryError,true);return false;}
      }else{report(error,true);return false;}
    }
    if(response.stale)return false;
    try{
      const entity=(response.result.entities??[]).find((item)=>item&&item.id&&item.authorId);
      if(!entity)throw new Error('The server did not return the saved comment.');
      const comment=mapComment(entity),task=currentTask(input.task.internalId);acknowledged.revision=comment.revision;if(!task)return false;
      const index=(task.comments??[]).findIndex((item)=>item.id===comment.id);if(index>=0)task.comments.splice(index,1,comment);else (task.comments??=[]).push(comment);
      task.comments.sort(chronological);
      // Typing after Save keeps the editor open; its next save builds on this one.
      if(editing&&currentSession()===expectedSession)facade?.commentAcknowledged?.(input,comment);
      await refreshActivity(task,true);
      if(notifyEditor&&(!editing||isCurrent())&&app?.context?.().view==='task'&&app.context().taskId===expectedTask)facade?.commentSaved?.(task.id,comment,{mode:input.mode,interactionId:input.interactionId,changed:(response.result.events??[]).length>0});
      return true;
    }catch(error){report(error,true);return false;}
  }

  // Saves of one comment's edits run one at a time. A Save made before the
  // previous reply waits for it and builds on the revision that reply
  // acknowledged, so it never conflicts with the person's own edit; only the
  // newest text is sent.
  const commentEdits=new Map();
  function saveComment(input){
    const key=`comment:${input.interactionId}`;if(interactions.has(key))return interactions.get(key);
    if(input.mode!=='edit'){const promise=performSaveComment(input).finally(()=>interactions.delete(key));interactions.set(key,promise);return promise;}
    const editKey=`${currentSession()}:${input.commentId}`,queued=commentEdits.get(editKey);
    if(queued){queued.next=input;queued.keys.push(key);interactions.set(key,queued.promise);return queued.promise;}
    const state={next:input,keys:[key],promise:null};commentEdits.set(editKey,state);
    state.promise=(async()=>{
      const rebased=new Map();let saved=false;
      try{
        while(state.next){
          const next=state.next;state.next=null;
          let revision=next.revision;while(rebased.has(revision))revision=rebased.get(revision);
          const acknowledged={revision:null};
          saved=await performSaveComment({...next,revision},acknowledged);
          if(Number.isSafeInteger(revision)&&Number.isSafeInteger(acknowledged.revision)&&acknowledged.revision!==revision)rebased.set(revision,acknowledged.revision);
          if(!saved)break;
        }
        return saved;
      }finally{if(commentEdits.get(editKey)===state)commentEdits.delete(editKey);for(const item of state.keys)interactions.delete(item);}
    })();
    interactions.set(key,state.promise);return state.promise;
  }

  async function performDeleteComment(input){
    const expectedTask=app?.context?.().taskId;
    try{
      const response=await execute('discussion.comment.delete',{commentId:input.comment.id},{expectedRevision:input.comment.revision,interactionKey:`discussion.comment.delete:${input.comment.id}`});
      if(response.stale)return false;
      const entity=(response.result.entities??[]).find((item)=>item&&item.id===input.comment.id);
      const task=currentTask(input.task.internalId);if(!task||!entity)return false;
      const mapped=mapComment(entity),index=task.comments.findIndex((item)=>item.id===mapped.id);if(index>=0)task.comments.splice(index,1,mapped);
      await refreshActivity(task,true);if(app?.context?.().view==='task'&&app.context().taskId===expectedTask)facade?.commentDeleted?.(task.id,mapped.id);return true;
    }catch(error){report(error,false);return false;}
  }

  function deleteComment(input){
    const key=`delete:${input.comment.id}`;if(interactions.has(key))return interactions.get(key);
    const promise=performDeleteComment(input).finally(()=>interactions.delete(key));interactions.set(key,promise);return promise;
  }

  async function refreshActivity(task,background){
    try{
      const response=await transport.api.activity(task.projectId,{taskId:task.internalId,limit:50,background});
      if(currentTask(task.internalId)!==task)return;
      task.activity=refreshPageWindow(task.activity??[],(response.items??[]).map((item)=>mapActivity(item,data.users)).filter(Boolean),!!response.nextCursor,item=>item.ts,Math.min(...(response.items??[]).map((/** @type {{createdAt:number}} */ item)=>secondsToMilliseconds(item.createdAt)))).sort(chronological);
      const page=taskPages.get(task.internalId)||{};if(!page.activityLoaded||!response.nextCursor)page.activityCursor=response.nextCursor??null;page.activityLoaded=true;taskPages.set(task.internalId,page);
    }catch(error){if(error?.code!=='aborted')report(error,false);}
  }

  async function readCanonicalTask(task){
    const expectedSession=currentSession(),expectedRoute=routeKey;
    try{
      const view=await transport.api.request(`/api/tasks/${encodeURIComponent(task.internalId)}`,{background:true});
      if(!view||currentSession()!==expectedSession||routeKey!==expectedRoute||!currentTask(task.internalId))return null;
      if(currentTask(task.internalId).revision>view.revision)return currentTask(task.internalId);
      const mapped=replaceTaskDetail(data,view);
      facade?.canonicalTask?.(mapped.id);
      return mapped;
    }catch(error){if(currentSession()!==expectedSession||routeKey!==expectedRoute)return null;if([403,404].includes(error?.status))globalThis.OneloopRecovery?.handleRouteError?.(error,{background:true});else if(error?.code!=='aborted'&&error?.code!=='network_error')report(error,false);return null;}
  }

  function refreshInbox(filter){
    const session=currentSession();
    return scheduleLiveRead(`inbox:${session}`,1,()=>session===currentSession()?readInbox(filter,{background:true}):null);
  }

  async function changeInbox(operation,id){
    try{const response=await execute(operation,{notificationId:id},{interactionKey:`${operation}:${id}`});if(response.stale)return false;await refreshInbox(facade.filter());return true;}catch(error){report(error,false);return false;}
  }
  async function bulkInbox(operation,filter){
    try{await execute(operation,{filter:{projectIds:filter.projects??[],unreadOnly:!!filter.unread,archived:!!filter.archived}},{interactionKey:`${operation}:${filterKey(filter)}`});await refreshInbox(filter);return true;}catch(error){report(error,false);return false;}
  }

  async function openNotification(item){
    if(!item)return;
    try{
      if(!item.readAt)await execute('inbox.markRead',{notificationId:item.id},{interactionKey:`inbox.markRead:${item.id}`});
      if(!item.destinationAvailable||!item.taskId){app.toast('This item is no longer available','info');await readInbox(facade.filter());return;}
      // A task removed since the Inbox loaded is reported here; the Inbox stays.
      const loaded=await transport.reload({taskId:item.taskId,routeErrors:false});if(loaded?.stale)return;
      const task=loaded?.unavailable?null:currentTask(item.taskId);if(!task){app.toast('This item is no longer available','info');await readInbox(facade.filter());return;}
      facade?.target?.({commentId:item.commentId,blockId:item.blockId,rootId:item.rootId});
      app.openTask(task.id);
      if(item.commentId||item.blockId)await readTask(task,{targetCommentId:item.commentId,targetBlockId:item.blockId});
    }catch(error){report(error,false);}
  }

  function entityRevision(entityType,entityId){
    if(!entityType||!entityId)return null;
    const collections={project:data.projects,track:data.tracks,epic:data.epics,milestone:data.milestones,task:data.tasks,pool_item:data.pool};
    const collection=collections[entityType];if(!collection)return null;
    const item=collection.find((entry)=>entry.id===entityId||entry.internalId===entityId);
    return Number.isFinite(item?.revision)?Number(item.revision):null;
  }

  function hintIsCovered(hint){
    const revision=hint?.entityRevision;if(!Number.isSafeInteger(revision)||revision<1)return false;
    const current=entityRevision(hint.entityType,hint.entityId);return current!==null&&current>=revision;
  }

  function clearProjectReconcile(){
    if(projectReconcileTimer)clearTimeout(projectReconcileTimer);
    projectReconcileTimer=null;projectReconcileProjectId=null;pendingProjectHints.clear();
  }

  function motionPending(context){
    return context?.view==='board'?!!app?._boardMovePending:context?.view==='roadmap'?!!app?._roadmapMovePending:false;
  }

  function scheduleProjectReconcile(projectId,{full=false,hint=/** @type {any} */({})}={}){
    if(projectReconcileProjectId&&projectReconcileProjectId!==projectId)clearProjectReconcile();
    projectReconcileProjectId=projectId;
    const identity=hint.entityType&&hint.entityId?`${hint.entityType}:${hint.entityId}`:`${hint.kind??'reconcile'}:project`;
    const previous=pendingProjectHints.get(identity);
    const previousRevision=previous?.hint?.entityRevision,nextRevision=hint.entityRevision;
    if(!previous||previousRevision==null||nextRevision==null||nextRevision>=previousRevision){
      pendingProjectHints.set(identity,{hint,full:full||!!previous?.full});
    }else if(full&&!previous.full){
      previous.full=true;
    }
    if(projectReconcileTimer)return;
    const flush=()=>{
      projectReconcileTimer=null;
      const context=app?.context?.();
      if(!context||context.projectId!==projectReconcileProjectId){clearProjectReconcile();return;}
      if(projectReconcileRunning||motionPending(context)){projectReconcileTimer=setTimeout(flush,60);return;}
      const pending=[...pendingProjectHints.values()];clearProjectReconcile();
      const uncovered=pending.filter((item)=>!hintIsCovered(item.hint));
      if(!uncovered.length)return;
      const needsFull=uncovered.some((item)=>item.full);
      projectReconcileRunning=true;
      transport.reload({projectId,background:true,viewOnly:!needsFull,hints:uncovered.map(item=>item.hint)}).catch(()=>{}).finally(()=>{projectReconcileRunning=false;});
    };
    projectReconcileTimer=setTimeout(flush,60);
  }

  async function reconcile(kind='reconcile',hint=/** @type {any} */({})){
    const context=app?.context?.();if(!context||!data.session)return;
    if(kind==='inbox.changed'||kind==='reconcile'||context.view==='inbox'&&hint.entityType==='comment'){
      const session=currentSession();scheduleLiveRead(`inbox:${session}`,1,()=>session===currentSession()?readInbox(facade.filter(),{background:true}):null);
      if(kind==='inbox.changed'||context.view==='inbox'&&hint.entityType==='comment')return;
    }
    if(hint.projectId&&context.projectId&&hint.projectId!==context.projectId)return;
    const metadataChange=['project','membership','track','epic','milestone','pool_item'].includes(hint.entityType);
    if(context.view==='task'){
      const task=currentTask(context.taskId);if(!task)return;
      if(!metadataChange&&hint.taskId&&hint.taskId!==task.internalId)return;
      const session=currentSession(),route=routeKey;
      if(hint.entityType==='comment'&&hint.entityId)changedComments.add(hint.entityId);
      const full=kind==='reconcile'||metadataChange;
      const canonical=!hint.entityType||!['comment','attachment'].includes(hint.entityType);
      scheduleLiveRead(`task:${session}:${task.internalId}`,full?1:canonical?2:4,async flags=>{
        if(session!==currentSession()||route!==routeKey)return;
        if(flags&1){const loaded=await transport.reload({projectId:context.projectId,background:true});if(loaded?.stale)return;}
        if(session!==currentSession()||route!==routeKey)return;
        const current=currentTask(context.taskId);
        if(!current)return;
        const next=flags&2&&!(flags&1)?await readCanonicalTask(current):current;
        if(next&&session===currentSession()&&route===routeKey){
          const targets=[...changedComments];changedComments.clear();
          await readTask(next,{background:true,targetCommentIds:targets,reconcile:!!(flags&1)});
        }
      });
      return;
    }
    // These hints cannot change cards, timeline planning, Pool or account screens.
    if(kind==='activity.changed'){
      // Knowledge syncs refresh only the Knowledge page, which follows them itself.
      if(['comment','attachment','knowledge_source'].includes(hint.entityType))return;
      const accessChange=['project','membership'].includes(hint.entityType);
      if(['inbox','profile','users','storage','settings'].includes(context.view)&&!accessChange)return;
    }
    if(kind==='activity.changed'||kind==='reconcile'){
      scheduleProjectReconcile(context.projectId,{full:kind==='reconcile'||metadataChange,hint:{...hint,kind}});
    }
  }

  function visibilityChanged(){
    if(visibility?.visibilityState==='hidden'){
      source?.close?.();source=null;
      clearProjectReconcile();clearLiveReads();
    }else if(!source){
      // No bootstrap cursor: the server must reconcile changes missed while hidden.
      startEvents();
    }
  }

  function startEvents(initial=false){
    source?.close?.();source=null;if(disposed||!data.session||data.session.temporary||visibility?.visibilityState==='hidden')return;
    try{
      source=eventSourceFactory('/api/events'+(initial&&data.syncCursor?`?cursor=${encodeURIComponent(data.syncCursor)}`:''));
      const activeSource=source;
      source.addEventListener?.('open',()=>{if(source!==activeSource)return;transport.publish?.({type:'live-open'});globalThis.OneloopRecovery?.liveConnected?.();});
      const receive=(event)=>{if(source!==activeSource)return;let payload={};try{payload=JSON.parse(event.data||'{}');}catch{}const kind=payload.kind||event.type,context=app?.context?.();if(kind==='ready')return;const visibleTask=context?.view==='task'?currentTask(context.taskId):null;transport.publish?.({type:'sse',kind,taskId:visibleTask&&(!payload.taskId||payload.taskId===visibleTask.internalId)?context.taskId:null,...(payload.entityType?{entityType:payload.entityType}:{}),...(payload.projectId?{projectId:payload.projectId}:{})});void reconcile(kind,payload);};
      source.addEventListener?.('reconcile',receive);source.addEventListener?.('hint',receive);
      source.addEventListener?.('error',()=>{
        if(source!==activeSource)return;
        source?.close?.();source=null;
        globalThis.OneloopRecovery?.liveDisconnected?.(()=>startEvents());
        if(sessionCheck)return;
        const expectedSession=currentSession();
        const check=transport.api.request('/api/auth/me',{background:true}).catch((error)=>{
          if(expectedSession===currentSession()&&error?.status===401&&!globalThis.OneloopRecovery?.sessionExpired?.())globalThis.location?.reload?.();
        }).finally(()=>{if(sessionCheck===check)sessionCheck=null;});
        sessionCheck=check;
      });
    }catch(error){report(error,false);}
  }

  const controller={
    production:true,
    bind(nextApp,nextHooks,nextFacade){
      app=nextApp;facade=nextFacade;sessionKey=currentSession();
      if(Number.isFinite(data.inboxUnreadCount))facade?.unreadCount?.(data.inboxUnreadCount);
      unsubscribe?.();unsubscribe=transport.subscribe((change)=>{
        const next=currentSession();
        if(next!==sessionKey){sessionKey=next;taskGeneration++;inboxGeneration++;taskController?.abort();inboxController?.abort();taskPages=new Map();clearProjectReconcile();clearLiveReads();sessionCheck=null;inboxPage={key:'',nextCursor:null,unreadCount:0,filteredCount:0,loaded:false};startEvents(true);}
        if(change?.type==='bootstrap'){
          if(Number.isFinite(change.projection?.inboxUnreadCount))facade?.unreadCount?.(change.projection.inboxUnreadCount);
        }
      });
      visibility?.removeEventListener?.('visibilitychange',visibilityChanged);
      visibility?.addEventListener?.('visibilitychange',visibilityChanged);
      startEvents(true);return controller;
    },
    beforeRender(context){const next=JSON.stringify([context.userId,context.view,context.projectId,context.taskId]);if(next!==routeKey){taskGeneration++;taskController?.abort();clearLiveReads('task:');changedComments.clear();inboxEntry=context.view==='inbox';}routeKey=next;},
    mount(context){
      if(!data.session)return;
      if(context.view==='task'){
        const task=currentTask(context.taskId),page=task&&taskPages.get(task.internalId);
        // Reading a page again after a refresh replaced its task is passive.
        if(task&&(!page?.loaded||page.taskRef?.deref()!==task)&&!page?.loading&&!page?.error)readTask(task,{background:!!page?.loaded});
      }else if(context.view==='inbox'){
        const key=`${currentSession()}:${filterKey(facade.filter())}`;if((inboxEntry||!inboxPage.loaded||inboxPage.key!==key)&&!inboxPage.loading&&!(inboxPage.error&&inboxPage.key===key)){inboxEntry=false;readInbox(facade.filter(),{background:inboxPage.loaded});}
      }
    },
    saveComment,deleteComment,
    loadInbox:(filter)=>readInbox(filter),
    moreInbox:(filter)=>inboxPage.nextCursor?readInbox(filter,{append:true}):Promise.resolve({done:true}),
    moreTask(id){const task=currentTask(id);return task?readTask(task,{append:true}):Promise.resolve({done:true});},
    loadTaskPage(id){const task=currentTask(id);return task?readTask(task):Promise.resolve({done:true});},
    setRead:(id,currentlyRead)=>changeInbox(currentlyRead?'inbox.markUnread':'inbox.markRead',id),
    setArchived:(id,currentlyArchived)=>changeInbox(currentlyArchived?'inbox.restore':'inbox.archive',id),
    bulk:(action,filter)=>bulkInbox(action==='read'?'inbox.bulkMarkRead':'inbox.bulkArchive',filter),
    openNotification,
    dispose(){disposed=true;visibility?.removeEventListener?.('visibilitychange',visibilityChanged);unsubscribe?.();source?.close?.();source=null;taskController?.abort();inboxController?.abort();clearProjectReconcile();clearLiveReads();sessionCheck=null;},
  };
  globalThis.OneloopCollaboration=controller;
  return controller;
}
