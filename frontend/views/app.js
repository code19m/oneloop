// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* The views' shell: it routes addresses and draws the page around the
   features in views/app/. frontend/src/app/boot.js imports it once DATA and
   the controllers are in place, and the view bridge then adds the
   server-backed actions to `App`. See frontend/README.md before changing an
   action. */

import { UIMotion } from '../src/app/motion.js';
import { checkPreviewAccess } from '../src/features/files/preview.js';
import { accountTopbarHtml, renderProfile, renderSettings, renderUsers } from './app/account.js';
import { mountAttachments } from './app/attachments.js';
import {
  boardMovePending, boardSnapshot, boardSnapshots, boardTopbarHtml, cancelBoardSearch, clearFilterMotion,
  renderBoard, resetBoardFilters,
} from './app/board.js';
import { beforeCollaborationRender, inboxHtml, inboxNav, mountCollaboration } from './app/collaboration.js';
import { field, resetFieldIds } from './app/controls.js';
import { renderModal } from './app/dialogs.js';
import {
  I, UIAction, avatarHtml, d, esc, instanceDateKey, instanceToday, iso, setHTML, today,
} from './app/format.js';
import { mountDescription, sizeDescription, sizeDescriptionEditors } from './app/forms.js';
import {
  App, D, blockedCount, canBoard, canReadProject, canReadTask, counts, epicById, hasPermission, instanceNow,
  isAdmin, knowledge, me, poolTotal, project, recovery, report, runtime, state, taskById, trackById,
  visibleProjects,
} from './app/model.js';
import {
  POP, askToDiscard, closePop, dismissMenu, hideEpicTip, openMenu, overlayKey, pendingConfirmation,
  placeMenu, placePop, rememberOpener, renderMenu, restoreOpener, showWaitingPassword, stampOverlays, syncOverlayFocus,
  syncSidebar,
} from './app/overlays.js';
import {
  mountRoadmap, renderPeek, renderRoadmap, roadmapHeight, roadmapMovePending, roadmapTopbarHtml,
} from './app/roadmap.js';
import { storageHtml } from './app/storage.js';
import { clearStaleTaskSave, mountTaskPage, renderTask, taskTopbarHtml } from './app/task.js';
import { ensureToastRegion } from './app/toasts.js';

const TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// ---------- render motion ----------
const boardScrollMemory=new Map();
function prepareRenderMotion(overlaysOnly=false) {
  const page = overlaysOnly?null:document.querySelector('.content');
  const previous = new Map();
  if(page?.dataset.pageKey?.includes(':board:'))boardScrollMemory.set(`${D.session?.userId}:${page.dataset.pageKey}`, [...document.querySelectorAll('.board,.col-cards')].map(el=>[el.closest('[data-col]')?.dataset.col,el.scrollLeft,el.scrollTop]));
  const scrim = document.querySelector('#overlay-root > .scrim');
  if (state.modal || state.peek || state.menu) {
    UIMotion.clearExits();
  } else if (scrim) UIMotion.exit(scrim);
  ['.modal','.peek','.menu'].forEach((selector) => {
    const el = document.querySelector('#app ' + selector);
    if (!el) return;
    previous.set(selector, el.dataset.motionKey || '');
    if (!overlayKey(selector)) UIMotion.exit(el);
  });
  return { previous, hadBlock:!!document.querySelector('.task-block'), pageState:page?.querySelector('.page-error,.loading-state')?.className||'ready', hadScrim: !!scrim, pageKey: page?.dataset.pageKey, scrolls: [...(overlaysOnly?[]:document.querySelectorAll('.content,.task-page,.settings,.board,.col-cards'))].map(el => [el.className, el.closest('[data-col]')?.dataset.col, el.scrollLeft, el.scrollTop]) };
}
function finishRenderMotion(before,overlaysOnly=false) {
  if (before.hadScrim) document.querySelectorAll('#overlay-root > .scrim').forEach(el => { el.style.animation = 'none'; });
  const page = overlaysOnly?null:document.querySelector('.content');
  const key = `${state.projectId}:${state.view}:${state.view === 'task' ? state.taskId : ''}`;
  if (page) {
    page.dataset.pageKey = key;
    if (before.pageKey && before.pageKey !== key) {
      UIMotion.fade(page);
      if(state.view==='board')for(const [col,left,top] of boardScrollMemory.get(`${D.session?.userId}:${key}`)||[]){const el=document.querySelector(col?`[data-col="${esc(col)}"] .col-cards`:'.board');if(el){el.scrollLeft=left;el.scrollTop=top;}}
    }
    else if (before.pageKey === key) before.scrolls.forEach(([classes, col, left, top]) => {
      const selector = '.' + classes.trim().split(/\s+/).join('.');
      const el = document.querySelector(col ? `[data-col="${esc(col)}"] ${selector}` : selector);
      if (el) { el.scrollLeft = left; el.scrollTop = top; }
    });
  }
  if(!overlaysOnly&&!before.hadBlock)UIMotion.enter(document.querySelector('.task-block'));
  ['.modal','.peek','.menu'].forEach((selector) => {
    const el = document.querySelector('#app ' + selector);
    if (!el) return;
    const key = overlayKey(selector); el.dataset.motionKey = key;
    if (before.previous.get(selector) === key) el.style.animation = 'none';
  });
}

