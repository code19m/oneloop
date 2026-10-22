// @ts-check

import {
  NAMED_TASKS_LIMIT, appendBoardTasks, appendRoadmapDays, changedSections, compareTaskOrder, mapRoadmapMark, sectionKey, mergeEpicActivityPage, mergeEpicTaskPage, replaceBoardTasks, replacePoolPage, replaceRoadmap, replaceTaskDetail,
  setBoardPageInfo, setPoolPageInfo, setProjectTaskCounts,
} from './projection-store.js';
import {byStatus, toLegacyScope, toLegacyStatus, toWireStatus} from './wire.js';
import {mapActivity} from './activity-mapper.js';
import {NO_ASSIGNEE, boardFiltered, matchesBoardFilters, normalizeBoardFilters, sameBoardFilters} from './board-filters.js';

const STATUSES=['planning','progress','review','done'];
function boardFilters(filters={}){
  return {limit:50,...normalizeBoardFilters(filters)};
}

/** @typedef {{slot:string,target:string,background:boolean,epoch:number,projection:number,controller:AbortController,signal:AbortSignal,promise:Promise<any>|null,next:Token|null,done:boolean}} Token */

/**
 * Reads behind the open views. Every read has a slot named after what it
 * loads: the Board, one task, the epic drawer, or a project's counts, Roadmap,
 * Roadmap structure, Roadmap days, list of a Roadmap mark, or Pool scope.
 * A newer read of a slot replaces an older one; when both asked for the same
 * thing, the older caller gets the newer result instead of nothing. Reads of
 * different slots never cancel each other. A background (live) read never
 * replaces a read someone is waiting for: it waits for that read first, and it
 * is dropped when a full refresh landed while it ran. `writes`, the tab's
 * command gateway, runs a live read that replaces a collection, as of the
 * Board, the Roadmap or the Pool, again when it overlapped one of the tab's
 * own changes, which its answer could undo.
 */
