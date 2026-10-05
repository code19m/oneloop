// @ts-check

import {
  appendBoardTasks, compareTaskOrder, mergeEpicActivityPage, mergeEpicTaskPage, replaceBoardTasks, replacePoolPage, replaceRoadmap, replaceTaskDetail,
  setBoardPageInfo, setPoolPageInfo, setProjectTaskCounts, wireStatus,
} from './projection-store.js';
import {mapActivity} from './activity-mapper.js';
import {savedDoneOrder} from './done-order.js';
import {secondsToMilliseconds} from './time.js';

const STATUSES=['planning','progress','review','done'];
function boardFilters(filters={}){
  return {limit:50,search:String(filters.search??'').trim()||undefined,trackIds:[...(filters.trackIds??[])].sort(),epicIds:[...(filters.epicIds??[])].sort(),assigneeIds:(filters.assigneeIds??[]).filter(id=>id!=='__unassigned__').sort(),noAssignee:(filters.assigneeIds??[]).includes('__unassigned__')||undefined,blocked:filters.blocked||undefined,
    // The browser's Done order travels with every Board read; only Done uses it.
    ...(savedDoneOrder()==='completed'?{doneOrder:'completed'}:{})};
}

/** @typedef {{slot:string,target:string,background:boolean,epoch:number,projection:number,controller:AbortController,signal:AbortSignal,promise:Promise<any>|null,next:Token|null,done:boolean}} Token */

/**
 * Reads behind the open views. Every read has a slot named after what it
 * loads: the Board, one task, the epic drawer, or a project's counts, Roadmap
 * or Pool scope.
 * A newer read of a slot replaces an older one; when both asked for the same
 * thing, the older caller gets the newer result instead of nothing. Reads of
 * different slots never cancel each other. A background (live) read never
 * replaces a read someone is waiting for: it waits for that read first, and it
 * is dropped when a full refresh landed while it ran.
 */