// ---------- auth ----------
function renderAuth(mode) {
  // Someone typing when their session ended keeps typing into nothing, not into Username.
  const keptInput = !!recovery.keepsInput;
  const inner = mode === 'change'
    ? `<h1 tabindex="-1">Set a new password</h1>
      <form novalidate ${UIAction.on('submit', 'setPassword', UIAction.event)}>
        ${field('Current temporary password', `<input class="ctl" type="password" name="cur" autocomplete="current-password" autofocus>`)}
        ${field('New password', `<input class="ctl" type="password" name="pw" autocomplete="new-password">`)}
        ${field('Confirm', `<input class="ctl" type="password" name="pw2">`)}
        <div class="modal-actions"><button class="btn danger" type="button" ${UIAction('logout')}>Sign out</button><button class="btn primary" type="submit">Save password</button></div>
      </form>`
    : `<h1 tabindex="-1">Sign in</h1>
      <form novalidate ${UIAction.on('submit', 'login', UIAction.event)}>
        ${field('Username', `<input class="ctl mono" name="username" maxlength="32" autocomplete="username"${keptInput ? '' : ' autofocus'}>`)}
        ${field('Password', `<input class="ctl" type="password" name="password" autocomplete="current-password">`)}
        <div class="modal-actions"><button class="btn primary wide" type="submit">Sign in</button></div>
      </form>`;
  return `<main class="auth-wrap" id="main" tabindex="-1"><div class="auth-card">
    <div class="logo" role="img" aria-label="oneloop">${I.logo}<span>${I.wordmark}</span></div>${recovery.expired?`<p class="auth-notice" role="alert">${keptInput?'Your session ended. Sign in again to keep what you typed.':'Your session ended. Sign in to continue.'}</p>`:''}${inner}</div></main>`;
}

function documentTitle() {
  if(!D.session||!me()?.active||me()?.mustChange)return 'oneloop';
  if(recovery.pageError||['forbidden','notfound','no-projects'].includes(state.view))return 'oneloop';
  const names={board:'Board',roadmap:'Roadmap',knowledge:'Knowledge base',inbox:'Inbox',profile:'Profile',users:'Users',settings:'Settings',storage:'Storage'};
  if(state.view==='task'){
    const task=taskById(state.taskId);
    if(!task||!canReadTask(task))return 'oneloop';
    return `${task.id} · ${task.title} · oneloop`;
  }
  const label=names[state.view];if(!label)return 'oneloop';
  const p=['board','roadmap','knowledge','settings'].includes(state.view)?project():null;
  return `${label}${p&&canReadProject(p.id)?` · ${p.name}`:''} · oneloop`;
}
function updateDocumentTitle(){const title=documentTitle();if(document.title!==title)document.title=title;}
function awaitingServerTask() {
  return !!((state.view === 'notfound'||state.view==='task'&&taskById(state.taskId)?.detailsLoaded===false) && state.taskId &&
    location.hash.startsWith('#/task/') && !['403','404','deleted'].includes(recovery.pageError));
}

function renderTopbar() {
  if (state.view === 'knowledge') return knowledge.topbar();
  if (state.view === 'notfound') return awaitingServerTask() ? '<h1>Task</h1>' : '<h1>Page not found</h1>';
  if (state.view === 'no-projects') return '<h1>Projects</h1>';
  if (state.view === 'forbidden') return '<h1>Access denied</h1>';
  if (state.view === 'roadmap') return roadmapTopbarHtml();
  if (state.view === 'board') return boardTopbarHtml();
  if (state.view === 'task') return taskTopbarHtml();
  if (state.view === 'storage') return '<h1>Storage</h1><span class="meta">All projects</span>';
  if (state.view === 'inbox') return '<h1>Inbox</h1>';
  return accountTopbarHtml();
}

