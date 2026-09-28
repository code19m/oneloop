// @ts-check

import {
  appendBoardTasks, mergeEpicActivityPage, mergeEpicTaskPage, replaceBoardTasks, replacePoolPage, replaceRoadmap, replaceTaskDetail,
  setBoardPageInfo, setPoolPageInfo, setProjectTaskCounts, wireStatus,
} from './projection-store.js';
import {mapActivity} from './activity-mapper.js';

const STATUSES=['planning','progress','review','done'];
function boardFilters(filters={}){
  return {limit:50,search:String(filters.search??'').trim()||undefined,trackIds:[...(filters.trackIds??[])].sort(),epicIds:[...(filters.epicIds??[])].sort(),assigneeIds:(filters.assigneeIds??[]).filter(id=>id!=='__unassigned__').sort(),noAssignee:(filters.assigneeIds??[]).includes('__unassigned__')||undefined,blocked:filters.blocked||undefined};
}

export function createReadController({api,data,onBoard=(_state)=>{},onRoadmap=(_projection)=>{},onPool=(_page)=>{},onTask=(_task)=>{},onEpic=(_page)=>{},onCounts=(_counts)=>{},onError=(_error)=>{}}){
  let generation=0,controller=null;
  let epicGeneration=0,epicController=null;
  let boardState=null,boardDirty=false;
  /** @type {Promise<any>|null} */ let boardPageRead=null;
  const stamp=()=>JSON.stringify([data.session?.id,data.session?.userId,data.projectionGeneration??0]);
  const remember=(state)=>{state.stamp=stamp();state.ids=new Set(data.tasks.filter(task=>task.projectId===state.projectId).map(task=>task.internalId));state.depths??=Object.fromEntries(STATUSES.map(status=>[status,1]));boardState=state;boardDirty=false;};
  const poolStates=new Map();
  const begin=()=>{generation++;controller?.abort();controller=new AbortController();return {generation,signal:controller.signal};};
  const current=(token)=>token.generation===generation;
  const ignored=(token,error)=>!current(token)||error?.code==='aborted';
  function adoptBoard(projectId,filters={}){
    if(data.bootstrapView!=='board'||data.boardPageInfo?.projectId!==projectId)return false;
    if(filters.search||filters.blocked||(filters.trackIds??[]).length||(filters.epicIds??[]).length||(filters.assigneeIds??[]).length)return false;
    remember({projectId,filters:boardFilters(filters),pages:data.boardPageInfo.pages});
    onBoard(boardState);return true;
  }

  async function board(projectId,filters={},options={}){
    const token=begin();
    const common=boardFilters(filters);
    const same=boardState?.projectId===projectId&&JSON.stringify(boardState.filters)===JSON.stringify(common);
    if(options.skipUnchanged&&same&&!boardDirty&&boardState.stamp===stamp()){
      data.tasks.splice(0,data.tasks.length,...data.tasks.filter(task=>task.projectId!==projectId||boardState.ids.has(task.internalId)));
      onBoard(boardState);return {stale:false,state:boardState,unchanged:true};
    }
    try{
      const response=await api.boardView(projectId,common,{signal:token.signal,background:options.background});
      if(!current(token))return {stale:true};
      const pages=[response.planning,response.inProgress,response.inReview,response.done];
      const depths=same?{...boardState.depths}:Object.fromEntries(STATUSES.map(status=>[status,1]));
      // A real reconcile rebuilds only the previously loaded depth, using the
      // server's bounded pages. Ordinary task hints use patchBoard instead.
      await Promise.all(pages.map(async(page,index)=>{let depth=1;while(depth<(depths[STATUSES[index]]??1)&&page.nextCursor){const next=await api.board(projectId,{...common,status:wireStatus(STATUSES[index]),cursor:page.nextCursor},{signal:token.signal,background:options.background});page.items.push(...next.items);page.nextCursor=next.nextCursor;depth++;}depths[STATUSES[index]]=depth;}));
      if(!current(token))return {stale:true};
      replaceBoardTasks(data,projectId,pages.flatMap((page)=>page.items));
      const pageMap=Object.fromEntries(STATUSES.map((status,index)=>[status,{nextCursor:pages[index].nextCursor,total:Number(pages[index].total??0)}]));
      remember({projectId,filters:common,pages:pageMap,depths});
      setBoardPageInfo(data,projectId,common,pageMap);
      setProjectTaskCounts(data,projectId,{planning:response.counts.planning,progress:response.counts.inProgress,review:response.counts.inReview,done:response.counts.done,blocked:response.counts.blocked});
      onBoard(boardState);return {stale:false,state:boardState};
    }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
  }

  async function patchBoard(projectId,filters,hints){
    const pendingGeneration=generation;
    while(boardPageRead){await boardPageRead;if(pendingGeneration!==generation)return {stale:true};}
    const common=boardFilters(filters);
    if(!boardState||boardState.projectId!==projectId||boardState.stamp!==stamp()||JSON.stringify(boardState.filters)!==JSON.stringify(common))return board(projectId,filters,{background:true});
    const token=begin();
    const ids=[...new Set(hints.map(hint=>hint.taskId??hint.entityId).filter(Boolean))];
    try{
      const filtered=common.search||common.blocked||common.trackIds.length||common.epicIds.length||common.assigneeIds.length||common.noAssignee;
      const [tasks,counts,head]=await Promise.all([
        Promise.all(ids.map(async id=>{try{return {id,view:await api.task(id,{signal:token.signal,background:true})};}catch(error){if(error?.status===404)return {id,view:null};throw error;}})),
        api.counts(projectId,{signal:token.signal,background:true}),
        filtered?api.boardView(projectId,common,{signal:token.signal,background:true}):null,
      ]);
      if(!current(token))return {stale:true};
      for(const {id,view} of tasks){
        const old=data.tasks.find(item=>item.internalId===id);
        const status=view&&({in_progress:'progress',in_review:'review'}[view.status]??view.status);
        const page=boardState.pages[status];
        const loaded=data.tasks.filter(item=>item.projectId===projectId&&item.state===status);
        const edge=Math.max(-Infinity,...loaded.map(item=>item.order??0));
        const parent=view&&data.epics.find(item=>item.id===view.epicId);
        const matches=view&&view.projectId===projectId&&
          (!common.search||view.title.toLowerCase().includes(common.search.toLowerCase())||view.taskKey.toLowerCase().includes(common.search.toLowerCase()))&&
          (!common.trackIds.length||common.trackIds.includes(parent?.trackId))&&
          (!common.epicIds.length||common.epicIds.includes(view.epicId))&&
          (!(common.assigneeIds.length||common.noAssignee)||view.assigneeIds.some(id=>common.assigneeIds.includes(id))||common.noAssignee&&!view.assigneeIds.length)&&
          (!common.blocked||!!view.activeBlock);
        if(matches&&page&&(!page.nextCursor||view.position<=edge))appendBoardTasks(data,[view]);
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
    }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
  }

  async function counts(projectId,options={}){
    const token=begin();
    try{
      const response=await api.counts(projectId,{signal:token.signal,background:options.background});
      if(!current(token))return {stale:true};
      const result=setProjectTaskCounts(data,projectId,{planning:response.planning,progress:response.inProgress,review:response.inReview,done:response.done,blocked:response.blocked});
      onCounts(result);return {stale:false,counts:result};
    }catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}
  }

  /** @param {string} status */
  async function moreBoard(status){
    const pendingGeneration=generation;
    while(boardPageRead){await boardPageRead;if(pendingGeneration!==generation)return {stale:true};}
    const pending=performMoreBoard(status);boardPageRead=pending;
    try{return await pending;}finally{if(boardPageRead===pending)boardPageRead=null;}
  }

  async function performMoreBoard(status){
    const state=boardState,page=state?.pages?.[status];if(!state||!page?.nextCursor)return {done:true};
    const token={generation,signal:controller?.signal};
    try{
      const next=await api.board(state.projectId,{...state.filters,status:wireStatus(status),cursor:page.nextCursor},{signal:token.signal});
      if(!current(token))return {stale:true};
      appendBoardTasks(data,next.items);for(const item of next.items)state.ids.add(item.id);state.depths[status]=(state.depths[status]??1)+1;page.nextCursor=next.nextCursor;page.total=Number(next.total??page.total);
      setBoardPageInfo(data,state.projectId,state.filters,state.pages);return {done:!next.nextCursor};
    }catch(error){if(ignored(token,error))return {stale:true};if(error?.code==='cursor_stale'){boardState=null;return board(state.projectId,{...state.filters,assigneeIds:[...state.filters.assigneeIds,...(state.filters.noAssignee?['__unassigned__']:[])]});}onError(error);throw error;}
  }

  async function roadmap(projectId,options={}){const token=begin();try{const projection=await api.roadmap(projectId,{signal:token.signal,background:options.background});if(!current(token))return {stale:true};replaceRoadmap(data,projection);onRoadmap(projection);return {stale:false};}catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}}

  async function pool(projectId,scope,append=false,cursor){
    const token=begin(),key=`${projectId}:${scope}`;
    const pageKey=`${projectId}:${scope==='personal'?'mine':'project'}`;
    data.poolPageInfo[pageKey]={nextCursor:null,total:0,loaded:false,...data.poolPageInfo[pageKey],loading:true,error:false};
    onPool(data.poolPageInfo[pageKey]);
    try{
      const page=await api.pool(projectId,{scope,cursor,limit:50},{signal:token.signal});if(!current(token))return {stale:true};
      replacePoolPage(data,projectId,scope,page.items,append);setPoolPageInfo(data,projectId,scope,page);
      poolStates.set(key,{projectId,scope,nextCursor:page.nextCursor});onPool(page);return {stale:false,page};
    }catch(error){if(ignored(token,error))return {stale:true};data.poolPageInfo[pageKey]={...data.poolPageInfo[pageKey],loading:false,error:true};onPool(data.poolPageInfo[pageKey]);onError(error);throw error;}
  }

  async function morePool(projectId,scope){
    const state=poolStates.get(`${projectId}:${scope}`);if(!state?.nextCursor)return {done:true};
    return pool(projectId,scope,true,state.nextCursor).then((result)=>({ ...result,done:!result.page?.nextCursor }));
  }

  async function task(taskId){const token=begin();try{const view=await api.task(taskId,{signal:token.signal});if(!current(token))return {stale:true};const mapped=replaceTaskDetail(data,view);onTask(mapped);return {stale:false,task:mapped};}catch(error){if(ignored(token,error))return {stale:true};onError(error);throw error;}}

  async function epic(epicId,{tasks=true,activity=true,appendTasks=false,appendActivity=false,background=false}={}){
    epicController?.abort?.();
    epicController=new AbortController();
    const token={generation:++epicGeneration,signal:epicController.signal};
    const currentEpic=()=>token.generation===epicGeneration;
    const page=data.epicPageInfo[epicId];
    try{
      const [taskPage,activityPage]=await Promise.all([
        tasks?api.epicTasks(epicId,{cursor:appendTasks?page?.tasksCursor:undefined,limit:50,signal:token.signal,background}):null,
        activity?api.epicActivity(epicId,{cursor:appendActivity?page?.activityCursor:undefined,limit:50,signal:token.signal,background}):null,
      ]);
      if(!currentEpic())return {stale:true};
      if(taskPage)mergeEpicTaskPage(data,epicId,taskPage.items,taskPage,appendTasks);
      if(activityPage)mergeEpicActivityPage(data,epicId,(activityPage.items??[]).map((item)=>mapActivity(item,data.users)).filter(Boolean),activityPage.nextCursor,appendActivity);
      onEpic(data.epicPageInfo[epicId]);
      return {stale:false,page:data.epicPageInfo[epicId]};
    }catch(error){if(!currentEpic()||error?.code==='aborted')return {stale:true};if(error?.code==='cursor_stale'&&appendTasks)return epic(epicId,{tasks,activity,appendTasks:false,appendActivity,background});onError(error);throw error;}
  }

  function moreEpicTasks(epicId){const page=data.epicPageInfo[epicId];return page?.tasksCursor?epic(epicId,{tasks:true,activity:false,appendTasks:true}):Promise.resolve({done:true});}
  function moreEpicActivity(epicId){const page=data.epicPageInfo[epicId];return page?.activityCursor?epic(epicId,{tasks:false,activity:true,appendActivity:true}):Promise.resolve({done:true});}

  return Object.freeze({adoptBoard,board,patchBoard,invalidateBoard(){boardDirty=true;},counts,moreBoard,roadmap,pool,morePool,task,epic,moreEpicTasks,moreEpicActivity,cancel({preserveBoard=false}={}){generation++;epicGeneration++;controller?.abort();epicController?.abort();if(!preserveBoard)boardState=null;poolStates.clear();}});
}
