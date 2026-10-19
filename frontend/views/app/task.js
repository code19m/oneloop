// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* A task's page: its fields, its description as Markdown or in its editor,
   block, attachments and activity, the drafts of fields not saved yet, and
   the save status in its top bar. */

import { UIMotion } from '../../src/app/motion.js';
import { fadeOutRows, placeRows } from '../../src/app/rows.js';
import { checklistHtml, refreshChecklist } from '../../src/features/checklist/checklist.js';
import { sourcePosition } from '../../src/features/files/file-views.js';
import { attachmentsHtml } from './attachments.js';
import { renderBoard } from './board.js';
import { blockText, composerHtml, feedHtml, retryTaskPage, sizeCommentBodies, taskFeedState } from './collaboration.js';
import { dateHtml, multiHtml, selectHtml, setSelectValue } from './controls.js';
import {
  I, STATUS, UIAction, ago, avatarHtml, esc, formatInstant, overdue, setHTML, stIcon,
} from './format.js';
import { epicOptions, mountDescription, sizeDescription, sizeTaskTitle, trackOptions } from './forms.js';
import {
  App, canBoard, epicById, me, projectMembers, recovery, report, runtime, state, taskById, trackById, userById, userHandle,
} from './model.js';
import { openMenu } from './overlays.js';
import { announce } from './toasts.js';

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
  const gone=[...existing].filter(([key])=>!wanted.has(key)).map(([key,el])=>[el,rows.get(key)]),viewport=timeline.closest('.content')?.getBoundingClientRect();
  timeline.style.position='relative';
  placeRows(timeline,children);
  if(children.length<=100)changed.forEach(el=>UIMotion.fade(el));
  if(gone.length<=20)fadeOutRows(timeline,gone,{listRect:timelineRect,viewport,height:before});
  if(active?.isConnected&&timeline.contains(active))active.focus({preventScroll:true});
  else if(focusedKey&&focusedControl){const row=[...timeline.querySelectorAll('[data-feed-key]')].find(el=>el.dataset.feedKey===focusedKey);const target=focusedControl.replyRoot?[...row?.querySelectorAll('[data-reply-root]')||[]].find(el=>el.dataset.replyRoot===focusedControl.replyRoot):focusedControl.comment?[...row?.querySelectorAll('[data-comment] button')||[]].find(el=>el.closest('[data-comment]')?.dataset.comment===focusedControl.comment&&el.getAttribute('aria-label')===focusedControl.action):[...row?.querySelectorAll('button')||[]].find(el=>el.className===focusedControl.className);target?.focus({preventScroll:true});}
  UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-feed-key]','data-feed-key',rows);
}

// A title or description that is not saved yet stays as typed, with Save.
const taskDraft = (t, field) => runtime()?.taskDraft?.(t.internalId, field) || null;
function taskDraftNote(t, field) {
  if (!taskDraft(t, field)?.unsaved) return '';
  if (!canBoard()) return `<p class="save-feedback" data-draft-note="${esc(field)}" role="alert">Not saved. You no longer have permission to edit this task.</p>`;
  return `<p class="save-feedback" data-draft-note="${esc(field)}" role="status">Not saved <button type="button" class="btn quiet" data-save-shortcut ${UIAction('saveTaskDraft', t.id, field)}>Save</button></p>`;
}
/** Put the Not saved note of `field` at the end of `host`, or take it away. A note that stays the same keeps its element, and so its focus. */
function placeDraftNote(host, t, field) {
  const old = host.querySelector('[data-draft-note]'), template = document.createElement('template'); setHTML(template, taskDraftNote(t, field));
  const note = template.content.firstElementChild;
  if (old && note && old.outerHTML === note.outerHTML) return;
  old?.remove(); if (note) host.append(note);
}
// A field the person can no longer edit stays readable when it holds their unsaved text, so they can copy it.
const lockedField = (t, field) => taskDraft(t, field)?.unsaved ? 'readonly' : 'disabled';

/**
 * Show the open task's title as it is now, with its Not saved note. The title
 * being typed keeps what the person is typing. A new title waits for a press
 * on the page to end: it can take more lines and move what lies below.
 */