export function createReadController({api,data,onBoard=(_state)=>{},onRoadmap=(_projection)=>{},onPool=(_page)=>{},onTask=(_task)=>{},onEpic=(_page)=>{},onCounts=(_counts)=>{},onError=(_error)=>{}}){
  let epoch=0;
  let boardState=null,boardDirty=false,pageController=new AbortController();
  /** @type {Promise<any>|null} */ let boardPageRead=null;
  /** @type {Map<string,Token>} */ const slots=new Map();
  /** @type {Set<Promise<any>>} */ const foreground=new Set();
  const stamp=()=>JSON.stringify([data.session?.id,data.session?.userId,data.projectionGeneration??0]);
  const remember=(state,started=stamp())=>{state.stamp=started;state.ids=new Set(data.tasks.filter(task=>task.projectId===state.projectId).map(task=>task.internalId));state.depths??=Object.fromEntries(STATUSES.map(status=>[status,1]));boardState=state;boardDirty=false;};
  const poolStates=new Map();
  const current=(/** @type {Token} */ token)=>slots.get(token.slot)===token&&token.epoch===epoch&&!(token.background&&token.projection!==(data.projectionGeneration??0));
  const ignored=(/** @type {Token} */ token,error)=>!current(token)||error?.code==='aborted';

  /**
   * Run `work` as the newest read of `slot`. A stale outcome resolves to the
   * newer read of the same target when there is one.
   * @param {string} slot @param {string} target @param {boolean} background
   * @param {(token:Token)=>Promise<any>} work @param {(token:Token)=>void} [lost] runs when the read ends without landing
   */
  async function read(slot,target,background,work,lost=()=>{}){
    if(background){
      // Live updates queue behind a read someone started instead of replacing it.
      for(let active=slots.get(slot);active&&!active.done&&!active.background;active=slots.get(slot))await active.promise?.catch(()=>{});
    }
    const previous=slots.get(slot),controller=new AbortController();
    /** @type {Token} */
    const token={slot,target,background,epoch,projection:data.projectionGeneration??0,controller,signal:controller.signal,promise:null,next:null,done:false};
    slots.set(slot,token);
    token.promise=(async()=>{
      try{
        const result=await work(token);
        if(!result?.stale)return result;
        const next=token.next;
        if(next&&next.target===token.target&&next.epoch===token.epoch)return next.promise;
        lost(token);return result;
      }finally{token.done=true;if(slots.get(slot)===token)slots.delete(slot);}
    })();
    if(previous&&!previous.done){previous.next=token;previous.controller.abort();}
    if(!background){foreground.add(token.promise);token.promise.then(()=>foreground.delete(token.promise),()=>foreground.delete(token.promise));}
    return token.promise;
  }

  /** Replace a Board read in flight for other filters; the newest filters win. */
  function supersedeBoard(target){
    const active=slots.get('board');
    if(active&&!active.done&&active.target!==target){slots.delete('board');active.controller.abort();}
  }
  const boardTarget=(projectId,common)=>JSON.stringify([projectId,common]);
  // A live Board read carries a change hint; losing it leaves the cache dirty.
  const boardLost=(/** @type {Token} */ token)=>{if(token.background)boardDirty=true;};

  function adoptBoard(projectId,filters={}){
    if(data.bootstrapView!=='board'||data.boardPageInfo?.projectId!==projectId)return false;
    if(filters.search||filters.blocked||(filters.trackIds??[]).length||(filters.epicIds??[]).length||(filters.assigneeIds??[]).length)return false;
    if(data.boardPageInfo.filters?.doneOrder!==boardFilters(filters).doneOrder)return false;
    supersedeBoard(boardTarget(projectId,boardFilters(filters)));
    remember({projectId,filters:boardFilters(filters),pages:data.boardPageInfo.pages});
    onBoard(boardState);return true;
  }

  async function board(projectId,filters={},options={}){
    const common=boardFilters(filters),target=boardTarget(projectId,common);
    const loaded=(state=boardState)=>state?.projectId===projectId&&JSON.stringify(state.filters)===JSON.stringify(common);
    if(options.skipUnchanged&&loaded()&&!boardDirty&&boardState.stamp===stamp()){
      // A live patch of these cards may still be running; it repaints when it lands.
      supersedeBoard(target);
      data.tasks.splice(0,data.tasks.length,...data.tasks.filter(task=>task.projectId!==projectId||boardState.ids.has(task.internalId)));
      onBoard(boardState);return {stale:false,state:boardState,unchanged:true};
    }
    return read('board',target,!!options.background,async token=>{
      const started=stamp();
      try{
        const response=await api.boardView(projectId,common,{signal:token.signal,background:options.background});
        if(!current(token))return {stale:true};
        const pages=[response.planning,response.inProgress,response.inReview,response.done];
        const depths=loaded()?{...boardState.depths}:Object.fromEntries(STATUSES.map(status=>[status,1]));
        // A real reconcile rebuilds only the previously loaded depth, using the
        // server's bounded pages. Ordinary task hints use patchBoard instead.
        // A write during this read makes its deeper cursors stale; the column then keeps the pages it has.
        await Promise.all(pages.map(async(page,index)=>{let depth=1;while(depth<(depths[STATUSES[index]]??1)&&page.nextCursor){let next;try{next=await api.board(projectId,{...common,status:wireStatus(STATUSES[index]),cursor:page.nextCursor},{signal:token.signal,background:options.background});}catch(error){if(error?.code!=='cursor_stale')throw error;break;}page.items.push(...next.items);page.nextCursor=next.nextCursor;depth++;}depths[STATUSES[index]]=depth;}));
        if(!current(token))return {stale:true};
        replaceBoardTasks(data,projectId,pages.flatMap((page)=>page.items));
        const pageMap=Object.fromEntries(STATUSES.map((status,index)=>[status,{nextCursor:pages[index].nextCursor,total:Number(pages[index].total??0)}]));
        // Cards read before a newer projection are not reused as current.
        remember({projectId,filters:common,pages:pageMap,depths},started);
        setBoardPageInfo(data,projectId,common,pageMap);
        setProjectTaskCounts(data,projectId,{planning:response.counts.planning,progress:response.counts.inProgress,review:response.counts.inReview,done:response.counts.done,blocked:response.counts.blocked});
        onBoard(boardState);return {stale:false,state:boardState};
      }catch(error){if(ignored(token,error))return {stale:true};boardLost(token);onError(error);throw error;}
    },boardLost);
  }

  async function patchBoard(projectId,filters,hints){
    const pendingEpoch=epoch;
    while(boardPageRead){await boardPageRead;if(pendingEpoch!==epoch)return {stale:true};}
    const common=boardFilters(filters),target=boardTarget(projectId,common);
    // Wait for a Board read someone started, then patch the cards it loaded.
    for(let active=slots.get('board');active&&!active.done&&!active.background;active=slots.get('board'))await active.promise?.catch(()=>{});
    if(pendingEpoch!==epoch)return {stale:true};
    if(!boardState)return board(projectId,filters,{background:true});
    // The Board now shows other cards, loaded after this change; the hint is moot.
    if(boardState.projectId!==projectId||JSON.stringify(boardState.filters)!==JSON.stringify(common))return {stale:true};
    if(boardState.stamp!==stamp())return board(projectId,filters,{background:true});
    const ids=[...new Set(hints.map(hint=>hint.taskId??hint.entityId).filter(Boolean))];
    return read('board',target,true,async token=>{
      try{
        const filtered=common.search||common.blocked||common.trackIds.length||common.epicIds.length||common.assigneeIds.length||common.noAssignee;
        const [tasks,counts,head]=await Promise.all([
          Promise.all(ids.map(async id=>{try{return {id,view:await api.task(id,{signal:token.signal,background:true})};}catch(error){if(error?.status===404)return {id,view:null};throw error;}})),
          api.counts(projectId,{signal:token.signal,background:true}),
          filtered?api.boardView(projectId,common,{signal:token.signal,background:true}):null,
        ]);
        if(!current(token)||boardState?.projectId!==projectId)return {stale:true};
        for(const {id,view} of tasks){
          const old=data.tasks.find(item=>item.internalId===id);
          const status=view&&({in_progress:'progress',in_review:'review'}[view.status]??view.status);
          const page=boardState.pages[status];
          const loaded=data.tasks.filter(item=>item.projectId===projectId&&item.state===status);
          const edge=loaded.sort((left,right)=>compareTaskOrder(left,right,common.doneOrder)).at(-1);
          const parent=view&&data.epics.find(item=>item.id===view.epicId);
          const matches=view&&view.projectId===projectId&&
            (!common.search||view.title.toLowerCase().includes(common.search.toLowerCase())||view.taskKey.toLowerCase().includes(common.search.toLowerCase()))&&
            (!common.trackIds.length||common.trackIds.includes(parent?.trackId))&&
            (!common.epicIds.length||common.epicIds.includes(view.epicId))&&
            (!(common.assigneeIds.length||common.noAssignee)||view.assigneeIds.some(id=>common.assigneeIds.includes(id))||common.noAssignee&&!view.assigneeIds.length)&&
            (!common.blocked||!!view.activeBlock);
          if(matches&&page&&(!page.nextCursor||edge&&compareTaskOrder({order:view.position,internalId:view.id,state:status,completedAt:secondsToMilliseconds(view.completedAt)??null},edge,common.doneOrder)<=0))appendBoardTasks(data,[view]);
          else if(old)data.tasks.splice(data.tasks.indexOf(old),1);
        }
        const mapped={planning:counts.planning,progress:counts.inProgress,review:counts.inReview,done:counts.done,blocked:counts.blocked};
        setProjectTaskCounts(data,projectId,mapped);
        // Filtered totals require the authoritative bounded Board response. Keep
        // the loaded window and cursors; this read does not replace its cards.
        if(head){
          for(const [index,status] of STATUSES.entries())boardState.pages[status].total=[head.planning,head.inProgress,head.inReview,head.done][index].total;
        }else for(const status of STATUSES)boardState.pages[status].total=mapped[status];
        boardState.ids=new Set(data.tasks.filter(task=>task.projectId===projectId).map(task=>task.internalId));
        setBoardPageInfo(data,projectId,common,boardState.pages);onBoard(boardState);return {stale:false};
      }catch(error){if(ignored(token,error))return {stale:true};boardLost(token);onError(error);throw error;}
    },boardLost);
  }

  async function counts(projectId,options={}){
    return read(`counts:${projectId}`,'',!!options.background,async token=>{
      try{
        const response=await api.counts(projectId,{signal:token.signal,background:options.background});
        if(!current(token))return {stale:true};
        const result=setProjectTaskCounts(data,projectId,{planning:response.planning,progress:response.inProgress,review:response.inReview,done:response.done,blocked:response.blocked});
        onCounts(result);return {stale:false,counts:result};
      }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
  }

  /** @param {string} status */
  async function moreBoard(status){
    const pendingEpoch=epoch;
    while(boardPageRead){await boardPageRead;if(pendingEpoch!==epoch)return {stale:true};}
    const pending=performMoreBoard(status);boardPageRead=pending;
    try{return await pending;}finally{if(boardPageRead===pending)boardPageRead=null;}
  }

  // The next page extends the loaded cards; a newer Board read replaces them.
  async function performMoreBoard(status){
    const state=boardState,page=state?.pages?.[status],started=epoch;if(!state||!page?.nextCursor)return {done:true};
    const replaced=()=>boardState!==state||started!==epoch;
    try{
      pageController=new AbortController();
      const next=await api.board(state.projectId,{...state.filters,status:wireStatus(status),cursor:page.nextCursor},{signal:pageController.signal});
      if(replaced())return {stale:true};
      appendBoardTasks(data,next.items);for(const item of next.items)state.ids.add(item.id);state.depths[status]=(state.depths[status]??1)+1;page.nextCursor=next.nextCursor;page.total=Number(next.total??page.total);
      setBoardPageInfo(data,state.projectId,state.filters,state.pages);return {done:!next.nextCursor};
    }catch(error){
      if(replaced()||error?.code==='aborted')return {stale:true};
      // A write since the last read moved the cursor: read the Board again, one page deeper in this column.
      if(error?.code==='cursor_stale'){state.depths[status]=(state.depths[status]??1)+1;return board(state.projectId,{...state.filters,assigneeIds:[...state.filters.assigneeIds,...(state.filters.noAssignee?['__unassigned__']:[])]});}
      onError(error);throw error;
    }
  }

  async function roadmap(projectId,options={}){
    return read(`roadmap:${projectId}`,'',!!options.background,async token=>{
      try{const projection=await api.roadmap(projectId,{signal:token.signal,background:options.background});if(!current(token))return {stale:true};replaceRoadmap(data,projection);onRoadmap(projection);return {stale:false};}
      catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
  }

  async function pool(projectId,scope,append=false,cursor,options={}){
    const key=`${projectId}:${scope}`,pageKey=`${projectId}:${scope==='personal'?'mine':'project'}`;
    const settle=()=>{if(data.poolPageInfo[pageKey]?.loading){data.poolPageInfo[pageKey]={...data.poolPageInfo[pageKey],loading:false};onPool(data.poolPageInfo[pageKey]);}};
    return read(`pool:${key}`,append?`more:${cursor}`:'head',!!options.background,async token=>{
      data.poolPageInfo[pageKey]={nextCursor:null,total:0,loaded:false,...data.poolPageInfo[pageKey],loading:true,error:false};
      onPool(data.poolPageInfo[pageKey]);
      try{
        const page=await api.pool(projectId,{scope,cursor,limit:50},{signal:token.signal,background:options.background});if(!current(token))return {stale:true};
        replacePoolPage(data,projectId,scope,page.items,append);setPoolPageInfo(data,projectId,scope,page);
        poolStates.set(key,{projectId,scope,nextCursor:page.nextCursor});onPool(page);return {stale:false,page};
      }catch(error){if(ignored(token,error))return {stale:true};data.poolPageInfo[pageKey]={...data.poolPageInfo[pageKey],loading:false,error:true};onPool(data.poolPageInfo[pageKey]);onError(error);throw error;}
    },token=>{const active=slots.get(token.slot);if(!active||active===token||active.done)settle();});
  }

  async function morePool(projectId,scope){
    const state=poolStates.get(`${projectId}:${scope}`);if(!state?.nextCursor)return {done:true};
    return pool(projectId,scope,true,state.nextCursor).then((result)=>({ ...result,done:!result.page?.nextCursor }));
  }

  async function task(taskId){
    return read(`task:${taskId}`,'',false,async token=>{
      try{const view=await api.task(taskId,{signal:token.signal});if(!current(token))return {stale:true};const mapped=replaceTaskDetail(data,view);onTask(mapped);return {stale:false,task:mapped};}
      catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
  }

  /**
   * The epic's tasks from the first page, until there are at least `count` or
   * none are left. A write while reading makes the next cursor stale; the
   * drawer then keeps the pages read so far.
   * @param {string} epicId @param {number} count @param {Token} token @param {boolean} background
   */
  async function epicTasks(epicId,count,token,background){
    const first=await api.epicTasks(epicId,{limit:50,signal:token.signal,background});
    const items=[...first.items];let nextCursor=first.nextCursor,total=first.total;
    while(items.length<count&&nextCursor){
      let next;
      try{next=await api.epicTasks(epicId,{cursor:nextCursor,limit:50,signal:token.signal,background});}catch(error){if(error?.code!=='cursor_stale')throw error;break;}
      items.push(...next.items);nextCursor=next.nextCursor;total=next.total;
    }
    return {items,nextCursor,total,append:false};
  }

  /**
   * The open epic drawer's tasks and activity, read in one slot. A newer read
   * replaces an older one, but a live read waits for a read someone started
   * and Load more waits for a live read, so neither cancels the other. A live
   * read shows as many tasks as the drawer did, read again from the first.
   */
  async function epic(epicId,{tasks=true,activity=true,appendTasks=false,appendActivity=false,background=false}={}){
    if(appendTasks||appendActivity)for(let active=slots.get('epic');active&&!active.done&&active.background;active=slots.get('epic'))await active.promise?.catch(()=>{});
    const shown=data.epicPageInfo[epicId];
    return read('epic',JSON.stringify([epicId,tasks,activity,appendTasks&&shown?.tasksCursor,appendActivity&&shown?.activityCursor]),background,async token=>{
      const page=data.epicPageInfo[epicId],count=page?.taskIds?.length??0;
      // Load more extends the tasks shown; a write since they were read makes
      // its cursor stale, and then the drawer reads them again with more.
      const readTasks=async()=>{
        if(!appendTasks)return epicTasks(epicId,background?count:0,token,background);
        try{return {...await api.epicTasks(epicId,{cursor:page?.tasksCursor,limit:50,signal:token.signal,background}),append:true};}
        catch(error){if(error?.code!=='cursor_stale')throw error;return epicTasks(epicId,count+1,token,background);}
      };
      try{
        const [taskPage,activityPage]=await Promise.all([
          tasks?readTasks():null,
          activity?api.epicActivity(epicId,{cursor:appendActivity?page?.activityCursor:undefined,limit:50,signal:token.signal,background}):null,
        ]);
        if(!current(token))return {stale:true};
        if(taskPage)mergeEpicTaskPage(data,epicId,taskPage.items,taskPage,taskPage.append);
        if(activityPage)mergeEpicActivityPage(data,epicId,(activityPage.items??[]).map((item)=>mapActivity(item,data.users)).filter(Boolean),activityPage.nextCursor,appendActivity);
        onEpic(data.epicPageInfo[epicId]);
        return {stale:false,page:data.epicPageInfo[epicId]};
      }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
  }

  function moreEpicTasks(epicId){const page=data.epicPageInfo[epicId];return page?.tasksCursor?epic(epicId,{tasks:true,activity:false,appendTasks:true}):Promise.resolve({done:true});}
  function moreEpicActivity(epicId){const page=data.epicPageInfo[epicId];return page?.activityCursor?epic(epicId,{tasks:false,activity:true,appendActivity:true}):Promise.resolve({done:true});}

  return Object.freeze({
    adoptBoard,board,patchBoard,invalidateBoard(){boardDirty=true;},counts,moreBoard,roadmap,pool,morePool,task,epic,moreEpicTasks,moreEpicActivity,
    /** Settles when the reads someone started before this call have finished. */
    idle(){return Promise.allSettled([...foreground]).then(()=>{});},
    /** Drop every read, for a new session. */
    cancel(){epoch++;for(const token of slots.values())token.controller.abort();slots.clear();pageController.abort();boardState=null;boardDirty=false;poolStates.clear();},
  });
}
