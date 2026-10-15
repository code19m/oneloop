// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* The views' shell: it routes addresses and draws the page around the
   features in views/app/. frontend/src/app/boot.js imports it once it has set
   DATA and loaded the classic view scripts, and the view bridge then adds the
   server-backed actions to `App`. See frontend/README.md before changing an
   action. */

import { UIMotion } from '../src/app/motion.js';
import { checkPreviewAccess } from '../src/features/files/preview.js';
import { attachmentsHtml, mountAttachments } from './app/attachments.js';
import {
  boardMovePending, boardSnapshot, boardSnapshots, boardTopbarHtml, cancelBoardSearch,
  clearFilterMotion, renderBoard,
} from './app/board.js';
import { dateHtml, field, multiHtml, resetFieldIds, selectHtml } from './app/controls.js';
import { renderModal } from './app/dialogs.js';
import './app/drag.js';
import {
  I, STATUS, UIAction, ago, avatarHtml, d, esc, formatInstant, instanceDateKey, instanceToday,
  iso, overdue, previousDate, setHTML, stIcon, today,
} from './app/format.js';
import {
  mountDescription, sizeDescription, sizeDescriptionEditors, sizeTaskTitle,
} from './app/forms.js';
import {
  App, D, canBoard, canReadProject, canReadTask, collaboration, counts, epicById, epics,
  hasPermission, instanceNow, isAdmin, me, poolItems, project,
  projectMembers, report, runtime, state, taskById, tasks, trackById, userById,
  userHandle, visibleProjects,
} from './app/model.js';
import {
  POP, askConfirmation, askToDiscard, closePop, dismissMenu, hideEpicTip, overlayKey,
  pendingConfirmation, placeMenu, placePop, rememberOpener, renderMenu, restoreOpener,
  showWaitingPassword, stampOverlays, syncOverlayFocus, syncSidebar,
} from './app/overlays.js';
import {
  mountRoadmap, renderPeek, renderRoadmap, roadmapHeight, roadmapMovePending, roadmapTopbarHtml,
} from './app/roadmap.js';
import { storageHtml } from './app/storage.js';
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
  const keptInput = !!window.Recovery?.keepsInput;
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
    <div class="logo" role="img" aria-label="oneloop">${I.logo}<span>${I.wordmark}</span></div>${window.Recovery?.expired?`<p class="auth-notice" role="alert">${keptInput?'Your session ended. Sign in again to keep what you typed.':'Your session ended. Sign in to continue.'}</p>`:''}${inner}</div></main>`;
}

const currentBrowserSession = () => D.session ? (D.browserSessions || []).find(item => item.id === D.session.id && item.userId === D.session.userId && item.revokedAt == null) : null;
function renderProfileAccess() {
  const current = currentBrowserSession(), userId = me().id;
  const sessions = (D.browserSessions || []).filter(item => item.userId === userId && (window.Recovery ? Recovery.sessionActive(item) : item.revokedAt == null)).sort((a,b) => Number(b.id === current?.id) - Number(a.id === current?.id) || b.lastActiveAt - a.lastActiveAt);
  const grants = (D.appGrants || []).filter(item => item.userId === userId && item.revokedAt == null && (!item.expiresAt || item.expiresAt > Date.now())).sort((a,b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const fact = (label,value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  const date = value => value ? formatInstant(value) : 'Unavailable';
  const permissions = { read:'Read', manage_roadmap:'Manage Roadmap', manage_board:'Manage Board' };
  const sessionRows = sessions.map(item => `<div class="access-session-row" data-session-id="${esc(item.id)}">
    <div class="access-session-main"><div class="access-session-title">${esc(item.device || 'Unknown device')}${item.id === current?.id ? '<span class="current-session">Current</span>' : ''}</div>
    ${item.browser ? `<div class="access-session-sub">${esc(item.browser)}</div>` : ''}
    <dl class="access-session-facts">${fact('IP address',item.ip || 'Unavailable')}${fact('Last active',item.id === current?.id ? 'Now' : item.lastActiveAt ? date(item.lastActiveAt) : 'Never')}</dl></div>
    ${item.id !== current?.id ? `<button class="btn quiet danger" type="button" aria-label="Revoke ${esc(item.device)} session" ${UIAction('revokeSession', item.id)}>Revoke</button>` : ''}</div>`).join('');
  const appRows = grants.map(item => `<div class="access-session-row" data-grant-id="${esc(item.id)}"><div class="access-session-main">
    <div class="access-session-title">${esc(item.clientName)}<span class="access-client-type">${esc(item.protocol)}</span></div>
    <div class="app-access-scopes">${(item.access || []).map(grant => `<div><span class="access-project">${esc(visibleProjects().find(p=>p.id===grant.projectId)?.name || 'Unavailable project')}</span><span>${esc(grant.permissions.map(permission=>permissions[permission] || permission).join(' · '))}</span></div>`).join('')}</div>
    <dl class="access-session-facts">${fact('Last used',item.lastUsedAt ? date(item.lastUsedAt) : 'Never')}${fact('Connected',date(item.authorizedAt))}${fact('Expires',item.expiresAt ? date(item.expiresAt) : 'No expiry')}</dl>
    </div><button type="button" class="btn quiet danger" aria-label="Revoke ${esc(item.clientName)} access" ${UIAction('revokeAppAccess', item.id)}>Revoke</button></div>`).join('');
  return `<section class="section"><div class="access-section-heading"><h2 tabindex="-1">Sessions</h2><button type="button" class="btn quiet danger" ${UIAction('revokeOtherSessions')} ${sessions.some(item=>item.id!==current?.id) ? '' : 'disabled'}>Sign out other sessions</button></div><div class="access-session-list">${sessionRows || '<div class="access-empty">No active sessions</div>'}</div></section>
    <section class="section"><h2 tabindex="-1">Connected apps</h2><div class="access-session-list">${appRows || '<div class="access-empty">No connected apps</div>'}</div></section>`;
}
function refreshProfileAccess(status = {}) {
  const host = document.querySelector('.profile-access');
  if (!host) return;
  const hadFocus = host.contains(document.activeElement);
  const before=host.getBoundingClientRect().height;
  setHTML(host,renderProfileAccess() + (status.loading ? '<p class="access-note" role="status">Loading access…</p>' : status.error ? `<p class="access-note" role="alert">${esc(status.error)} <button type="button" class="btn quiet" ${UIAction('retryProfileAccess')}>Retry</button></p>` : ''));
  UIMotion.fade(host);UIMotion.height(host,before);
  if (hadFocus) (host.querySelector('button:not(:disabled)') || host.querySelector('h2'))?.focus({preventScroll:true});
}

function renderProfile() {
  const u = me();
  return `<div class="settings">
    <div class="section">
      <div class="avatar-row">
        ${avatarHtml(u.id, 56)}
        <div class="avatar-actions">
          <input type="file" id="avIn" accept="image/*" hidden ${UIAction.on('change', 'setAvatar', UIAction.element)}>
          <button class="btn" ${UIAction('chooseAvatar')}>${u.avatar ? 'Change avatar' : 'Upload avatar'}</button>
          ${u.avatar ? `<button class="btn" ${UIAction('removeAvatar')}>Remove</button>` : ''}
        </div>
      </div>
      ${field('Username', `<input class="ctl mono" value="${esc(userHandle(u))}" disabled>`)}
      ${field('Full name', `<input class="ctl" name="name" value="${esc(u.name)}" maxlength="80" data-autosave ${UIAction.on('blur', 'updMe', UIAction.value)} data-key="Enter" ${UIAction.on('keydown', 'leaveField', UIAction.event, UIAction.element)}>`)}
    </div>
    <div class="section">
      <h2>Password</h2>
      <form novalidate ${UIAction.on('submit', 'changePassword', UIAction.event)}>
        ${field('Current password', `<input class="ctl" type="password" name="cur" autocomplete="current-password">`)}
        <div class="field-row">
          ${field('New password', `<input class="ctl" type="password" name="pw" autocomplete="new-password">`)}
          ${field('Confirm', `<input class="ctl" type="password" name="pw2" autocomplete="new-password">`)}
        </div>
        <div class="modal-actions start"><button class="btn primary" type="submit">Change password</button></div>
      </form>
    </div>
    <div class="profile-access">${renderProfileAccess()}</div>
  </div>`;
}

let taskSaveFeedback = null, taskSaveTimer;
function clearTaskSaved() {
  clearTimeout(taskSaveTimer);taskSaveFeedback=null;
  const status=document.querySelector('.task-save-status');if(status)status.textContent='';
}
function taskSaved(id) {
  if(state.view!=='task'||state.taskId!==id)return;
  clearTimeout(taskSaveTimer);taskSaveFeedback={id,owner:me()?.id};
  const status=document.querySelector('.task-save-status');if(status)status.textContent='Saved';
  taskSaveTimer=setTimeout(clearTaskSaved,3000);
}
function taskSaving(id, token) {
  if(state.view!=='task'||state.taskId!==id)return;
  clearTimeout(taskSaveTimer);taskSaveFeedback={id,owner:me()?.id,token,saving:true};
  const status=document.querySelector('.task-save-status');if(status)status.textContent='Saving…';
}
function clearTaskSaving(token) {
  if(!taskSaveFeedback?.saving||taskSaveFeedback.token!==token)return;
  clearTaskSaved();
}

function documentTitle() {
  if(!D.session||!me()?.active||me()?.mustChange)return 'oneloop';
  if(window.Recovery?.pageError||['forbidden','notfound','no-projects'].includes(state.view))return 'oneloop';
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
    location.hash.startsWith('#/task/') && !['403','404','deleted'].includes(window.Recovery?.pageError));
}

// ---------- task page ----------
function taskActivityHtml(task){
  const feed=collaboration.feedHtml(task),state=collaboration.taskFeedState(task.id);
  const retry=`<button class="btn quiet" ${UIAction('retryTaskActivity', task.id)}>Retry</button>`;
  if(!feed)return state?.error?`<div class="access-note" role="alert">Could not load activity. ${retry}</div>`:state?.loaded===false?'<div class="access-note" role="status">Loading activity…</div>':'<div class="access-note">No activity yet</div>';
  return state?.error?`<div class="access-note" role="alert">Could not refresh activity. ${retry}</div>${feed}`:feed;
}
const feedRowMarkup = new WeakMap();
function refreshTaskActivity(id,preserveComments=true) {
  if(state.view!=='task'||state.taskId!==id)return;
  updateDocumentTitle();
  const timeline=document.querySelector('.task-page .timeline');if(!timeline)return;
  const active=document.activeElement,before=timeline.getBoundingClientRect().height,rows=UIMotion.rows(timeline,'[data-feed-key]','data-feed-key'),existing=new Map([...timeline.children].filter(el=>el.dataset.feedKey).map(el=>[el.dataset.feedKey,el])),timelineRect=timeline.getBoundingClientRect();
  const template=document.createElement('template');setHTML(template,taskActivityHtml(taskById(id)));
  const next=[...template.content.children],wanted=new Set(next.map(el=>el.dataset.feedKey).filter(Boolean));
  const focusedKey=active?.closest?.('[data-feed-key]')?.dataset.feedKey;
  const focusedControl=active?.matches?.('button')?{comment:active.closest('[data-comment]')?.dataset.comment,replyRoot:active.dataset.replyRoot,action:active.getAttribute('aria-label'),className:active.className}:null;
  const changed=[];
  const children=next.map(el=>{const old=existing.get(el.dataset.feedKey),markup=el.outerHTML;if(old&&((preserveComments&&old.classList.contains('comment-conversation'))||feedRowMarkup.get(old)===markup))return old;feedRowMarkup.set(el,markup);if(old)changed.push(el);return el;});
  const exiting=document.createElement('div');exiting.inert=true;exiting.setAttribute('aria-hidden','true');Object.assign(exiting.style,{position:'absolute',inset:'0',height:before+'px',pointerEvents:'none'});
  const viewport=timeline.closest('.content')?.getBoundingClientRect(),removed=[...existing.keys()].filter(key=>!wanted.has(key)).length;
  if(removed<=20&&!UIMotion.reduced())existing.forEach((el,key)=>{const rect=rows.get(key);if(wanted.has(key)||!rect?.height||viewport&&(rect.bottom<viewport.top||rect.top>viewport.bottom))return;const ghost=UIMotion.ghost(el);Object.assign(ghost.style,{position:'absolute',top:rect.top-timelineRect.top+'px',left:rect.left-timelineRect.left+'px',width:rect.width+'px',height:rect.height+'px',margin:'0'});exiting.append(ghost);});
  timeline.style.position='relative';
  // Move only rows whose place changed. replaceChildren would detach every row, and browsers cancel a click whose pressed element left the document, even briefly.
  let cursor=timeline.firstChild;for(const child of children){if(child===cursor)cursor=cursor.nextSibling;else timeline.insertBefore(child,cursor);}while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
  if(children.length<=100)changed.forEach(el=>UIMotion.fade(el));if(exiting.children.length){timeline.append(exiting);const animation=UIMotion.animate(exiting,[{opacity:1},{opacity:0}],140);if(animation)animation.finished.then(()=>exiting.remove(),()=>exiting.remove());else exiting.remove();}
  if(active?.isConnected&&timeline.contains(active))active.focus({preventScroll:true});
  else if(focusedKey&&focusedControl){const row=[...timeline.querySelectorAll('[data-feed-key]')].find(el=>el.dataset.feedKey===focusedKey);const target=focusedControl.replyRoot?[...row?.querySelectorAll('[data-reply-root]')||[]].find(el=>el.dataset.replyRoot===focusedControl.replyRoot):focusedControl.comment?[...row?.querySelectorAll('[data-comment] button')||[]].find(el=>el.closest('[data-comment]')?.dataset.comment===focusedControl.comment&&el.getAttribute('aria-label')===focusedControl.action):[...row?.querySelectorAll('button')||[]].find(el=>el.className===focusedControl.className);target?.focus({preventScroll:true});}
  UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-feed-key]','data-feed-key',rows);
}

// A title or description that is not saved yet stays as typed, with Save.
const taskDraft = (t, field) => runtime()?.taskDraft?.(t.internalId, field) || null;
function taskDraftNote(t, field) {
  if (!taskDraft(t, field)?.unsaved) return '';
  if (!canBoard()) return `<p class="save-feedback" data-draft-note="${esc(field)}" role="alert">Not saved. You no longer have permission to edit this task.</p>`;
  return `<p class="save-feedback" data-draft-note="${esc(field)}" role="status">Not saved <button type="button" class="btn quiet" ${UIAction('saveTaskDraft', t.id, field)}>Save</button></p>`;
}
// A field the person can no longer edit stays readable when it holds their unsaved text, so they can copy it.
const lockedField = (t, field) => taskDraft(t, field)?.unsaved ? 'readonly' : 'disabled';
/** The task page's status and Blocked badge in the top bar, and its Properties heading with Block task. */
const taskStatusHtml = (t) => `<span class="chip idle task-status-chip">${stIcon(t.state)}${STATUS[t.state]}</span>${t.block ? `<span class="blocked-badge">${I.blocked}Blocked</span>` : ''}`;
const taskPropertiesHeadingHtml = (t, canEdit) => `<div class="task-properties-heading"><h2 id="task-properties-heading">Properties</h2>${canEdit && t.state !== 'done' && !t.block ? `<button class="btn block-task-action" ${UIAction('openModal', 'block', t.id)}>${I.blocked}Block task</button>` : ''}</div>`;
function renderTask() {
  const t = taskById(state.taskId);
  if (!t) { state.view = 'board'; return renderBoard(); }
  const canEdit = canBoard();
  const title = taskDraft(t, 'title')?.value ?? t.title, desc = taskDraft(t, 'desc')?.value ?? t.desc ?? '';
  const feed = taskActivityHtml(t);

  const late = overdue(t);
  return `<div class="task-page"><div class="task-layout${t.block ? ' has-block' : ''}">
      <div class="task-title-field"><textarea class="tp-title" name="title" aria-label="Task title" rows="1" placeholder="Fix payment validation" required aria-required="true" maxlength="140" data-autosave ${UIAction.on('input', 'sizeTaskTitle')} data-key="Enter" ${UIAction.on('keydown', 'leaveField', UIAction.event, UIAction.element)} ${canEdit ? UIAction.on('blur', 'updTask', t.id, 'title', UIAction.value) : lockedField(t, 'title')}>${esc(title)}</textarea>${taskDraftNote(t, 'title')}</div>
    ${t.block ? `<section class="task-block" data-block-id="${esc(t.block.id)}" tabindex="-1" aria-label="Task blocked"><div class="task-block-heading"><strong>${I.blocked}Blocked</strong>${canEdit ? `<button class="btn unblock-action" ${UIAction('openModal', 'unblock', t.id)}>Unblock task</button>` : ''}</div><p>${collaboration?.blockText(t.block) || esc(t.block.reason)}</p><div class="task-block-footer"><small>${esc(userById(t.block.by)?.name || t.block.by)} · ${ago(t.block.at)}</small>${canEdit ? `<button class="btn block-edit-action" ${UIAction('openModal', 'block', t.id)}>Edit reason</button>` : ''}</div></section>` : ''}
    <aside class="tp-rail" aria-labelledby="task-properties-heading">
      ${taskPropertiesHeadingHtml(t, canEdit)}
      <dl class="task-properties">
        <div class="task-property"><dt>Status</dt><dd>${selectHtml('tpState', { label: 'Status', cls: 'prop', disabled: !canEdit, icon: stIcon(t.state), value: t.state, options: Object.entries(STATUS).map(([v, l]) => ({ v, l, icon: stIcon(v) })), pick: (v) => App.updTask(t.id, 'state', v) })}</dd></div>
        <div class="task-property"><dt>Epic</dt><dd>${selectHtml('tpEpic', { label: 'Epic', cls: 'prop', disabled: !canEdit, icon: I.roadmap, value: t.epicId, search: true, options: epics().filter(e => e.state !== 'done' || e.id === t.epicId).slice().sort((a, b) => d(a.start) - d(b.start)).map((e) => ({ v: e.id, l: e.title })), pick: (v) => App.updTask(t.id, 'epicId', v) })}</dd></div>
        <div class="task-property"><dt>Assignees</dt><dd>${msHtml('tpAssign', t.id, !canEdit)}</dd></div>
        <div class="task-property task-property-date prop-row${late ? ' late' : ''}"><dt>Deadline</dt><dd>${dateHtml('tpDl', { hideLabel: true, cls: 'prop', disabled: !canEdit, icon: I.clock, name: '_dl', value: t.deadline || '', clearable: true, autosave: true, pick: (v) => App.updTask(t.id, 'deadline', v) })}<span class="task-overdue" ${late ? '' : 'hidden'}>Overdue</span></dd></div>
        <div class="task-property"><dt>Created at</dt><dd>${Number.isFinite(t.created)?`<time class="task-created-at" datetime="${new Date(t.created).toISOString()}">${formatInstant(t.created)}</time>`:'<span class="task-created-at">Unavailable</span>'}</dd></div>
      </dl>
    </aside>
    <div class="tp-main">
      <div class="tp-sec task-description expandable-description" data-task="${esc(t.id)}" data-description-key="task-${esc(t.id)}"><h2 id="task-description-label">Description</h2>
        <div class="description-preview"><textarea id="task-description" class="ctl" aria-labelledby="task-description-label" placeholder="${canEdit ? 'Add a description…' : 'No description'}" aria-required="false" maxlength="4000" data-autosave ${UIAction.on('focus', 'expandDescription')} ${UIAction.on('input', 'sizeDescription')} ${canEdit ? UIAction.on('blur', 'updTask', t.id, 'desc', UIAction.value) : lockedField(t, 'desc')}>${esc(desc)}</textarea></div>
        <button type="button" class="description-toggle" aria-controls="task-description" aria-expanded="false" ${UIAction('toggleDescription')} hidden>Show more</button>${taskDraftNote(t, 'desc')}</div>
      ${attachmentsHtml(t, canEdit)}
      <div class="tp-sec task-activity"><h2>Activity</h2>
        <div class="timeline">${feed}</div>
        <div class="comment-composer-home">${collaboration?.composerHtml(t) || ''}</div></div>
    </div>
  </div></div>`;
}

function msHtml(key, taskId, disabled) {
  return multiHtml(key, {
    label: 'Assignees',
    cls: 'prop',
    disabled,
    icon: () => { const a = (taskById(taskId)?.assignees || []).filter(userById); return a.length ? `<span class="avs">${a.slice(0, 3).map((x) => avatarHtml(x, 16)).join('')}</span>` : I.person; },
    options: projectMembers().map((u) => ({ v: u.id, l: u.name, sub: userHandle(u) })),
    values: () => taskById(taskId)?.assignees || [],
    toggle: (v) => { clearTaskSaved();if (!App.require('manage_board') || window.Recovery&&!Recovery.ensureOnline()) return; const t = taskById(taskId); if(!t){App.toast('This task is no longer available','error');return;} if(!(t.assignees||[]).includes(v)&&!projectMembers().some(u=>u.id===v)){App.toast('This person is no longer a project member','error');return;} runtime().setAssignees(t.internalId,t.assignees.includes(v)?t.assignees.filter(id=>id!==v):[...t.assignees,v]).catch(report); },
    summary: () => { const a = taskById(taskId)?.assignees || []; return a.length ? a.map((x) => (userById(x) || { name: x }).name).join(', ') : 'Unassigned'; },
    onClose: () => render(),
  });
}

// ---------- settings ----------
let memberWindow = {projectId:null, query:'', limit:100};
document.addEventListener('input', event => {
  const input=event.target;
  if(!(input instanceof HTMLInputElement)||!input.matches('.settings-wide [data-member-search]'))return;
  memberWindow.query=input.value;memberWindow.limit=100;App.refreshUsers();
});
document.addEventListener('click', event => {
  if(!(event.target instanceof Element)||!event.target.closest('.settings-wide [data-more-members]'))return;
  memberWindow.limit+=100;App.refreshUsers();
});
function renderSettings() {
  const p = project();
  if(memberWindow.projectId!==p.id)memberWindow={projectId:p.id,query:'',limit:100};
  const members = (p.members || []).map((raw) => ({
    record: typeof raw === 'string' ? { userId: raw, permissions: [] } : raw,
    user: userById(typeof raw === 'string' ? raw : raw.userId),
  })).filter((x) => x.user);
  const memberIds = new Set((p.members || []).map((raw) => typeof raw === 'string' ? raw : raw.userId));
  const candidates = D.users.filter((u) => u.active && !memberIds.has(u.id));
  const query=memberWindow.query.toLowerCase();
  const matching=members.filter(({user})=>!query||`${user.name} ${userHandle(user)}`.toLowerCase().includes(query));
  return `<div class="settings settings-wide">
    <div class="section">
      <h2>Project</h2>
      <div class="project-fields">
        <div class="field-row">
          ${field('Name', `<input class="ctl" name="name" value="${esc(p.name)}" maxlength="60" data-autosave ${UIAction.on('blur', 'updateProjectField', UIAction.element)} data-key="Enter" ${UIAction.on('keydown', 'leaveProjectField', UIAction.event, UIAction.element)}>`)}
          <div class="prefix-field">${field('Task prefix', `<input class="ctl mono" name="key" value="${esc(p.key)}" maxlength="4" data-autosave ${UIAction.on('blur', 'updateProjectField', UIAction.element)} data-key="Enter" ${UIAction.on('keydown', 'leaveProjectField', UIAction.event, UIAction.element)}>`)}</div>
        </div>
      </div>
    </div>
    <div class="section">
      <h2>Project access <span class="mono subtle">${members.length}</span></h2>
      <input id="member-search" class="ctl" type="search" aria-label="Search project members" placeholder="Search members" value="${esc(memberWindow.query)}" data-member-search>
      <div class="member-access-list" aria-busy="${esc(!!D.adminUsers?.loading)}">
        ${matching.slice(0,memberWindow.limit).map(({ user: u, record: m }) => `
          <div class="member-access-row ${u.active ? '' : 'off'}">
            <div class="member-person">${avatarHtml(u.id, 24)}<span><b data-tip="${esc(u.name)}" data-tip-overflow>${esc(u.name)}</b><small class="mono">${esc(userHandle(u))}</small></span>${u.active ? '' : '<span class="tag-off">deactivated</span>'}</div>
            <div class="member-grants">
              ${u.admin ? '<span class="admin-access">Full access</span>' : `
                <label class="permission-check"><input type="checkbox" data-autosave aria-label="${esc(u.name)}: manage Roadmap" ${(m.permissions || []).includes('manage_roadmap') ? 'checked' : ''} ${UIAction.on('change', 'setMemberPermission', u.id, 'manage_roadmap', UIAction.checked, UIAction.element)}><span><b>Roadmap</b></span></label>
                <label class="permission-check"><input type="checkbox" data-autosave aria-label="${esc(u.name)}: manage Board" ${(m.permissions || []).includes('manage_board') ? 'checked' : ''} ${UIAction.on('change', 'setMemberPermission', u.id, 'manage_board', UIAction.checked, UIAction.element)}><span><b>Board</b></span></label>`}
            </div>
            <button class="row-x icon-button" type="button" title="Remove from project" aria-label="Remove ${esc(u.name)} from project" ${UIAction('removeMember', u.id)}>${I.close}</button>
          </div>`).join('') || `<div class="empty-note inline">${query?'No matching members':'No members yet'}</div>`}
      </div>
      ${matching.length>memberWindow.limit?'<button type="button" class="btn quiet" data-more-members>Load more members</button>':''}
      <div class="add-member">${D.adminUsers?.loading&&!D.adminUsers?.loaded ? '<span class="access-note" role="status">Loading users…</span>' : candidates.length
        ? selectHtml('addMember', { label:'Add member', value: '', placeholder: 'Add member…', search: true, options: candidates.map((u) => ({ v: u.id, l: `${u.name} · ${userHandle(u)}` })), pick: (v) => App.addMember(v) })
        : D.adminUsers?.nextCursor ? '' : '<div class="mono subtle">No users to add</div>'}</div>
      ${D.adminUsers?.nextCursor ? `<button type="button" class="btn quiet" data-more-users ${UIAction('loadMoreUsers')} ${D.adminUsers.loading?'disabled':''}>Load more users</button>` : ''}
      ${D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" ${UIAction('retryUsers')}>Retry</button></p>` : ''}
    </div>
    ${window.OneloopKnowledge?.settingsHtml(p.id) || ''}
    <div class="section danger-zone">
      <h2>Danger zone</h2>
      <button class="btn danger" ${UIAction('deleteProject')}>Delete project</button>
    </div>
  </div>`;
}

function usersCountLabel() {
  if(!D.adminUsers?.loaded)return D.adminUsers?.loading?'…':'';
  // While more pages wait on the server, the loaded count is only a lower bound.
  return `${D.adminUsers.ids.length}${D.adminUsers.nextCursor?'+':''}`;
}
function renderUsers() {
  const awaiting = D.adminUsers?.loading && !D.adminUsers.loaded;
  const listed=awaiting?[]:D.adminUsers?.loaded?D.adminUsers.ids.map(userById).filter(Boolean):D.users.slice(0,state.usersLimit);
  const hasMore=D.adminUsers?.loaded?!!D.adminUsers.nextCursor:D.users.length>state.usersLimit;
  return `<div class="settings">
    <div class="section">
      ${awaiting ? '<p class="access-note" role="status">Loading users…</p>' : D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" ${UIAction('retryUsers')}>Retry</button></p>` : ''}
      ${listed.map((u) => `
        <button type="button" class="user-row clickable ${u.active ? '' : 'off'}" data-user-id="${esc(u.id)}" ${UIAction('openModal', 'user', u.id)}>${avatarHtml(u.id, 22)}
          <span class="uname">${esc(u.name)}</span><span class="mono subtle">${esc(userHandle(u))}</span>
          ${u.active ? '' : '<span class="tag-off">deactivated</span>'}
          ${u.mustChange ? '<span class="tag-off warn">temporary password</span>' : ''}</button>`).join('')}${!awaiting && hasMore ? `<button class="btn quiet" ${UIAction('loadMoreUsers')}>Load more users</button>` : ''}
    </div>
  </div>`;
}

function renderTopbar() {
  if (state.view === 'knowledge') return window.OneloopKnowledge?.topbar() || '<h1>Knowledge base</h1>';
  if (state.view === 'notfound') return awaitingServerTask() ? '<h1>Task</h1>' : '<h1>Page not found</h1>';
  if (state.view === 'no-projects') return '<h1>Projects</h1>';
  if (state.view === 'forbidden') return '<h1>Access denied</h1>';
  if (state.view === 'roadmap') return roadmapTopbarHtml();
  if (state.view === 'board') return boardTopbarHtml();
  if (state.view === 'task') {
    const t = taskById(state.taskId);
    if (!t) return '<h1>Board</h1>';
    return `<button class="btn icon" ${UIAction('nav', 'board')} title="Back to Board" aria-label="Back to Board"><span aria-hidden="true">←</span></button>
    <h1 class="task-heading"><span class="mono">${esc(t.id)}</span></h1>
    ${taskStatusHtml(t)}<span class="task-save-status" role="status" aria-live="polite">${taskSaveFeedback?.id===t.id?taskSaveFeedback.saving?'Saving…':'Saved':''}</span>
    ${canBoard() ? `<div class="right"><button class="btn icon task-actions-button" aria-label="Task actions" title="Task actions" aria-controls="action-menu" aria-expanded="${!!state.menu?.taskActions}" ${UIAction('taskActions', UIAction.event, t.id)}>${I.kebab}</button></div>` : '<div class="right"><span class="read-only-pill">read only</span></div>'}`;
  }
  if (state.view === 'storage') return '<h1>Storage</h1><span class="meta">All projects</span>';
  if (state.view === 'inbox') return '<h1>Inbox</h1>';
  if (state.view === 'profile') return `<h1>Profile</h1><span class="meta">${esc(userHandle(me()))}</span>`;
  if (state.view === 'users') return `<h1>Users</h1><span class="meta users-count">${usersCountLabel()}</span><div class="right"><button class="btn primary" ${UIAction('openModal', 'user')}>${I.plus} New user</button></div>`;
  return `<h1>Settings</h1><span class="meta" data-tip="${esc(project().name)}" data-tip-overflow>${esc(project().name)}</span>`;
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
  const authorized=D.session&&(!['task','board','roadmap','settings'].includes(state.view)||canReadProject(state.projectId))&&(!window.Recovery?.pageError);
  // WebKit may blur an editor without focusing the pressed button. Keep its
  // DOM target alive through pointer release/click, including slow presses.
  const busy=POP.el||state.modal||state.peek||pendingConfirmation||document.activeElement?.closest('.task-page,.peek,.modal')||pressedTaskControl;
  if(authorized&&busy&&!(state.view==='task'&&!canBoard()&&document.querySelector('.tp-title:not(:disabled):not([readonly])'))){backgroundRenderTimer=setTimeout(refreshBackground,100);return;}
  render();
}
// Snapshot immediately around the DOM swap, never across an awaited read.
function render(){
  clearTimeout(backgroundRenderTimer);dialogPaintOwed=false;
  if(!window.ONELOOP_DEFER_BOOT_RENDER)D.peopleVersion=(D.peopleVersion||0)+1;
  const scope=renderScope(),active=document.activeElement;
  const preserve=paintedScope===scope&&!window.Recovery?.pageError&&(!D.session||canReadProject(state.projectId)||['profile','users','inbox','storage'].includes(state.view));
  const focused=preserve&&active?.matches('input:not([type=file]),textarea')?{opener:rememberOpener(active),value:active.value,scrollTop:active.scrollTop}:null;
  // Text typed into a task field whose edit rights just ended stays as a Not saved draft.
  if(focused&&state.view==='task'&&!active.disabled&&!active.readOnly&&!canBoard()){
    const field=active.matches('.tp-title')?'title':active.id==='task-description'?'desc':null,t=taskById(state.taskId);
    if(field&&t)runtime()?.keepTaskDraft?.(t.id,field,active.value);
  }
  const focusedControl=preserve&&!focused&&active?.closest('#app')?rememberOpener(active):null;
  // The page heading and main area outlast any content render of the same page, such as
  // a loading skeleton during a slow read, so a keyboard user keeps their place.
  const landmark=active?.matches?.('.topbar h1')?'.topbar h1':active?.id==='main'?'#main':null,page=pageScope();
  const snapshot=focused?window.Recovery?.captureEditor?.():null;
  if(snapshot)snapshot.controls=snapshot.controls.filter(control=>control.key===snapshot.activeKey);
  rendering=true;
  try{
    renderContent();
    // An unanswered conflict prompt goes back beside its redrawn field before focus is restored.
    window.Recovery?.keepPrompts?.();
    const board=document.querySelector('.board');if(board)boardSnapshots.set(board,boardSnapshot());
    if(document.getElementById('rmScroll')&&document.querySelector('.content')?.clientHeight!==roadmapHeight)App.refreshRoadmap();
    if (paintedPage !== pageScope() && document.activeElement === document.body && !document.querySelector('.modal,.peek') && !document.getElementById('app').inert) {
      const target = document.querySelector('.topbar h1') || document.querySelector('.auth-card [autofocus]') || document.querySelector('.auth-card h1');
      target?.focus({preventScroll:true});
    }
    if(scope===renderScope()&&focused){
      if(snapshot)window.Recovery.restoreEditor(snapshot);
      restoreOpener(focused.opener);
      const target=document.activeElement;
      if(target?.matches('input,textarea')){target.value=focused.value;target.scrollTop=focused.scrollTop;if(focused.opener.selection)try{target.setSelectionRange(...focused.opener.selection);}catch{}}
    }
    if(focusedControl && document.activeElement===document.body)restoreOpener(focusedControl);
    if(landmark && document.activeElement===document.body && page===pageScope() && !document.querySelector('.modal,.peek'))document.querySelector(landmark)?.focus({preventScroll:true});
    const sidebar=document.querySelector('.sidebar');
    if(innerWidth<=900 && state.sideOpen && sidebar && !sidebar.inert && !sidebar.closest('[inert]') && document.activeElement===document.body)sidebar.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }finally{rendering=false;paintedScope=renderScope();paintedPage=pageScope();}
  window.Recovery?.resumeEditing?.();
}
function renderOverlays(){
  showWaitingPassword();
  const root=document.getElementById('overlay-root');
  if(!root||!D.session||!me()?.active){render();return;}
  const oldModalElement=root.querySelector('.modal'),oldPeekElement=root.querySelector('.peek'),oldFocus=document.activeElement;
  const focus={oldModal:!!oldModalElement,oldPeek:!!oldPeekElement,oldFocus,oldModalKey:oldModalElement?.dataset.motionKey,oldPeekKey:oldPeekElement?.dataset.motionKey,oldPanelFocus:(oldModalElement||oldPeekElement)?.contains(oldFocus)?rememberOpener(oldFocus):null};
  collaboration?.beforeRender({userId:me()?.id,projectId:state.projectId,view:state.view,taskId:state.taskId,modal:state.modal});
  const motion=prepareRenderMotion(true);hideEpicTip();closePop(true);
  const template=document.createElement('template');setHTML(template,`${state.peek?renderPeek():''}${renderModal()}${renderMenu()}`);
  // A modal over a drawer must retain that drawer's open editor and scroll.
  const nextPeek=template.content.querySelector('.peek');
  if(nextPeek&&oldPeekElement&&focus.oldPeekKey===state.peek)nextPeek.replaceWith(oldPeekElement);
  root.replaceChildren(template.content);
  document.getElementById('app').classList.toggle('side-open',!!state.sideOpen);
  document.querySelector('.switcher-btn')?.setAttribute('aria-expanded',String(!!state.menu?.projectMenu));
  document.querySelector('.me-chip')?.setAttribute('aria-expanded',String(!!state.menu?.version));
  mountDescription();collaboration?.mount();
  finishRenderMotion(motion,true);stampOverlays();if(state.menu)placeMenu();syncOverlayFocus(focus);
  paintedScope=renderScope();
}
function renderContent() {
  if(state.view!=='board'||!D.session)cancelBoardSearch();
  window.OneloopKnowledge?.beforeRender();
  const oldModalElement = document.querySelector('#overlay-root > .modal-wrap .modal');
  const oldPeekElement = document.querySelector('#overlay-root > .peek');
  const oldModal = !!oldModalElement, oldPeek = !!oldPeekElement;
  const oldFocus = document.activeElement;
  const oldModalKey = oldModalElement?.dataset.motionKey,oldPeekKey = oldPeekElement?.dataset.motionKey;
  const oldPanelFocus = (oldModalElement || oldPeekElement)?.contains(oldFocus) ? rememberOpener(oldFocus) : null;
  resetFieldIds();
  showWaitingPassword();
  if(state.modal?.type==='temppw'&&(!D.session||state.modal.ownerSession!==D.session.id||state.modal.ownerId!==me()?.id||!isAdmin()))state.modal=null;
  if(taskSaveFeedback&&(state.view!=='task'||state.taskId!==taskSaveFeedback.id||me()?.id!==taskSaveFeedback.owner))clearTaskSaved();
  today.setTime(instanceToday().getTime());
  if (pendingConfirmation && (pendingConfirmation.session !== D.session?.id || pendingConfirmation.hash !== location.hash || !D.session)) pendingConfirmation.close(false, false);
  checkPreviewAccess();
  collaboration?.beforeRender({userId:me()?.id,projectId:state.projectId,view:state.view,taskId:state.taskId,modal:state.modal});
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
  const error = window.Recovery?.pageError || (state.view === 'notfound' && !awaitingServerTask() ? '404' : state.view === 'forbidden' ? '403' : null);
  const view = state.view==='no-projects' ? `<div class="page-empty"><h2>No projects available</h2><p>${isAdmin()?'Create the first project to start planning work.':'Ask an admin to add you to a project.'}</p>${isAdmin()?`<button class="btn primary" ${UIAction('openModal', 'project')}>Create project</button>`:''}</div>` : error ? window.Recovery?.errorHtml(error) || `<div class="page-error"><h2>${error === '403' ? 'Access denied' : 'Page not found'}</h2><button class="btn quiet" ${UIAction('nav', 'board')}>Back to Board</button></div>` : awaitingServerTask() ? '<div class="pending-task-route" role="status" aria-label="Loading task"></div>' : state.view === 'knowledge' ? window.OneloopKnowledge?.render(state.projectId) || '' : state.view === 'roadmap' ? renderRoadmap() : state.view === 'board' ? renderBoard() : state.view === 'task' ? renderTask() : state.view === 'profile' ? renderProfile() : state.view === 'users' ? renderUsers() : state.view === 'inbox' ? collaboration?.inboxHtml() || '' : state.view === 'storage' ? `<div class="workspace-page storage-page">${storageHtml()}</div>` : renderSettings();
  const appRoot = document.getElementById('app'), shell = document.createElement('template');
  setHTML(shell,`
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="side-scrim" ${UIAction('toggleSidebar', false)}></div>
    <nav class="sidebar" aria-label="Main navigation" ${window.innerWidth <= 900 && !state.sideOpen ? 'inert' : ''}>
      <div class="sidebar-brand has-inbox"><div class="logo" role="img" aria-label="oneloop">${I.logo}<span class="lbl">${I.wordmark}</span></div>${collaboration?.inboxNav(state.view) || ''}</div>
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
      <div class="page-header"><button type="button" class="btn icon menu-btn" aria-label="Toggle sidebar" aria-expanded="${window.innerWidth <= 900 ? !!state.sideOpen : !state.rail}">${I.menu}</button><header class="topbar${state.view === 'board' ? ' board-topbar' : ['settings','profile','users','inbox','storage'].includes(state.view) ? ' form-topbar'+(['inbox','storage'].includes(state.view)?' workspace-topbar':'') : ''}">${renderTopbar().replaceAll('<h1','<h1 tabindex="-1"')}</header></div>${window.Recovery?.connectionHtml() || ''}
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

  document.querySelectorAll('.timeline > [data-feed-key]').forEach(el=>feedRowMarkup.set(el,el.outerHTML));
  mountDescription();
  if (state.view === 'task') mountAttachments(state.taskId);
  if (state.view === 'roadmap' && !error) mountRoadmap();
  window.OneloopKnowledge?.mount();
  finishRenderMotion(renderMotion);
  stampOverlays();
  if (state.menu) placeMenu();
  collaboration?.mount();
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
    const blocked=document.querySelector('.blocked-filter-count');
    const blockedCount=String(D.projectTaskCounts?.[state.projectId]?.blocked??tasks().filter(task=>task.block&&task.state!=='done').length);
    if(blocked&&blocked.textContent!==blockedCount)blocked.textContent=blockedCount;
    const mine=D.poolPageInfo?.[`${state.projectId}:mine`]?.total,team=D.poolPageInfo?.[`${state.projectId}:project`]?.total;
    const poolTotal=Number.isFinite(mine)&&Number.isFinite(team)?mine+team:poolItems().length;
    document.querySelectorAll('[data-pool-count]').forEach(el=>{if(el.textContent!==String(poolTotal))el.textContent=String(poolTotal);});
  },
  refreshProfileAccess,
  refreshUsers({loadingOnly=false}={}) {
    if (loadingOnly) {
      document.querySelector(state.view==='settings'?'.member-access-list':'.content .settings')?.setAttribute('aria-busy', String(!!D.adminUsers?.loading));
      document.querySelectorAll('[data-more-users]').forEach(button=>button.disabled=!!D.adminUsers?.loading);
      return;
    }
    if (state.view === 'settings') {
      const settings = document.querySelector('.settings-wide');
      const section = settings?.querySelectorAll(':scope > .section')[1];
      if (!section) return;
      const focus = section.contains(document.activeElement) ? rememberOpener(document.activeElement) : null;
      closePop(true);
      const template = document.createElement('template'); setHTML(template,renderSettings());
      section.replaceWith(template.content.querySelectorAll('.section')[1]);
      if (focus) restoreOpener(focus);
      return;
    }
    if (state.view !== 'users') return;
    const content = document.querySelector('.content'), count = document.querySelector('.users-count');
    if (!content) return;
    const scroll = content.scrollTop, focus = document.activeElement, userId = focus?.matches?.('.user-row') ? focus.dataset.userId : null;
    setHTML(content,renderUsers()); content.scrollTop = scroll;
    if (count) count.textContent = usersCountLabel();
    if (userId) [...content.querySelectorAll('.user-row')].find(el => el.dataset.userId === userId)?.focus({preventScroll:true});
  },
  /**
   * Show each title and description field's draft, or its saved value once
   * the draft is gone (such as after Use latest), with its Not saved note.
   * The field being edited keeps what the person is typing.
   */
  refreshTaskDrafts(id) {
    if (state.view !== 'task' || state.taskId !== id) return;
    const t = taskById(id); if (!t) return;
    for (const [field, selector, control] of [['title', '.task-title-field', '.tp-title'], ['desc', '.task-description', '#task-description']]) {
      const host = document.querySelector(`.task-page ${selector}`); if (!host) continue;
      const input = host.querySelector(control), value = taskDraft(t, field)?.value ?? (field === 'title' ? t.title : t.desc ?? '');
      if (input && input !== document.activeElement && input.value !== value) { input.value = value; if (field === 'title') sizeTaskTitle(); else sizeDescription(); }
      host.querySelector('[data-draft-note]')?.remove();
      const template = document.createElement('template'); setHTML(template, taskDraftNote(t, field));
      host.append(template.content);
    }
  },
  /**
   * Show the saved status, block and deadline of the open task around its
   * fields: the header chip and badge, the Status icon, Block task and
   * Overdue. A field save draws the page again only once focus leaves it.
   */
  refreshTaskHeader() {
    const t = state.view === 'task' ? taskById(state.taskId) : null, page = document.querySelector('.task-page');
    if (!t || !page) return;
    // Only these pieces: rendering the whole page again would register its
    // fields anew, and a save still in flight would no longer find its field.
    const html = (source) => { const next = document.createElement('template'); setHTML(next, source); return next.content; };
    const topbar = document.querySelector('.topbar');
    topbar?.querySelector('.blocked-badge')?.remove();
    topbar?.querySelector('.task-status-chip')?.replaceWith(html(taskStatusHtml(t)));
    const heading = page.querySelector('.task-properties-heading');
    if (heading && !heading.contains(document.activeElement)) heading.replaceWith(html(taskPropertiesHeadingHtml(t, canBoard())));
    page.querySelector('#select-tpState > svg')?.replaceWith(html(stIcon(t.state)));
    const late = overdue(t);
    page.querySelector('.task-property-date')?.classList.toggle('late', late);
    page.querySelector('.task-overdue')?.toggleAttribute('hidden', !late);
  },
  noteTaskSaving: taskSaving,
  clearTaskSaving,
  retryTaskActivity(id){collaboration?.retryTaskPage?.(id);},
  refreshTaskActivity,
  followAddress,
  selectProject(id) { if(!visibleProjects().some(project=>project.id===id))return;const leaveTask=state.view==='task'&&state.projectId!==id;state.projectId=id;state.rmScrollLeft=null;state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;if(leaveTask){state.view='board';state.taskId=null;setLocalHash('#/board');}if(state.view==='knowledge'){window.OneloopKnowledge?.route('knowledge',id);setLocalHash('#/knowledge');}render(); },
  acceptMoreUsers() { if(state.view==='settings'){App.refreshUsers();return;}state.usersLimit+=50;render(); },
  nav(v) { window.Recovery?.clearPageError(); state.view = v; state.menu = null; state.peek = null; state.modal = null; state.sideOpen = false; if (v === 'knowledge') window.OneloopKnowledge?.route(v, state.projectId); setLocalHash('#/' + v); render(); },
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
    return window.Recovery?.hasUnsavedInput?.() ? 'End your current browser session. Text you typed and have not saved will be lost.' : 'End your current browser session.';
  },
  chooseAvatar() { document.getElementById('avIn')?.click(); },
  userMenu(ev) {
    const r = ev.currentTarget.getBoundingClientRect();
    App._openMenu([
      { theme: true },
      ...(window.Recovery?.setAutoReload ? [{ autoReload: true }] : []),
      { sep: true },
      { label: 'Profile', icon: I.person, fn: () => App.nav('profile') },
      ...(isAdmin() ? [{ label: 'Users', icon: I.users, fn: () => App.nav('users') },{ label: 'Storage', icon: I.storage, fn: () => App.nav('storage') }] : []),
      { sep: true },
      { label: 'Sign out', icon: I.signOut, danger: true, fn: () => App.logout() },
    ], r.left, r.top, { version: true, above: true, trigger:ev.currentTarget });
  },
  setTheme(value) { window.Theme.set(value); },
  toggleAutoReload() {
    window.Recovery?.setAutoReload?.(!window.Recovery?.autoReload);
    App.autoReloadChanged();
  },
  /** Show Reload after updates as it is now, also after another tab changed it. */
  autoReloadChanged() {
    const on = !!window.Recovery?.autoReload, button = document.querySelector('[data-auto-reload]');
    if (!button || button.getAttribute('aria-pressed') === String(on)) return;
    button.setAttribute('aria-pressed', String(on));
    setHTML(button.querySelector('.menu-check'), on ? I.tick : '');
  },
  clearTaskSaved,
  noteTaskSaved:taskSaved,
  /** Enter leaves a field that saves itself when it loses focus, and types nothing. */
  leaveField(event, field) { event.preventDefault(); field.blur(); },

  openTask(id) { const target=taskById(id),track=trackById(epicById(target?.epicId)?.trackId);if(!target||!track)return;if(!canReadTask(target)){state.view='forbidden';state.peek=null;state.modal=null;render();return;}state.projectId=track.projectId;state.sideOpen = false; state.view = 'task'; state.taskId = id; state.menu = null; setLocalHash('#/task/' + id); render(); },
  closeOverlays() { if (state.menu&&!state.modal&&!state.peek){dismissMenu();return;}if (state.modal?.poolId) { App.returnToPool(); return; } state.peek = state.peek && state.modal ? state.peek : null; state.modal = null; state.menu = null; if (dialogPaintOwed) render(); else renderOverlays(); },

  // menus
  projectMenu(ev) {
    const r = ev.currentTarget.getBoundingClientRect();
    const items = visibleProjects().map((p) => ({ label: p.name, projectId:p.id, projectName:p.name, fn: () => runtime().selectProject(p.id).catch(report) }));
    if (isAdmin()) items.push({ sep: true }, { label: 'New project', icon:I.plus, fn: () => { state.modal = { type: 'project' }; renderOverlays(); } });
    App._openMenu(items, r.left, r.bottom + 6, { projectMenu: true, trigger:ev.currentTarget });
  },

  /** Enter saves a project field, then leaves it. */
  leaveProjectField(event, input) { event.preventDefault(); App.updateProjectField(input); input.blur(); },

  taskActions(ev,id) {
    if(!canBoard()||!taskById(id))return;
    const r=ev.currentTarget.getBoundingClientRect();
    App._openMenu([{label:'Delete task',danger:true,fn:()=>App.deleteTask(id)}],r.right,r.bottom+4,{taskActions:true,trigger:ev.currentTarget});
  },

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
    const projectId=window.OneloopKnowledge?.route(route,state.projectId);
    if(projectId&&projectId!==state.projectId){
      if(!visibleProjects().some(project=>project.id===projectId)){state.view='notfound';return;}
      state.projectId=projectId;state.rmScrollLeft=null;state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;
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
  if (!window.Recovery?.hasUnsavedInput?.({ leaving:false })) return true;
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
  if(index!==-1){locallyRenderedHashes.splice(index,1);window.Recovery?.clearPageError();return;}
  if(event.newURL && event.newURL!==location.href)return;
  // An entry without a place is new: a link, or an address typed by hand.
  const typed=typeof placeOf()!=='number';
  if(typed)markPlace(shownPlace+1);
  // Staying keeps the page, so the route loader must not load the new one either.
  if(!mayFollowAddress(event,typed)){event.stopImmediatePropagation();return;}
  shownPlace=placeOf();
  window.Recovery?.clearPageError();
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
document.addEventListener('input', (e) => { if(e.target.closest('.task-page'))clearTaskSaved(); }, true);
let rsz;
window.addEventListener('resize', () => {
  hideEpicTip();
  clearTimeout(rsz);
  rsz = setTimeout(() => {
    syncSidebar();
    // Resize only the timeline; keep form input, focus, and open dialogs intact.
    const content = document.querySelector('.content');
    if (state.view === 'roadmap' && content && !window.Recovery?.pageError) {
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

collaboration?.bind(App,{task:taskById,projects:visibleProjects,view:()=>state.view,canBoard:task=>hasPermission('manage_board',trackById(epicById(task?.epicId)?.trackId)?.projectId),confirm:askConfirmation,refresh:render,refreshBackground,refreshActivity:refreshTaskActivity,multi:multiHtml,ago,instant:formatInstant,dateKey:instanceDateKey,previousDate,avatar:avatarHtml,
  refreshComments:(id,composer=false)=>{if(state.view!=='task'||state.taskId!==id)return;const task=taskById(id),timeline=document.querySelector('.task-page .timeline'),before=timeline?.getBoundingClientRect().height,rows=UIMotion.rows(timeline,'[data-comment]','data-comment'),focused=document.activeElement?.dataset.replyRoot;if(timeline){setHTML(timeline,collaboration.feedHtml(task));UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-comment]','data-comment',rows);if(focused)[...timeline.querySelectorAll('[data-reply-root]')].find(el=>el.dataset.replyRoot===focused)?.focus({preventScroll:true});}if(composer){const home=document.querySelector('.comment-composer-home');if(home)setHTML(home,Collab.composerHtml(task));UIMotion.enter(document.querySelector('.collaboration-composer .reply-context'));}},
});
window.Recovery?.bind(App,{refresh:render});
setInterval(()=>{
  const key=instanceDateKey(instanceNow());if(key===iso(today))return;today.setTime(+d(key));
  if(!D.session||me()?.mustChange)return;
  if (state.view==='roadmap'||state.peek) runtime().dateChanged().catch(()=>{});
  if(state.view==='task'){
    const late=overdue(taskById(state.taskId)),row=document.querySelector('.task-property-date');
    row?.classList.toggle('late',late);const label=row?.querySelector('.task-overdue');if(label)label.hidden=!late;
  }else if(state.view==='board')App.refreshBoard();
  else if(state.view==='roadmap')App.refreshRoadmap();
  else if(state.view==='inbox')refreshBackground();
},60000);
ensureToastRegion();
resolveRoute();
if(!window.ONELOOP_DEFER_BOOT_RENDER)render();