function paintTitle(t) {
  const host = document.querySelector('.task-page .task-title-field');
  if (!host) return;
  const input = host.querySelector('.tp-title'), value = taskDraft(t, 'title')?.value ?? t.title;
  if (input && input !== document.activeElement && input.value !== value && !App.afterPress(repaintTitle)) { input.value = value; sizeTaskTitle(); }
  placeDraftNote(host, t, 'title');
}
function repaintTitle() { const t = state.view === 'task' ? taskById(state.taskId) : null; if (t) paintTitle(t); }
/** Show the open task's checklist as it is now: once for all the changes that waited for a press. */
function refreshShownChecklist() { if (state.view === 'task') App.refreshTaskChecklist(state.taskId); }

// ---------- description ----------
// The description shows its saved text as Markdown. Its editor shows instead
// while the person has it open, while its text waits to be saved (a save on
// its way, a Not saved draft or a conflict question), and while it is empty
// for someone who can edit it.

// The task whose description editor the person has open, from when it gets
// focus until focus moves elsewhere on the page. Drawing the page again, a
// window that loses focus, Cmd+S and a session that ends keep it open.
let descriptionOpen = null;
const descriptionIsOpen = (t) => descriptionOpen?.taskId === t.id && descriptionOpen.userId === me()?.id;
const descriptionText = (t) => taskDraft(t, 'desc')?.value ?? t.desc ?? '';
function showsDescriptionEditor(t, canEdit) {
  const draft = taskDraft(t, 'desc');
  return !!draft?.unsaved || canEdit && (!!draft || descriptionIsOpen(t) || !descriptionText(t));
}
/** The description's editor, its rendered text, or for read-only members "No description". */
function descriptionBodyHtml(t, canEdit) {
  const desc = descriptionText(t);
  if (showsDescriptionEditor(t, canEdit)) return `<textarea id="task-description" class="ctl" aria-labelledby="task-description-label" placeholder="${canEdit ? 'Add a description…' : 'No description'}" aria-required="false" maxlength="4000" data-autosave ${UIAction.on('focus', 'expandDescription')} ${UIAction.on('input', 'sizeDescription')} ${canEdit ? `${UIAction.on('blur', 'updTask', t.id, 'desc', UIAction.value)} ${UIAction.on('keydown', 'descriptionKey', UIAction.event)}` : lockedField(t, 'desc')}>${esc(desc)}</textarea>`;
  if (!desc) return '<p class="description-content description-empty" id="task-description-content">No description</p>';
  // A click opens the editor; links, boxes and selections inside keep their own.
  return `<div class="description-content" id="task-description-content" role="group" aria-labelledby="task-description-label" data-markdown="${esc(desc)}" ${canEdit ? UIAction('editDescription', t.id, UIAction.event) : ''}>${esc(desc)}</div>`;
}
const descriptionBodyId = (t, canEdit) => showsDescriptionEditor(t, canEdit) ? 'task-description' : 'task-description-content';
// Edit shows while the editor is closed and there is text to edit.
const editHidden = (t) => descriptionIsOpen(t) || !descriptionText(t);
const placeEditButton = (t) => document.querySelector('.task-page .description-edit')?.toggleAttribute('hidden', editHidden(t));
/** The Description heading, with Edit for keyboards and screen readers. */
const descriptionHeadingHtml = (t, canEdit) => `<div class="description-heading"><h2 id="task-description-label">Description</h2>${canEdit ? `<button type="button" class="btn quiet description-edit" aria-label="Edit description" ${UIAction('editDescription', t.id)} ${editHidden(t) ? 'hidden' : ''}>Edit</button>` : ''}</div>`;
/**
 * Show the open task's description in place as it is now: its editor with
 * the text that waits to be saved, or its rendered text, with Edit and its
 * Not saved note. The editor being typed in keeps what the person is typing.
 * The editor opens at once. Anything else waits for a press on the page to
 * end, so what lies below doesn't move under the pointer, and for focus to
 * leave the description, so a reader keeps their place.
 */