let paintedPage=null;
const pageScope=()=>JSON.stringify([D.session?.id,D.session?.userId,state.view,state.projectId,state.taskId]);
let rendering=false,paintedScope=null,backgroundRenderTimer=null,dialogPaintOwed=false,pressedTaskControl=false,pressedControlTimer=null;
const renderScope=()=>JSON.stringify([D.session?.id,D.session?.userId,location.hash,state.view,state.projectId,state.taskId,state.modal?.type,state.modal?.id,state.peek]);
// A render rebuilds an open dialog and loses its unsaved fields, so a change
// that arrives under one paints when that dialog closes.
function refreshAfterDialog(){
  if(state.modal){dialogPaintOwed=true;return;}
  render();
}
// Keep live metadata current without removing an active control or overlay.
function refreshBackground(){
  clearTimeout(backgroundRenderTimer);
  const authorized=D.session&&(!['task','board','roadmap','settings'].includes(state.view)||canReadProject(state.projectId))&&(!recovery.pageError);
  // WebKit may blur an editor without focusing the pressed button. Keep its
  // DOM target alive through pointer release/click, including slow presses.
  const busy=POP.el||state.modal||state.peek||pendingConfirmation||document.activeElement?.closest('.task-page,.peek,.modal')||pressedTaskControl;
  if(authorized&&busy&&!(state.view==='task'&&!canBoard()&&document.querySelector('.tp-title:not(:disabled):not([readonly])'))){backgroundRenderTimer=setTimeout(refreshBackground,100);return;}
  render();
}
// Snapshot immediately around the DOM swap, never across an awaited read.
function render(){
  clearTimeout(backgroundRenderTimer);dialogPaintOwed=false;
  const scope=renderScope(),active=document.activeElement;
  const preserve=paintedScope===scope&&!recovery.pageError&&(!D.session||canReadProject(state.projectId)||['profile','users','inbox','storage'].includes(state.view));
  const focused=preserve&&active?.matches('input:not([type=file]),textarea')?{opener:rememberOpener(active),value:active.value,scrollTop:active.scrollTop}:null;
  // Text typed into a task field whose edit rights just ended stays as a Not saved draft.
  if(focused&&state.view==='task'&&!active.disabled&&!active.readOnly&&!canBoard()){
    const field=active.matches('.tp-title')?'title':active.id==='task-description'?'desc':null,t=taskById(state.taskId);
    if(field&&t)runtime().keepTaskDraft(t.id,field,active.value);
  }
  const focusedControl=preserve&&!focused&&active?.closest('#app')?rememberOpener(active):null;
  // The page heading and main area outlast any content render of the same page, such as
  // a loading skeleton during a slow read, so a keyboard user keeps their place.
  const landmark=active?.matches?.('.topbar h1')?'.topbar h1':active?.id==='main'?'#main':null,page=pageScope();
  const snapshot=focused?recovery.captureEditor():null;
  if(snapshot)snapshot.controls=snapshot.controls.filter(control=>control.key===snapshot.activeKey);
  rendering=true;
  try{
    renderContent();
    // An unanswered conflict prompt goes back beside its redrawn field before focus is restored.
    recovery.keepPrompts();
    const board=document.querySelector('.board');if(board)boardSnapshots.set(board,boardSnapshot());
    if(document.getElementById('rmScroll')&&document.querySelector('.content')?.clientHeight!==roadmapHeight)App.refreshRoadmap();
    if (paintedPage !== pageScope() && document.activeElement === document.body && !document.querySelector('.modal,.peek') && !document.getElementById('app').inert) {
      const target = document.querySelector('.topbar h1') || document.querySelector('.auth-card [autofocus]') || document.querySelector('.auth-card h1');
      target?.focus({preventScroll:true});
    }
    if(scope===renderScope()&&focused){
      if(snapshot)recovery.restoreEditor(snapshot);
      restoreOpener(focused.opener);
      const target=document.activeElement;
      if(target?.matches('input,textarea')){target.value=focused.value;target.scrollTop=focused.scrollTop;if(focused.opener.selection)try{target.setSelectionRange(...focused.opener.selection);}catch{}}
    }
    if(focusedControl && document.activeElement===document.body)restoreOpener(focusedControl);
    if(landmark && document.activeElement===document.body && page===pageScope() && !document.querySelector('.modal,.peek'))document.querySelector(landmark)?.focus({preventScroll:true});
    const sidebar=document.querySelector('.sidebar');
    if(innerWidth<=900 && state.sideOpen && sidebar && !sidebar.inert && !sidebar.closest('[inert]') && document.activeElement===document.body)sidebar.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }finally{rendering=false;paintedScope=renderScope();paintedPage=pageScope();}
  recovery.resumeEditing();
}
function renderOverlays(){
  showWaitingPassword();
  const root=document.getElementById('overlay-root');
  if(!root||!D.session||!me()?.active){render();return;}
  const oldModalElement=root.querySelector('.modal'),oldPeekElement=root.querySelector('.peek'),oldFocus=document.activeElement;
  const focus={oldModal:!!oldModalElement,oldPeek:!!oldPeekElement,oldFocus,oldModalKey:oldModalElement?.dataset.motionKey,oldPeekKey:oldPeekElement?.dataset.motionKey,oldPanelFocus:(oldModalElement||oldPeekElement)?.contains(oldFocus)?rememberOpener(oldFocus):null};
  beforeCollaborationRender({userId:me()?.id,projectId:state.projectId,view:state.view,taskId:state.taskId,modal:state.modal});
  const motion=prepareRenderMotion(true);hideEpicTip();closePop(true);
  const template=document.createElement('template');setHTML(template,`${state.peek?renderPeek():''}${renderModal()}${renderMenu()}`);
  // A modal over a drawer must retain that drawer's open editor and scroll.
  const nextPeek=template.content.querySelector('.peek');
  if(nextPeek&&oldPeekElement&&focus.oldPeekKey===state.peek)nextPeek.replaceWith(oldPeekElement);
  root.replaceChildren(template.content);
  document.getElementById('app').classList.toggle('side-open',!!state.sideOpen);
  document.querySelector('.switcher-btn')?.setAttribute('aria-expanded',String(!!state.menu?.projectMenu));
  document.querySelector('.me-chip')?.setAttribute('aria-expanded',String(!!state.menu?.version));
  mountDescription();mountCollaboration();
  finishRenderMotion(motion,true);stampOverlays();if(state.menu)placeMenu();syncOverlayFocus(focus);
  paintedScope=renderScope();
}
function renderContent() {
  if(state.view!=='board'||!D.session)cancelBoardSearch();
  knowledge.beforeRender();
  const oldModalElement = document.querySelector('#overlay-root > .modal-wrap .modal');
  const oldPeekElement = document.querySelector('#overlay-root > .peek');
  const oldModal = !!oldModalElement, oldPeek = !!oldPeekElement;
  const oldFocus = document.activeElement;
  const oldModalKey = oldModalElement?.dataset.motionKey,oldPeekKey = oldPeekElement?.dataset.motionKey;
  const oldPanelFocus = (oldModalElement || oldPeekElement)?.contains(oldFocus) ? rememberOpener(oldFocus) : null;
  resetFieldIds();
  showWaitingPassword();
  if(state.modal?.type==='temppw'&&(!D.session||state.modal.ownerSession!==D.session.id||state.modal.ownerId!==me()?.id||!isAdmin()))state.modal=null;
  clearStaleTaskSave();
  today.setTime(instanceToday().getTime());
  if (pendingConfirmation && (pendingConfirmation.session !== D.session?.id || pendingConfirmation.hash !== location.hash || !D.session)) pendingConfirmation.close(false, false);
  checkPreviewAccess();
  beforeCollaborationRender({userId:me()?.id,projectId:state.projectId,view:state.view,taskId:state.taskId,modal:state.modal});
  const renderMotion = prepareRenderMotion();
  clearFilterMotion();
  hideEpicTip();
  closePop(true);
  if (!D.session) { updateDocumentTitle();setHTML(document.getElementById('app'),renderAuth('login')); return; }
  if (me().mustChange) { updateDocumentTitle();setHTML(document.getElementById('app'),renderAuth('change')); return; }
  if(state.view==='task'&&!canReadTask(taskById(state.taskId))){state.view='forbidden';state.peek=null;state.modal=null;}
  if(state.peek&&!canReadProject(trackById(epicById(state.peek)?.trackId)?.projectId))state.peek=null;
  if(state.modal&&!canReadProject(state.projectId)&&!['user','project','temppw'].includes(state.modal.type))state.modal=null;
  if (!visibleProjects().find((p) => p.id === state.projectId)) state.projectId = (visibleProjects()[0] || {}).id;
  // The empty page keeps its address, so a first project returns to that page.
  if (state.view === 'no-projects' && project()) resolveRoute();
  if (['settings','users','storage'].includes(state.view) && !isAdmin()) state.view = 'forbidden';
  if(!project()&&['roadmap','board','knowledge','settings'].includes(state.view))state.view='no-projects';
  updateDocumentTitle();
  const c = counts();
  const p = project() || {name:'No projects'};
  const u = me();
  const error = recovery.pageError || (state.view === 'notfound' && !awaitingServerTask() ? '404' : state.view === 'forbidden' ? '403' : null);
  const view = state.view==='no-projects' ? `<div class="page-empty"><h2>No projects available</h2><p>${isAdmin()?'Create the first project to start planning work.':'Ask an admin to add you to a project.'}</p>${isAdmin()?`<button class="btn primary" ${UIAction('openModal', 'project')}>Create project</button>`:''}</div>` : error ? recovery.errorHtml(error) : awaitingServerTask() ? '<div class="pending-task-route" role="status" aria-label="Loading task"></div>' : state.view === 'knowledge' ? knowledge.render(state.projectId) : state.view === 'roadmap' ? renderRoadmap() : state.view === 'board' ? renderBoard() : state.view === 'task' ? renderTask() : state.view === 'profile' ? renderProfile() : state.view === 'users' ? renderUsers() : state.view === 'inbox' ? inboxHtml() : state.view === 'storage' ? `<div class="workspace-page storage-page">${storageHtml()}</div>` : renderSettings();
  const appRoot = document.getElementById('app'), shell = document.createElement('template');
  setHTML(shell,`
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="side-scrim" ${UIAction('toggleSidebar', false)}></div>
    <nav class="sidebar" aria-label="Main navigation" ${window.innerWidth <= 900 && !state.sideOpen ? 'inert' : ''}>
      <div class="sidebar-brand has-inbox"><div class="logo" role="img" aria-label="oneloop">${I.logo}<span class="lbl">${I.wordmark}</span></div>${inboxNav(state.view)}</div>
      <div class="switcher"><button class="switcher-btn btn" ${!project()&&!isAdmin()?'disabled':''} ${UIAction('projectMenu', UIAction.event)} title="${esc(p.name)}" aria-label="Project: ${esc(p.name)}" aria-expanded="${!!state.menu?.projectMenu}" aria-controls="project-switcher-menu">
        <span class="project-identity"><span class="avatar">${esc(p.name[0].toUpperCase())}</span><span class="lbl project-name">${esc(p.name)}</span></span><span class="lbl project-chevron">${I.chev}</span></button></div>
      <div class="nav">
        <button class="nav-item ${state.view === 'roadmap' ? 'on' : ''}" ${state.view === 'roadmap' ? 'aria-current="page"' : ''} ${UIAction('nav', 'roadmap')} title="Roadmap">${I.roadmap}<span class="lbl">Roadmap</span></button>
        <button class="nav-item ${state.view === 'board' || state.view === 'task' ? 'on' : ''}" ${state.view === 'board' || state.view === 'task' ? 'aria-current="page"' : ''} ${UIAction('nav', 'board')} title="Board">${I.board}<span class="lbl">Board</span><span class="end lbl mono subtle">${c.open}</span></button>
        <button class="nav-item ${state.view === 'knowledge' ? 'on' : ''}" ${state.view === 'knowledge' ? 'aria-current="page"' : ''} ${UIAction('nav', 'knowledge')} title="Knowledge">${I.knowledge}<span class="lbl">Knowledge</span></button>
        ${isAdmin() ? `<button class="nav-item ${state.view === 'settings' ? 'on' : ''}" ${UIAction('nav', 'settings')} title="Settings">${I.settings}<span class="lbl">Settings</span></button>` : ''}
      </div>
      <div class="sidebar-bottom"><div class="profile-area"><button class="me-chip" ${UIAction('userMenu', UIAction.event)} title="${esc(u.name)}" aria-controls="action-menu" aria-expanded="${!!state.menu?.version}">${avatarHtml(u.id, 20)}
        <span class="lbl uname">${esc(u.name)}</span><span class="lbl profile-chevron">${I.chev}</span></button></div></div>
    </nav>
    <div class="main">
      <div class="page-header"><button type="button" class="btn icon menu-btn" aria-label="Toggle sidebar" aria-expanded="${window.innerWidth <= 900 ? !!state.sideOpen : !state.rail}">${I.menu}</button><header class="topbar${state.view === 'board' ? ' board-topbar' : ['settings','profile','users','inbox','storage'].includes(state.view) ? ' form-topbar'+(['inbox','storage'].includes(state.view)?' workspace-topbar':'') : ''}">${renderTopbar().replaceAll('<h1','<h1 tabindex="-1"')}</header></div>${recovery.connectionHtml()}
      <main id="main" tabindex="-1" class="content${['settings','profile','users','inbox','storage'].includes(state.view) ? ' form-content'+(['inbox','storage'].includes(state.view)?' workspace-content':'') : ''}">${view}</main>

    </div>
    <div id="overlay-root">${state.peek ? renderPeek() : ''}${renderModal()}${renderMenu()}</div>
    `);
  // Browsers drop a click when the pressed element leaves the document before
  // mouseup, even if it returns. So a render, such as the route-loading
  // indicator, must not detach an unchanged sidebar: replace only the nodes
  // around it, keeping its listeners and focus.
  const oldSidebar = appRoot.querySelector(':scope > .sidebar'), newSidebar = [...shell.content.children].find(node => node.classList.contains('sidebar'));
  const keptSidebar = !!oldSidebar && !!newSidebar && oldSidebar.isEqualNode(newSidebar);
  if (keptSidebar) {
    const nodes = [...shell.content.childNodes], at = nodes.indexOf(newSidebar);
    for (const node of [...appRoot.childNodes]) if (node !== oldSidebar) node.remove();
    oldSidebar.before(...nodes.slice(0, at));
    oldSidebar.after(...nodes.slice(at + 1));
  } else appRoot.replaceChildren(shell.content);

  document.querySelector('.skip-link')?.addEventListener('click', event => { event.preventDefault(); document.getElementById('main')?.focus(); });
  const appEl = document.getElementById('app');
  appEl.classList.toggle('side-open', !!state.sideOpen);
  appEl.classList.toggle('rail', !!state.rail);
  const mb = document.querySelector('.menu-btn');
  if (mb) mb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); App.toggleSidebar(); });
  if (TOUCH && !keptSidebar) {
    const sb = document.querySelector('.sidebar');
    if (sb) sb.addEventListener('click', (e) => {
      if (state.rail && window.innerWidth > 900 && !e.target.closest('.nav-item, .me-chip, .switcher-btn')) App.toggleSidebar(false);
    });
  }

  mountTaskPage();
  mountDescription();
  if (state.view === 'task') mountAttachments(state.taskId);
  if (state.view === 'roadmap' && !error) mountRoadmap();
  knowledge.mount();
  finishRenderMotion(renderMotion);
  stampOverlays();
  if (state.menu) placeMenu();
  mountCollaboration();
  syncOverlayFocus({ oldModal, oldPeek, oldFocus, oldModalKey, oldPeekKey, oldPanelFocus });
}

