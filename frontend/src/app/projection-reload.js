// @ts-check

import { ApiError } from '../data/api-client.js';
import { leaveAdminPage, leaveUnavailableProject } from '../features/recovery/controller.js';
import { boardFiltered } from '../data/board-filters.js';
import { toWireScope } from '../data/wire.js';
import { lastSwitch, pageOf, readAddress, rememberSwitch } from './address.js';

/**
 * What the bootstrap loads for an address: a task page's task; or the project
 * the address names, else the one on screen, with the Board's first pages, the
 * Roadmap or metadata only. A filtered Board reads its cards afterwards, so it
 * never shows the unfiltered ones first.
 * @param {string} hash @param {any} app
 */
export function routeScope(hash, app) {
  const {page,projectId,taskId,filters}=readAddress(hash);
  if(page==='task')return {taskId,view:'task'};
  const project=projectId??app?.context().projectId;
  const view=page==='board'&&!boardFiltered(filters)?'board':page==='roadmap'?'roadmap':'metadata';
  return project?{projectId:project,view}:{view};
}

/**
 * Load the projection as someone signs in, for the page the tab shows. An
 * address that names no project, with none on screen, opens the project of
 * the last switch in this browser, but only for the person who made it. A
 * task they can't open loads only metadata, and a project they can't open
 * loads the first project instead: an address that names it then shows Page
 * not found, and their own switch to it is forgotten.
 * @param {{bootstrap:any,api:any,data:any,getApp:()=>any,location?:{hash:string}}} options
 */
export function createSignInLoad({ bootstrap, api, data, getApp, location = globalThis.location }) {
  /** @type {{key:string,response:Promise<any>}|null} */ let early = null;
  /** The scope of the page the tab shows, with the project of `last`, a switch, when the page names none. */
  const scopeWith = (last) => {
    const scope = routeScope(location.hash, getApp());
    return last && !scope.projectId && !scope.taskId ? { ...scope, projectId: last.projectId } : scope;
  };
  return Object.freeze({
    /**
     * Start the first load's read while the page checks the session. Both
     * answer for the same cookie, so neither waits for the other. The person
     * isn't known yet, so it takes the last switch whoever made it; the load
     * uses the read only if it still asks for the same scope, and a session
     * change drops it.
     */
    prefetch() {
      const scope = scopeWith(lastSwitch());
      early = { key: JSON.stringify(scope), response: api.bootstrap(scope) };
      early.response.catch(() => {});
    },
    /** A session change drops the early read. */
    sessionChanged() { early = null; },
    async load() {
      const person = data.session?.userId, last = lastSwitch();
      // Someone else's switch never opens for this person.
      const scope = scopeWith(last?.userId === person ? last : null);
      const first = early?.key === JSON.stringify(scope) ? { ...scope, response: early.response } : scope;
      early = null;
      try { return await bootstrap.load(first); }
      catch (error) {
        if (!(error instanceof ApiError) || ![403, 404].includes(error.status)) throw error;
        if (scope.taskId) return bootstrap.load({ view: 'metadata' });
        if (!scope.projectId) throw error;
        if (person && last?.projectId === scope.projectId) rememberSwitch(person, null);
        return bootstrap.load({ view: scope.view });
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
    const context=getApp()?.context()??{};
    return JSON.stringify([data.session?.id,data.session?.userId,pageOf(location.hash),context.view,context.projectId,context.taskId]);
  };

  return async function reloadProjection(scope={}){
    const app=getApp(),recovery=getRecovery();
    if(scope.background){
      await bootstrap.idle();
      await reads.idle();
      // A change in a project that is no longer shown needs no refresh.
      if(scope.projectId&&scope.projectId!==app?.context().projectId)return {stale:true};
    }
    const generation=++projectionGeneration,requestedScope=projectionScope();
    const requestIsCurrent=()=>generation===projectionGeneration&&requestedScope===projectionScope();
    const complete=(result)=>{
      if(requestIsCurrent()&&!result?.stale){recovery?.refreshSucceeded();app?.updateDocumentTitle();}
      return result;
    };
    try{
      const previous=app?.context(),previousName=data.projects.find((item)=>item.id===previous?.projectId)?.name;
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
      try { loaded=await bootstrap.load({...routeScope(location.hash,app),...scope}); }
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
      if(current.modal?.type==='pool'||current.modal?.poolId)windows.push(reads.pool(current.projectId,toWireScope(current.poolTab),false,undefined,readOptions));
      if(current.peek&&data.epics.some((item)=>item.id===current.peek))windows.push(reads.epic(current.peek,readOptions));
      if(current.view==='board'&&data.projects.some((item)=>item.id===current.projectId)){
        // A Board bootstrap carries the first page of each column.
        if(!reads.adoptBoard(current.projectId,current.board))windows.push(reads.board(current.projectId,current.board,readOptions));
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