function paintDescription(t) {
  const section = document.querySelector('.task-page .task-description');
  if (!section) return;
  const canEdit = canBoard(), body = section.querySelector('.description-preview'), input = body.querySelector('#task-description'), desc = descriptionText(t);
  const shown = input ? 'editor' : body.querySelector('[data-markdown]') ? 'reader' : 'empty';
  const wanted = input && input === document.activeElement || showsDescriptionEditor(t, canEdit) ? 'editor' : desc ? 'reader' : 'empty';
  if (wanted === 'editor' && shown === 'editor') { if (input !== document.activeElement && input.value !== desc) { input.value = desc; sizeDescription(); } }
  else if (wanted !== shown || wanted === 'reader' && body.querySelector('[data-markdown]').getAttribute('data-markdown') !== desc) {
    if (wanted !== 'editor' && (App.afterPress(repaintDescription) || body.contains(document.activeElement))) { placeEditButton(t); return; }
    const before = body.getBoundingClientRect().height;
    setHTML(body, descriptionBodyHtml(t, canEdit));
    section.querySelector('.description-toggle')?.setAttribute('aria-controls', descriptionBodyId(t, canEdit));
    mountDescription(); UIMotion.height(body, before);
  }
  placeEditButton(t); placeDraftNote(section, t, 'desc');
}
function repaintDescription() { const t = state.view === 'task' ? taskById(state.taskId) : null; if (t) paintDescription(t); }
/** Where in its text the description reader shows a click: the place in its Markdown, or null where the browser can't tell. */
function clickedPlace(reader, event) {
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY), range = caret ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = caret?.offsetNode ?? range?.startContainer;
  return node ? sourcePosition(reader, node, caret?.offset ?? range.startOffset, reader.getAttribute('data-markdown')) : null;
}
/** Select the word around `at` in `input`, as a double-click on it in the text did. */
function selectWord(input, at) {
  const word = /[\p{L}\p{N}\p{M}_]/u, text = input.value;
  let start = at, end = at;
  while (start > 0 && word.test(text[start - 1])) start--;
  while (end < text.length && word.test(text[end])) end++;
  input.setSelectionRange(start, end);
}
document.addEventListener('focusin', (event) => {
  const t = event.target.id === 'task-description' && state.view === 'task' ? taskById(state.taskId) : null;
  if (!t) return;
  descriptionOpen = { taskId: t.id, userId: me()?.id }; placeEditButton(t);
});
document.addEventListener('focusout', (event) => {
  const preview = state.view === 'task' ? event.target.closest?.('.task-page .description-preview') : null, t = preview ? taskById(state.taskId) : null;
  if (!t || App.isRendering() || document.activeElement === event.target) return;
  // Focus left the rendered text, such as one of its links: show what changed meanwhile.
  if (event.target.id !== 'task-description') { if (!preview.contains(event.relatedTarget)) queueMicrotask(repaintDescription); return; }
  descriptionOpen = null;
  // An editor that stays, such as one whose text waits for its save, stays as it is.
  if (showsDescriptionEditor(t, canBoard())) placeEditButton(t); else paintDescription(t);
});

// ---------- status, track and epic ----------
// An epic stays on its track, so moving a task to another track takes it out
// of its epic. The person who moved it sees why under Epic until they leave
// the task, or until it has an epic again or moves on.
let clearedEpic = null;
/** What the Epic cleared note under `t`'s Epic says, or nothing. */
function epicNote(t) {
  if (clearedEpic && (clearedEpic.taskId !== t.internalId || clearedEpic.userId !== me()?.id || t.epicId || t.trackId !== clearedEpic.trackId)) clearedEpic = null;
  return clearedEpic?.text ?? '';
}
// Picks on their way to the server, by task and field. A select shows its
// pick until the save settles, also when a change made elsewhere or a
// conflict question draws the page meanwhile. A track pick keeps the epic and
// track the task had when it was last drawn before it moved: the saved place
// the move leaves, which the Epic cleared note names.
const picks = new Map();
/** What the select of `field` shows for `t`: its pick on the way, else the saved value. */
function shownValue(t, field) {
  const pick = picks.get(`${t.internalId}:${field}`);
  return pick ? pick.value : field === 'state' ? t.state : t[field] ?? '';
}
/** Remember the place a track pick on its way leaves, as the page shows it now. */
function notePlace(t) {
  const pick = picks.get(`${t.internalId}:trackId`);
  if (pick && t.trackId !== pick.value) Object.assign(pick, { epicId: t.epicId, trackId: t.trackId });
}
// The task's revision when the person last opened its Status, Track, Epic or
// Assignees list. A pick builds on what its list showed: a change that lands
// while the list is open meets the conflict question, and one the page
// showed before the list opened doesn't.
let opened = null;
const noteOpened = (id) => () => { const t = taskById(id); opened = t ? { taskId: t.internalId, revision: t.revision } : null; };
const openedRevision = (t) => opened?.taskId === t.internalId ? opened.revision : undefined;
/**
 * Save the task's status, track or epic as picked in its select. The
 * selects show the saved values again once the save settles, so a pick that
 * didn't save, such as offline, doesn't stay on screen.
 */
