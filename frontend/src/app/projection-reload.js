// @ts-check

import { ApiError } from '../data/api-client.js';
import { leaveAdminPage, leaveUnavailableProject } from '../features/recovery/controller.js';

/**
 * The bootstrap view for the current address: the task, the Board, the
 * Roadmap or metadata only.
 * @param {string} hash @param {any} app
 */
export function routeScope(hash, app) {
  const route=hash.replace(/^#\/?/,'');
  if(route.startsWith('task/')){
    try{return {taskId:decodeURIComponent(route.slice(5)),view:'task'};}catch{return {view:'metadata'};}
  }
  const filters=app?.context?.().board;
  const filtered=filters&&(filters.search||filters.blocked||filters.trackIds?.length||filters.epicIds?.length||filters.assigneeIds?.length);
  return {view:route==='board'&&!filtered?'board':route==='roadmap'||!route?'roadmap':'metadata'};
}

/**
 * Load the projection as someone signs in: the page the tab shows, in the
 * project it showed when the last session ended, so the project switcher and
 * the loaded work agree. A task they can't open loads only metadata, and a
 * project they can't open loads the default project.
 * @param {{bootstrap:any,getApp:()=>any,location?:{hash:string}}} options
 */
export function createSignInLoad({ bootstrap, getApp, location = globalThis.location }) {
  /** @type {string|undefined} */ let shown;
  return Object.freeze({
    /** Remember the project on screen as a session ends. */
    sessionEnded() { shown = getApp()?.context?.().projectId ?? undefined; },
    async load() {
      const scope = routeScope(location.hash, getApp());
      try { return await bootstrap.load(shown ? { projectId: shown, ...scope } : scope); }
      catch (error) {
        if (!(error instanceof ApiError) || ![403, 404].includes(error.status)) throw error;
        if (scope.taskId) return bootstrap.load({ view: 'metadata' });
        if (shown) return bootstrap.load(scope);
        throw error;
      }
    },
  });
}

/**
 * Reload the projection and every window the page shows beyond it. A live
 * (background) refresh never interrupts a load someone started: it waits for
 * that load, then refreshes whatever is shown by then.
 * @param {{data:any,bootstrap:any,reads:any,getApp:()=>any,getBridge:()=>any,getRecovery:()=>any,location?:{hash:string}}} options
 */
export function createProjectionReload({ data, bootstrap, reads, getApp, getBridge, getRecovery, location = globalThis.location }) {
  let projectionGeneration=0;
  const projectionScope=()=>{
    const context=getApp()?.context?.()??{};
    return JSON.stringify([data.session?.id,data.session?.userId,location.hash,context.view,context.projectId,context.taskId]);
  };

  return async function reloadProjection(scope={}){
    const app=getApp(),recovery=getRecovery();
    if(scope.background){
      await bootstrap.idle();
      await reads.idle();
      // A change in a project that is no longer shown needs no refresh.
      if(scope.projectId&&scope.projectId!==app?.context?.().projectId)return {stale:true};
    }
    const generation=++projectionGeneration,requestedScope=projectionScope();
    const requestIsCurrent=()=>generation===projectionGeneration&&requestedScope===projectionScope();
    const complete=(result)=>{
      if(requestIsCurrent()&&!result?.stale){recovery?.refreshSucceeded();app?.updateDocumentTitle?.();}
      return result;
    };
    try{
      const previous=app?.context?.(),previousName=data.projects.find((item)=>item.id===previous?.projectId)?.name;
      if(scope.viewOnly&&app&&previous?.projectId&&data.projects.some((item)=>item.id===previous.projectId)){
        if(previous.view==='board')return complete(scope.hints?.every(hint=>['task','task_block'].includes(hint.entityType))?await reads.patchBoard(previous.projectId,previous.board,scope.hints):await reads.board(previous.projectId,previous.board,{background:!!scope.background}));
        if(previous.view==='roadmap'){
          // An open epic drawer lists tasks, so it reads them again too. A
          // live read waits for a Load more someone started instead of
          // cancelling it.
          const views=[reads.roadmap(previous.projectId,{background:!!scope.background})];
          if(previous.peek&&data.epics.some((item)=>item.id===previous.peek))views.push(reads.epic(previous.peek,{background:!!scope.background}));
          const results=await Promise.all(views);
          return complete(results.find((result)=>result?.stale)??results[0]);
        }
      }
      let loaded,destinationError;
      try { loaded=await bootstrap.load({projectId:app?.context?.().projectId,...routeScope(location.hash,app),...scope}); }
      catch(error) {
        if (!(error instanceof ApiError) || ![403,404].includes(error.status) || !requestIsCurrent()) throw error;
        destinationError=error;
        loaded=await bootstrap.load({view:'board',background:!!scope.background});
      }
      if(loaded?.stale||!app)return loaded;
      if(leaveUnavailableProject(data,app,previous,previousName)||leaveAdminPage(data,app,previous))return loaded;
      if(destinationError){
        // A caller that opens something from another page reports it there instead.
        if(scope.routeErrors===false)return {...loaded,unavailable:true};
        recovery?.handleRouteError(destinationError,{background:!!scope.background});return loaded;
      }
      const current=app.context(),bridge=getBridge();
      const readOptions={background:!!scope.background};
      // The bootstrap replaces only its own projection. Reload every window
      // shown beyond it: the Board cards, the open Pool scope, the open epic
      // drawer and the loaded account pages.
      const windows=[];
      if(current.modal?.type==='pool'||current.modal?.poolId)windows.push(reads.pool(current.projectId,current.poolTab==='project'?'team':'personal',false,undefined,readOptions));
      if(current.peek&&data.epics.some((item)=>item.id===current.peek))windows.push(reads.epic(current.peek,readOptions));
      if(current.view==='board'&&data.projects.some((item)=>item.id===current.projectId)){
        windows.push(reads.board(current.projectId,current.board,readOptions));
      }
      else if(current.view==='roadmap')app.refreshRoadmap();
      else if(bridge&&['profile','users','settings'].includes(current.view))windows.push(bridge.loadCurrentRoute({refresh:true,background:!!scope.background}));
      else if(data.projects.some((item)=>item.id===current.projectId)){app.refreshCounts();if(current.view==='task')app.refreshBackground();}
      else app.refresh();
      const results=await Promise.all(windows);
      return complete(results.find(result=>result?.stale)??loaded);
    }catch(error){
      if(scope.background&&requestIsCurrent())recovery?.refreshFailed(error);
      throw error;
    }
  };
}
