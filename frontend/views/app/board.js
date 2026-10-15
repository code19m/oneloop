// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* The Board: task columns, their filters, and moving tasks with optimistic
   saves that roll back when the server refuses. */

import { UIMotion } from '../../src/app/motion.js';
import {
  NO_ASSIGNEE, boardFiltered, matchesBoardFilters, normalizeBoardFilters,
} from '../../src/data/board-filters.js';
import { sessionKey } from '../../src/data/projection-store.js';
import { MULTI, multiHtml } from './controls.js';
import { drag, dropIndicator, makeDropIndicator, setDragImage } from './drag.js';
import {
  I, STATUS, UIAction, avatarHtml, d, esc, formatInstant, humanInstant, humanShort, instanceDateKey,
  instanceTimeZone, instanceToday, overdue, setHTML, stIcon, today,
} from './format.js';
import {
  App, D, blockedCount, canBoard, epicById, epics, firstBoardPages, instanceNow, me, poolTotal,
  projectMembers, recovery, report, runtime, state, taskById, tasks, trackById, tracks, userById, userHandle,
} from './model.js';
import { openMenu } from './overlays.js';
import { patchInPlace, placeRows } from './rows.js';
import { announce } from './toasts.js';

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

/** The filters the Board shows, as App.context().board names them. */
const boardFilters = () => ({ search: state.boardQ, blocked: state.boardBlocked, trackIds: state.boardTracks, epicIds: state.boardEpics, assigneeIds: state.boardAssignees });

/** The project's loaded tasks that pass the Board's filters. */
function boardTasks() {
  const filters = normalizeBoardFilters(boardFilters());
  if (!boardFiltered(filters)) return tasks();
  return tasks().filter((t) => matchesBoardFilters({ title: t.title, key: t.id, epicId: t.epicId, trackId: epicById(t.epicId)?.trackId, assigneeIds: t.assignees || [], blocked: !!t.block && t.state !== 'done' }, filters));
}