function saveProperty(id, field, value) {
  const t = taskById(id), saving = t && App.updTask(id, field, value, openedRevision(t));
  if (typeof saving?.then !== 'function') { App.refreshTaskHeader(); return; }
  const key = `${t.internalId}:${field}`, pick = { value, epicId: t.epicId, trackId: t.trackId };
  picks.set(key, pick);
  saving.then((saved) => {
    if (picks.get(key) === pick) picks.delete(key);
    const moved = taskById(id), epic = epicById(pick.epicId), from = trackById(pick.trackId), to = field === 'trackId' && trackById(value);
    // A task that left its epic for another track says why, while its page is open.
    if (saved && to && epic && from && from !== to && moved && !moved.epicId && moved.trackId === value && state.view === 'task' && taskById(state.taskId) === moved) {
      clearedEpic = { taskId: moved.internalId, userId: me()?.id, trackId: value, text: `Epic cleared: “${epic.title}” is on ${from.name}, not ${to.name}.` };
      announce(clearedEpic.text);
    }
    App.refreshTaskHeader();
  });
}
// A select skips changes from elsewhere while its list is open, so it shows them once the list closes.
const showSaved = () => App.refreshTaskHeader();
/** The task's Track and Epic, with the Epic cleared note. */
function trackEpicHtml(t, canEdit) {
  notePlace(t);
  const note = epicNote(t);
  return `<div class="task-property"><dt>Track</dt><dd>${selectHtml('tpTrack', { label: 'Track', cls: 'prop', disabled: !canEdit, icon: I.track, value: shownValue(t, 'trackId'), options: trackOptions(), pick: (v) => saveProperty(t.id, 'trackId', v), onOpen: noteOpened(t.id), onClose: showSaved })}</dd></div>
        <div class="task-property"><dt>Epic</dt><dd>${selectHtml('tpEpic', { label: 'Epic', cls: 'prop', disabled: !canEdit, icon: I.roadmap, value: shownValue(t, 'epicId'), search: true, describedBy: note ? 'tpEpic-note' : '', options: epicOptions(t.trackId, t.epicId), pick: (v) => saveProperty(t.id, 'epicId', v), onOpen: noteOpened(t.id), onClose: showSaved })}${note ? `<p class="task-property-note" id="tpEpic-note">${esc(note)}</p>` : ''}</dd></div>`;
}
/** Show the open task's track and epic in place: their choices, values and the Epic cleared note. */
function paintTrackEpic(t, page) {
  notePlace(t);
  setSelectValue('tpTrack', shownValue(t, 'trackId'), trackOptions());
  setSelectValue('tpEpic', shownValue(t, 'epicId'), epicOptions(t.trackId, t.epicId));
  const button = page.querySelector('#select-tpEpic'), note = epicNote(t), old = page.querySelector('#tpEpic-note');
  if (!button || (old?.textContent ?? '') === note) return;
  old?.remove();
  if (!note) { button.removeAttribute('aria-describedby'); return; }
  const element = document.createElement('p'); element.className = 'task-property-note'; element.id = 'tpEpic-note'; element.textContent = note;
  button.closest('dd').append(element); button.setAttribute('aria-describedby', element.id);
}

