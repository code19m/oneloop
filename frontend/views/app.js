// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* Application view renderer, an ES module that frontend/src/app/boot.js
   imports once it has set DATA and loaded the classic view scripts. The view
   bridge then adds the server-backed actions to `App`. See
   frontend/README.md before changing an action. */

import {
  MULTI, dateHtml, dateValue, field, multiHtml, optionalMark, resetFieldIds, selectHtml,
} from './app/controls.js';
import './app/drag.js';
import {
  MOTION, animateLayout, exitVisual, exitVisuals, fadeContent, motionRects, reducedMotion,
  uiAnimate, uiAnimations,
} from './app/effects.js';
import {
  I, STATUS, ago, avatarHtml, d, esc, formatInstant, humanInstant, humanShort, instanceDateKey,
  instanceTimeZone, instanceToday, iso, overdue, previousDate, setHTML, stIcon, today,
} from './app/format.js';
import {
  descriptionEditorHtml, mountDescription, sizeDescription, sizeDescriptionEditors, sizeTaskTitle,
  taskModalHtml,
} from './app/forms.js';
import {
  App, D, activeAdmins, canBoard, canReadProject, canReadTask, collaboration, counts, epicById,
  epics, hasPermission, instanceNow, invoke, isAdmin, locallyRenderedHashes, me, poolItems,
  project, projectMembers, setLocalHash, state, taskById, tasks, trackById, tracks, userById,
  userHandle, visibleProjects,
} from './app/model.js';
import {
  POP, askConfirmation, askToDiscard, closePop, dismissMenu, hideEpicTip, overlayKey,
  pendingConfirmation, placeMenu, placePop, rememberOpener, renderMenu, restoreOpener,
  showWaitingPassword, stampOverlays, syncOverlayFocus, syncSidebar,
} from './app/overlays.js';
import {
  mountRoadmap, renderPeek, renderRoadmap, roadmapHeight, roadmapTopbarHtml,
} from './app/roadmap.js';
import { announce, ensureToastRegion } from './app/toasts.js';