export function renderBoard({column=null,excludeIds=null}={}) {
  const ts = boardTasks();
  const filtered = boardFiltered(boardFilters());
  if (!ts.length) return `<div class="board board-empty"><div class="page-empty"><h2>${filtered ? 'No matching tasks' : 'No tasks yet'}</h2>${filtered ? `<button class="btn quiet" ${UIAction('clearBoardFilters')}>Clear filters</button>` : canBoard() ? `<button class="btn primary" ${UIAction('openModal', 'task')}>${I.plus} Create task</button>` : ''}</div></div>`;
  const cols = COLS.filter(c=>!column||c.key===column).map((c) => {
    const list = ts.filter((t) => t.state === c.key);
    const serverPage = D.boardPageInfo?.projectId === state.projectId ? D.boardPageInfo.pages?.[c.key] : null;
    const cards = list.slice(0,state.boardLimits[c.key] || 50).filter(t=>!excludeIds?.has(t.id)).map((t) => {
      const e = epicById(t.epicId);
      const b = taskBits(t);
      const av = (t.assignees || []).filter(userById);
      const avs = av.slice(0, 3).map((a) => avatarHtml(a, 18)).join('') + (av.length > 3 ? `<span class="avatar">+${av.length - 3}</span>` : '');
      return `<div role="listitem" class="card ${b.cls}${t.block ? ' blocked' : ''}" data-task="${esc(t.id)}" ${canBoard() ? `data-reorderable="true" ${UIAction.on('dragstart', 'taskDragStart', UIAction.event, t.id)} ${UIAction.on('dragend', 'dragEnd')}` : ''} ${UIAction('openTask', t.id)}>
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
    return `<section class="col" aria-labelledby="col-${c.key}" data-col="${esc(c.key)}" ${canBoard() ? `${UIAction.on('dragover', 'colOver', UIAction.event)} ${UIAction.on('dragleave', 'colLeave', UIAction.event)} ${UIAction.on('drop', 'dropTask', UIAction.event, c.key)}` : ''}>
      <div class="col-head"><div class="row1">${stIcon(c.key)}<h2 id="col-${esc(c.key)}">${c.name}</h2><span class="mono subtle">${serverPage?.total ?? list.length}</span>${c.key === 'done' ? `<button type="button" class="btn quiet done-order" aria-pressed="${doneNewest()}" ${UIAction('toggleDoneOrder')}>Newest first</button>` : ''}</div>
      </div>
      <div class="col-cards" role="list" aria-labelledby="col-${c.key}">${cards || '<div class="empty-note" role="listitem">No tasks</div>'}${serverPage?.nextCursor ? `<div role="listitem" class="board-load-more"><button class="btn quiet" ${UIAction('loadMoreBoard', c.key)}>Load more</button></div>` : ''}</div></section>`;
  }).join('');
  return `<div class="board">${cols}</div>`;
}

// ---------- filters ----------
const filterAnimations = new Set();
const filterExitLayers = new Set();
const filterScroll = new WeakMap();
export const boardSnapshots = new WeakMap();
let boardSearchTimer;

export function cancelBoardSearch() { clearTimeout(boardSearchTimer); boardSearchTimer = null; }

export function boardSnapshot() {
  // Display dependencies, not just task revisions: access, parent names,
  // avatars and date boundaries can change independently of a task.
  return JSON.stringify([
    state.projectId, canBoard(), instanceTimeZone(), instanceDateKey(instanceNow()),
    boardFiltered(boardFilters()),
    state.boardLimits, D.boardPageInfo,
    boardTasks().map(t=>[t.id,t.state,t.title,t.epicId,t.created,t.deadline,t.assignees,t.block]),
    D.epics.map(e=>[e.id,e.title]), D.users.map(u=>[u.id,u.name,u.avatar]),
  ]);
}

export function clearFilterMotion() {
  filterAnimations.forEach((animation) => animation.cancel());
  filterAnimations.clear();
  filterExitLayers.forEach((layer) => layer.remove());
  filterExitLayers.clear();
}

function filterAnimate(element, frames, cleanup) {
  const animation = UIMotion.animate(element, frames);
  if (!animation) { cleanup?.(); return; }
  filterAnimations.add(animation);
  const finish = () => { filterAnimations.delete(animation); cleanup?.(); };
  animation.finished.then(finish, finish);
}

function boardRowKey(row, column) {
  if (row.dataset.task) return `task:${row.dataset.task}`;
  return `${column}:${row.classList.contains('empty-note') ? 'empty' : 'more'}`;
}

/** Show the Board unfiltered, from the first page of each column, as for another project. */
export function resetBoardFilters() {
  state.boardTracks = []; state.boardEpics = []; state.boardAssignees = []; state.boardQ = ''; state.boardBlocked = false;
  state.boardLimits = firstBoardPages();
}

function applyBoardFilters(reset = true, fromServer = false, { animate: motion = true } = {}) {
  if (!fromServer) cancelBoardSearch();
  App.updateDocumentTitle();
  if(reset) state.boardLimits = firstBoardPages();
  if(!fromServer){runtime().filterBoard(App.context().board).catch(report);return;}
  const board = document.querySelector('.board');
  if (!board || state.view !== 'board') return;
  const snapshot = boardSnapshot();
  if (boardSnapshots.get(board) === snapshot) return;
  today.setTime(instanceToday().getTime());
  // Snapshot painted positions before cancelling an interrupted transition.
  const previous = new Map([...board.querySelectorAll('.col-cards > *')].map((card) =>
    [boardRowKey(card,card.closest('.col').dataset.col), { card, rect: card.getBoundingClientRect(), opacity: getComputedStyle(card).opacity }]));
  clearFilterMotion();
  const animate = motion && !UIMotion.reduced() && typeof board.animate === 'function' && !drag.item;
  const template = document.createElement('template');
  setHTML(template,renderBoard());
  if (!board.querySelector('.col') || !template.content.querySelector('.col')) {
    const next=template.content.firstElementChild;
    if (board.classList.contains('board-empty') && next.classList.contains('board-empty')
      && board.textContent===next.textContent && board.querySelector('button')?.className===next.querySelector('button')?.className) {boardSnapshots.set(board,snapshot);return;}
    board.replaceWith(next); boardSnapshots.set(next,snapshot); UIMotion.fade(next); return;
  }
  [...board.querySelectorAll('.col')].forEach((column) => {
    const list = column.querySelector('.col-cards');
    const next = template.content.querySelector(`[data-col="${esc(column.dataset.col)}"]`);
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
      const ghost = UIMotion.ghost(card);
      ghost.style.cssText = `position:absolute;margin:0;left:${old.rect.left - viewport.left}px;top:${old.rect.top - viewport.top}px;width:${old.rect.width}px;height:${old.rect.height}px`;
      exitLayer.append(ghost);
      const layer = exitLayer;
      filterAnimate(ghost, [{ opacity: old.opacity }, { opacity: 0 }], () => {
        ghost.remove();
        if (!layer.children.length) { layer.remove(); filterExitLayers.delete(layer); }
      });
    });
    // A row keeps its element while its actions stay; a permission change
    // replaces a card, so its drag handlers come and go together.
    placeRows(list, desired.map((row) => {
      const old=previous.get(boardRowKey(row,column.dataset.col))?.card;
      return old && old.hasAttribute('data-reorderable')===row.hasAttribute('data-reorderable') ? patchInPlace(old,row) : row;
    }));
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

// ---------- page header ----------
/** The Board's page header: search, filters, Pool and New task. */
export function boardTopbarHtml() {
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
    <input class="ctl board-search" data-board-search aria-label="Search tasks" placeholder="Search tasks" value="${esc(state.boardQ)}" ${UIAction.on('input', 'setBoardQ', UIAction.value, UIAction.event)} ${UIAction.on('keydown', 'boardSearchKey', UIAction.event)}>
    ${mk('fTrack', state.boardTracks, 'All tracks', 'tracks', tracks().map((t) => ({ v: t.id, l: t.name })), { width: 140 })}
    ${mk('fEpic', state.boardEpics, 'All epics', 'epics', epicOpts.map((e) => ({ v: e.id, l: e.title })), { search: true, width: 180 })}
    ${mk('fAssignee', state.boardAssignees, 'All assignees', 'assignees', assigneeOpts, { search: true, width: 150 })}
    <button class="btn blocked-filter" aria-pressed="${state.boardBlocked}" ${UIAction('setBlockedFilter', UIAction.element)}>${I.blocked}Blocked<span class="blocked-filter-count" title="Blocked tasks in this project">${blockedCount()}</span></button>
    <button class="btn quiet" ${UIAction('openModal', 'pool')}>Pool <span class="mono subtle" data-pool-count>${poolTotal()}</span></button>
    ${canBoard() ? `<button class="btn primary" ${UIAction('openModal', 'task')}>${I.plus} Task</button>` : '<span class="read-only-pill">read only</span>'}
  </div>`;
}

// ---------- moving tasks ----------
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

/** The task's project and the tasks next to it in that project, where a rollback puts it back. */
function moveOrigin(t) {
  const projectId=t.projectId||trackById(epicById(t.epicId)?.trackId)?.projectId||state.projectId;
  const taskProject=(item)=>item.projectId||trackById(epicById(item.epicId)?.trackId)?.projectId;
  const projectTasks=D.tasks.filter((item)=>taskProject(item)===projectId),index=projectTasks.indexOf(t);
  return { task:t, revision:t.revision, projectId, sessionKey:sessionKey(D),
    previousTaskBefore:index>0?projectTasks[index-1]:null, previousTaskAfter:projectTasks[index+1]||null };
}

function applyTaskMove(t, col, beforeId = null, atTop = false) {
  // A newest-first Done shows a finished task on top and has no manual order to change.
  const newest = col === 'done' && doneNewest();
  if (newest) { if (t.state === 'done') return null; beforeId = null; atTop = true; }
  const plan = taskMovePlan(t, col, beforeId, atTop); if (!plan) return null;
  const shownBefore = shownColumn(col).filter((item) => item !== t);
  const origin = moveOrigin(t), { projectId } = origin, previousState = t.state;
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
    ...origin, previousState, optimisticState:col, previousOrders, optimisticOrders,
    pageInfoReference,previousPageInfo,optimisticPageInfo:D.boardPageInfo?JSON.parse(JSON.stringify(D.boardPageInfo)):null,
    countsReference,previousCounts,optimisticCounts:countsReference?{...countsReference}:null,affectedEpics,optimisticEpics,
    payload:{ taskId:t.internalId||t.id, status:col, ...(newest ? {} : plan.placement), optimistic:true },
  };
}

/**
 * Put a moved task back between the tasks it was next to, unless the move
 * no longer stands as sent: another session, or a newer revision of the task.
 */
function restoreTaskPosition(change) {
  if (sessionKey(D)!==change.sessionKey || !D.tasks.includes(change.task) || change.task.revision !== change.revision) return false;
  const currentIndex=D.tasks.indexOf(change.task);D.tasks.splice(currentIndex,1);
  if(change.previousTaskAfter&&D.tasks.includes(change.previousTaskAfter))D.tasks.splice(D.tasks.indexOf(change.previousTaskAfter),0,change.task);
  else if(change.previousTaskBefore&&D.tasks.includes(change.previousTaskBefore))D.tasks.splice(D.tasks.indexOf(change.previousTaskBefore)+1,0,change.task);
  else D.tasks.splice(Math.min(currentIndex,D.tasks.length),0,change.task);
  return true;
}

/** Undo a column move: the task's place and status, the column orders and the counts it changed. */
function rollbackTaskMove(change) {
  if (change.task.state!==change.optimisticState || !restoreTaskPosition(change)) return false;
  change.task.state=change.previousState;
  for(const [item,order] of change.previousOrders)if(D.tasks.includes(item)&&item.order===change.optimisticOrders.get(item))item.order=order;
  if(change.previousPageInfo&&D.boardPageInfo===change.pageInfoReference&&JSON.stringify(D.boardPageInfo)===JSON.stringify(change.optimisticPageInfo))D.boardPageInfo=change.previousPageInfo;
  if(change.previousCounts&&D.projectTaskCounts?.[change.projectId]===change.countsReference&&JSON.stringify(change.countsReference)===JSON.stringify(change.optimisticCounts))D.projectTaskCounts[change.projectId]=change.previousCounts;
  for(const [id,value] of change.affectedEpics){const item=epicById(id),optimistic=change.optimisticEpics.get(id);if(item===value.item&&item===optimistic?.item&&item.state===optimistic.state&&item.done===optimistic.done)Object.assign(item,{state:value.state,done:value.done});}
  return true;
}

/** The Board move the server has not answered yet. The Board takes one move at a time. */
let pendingMove = null;
export const boardMovePending = () => !!pendingMove;

/**
 * Send a move that already shows. When the server refuses it, `rollback`
 * undoes it, and `onRollback` draws the Board again if it still shows the
 * move's project.
 */
function submitTaskMove(change, { rollback = rollbackTaskMove, onRollback = () => App.refresh() } = {}) {
  if (!change) return;
  const pending={};pendingMove=pending;
  runtime().moveTask(change.payload).catch((error)=>{
    if(!error?.uncertain&&rollback(change)&&state.view==='board'&&state.projectId===change.projectId)onRollback();
    report(error);
  }).finally(()=>{if(pendingMove===pending)pendingMove=null;});
}

function setTaskState(t, col) {
  if (!canBoard()) return;
  if (pendingMove) return false;
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

function settleCard(card, from) {
  if (!card || !from || UIMotion.reduced()) return;
  const to = card.getBoundingClientRect();
  const ghost = UIMotion.ghost(card);
  ghost.classList.remove('dragging');
  ghost.classList.add('drag-settle');
  ghost.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px`;
  document.body.appendChild(ghost);
  card.classList.add('settling');
  const animation = UIMotion.animate(ghost, [
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(1.025)`, opacity: 0.9 },
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
  ], 260);
  const cleanup = () => { ghost.remove(); card.classList.remove('settling'); };
  if (animation) animation.finished.then(cleanup, cleanup); else cleanup();
}

document.addEventListener('compositionend', (e) => { if(e.target.matches?.('[data-board-search]'))App.setBoardQ(e.target.value,e); }, true);

Object.assign(App, {
  // A drop animates its own card; it passes { animate: false } so the refresh does not move it again.
  refreshBoard(options) { applyBoardFilters(false,true,options); App.refreshCounts(); },
  acceptMoreBoard(col) {
    state.boardLimits[col]=(state.boardLimits[col]||50)+50;
    const board=document.querySelector('.board'),column=board?.querySelector(`[data-col="${esc(col)}"]`),list=column?.querySelector('.col-cards');
    if(!list||state.view!=='board')return;
    const ids=new Set([...list.querySelectorAll('[data-task]')].map(card=>card.dataset.task));
    const template=document.createElement('template');setHTML(template,renderBoard({column:col,excludeIds:ids}));
    const next=template.content.querySelector('.col-cards'),more=list.querySelector('.board-load-more');
    for(const card of next.querySelectorAll('.card')){list.insertBefore(card,more);UIMotion.enter(card);}
    if(list.querySelector('.card'))list.querySelector('.empty-note')?.remove();
    const nextMore=next.querySelector('.board-load-more');
    if(!nextMore){const focused=more?.contains(document.activeElement);more?.remove();if(focused)list.querySelector('.card:last-of-type .title')?.focus({preventScroll:true});}
    else if(!more)list.append(nextMore);
    column.querySelector('.col-head .mono').textContent=template.content.querySelector('.col-head .mono').textContent;
    boardSnapshots.set(board,boardSnapshot());
  },
  setBlockedFilter(button){state.boardBlocked=!state.boardBlocked;button?.setAttribute('aria-pressed',String(state.boardBlocked));applyBoardFilters();},
  taskDragStart(ev, id) {
    clearFilterMotion();
    if (!App.require('manage_board')) { ev.preventDefault(); return; }
    if (pendingMove) { ev.preventDefault(); return; }
    App.dragEnd(false);
    ev.dataTransfer.setData('text/task', id);
    ev.dataTransfer.effectAllowed = 'move';
    const card = ev.currentTarget;
    const r = card.getBoundingClientRect();
    drag.item = { kind: 'task', id, offsetX: ev.clientX - r.left, offsetY: ev.clientY - r.top };
    setDragImage(ev, card);
    document.body.classList.add('is-dragging');
    requestAnimationFrame(() => { if (drag.item?.id === id) card.classList.add('dragging'); });
  },
  colOver(ev) {
    if (!canBoard() || drag.item?.kind !== 'task') return;
    if (!ev.dataTransfer.types.includes('text/task')) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
    const colEl = ev.currentTarget;
    const list = colEl.querySelector('.col-cards');
    const ind = dropIndicator();
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
    if (drag.column === colEl.dataset.col && drag.before === beforeId && ind?.parentNode === list) return;
    const before = UIMotion.positions('.card[data-task]');
    document.querySelectorAll('.col.drop').forEach((el) => { if (el !== colEl) el.classList.remove('drop'); });
    colEl.classList.add('drop');
    drag.column = colEl.dataset.col;
    drag.before = beforeId;
    const marker = makeDropIndicator(false);
    if (next) list.insertBefore(marker, next); else list.appendChild(marker);
    UIMotion.layout(before, '.card[data-task]', drag.item.id);
  },
  colLeave(ev) {
    if (ev.currentTarget.contains(ev.relatedTarget)) return;
    ev.currentTarget.classList.remove('drop');
    if (dropIndicator()?.parentNode === ev.currentTarget.querySelector('.col-cards')) {
      const before = UIMotion.positions('.card[data-task]');
      dropIndicator().remove(); drag.column = null; drag.before = null;
      UIMotion.layout(before, '.card[data-task]', drag.item?.id);
    }
  },
  dropTask(ev, col) {
    if(recovery.blockDrag()){ev.preventDefault();App.dragEnd();return;}
    if (!App.require('manage_board')) return;
    if (pendingMove) { ev.preventDefault(); App.dragEnd(); return; }
    if (!ev.dataTransfer.types.includes('text/task') || drag.item?.kind !== 'task') return;
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/task');
    const beforeId = drag.before;
    const t = taskById(id);
    if (!t || id === beforeId) { App.dragEnd(); return; }
    if(t.block && col==='done'){App.dragEnd();App.openModal('completeBlocked',id);return;}
    const before=UIMotion.positions('.card[data-task]'),from={left:ev.clientX-drag.item.offsetX,top:ev.clientY-drag.item.offsetY};
    const scrolls=[...document.querySelectorAll('.col-cards')].map((el)=>[el.closest('.col').dataset.col,el.scrollTop]);
    const boardLeft=document.querySelector('.board').scrollLeft,change=applyTaskMove(t,col,beforeId);
    App.dragEnd(false);if(!change)return;
    App.refreshBoard({animate:false});document.querySelector('.board').scrollLeft=boardLeft;
    scrolls.forEach(([key,top])=>{const list=document.querySelector(`[data-col="${esc(key)}"] .col-cards`);if(list)list.scrollTop=top;});
    UIMotion.layout(before,'.card[data-task]',id);settleCard(document.querySelector(`[data-task="${esc(id)}"]`),from);
    submitTaskMove(change,{onRollback:()=>{const rollbackBefore=UIMotion.positions('.card[data-task]');App.refreshBoard({animate:false});UIMotion.layout(rollbackBefore,'.card[data-task]');}});
  },
  clearBoardFilters(){cancelBoardSearch();resetBoardFilters();runtime().filterBoard(App.context().board).catch(report);},
  toggleDoneOrder(){runtime().setDoneOrder(doneNewest()?'manual':'completed').catch(report);},
  loadMoreBoard(col){runtime().loadMoreBoard(col).catch(report);},
  taskMoveMenu(event,id){
    event.stopPropagation(); // The card around the button would open the task.
    if(pendingMove)return;
    if(!canBoard())return;const task=taskById(id),list=boardTasks().filter(t=>t.state===task.state),index=list.indexOf(task),r=event.currentTarget.getBoundingClientRect();
    const items=COLS.filter(c=>c.key!==task.state).map(c=>({label:'Move to '+c.name,fn:()=>{if(canBoard()){if(setTaskState(task,c.key)!==false){App.refresh();focusMovedTask(id);}}}}));
    const ordered=!(task.state==='done'&&doneNewest());
    if(ordered&&index>0)items.push({label:'Move up',fn:()=>App.moveTaskOrder(id,list[index-1].id,true)});
    if(ordered&&index<list.length-1)items.push({label:'Move down',fn:()=>App.moveTaskOrder(id,list[index+1].id,false)});
    openMenu(items,r.left,r.bottom+6,{trigger:event.currentTarget});
  },
  /** Move a task just before or after another one in its column. */
  moveTaskOrder(id,anchor,before){
    if(!canBoard()||pendingMove)return;
    const task=taskById(id),target=taskById(anchor);if(!task||!target||task.state!==target.state)return;
    const change={...moveOrigin(task),payload:{taskId:task.internalId,status:task.state,[before?'beforeTaskId':'afterTaskId']:target.internalId,optimistic:true}};
    const old=UIMotion.positions('.card[data-task]');D.tasks.splice(D.tasks.indexOf(task),1);D.tasks.splice(D.tasks.indexOf(target)+(before?0:1),0,task);App.refresh();focusMovedTask(id);UIMotion.layout(old,'.card[data-task]');
    submitTaskMove(change,{rollback:restoreTaskPosition,onRollback:()=>App.refreshBoard()});
  },

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