/** The task page's status and Blocked badge in the top bar, and its Properties heading with Block task. */
const taskStatusHtml = (t) => `<span class="chip idle task-status-chip">${stIcon(t.state)}${STATUS[t.state]}</span>${t.block ? `<span class="blocked-badge">${I.blocked}Blocked</span>` : ''}`;
const taskPropertiesHeadingHtml = (t, canEdit) => `<div class="task-properties-heading"><h2 id="task-properties-heading">Properties</h2>${canEdit && t.state !== 'done' && !t.block ? `<button class="btn block-task-action" ${UIAction('openModal', 'block', t.id)}>${I.blocked}Block task</button>` : ''}</div>`;
/** The open task's page. */
export function renderTask() {
  const t = taskById(state.taskId);
  if (!t) { state.view = 'board'; return renderBoard(); }
  const canEdit = canBoard();
  const title = taskDraft(t, 'title')?.value ?? t.title;
  const feed = taskActivityHtml(t);
  if (descriptionOpen && !descriptionIsOpen(t)) descriptionOpen = null;

  const late = overdue(t);
  return `<div class="task-page"><div class="task-layout${t.block ? ' has-block' : ''}">
      <div class="task-title-field"><textarea class="tp-title" name="title" aria-label="Task title" rows="1" placeholder="Fix payment validation" required aria-required="true" maxlength="140" data-autosave ${UIAction.on('input', 'sizeTaskTitle')} data-key="Enter" ${UIAction.on('keydown', 'leaveField', UIAction.event, UIAction.element)} ${canEdit ? UIAction.on('blur', 'updTask', t.id, 'title', UIAction.value) : lockedField(t, 'title')}>${esc(title)}</textarea>${taskDraftNote(t, 'title')}</div>
    ${t.block ? `<section class="task-block" data-block-id="${esc(t.block.id)}" tabindex="-1" aria-label="Task blocked"><div class="task-block-heading"><strong>${I.blocked}Blocked</strong>${canEdit ? `<button class="btn unblock-action" ${UIAction('openModal', 'unblock', t.id)}>Unblock task</button>` : ''}</div><p>${blockText(t.block)}</p><div class="task-block-footer"><small>${esc(userById(t.block.by)?.name || t.block.by)} · ${ago(t.block.at)}</small>${canEdit ? `<button class="btn block-edit-action" ${UIAction('openModal', 'block', t.id)}>Edit reason</button>` : ''}</div></section>` : ''}
    <aside class="tp-rail" aria-labelledby="task-properties-heading">
      ${taskPropertiesHeadingHtml(t, canEdit)}
      <dl class="task-properties">
        <div class="task-property"><dt>Status</dt><dd>${selectHtml('tpState', { label: 'Status', cls: 'prop', disabled: !canEdit, icon: stIcon(shownValue(t, 'state')), value: shownValue(t, 'state'), options: Object.entries(STATUS).map(([v, l]) => ({ v, l, icon: stIcon(v) })), pick: (v) => saveProperty(t.id, 'state', v), onOpen: noteOpened(t.id), onClose: showSaved })}</dd></div>
        ${trackEpicHtml(t, canEdit)}
        <div class="task-property"><dt>Assignees</dt><dd>${msHtml('tpAssign', t.id, !canEdit)}</dd></div>
        <div class="task-property task-property-date prop-row${late ? ' late' : ''}"><dt>Deadline</dt><dd>${dateHtml('tpDl', { hideLabel: true, cls: 'prop', disabled: !canEdit, icon: I.clock, name: '_dl', value: t.deadline || '', clearable: true, autosave: true, pick: (v) => App.updTask(t.id, 'deadline', v) })}<span class="task-overdue" ${late ? '' : 'hidden'}>Overdue</span></dd></div>
        <div class="task-property"><dt>Created at</dt><dd>${Number.isFinite(t.created)?`<time class="task-created-at" datetime="${new Date(t.created).toISOString()}">${formatInstant(t.created)}</time>`:'<span class="task-created-at">Unavailable</span>'}</dd></div>
      </dl>
    </aside>
    <div class="tp-main">
      <div class="tp-sec task-description expandable-description" data-task="${esc(t.id)}" data-description-key="task-${esc(t.id)}">${descriptionHeadingHtml(t, canEdit)}
        <div class="description-preview">${descriptionBodyHtml(t, canEdit)}</div>
        <button type="button" class="description-toggle" aria-controls="${descriptionBodyId(t, canEdit)}" aria-expanded="false" ${UIAction('toggleDescription')} hidden>Show more</button>${taskDraftNote(t, 'desc')}</div>
      ${checklistHtml(t, canEdit)}
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
    toggle: (v) => { clearTaskSaved();if (!App.require('manage_board') || !recovery.ensureOnline()) return; const t = taskById(taskId); if(!t){App.toast('This task is no longer available','error');return;} if(!(t.assignees||[]).includes(v)&&!projectMembers().some(u=>u.id===v)){App.toast('This person is no longer a project member','error');return;} runtime().setAssignees(t.internalId,t.assignees.includes(v)?t.assignees.filter(id=>id!==v):[...t.assignees,v],openedRevision(t)).catch(report); },
    onOpen: noteOpened(taskId),
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

/**
 * After the task page draws: remember the timeline's rows, so a refresh keeps
 * the ones that did not change, and fold long comments.
 */
export function mountTaskPage() {
  document.querySelectorAll('.timeline > [data-feed-key]').forEach(el=>feedRowMarkup.set(el,el.outerHTML));
  // Long comments fold before the render puts the scroll position back, so the reader stays at the same comment.
  sizeCommentBodies();
}

/** Clear a Saved status, and an Epic cleared note, that belong to another page or person. */
export function clearStaleTaskSave() {
  if(taskSaveFeedback&&(state.view!=='task'||state.taskId!==taskSaveFeedback.id||me()?.id!==taskSaveFeedback.owner))clearTaskSaved();
  if(clearedEpic&&(state.view!=='task'||taskById(state.taskId)?.internalId!==clearedEpic.taskId))clearedEpic=null;
}

document.addEventListener('input', (e) => { if(e.target.closest('.task-page'))clearTaskSaved(); }, true);

Object.assign(App, {
  /**
   * Show the title's and description's drafts, or their saved values once
   * the drafts are gone (such as after Use latest), with their Not saved
   * notes. The field being edited keeps what the person is typing.
   */
  refreshTaskDrafts(id) {
    if (state.view !== 'task' || state.taskId !== id) return;
    const t = taskById(id); if (!t) return;
    paintTitle(t); paintDescription(t);
  },
  /**
   * Open the description's editor, focused with the caret where a click on
   * its text landed, else at the end. The second press of a double-click
   * selects the word the first one landed on. A click that lands on a link, a
   * box or a summary, or that ends a text selection, leaves the description
   * as it is.
   */
  editDescription(id, event) {
    const t = taskById(id);
    if (!t || state.view !== 'task' || taskById(state.taskId) !== t || !canBoard()) return;
    if (event && (event.target.closest('a,input,summary') || !getSelection().isCollapsed)) return;
    // The editor takes the text's place, so the click's place is read first.
    const reader = document.getElementById('task-description-content'), clicked = event && reader?.hasAttribute('data-markdown') ? clickedPlace(reader, event) : null;
    descriptionOpen = { taskId: t.id, userId: me()?.id };
    paintDescription(t);
    const input = document.getElementById('task-description');
    if (!input) return;
    const caret = clicked ?? input.value.length, text = input.value;
    input.focus({ preventScroll: true });
    // Not every browser scrolls a field to a caret placed by code, so the
    // field measures the text before the caret, and shows the line where it
    // ends once that text is taller than the field.
    input.value = text.slice(0, caret); const line = input.scrollHeight; input.value = text;
    input.setSelectionRange(caret, caret); input.scrollTop = line > input.clientHeight ? line - input.clientHeight / 2 : 0;
    if (clicked !== null) input.addEventListener('mousedown', (press) => { if (press.detail !== 2) return; press.preventDefault(); selectWord(input, clicked); }, { once: true });
  },
  /**
   * Escape and Cmd/Ctrl+Enter leave the description, which saves it, and
   * give focus to Edit. An empty description has no Edit: its field, which
   * stays, is what opens it again.
   */
  descriptionKey(event) {
    if (event.isComposing || event.keyCode === 229 || !(event.key === 'Escape' || event.key === 'Enter' && (event.metaKey || event.ctrlKey))) return;
    event.preventDefault(); event.stopPropagation();
    const input = event.currentTarget, edit = input.closest('.task-description')?.querySelector('.description-edit');
    input.blur();
    (edit && !edit.hidden ? edit : document.getElementById('task-description'))?.focus({ preventScroll: true });
  },
  /**
   * Show the saved status, block and deadline of the open task around its
   * fields: the header chip and badge, Status, Block task and Overdue. A
   * field save, and a change from elsewhere, draw the page again only once
   * focus leaves it.
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
    const status = shownValue(t, 'state');
    page.querySelector('#select-tpState > svg')?.replaceWith(html(stIcon(status)));
    setSelectValue('tpState', status);
    paintTrackEpic(t, page);
    const late = overdue(t);
    page.querySelector('.task-property-date')?.classList.toggle('late', late);
    page.querySelector('.task-overdue')?.toggleAttribute('hidden', !late);
  },
  /**
   * Show the open task as it is saved now, after a read of it or a change
   * from elsewhere, such as a teammate, another tab or an MCP agent: its
   * header, Status, title, description and checklist at once, in place, and
   * the rest of the page once focus leaves it. The field being typed in keeps
   * what the person is typing. The checklist waits for a press on the page to
   * end: a row that moves under the pointer would lose its click.
   */
  refreshTask(id) {
    App.refreshTaskHeader(); App.refreshTaskDrafts(id);
    if (!App.afterPress(refreshShownChecklist)) App.refreshTaskChecklist(id);
    App.refreshBackground();
  },
  /** Show a task's checklist as it is now, in place, when its page is open. */
  refreshTaskChecklist(id) { refreshChecklist(taskById(id)); },
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