const NO_ASSIGNEE = '__unassigned__';
const TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const boardScrollMemory=new Map();
function prepareRenderMotion(overlaysOnly=false) {
  const page = overlaysOnly?null:document.querySelector('.content');
  const previous = new Map();
  if(page?.dataset.pageKey?.includes(':board:'))boardScrollMemory.set(`${D.session?.userId}:${page.dataset.pageKey}`, [...document.querySelectorAll('.board,.col-cards')].map(el=>[el.closest('[data-col]')?.dataset.col,el.scrollLeft,el.scrollTop]));
  const scrim = document.querySelector('#overlay-root > .scrim');
  if (state.modal || state.peek || state.menu) {
    exitVisuals.forEach(el => { uiAnimations.get(el)?.cancel(); el.remove(); }); exitVisuals.clear();
  } else if (scrim) exitVisual(scrim);
  ['.modal','.peek','.menu'].forEach((selector) => {
    const el = document.querySelector('#app ' + selector);
    if (!el) return;
    previous.set(selector, el.dataset.motionKey || '');
    if (!overlayKey(selector)) exitVisual(el);
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
      fadeContent(page);
      if(state.view==='board')for(const [col,left,top] of boardScrollMemory.get(`${D.session?.userId}:${key}`)||[]){const el=document.querySelector(col?`[data-col="${UIEscape(col)}"] .col-cards`:'.board');if(el){el.scrollLeft=left;el.scrollTop=top;}}
    }
    else if (before.pageKey === key) before.scrolls.forEach(([classes, col, left, top]) => {
      const selector = '.' + classes.trim().split(/\s+/).join('.');
      const el = document.querySelector(col ? `[data-col="${UIEscape(col)}"] ${selector}` : selector);
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

/** The cards a Board column shows, in order. */
const shownColumn = (col) => boardTasks().filter((item) => item.state === col).slice(0, state.boardLimits[col] || 50);
/** Whether a column shows its last card: the server has no more, and every loaded card is drawn. */
function columnEndShown(col, except) {
  const page = D.boardPageInfo?.projectId === state.projectId ? D.boardPageInfo.pages?.[col] : null;
  return !page?.nextCursor && boardTasks().filter((item) => item.state === col && item !== except).length <= (state.boardLimits[col] || 50);
}
// Without a target card, a card follows the last card its column shows, or
// goes to the top with `atTop`.
function taskMovePlan(t, col, beforeId = null, atTop = false) {
  const originalColumn = tasks().filter((item) => item.state === col);
  const destination = originalColumn.filter((item) => item !== t);
  const last = beforeId || atTop ? null : shownColumn(col).filter((item) => item !== t).at(-1) ?? destination.at(-1);
  const index = beforeId ? destination.findIndex((item) => item.id === beforeId) : last ? destination.indexOf(last) + 1 : 0;
  if (beforeId && index < 0) return null;
  const nextColumn = [...destination]; nextColumn.splice(index, 0, t);
  if (t.state === col && originalColumn.length === nextColumn.length && originalColumn.every((item, at) => item === nextColumn[at])) return null;
  const placement = beforeId
    ? { beforeTaskId: taskById(beforeId)?.internalId || beforeId }
    : last
      ? { afterTaskId: last.internalId || last.id }
      : { position: 0 };
  return { destination, index, placement };
}

function applyTaskMove(t, col, beforeId = null, atTop = false) {
  // A newest-first Done shows a finished task on top and has no manual order to change.
  const newest = col === 'done' && doneNewest();
  if (newest) { if (t.state === 'done') return null; beforeId = null; atTop = true; }
  const plan = taskMovePlan(t, col, beforeId, atTop); if (!plan) return null;
  const shownBefore = shownColumn(col).filter((item) => item !== t);
  const previousState = t.state, projectId=t.projectId||trackById(epicById(t.epicId)?.trackId)?.projectId||state.projectId, sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`;
  const taskProject=(item)=>item.projectId||trackById(epicById(item.epicId)?.trackId)?.projectId;
  const previousProjectTasks=D.tasks.filter((item)=>taskProject(item)===projectId),taskIndex=previousProjectTasks.indexOf(t);
  const previousTaskBefore=taskIndex>0?previousProjectTasks[taskIndex-1]:null,previousTaskAfter=previousProjectTasks[taskIndex+1]||null;
  const previousOrders = new Map(tasks().map((item)=>[item,item.order]));
  const pageInfoReference=D.boardPageInfo;
  const previousPageInfo = D.boardPageInfo ? JSON.parse(JSON.stringify(D.boardPageInfo)) : null;
  const countsReference=D.projectTaskCounts?.[projectId]||null;
  const previousCounts = countsReference ? { ...countsReference } : null;
  const affectedEpics = new Map();
  for (const id of new Set([t.epicId])) { const item = epicById(id); if (item) affectedEpics.set(id, { item, state:item.state, done:item.done }); }
  D.tasks.splice(D.tasks.indexOf(t), 1);
  const next = plan.destination[plan.index], previous = plan.destination[plan.index - 1];
  const at = next ? D.tasks.indexOf(next) : previous ? D.tasks.indexOf(previous) + 1 : D.tasks.length;
  D.tasks.splice(Math.max(0, at), 0, t);
  t.state = col;
  if (newest) t.completedAt = Date.now();
  for (const status of new Set([previousState,col])) tasks().filter((item)=>item.state===status).forEach((item,index)=>{item.order=index;});
  // The column keeps showing every card it showed, and shows the moved card too.
  const column = boardTasks().filter((item) => item.state === col);
  state.boardLimits[col] = Math.max(state.boardLimits[col] || 50, ...[t, ...shownBefore].map((item) => column.indexOf(item) + 1));
  const epic = epicById(t.epicId);
  if (epic) {
    if (col === 'done') epic.done += 1;
    if (previousState === 'done') epic.done = Math.max(epic.done - 1, 0);
    if (col !== 'planning' && epic.state === 'planning') epic.state = 'active';
  }
  const pages=D.boardPageInfo?.projectId===projectId?D.boardPageInfo?.pages:null;
  if(previousState!==col&&pages){if(pages[previousState])pages[previousState].total=Math.max(0,pages[previousState].total-1);if(pages[col])pages[col].total+=1;}
  const counts=D.projectTaskCounts?.[projectId];
  if(previousState!==col&&counts){counts[previousState]=Math.max(0,(counts[previousState]||0)-1);counts[col]=(counts[col]||0)+1;counts.open=counts.planning+counts.progress+counts.review;}
  const optimisticOrders=new Map([...previousOrders.keys()].map((item)=>[item,item.order]));
  const optimisticEpics=new Map([...affectedEpics].map(([id])=>{const item=epicById(id);return[id,{item,state:item?.state,done:item?.done}];}));
  return {
    task:t, revision:t.revision, projectId, sessionKey, previousState, optimisticState:col,
    previousTaskBefore,previousTaskAfter,previousOrders,optimisticOrders,
    pageInfoReference,previousPageInfo,optimisticPageInfo:D.boardPageInfo?JSON.parse(JSON.stringify(D.boardPageInfo)):null,
    countsReference,previousCounts,optimisticCounts:countsReference?{...countsReference}:null,affectedEpics,optimisticEpics,
    payload:{ taskId:t.internalId||t.id, status:col, ...(newest ? {} : plan.placement), optimistic:true },
  };
}

function rollbackTaskMove(change) {
  const sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`;
  if (!change || sessionKey!==change.sessionKey || !D.tasks.includes(change.task) || change.task.revision !== change.revision || change.task.state!==change.optimisticState) return false;
  const currentIndex=D.tasks.indexOf(change.task);D.tasks.splice(currentIndex,1);
  if(change.previousTaskAfter&&D.tasks.includes(change.previousTaskAfter))D.tasks.splice(D.tasks.indexOf(change.previousTaskAfter),0,change.task);
  else if(change.previousTaskBefore&&D.tasks.includes(change.previousTaskBefore))D.tasks.splice(D.tasks.indexOf(change.previousTaskBefore)+1,0,change.task);
  else D.tasks.splice(Math.min(currentIndex,D.tasks.length),0,change.task);
  change.task.state=change.previousState;
  for(const [item,order] of change.previousOrders)if(D.tasks.includes(item)&&item.order===change.optimisticOrders.get(item))item.order=order;
  if(change.previousPageInfo&&D.boardPageInfo===change.pageInfoReference&&JSON.stringify(D.boardPageInfo)===JSON.stringify(change.optimisticPageInfo))D.boardPageInfo=change.previousPageInfo;
  if(change.previousCounts&&D.projectTaskCounts?.[change.projectId]===change.countsReference&&JSON.stringify(change.countsReference)===JSON.stringify(change.optimisticCounts))D.projectTaskCounts[change.projectId]=change.previousCounts;
  for(const [id,value] of change.affectedEpics){const item=epicById(id),optimistic=change.optimisticEpics.get(id);if(item===value.item&&item===optimistic?.item&&item.state===optimistic.state&&item.done===optimistic.done)Object.assign(item,{state:value.state,done:value.done});}
  return true;
}

function submitTaskMove(change,onRollback=()=>App.refresh()) {
  if (!change) return;
  const pending={};App._boardMovePending=pending;
  window.OneloopRuntime.invoke('task.move',change.payload).catch((error)=>{
    if(!error?.uncertain&&rollbackTaskMove(change)&&state.view==='board'&&state.projectId===change.projectId)onRollback();
    window.OneloopRuntime.report(error);
  }).finally(()=>{if(App._boardMovePending===pending)App._boardMovePending=false;});
}

function setTaskState(t, col) {
  if (!canBoard()) return;
  if (App._boardMovePending) return false;
  if (t.state === col) return;
  if (t.block && col === 'done') { App.openModal('completeBlocked', t.id); return false; }
  // A column that does not show its end takes the card at the top, where it stays in view.
  const change=applyTaskMove(t,col,null,!columnEndShown(col,t));if(!change)return false;submitTaskMove(change);
}
function focusMovedTask(id) {
  if (state.view !== 'board' || state.modal) return;
  const card = [...document.querySelectorAll('.card[data-task]')].find(el=>el.dataset.task===id);
  card?.scrollIntoView?.({block:'nearest',inline:'nearest'});
  (card?.querySelector('.card-move') || card?.querySelector('.card-title-button') || document.getElementById('main'))?.focus({preventScroll:true});
  announce(`${id} moved to ${STATUS[taskById(id)?.state] || 'new position'}`);
}

// ---------- board ----------
const COLS = [
  { key: 'planning', name: 'Planning' },
  { key: 'progress', name: 'In Progress' },
  { key: 'review', name: 'In Review' },
  { key: 'done', name: 'Done' },
];
/** Whether the loaded Done column lists the most recently completed task first. */
const doneNewest = () => D.boardPageInfo?.projectId === state.projectId && D.boardPageInfo?.filters?.doneOrder === 'completed';

function taskBits(t) {
  if (t.state === 'done') return { right: stIcon('done'), cls: 'done' };
  if (t.state === 'review') return { right: '', cls: 'review' };
  return { right: '', cls: '' };
}

function boardTasks() {
  let ts = tasks();
  if (state.boardTracks.length) { const eids = new Set(epics().filter((e) => state.boardTracks.includes(e.trackId)).map((e) => e.id)); ts = ts.filter((t) => eids.has(t.epicId)); }
  if (state.boardEpics.length) ts = ts.filter((t) => state.boardEpics.includes(t.epicId));
  if (state.boardAssignees.length) ts = ts.filter((t) => {
    const assignees = t.assignees || [];
    return (!assignees.length && state.boardAssignees.includes(NO_ASSIGNEE)) || assignees.some((a) => state.boardAssignees.includes(a));
  });
  if (state.boardBlocked) ts = ts.filter(t=>!!t.block && t.state!=='done');
  if (state.boardQ) { const q = state.boardQ.toLowerCase(); ts = ts.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)); }
  return ts;
}

/** @param {{column?:string|null,excludeIds?:Set<string>|null}} [options] */
function renderBoard({column=null,excludeIds=null}={}) {
  const ts = boardTasks();
  const filtered = state.boardBlocked || state.boardQ || state.boardTracks.length || state.boardEpics.length || state.boardAssignees.length;
  if (!ts.length) return `<div class="board board-empty"><div class="page-empty"><h2>${filtered ? 'No matching tasks' : 'No tasks yet'}</h2>${filtered ? `<button class="btn quiet" ${UIAction('clearBoardFilters')}>Clear filters</button>` : canBoard() ? `<button class="btn primary" ${UIAction('openModal', 'task')}>${I.plus} Create task</button>` : ''}</div></div>`;
  const cols = COLS.filter(c=>!column||c.key===column).map((c) => {
    const list = ts.filter((t) => t.state === c.key);
    const serverPage = D.boardPageInfo?.projectId === state.projectId ? D.boardPageInfo.pages?.[c.key] : null;
    const cards = list.slice(0,state.boardLimits[c.key] || 50).filter(t=>!excludeIds?.has(t.id)).map((t) => {
      const e = epicById(t.epicId);
      const b = taskBits(t);
      const av = (t.assignees || []).filter(userById);
      const avs = av.slice(0, 3).map((a) => avatarHtml(a, 18)).join('') + (av.length > 3 ? `<span class="avatar" style="width:18px;height:18px;font-size:var(--text-xs)">+${av.length - 3}</span>` : '');
      return `<div role="listitem" class="card ${b.cls}${t.block ? ' blocked' : ''}" data-task="${UIEscape(t.id)}" ${canBoard() ? `data-reorderable="true" ${UIAction.on('dragstart', 'taskDragStart', UIAction.event, t.id)} ${UIAction.on('dragend', 'dragEnd')}` : ''} ${UIAction('openTask', t.id)}>
        <div class="id-row"><span>${esc(t.id)}</span><span class="card-end">${t.block ? `<span class="blocked-badge" data-tip-tap data-tip="${esc(t.block.reason)} — ${esc(userById(t.block.by)?.name || t.block.by)} · ${esc(formatInstant(t.block.at))}">${I.blocked}Blocked</span>` : ''}${b.right}${canBoard() ? `<button type="button" class="card-move" aria-label="Move ${esc(t.id)}" ${UIAction('taskMoveMenu', UIAction.event, t.id)}>${I.kebab}</button>` : ''}</span></div>
        <button type="button" class="title card-title-button" aria-describedby="card-context-${esc(t.id)}"${t.block ? ` data-tip="${esc(t.block.reason)} — ${esc(userById(t.block.by)?.name || t.block.by)} · ${esc(formatInstant(t.block.at))}" data-tip-keyboard` : ''}>${esc(t.title)}</button>
        <span class="sr-only" id="card-context-${esc(t.id)}">${esc([t.id,c.name,e?.title,t.deadline ? 'Due '+t.deadline : '',overdue(t) ? 'Overdue' : '',t.block ? 'Blocked: '+t.block.reason+' — '+(userById(t.block.by)?.name||t.block.by)+' · '+formatInstant(t.block.at) : '',av.length ? 'Assigned to '+av.map(id=>userById(id).name).join(', ') : 'Unassigned'].filter(Boolean).join(' · '))}</span>
        <div class="epic" data-tip="${esc(e ? e.title : '')}" data-tip-overflow>${esc(e ? e.title : '')}</div>
        <div class="card-foot">
          <span class="mono card-created"${t.created ? ` data-tip="Created ${esc(formatInstant(t.created))}"` : ''}>${t.created ? humanInstant(t.created) : ''}</span>
          ${t.deadline ? `<span class="mono dl${overdue(t) ? ' late' : ''}" data-tip="Deadline ${esc(t.deadline)}">${I.clock}${humanShort(d(t.deadline))}${overdue(t) ? ' · Overdue' : ''}</span>` : ''}
          <span class="avs">${avs}</span>
        </div></div>`;
    }).join('');
    return `<section class="col" aria-labelledby="col-${c.key}" data-col="${UIEscape(c.key)}" ${canBoard() ? `${UIAction.on('dragover', 'colOver', UIAction.event)} ${UIAction.on('dragleave', 'colLeave', UIAction.event)} ${UIAction.on('drop', 'dropTask', UIAction.event, c.key)}` : ''}>
      <div class="col-head"><div class="row1">${stIcon(c.key)}<h2 id="col-${UIEscape(c.key)}">${c.name}</h2><span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${serverPage?.total ?? list.length}</span>${c.key === 'done' ? `<button type="button" class="btn quiet done-order" aria-pressed="${doneNewest()}" ${UIAction('toggleDoneOrder')}>Newest first</button>` : ''}</div>
      </div>
      <div class="col-cards" role="list" aria-labelledby="col-${c.key}">${cards || '<div class="empty-note" role="listitem">No tasks</div>'}${serverPage?.nextCursor ? `<div role="listitem" class="board-load-more"><button class="btn quiet" ${UIAction('loadMoreBoard', c.key)}>Load more</button></div>` : ''}</div></section>`;
  }).join('');
  return `<div class="board">${cols}</div>`;
}

const filterAnimations = new Set();
const filterExitLayers = new Set();
const filterScroll = new WeakMap();
const boardSnapshots = new WeakMap();
let boardSearchTimer;
function cancelBoardSearch() { clearTimeout(boardSearchTimer); boardSearchTimer = null; }
function boardSnapshot() {
  // Display dependencies, not just task revisions: access, parent names,
  // avatars and date boundaries can change independently of a task.
  return JSON.stringify([
    state.projectId, canBoard(), instanceTimeZone(), instanceDateKey(instanceNow()),
    !!(state.boardQ || state.boardBlocked || state.boardTracks.length || state.boardEpics.length || state.boardAssignees.length),
    state.boardLimits, D.boardPageInfo,
    boardTasks().map(t=>[t.id,t.state,t.title,t.epicId,t.created,t.deadline,t.assignees,t.block]),
    D.epics.map(e=>[e.id,e.title]), D.users.map(u=>[u.id,u.name,u.avatar]),
  ]);
}
function clearFilterMotion() {
  filterAnimations.forEach((animation) => animation.cancel());
  filterAnimations.clear();
  filterExitLayers.forEach((layer) => layer.remove());
  filterExitLayers.clear();
}
function filterAnimate(element, frames, cleanup) {
  const animation = element.animate(frames, { duration: MOTION.normal, easing: MOTION.ease });
  filterAnimations.add(animation);
  const finish = () => { filterAnimations.delete(animation); cleanup?.(); };
  animation.finished.then(finish, finish);
}
function boardRowKey(row, column) {
  if (row.dataset.task) return `task:${row.dataset.task}`;
  return `${column}:${row.classList.contains('empty-note') ? 'empty' : 'more'}`;
}
// Board rows have stable actions for their key. Preserve their DOM/listeners,
// focus and images while updating changed presentation. Permission changes
// replace a card so its drag handlers are installed/removed together.
function patchBoardRow(current, next) {
  for (const attribute of [...current.attributes])
    if (!attribute.name.startsWith('on') && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of next.attributes)
    if (!attribute.name.startsWith('on') && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  const children = [...next.childNodes];
  children.forEach((child, index) => {
    const old = current.childNodes[index];
    if (!old) { current.append(child); return; }
    if (old.nodeType !== child.nodeType || old.nodeName !== child.nodeName) { old.replaceWith(child); return; }
    if (child.nodeType === Node.ELEMENT_NODE) patchBoardRow(old, child);
    else if (old.nodeValue !== child.nodeValue) old.nodeValue = child.nodeValue;
  });
  while (current.childNodes.length > children.length) current.lastChild.remove();
  return current;
}
function applyBoardFilters(reset = true, fromServer = false, { animate: motion = true } = {}) {
  if (!fromServer) cancelBoardSearch();
  App.updateDocumentTitle();
  if(reset) state.boardLimits = {planning:50,progress:50,review:50,done:50};
  if(!fromServer){invoke('board.filter',App.context().board);return;}
  const board = document.querySelector('.board');
  if (!board || state.view !== 'board') return;
  const snapshot = boardSnapshot();
  if (boardSnapshots.get(board) === snapshot) return;
  today.setTime(instanceToday().getTime());
  // Snapshot painted positions before cancelling an interrupted transition.
  const previous = new Map([...board.querySelectorAll('.col-cards > *')].map((card) =>
    [boardRowKey(card,card.closest('.col').dataset.col), { card, rect: card.getBoundingClientRect(), opacity: getComputedStyle(card).opacity }]));
  clearFilterMotion();
  const animate = motion && !reducedMotion.matches && typeof board.animate === 'function' && !App._drag;
  const template = document.createElement('template');
  setHTML(template,renderBoard());
  if (!board.querySelector('.col') || !template.content.querySelector('.col')) {
    const next=template.content.firstElementChild;
    if (board.classList.contains('board-empty') && next.classList.contains('board-empty')
      && board.textContent===next.textContent && board.querySelector('button')?.className===next.querySelector('button')?.className) {boardSnapshots.set(board,snapshot);return;}
    board.replaceWith(next); boardSnapshots.set(next,snapshot); fadeContent(next); return;
  }
  [...board.querySelectorAll('.col')].forEach((column) => {
    const list = column.querySelector('.col-cards');
    const next = template.content.querySelector(`[data-col="${UIEscape(column.dataset.col)}"]`);
    const desired = [...next.querySelector('.col-cards').children];
    const ids = new Set(desired.map((card) => card.dataset.task).filter(Boolean));
    const viewport = list.getBoundingClientRect();
    const oldCards = [...list.querySelectorAll('.card')];
    const memory = filterScroll.get(list);
    const scrollTop = memory && list.scrollTop === memory.applied ? memory.wanted : list.scrollTop;
    let exitLayer;
    if (animate) oldCards.forEach((card) => {
      const old = previous.get(boardRowKey(card,column.dataset.col));
      if (ids.has(card.dataset.task) || old.rect.bottom <= viewport.top || old.rect.top >= viewport.bottom) return;
      if (!exitLayer) {
        exitLayer = document.createElement('div');
        exitLayer.className = 'board-filter-exits';
        exitLayer.style.cssText = `left:${list.offsetLeft}px;top:${list.offsetTop}px;width:${list.clientWidth}px;height:${list.clientHeight}px`;
        exitLayer.setAttribute('aria-hidden', 'true'); exitLayer.inert = true;
        column.append(exitLayer); filterExitLayers.add(exitLayer);
      }
      const ghost = card.cloneNode(true);
      ghost.removeAttribute('data-task'); ghost.removeAttribute('data-reorderable');
      for (const name of ghost.getAttributeNames()) if (/^data-(?:action|args)\b/.test(name)) ghost.removeAttribute(name);
      ghost.style.cssText = `position:absolute;margin:0;left:${old.rect.left - viewport.left}px;top:${old.rect.top - viewport.top}px;width:${old.rect.width}px;height:${old.rect.height}px`;
      exitLayer.append(ghost);
      const layer = exitLayer;
      filterAnimate(ghost, [{ opacity: old.opacity }, { opacity: 0 }], () => {
        ghost.remove();
        if (!layer.children.length) { layer.remove(); filterExitLayers.delete(layer); }
      });
    });
    // Keep unchanged children connected; replaceChildren would detach focused
    // controls and restart empty-state/Load more entrance animations.
    let cursor=list.firstElementChild;
    for (const row of desired) {
      const old=previous.get(boardRowKey(row,column.dataset.col))?.card;
      const child=old && old.hasAttribute('data-reorderable')===row.hasAttribute('data-reorderable') ? patchBoardRow(old,row) : row;
      if (child===cursor) cursor=cursor.nextElementSibling;
      else list.insertBefore(child,cursor);
    }
    while(cursor){const next=cursor.nextElementSibling;cursor.remove();cursor=next;}
    const count=column.querySelector('.col-head .row1 .mono'),nextCount=next.querySelector('.col-head .row1 .mono').textContent;
    if(count.textContent!==nextCount)count.textContent=nextCount;
    const order=column.querySelector('.col-head .done-order'),pressed=next.querySelector('.col-head .done-order')?.getAttribute('aria-pressed');
    if(order&&pressed&&order.getAttribute('aria-pressed')!==pressed)order.setAttribute('aria-pressed',pressed);
    list.scrollTop = scrollTop;
    filterScroll.set(list, { wanted: scrollTop, applied: list.scrollTop });
    if (!animate) return;
    [...list.children].forEach((card) => {
      const to = card.getBoundingClientRect(), old = previous.get(boardRowKey(card,column.dataset.col));
      const visible = to.bottom > viewport.top && to.top < viewport.bottom;
      const wasVisible = old && old.rect.bottom > viewport.top && old.rect.top < viewport.bottom;
      if (!visible && !wasVisible) return;
      if (!old) {
        filterAnimate(card, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }]);
      } else {
        const dx = old.rect.left - to.left, dy = old.rect.top - to.top;
        if (Math.abs(dx) + Math.abs(dy) > .5 || Number(old.opacity) < 1)
          filterAnimate(card, [{ opacity: old.opacity, transform: `translate(${dx}px,${dy}px)` }, { opacity: 1, transform: 'none' }]);
      }
    });
  });
  boardSnapshots.set(board,snapshot);
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
        <div class="modal-actions"><button class="btn primary" type="submit" style="width:100%;justify-content:center">Sign in</button></div>
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
  fadeContent(host);UIMotion.height(host,before);
  if (hadFocus) (host.querySelector('button:not(:disabled)') || host.querySelector('h2'))?.focus({preventScroll:true});
}

function renderProfile() {
  const u = me();
  return `<div class="settings">
    <div class="section">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
        ${avatarHtml(u.id, 56)}
        <div style="display:flex;gap:8px">
          <input type="file" id="avIn" accept="image/*" style="display:none" ${UIAction.on('change', 'setAvatar', UIAction.element)}>
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
        <div class="modal-actions" style="justify-content:flex-start;margin-top:4px"><button class="btn primary" type="submit">Change password</button></div>
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
  if(removed<=20&&!UIMotion.reduced())existing.forEach((el,key)=>{const rect=rows.get(key);if(wanted.has(key)||!rect?.height||viewport&&(rect.bottom<viewport.top||rect.top>viewport.bottom))return;const ghost=el.cloneNode(true);[ghost,...ghost.querySelectorAll('*')].forEach(node=>[...node.attributes].forEach(attr=>{if(attr.name==='id'||attr.name==='name'||attr.name==='tabindex'||attr.name.startsWith('on')||attr.name.startsWith('data-')||attr.name.startsWith('aria-'))node.removeAttribute(attr.name);}));Object.assign(ghost.style,{position:'absolute',top:rect.top-timelineRect.top+'px',left:rect.left-timelineRect.left+'px',width:rect.width+'px',height:rect.height+'px',margin:'0'});exiting.append(ghost);});
  timeline.style.position='relative';
  // Move only rows whose place changed. replaceChildren would detach every row, and browsers cancel a click whose pressed element left the document, even briefly.
  let cursor=timeline.firstChild;for(const child of children){if(child===cursor)cursor=cursor.nextSibling;else timeline.insertBefore(child,cursor);}while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
  if(children.length<=100)changed.forEach(el=>UIMotion.fade(el));if(exiting.children.length){timeline.append(exiting);const animation=UIMotion.animate(exiting,[{opacity:1},{opacity:0}],140);if(animation)animation.finished.then(()=>exiting.remove(),()=>exiting.remove());else exiting.remove();}
  if(active?.isConnected&&timeline.contains(active))active.focus({preventScroll:true});
  else if(focusedKey&&focusedControl){const row=[...timeline.querySelectorAll('[data-feed-key]')].find(el=>el.dataset.feedKey===focusedKey);const target=focusedControl.replyRoot?[...row?.querySelectorAll('[data-reply-root]')||[]].find(el=>el.dataset.replyRoot===focusedControl.replyRoot):focusedControl.comment?[...row?.querySelectorAll('[data-comment] button')||[]].find(el=>el.closest('[data-comment]')?.dataset.comment===focusedControl.comment&&el.getAttribute('aria-label')===focusedControl.action):[...row?.querySelectorAll('button')||[]].find(el=>el.className===focusedControl.className);target?.focus({preventScroll:true});}
  UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-feed-key]','data-feed-key',rows);
}

// A title or description that is not saved yet stays as typed, with Save.
const taskDraft = (t, field) => window.OneloopRuntime?.taskDraft?.(t.internalId, field) || null;
function taskDraftNote(t, field) {
  if (!taskDraft(t, field)?.unsaved) return '';
  if (!canBoard()) return `<p class="save-feedback" data-draft-note="${UIEscape(field)}" role="alert">Not saved. You no longer have permission to edit this task.</p>`;
  return `<p class="save-feedback" data-draft-note="${UIEscape(field)}" role="status">Not saved <button type="button" class="btn quiet" ${UIAction('saveTaskDraft', t.id, field)}>Save</button></p>`;
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
  const atts = window.Uploads?.renderAttachments(t,canEdit) || '';

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
      <div class="tp-sec task-attachments">${window.Uploads?.attachmentHeader(t,canEdit) || '<h2>Attachments</h2>'}
        ${canEdit ? `<input type="file" id="attIn" multiple style="display:none" ${UIAction.on('change', 'attachFiles', t.id, UIAction.element)}>` : ''}
        ${atts}<div class="upload-list"></div></div>
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
    toggle: (v) => { clearTaskSaved();if (!App.require('manage_board') || window.Recovery&&!Recovery.ensureOnline()) return; const t = taskById(taskId); if(!t){App.toast('This task is no longer available','error');return;} if(!(t.assignees||[]).includes(v)&&!projectMembers().some(u=>u.id===v)){App.toast('This person is no longer a project member','error');return;} invoke('task.assignees',{taskId:t.internalId,assigneeIds:t.assignees.includes(v)?t.assignees.filter(id=>id!==v):[...t.assignees,v]}); },
    summary: () => { const a = taskById(taskId)?.assignees || []; return a.length ? a.map((x) => (userById(x) || { name: x }).name).join(', ') : 'Unassigned'; },
    onClose: () => render(),
  });
}

// ---------- settings ----------
/** @type {{projectId:string|null,query:string,limit:number}} */
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
  const memberIds = new Set((p.members || []).map((/** @type {any} */ raw) => typeof raw === 'string' ? raw : raw.userId));
  const candidates = D.users.filter((u) => u.active && !memberIds.has(u.id));
  const query=memberWindow.query.toLowerCase();
  const matching=members.filter((/** @type {{user:any}} */ {user})=>!query||`${user.name} ${userHandle(user)}`.toLowerCase().includes(query));
  return `<div class="settings settings-wide">
    <div class="section">
      <h2>Project</h2>
      <div class="project-fields">
        <div class="field-row">
          ${field('Name', `<input class="ctl" name="name" value="${esc(p.name)}" maxlength="60" data-autosave ${UIAction.on('blur', 'updateProjectField', UIAction.element)} data-key="Enter" ${UIAction.on('keydown', 'leaveProjectField', UIAction.event, UIAction.element)}>`)}
          <div style="max-width:110px">${field('Task prefix', `<input class="ctl mono" name="key" value="${esc(p.key)}" maxlength="4" data-autosave ${UIAction.on('blur', 'updateProjectField', UIAction.element)} data-key="Enter" ${UIAction.on('keydown', 'leaveProjectField', UIAction.event, UIAction.element)}>`)}</div>
        </div>
      </div>
    </div>
    <div class="section">
      <h2>Project access <span class="mono" style="font-size:var(--text-sm);color:var(--ink-ghost)">${members.length}</span></h2>
      <input id="member-search" class="ctl" type="search" aria-label="Search project members" placeholder="Search members" value="${esc(memberWindow.query)}" data-member-search>
      <div class="member-access-list" aria-busy="${UIEscape(!!D.adminUsers?.loading)}">
        ${matching.slice(0,memberWindow.limit).map(({ user: u, record: m }) => `
          <div class="member-access-row ${u.active ? '' : 'off'}">
            <div class="member-person">${avatarHtml(u.id, 24)}<span><b data-tip="${esc(u.name)}" data-tip-overflow>${esc(u.name)}</b><small class="mono">${esc(userHandle(u))}</small></span>${u.active ? '' : '<span class="tag-off">deactivated</span>'}</div>
            <div class="member-grants">
              ${u.admin ? '<span class="admin-access">Full access</span>' : `
                <label class="permission-check"><input type="checkbox" data-autosave aria-label="${esc(u.name)}: manage Roadmap" ${(m.permissions || []).includes('manage_roadmap') ? 'checked' : ''} ${UIAction.on('change', 'setMemberPermission', u.id, 'manage_roadmap', UIAction.checked, UIAction.element)}><span><b>Roadmap</b></span></label>
                <label class="permission-check"><input type="checkbox" data-autosave aria-label="${esc(u.name)}: manage Board" ${(m.permissions || []).includes('manage_board') ? 'checked' : ''} ${UIAction.on('change', 'setMemberPermission', u.id, 'manage_board', UIAction.checked, UIAction.element)}><span><b>Board</b></span></label>`}
            </div>
            <button class="row-x icon-button" type="button" title="Remove from project" aria-label="Remove ${esc(u.name)} from project" ${UIAction('removeMember', u.id)}>${I.close}</button>
          </div>`).join('') || `<div class="empty-note" style="border:0;text-align:left;padding:4px 0">${query?'No matching members':'No members yet'}</div>`}
      </div>
      ${matching.length>memberWindow.limit?'<button type="button" class="btn quiet" data-more-members>Load more members</button>':''}
      <div style="margin-top:12px;width:260px">${D.adminUsers?.loading&&!D.adminUsers?.loaded ? '<span class="access-note" role="status">Loading users…</span>' : candidates.length
        ? selectHtml('addMember', { label:'Add member', value: '', placeholder: 'Add member…', search: true, options: candidates.map((u) => ({ v: u.id, l: `${u.name} · ${userHandle(u)}` })), pick: (v) => App.addMember(v) })
        : D.adminUsers?.nextCursor ? '' : '<div class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">No users to add</div>'}</div>
      ${D.adminUsers?.nextCursor ? `<button type="button" class="btn quiet" data-more-users ${UIAction('loadMoreUsers')} ${D.adminUsers.loading?'disabled':''}>Load more users</button>` : ''}
      ${D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" ${UIAction('retryUsers')}>Retry</button></p>` : ''}
    </div>
    ${window.OneloopKnowledge?.settingsHtml(p.id) || ''}
    <div class="section" style="border-color:color-mix(in srgb,var(--err) 25%,transparent)">
      <h2 style="color:var(--err)">Danger zone</h2>
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
          <span class="uname">${esc(u.name)}</span><span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${esc(userHandle(u))}</span>
          ${u.active ? '' : '<span class="tag-off">deactivated</span>'}
          ${u.mustChange ? '<span class="tag-off" style="color:var(--warn);border-color:color-mix(in srgb,var(--warn) 30%,transparent)">temporary password</span>' : ''}</button>`).join('')}${!awaiting && hasMore ? `<button class="btn quiet" ${UIAction('loadMoreUsers')}>Load more users</button>` : ''}
    </div>
  </div>`;
}
function poolRowHtml(p) {
  const writable=p.scope==='mine'?p.ownerId===me()?.id:canBoard();
  return `<div class="pool-row${canBoard()?' promotable':''}" data-pool-item="${UIEscape(p.id)}"><div class="pool-item-main"><div class="pool-item-copy">${canBoard()?`<button type="button" class="txt pool-promote" aria-label="Create task from ${esc(p.title)}" data-tip="${esc(p.title)}" data-tip-overflow ${UIAction('promotePool',p.id)}>${esc(p.title)}</button>`:`<span class="txt">${esc(p.title)}</span>`}${p.desc?`<span class="pool-description-preview">${esc(p.desc)}</span>`:''}</div><span class="act">${writable||p.desc?`<button type="button" class="btn icon pool-note-toggle" aria-label="${writable?p.desc?'Edit description':'Add description':'View description'} for ${esc(p.title)}" title="${writable?p.desc?'Edit description':'Add description':'View description'}" aria-expanded="false" ${UIAction('editPoolDescription',UIAction.event,p.id)}>${I.note}</button>`:''}${canBoard()?`<button type="button" class="btn icon pool-promote-action" aria-label="Create task from ${esc(p.title)}" title="Create task" ${UIAction('promotePool',p.id)}>${I.arrow}</button>`:''}${writable?`<button type="button" class="btn icon pool-delete" aria-label="Delete ${esc(p.title)}" title="Delete item" ${UIAction('delPool',UIAction.event,p.id)}>${I.close}</button>`:''}</span></div></div>`;
}
function resetPoolCapture(){const capture=document.querySelector('.pool-capture');if(!capture)return;capture.classList.remove('is-expanded');const notes=capture.querySelector('#poolNewDesc');notes.value='';const content=capture.querySelector('.pool-capture-notes');content.inert=true;content.setAttribute('aria-hidden','true');const toggle=capture.querySelector('.pool-capture-toggle');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Add description');toggle.title='Add description';setHTML(toggle,I.note);}

function poolReadNotice(empty=false) {
  const page=D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`];
  if(page?.error)return `<div class="pool-read-status access-note" role="alert">Could not ${page.loaded?'refresh':'load'} items. <button class="btn quiet" ${UIAction('retryPool')}>Retry</button></div>`;
  if(!empty)return '';
  const pending=page?.loaded===false;
  return `<div class="empty-note"${pending?' role="status"':''}>${pending?'Loading items…':'No items'}</div>`;
}
function poolLoadMoreHtml() {
  return D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`]?.nextCursor?`<button class="btn quiet pool-load-more" ${UIAction('loadMorePool')}>Load more</button>`:'';
}
function updatePool({ completeItemId } = {}) {
  App.updateDocumentTitle();
  const view = document.querySelector('.pool-view');
  if (!view) return;
  const list = view.querySelector('.pool-list');
  const listScroll = list.scrollTop;
  const tabChanged = list.dataset.poolScope && list.dataset.poolScope !== state.poolTab;
  const beforeRows = new Map([...list.querySelectorAll('[data-pool-item]')].map(el => [el.dataset.poolItem, el.getBoundingClientRect()]));
  const items = poolItems(state.poolTab);
  const ids = new Set(items.map((item) => item.id));
  list.querySelectorAll('[data-pool-item]').forEach((row) => { if (!ids.has(row.dataset.poolItem)) { if (!tabChanged) exitVisual(row); row.remove(); } });
  list.querySelector('.empty-note')?.remove();
  list.querySelector('.pool-read-status')?.remove();
  let cursor = list.firstElementChild;
  items.forEach((item) => {
    let row = list.querySelector(`[data-pool-item="${UIEscape(item.id)}"]`);
    if (row) {
      const editor=row.querySelector('.pool-description-editor');
      const editedHere = !!editor?.contains(document.activeElement);
      const template = document.createElement('template'); setHTML(template,poolRowHtml(item));
      const fresh = template.content.firstElementChild;
      const actions=element=>[...element.querySelectorAll('.act > button')].map(button=>button.className).join('|');
      const sameActions=row.className===fresh.className&&actions(row)===actions(fresh);
      row.className=fresh.className;
      if(sameActions)patchBoardRow(row.querySelector('.pool-item-main'),fresh.querySelector('.pool-item-main'));
      else row.querySelector('.pool-item-main')?.replaceWith(fresh.querySelector('.pool-item-main'));
      if(item.id===completeItemId){editor?.remove();if(editedHere)row.querySelector('.pool-note-toggle')?.focus({preventScroll:true});}
      else if(editor){
        row.querySelector('.pool-note-toggle')?.setAttribute('aria-expanded','true');
        const reader=editor.querySelector('.pool-note-read');if(reader){reader.textContent=item.desc||'';reader.setAttribute('aria-label',`Description for ${item.title}`);}
      }
    }
    if (!row) { const template = document.createElement('template'); setHTML(template,poolRowHtml(item)); row = template.content.firstElementChild; }
    if (row !== cursor) list.insertBefore(row, cursor);
    cursor = row.nextElementSibling;
  });
  if (!items.length) setHTML(list,poolReadNotice(true));
  else if(D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`]?.error){const note=document.createElement('template');setHTML(note,poolReadNotice());list.append(note.content);}
  list.querySelector('.pool-load-more')?.remove();
  const more=document.createElement('template');setHTML(more,poolLoadMoreHtml());list.append(more.content);
  view.querySelectorAll('[data-pool-tab]').forEach((button) => {
    const selected = button.dataset.poolTab === state.poolTab;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('span').textContent = D.poolPageInfo?.[`${state.projectId}:${button.dataset.poolTab}`]?.total ?? poolItems(button.dataset.poolTab).length;
  });
  const input = view.querySelector('#poolAdd');
  input.hidden = state.poolTab === 'project' && !canBoard();
  view.querySelector('.pool-capture').hidden=input.hidden;
  if(tabChanged){input.value='';resetPoolCapture();view.querySelectorAll('.pool-description-editor').forEach(el=>el.remove());view.querySelectorAll('.pool-note-toggle').forEach(el=>el.setAttribute('aria-expanded','false'));}
  const mineTotal=D.poolPageInfo?.[`${state.projectId}:mine`]?.total,teamTotal=D.poolPageInfo?.[`${state.projectId}:project`]?.total;
  document.querySelectorAll('[data-pool-count]').forEach((el) => { el.textContent = Number.isFinite(mineTotal)&&Number.isFinite(teamTotal)?mineTotal+teamTotal:poolItems().length; });
  list.dataset.poolScope = state.poolTab;
  if (!tabChanged) list.scrollTop = listScroll;
  if (tabChanged) fadeContent(list);
  else list.querySelectorAll('[data-pool-item]').forEach(row => {
    const from = beforeRows.get(row.dataset.poolItem), to = row.getBoundingClientRect();
    if (!from) uiAnimate(row, [{ opacity:0,transform:'translateY(4px)' },{ opacity:1,transform:'none' }]);
    else if (Math.abs(from.top - to.top) > 1) uiAnimate(row, [{transform:`translateY(${from.top - to.top}px)`},{transform:'none'}]);
  });
}

function renderModal() {
  const m = state.modal;
  if (!m) return '';
  let body = '';
  if (['block','unblock','completeBlocked'].includes(m.type)) {
    const task=taskById(m.id),blocking=m.type==='block',complete=m.type==='completeBlocked';
    if(!task)return '';
    body=`<h2>${blocking ? task.block ? 'Edit block reason' : 'Block task' : complete ? 'Unblock and complete task?' : 'Unblock task'}</h2>
      ${!blocking ? `<p class="sub">${esc(task.block?.reason || '')}</p>` : ''}
      <form novalidate data-block-action ${UIAction.on('submit', 'saveBlock', UIAction.event, task.id, m.type)}>
        ${field(blocking?'Reason':'Resolution',blocking ? Collab.blockReasonHtml(task) : `<textarea class="ctl" name="reason" maxlength="500" placeholder="How was this resolved?" ${UIAction.on('keydown', 'commentKey', UIAction.event)}></textarea>`,!blocking)}
        <div class="modal-actions"><button type="button" class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary">${blocking?'Save':complete?'Unblock and complete':'Unblock'}</button></div>
      </form>`;
  } else if (m.type === 'epic') {
    const e = m.id ? epicById(m.id) : null;
    body = `<h2>${e ? 'Edit epic' : 'New epic'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveEpic', UIAction.event, m.id || '')}>
      ${field('Title', `<input class="ctl" name="title" placeholder="Payment integration" value="${esc(e ? e.title : '')}" maxlength="120" required autofocus>`)}
      ${field('Track', selectHtml('mTrack', { name: 'trackId', value: e ? e.trackId : (m.trackId || ''), placeholder: 'Choose a track', options: tracks().map((t) => ({ v: t.id, l: t.name })) }))}
      <div class="field-row">
        ${field('Start', dateHtml('mStart', { name: 'start', value: e ? e.start : iso(today), max: () => dateValue('mEnd'), maxError: 'Start date cannot be after the end date.' }))}
        ${field('End', dateHtml('mEnd', { name: 'end', value: (e && e.end) || '', clearable: true, min: () => dateValue('mStart'), minError: 'End date cannot be before the start date.', placeholder: 'No end date' }), true)}
      </div>
      ${field('Description', descriptionEditorHtml(e?.desc,2000), true)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${e ? 'Save' : 'Create epic'}</button></div>
    </form>`;
  } else if (m.type === 'milestone') {
    const ms = m.id ? D.milestones.find((x) => x.id === m.id) : null;
    body = `<h2>${ms ? 'Edit milestone' : 'New milestone'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveMilestone', UIAction.event, m.id || '')}>
      ${field('Name', `<input class="ctl" name="name" placeholder="Public launch" value="${esc(ms ? ms.name : '')}" maxlength="60" required autofocus>`)}
      ${field('Date', dateHtml('mDate', { name: 'date', value: ms ? ms.date : iso(today) }))}
      ${field('Goal', descriptionEditorHtml(ms?.desc,500), true)}
      <div class="modal-actions">${ms ? `<button class="btn danger" type="button" style="margin-right:auto" ${UIAction('deleteMilestone', ms.id)}>Delete</button>` : ''}<button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${ms ? 'Save' : 'Create milestone'}</button></div>
    </form>`;
  } else if (m.type === 'track') {
    const t = m.id ? trackById(m.id) : null;
    body = `<h2>${t ? 'Rename track' : 'New track'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveTrack', UIAction.event, m.id || '')}>
      ${field('Name', `<input class="ctl" name="name" placeholder="Backend & API" value="${esc(t ? t.name : '')}" maxlength="60" required autofocus>`)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${t ? 'Save' : 'Create track'}</button></div>
    </form>`;
  } else if (m.type === 'task') {
    body = taskModalHtml(m);
  } else if (m.type === 'project') {
    body = `<h2>New project</h2>
    <form novalidate ${UIAction.on('submit', 'saveProjectNew', UIAction.event)}>
      ${field('Name', `<input class="ctl" name="name" maxlength="60" required autofocus>`)}
      ${field('Task prefix', `<input class="ctl mono" name="key" placeholder="APP" maxlength="4">`)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">Create project</button></div>
    </form>`;
  } else if (m.type === 'user') {
    const u = m.id ? userById(m.id) : null;
    const lastAdmin = u && u.admin && u.active && activeAdmins().length === 1;
    body = `<h2>${u ? 'Edit user' : 'New user'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveUser', UIAction.event, m.id || '')}>
      ${field('Username', `<input class="ctl mono" name="username" value="${esc(u ? userHandle(u) : '')}" ${u ? 'disabled' : 'autofocus'} maxlength="32">`)}
      ${field('Full name', `<input class="ctl" name="name" value="${esc(u ? u.name : '')}" maxlength="80" ${u ? 'autofocus' : ''}>`)}
      <label class="check" style="margin-bottom:5px"><input type="checkbox" name="admin" ${u && u.admin ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}> Admin${lastAdmin ? ' <span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">· last active admin</span>' : ''}</label>
      ${u ? `<label class="check" style="margin-bottom:14px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}> Active</label>` : ''}
      <div class="modal-actions">
        ${u ? `<button class="btn" type="button" style="margin-right:auto" ${UIAction('resetPassword', u.id)}>Reset password</button>` : ''}
        <button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button>
        <button class="btn primary" type="submit">${u ? 'Save' : 'Create user'}</button>
      </div>
    </form>`;
  } else if (m.type === 'temppw') {
    const user=userById(m.id),account=user?.username||user?.name||'Account';
    body = `<h2>Temporary password</h2>
    <div class="temporary-password-meta"><strong>${esc(account)}</strong><span>Shown once</span></div>
    <div class="pw-box"><span class="mono" id="tmpPw">${esc(m.pw)}</span><button class="btn" type="button" aria-label="Copy temporary password" ${UIAction('copyTemporaryPassword')}>Copy</button></div>
    <div class="modal-actions"><button class="btn primary" ${UIAction('closeOverlays')}>Done</button></div>`;
  } else if (m.type === 'pool') {
    const mine = poolItems('mine'), proj = poolItems('project');
    const pl = state.poolTab === 'mine' ? mine : proj;
    const canWritePool = state.poolTab === 'mine' || canBoard();
    const rows = pl.length?pl.map(poolRowHtml).join('')+poolReadNotice():poolReadNotice(true);
    body = `<div class="pool-view"><div class="pool-head"><h2>Pool</h2>
      <div class="seg" style="margin-left:auto">
        <button type="button" class="${state.poolTab === 'mine' ? 'on' : ''}" data-pool-tab="mine" aria-pressed="${state.poolTab === 'mine'}" ${UIAction('setPoolTab', 'mine')}>My <span class="mono" style="font-size:var(--text-xs);opacity:.7">${D.poolPageInfo?.[`${state.projectId}:mine`]?.total ?? mine.length}</span></button>
        <button type="button" class="${state.poolTab === 'project' ? 'on' : ''}" data-pool-tab="project" aria-pressed="${state.poolTab === 'project'}" ${UIAction('setPoolTab', 'project')}>Team <span class="mono" style="font-size:var(--text-xs);opacity:.7">${D.poolPageInfo?.[`${state.projectId}:project`]?.total ?? proj.length}</span></button>
      </div>
      <button type="button" class="btn icon" aria-label="Close pool" title="Close pool" ${UIAction('closeOverlays')}>${I.close}</button>
    </div>
    <div class="pool-capture" ${canWritePool?'':'hidden'}><div class="pool-capture-title"><input id="poolAdd" class="ctl" placeholder="Add an item" aria-label="Add pool item" maxlength="140" ${canWritePool?'':'hidden'} ${UIAction.on('keydown', 'poolKey', UIAction.event)}><button type="button" class="btn icon pool-capture-toggle" aria-label="Add description" title="Add description" aria-expanded="false" aria-controls="pool-capture-notes" ${UIAction('togglePoolDescription')}>${I.note}</button></div><div class="pool-capture-notes" id="pool-capture-notes" aria-hidden="true" inert><div><label for="poolNewDesc">Description ${optionalMark}</label><textarea id="poolNewDesc" class="ctl" maxlength="2000" placeholder="A little context for later…" ${UIAction.on('keydown', 'poolDescriptionKey', UIAction.event)}></textarea><div class="pool-description-actions"><button type="button" class="btn primary" ${UIAction('addPoolItem')}>Add item</button></div></div></div></div>
    <div class="pool-list" data-pool-scope="${UIEscape(state.poolTab)}">${rows}${poolLoadMoreHtml()}</div></div>`;
  } else if (m.type === 'knowledge') {
    body = window.OneloopKnowledge?.modalHtml() || '';
  } else if (m.type === 'confirm') {
    body = `<h2>${esc(m.title)}</h2><div class="sub">${esc(m.text)}</div>
    <div class="modal-actions"><button class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button></div>`;
  }
  body = body.replace('<h2', '<h2 id="modal-title"');
  // The dialog's wrapper covers the backdrop, so a click beside the dialog does nothing.
  return `<div class="scrim"></div><div class="modal-wrap"><div class="modal${m.type === 'pool' ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">${body}</div></div>`;
}

/** The Board's page header: search, filters, Pool and New task. */
function boardTopbarHtml() {
  const applyBoard = applyBoardFilters;
  const epicOpts = (state.boardTracks.length ? epics().filter((e) => state.boardTracks.includes(e.trackId)) : epics()).slice().sort((a, b) => d(a.start) - d(b.start));
  const updateEpicFilter = () => {
    const choices = (state.boardTracks.length ? epics().filter(epic => state.boardTracks.includes(epic.trackId)) : epics()).slice().sort((a,b)=>d(a.start)-d(b.start));
    const allowed = new Set(choices.map(epic=>epic.id));
    state.boardEpics.splice(0,state.boardEpics.length,...state.boardEpics.filter(id=>allowed.has(id)));
    const def = MULTI.fEpic;
    if(def) { def.options=choices.map(epic=>({v:epic.id,l:epic.title})); const button=document.querySelector('[data-filter-key="fEpic"]');if(button){button.querySelector('.sel-label').textContent=def.summary();button.dataset.tip=def.summary();button.classList.toggle('empty',!state.boardEpics.length);} }
  };
  const mk = (key, arr, all, noun, options, extra) => multiHtml(key, Object.assign({
    options, search: options.length > 6,
    values: () => arr,
    toggle: (v) => { const i = arr.indexOf(v); if (i === -1) arr.push(v); else arr.splice(i, 1); if(key==='fTrack')updateEpicFilter(); applyBoard(); },
    clear: () => { arr.length = 0; if(key==='fTrack')updateEpicFilter(); applyBoard(); },
    summary: () => arr.length === 0 ? all : arr.length === 1 ? ((MULTI[key]?.options || options).find((o) => o.v === arr[0]) || {}).l || all : `${arr.length} ${noun}`,
  }, extra || {}));
  const meId = me().id;
  const assigneeOpts = [{ v: meId, l: me().name, sub: 'My tasks', pinned: true }, { v: NO_ASSIGNEE, l: 'No assignee', pinned: true }, ...projectMembers().filter((u) => u.id !== meId).map((u) => ({ v: u.id, l: u.name, sub: userHandle(u) }))];
  return `<h1>Board</h1>
  <div class="right board-filters">
    <input class="ctl" data-board-search style="width:170px" aria-label="Search tasks" placeholder="Search tasks" value="${esc(state.boardQ)}" ${UIAction.on('input', 'setBoardQ', UIAction.value, UIAction.event)} ${UIAction.on('keydown', 'boardSearchKey', UIAction.event)}>
    ${mk('fTrack', state.boardTracks, 'All tracks', 'tracks', tracks().map((t) => ({ v: t.id, l: t.name })), { width: 140 })}
    ${mk('fEpic', state.boardEpics, 'All epics', 'epics', epicOpts.map((e) => ({ v: e.id, l: e.title })), { search: true, width: 180 })}
    ${mk('fAssignee', state.boardAssignees, 'All assignees', 'assignees', assigneeOpts, { search: true, width: 150 })}
    <button class="btn blocked-filter" aria-pressed="${state.boardBlocked}" ${UIAction('setBlockedFilter', UIAction.element)}>${I.blocked}Blocked<span class="blocked-filter-count" title="Blocked tasks in this project">${D.projectTaskCounts?.[state.projectId]?.blocked ?? tasks().filter(t=>t.block && t.state!=='done').length}</span></button>
    <button class="btn quiet" ${UIAction('openModal', 'pool')}>Pool <span class="mono" data-pool-count style="font-size:var(--text-xs);color:var(--ink-ghost)">${Number.isFinite(D.poolPageInfo?.[`${state.projectId}:mine`]?.total)&&Number.isFinite(D.poolPageInfo?.[`${state.projectId}:project`]?.total)?D.poolPageInfo[`${state.projectId}:mine`].total+D.poolPageInfo[`${state.projectId}:project`].total:poolItems().length}</span></button>
    ${canBoard() ? `<button class="btn primary" ${UIAction('openModal', 'task')}>${I.plus} Task</button>` : '<span class="read-only-pill">read only</span>'}
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
    <h1 style="display:flex;align-items:center;gap:8px"><span class="mono">${esc(t.id)}</span></h1>
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
    if(field&&t)window.OneloopRuntime?.keepTaskDraft?.(t.id,field,active.value);
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
  const oldModalElement=/** @type {HTMLElement|null} */(root.querySelector('.modal')),oldPeekElement=/** @type {HTMLElement|null} */(root.querySelector('.peek')),oldFocus=document.activeElement;
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
  window.Uploads?.validateAccess();
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
  const view = state.view==='no-projects' ? `<div class="page-empty"><h2>No projects available</h2><p>${isAdmin()?'Create the first project to start planning work.':'Ask an admin to add you to a project.'}</p>${isAdmin()?`<button class="btn primary" ${UIAction('openModal', 'project')}>Create project</button>`:''}</div>` : error ? window.Recovery?.errorHtml(error) || `<div class="page-error"><h2>${error === '403' ? 'Access denied' : 'Page not found'}</h2><button class="btn quiet" ${UIAction('nav', 'board')}>Back to Board</button></div>` : awaitingServerTask() ? '<div class="pending-task-route" role="status" aria-label="Loading task"></div>' : state.view === 'knowledge' ? window.OneloopKnowledge?.render(state.projectId) || '' : state.view === 'roadmap' ? renderRoadmap() : state.view === 'board' ? renderBoard() : state.view === 'task' ? renderTask() : state.view === 'profile' ? renderProfile() : state.view === 'users' ? renderUsers() : state.view === 'inbox' ? collaboration?.inboxHtml() || '' : state.view === 'storage' ? `<div class="workspace-page storage-page">${window.Uploads?.storageHtml() || ''}</div>` : renderSettings();
  const appRoot = document.getElementById('app'), shell = document.createElement('template');
  setHTML(shell,`
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="side-scrim" ${UIAction('toggleSidebar', false)}></div>
    <nav class="sidebar" aria-label="Main navigation" ${window.innerWidth <= 900 && !state.sideOpen ? 'inert' : ''}>
      <div class="sidebar-brand has-inbox"><div class="logo" role="img" aria-label="oneloop">${I.logo}<span class="lbl">${I.wordmark}</span></div>${collaboration?.inboxNav(state.view) || ''}</div>
      <div class="switcher"><button class="switcher-btn btn" style="border-color:rgb(var(--tone-rgb) / 0.06)" ${!project()&&!isAdmin()?'disabled':''} ${UIAction('projectMenu', UIAction.event)} title="${esc(p.name)}" aria-label="Project: ${esc(p.name)}" aria-expanded="${!!state.menu?.projectMenu}" aria-controls="project-switcher-menu">
        <span class="project-identity"><span class="avatar">${esc(p.name[0].toUpperCase())}</span><span class="lbl project-name">${esc(p.name)}</span></span><span class="lbl project-chevron">${I.chev}</span></button></div>
      <div class="nav">
        <button class="nav-item ${state.view === 'roadmap' ? 'on' : ''}" ${state.view === 'roadmap' ? 'aria-current="page"' : ''} ${UIAction('nav', 'roadmap')} title="Roadmap">${I.roadmap}<span class="lbl">Roadmap</span></button>
        <button class="nav-item ${state.view === 'board' || state.view === 'task' ? 'on' : ''}" ${state.view === 'board' || state.view === 'task' ? 'aria-current="page"' : ''} ${UIAction('nav', 'board')} title="Board">${I.board}<span class="lbl">Board</span><span class="end lbl mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${c.open}</span></button>
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
    <div id="overlay-root" style="display:contents">${state.peek ? renderPeek() : ''}${renderModal()}${renderMenu()}</div>
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
  if (state.view === 'task') window.Uploads?.mount(state.taskId);
  if (state.view === 'roadmap' && !error) mountRoadmap();
  window.OneloopKnowledge?.mount();
  finishRenderMotion(renderMotion);
  stampOverlays();
  if (state.menu) placeMenu();
  collaboration?.mount();
  syncOverlayFocus({ oldModal, oldPeek, oldFocus, oldModalKey, oldPeekKey, oldPanelFocus });
}
function settleCard(card, from) {
  if (!card || !from || reducedMotion.matches) return;
  const to = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.removeAttribute('data-task');
  ghost.removeAttribute('data-reorderable');
  ghost.classList.remove('dragging');
  ghost.classList.add('drag-settle');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px`;
  document.body.appendChild(ghost);
  card.classList.add('settling');
  const animation = ghost.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(1.025)`, opacity: 0.9 },
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
  ], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  const cleanup = () => { ghost.remove(); card.classList.remove('settling'); };
  animation.finished.then(cleanup, cleanup);
}

// ---------- actions ----------
Object.assign(App, {
  /** Production compatibility boundary. New modules must not reach private state directly. */
  context() { return { view:state.view, taskId:state.taskId, projectId:state.projectId, poolTab:state.poolTab, peek:state.peek, board:{trackIds:[...state.boardTracks],epicIds:[...state.boardEpics],assigneeIds:[...state.boardAssignees],search:state.boardQ,blocked:state.boardBlocked}, modal:state.modal ? { ...state.modal } : null }; },
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
  refreshPool: updatePool,
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
  followAddress,
  selectProject(id) { if(!visibleProjects().some(project=>project.id===id))return;const leaveTask=state.view==='task'&&state.projectId!==id;state.projectId=id;state.rmScrollLeft=null;state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;if(leaveTask){state.view='board';state.taskId=null;setLocalHash('#/board');}if(state.view==='knowledge'){window.OneloopKnowledge?.route('knowledge',id);setLocalHash('#/knowledge');}render(); },
  // A drop animates its own card; it passes { animate: false } so the refresh does not move it again.
  refreshBoard(options) { applyBoardFilters(false,true,options); App.refreshCounts(); },
  acceptMoreBoard(col) {
    state.boardLimits[col]=(state.boardLimits[col]||50)+50;
    const board=document.querySelector('.board'),column=board?.querySelector(`[data-col="${UIEscape(col)}"]`),list=column?.querySelector('.col-cards');
    if(!list||state.view!=='board')return;
    const ids=new Set([...list.querySelectorAll(/** @type {'div'} */('[data-task]'))].map(card=>card.dataset.task));
    const template=document.createElement('template');setHTML(template,renderBoard({column:col,excludeIds:ids}));
    const next=template.content.querySelector('.col-cards'),more=list.querySelector('.board-load-more');
    for(const card of next.querySelectorAll('.card')){list.insertBefore(card,more);UIMotion.enter(card);}
    if(list.querySelector('.card'))list.querySelector('.empty-note')?.remove();
    const nextMore=next.querySelector('.board-load-more');
    if(!nextMore){const focused=more?.contains(document.activeElement);more?.remove();if(focused)list.querySelector(/** @type {'button'} */('.card:last-of-type .title'))?.focus({preventScroll:true});}
    else if(!more)list.append(nextMore);
    column.querySelector('.col-head .mono').textContent=template.content.querySelector('.col-head .mono').textContent;
    boardSnapshots.set(board,boardSnapshot());
  },
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
  setBlockedFilter(button){state.boardBlocked=!state.boardBlocked;button?.setAttribute('aria-pressed',String(state.boardBlocked));applyBoardFilters();},
  closeOverlays() { if (state.menu&&!state.modal&&!state.peek){dismissMenu();return;}if (state.modal?.poolId) { App.returnToPool(); return; } state.peek = state.peek && state.modal ? state.peek : null; state.modal = null; state.menu = null; if (dialogPaintOwed) render(); else renderOverlays(); },

  // menus
  projectMenu(ev) {
    const r = ev.currentTarget.getBoundingClientRect();
    const items = visibleProjects().map((p) => ({ label: p.name, projectId:p.id, projectName:p.name, fn: () => invoke('workspace.select',{projectId:p.id}) }));
    if (isAdmin()) items.push({ sep: true }, { label: 'New project', icon:I.plus, fn: () => { state.modal = { type: 'project' }; renderOverlays(); } });
    App._openMenu(items, r.left, r.bottom + 6, { projectMenu: true, trigger:ev.currentTarget });
  },

  /** Enter saves a project field, then leaves it. */
  leaveProjectField(event, input) { event.preventDefault(); App.updateProjectField(input); input.blur(); },
  taskDragStart(ev, id) {
    clearFilterMotion();
    if (!App.require('manage_board')) { ev.preventDefault(); return; }
    if (App._boardMovePending) { ev.preventDefault(); return; }
    App.dragEnd(false);
    ev.dataTransfer.setData('text/task', id);
    ev.dataTransfer.effectAllowed = 'move';
    const card = ev.currentTarget;
    const r = card.getBoundingClientRect();
    App._drag = { kind: 'task', id, offsetX: ev.clientX - r.left, offsetY: ev.clientY - r.top };
    App._dragImage(ev, card);
    document.body.classList.add('is-dragging');
    requestAnimationFrame(() => { if (App._drag?.id === id) card.classList.add('dragging'); });
  },
  colOver(ev) {
    if (!canBoard() || App._drag?.kind !== 'task') return;
    if (!ev.dataTransfer.types.includes('text/task')) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
    const colEl = ev.currentTarget;
    const list = colEl.querySelector('.col-cards');
    const ind = App._ind();
    // Don't oscillate when the pointer is inside the insertion gap itself.
    if (ind?.parentNode === list) {
      const r = ind.getBoundingClientRect();
      if (ev.clientY >= r.top - 4 && ev.clientY <= r.bottom + 4) return;
    }
    const cards = [...colEl.querySelectorAll('.card:not(.dragging)')];
    const next = colEl.dataset.col === 'done' && doneNewest() ? cards[0] : cards.find((c) => {
      // Hit-test the final layout, not a sibling's in-flight transform.
      const y = list.getBoundingClientRect().top + c.offsetTop - list.scrollTop;
      return ev.clientY < y + c.offsetHeight / 2;
    });
    const beforeId = next ? next.dataset.task : null;
    if (App._dropColumn === colEl.dataset.col && App._dropBefore === beforeId && ind?.parentNode === list) return;
    const before = motionRects('.card[data-task]');
    document.querySelectorAll('.col.drop').forEach((el) => { if (el !== colEl) el.classList.remove('drop'); });
    colEl.classList.add('drop');
    App._dropColumn = colEl.dataset.col;
    App._dropBefore = beforeId;
    const marker = App._mkInd(false);
    if (next) list.insertBefore(marker, next); else list.appendChild(marker);
    animateLayout(before, '.card[data-task]', App._drag.id);
  },
  colLeave(ev) {
    if (ev.currentTarget.contains(ev.relatedTarget)) return;
    ev.currentTarget.classList.remove('drop');
    if (App._ind()?.parentNode === ev.currentTarget.querySelector('.col-cards')) {
      const before = motionRects('.card[data-task]');
      App._ind().remove(); App._dropColumn = null; App._dropBefore = null;
      animateLayout(before, '.card[data-task]', App._drag?.id);
    }
  },
  dropTask(ev, col) {
    if(window.Recovery?.blockDrag()){ev.preventDefault();App.dragEnd();return;}
    if (!App.require('manage_board')) return;
    if (App._boardMovePending) { ev.preventDefault(); App.dragEnd(); return; }
    if (!ev.dataTransfer.types.includes('text/task') || App._drag?.kind !== 'task') return;
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/task');
    const beforeId = App._dropBefore;
    const t = taskById(id);
    if (!t || id === beforeId) { App.dragEnd(); return; }
    if(t.block && col==='done'){App.dragEnd();App.openModal('completeBlocked',id);return;}
    const before=motionRects('.card[data-task]'),from={left:ev.clientX-App._drag.offsetX,top:ev.clientY-App._drag.offsetY};
    const scrolls=[...document.querySelectorAll('.col-cards')].map((el)=>[el.closest('.col').dataset.col,el.scrollTop]);
    const boardLeft=document.querySelector('.board').scrollLeft,change=applyTaskMove(t,col,beforeId);
    App.dragEnd(false);if(!change)return;
    App.refreshBoard({animate:false});document.querySelector('.board').scrollLeft=boardLeft;
    scrolls.forEach(([key,top])=>{const list=document.querySelector(`[data-col="${UIEscape(key)}"] .col-cards`);if(list)list.scrollTop=top;});
    animateLayout(before,'.card[data-task]',id);settleCard(document.querySelector(`[data-task="${UIEscape(id)}"]`),from);
    submitTaskMove(change,()=>{const rollbackBefore=motionRects('.card[data-task]');App.refreshBoard({animate:false});animateLayout(rollbackBefore,'.card[data-task]');});
  },

  taskActions(ev,id) {
    if(!canBoard()||!taskById(id))return;
    const r=ev.currentTarget.getBoundingClientRect();
    App._openMenu([{label:'Delete task',danger:true,fn:()=>App.deleteTask(id)}],r.right,r.bottom+4,{taskActions:true,trigger:ev.currentTarget});
  },

  togglePoolDescription(){const capture=document.querySelector('.pool-capture');if(!capture||capture.hidden)return;const open=!capture.classList.contains('is-expanded');if(!open){resetPoolCapture();document.getElementById('poolAdd').focus();return;}capture.classList.add('is-expanded');const content=capture.querySelector('.pool-capture-notes');content.inert=false;content.setAttribute('aria-hidden','false');const toggle=capture.querySelector('.pool-capture-toggle');toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Remove description');toggle.title='Remove description';setHTML(toggle,I.close);document.getElementById('poolNewDesc').focus();},
  addPoolItem(){const input=document.getElementById('poolAdd');if(input&&!input.hidden)App.poolKey({key:'Enter',target:input,preventDefault(){}});},
  poolDescriptionKey(ev,id){
    if(ev.defaultPrevented||ev.isComposing||ev.keyCode===229)return;
    if(ev.key==='Enter'&&ev.repeat){ev.preventDefault();return;}
    if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();if(id)App.cancelPoolDescription(id);else {resetPoolCapture();document.getElementById('poolAdd').focus();}return;}
    if(ev.key==='Enter'&&!ev.shiftKey&&!ev.altKey){ev.preventDefault();if(id){const form=ev.currentTarget.closest('form');if(form)App.savePoolDescription({target:form,preventDefault(){}},id);}else App.addPoolItem();}
  },
  editPoolDescription(ev,id){ev.stopPropagation();const item=poolItems(state.poolTab).find(p=>p.id===id),row=ev.currentTarget.closest('[data-pool-item]');if(!item||!row)return;const existing=row.querySelector('.pool-description-editor');if(existing){App.cancelPoolDescription(id);return;}document.querySelectorAll('.pool-description-editor').forEach(el=>App.cancelPoolDescription(el.closest('[data-pool-item]').dataset.poolItem,false));const writable=item.scope==='mine'?item.ownerId===me()?.id:canBoard(),editor=document.createElement('div');editor.className='pool-description-editor';const before=row.getBoundingClientRect().height;setHTML(editor,writable?`<form novalidate ${UIAction.on('submit','savePoolDescription',UIAction.event,id)}><label for="pool-desc-${UIEscape(id)}">Description ${optionalMark}</label><textarea class="ctl" id="pool-desc-${UIEscape(id)}" name="desc" maxlength="2000" ${UIAction.on('keydown','poolDescriptionKey',UIAction.event,id)} placeholder="A little context for later…">${esc(item.desc||'')}</textarea><div class="pool-description-actions"><button type="button" class="btn quiet" ${UIAction('cancelPoolDescription',id)}>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`:`<div class="pool-note-read" tabindex="-1" role="group" aria-label="Description for ${esc(item.title)}">${esc(item.desc||'')}</div>`);row.append(editor);const reader=editor.querySelector('.pool-note-read');if(reader&&reader.scrollHeight>reader.clientHeight)reader.setAttribute('tabindex','0');ev.currentTarget.setAttribute('aria-expanded','true');UIMotion.height(row,before);editor.querySelector('textarea,.pool-note-read')?.focus({preventScroll:true});},
  cancelPoolDescription(id,focus=true){const row=document.querySelector(`[data-pool-item="${UIEscape(id)}"]`);if(!row)return;const before=row.getBoundingClientRect().height;row.querySelector('.pool-description-editor')?.remove();const toggle=row.querySelector('.pool-note-toggle');toggle?.setAttribute('aria-expanded','false');UIMotion.height(row,before);if(focus)toggle?.focus({preventScroll:true});},
  promotePool(id) {
    if (!App.require('manage_board')) return;
    const item = poolItems(state.poolTab).find((x) => x.id === id);
    const view = document.querySelector('.pool-view');
    if (!item || !view) return;
    (App._poolScroll ||= {})[state.poolTab] = view.querySelector('.pool-list').scrollTop;
    document.querySelectorAll('.pool-description-editor').forEach(el=>App.cancelPoolDescription(el.closest('[data-pool-item]').dataset.poolItem,false));resetPoolCapture();document.getElementById('poolAdd').value='';
    state.modal = { type: 'task', poolId: id, title: item.title, desc:item.desc||'' };
    stampOverlays();
    view.hidden = true;
    const editor = document.createElement('div');
    editor.className = 'pool-editor';
    setHTML(editor,taskModalHtml(state.modal));
    view.parentElement.appendChild(editor);
    mountDescription();
    fadeContent(editor);
    editor.querySelector('[name="title"]').focus();
  },
  returnToPool() {
    closePop(true);
    document.querySelector('.pool-editor')?.remove();
    const view = document.querySelector('.pool-view');
    if (!view) return;
    state.modal = { type: 'pool' };
    stampOverlays();
    view.hidden = false;
    updatePool();
    view.querySelector('.pool-list').scrollTop = App._poolScroll?.[state.poolTab] || 0;
    fadeContent(view);
    view.querySelector('#poolAdd')?.focus();
  },
  setPoolTab(k) {
    if (!['mine', 'project'].includes(k) || k === state.poolTab) return;
    const list = document.querySelector('.pool-list');
    (App._poolScroll ||= {})[state.poolTab] = list.scrollTop;
    state.poolTab = k;
    updatePool();
    list.scrollTop = App._poolScroll[k] || 0;
    invoke('pool.select',{scope:k});
  },
  loadMorePool(){invoke('pool.more',{scope:state.poolTab});},

  refresh: render,
  /** Draw the dialog, drawer and menu again, and leave the page as it is. */
  refreshOverlays: renderOverlays,
  refreshBackground,
  refreshAfterDialog,
  isRendering:()=>rendering,
  clearBoardFilters(){cancelBoardSearch();state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;state.boardLimits={planning:50,progress:50,review:50,done:50};invoke('board.filter',App.context().board);},
  retryPool(){invoke('pool.select',{scope:state.poolTab});},
  toggleDoneOrder(){invoke('board.doneOrder',{order:doneNewest()?'manual':'completed'});},
  loadMoreBoard(col){invoke('board.more',{status:col});},
  taskMoveMenu(event,id){
    event.stopPropagation(); // The card around the button would open the task.
    if(App._boardMovePending)return;
    if(!canBoard())return;const task=taskById(id),list=boardTasks().filter(t=>t.state===task.state),index=list.indexOf(task),r=event.currentTarget.getBoundingClientRect();
    const items=COLS.filter(c=>c.key!==task.state).map(c=>({label:'Move to '+c.name,fn:()=>{if(canBoard()){if(setTaskState(task,c.key)!==false){App.refresh();focusMovedTask(id);}}}}));
    const ordered=!(task.state==='done'&&doneNewest());
    if(ordered&&index>0)items.push({label:'Move up',fn:()=>App.moveTaskOrder(id,list[index-1].id,true)});
    if(ordered&&index<list.length-1)items.push({label:'Move down',fn:()=>App.moveTaskOrder(id,list[index+1].id,false)});
    App._openMenu(items,r.left,r.bottom+6,{trigger:event.currentTarget});
  },
  moveTaskOrder(id,anchor,before){if(!canBoard())return;const task=taskById(id),target=taskById(anchor);if(!task||!target||task.state!==target.state)return;const old=motionRects('.card[data-task]');D.tasks.splice(D.tasks.indexOf(task),1);D.tasks.splice(D.tasks.indexOf(target)+(before?0:1),0,task);App.refresh();focusMovedTask(id);animateLayout(old,'.card[data-task]');},

  // filters
  setBoardQ(v,event) {
    cancelBoardSearch();
    state.boardQ = v.trim();
    if (event?.isComposing) return;
    if (!event || !v) { applyBoardFilters(); return; }
    const projectId=state.projectId, sessionId=D.session?.id;
    boardSearchTimer=setTimeout(()=>{
      if(state.view==='board'&&state.projectId===projectId&&D.session?.id===sessionId)applyBoardFilters();
    },180);
  },
  boardSearchKey(event) {
    if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(boardSearchTimer)applyBoardFilters();}
  },
});
window.App = App;
export { App };

// ---------- global listeners ----------
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
/** The address Discard let through, which routes without asking again. */
let discardedFor = null;
/** Go to an address that the person already chose to leave typed text for. */
function followAddress(hash) { discardedFor = new URL(hash, location.href).href; location.hash = hash; }
/**
 * Back, Forward or an address typed by hand: a field that saves itself saves
 * first, as no browser blurs it here. If typed text would still be lost, the
 * old address comes back while oneloop asks; Discard goes on.
 */
function mayFollowAddress(event) {
  if (event.newURL === discardedFor) { discardedFor = null; return true; }
  const active = document.activeElement;
  if (active?.matches?.('[data-autosave]')) active.blur();
  if (!window.Recovery?.hasUnsavedInput?.({ leaving:false })) return true;
  const { oldURL, newURL } = event;
  history.replaceState(history.state, '', oldURL);
  askToDiscard(() => {
    discardedFor = newURL;
    history.replaceState(history.state, '', newURL);
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL }));
  });
  return false;
}
window.addEventListener('hashchange',(event)=>{
  // Local navigation already painted its destination. Consume only that
  // exact history event, so external hashes and Back/Forward still route.
  const index=locallyRenderedHashes.indexOf(event.newURL);
  if(index!==-1){locallyRenderedHashes.splice(index,1);window.Recovery?.clearPageError();return;}
  if(event.newURL && event.newURL!==location.href)return;
  // Staying keeps the page, so the route loader must not load the new one either.
  if(!mayFollowAddress(event)){event.stopImmediatePropagation();return;}
  window.Recovery?.clearPageError();
  state.peek=null;state.modal=null;state.menu=null;resolveRoute();render();
});
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
document.addEventListener('compositionend', (e) => { if(e.target.matches?.('[data-board-search]'))App.setBoardQ(e.target.value,e); }, true);
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

collaboration?.bind(App,{task:taskById,projects:visibleProjects,view:()=>state.view,canBoard:task=>hasPermission('manage_board',trackById(epicById(task?.epicId)?.trackId)?.projectId),confirm:askConfirmation,refresh:render,refreshBackground,refreshActivity:refreshTaskActivity,exit:exitVisual,multi:multiHtml,ago,instant:formatInstant,dateKey:instanceDateKey,previousDate,avatar:avatarHtml,
  refreshComments:(id,composer=false)=>{if(state.view!=='task'||state.taskId!==id)return;const task=taskById(id),timeline=document.querySelector('.task-page .timeline'),before=timeline?.getBoundingClientRect().height,rows=UIMotion.rows(timeline,'[data-comment]','data-comment'),focused=document.activeElement?.dataset.replyRoot;if(timeline){setHTML(timeline,collaboration.feedHtml(task));UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-comment]','data-comment',rows);if(focused)[...timeline.querySelectorAll('[data-reply-root]')].find(el=>el.dataset.replyRoot===focused)?.focus({preventScroll:true});}if(composer){const home=document.querySelector('.comment-composer-home');if(home)setHTML(home,Collab.composerHtml(task));UIMotion.enter(document.querySelector('.collaboration-composer .reply-context'));}},
});
window.Recovery?.bind(App,{refresh:render});
window.Uploads?.bind(App,{confirm:askConfirmation,task:taskById,canRead:id=>canReadTask(taskById(id)),can:id=>hasPermission('manage_board',trackById(epicById(taskById(id)?.epicId)?.trackId)?.projectId),refresh:render,me,instant:formatInstant,refreshAttachments:id=>{if(state.view!=='task'||state.taskId!==id)return;const template=document.createElement('template');setHTML(template,renderTask());const oldAttachments=document.querySelector('.task-attachments'),before=oldAttachments?.getBoundingClientRect().height,rows=UIMotion.rows(oldAttachments,'[data-attachment-id]','data-attachment-id');oldAttachments?.replaceWith(template.content.querySelector('.task-attachments'));const nextAttachments=document.querySelector('.task-attachments');UIMotion.height(nextAttachments,before);UIMotion.reflow(nextAttachments,'[data-attachment-id]','data-attachment-id',rows);refreshTaskActivity(id);window.Uploads.mount(id);}});
setInterval(()=>{
  const key=instanceDateKey(instanceNow());if(key===iso(today))return;today.setTime(+d(key));
  if(!D.session||me()?.mustChange)return;
  if (state.view==='roadmap'||state.peek) window.OneloopRuntime.invoke('date.rollover',{}).catch(()=>{});
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
