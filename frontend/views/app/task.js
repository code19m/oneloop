// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* A task's page: its fields, block, attachments and activity, the drafts of
   fields not saved yet, and the save status in its top bar. */

import { UIMotion } from '../../src/app/motion.js';
import { attachmentsHtml } from './attachments.js';
import { renderBoard } from './board.js';
import { blockText, composerHtml, feedHtml, retryTaskPage, taskFeedState } from './collaboration.js';
import { dateHtml, multiHtml, selectHtml } from './controls.js';
import {
  I, STATUS, UIAction, ago, avatarHtml, d, esc, formatInstant, overdue, setHTML, stIcon,
} from './format.js';
import { sizeDescription, sizeTaskTitle } from './forms.js';
import {
  App, canBoard, epics, me, projectMembers, recovery, report, runtime, state, taskById, userById, userHandle,
} from './model.js';
import { openMenu } from './overlays.js';

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

function taskActivityHtml(task){
  const feed=feedHtml(task),state=taskFeedState(task.id);
  const retry=`<button class="btn quiet" ${UIAction('retryTaskActivity', task.id)}>Retry</button>`;
  if(!feed)return state?.error?`<div class="access-note" role="alert">Could not load activity. ${retry}</div>`:state?.loaded===false?'<div class="access-note" role="status">Loading activity…</div>':'<div class="access-note">No activity yet</div>';
  return state?.error?`<div class="access-note" role="alert">Could not refresh activity. ${retry}</div>${feed}`:feed;
}
const feedRowMarkup = new WeakMap();
function refreshTaskActivity(id,preserveComments=true) {
  if(state.view!=='task'||state.taskId!==id)return;
  App.updateDocumentTitle();
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
/** The open task's page. */
export function renderTask() {
  const t = taskById(state.taskId);
  if (!t) { state.view = 'board'; return renderBoard(); }
  const canEdit = canBoard();
  const title = taskDraft(t, 'title')?.value ?? t.title, desc = taskDraft(t, 'desc')?.value ?? t.desc ?? '';
  const feed = taskActivityHtml(t);

  const late = overdue(t);
  return `<div class="task-page"><div class="task-layout${t.block ? ' has-block' : ''}">
      <div class="task-title-field"><textarea class="tp-title" name="title" aria-label="Task title" rows="1" placeholder="Fix payment validation" required aria-required="true" maxlength="140" data-autosave ${UIAction.on('input', 'sizeTaskTitle')} data-key="Enter" ${UIAction.on('keydown', 'leaveField', UIAction.event, UIAction.element)} ${canEdit ? UIAction.on('blur', 'updTask', t.id, 'title', UIAction.value) : lockedField(t, 'title')}>${esc(title)}</textarea>${taskDraftNote(t, 'title')}</div>
    ${t.block ? `<section class="task-block" data-block-id="${esc(t.block.id)}" tabindex="-1" aria-label="Task blocked"><div class="task-block-heading"><strong>${I.blocked}Blocked</strong>${canEdit ? `<button class="btn unblock-action" ${UIAction('openModal', 'unblock', t.id)}>Unblock task</button>` : ''}</div><p>${blockText(t.block)}</p><div class="task-block-footer"><small>${esc(userById(t.block.by)?.name || t.block.by)} · ${ago(t.block.at)}</small>${canEdit ? `<button class="btn block-edit-action" ${UIAction('openModal', 'block', t.id)}>Edit reason</button>` : ''}</div></section>` : ''}
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
        <div class="comment-composer-home">${composerHtml(t)}</div></div>
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
    toggle: (v) => { clearTaskSaved();if (!App.require('manage_board') || !recovery.ensureOnline()) return; const t = taskById(taskId); if(!t){App.toast('This task is no longer available','error');return;} if(!(t.assignees||[]).includes(v)&&!projectMembers().some(u=>u.id===v)){App.toast('This person is no longer a project member','error');return;} runtime().setAssignees(t.internalId,t.assignees.includes(v)?t.assignees.filter(id=>id!==v):[...t.assignees,v]).catch(report); },
    summary: () => { const a = taskById(taskId)?.assignees || []; return a.length ? a.map((x) => (userById(x) || { name: x }).name).join(', ') : 'Unassigned'; },
    onClose: () => App.refresh(),
  });
}


/** The top bar of the open task's page: back to the Board, its id, status, save status and actions. */
export function taskTopbarHtml() {
  const t = taskById(state.taskId);
  if (!t) return '<h1>Board</h1>';
  return `<button class="btn icon" ${UIAction('nav', 'board')} title="Back to Board" aria-label="Back to Board"><span aria-hidden="true">←</span></button>
  <h1 class="task-heading"><span class="mono">${esc(t.id)}</span></h1>
  ${taskStatusHtml(t)}<span class="task-save-status" role="status" aria-live="polite">${taskSaveFeedback?.id===t.id?taskSaveFeedback.saving?'Saving…':'Saved':''}</span>
  ${canBoard() ? `<div class="right"><button class="btn icon task-actions-button" aria-label="Task actions" title="Task actions" aria-controls="action-menu" aria-expanded="${!!state.menu?.taskActions}" ${UIAction('taskActions', UIAction.event, t.id)}>${I.kebab}</button></div>` : '<div class="right"><span class="read-only-pill">read only</span></div>'}`;
}

/** Remember the timeline's rows as drawn, so a refresh keeps the ones that did not change. */
export function mountTaskPage() {
  document.querySelectorAll('.timeline > [data-feed-key]').forEach(el=>feedRowMarkup.set(el,el.outerHTML));
}

/** Clear a Saved status that belongs to another page or person. */
export function clearStaleTaskSave() {
  if(taskSaveFeedback&&(state.view!=='task'||state.taskId!==taskSaveFeedback.id||me()?.id!==taskSaveFeedback.owner))clearTaskSaved();
}

document.addEventListener('input', (e) => { if(e.target.closest('.task-page'))clearTaskSaved(); }, true);

Object.assign(App, {
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
  retryTaskActivity(id){retryTaskPage(id);},
  refreshTaskActivity,
  clearTaskSaved,
  noteTaskSaved:taskSaved,
  taskActions(ev,id) {
    if(!canBoard()||!taskById(id))return;
    const r=ev.currentTarget.getBoundingClientRect();
    openMenu([{label:'Delete task',danger:true,fn:()=>App.deleteTask(id)}],r.right,r.bottom+4,{taskActions:true,trigger:ev.currentTarget});
  },
});
