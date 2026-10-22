// @ts-check

/** The view bridge's page changes: asking before typed text is lost, and loading what each page shows. */

import { pageOf } from '../address.js';

/**
 * @param {import('../view-bridge.js').BridgeContext} ctx
 * @param {ReturnType<typeof import('./account.js').installAccount>} account
 */
export function installRoute(ctx, account) {
  const { app, data, reads, recovery, reloadBootstrap, task, context, sessionScope, nav } = ctx;
  const { loadUsers, loadProfileAccess } = account;
  let projectGeneration=0,routeGeneration=0;

  // Another page discards text typed into this one, so ask first. Drafts and
  // saves that are running carry on, so they don't count.
  const losesInput=()=>!!recovery.hasUnsavedInput({leaving:false});
  /** @param {()=>void} leave @param {()=>void} [stay] */
  const askToDiscard=(leave,stay)=>app.askToDiscard(leave,stay);
  /** Resolves whether the page may change. */
  const mayLeavePage=()=>losesInput()?new Promise((resolve)=>askToDiscard(()=>resolve(true),()=>resolve(false))):Promise.resolve(true);
  // A page change someone asks for, from the sidebar, a menu or a back button.
  // One that must happen, such as leaving a project that is gone, passes
  // `discard`; one that follows the person's own change, such as deleting a
  // task, calls `nav` directly. Neither asks. `projectId` names the page's
  // project when it is another one.
  app.nav=(view,options)=>{
    if(options?.discard||!losesInput())return nav(view,options);
    askToDiscard(()=>nav(view,options));
  };
  document.addEventListener('click',(event)=>{
    const link=/** @type {HTMLAnchorElement|null} */(/** @type {Element} */(event.target).closest('a[href^="#/"]'));
    // A link to the page that shows changes nothing, so it loses nothing.
    if(!link||link.href===location.href||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||!losesInput())return;
    event.preventDefault();
    askToDiscard(()=>app.followAddress(link.getAttribute('href')));
  },true);

  // A read that takes more than a moment marks the page busy, after the same
  // delay as a slow page load's skeleton. Reads can overlap.
  let busyReads=0;
  /** @template T @param {Promise<T>} read @returns {Promise<T>} */
  async function whileBusy(read){
    busyReads++;const timer=setTimeout(()=>document.querySelector('.content')?.setAttribute('aria-busy','true'),120);
    try{return await read;}
    finally{clearTimeout(timer);if(!--busyReads)document.querySelector('.content')?.removeAttribute('aria-busy');}
  }

  /** A `background` (live) load reads passively, so it never keeps an idle session open. */
  async function loadCurrentRoute({reuseBootstrap=false,refresh=false,background=false}={}){
    const generation=++routeGeneration,current={...context()},expectedSession=sessionScope();
    // A temporary password shows only the form that changes it, and no project
    // is loaded yet, so there is no page to load.
    if(!data.session||data.session.temporary)return;
    const routeHash=location.hash;
    // A filter or a Knowledge section rewrites the address, but the page stays.
    const stillCurrent=()=>generation===routeGeneration&&expectedSession===sessionScope()&&pageOf(routeHash)===pageOf(location.hash);
    if(!['users','settings'].includes(current.view))account.leaveUsers();
    if(current.view!=='profile')account.leaveProfile();
    try{
      let reuse=reuseBootstrap;
      // An address can name a project whose tracks, epics and people aren't
      // loaded, as after a Knowledge link, Back or a pasted link. They load
      // first, while the page shows its skeleton.
      if(['board','roadmap','settings','knowledge'].includes(current.view)&&current.projectId!==data.bootstrapProjectId&&data.projects.some((item)=>item.id===current.projectId)){
        if((await reloadBootstrap({background}))?.stale||!stillCurrent())return {stale:true};
        app.refreshAfterDialog();reuse=true;Object.assign(current,context());
      }
      if(current.view==='board'){if(!reuse||!reads.adoptBoard(current.projectId,current.board))await reads.board(current.projectId,current.board,{skipUnchanged:true,background});}
      // A bootstrap for another page, such as after Page not found, has no epic counts.
      else if(current.view==='roadmap'&&current.projectId){if(!reuse||data.bootstrapView!=='roadmap')await reads.roadmap(current.projectId,{background});}
      else if(current.taskId&&routeHash?.startsWith('#/task/')){
        if(reuseBootstrap&&task(current.taskId)?.detailsLoaded){
          if(current.view!=='task'){recovery.clearPageError();app.openTask(task(current.taskId).id);}
          return {stale:false};
        }
        if(!task(current.taskId)||task(current.taskId)?.detailsLoaded===false)recovery.beginRouteLoad();
        const loaded=await reads.task(current.taskId);
        if(!stillCurrent())return {stale:true};
        if(!loaded?.stale&&loaded?.task){
          // The read already drew a page that shows this task, unless its loading state shows.
          const shown=context(),redraw=!!recovery.pageError||shown.view!=='task'||shown.taskId!==loaded.task.id;
          recovery.clearPageError();if(redraw)app.openTask(loaded.task.id);
        }
      }
      else if(current.view==='users'||current.view==='settings')await loadUsers(false,null,{keepDepth:refresh,background});
      else if(current.view==='profile')await loadProfileAccess({background});
      if(!stillCurrent())return {stale:true};
      const projectId=context().projectId;
      if(!reuse&&(['roadmap','task','knowledge'].includes(current.view)||routeHash?.startsWith('#/task/'))&&data.projects.some((item)=>item.id===projectId))await reads.counts(projectId,{background});
      return {stale:!stillCurrent()};
    }catch(error){
      if(!stillCurrent())return {stale:true};
      throw error;
    }
  }

  return {
    /** @param {{search?:string,blocked?:boolean,trackIds?:string[],epicIds?:string[],assigneeIds?:string[]}} filters */
    filterBoard(filters){return whileBusy(reads.board(context().projectId,filters,{skipUnchanged:true}));},
    /** @param {string} status */
    async loadMoreBoard(status){const result=await reads.moreBoard(status);if(!result.stale)app.acceptMoreBoard(status);return result;},
    /**
     * Switch to another project, once typed text may be left. One bootstrap
     * loads it for the page the switch shows, as from Page not found to the
     * Roadmap that its address names, so that page needs no read of its own.
     * @param {string} projectId
     */
    async selectProject(projectId){
      if(!await mayLeavePage())return {stale:true};
      const generation=++projectGeneration,scope=sessionScope(),page=app.pageAfterSwitch(projectId);
      routeGeneration++;
      const loaded=await whileBusy(reloadBootstrap({projectId,taskId:undefined,view:page==='roadmap'?'roadmap':['board','task'].includes(page)?'board':'metadata'}));
      if(loaded?.stale||generation!==projectGeneration||scope!==sessionScope())return {stale:true};
      app.selectProject(projectId);
      return loadCurrentRoute({reuseBootstrap:true});
    },
    loadCurrentRoute,
  };
}