// ---------- actions ----------
Object.assign(App, {
  /**
   * What the views show, which the modules in src/ read instead of the views'
   * own state. `movePending` says whether a Board or Roadmap move on the page
   * that shows still waits for the server.
   */
  context() { return { view:state.view, taskId:state.taskId, projectId:state.projectId, poolTab:state.poolTab, peek:state.peek, board:{trackIds:[...state.boardTracks],epicIds:[...state.boardEpics],assigneeIds:[...state.boardAssignees],search:state.boardQ,blocked:state.boardBlocked}, modal:state.modal ? { ...state.modal } : null, movePending:state.view==='board'?boardMovePending():state.view==='roadmap'?roadmapMovePending():false }; },
  updateDocumentTitle,
  refreshCounts() {
    const badge=document.querySelector('.sidebar .nav-item[title="Board"] .end');
    const open=String(counts().open);if(badge&&badge.textContent!==open)badge.textContent=open;
    const blocked=document.querySelector('.blocked-filter-count'),blockedText=String(blockedCount());
    if(blocked&&blocked.textContent!==blockedText)blocked.textContent=blockedText;
    const pool=String(poolTotal());
    document.querySelectorAll('[data-pool-count]').forEach(el=>{if(el.textContent!==pool)el.textContent=pool;});
  },
  followAddress,
  selectProject(id) { if(!visibleProjects().some(project=>project.id===id))return;const leaveTask=state.view==='task'&&state.projectId!==id;state.projectId=id;state.rmScrollLeft=null;resetBoardFilters();if(leaveTask){state.view='board';state.taskId=null;setLocalHash('#/board');}if(state.view==='knowledge'){knowledge.route('knowledge',id);setLocalHash('#/knowledge');}render(); },
  nav(v) { recovery.clearPageError(); state.view = v; state.menu = null; state.peek = null; state.modal = null; state.sideOpen = false; if (v === 'knowledge') knowledge.route(v, state.projectId); setLocalHash('#/' + v); render(); },
  require(permission) {
    if (hasPermission(permission)) return true;
    App.toast(`${permission === 'manage_roadmap' ? 'Roadmap' : 'Board'}: read only`, 'info');
    return false;
  },
  toggleSidebar(force) {
    // The shell binds only click, which covers pointer and keyboard activation.
    const appEl = document.getElementById('app');
    if (window.innerWidth <= 900) {
      // phone: a drawer under the top bar; the same button opens and closes it
      state.sideOpen = typeof force === 'boolean' ? force : !state.sideOpen;
      appEl.classList.toggle('side-open', state.sideOpen);
      syncSidebar();
      (state.sideOpen ? document.querySelector('.sidebar button:not(:disabled)') : document.querySelector('.menu-btn'))?.focus({preventScroll:true});
      return;
    }
    // desktop: full sidebar or icon rail, remembered
    state.rail = typeof force === 'boolean' ? force : !state.rail;
    appEl.classList.toggle('rail', state.rail);
    document.querySelector('.menu-btn').setAttribute('aria-expanded', String(!state.rail));
    try { localStorage.setItem('oneloop.sidebar', state.rail ? 'rail' : 'full'); } catch {}
  },
  /** What Sign out asks, which says when typed text would be lost. */
  signOutText() {
    return recovery.hasUnsavedInput() ? 'End your current browser session. Text you typed and have not saved will be lost.' : 'End your current browser session.';
  },
  userMenu(ev) {
    const r = ev.currentTarget.getBoundingClientRect();
    openMenu([
      { theme: true },
      { autoReload: true },
      { sep: true },
      { label: 'Profile', icon: I.person, fn: () => App.nav('profile') },
      ...(isAdmin() ? [{ label: 'Users', icon: I.users, fn: () => App.nav('users') },{ label: 'Storage', icon: I.storage, fn: () => App.nav('storage') }] : []),
      { sep: true },
      { label: 'Sign out', icon: I.signOut, danger: true, fn: () => App.logout() },
    ], r.left, r.top, { version: true, above: true, trigger:ev.currentTarget });
  },
  setTheme(value) { window.Theme.set(value); },
  toggleAutoReload() {
    recovery.setAutoReload(!recovery.autoReload);
    App.autoReloadChanged();
  },
  /** Show Reload after updates as it is now, also after another tab changed it. */
  autoReloadChanged() {
    const on = !!recovery.autoReload, button = document.querySelector('[data-auto-reload]');
    if (!button || button.getAttribute('aria-pressed') === String(on)) return;
    button.setAttribute('aria-pressed', String(on));
    setHTML(button.querySelector('.menu-check'), on ? I.tick : '');
  },
  /** Enter leaves a field that saves itself when it loses focus, and types nothing. */
  leaveField(event, field) { event.preventDefault(); field.blur(); },

  openTask(id) { const target=taskById(id),track=trackById(epicById(target?.epicId)?.trackId);if(!target||!track)return;if(!canReadTask(target)){state.view='forbidden';state.peek=null;state.modal=null;render();return;}state.projectId=track.projectId;state.sideOpen = false; state.view = 'task'; state.taskId = id; state.menu = null; setLocalHash('#/task/' + id); render(); },
  closeOverlays() { if (state.menu&&!state.modal&&!state.peek){dismissMenu();return;}if (state.modal?.poolId) { App.returnToPool(); return; } state.peek = state.peek && state.modal ? state.peek : null; state.modal = null; state.menu = null; if (dialogPaintOwed) render(); else renderOverlays(); },

  // menus
  projectMenu(ev) {
    const r = ev.currentTarget.getBoundingClientRect();
    const items = visibleProjects().map((p) => ({ label: p.name, projectId:p.id, projectName:p.name, fn: () => runtime().selectProject(p.id).catch(report) }));
    if (isAdmin()) items.push({ sep: true }, { label: 'New project', icon:I.plus, fn: () => { state.modal = { type: 'project' }; renderOverlays(); } });
    openMenu(items, r.left, r.bottom + 6, { projectMenu: true, trigger:ev.currentTarget });
  },

  /** Enter saves a project field, then leaves it. */
  leaveProjectField(event, input) { event.preventDefault(); App.updateProjectField(input); input.blur(); },

  refresh: render,
  /** Draw the dialog, drawer and menu again, and leave the page as it is. */
  refreshOverlays: renderOverlays,
  refreshBackground,
  refreshAfterDialog,
  isRendering:()=>rendering,
});
window.App = App;
export { App };

