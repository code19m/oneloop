// @ts-check

import { ApiError } from '../data/api-client.js';
import { leaveAdminPage, leaveUnavailableProject } from '../features/recovery/controller.js';
import { boardFiltered, normalizeBoardFilters } from '../data/board-filters.js';
import { toWireScope } from '../data/wire.js';
import { lastSwitch, pageOf, readAddress, rememberSwitch } from './address.js';

/** @typedef {{projectId?:string,taskId?:string|null,view?:string,filters?:ReturnType<typeof normalizeBoardFilters>}&Record<string,any>} BootstrapScope */

/**
 * What the bootstrap loads for an address, with `scope` over it: a task
 * page's task; or the project the address names, else the one on screen,
 * with the Board's first pages for the address's filters, the Roadmap or
 * metadata only. The filters belong to the address's page, so a load that
 * names another project or page, as a project switch does, leaves them out.
 * @param {string} hash @param {any} app @param {Record<string,any>} [scope]
 * @returns {BootstrapScope}
 */
export function routeScope(hash, app, scope = {}) {
  const {page,projectId,taskId,filters}=readAddress(hash);
  if(page==='task')return {taskId,view:'task',...scope};
  const project=projectId??app?.context().projectId;
  const view=page==='board'?'board':page==='roadmap'?'roadmap':'metadata';
  const shown=project?{projectId:project,view}:{view},next={...shown,...scope};
  const samePage=scope.view===undefined&&next.projectId===shown.projectId;
  return samePage&&view==='board'&&boardFiltered(filters)?{...next,filters:normalizeBoardFilters(filters)}:next;
}

/**
 * Load the projection as someone signs in, for the page the tab shows. An
 * address that names no project, with none on screen, opens the project of
 * the last switch in this browser, which the server opens only for the
 * person who made it and while they can open it; when it can't, their switch
 * is forgotten. A task they can't open loads only metadata, and a project
 * that the address names but they can't open loads the first project
 * instead: the address then shows Page not found.
 * @param {{bootstrap:any,api:any,data:any,getApp:()=>any,location?:{hash:string}}} options
 */
export function createSignInLoad({ bootstrap, api, data, getApp, location = globalThis.location }) {
  /** @type {{key:string,response:Promise<any>}|null} */ let early = null;
  /** The scope of the page the tab shows, with the last switch when the page names no project. */
  const withSwitch = (/** @type {BootstrapScope} */ scope) => {
    const last = lastSwitch();
    return last && !scope.projectId && !scope.taskId ? { ...scope, lastSwitch: last } : scope;
  };
  return Object.freeze({
    /**
     * Start the first load's read while the page checks the session. Both
     * answer for the same cookie, so neither waits for the other, and the
     * server answers for whoever signed in. The load uses the read if it
     * still asks for the same page, and a session change drops it.
     */
    prefetch() {
      const scope = routeScope(location.hash, getApp());
      early = { key: JSON.stringify(scope), response: api.bootstrap(withSwitch(scope)) };
      early.response.catch(() => {});
    },
    /** A session change drops the early read. */
    sessionChanged() { early = null; },
    async load() {
      const person = data.session?.userId, last = lastSwitch(), scope = routeScope(location.hash, getApp());
      const first = early?.key === JSON.stringify(scope) ? { ...scope, response: early.response } : withSwitch(scope);
      early = null;
      try {
        const loaded = await bootstrap.load(first), opened = loaded?.projection?.selectedProjectId;
        // Another project opened than the one of this person's switch: they can no longer open it.
        if (person && last?.userId === person && !scope.projectId && !scope.taskId && opened && opened !== last.projectId) rememberSwitch(person, null);
        return loaded;
      } catch (error) {
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
    // A bootstrap's answer still fits while its page shows; a newer bootstrap drops it by itself.
    const stillShown=()=>requestedScope===projectionScope();
    const complete=(result)=>{
      if(requestIsCurrent()&&!result?.stale){recovery?.refreshSucceeded();app?.updateDocumentTitle();}
      return result;
    };
    try{
      const previous=app?.context(),previousName=data.projects.find((item)=>item.id===previous?.projectId)?.name;
      if(scope.viewOnly&&app&&previous?.projectId&&data.projects.some((item)=>item.id===previous.projectId)){
        // Hints of tasks, their blocks and checklists patch their cards. A
        // column that was re-spaced moved cards no hint names, so the Board
        // reads its cards again.
        if(previous.view==='board')return complete(scope.hints?.every(hint=>['task','task_block','checklist'].includes(hint.entityType)&&!hint.respaced)?await reads.patchBoard(previous.projectId,previous.board,scope.hints):await reads.board(previous.projectId,previous.board,{background:!!scope.background}));
        if(previous.view==='roadmap'){
          // Hints of tasks and their blocks name what changed in the lanes,
          // which read those tasks again with their counts. An open epic
          // drawer lists tasks, so it reads them again too. A live read waits
          // for a Load more someone started instead of cancelling it.
          const named=scope.hints?.every(hint=>['task','task_block'].includes(hint.entityType)&&!hint.respaced&&(hint.taskId??hint.entityId))?scope.hints.map(hint=>hint.taskId??hint.entityId):null;
          const views=[named?reads.patchRoadmap(previous.projectId,named,{background:!!scope.background}):reads.roadmap(previous.projectId,{background:!!scope.background})];
          if(previous.peek&&data.epics.some((item)=>item.id===previous.peek))views.push(reads.epic(previous.peek,{background:!!scope.background}));
          const results=await Promise.all(views);
          return complete(results.find((result)=>result?.stale)??results[0]);
        }
      }
      let loaded,destinationError;
      try { loaded=await bootstrap.load({...routeScope(location.hash,app,scope),isCurrent:stillShown}); }
      catch(error) {
        if (!(error instanceof ApiError) || ![403,404].includes(error.status) || !requestIsCurrent()) throw error;
        destinationError=error;
        loaded=await bootstrap.load({view:'board',background:!!scope.background,isCurrent:stillShown});
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
        // A Board bootstrap carries the first page of each column for its filters.
        if(!reads.adoptBoard(current.projectId,current.board))windows.push(reads.board(current.projectId,current.board,readOptions));
      }
      else if(current.view==='roadmap')app.refreshRoadmap();
      else if(bridge&&['profile','users','settings'].includes(current.view))windows.push(bridge.loadCurrentRoute({refresh:true,background:!!scope.background}));
      else if(data.projects.some((item)=>item.id===current.projectId)){app.refreshCounts();if(current.view==='task')app.refreshTask(current.taskId);}
      else app.refresh();
      const results=await Promise.all(windows);
      return complete(results.find(result=>result?.stale)??loaded);
    }catch(error){
      if(scope.background&&requestIsCurrent())recovery?.refreshFailed(error);
      throw error;
    }
  };
}