export function createReadController({api,data,writes={readUnchanged:(/** @type {()=>Promise<any>} */ read,/** @type {()=>boolean} */ _current)=>read()},onBoard=(_state)=>{},onRoadmap=(_projection)=>{},onPool=(_page)=>{},onTask=(_task)=>{},onEpic=(_page)=>{},onCounts=(_counts)=>{},onError=(_error)=>{}}){
  let epoch=0;
  /** How many changes made elsewhere each lanes of the Roadmap were read for. @type {WeakMap<object,number>} */
  const changesOf=new WeakMap();
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
   * The answer of `ask` for the read of `token`. A live read that ran while
   * this tab moved, added or deleted something may answer from before that
   * change, and would undo it, so it answers only once it overlapped none.
   * @template T @param {Token} token @param {()=>Promise<T>} ask @returns {Promise<T>}
   */
  const answerOf=(token,ask)=>token.background?writes.readUnchanged(ask,()=>current(token)):ask();

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
    const common=boardFilters(filters),loaded=data.boardPageInfo;
    if(data.bootstrapView!=='board'||loaded?.projectId!==projectId)return false;
    // The bootstrap's pages are a Board read's for the filters they name.
    if(!sameBoardFilters(loaded.filters,common))return false;
    // A column that shows more than its first page reads those pages again.
    if(boardState?.projectId===projectId&&Object.values(boardState.depths).some(depth=>depth>1))return false;
    supersedeBoard(boardTarget(projectId,common));
    remember({projectId,filters:common,pages:loaded.pages});
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
      try{
        const attempt=async()=>{
          const started=stamp(),response=await api.boardView(projectId,common,{signal:token.signal,background:options.background});
          if(!current(token))return null;
          const columns=byStatus(response),pages=STATUSES.map(status=>columns[status]);
          const depths=loaded()?{...boardState.depths}:Object.fromEntries(STATUSES.map(status=>[status,1]));
          // A real reconcile rebuilds only the previously loaded depth, using the
          // server's bounded pages. Ordinary task hints use patchBoard instead.
          // A write during this read makes its deeper cursors stale; the column then keeps the pages it has.
          await Promise.all(pages.map(async(page,index)=>{let depth=1;while(depth<(depths[STATUSES[index]]??1)&&page.nextCursor){let next;try{next=await api.board(projectId,{...common,status:toWireStatus(STATUSES[index]),cursor:page.nextCursor},{signal:token.signal,background:options.background});}catch(error){if(error?.code!=='cursor_stale')throw error;break;}page.items.push(...next.items);page.nextCursor=next.nextCursor;depth++;}depths[STATUSES[index]]=depth;}));
          return {started,response,pages,depths};
        };
        const answer=await answerOf(token,attempt);
        if(!answer||!current(token))return {stale:true};
        const {started,response,pages,depths}=answer;
        replaceBoardTasks(data,projectId,pages.flatMap((page)=>page.items));
        const pageMap=Object.fromEntries(STATUSES.map((status,index)=>[status,{nextCursor:pages[index].nextCursor,total:Number(pages[index].total??0)}]));
        // Cards read before a newer projection are not reused as current.
        remember({projectId,filters:common,pages:pageMap,depths},started);
        setBoardPageInfo(data,projectId,common,pageMap);
        setProjectTaskCounts(data,projectId,byStatus(response.counts));
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
    // A checklist change moves no card, so the counts and totals stay.
    const moved=hints.some(hint=>hint.entityType!=='checklist');
    return read('board',target,true,async token=>{
      try{
        const filtered=boardFiltered(common);
        // The cards as the hints left them, read again when the tab changed one meanwhile.
        const [tasks,counts,head]=await answerOf(token,()=>Promise.all([
          Promise.all(ids.map(async id=>{try{return {id,view:await api.task(id,{signal:token.signal,background:true})};}catch(error){if(error?.status===404)return {id,view:null};throw error;}})),
          moved?api.counts(projectId,{signal:token.signal,background:true}):null,
          moved&&filtered?api.boardView(projectId,common,{signal:token.signal,background:true}):null,
        ]));
        if(!current(token)||boardState?.projectId!==projectId)return {stale:true};
        for(const {id,view} of tasks){
          const old=data.tasks.find(item=>item.internalId===id);
          const status=view&&toLegacyStatus(view.status);
          const page=boardState.pages[status];
          const loaded=data.tasks.filter(item=>item.projectId===projectId&&item.state===status);
          const edge=loaded.sort(compareTaskOrder).at(-1);
          const matches=view&&view.projectId===projectId&&matchesBoardFilters({title:view.title,key:view.taskKey,epicId:view.epicId,trackId:view.trackId,assigneeIds:view.assigneeIds,blocked:!!view.activeBlock},common);
          if(matches&&page&&(!page.nextCursor||edge&&compareTaskOrder({order:view.position,internalId:view.id},edge)<=0))appendBoardTasks(data,[view]);
          else if(old)data.tasks.splice(data.tasks.indexOf(old),1);
        }
        if(counts){
          const mapped=byStatus(counts);
          setProjectTaskCounts(data,projectId,mapped);
          // Filtered totals require the authoritative bounded Board response. Keep
          // the loaded window and cursors; this read does not replace its cards.
          if(head){
            const columns=byStatus(head);for(const status of STATUSES)boardState.pages[status].total=columns[status].total;
          }else for(const status of STATUSES)boardState.pages[status].total=mapped[status];
        }
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
        const result=setProjectTaskCounts(data,projectId,byStatus(response));
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
      const next=await api.board(state.projectId,{...state.filters,status:toWireStatus(status),cursor:page.nextCursor},{signal:pageController.signal});
      if(replaced())return {stale:true};
      appendBoardTasks(data,next.items);for(const item of next.items)state.ids.add(item.id);state.depths[status]=(state.depths[status]??1)+1;page.nextCursor=next.nextCursor;page.total=Number(next.total??page.total);
      setBoardPageInfo(data,state.projectId,state.filters,state.pages);return {done:!next.nextCursor};
    }catch(error){
      if(replaced()||error?.code==='aborted')return {stale:true};
      // A write since the last read moved the cursor: read the Board again, one page deeper in this column.
      if(error?.code==='cursor_stale'){state.depths[status]=(state.depths[status]??1)+1;return board(state.projectId,{...state.filters,assigneeIds:[...state.filters.assigneeIds,...(state.filters.noAssignee?[NO_ASSIGNEE]:[])]});}
      onError(error);throw error;
    }
  }

  /**
   * A project's Roadmap with its lanes, in one read: for the days `window`
   * names, else the days its view shows, else the ones it opens with.
   * @param {string} projectId @param {{background?:boolean,window?:{from:string,to:string,anchor?:string}}} [options]
   */
  async function roadmap(projectId,options={}){
    return read(`roadmap:${projectId}`,'',!!options.background,async token=>{
      try{
        const lanes=data.roadmap?.projectId===projectId?data.roadmap:null,window=options.window??lanes?.shown??null;
        // The page reads the lanes, their days and titles itself, as it draws them: never at a person's request.
        const projection=await answerOf(token,()=>api.roadmapLanes(projectId,window,{signal:token.signal,background:true}));
        if(!current(token))return {stale:true};
        replaceRoadmap(data,projection);onRoadmap(projection);return {stale:false};
      }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
  }

  /**
   * What a change to the tasks `ids` changed in the Roadmap's lanes, in one
   * read: those tasks, the lanes' counts, and the work in progress and all
   * the days the lanes hold (as counts alone: the lanes keep the tasks of
   * days with one that they hold) of the sections the change may have
   * changed. Those are
   * the ones the tasks were in, as far as the lanes hold them, and the ones
   * they are in now. A section whose counts of done tasks or plans changed
   * otherwise had a task the lanes didn't hold leave it: a second read gives
   * its days. Lanes of another project, or more tasks than one read names,
   * are read again.
   * @param {string} projectId @param {string[]} ids @param {{background?:boolean}} [options] @param {string[]} [left] sections a change left, for the second read
   */
  async function patchRoadmap(projectId,ids,options={},left=[]){
    const lanes=data.roadmap,named=[...new Set(ids)];
    // Lanes that hold more days than one read of a change covers are read again too.
    const held=lanes?(Date.parse(lanes.window.to)-Date.parse(lanes.window.from))/86400000:0;
    if(lanes?.projectId!==projectId||(!named.length&&!left.length)||named.length>NAMED_TASKS_LIMIT||held>=lanes.limits.changeDays)return roadmap(projectId,options);
    // A read of more days asked for before this change may miss it: it is dropped, and asked for again.
    changesOf.set(lanes,(changesOf.get(lanes)??0)+1);
    // Where the lanes last saw each named task.
    const seen=new Map([...data.tasks.filter((task)=>task.projectId===projectId),...Object.values(lanes.marks),...lanes.late].map((task)=>[task.internalId,sectionKey(task.trackId,task.epicId)]));
    const sections=[...new Set([...named.flatMap((id)=>seen.has(id)?[/** @type {string} */ (seen.get(id))]:[]),...left])];
    const result=await read(`roadmap:${projectId}`,'',!!options.background,async token=>{
      try{
        const before=lanes.sections;
        // The longest overdue come again when a named task is among them: it may have left them.
        const late=named.some((id)=>lanes.late.some((task)=>task.internalId===id))?{late:true}:{};
        const projection=await answerOf(token,()=>api.roadmapLanes(projectId,{...lanes.window,marks:0,tasks:named,sections,...late},{signal:token.signal,background:true}));
        // A newer read of the lanes, such as a bootstrap's, has these changes already.
        if(!current(token)||data.roadmap!==lanes)return {stale:true};
        replaceRoadmap(data,projection,named,sections);onRoadmap(projection);
        const changed=changedSections(projection.lanes,sections);
        const moved=[...new Set([...Object.keys(before),...Object.keys(lanes.sections)])].filter((key)=>!changed.has(key)&&(before[key]?.done!==lanes.sections[key]?.done||before[key]?.planning!==lanes.sections[key]?.planning));
        return {stale:false,moved};
      }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
    if(left.length||!result?.moved?.length)return {stale:!!result?.stale};
    return patchRoadmap(projectId,[],options,result.moved);
  }

  /**
   * A project's tracks, epics and milestones alone, as for a task of another
   * project, or a track or milestone that changed: they move no task.
   * @param {string} projectId @param {{background?:boolean}} [options]
   */
  async function roadmapStructure(projectId,options={}){
    return read(`roadmap-structure:${projectId}`,'',!!options.background,async token=>{
      try{
        const projection=await answerOf(token,()=>api.roadmap(projectId,{signal:token.signal,background:options.background}));
        if(!current(token))return {stale:true};
        replaceRoadmap(data,projection);onRoadmap(projection);return {stale:false};
      }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
  }

  /**
   * More days for the Roadmap's lanes, as the view comes to them: their
   * counts, and the tasks of days with one, nearest `anchor` first. A newer
   * read of the lanes drops it.
   * @param {string} projectId @param {{from:string,to:string,anchor?:string,marks?:number}} days
   */
  async function roadmapDays(projectId,days){
    const lanes=data.roadmap;
    if(lanes?.projectId!==projectId)return {stale:true};
    const changes=changesOf.get(lanes);
    return read(`roadmap:${projectId}:days`,JSON.stringify(days),false,async token=>{
      try{
        const read=await api.roadmapDays(projectId,days,{signal:token.signal,background:true});
        if(!current(token)||data.roadmap!==lanes||changesOf.get(lanes)!==changes)return {stale:true};
        appendRoadmapDays(data,projectId,read);onRoadmap(lanes);return {stale:false,marked:read.marked??null};
      }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
  }

  /**
   * The tasks of one section that a mark counting several stands for: its
   * done tasks or plans of some days, or its work in progress. Nothing is
   * kept; the list shows them.
   * @param {string} projectId @param {{track:string,epic?:string|null,kind:'done'|'plans'|'open',from?:string,to?:string}} query
   */
  async function roadmapList(projectId,query){
    // One list reads at a time: a newer one, or closing it, cancels the one before.
    return read('roadmap-list',JSON.stringify([projectId,query]),false,async token=>{
      try{
        const list=await api.roadmapList(projectId,query,{signal:token.signal});
        if(!current(token))return {stale:true,items:[],total:0};
        return {stale:false,items:list.items.map((/** @type {any} */ view)=>mapRoadmapMark(data,{...view,projectId})),total:list.total};
      }catch(error){if(ignored(token,error))return {stale:true,items:[],total:0};throw error;}
    });
  }
  /** Cancel the list a mark of the Roadmap is reading, as when it closes. */
  function cancelRoadmapList(){const token=slots.get('roadmap-list');if(token&&!token.done){slots.delete('roadmap-list');token.controller.abort();}}

  async function pool(projectId,scope,append=false,cursor,options={}){
    const key=`${projectId}:${scope}`,pageKey=`${projectId}:${toLegacyScope(scope)}`;
    const settle=()=>{if(data.poolPageInfo[pageKey]?.loading){data.poolPageInfo[pageKey]={...data.poolPageInfo[pageKey],loading:false};onPool(data.poolPageInfo[pageKey]);}};
    return read(`pool:${key}`,append?`more:${cursor}`:'head',!!options.background,async token=>{
      data.poolPageInfo[pageKey]={nextCursor:null,total:0,loaded:false,...data.poolPageInfo[pageKey],loading:true,error:false};
      onPool(data.poolPageInfo[pageKey]);
      try{
        const page=await answerOf(token,()=>api.pool(projectId,{scope,cursor,limit:50},{signal:token.signal,background:options.background}));if(!current(token))return {stale:true};
        replacePoolPage(data,projectId,scope,page.items,append);setPoolPageInfo(data,projectId,scope,page);
        poolStates.set(key,{projectId,scope,nextCursor:page.nextCursor});onPool(page);return {stale:false,page};
      }catch(error){if(ignored(token,error))return {stale:true};data.poolPageInfo[pageKey]={...data.poolPageInfo[pageKey],loading:false,error:true};onPool(data.poolPageInfo[pageKey]);onError(error);throw error;}
    },token=>{const active=slots.get(token.slot);if(!active||active===token||active.done)settle();});
  }

  async function morePool(projectId,scope){
    const state=poolStates.get(`${projectId}:${scope}`);if(!state?.nextCursor)return {done:true};
    return pool(projectId,scope,true,state.nextCursor).then((result)=>({ ...result,done:!result.page?.nextCursor }));
  }

  /**
   * Read one task. A task of one of the person's projects on a track or in an
   * epic the projection doesn't have yet, such as a task of another project
   * or one moved to a new epic, reads its project's Roadmap too, and shows
   * again once it can name them.
   */
  async function task(taskId){
    const loaded=await read(`task:${taskId}`,'',false,async token=>{
      try{const view=await api.task(taskId,{signal:token.signal});if(!current(token))return {stale:true};const mapped=replaceTaskDetail(data,view);onTask(mapped);return {stale:false,task:mapped};}
      catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
    const mapped=loaded?.task;
    const placed=(item)=>data.tracks.some((track)=>track.id===item.trackId)&&(!item.epicId||data.epics.some((epic)=>epic.id===item.epicId));
    if(loaded?.stale||!mapped||placed(mapped)||!data.projects.some((project)=>project.id===mapped.projectId))return loaded;
    if((await roadmapStructure(mapped.projectId))?.stale)return {stale:true};
    onTask(mapped);
    return loaded;
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
        if(activityPage)mergeEpicActivityPage(data,epicId,(activityPage.items??[]).map((item)=>mapActivity(item,data.users,data)).filter(Boolean),activityPage.nextCursor,appendActivity);
        onEpic(data.epicPageInfo[epicId]);
        return {stale:false,page:data.epicPageInfo[epicId]};
      }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
    });
  }

  function moreEpicTasks(epicId){const page=data.epicPageInfo[epicId];return page?.tasksCursor?epic(epicId,{tasks:true,activity:false,appendTasks:true}):Promise.resolve({done:true});}
  function moreEpicActivity(epicId){const page=data.epicPageInfo[epicId];return page?.activityCursor?epic(epicId,{tasks:false,activity:true,appendActivity:true}):Promise.resolve({done:true});}

  return Object.freeze({
    adoptBoard,board,patchBoard,invalidateBoard(){boardDirty=true;},counts,moreBoard,roadmap,patchRoadmap,roadmapStructure,roadmapDays,roadmapList,cancelRoadmapList,pool,morePool,task,epic,moreEpicTasks,moreEpicActivity,
    /** Settles when the reads someone started before this call have finished. */
    idle(){return Promise.allSettled([...foreground]).then(()=>{});},
    /** Drop every read, for a new session. */
    cancel(){epoch++;for(const token of slots.values())token.controller.abort();slots.clear();pageController.abort();boardState=null;boardDirty=false;poolStates.clear();},
  });
}