// ---------- routing ----------
function resolveRoute() {
  const route=location.hash.replace(/^#\/?/,'') || 'roadmap';
  if(route.startsWith('task/')){
    let id;try{id=decodeURIComponent(route.slice(5));}catch{state.view='notfound';state.taskId=null;return;}
    state.taskId=id;
    const task=taskById(id);
    if(!task){state.view='notfound';state.taskId=id;return;}
    const epic=epicById(task.epicId),track=trackById(epic?.trackId);
    if(!track){state.view='notfound';return;}
    state.projectId=track.projectId;state.view=canReadTask(task)?'task':'forbidden';state.taskId=task.id;return;
  }
  state.taskId=null;
  if(route==='knowledge'||/^knowledge[/?]/.test(route)){
    const projectId=knowledge.route(route,state.projectId);
    if(projectId&&projectId!==state.projectId){
      if(!visibleProjects().some(project=>project.id===projectId)){state.view='notfound';return;}
      state.projectId=projectId;state.rmScrollLeft=null;resetBoardFilters();
    }
    state.view='knowledge';return;
  }
  state.view=['roadmap','board','settings','profile','users','inbox','storage'].includes(route)?route:'notfound';
}
// Each history entry the views reach keeps its place in history.state, so
// that Cancel after Back or Forward can step back to the entry that shows.
const placeOf = () => history.state?.oneloopPlace;
const markPlace = place => history.replaceState({ ...history.state, oneloopPlace: place }, '');
if (typeof placeOf() !== 'number') markPlace(0);
/** The place of the entry whose page shows. */
let shownPlace = placeOf();
/** Addresses the views drew themselves, which the address listener then skips once. */
const locallyRenderedHashes = [];
function setLocalHash(hash) {
  if (location.hash === hash) return;
  location.hash = hash;
  markPlace(++shownPlace);
  locallyRenderedHashes.push(location.href);
}
/** The address Discard let through, which routes without asking again. */
let discardedFor = null;
/** The step back to the page that shows: its address, and the question it then asks. */
let returning = null;
/** Go to an address that the person already chose to leave typed text for. */
function followAddress(hash) { discardedFor = new URL(hash, location.href).href; location.hash = hash; }
/**
 * Back, Forward or an address typed by hand (`typed`): a field that saves
 * itself saves first, as no browser blurs it here. If typed text would still
 * be lost, the old address comes back while oneloop asks; Discard goes on.
 */
function mayFollowAddress(event, typed) {
  if (event.newURL === discardedFor) { discardedFor = null; return true; }
  const active = document.activeElement;
  if (active?.matches?.('[data-autosave]')) active.blur();
  if (!recovery.hasUnsavedInput({ leaving:false })) return true;
  const { oldURL, newURL } = event, steps = placeOf() - shownPlace;
  if (typed || !steps) {
    // A new entry: it shows the old address until Discard.
    shownPlace = placeOf();
    history.replaceState(history.state, '', oldURL);
    askToDiscard(() => {
      discardedFor = newURL;
      history.replaceState(history.state, '', newURL);
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL }));
    });
  } else {
    // Back or Forward: step back first, so the entries keep their addresses,
    // and ask once the address shows the page again, as a redraw expects.
    returning = { url:oldURL, ask:() => askToDiscard(() => { discardedFor = newURL; history.go(steps); }) };
    history.go(-steps);
  }
  return false;
}
window.addEventListener('hashchange',(event)=>{
  if(event.newURL===returning?.url){const {ask}=returning;returning=null;event.stopImmediatePropagation();ask();return;}
  // Local navigation already painted its destination. Consume only that
  // exact history event, so external hashes and Back/Forward still route.
  const index=locallyRenderedHashes.indexOf(event.newURL);
  if(index!==-1){locallyRenderedHashes.splice(index,1);recovery.clearPageError();return;}
  if(event.newURL && event.newURL!==location.href)return;
  // An entry without a place is new: a link, or an address typed by hand.
  const typed=typeof placeOf()!=='number';
  if(typed)markPlace(shownPlace+1);
  // Staying keeps the page, so the route loader must not load the new one either.
  if(!mayFollowAddress(event,typed)){event.stopImmediatePropagation();return;}
  shownPlace=placeOf();
  recovery.clearPageError();
  state.peek=null;state.modal=null;state.menu=null;resolveRoute();render();
});
// ---------- global listeners ----------
document.addEventListener('pointerdown', (e) => {
  clearTimeout(pressedControlTimer);
  pressedTaskControl=!!e.target.closest?.('.task-page,.peek,.modal');
});
const releasePressedControl=()=>{clearTimeout(pressedControlTimer);pressedControlTimer=setTimeout(()=>{pressedTaskControl=false;},0);};
// Retain the guard through click dispatch and intervening promise callbacks.
window.addEventListener('pointerup',releasePressedControl,true);
window.addEventListener('pointercancel',releasePressedControl,true);
window.addEventListener('click',releasePressedControl,true);
window.addEventListener('blur',()=>{clearTimeout(pressedControlTimer);pressedTaskControl=false;});
let rsz;
window.addEventListener('resize', () => {
  hideEpicTip();
  clearTimeout(rsz);
  rsz = setTimeout(() => {
    syncSidebar();
    // Resize only the timeline; keep form input, focus, and open dialogs intact.
    const content = document.querySelector('.content');
    if (state.view === 'roadmap' && content && !recovery.pageError) {
      setHTML(content,renderRoadmap());
      mountRoadmap();
    }
    if (POP.el) {
      if (POP.anchor?.isConnected) placePop(POP.anchor);
      else closePop(true);
    }
    sizeDescription();
    sizeDescriptionEditors();
    placeMenu();
  }, 120);
});

setInterval(()=>{
  const key=instanceDateKey(instanceNow());if(key===iso(today))return;today.setTime(+d(key));
  if(!D.session||me()?.mustChange)return;
  if (state.view==='roadmap'||state.peek) runtime().dateChanged().catch(()=>{});
  if(state.view==='task')App.refreshTaskHeader();
  else if(state.view==='board')App.refreshBoard();
  else if(state.view==='roadmap')App.refreshRoadmap();
  else if(state.view==='inbox')refreshBackground();
},60000);
ensureToastRegion();
resolveRoute();
