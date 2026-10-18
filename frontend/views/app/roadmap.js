// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* The Roadmap: each track as a lane on a zoomable time axis, with milestones
   and Today above them (the lanes' tasks are timeline.js's), the epic drawer,
   and moving tracks. */

import { pageOf, projectAddress } from '../../src/app/address.js';
import { UIMotion } from '../../src/app/motion.js';
import { sortable } from '../../src/app/sortable.js';
import { sessionKey } from '../../src/data/projection-store.js';
import {
  DAY, I, STATUS, UIAction, ago, d, esc, formatInstant, human, humanShort, setHTML, stIcon, today,
} from './format.js';
import { descriptionReadHtml } from './forms.js';
import {
  App, D, ROADMAP_SCALES, canBoard, canReadProject, canRoadmap, epicById, epics, milestones, project,
  report, runtime, state, taskById, tasks, trackById, tracks, userById,
} from './model.js';
import {
  EPIC_TIP, POP, hideEpicTip, mountRoadmapTip, openMenu, peekOpened, pendingConfirmation,
  rememberOpener, restoreOpener,
} from './overlays.js';
import { announce } from './toasts.js';
import {
  closeTimelineList, epicDated, epicStatus, focusTask, headFigure, isLate, laneBodyHtml, laneDates, laneEntry, laneFocus, laneModels,
  layoutLane, mountLanes, numbers, roadmapLanes, roomAfterNow, setStyle, syncLaneEdges, textWidth,
} from './timeline.js';

// ---------- roadmap geometry ----------
// The model holds dates as days from the range start; pixels are days times
// the zoom level (pixels per day). A zoom step moves the axis, lines and
// labels in place and draws only the lanes' marks again, which merge
// differently at each zoom.
/** The track rail on the left; on a phone each track's head sits above its lane instead. */
let RAIL = 216;
/**
 * The axis: a row of milestone cards when the project has milestones, a row
 * for Today, then a row of dates. Its height never changes with the zoom.
 */
const AXIS = 56, CARD_ROW = 52;
/** A milestone's card: the app's shiny diamond, its name and "Oct 26 · 9d away"; its line drops from the card. */
const CARD_TOP = 8, CARD_H = 44, LABEL_H = 20;
const axisHeight = (model) => AXIS + (model.goals.length ? CARD_ROW : 0);
const labelTop = (model) => CARD_TOP + (model.goals.length ? CARD_ROW : 0);
const ZOOM_MIN = 2.2, ZOOM_MAX = 42;
/** At this width and below, a track's head sits above its lane. */
const stackedLayout = () => window.innerWidth <= 900;
/**
 * Where today sits in a view the Roadmap places, as a share of the visible
 * timeline: the work done and in progress gets a little more room than the
 * dated plans after it. With nothing dated ahead, Today sits near the right
 * edge (roomAfterNow).
 */
const TODAY_AT = 0.56, TODAY_AT_PHONE = 0.6;
/** The scale nearest a zoom, in proportion, as each wheel notch zooms by a factor. */
const nearestScale = (ppd) => ROADMAP_SCALES.reduce((near, scale) => (Math.abs(Math.log(scale.ppd / ppd)) < Math.abs(Math.log(near.ppd / ppd)) ? scale : near));
/** From 18 px a day, a week is 126 px or more, so the axis shows weeks instead of months. */
const WEEK_AXIS_PPD = 18;
const roadmapScale = () => ROADMAP_SCALES.find((scale) => Math.abs(scale.ppd - state.pxPerDay) < 0.005) || null;
/** The item last focused or opened on the Roadmap, which a scale change keeps in view. */
let roadmapSelection = null;
/**
 * Whether the person picked the zoom: with a scale, a wheel or a pinch, or
 * through an address that names a scale. Otherwise the Roadmap opens at the
 * scale that fits each project's work, once its lanes load (`fitted`).
 */
let picked = false, fitted = null;

/**
 * The scale that shows the work around today: the last three weeks' done
 * work, the work in progress, the next six weeks of dates, and the room the
 * view keeps after now (`reserve`, in pixels). Returns its zoom and that
 * window of days.
 */
function fitScale(model, room, reserve) {
  const now = model.today;
  let from = now - 3, to = now;
  for (const lane of model.lanes) for (const section of lane.sections) for (const item of section.items) {
    if (item.kind === 'done' && item.at >= now - 21) from = Math.min(from, item.at);
    if (item.kind === 'flight') { from = Math.min(from, Math.max(item.from, now - 30)); if (!item.open && item.to <= now + 45) to = Math.max(to, item.to); }
    if (item.kind === 'planned' && item.at <= now + 45) to = Math.max(to, item.at);
  }
  for (const goal of model.goals) if (goal.at >= now - 3 && goal.at <= now + 45) to = Math.max(to, goal.at);
  const span = to - from + 4;
  const scale = ROADMAP_SCALES.find((item) => span * item.ppd + reserve <= room * 0.94) || ROADMAP_SCALES[ROADMAP_SCALES.length - 1];
  return { ppd: scale.ppd, window: { from, to } };
}

/**
 * The days the timeline covers: `start` anchors day 0, and `end` is the last
 * date it must reach. It runs from seven weeks back to two months ahead, and
 * further for dated epics, milestones and the lanes' work.
 */
function rmRange() {
  let min = new Date(today.getTime() - 50 * DAY), max = new Date(today.getTime() + 60 * DAY);
  const take = (date) => { if (date < min) min = date; if (date > max) max = date; };
  epics().forEach((e) => { if (epicDated(e)) { take(d(e.start)); take(d(e.end)); } });
  milestones().forEach((m) => take(d(m.date)));
  const work = laneDates();
  if (work) { take(work.min); take(work.max); }
  return { start: new Date(min.getTime() - 10 * DAY), end: new Date(max.getTime() + 45 * DAY) };
}

/** The Roadmap's lanes and milestones as day offsets; nothing here depends on the zoom level. */
function roadmapModel() {
  const { start, end } = rmRange(), timeline = laneModels(start);
  const day = (dt) => Math.round((dt - start) / DAY);
  const goals = milestones().slice().sort((a, b) => d(a.date) - d(b.date)).map((m) => {
    const date = d(m.date), days = Math.round((date - today) / DAY);
    const name = m.name.charAt(0).toUpperCase() + m.name.slice(1);
    const dateLabel = humanShort(date) + (days > 0 ? ` · ${days}d away` : days === 0 ? ' · Today' : '');
    // The card: border, padding, diamond and gap, then the longer of its two lines, with a little room.
    const pad = 12, diamond = 14, gap = 10;
    const width = Math.ceil(2 + 2 * pad + diamond + gap + Math.max(textWidth(name, '600 13px'), textWidth(dateLabel, '500 12px') * 1.06) + 6);
    // Where the diamond's middle sits in the card, and the card as the diamond alone.
    const pole = 1 + pad + diamond / 2, compact = 2 + 2 * pad + diamond;
    // A milestone marks its whole day: the line runs through the middle of it.
    return { m, past: days < 0, name, dateLabel, width, pole, compact, at: day(date) + 0.5 };
  });
  // How far the loaded pages reach: done work back to `historyFrom`, dated plans up to `plansUntil`.
  const items = timeline.lanes.flatMap((lane) => lane.sections).flatMap((section) => section.items);
  const reach = (kind, pick) => { const at = items.filter((item) => item.kind === kind).map((item) => item.at); return at.length ? pick(...at) : timeline.now; };
  return { start, span: day(end), today: timeline.now, lanes: timeline.lanes, ready: timeline.ready, goals, historyFrom: reach('done', Math.min), plansUntil: reach('planned', Math.max) };
}

/** Whether anything dated lies ahead: a dated plan, a deadline of work in progress, or a milestone. */
function datedAhead(model) {
  const now = model.today, items = model.lanes.flatMap((lane) => lane.sections).flatMap((section) => section.items);
  return items.some((item) => (item.kind === 'planned' && item.at > now) || (item.kind === 'flight' && !item.open && item.to > now)) || model.goals.some((goal) => goal.at > now);
}
/** Where every mark of every lane goes at a zoom level. */
const roadmapLayout = (model, ppd) => ({ ppd, lanes: model.lanes.map((lane) => layoutLane(lane, ppd, model.today)) });

/** The zoom factor of one wheel event, as a natural logarithm. */
const WHEEL_NOTCH = Math.log(1.15), MAC_WHEEL_LINE = 4.000244140625;

function wheelZoom(event) {
  const delta = event.deltaY;
  if (!delta) return 0;
  // A mouse notch zooms 15%: line or page deltas, large pixel deltas, or the
  // multiples of 4.000244140625 px that macOS sends. A touchpad pinch arrives
  // as many small pixel deltas (100 × the log of its scale), so the Roadmap
  // follows the fingers.
  const notch = event.deltaMode !== 0 || Math.abs(delta) >= 50 || Math.abs(delta) % MAC_WHEEL_LINE === 0;
  return notch ? -Math.sign(delta) * WHEEL_NOTCH : Math.max(-WHEEL_NOTCH, Math.min(WHEEL_NOTCH, -delta / 100));
}
const clampZoom = (ppd) => Math.round(Math.min(Math.max(ppd, ZOOM_MIN), ZOOM_MAX) * 1e4) / 1e4;
// Horizontal places at a zoom level, in whole pixels so text stays on the pixel grid.
const dayX = (days, ppd) => Math.round(days * ppd);
/** A milestone card's left edge: its diamond on the date. Where that card has no room it ends at its line, or shows its diamond alone (placeCards). */
const cardLeft = (goal, ppd) => dayX(goal.at, ppd) - goal.pole;

function showMilestoneTip(anchor, id) {
  const milestone = milestones().find(m => m.id === id);
  if (!milestone) return;
  const days = Math.round((d(milestone.date) - today) / DAY);
  const timing = days === 0 ? 'Today' : `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} ${days > 0 ? 'away' : 'ago'}`;
  mountRoadmapTip(anchor, 'milestone-tooltip', `<div class="epic-tip-title">${esc(milestone.name)}</div>
    <div class="epic-tip-track">Milestone · ${esc(project().name)}</div>
    <dl class="epic-tip-facts"><div><dt>Date</dt><dd>${esc(milestone.date)}</dd></div><div><dt>Timing</dt><dd>${timing}</dd></div></dl>
    <div class="epic-tip-description">${milestone.desc ? esc(milestone.desc) : '<span class="tone-ghost">No description</span>'}</div>`);
}

/** The latest rendered Roadmap, which mountRoadmap binds. */
let renderedRoadmap = null;

/** A track's lane: its head (its name and figures, with its grip and menu for people who manage the Roadmap) and its timeline. */
function laneHtml(lane, laid, ppd, model, stacked, viewWidth) {
  const t = lane.track;
  const body = model.ready ? laneBodyHtml(lane, laid, ppd, model.today, laneEntry(laid, laneFocus.get(t.id)))
    : '<div class="rt-loading" aria-hidden="true"><span class="skeleton"></span><span class="skeleton"></span></div>';
  const figure = headFigure(lane, model.ready);
  // A name cut off shows in full in its tip, on hover or, from its grip and ⋮, on keyboard focus.
  const nameTip = `data-tip="${esc(t.name)}" data-tip-overflow="track-name-${esc(t.id)}" data-tip-keyboard`;
  return `<section class="lane" data-track="${esc(t.id)}" aria-labelledby="track-name-${esc(t.id)}">
    <div class="rail-cell lane-head" style="width:${stacked ? `${viewWidth}px` : `${RAIL}px`}">
      <div class="lane-title-row"><h2 class="name" id="track-name-${esc(t.id)}" data-tip="${esc(t.name)}" data-tip-overflow>${esc(t.name)}</h2>${canRoadmap() ? `<div class="head-ctl">
        <button type="button" class="grip" aria-label="Reorder ${esc(t.name)}" title="Drag to reorder · Arrow keys to move" ${nameTip}>${I.grip}</button>
        <button type="button" class="kebab icon-button" aria-label="Manage ${esc(t.name)} track" ${nameTip} ${UIAction('trackMenu', UIAction.event, t.id)}>${I.kebab}</button>
      </div>` : ''}</div>
      ${figure ? `<p class="lane-figure">${figure}</p>` : ''}
    </div>
    <div class="lane-body rt-body" role="group" aria-label="${esc(`${t.name} timeline`)}" style="min-height:${laid.height}px">${body}</div>
  </section>`;
}

export function renderRoadmap() {
  // A scale change still easing finishes first, so the new Roadmap starts at its zoom.
  roadmapGestureCleanup();
  const stacked = stackedLayout();
  RAIL = stacked ? 0 : 216;
  const model = roadmapModel(), ppd = state.pxPerDay;
  const width = document.querySelector('.content')?.clientWidth || window.innerWidth;
  const layout = roadmapLayout(model, ppd);
  renderedRoadmap = { model, layout };
  const lanes = model.lanes.map((lane, i) => laneHtml(lane, layout.lanes[i], ppd, model, stacked, width)).join('');

  // Milestones: a card with the shiny diamond above the lanes, and a line from the card down through them.
  let lines = '', cards = '';
  model.goals.forEach((goal) => {
    const { m, past, name, dateLabel, width: cardWidth, pole, compact, at } = goal, x = dayX(at, ppd);
    lines += `<div class="ms-line${past ? ' past' : ''}" aria-hidden="true" style="left:${RAIL + x}px"></div>`;
    cards += `<div class="ms-line goal-connector${past ? ' past' : ''}" aria-hidden="true" style="left:${x}px;top:${CARD_TOP + CARD_H}px;bottom:0"></div>`;
    cards += `<button type="button" class="ms-label rt-card${past ? ' past' : ''}" data-milestone="${esc(m.id)}" data-flag="${esc(numbers(x, cardWidth, pole, compact))}" aria-label="${esc(`Milestone ${name}, ${dateLabel}`)}" style="left:${cardLeft(goal, ppd)}px;top:${CARD_TOP}px;width:${cardWidth}px" ${UIAction('milestoneClick', UIAction.event, m.id)} ${UIAction.on('mouseenter', 'milestoneHover', UIAction.event, m.id)} ${UIAction.on('mouseleave', 'epicLeave')} ${UIAction.on('focus', 'milestoneHover', UIAction.event, m.id, true)} ${UIAction.on('blur', 'epicLeave')} ${UIAction.on('keydown', 'roadmapTipKey', UIAction.event)}>
      ${I.diamond}<span class="txt"><span class="goal-name">${esc(name)}</span><span class="goal-date">${esc(dateLabel)}</span></span></button>`;
  });
  const todayX = dayX(model.today, ppd), top = labelTop(model);
  const todayLine = `<div class="today-line" aria-hidden="true" style="left:${RAIL + todayX}px"></div>`;
  const todayLabel = `<div class="today-line today-connector" aria-hidden="true" style="left:${todayX}px;top:${top + LABEL_H}px;bottom:0"></div><div class="rt-today" style="left:${todayX}px;top:${top}px" title="${esc(human(today))}">Today<span class="sr-only">, ${esc(human(today))}</span></div>`;

  // Calendar cells are day offsets that their container's --ppd scales.
  const calendar = `--ppd:${ppd}`;
  const trackHead = stacked ? '' : `<div class="rail-cell rm-track-head" style="width:${RAIL}px"></div>`;
  // A track is added from the row that ends the lanes.
  const addTrack = canRoadmap() ? `<div class="rt-add-track"><div class="rail-cell" style="width:${stacked ? `${width}px` : `${RAIL}px`}"><button class="btn quiet" type="button" ${UIAction('openModal', 'track')}>${I.plus}<span>Add track</span></button></div></div>` : '';
  return `<div class="rm-scroll${stacked ? ' rt-stacked' : ''}" id="rmScroll" role="region" aria-label="Roadmap timeline" data-range-start="${esc(+model.start)}" style="--rm-rail:${RAIL}px">
    <div class="rm-canvas" style="width:${RAIL + dayX(model.span, ppd)}px">
      <div class="rm-axis" style="height:${axisHeight(model)}px">
        ${trackHead}
        <div class="rm-axis-labels">${cards}${todayLabel}<div class="rm-month-grid rt-axis-dates" style="${calendar}"></div><div class="rt-axis-pin" aria-hidden="true"></div></div>
      </div>
      <div class="rt-lanes">
        <span class="rm-calendar-lines" style="${calendar}"></span>${todayLine}${lines}${lanes}
        ${model.lanes.length ? '' : '<div class="rm-empty">No tracks yet.</div>'}
      </div>
      ${addTrack}
    </div>
  </div>`;
}

/** The track move the server has not answered yet. The Roadmap takes one move at a time. */
let pendingMove = null;
export const roadmapMovePending = () => !!pendingMove;

// Scroll a lane's head into the Roadmap's view, below its sticky date axis.
function revealLane(lane) {
  const scroll = document.getElementById('rmScroll'), head = lane?.querySelector('.lane-head');
  if (!scroll || !head) return;
  const view = scroll.getBoundingClientRect(), top = view.top + (scroll.querySelector('.rm-axis')?.offsetHeight || 0), box = head.getBoundingClientRect();
  if (box.top < top) scroll.scrollTop -= top - box.top;
  else if (box.bottom > view.bottom) scroll.scrollTop += Math.min(box.bottom - view.bottom, box.top - top);
}

function focusMovedTrack(id) {
  const lane = [...document.querySelectorAll('.lane[data-track]')].find(el=>el.dataset.track===id);
  revealLane(lane);
  lane?.querySelector('.grip')?.focus({preventScroll:true});
}

/** Show track `id` at `position` at once, then save the move. */
function moveTrack(id, position) {
  if (!App.require('manage_roadmap') || pendingMove) return;
  const list = tracks(), index = list.findIndex(track=>track.id===id);
  if (index < 0) return;
  const to = Math.max(0, Math.min(list.length-1, position));
  if (to === index) return;
  const original=[...list],originalOrders=new Map(original.map((item)=>[item,item.order]));
  const moved = list.splice(index, 1)[0];
  list.splice(to, 0, moved);
  list.forEach((t, i) => { t.order = i; });
  App.refreshRoadmap(id);
  announce(`${moved.name} moved to position ${to+1} of ${list.length}`);
  const pending={};pendingMove=pending;const revision=moved.revision,projectId=moved.projectId,session=sessionKey(D),optimisticOrders=new Map(original.map((item)=>[item,item.order]));
  runtime().moveTrack({trackId:id,position:to,optimistic:true}).catch((error)=>{
    const sameSession=session===sessionKey(D);
    if(!error?.uncertain&&sameSession&&D.tracks.includes(moved)&&moved.revision===revision){for(const [item,order] of originalOrders)if(D.tracks.includes(item)&&item.order===optimisticOrders.get(item))item.order=order;if(state.view==='roadmap'&&state.projectId===projectId)App.refreshRoadmap();}
    report(error);
  }).finally(()=>{if(pendingMove===pending)pendingMove=null;});
}

// A track moves by its grip, with the pointer or the arrow keys, Home and End.
sortable({
  grip: '#app .lane[data-track] .grip', row: '.lane[data-track]', list: '.rm-scroll', scroll: '.rm-scroll',
  label: (row) => trackById(row.dataset.track)?.name ?? '',
  // Tracks move one at a time: while the last move saves, a press on a grip says so.
  ready: () => {
    if (!canRoadmap()) return false;
    if (pendingMove) App.toast('The last track move is still saving.', 'info');
    return !pendingMove;
  },
  move: (grip, target, after) => {
    const id = grip.closest('.lane').dataset.track;
    const index = tracks().filter((track) => track.id !== id).findIndex((track) => track.id === target.dataset.track);
    if (index >= 0) moveTrack(id, index + (after ? 1 : 0));
  },
});

// ---------- epic drawer ----------
const actFeed = (list, limit) => (list || []).slice(-(limit || 8)).reverse().map((a) =>
  `<div class="act-row"><span class="act-dot"></span><span class="act-text"><b>${esc(userById(a.who)?.name||a.actorName||a.who)}</b> ${esc(a.text.replace(/[؜‎‏‪-‮⁦-⁩]/g,''))}</span><time class="act-time" datetime="${new Date(a.ts).toISOString()}" aria-label="${formatInstant(a.ts)}" data-tip="${esc(formatInstant(a.ts))}">${ago(a.ts)}</time></div>`).join('')
  || '<div class="empty-note inline">nothing yet</div>';

function sparkline(weekly) {
  const max = Math.max(1,...weekly);
  const bars = weekly.map((v, i) => {
    const h = Math.max(Math.round((v / max) * 24), 4);
    const fill = i >= weekly.length - 2 ? 'var(--run)' : 'rgb(var(--tone-rgb) / 0.14)';
    return `<rect x="${i * 13}" y="${26 - h}" width="9" height="${h}" rx="1.5" fill="${fill}"/>`;
  }).join('');
  return `<svg width="${weekly.length * 13 - 4}" height="26" viewBox="0 0 ${weekly.length * 13 - 4} 26">${bars}</svg>`;
}

export function renderPeek() {
  const e = epicById(state.peek);
  if (!e) return '';
  const t = trackById(e.trackId);
  const page=D.epicPageInfo?.[e.id];
  const eTasks = page?.loaded?page.taskIds.map(taskById).filter(Boolean):tasks().filter((x) => x.epicId === e.id);
  const order = { progress: 0, review: 1, planning: 2, done: 3 };
  eTasks.sort((a, b) => order[a.state] - order[b.state] || Number(a.id.slice(a.id.lastIndexOf('-')+1)) - Number(b.id.slice(b.id.lastIndexOf('-')+1)));
  const stateColor = { done: 'var(--ok)', review: 'var(--review)', progress: 'var(--run)', planning: 'var(--ink-faint)' };
  const stateBits = (x) => [stIcon(x.state), `<span style="color:${stateColor[x.state]}">${STATUS[x.state].toLowerCase()}</span>`];
  const rows = eTasks.map((x) => {
    const [dot, m] = stateBits(x);
    return `<div class="task-row">${dot}<span class="tid">${esc(x.id)}</span><span class="tt" data-tip="${esc(x.title)}" data-tip-overflow>${esc(x.title)}</span><span class="tm">${m}</span></div>`;
  }).join('') || '<div class="empty-note peek-empty">no tasks yet</div>';

  // An epic without an end date shows how its work goes week by week; one with an end date, how far it is.
  const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
  const midBlock = e.counted === false ? '' : !e.end && e.weekly
    ? `<div class="peek-throughput" data-epic-throughput>${sparkline(e.weekly)}
        <div><div class="mono subtle tone-soft">${e.closedThisWeek} closed this week</div>
        <div class="mono subtle">${e.completedSinceStart ?? e.done} since ${humanShort(d(e.start))} · ${e.open ?? e.total - e.done} open</div></div></div>`
    : e.total ? `<div class="peek-progress">
        <div class="peek-progress-track"><div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${e.state === 'done' ? 'var(--ok)' : 'var(--run)'}"></div></div>
        <div class="mono subtle tone-faint peek-progress-label">${e.done} of ${e.total} tasks complete · ${pct}%</div></div>` : '';

  return `<div class="scrim" ${UIAction('closeOverlays')}></div>
  <aside class="peek" role="dialog" aria-modal="true" aria-labelledby="peek-title">
    <div class="peek-head">
      <div class="peek-heading">
        <span class="mono subtle peek-track">${esc(t ? t.name : '')}</span>
        <button type="button" class="btn icon" aria-label="Close epic" ${UIAction('closeOverlays')}>${I.close}</button>
      </div>
      <h2 id="peek-title" class="peek-title">${esc(e.title)}</h2>
      <div class="peek-meta">
        <span class="chip idle">${esc(epicStatus(e))}</span>
        <span class="mono subtle tone-faint">${e.end ? `${humanShort(d(e.start))} → ${humanShort(d(e.end))}` : `From ${humanShort(d(e.start))}`}</span>
      </div>
    </div>
    <div class="peek-body">
    ${midBlock}
    ${e.desc ? descriptionReadHtml(e.desc,'epic-description-'+e.id) : ''}
    <div class="peek-section-head">
      <div class="peek-section-title"><span class="peek-label">Tasks</span><span class="mono subtle" data-epic-task-total>${page?.loaded?page.tasksTotal:eTasks.length}</span></div>
    </div>
    <div class="peek-rows">${rows}${page?.tasksCursor?`<button class="btn quiet" ${UIAction('loadMoreEpicTasks', e.id)}>Load more tasks</button>`:''}
      <div class="peek-label peek-activity-label">Activity</div>
      ${actFeed(e.activity, page?.loaded?Number.MAX_SAFE_INTEGER:8)}
      ${page?.activityCursor?`<button class="btn quiet" ${UIAction('loadMoreEpicActivity', e.id)}>Load older activity</button>`:''}
    </div>
    </div>
    <div class="peek-actions">
      ${canBoard() && e.state !== 'done' ? `<button class="btn" ${UIAction('openModal', 'task', '', e.id)}>${I.plus} New task</button>` : ''}
      ${canRoadmap() ? `${e.state === 'done'
        ? `<button class="btn" ${UIAction('reopenEpic', e.id)}>Reopen</button>`
        : `<button class="btn" ${UIAction('closeEpic', e.id)}>Mark as done</button>`}
      <button class="btn" ${UIAction('openModal', 'epic', e.id)}>Edit epic</button>
      <button class="btn danger" ${UIAction('deleteEpic', e.id)}>Delete</button>` : canBoard() ? '' : '<span class="access-note">Read only</span>'}
    </div>
  </aside>`;
}

function refreshEpicSummary() {
  if (!state.peek) return;
  const old = document.querySelector('[data-epic-throughput]');
  if (!old) return;
  const template = document.createElement('template'); setHTML(template,renderPeek());
  const next = template.content.querySelector('[data-epic-throughput]');
  if (next) old.replaceWith(next);
}

// ---------- page header ----------
/** The project's late tasks the lanes show, the longest overdue first: what "Overdue N" steps through. */
const lateTasks = () => {
  const ids = new Set(roadmapLanes()?.taskIds ?? []);
  return tasks().filter((task) => ids.has(task.internalId) && isLate(task)).sort((a, b) => d(a.deadline) - d(b.deadline) || a.id.localeCompare(b.id));
};
/** The late task "Overdue N" showed last, so the next press shows the next one. */
let overdueShown = null;

/** The Roadmap's one figure: what is overdue, when anything is. Each track's head says what it has in progress. */
function roadmapStatsHtml() {
  const late = roadmapLanes()?.overdue ?? 0;
  return `<span class="roadmap-structure-stats">${late ? `<button type="button" class="roadmap-stat rt-stat-late" aria-label="${esc(`Overdue: ${late} ${late === 1 ? 'task' : 'tasks'}. Show ${late === 1 ? 'it' : 'the next one'}`)}" ${UIAction('focusOverdue')}><span>Overdue</span><strong>${late}</strong></button>` : ''}</span>`;
}

/** The Roadmap's page header: what is overdue, the scale, Today and the add buttons. */
export function roadmapTopbarHtml() {
  return `<h1 class="roadmap-title">Roadmap</h1><div class="roadmap-meta" role="group" aria-label="Roadmap summary">${roadmapStatsHtml()}</div>
  <div class="right">
    ${roadmapScaleHtml()}
    <button class="btn quiet" ${UIAction('goToday')}>Today</button>
    ${canRoadmap() ? `<button class="btn roadmap-milestone" data-tip="Milestone" data-tip-overflow ${UIAction('openModal', 'milestone')}><span class="ms-diamond"></span><span class="btn-label">Milestone</span></button>
    <button class="btn primary" ${UIAction('openModal', 'epic')}>${I.plus} Epic</button>` : '<span class="read-only-pill">read only</span>'}
  </div>`;
}

// ---------- roadmap mount: scroll + zoom ----------
/**
 * Returns the mounted Roadmap: what was rendered, the elements a zoom step
 * moves, and the calendar window currently in the DOM.
 */
function bindRoadmap(sc, rendered) {
  const all = (selector) => [...sc.querySelectorAll(selector)];
  const lines = all('.rt-lanes > .ms-line'), connectors = all('.goal-connector'), labels = all('.ms-label');
  const laneEls = all('.lane');
  return {
    sc, canvas: sc.querySelector('.rm-canvas'), ...rendered, ppd: rendered.layout.ppd, calendar: null, zoomLeft: NaN,
    lanes: rendered.model.lanes.map((lane, i) => ({ lane: laneEls[i], body: laneEls[i]?.querySelector('.rt-body'), data: lane })),
    goals: rendered.model.goals.map((goal, i) => ({ goal, line: lines[i], connector: connectors[i], label: labels[i] })).filter((goal) => goal.line && goal.connector && goal.label),
    today: [sc.querySelector('.rt-lanes > .today-line'), sc.querySelector('.today-connector'), sc.querySelector(".rt-today")],
    cells: { lines: sc.querySelector('.rm-calendar-lines'), months: sc.querySelector('.rm-month-grid') },
  };
}

/** Draw each lane's marks for the view's zoom. Focus stays on the same task: on its own mark, or the count it merged into. */
function drawLanes(view) {
  if (!view.model.ready) return;
  const active = document.activeElement;
  const focusedLane = active && view.sc.contains(active) && active.closest('.rt-body') ? active.closest('.lane') : null;
  view.lanes.forEach(({ lane, body, data }, i) => {
    if (!body) return;
    const laid = view.layout.lanes[i], focus = laneEntry(laid, lane === focusedLane ? active.dataset.nav : laneFocus.get(data.track.id));
    body.style.minHeight = `${laid.height}px`;
    setHTML(body, laneBodyHtml(data, laid, view.ppd, view.model.today, focus));
    if (lane === focusedLane && focus) [...body.querySelectorAll('[data-nav]')].find((el) => el.dataset.nav === focus)?.focus({ preventScroll: true });
  });
}

/**
 * One zoom step: move the axis, lines and cards for `ppd`, draw the lanes'
 * marks again, and keep `day` at `cx` pixels from the scroller's left edge.
 */
function zoomRoadmap(view, ppd, day, cx) {
  const { sc, model } = view;
  if (ppd !== view.ppd) {
    view.ppd = state.pxPerDay = ppd;
    view.canvas.style.width = `${RAIL + dayX(model.span, ppd)}px`;
    for (const { goal, line, connector, label } of view.goals) {
      const x = dayX(goal.at, ppd);
      line.style.left = `${RAIL + x}px`;
      connector.style.left = `${x}px`;
      label.style.left = `${cardLeft(goal, ppd)}px`;
      label.dataset.flag = numbers(x, goal.width, goal.pole, goal.compact);
    }
    const [line, connector, pill] = view.today, todayX = dayX(model.today, ppd);
    if (line) line.style.left = `${RAIL + todayX}px`;
    for (const el of [connector, pill]) if (el) el.style.left = `${todayX}px`;
    for (const el of Object.values(view.cells)) el?.style.setProperty('--ppd', String(ppd));
    view.layout = roadmapLayout(model, ppd);
    drawLanes(view);
    syncRoadmapScale();
  }
  const left = Math.max(0, RAIL + day * ppd - cx);
  if (Math.abs(sc.scrollLeft - left) >= 0.5) sc.scrollLeft = left;
  state.rmScrollLeft = view.zoomLeft = sc.scrollLeft;
  mountRoadmapCalendar(view);
}

/** The scale the header shows as pressed; after a free zoom, none. */
let pressedScale = null;

function roadmapScaleHtml() {
  pressedScale = roadmapScale()?.key ?? null;
  return `<div class="seg roadmap-scale" role="group" aria-label="Timeline scale">${ROADMAP_SCALES.map((scale) => `<button type="button" data-scale="${esc(scale.key)}" class="${pressedScale === scale.key ? 'on' : ''}" aria-pressed="${pressedScale === scale.key}" aria-keyshortcuts="${esc(scale.shortcut)}" ${UIAction('setRoadmapScale', scale.key)}>${scale.label}</button>`).join('')}</div>`;
}

/** Show the zoom's scale as pressed in the header, and a picked scale in the address. */
function syncRoadmapScale() {
  // A zoom step can run after Back or a link moved the tab to another page: that address stays.
  if (pageOf(location.hash) === projectAddress('roadmap', state.projectId)) App.replaceAddress();
  const current = roadmapScale()?.key ?? null;
  if (current === pressedScale) return;
  pressedScale = current;
  document.querySelectorAll('.roadmap-scale [data-scale]').forEach((button) => {
    const on = button.dataset.scale === current;
    button.setAttribute('aria-pressed', String(on)); button.classList.toggle('on', on);
  });
}

/** The scale the Roadmap's address names: the one nearest a zoom the person picked, or none while it fits the work. */
export function roadmapAddressScale() {
  return picked ? nearestScale(state.pxPerDay).key : null;
}

/**
 * Show the scale an address names. One the Roadmap doesn't have, or none,
 * fits the work again when a scale was picked. Another scale starts at
 * today, since a scroll position belongs to its zoom; a free zoom nearest
 * the named scale stays, as after Back.
 */
export function showRoadmapScale(key) {
  const scale = ROADMAP_SCALES.find((item) => item.key === key);
  if (!scale) { if (picked) { resetRoadmapScale(); state.rmScrollLeft = null; } return; }
  picked = true;
  if (nearestScale(state.pxPerDay) === scale) return;
  state.pxPerDay = scale.ppd; state.rmScrollLeft = null;
}

/** Forget the picked scale, so the Roadmap fits the work again, as for another project or the next person to sign in here. */
export function resetRoadmapScale() { picked = false; fitted = null; }

/** The day under the item last focused or opened, while it shows in the view, or null. */
function selectedDay(view) {
  if (!roadmapSelection) return null;
  const el = [...view.sc.querySelectorAll('.rt-body [data-nav]')].find((item) => item.dataset.nav === roadmapSelection);
  if (!el?.isConnected) return null;
  const shown = el.getBoundingClientRect(), port = view.sc.getBoundingClientRect();
  if (!(shown.right > port.left + RAIL && shown.left < port.right && shown.bottom > port.top + axisHeight(view.model) && shown.top < port.bottom)) return null;
  // A bar or an epic from its start, other marks from their middle, read from where they were placed.
  const placed = el.closest('.rt-epic') ?? el, start = placed !== el || el.classList.contains('rt-bar');
  return (parseFloat(placed.style.left) + (start ? 0 : (parseFloat(placed.style.width) || 20) / 2)) / view.ppd;
}

/**
 * What a scale change keeps in place: the selected task or epic while it
 * shows, else today while it shows, else the date in the middle of the view.
 * Returns the day and its distance from the scroller's left edge.
 */
function scaleAnchor(view) {
  const { sc, model } = view, width = sc.clientWidth, room = width - RAIL;
  const x = (day) => RAIL + day * view.ppd - sc.scrollLeft;
  const margin = Math.min(80, room / 4), inside = (cx) => Math.min(Math.max(cx, RAIL + margin), width - margin);
  const selected = selectedDay(view);
  if (selected !== null) return { day: selected, cx: inside(x(selected)) };
  const now = x(model.today);
  if (now >= RAIL && now <= width) return { day: model.today, cx: now };
  const cx = RAIL + room / 2;
  return { day: (sc.scrollLeft + cx - RAIL) / view.ppd, cx };
}

const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', month:'short' });

/**
 * Month labels and lines cover the visible dates plus one view of overscan
 * each way, so the DOM stays bounded at every zoom level. From WEEK_AXIS_PPD
 * the axis labels each week with its Monday's date instead of each month;
 * only months draw lines through the lanes. The cells follow --ppd, so this
 * redraws them only when the view nears the window's edge, the window
 * becomes much wider than needed or passes the end of the range, a partial
 * month at either end gains or loses its label, or the axis changes between
 * months and weeks.
 */
function mountRoadmapCalendar(view) {
  const { sc, model, ppd } = view, start = model.start, width = sc.clientWidth || window.innerWidth;
  const end = Math.max(model.span, (width - RAIL) / ppd);
  const day = (dt) => (dt - start) / DAY;
  const labeled = (from, to) => Math.round(to * ppd) - Math.round(from * ppd) > 46;
  const weeks = ppd >= WEEK_AXIS_PPD;
  const startMonth = new Date(start); startMonth.setUTCDate(1); startMonth.setUTCMonth(startMonth.getUTCMonth() + 1);
  const endMonth = new Date(+start + end * DAY); endMonth.setUTCDate(1); endMonth.setUTCHours(0, 0, 0, 0);
  const labels = `${weeks}:${labeled(0, Math.min(day(startMonth), end))}:${labeled(Math.max(day(endMonth), 0), end)}`;
  const margin = width / 2 / ppd;
  const need = { from: Math.max(0, sc.scrollLeft / ppd - margin), to: Math.min(end, (sc.scrollLeft + width - RAIL) / ppd + margin) };
  const shown = view.calendar;
  if (shown && shown.from <= need.from && shown.to >= need.to && shown.to <= end && shown.to - shown.from <= 4 * (width + RAIL) / ppd + 62 && shown.labels === labels) { syncEdges(view); return; }
  const first = new Date(+start + Math.max(0, (sc.scrollLeft - width - RAIL) / ppd) * DAY);
  first.setUTCDate(1); first.setUTCHours(0, 0, 0, 0);
  const last = Math.min(end, (sc.scrollLeft + width * 2) / ppd);
  let dates = '', lines = '', dividers = '', covered = Math.max(0, day(first));
  for (const m = new Date(first); day(m) < last; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const next = new Date(m); next.setUTCMonth(next.getUTCMonth() + 1);
    const from = Math.max(day(m), 0), to = Math.min(day(next), end);
    // The full year, so a month never reads like a date ("Aug 26").
    const label = monthFormatter.format(m) + (m.getUTCMonth() === 0 || +m === +first ? ' ' + m.getUTCFullYear() : '');
    if (!weeks && labeled(from, to)) dates += `<div class="rm-month" data-at="${esc(String(from))}" data-w="${esc(numbers(textWidth(label, '500 12px') + 4))}" style="--d:${from};--n:${to - from}">${label}</div>`;
    if (day(next) < end) {
      lines += `<div class="rm-month-line" aria-hidden="true" style="--d:${day(next)}"></div>`;
      if (!weeks) dividers += `<div class="rm-axis-divider" aria-hidden="true" style="--d:${day(next)}"></div>`;
    }
    covered = to;
  }
  // Each week starts on a Monday, labeled with its day; the first week of a month also names the month.
  if (weeks) for (const monday = new Date(+first + ((8 - first.getUTCDay()) % 7) * DAY); day(monday) < Math.min(last, end); monday.setUTCDate(monday.getUTCDate() + 7)) {
    const at = day(monday);
    if (at <= 0) continue;
    const opens = monday.getUTCDate() <= 7, text = opens ? humanShort(monday) : String(monday.getUTCDate());
    dividers += `<div class="rm-axis-divider" aria-hidden="true" style="--d:${at}"></div>`;
    dates += `<div class="rm-week${opens ? ' rt-month-start' : ''}" data-at="${esc(String(at))}" data-w="${esc(numbers(textWidth(text, '500 12px') * 1.06 + 4))}" style="--d:${at}">${text}</div>`;
  }
  view.calendar = { from: Math.max(0, day(first)), to: covered, labels };
  setHTML(view.cells.lines, lines);
  setHTML(view.cells.months, dividers + dates);
  syncEdges(view);
}

/**
 * Milestone cards' places: each card's diamond always sits on its line, so
 * the line drops straight from it. From the best: the card starting at the
 * line, ending at it (the diamond at the card's right), or the diamond
 * alone, which opens to the full card on hover and focus.
 */
const CARD_PLACES = [['start', 0], ['end', 1], ['compact', 10]];

/**
 * Milestone cards, in their own row above Today: each takes its best place
 * clear of the others and the view's edges, and never hides; where nothing
 * is clear it shows its diamond alone. With none in view, the next one waits
 * at the right edge and points to it.
 */
function placeCards(sc, from, to) {
  const pairs = (value) => value.split(',').map(Number);
  const cards = [...sc.querySelectorAll('[data-flag]')].map((flag) => {
    const [x, width, pole, compact] = pairs(flag.dataset.flag);
    const places = CARD_PLACES.map(([form, cost]) => {
      const size = form === 'compact' ? compact : width;
      const left = form === 'start' ? x - pole : form === 'end' ? x + pole - size : x - size / 2;
      return { form, cost, width: size, left, right: left + size };
    });
    return { flag, x, places };
  }).sort((a, b) => a.x - b.x);
  const shown = cards.map(({ x }) => x >= from && x <= to);
  // The best places together: a card that keeps its words may cost a neighbour its place, so a view with a
  // few milestones tries every combination; one crowded with them takes each first free place.
  const greedy = shown.filter(Boolean).length > 6;
  let best = null;
  const search = (index, taken, chosen, score) => {
    if (best && score >= best.score) return;
    if (index === cards.length) { best = { score, chosen: chosen.slice() }; return; }
    const free = shown[index] ? cards[index].places.filter((option) => option.left >= from && option.right <= to && taken.every(([a, b]) => option.right + 8 <= a || option.left - 8 >= b)) : [];
    for (const option of greedy ? free.slice(0, 1) : free) {
      chosen.push(option); taken.push([option.left, option.right]);
      search(index + 1, taken, chosen, score + option.cost);
      chosen.pop(); taken.pop();
    }
    if (greedy && free.length) return;
    chosen.push(shown[index] ? cards[index].places.find((option) => option.form === 'compact') : null);
    search(index + 1, taken, chosen, score + (shown[index] ? 100 : 0)); chosen.pop();
  };
  search(0, [], [], 0);
  const upcoming = shown.some(Boolean) ? -1 : cards.findIndex(({ flag, x }) => x > to && !flag.classList.contains('past'));
  cards.forEach(({ flag, places }, index) => {
    const edge = index === upcoming, place = edge ? { form: 'edge', width: places[0].width + 20, left: to - places[0].width - 20 } : best.chosen[index] || places[0];
    flag.classList.toggle('rt-card-end', place.form === 'end');
    flag.classList.toggle('rt-card-compact', place.form === 'compact');
    flag.classList.toggle('rt-card-edge', edge);
    setStyle(flag, 'left', `${Math.round(place.left)}px`);
    setStyle(flag, 'width', `${Math.round(place.width)}px`);
    flag.classList.toggle('rt-cut', !shown[index] && !edge);
  });
}

/**
 * Fit what the view's edges would cut: the month at the left edge stays
 * named, pinned there, and the dates under it hide; milestone cards take
 * their places; the lanes' titles and epic headers follow (timeline.js).
 * Dates are placed from the zoom, so they are right the moment a zoom lands.
 */
function syncEdges(view) {
  const { sc } = view, ppd = state.pxPerDay;
  const from = sc.scrollLeft + 2, to = sc.scrollLeft + sc.clientWidth - RAIL - 2;
  const pin = sc.querySelector('.rt-axis-pin');
  let pinned = from;
  if (pin) {
    const start = Number(sc.dataset.rangeStart), day = new Date(start + (sc.scrollLeft / ppd) * DAY);
    const name = (date) => date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', ...(date.getUTCFullYear() !== today.getUTCFullYear() ? { year: 'numeric' } : {}) });
    // When the next month starts within the pin's width, the pin names it already, so no month loses its name.
    const next = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1));
    const nextX = ((+next - start) / DAY) * ppd - sc.scrollLeft;
    const month = nextX < textWidth(name(day), '500 12px') + 32 ? name(next) : name(day);
    if (pin.textContent !== month) pin.textContent = month;
    setStyle(pin, 'left', `${sc.scrollLeft}px`);
    pinned = sc.scrollLeft + textWidth(month, '500 12px') + 24;
  }
  for (const label of sc.querySelectorAll('.rt-axis-dates [data-at]')) {
    const left = Math.round(Number(label.dataset.at) * ppd) + 8;
    label.classList.toggle('rt-cut', left < pinned || left + Number(label.dataset.w) > to);
  }
  placeCards(sc, from, to);
  syncLaneEdges(sc, RAIL);
}

let roadmapGestureCleanup = () => {};
/** The Roadmap on the page, which a scale change zooms. */
let mountedRoadmap = null;

/**
 * The scroll that puts now at TODAY_AT of the visible timeline when dated
 * work lies ahead; with nothing dated ahead, as far right as leaves the room
 * after now (`reserve`), so the done work and the work in progress get the rest.
 */
function todayScroll(sc, now, ppd, { reserve = 0, ahead = true } = {}) {
  const room = (sc ? sc.clientWidth : 900) - RAIL, share = room * (stackedLayout() ? TODAY_AT_PHONE : TODAY_AT);
  const at = ahead ? Math.min(share, room - reserve) : room - reserve;
  return Math.max(Math.round(now * ppd - at), 0);
}
/**
 * The scroll that shows a window of days, with a little room before it and
 * after it. Titles run to the right of their marks, so the window reaches to
 * the end of the last one that starts in it, while that still fits. With
 * nothing dated ahead, the window ends just after now, and most of the room
 * to spare goes to the work before it.
 */
function windowScroll(sc, { from, to }, ppd, { reserve, ahead }, now) {
  const room = sc.clientWidth - RAIL, left = from * ppd;
  let right = Math.max(to * ppd, now * ppd + reserve);
  for (const tag of sc.querySelectorAll('.rt-body [data-tag]')) {
    const [start, end] = tag.dataset.tag.split(',').map(Number);
    if (start >= left && start <= right + 24 && end > right && end - left + 48 <= room) right = end;
  }
  const spare = Math.max(0, room - (right - left));
  return Math.max(Math.round(ahead ? left - Math.max(48, spare * 0.3) : right - room + spare * 0.3), 0);
}

/** The pages of dated plans or done tasks that failed to load for these lanes, which a scroll doesn't ask for again. */
const failedPages = new WeakMap();
/**
 * Ask for the next page of done tasks while the view, with one view to
 * spare, reaches before the history the lanes have, and for the next page of
 * dated plans while it reaches past the last plan they have.
 */
function loadMore(view) {
  const lanes = roadmapLanes();
  if (!lanes || !view.model.ready) return;
  const { sc, model, ppd } = view, spare = sc.clientWidth / ppd;
  const from = sc.scrollLeft / ppd - spare, to = (sc.scrollLeft + sc.clientWidth - RAIL) / ppd + spare;
  const failed = failedPages.get(lanes) ?? new Set();
  for (const [kind, needed] of [['done', from < model.historyFrom], ['plans', to > model.plansUntil]]) {
    const cursor = lanes[kind].cursor;
    if (!needed || !cursor || failed.has(cursor)) continue;
    runtime().moreRoadmap(kind).catch((error) => { failed.add(cursor); failedPages.set(lanes, failed); report(error); });
  }
}

export function mountRoadmap() {
  roadmapGestureCleanup();
  const sc = document.getElementById('rmScroll');
  if (!sc || !renderedRoadmap) return;
  const view = Object.assign(bindRoadmap(sc, renderedRoadmap), { zoomTo: (_ppd) => {} });
  mountedRoadmap = view;
  sc.addEventListener('focusin', (event) => { const item = event.target.closest?.('.rt-body [data-nav]'); if (item) roadmapSelection = item.dataset.nav; });
  const stopLanes = mountLanes(sc, RAIL);
  const place = { reserve: roomAfterNow(view.model, datedAhead(view.model)), ahead: datedAhead(view.model) };
  // A project the person picked no scale for opens at the scale that fits its work, with that work in view.
  if (!picked && fitted !== state.projectId && view.model.ready) {
    fitted = state.projectId;
    const fit = stackedLayout() ? { ppd: ROADMAP_SCALES[0].ppd, window: null } : fitScale(view.model, sc.clientWidth - RAIL, place.reserve);
    if (fit.ppd !== view.ppd) zoomRoadmap(view, fit.ppd, view.model.today, 0);
    state.rmScrollLeft = fit.window ? windowScroll(sc, fit.window, view.ppd, place, view.model.today) : todayScroll(sc, view.model.today, view.ppd, place);
  }
  if (state.rmScrollLeft === null) state.rmScrollLeft = todayScroll(sc, view.model.today, view.ppd, place);
  view.place = place;
  syncRoadmapScale();
  sc.scrollLeft = state.rmScrollLeft;
  sc.scrollTop = state.rmScrollTop;
  mountRoadmapCalendar(view);
  loadMore(view);
  /** The zoom gesture in progress. */
  let gesture = null;
  let scrollFrame = 0;
  sc.addEventListener('scroll', () => {
    state.rmScrollLeft = sc.scrollLeft; state.rmScrollTop = sc.scrollTop;
    // A scroll the zoom did not make, such as a touchpad pan during a
    // pinch, moves the content under the pointer: zoom around that day now.
    if (gesture && Math.abs(sc.scrollLeft - view.zoomLeft) > 1) { gesture.day = (sc.scrollLeft + gesture.cx - RAIL) / view.ppd; view.zoomLeft = sc.scrollLeft; }
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!sc.isConnected) return;
      mountRoadmapCalendar(view);
      loadMore(view);
    });
  }, {passive:true});
  // Zoom: input events update one gesture, and one frame applies it. A
  // gesture keeps the day under the pointer, or under the pinch center as it
  // moves, in place.
  let frame = 0, pointerX = NaN;
  let idle;
  const begin = (kind, clientX, left = sc.getBoundingClientRect().left) => {
    picked = true;
    stopScale(false);
    hideEpicTip(); closeTimelineList();
    const cx = clientX - left;
    view.zoomLeft = sc.scrollLeft;
    gesture = { kind, left, cx, day: (view.zoomLeft + cx - RAIL) / view.ppd, ppd0: view.ppd, log: 0, target: null, distance: 0, cy: 0, dy: 0 };
    return gesture;
  };
  const step = () => {
    frame = 0;
    const current = gesture;
    if (!current || !sc.isConnected) return;
    const ppd = clampZoom(current.target ?? view.ppd * Math.exp(current.log));
    current.log = 0;
    zoomRoadmap(view, ppd, current.day, current.cx);
    if (current.dy) { sc.scrollTop -= current.dy; current.dy = 0; }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(step); };
  function end() {
    clearTimeout(idle);
    if (frame) { cancelAnimationFrame(frame); step(); }
    gesture = null;
    sc.removeEventListener('touchmove', movePinch);
    loadMore(view);
  }
  sc.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (gesture && gesture.kind !== 'wheel') return;
    const current = gesture || begin('wheel', e.clientX), cx = e.clientX - current.left;
    // A pointer that moved between events zooms around the day now under it.
    if (cx !== current.cx) { current.day = (sc.scrollLeft + cx - RAIL) / view.ppd; current.cx = cx; }
    current.log += wheelZoom(e);
    schedule();
    clearTimeout(idle); idle = setTimeout(end, 120);
  }, {passive:false});
  const center = (touches) => ({ x:(touches[0].clientX + touches[1].clientX) / 2, y:(touches[0].clientY + touches[1].clientY) / 2 });
  const spread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  function movePinch(e) {
    if (gesture?.kind !== 'pinch' || e.touches.length !== 2) return;
    // A pinch that starts while a finger drags a grip gets moves the browser can no longer cancel.
    if (e.cancelable) e.preventDefault();
    const point = center(e.touches);
    gesture.target = gesture.ppd0 * spread(e.touches) / gesture.distance;
    gesture.cx = point.x - gesture.left;
    gesture.dy += point.y - gesture.cy; gesture.cy = point.y;
    schedule();
  }
  sc.addEventListener('touchstart', e => {
    if (e.touches.length !== 2 || !spread(e.touches) || gesture?.kind === 'pinch') return;
    if (gesture) end();
    const point = center(e.touches), current = begin('pinch', point.x);
    current.distance = spread(e.touches); current.cy = point.y;
    sc.addEventListener('touchmove', movePinch, {passive:false});
  }, {passive:true});
  const endPinch = (e) => { if (gesture?.kind === 'pinch' && e.touches.length < 2) end(); };
  sc.addEventListener('touchend', endPinch, {passive:true});
  sc.addEventListener('touchcancel', endPinch, {passive:true});
  // Safari reports a touchpad pinch as gesture events, not ctrl+wheel. On
  // touch screens, touch events already drive the pinch.
  sc.addEventListener('pointermove', e => { pointerX = e.clientX; }, {passive:true});
  const pinchGesture = (e) => {
    e.preventDefault();
    if (gesture?.kind === 'pinch') return;
    if (e.type === 'gesturestart') {
      if (gesture) end();
      const left = sc.getBoundingClientRect().left;
      begin('gesture', Number.isFinite(e.clientX) ? e.clientX : Number.isFinite(pointerX) ? pointerX : left + sc.clientWidth / 2, left);
      return;
    }
    if (gesture?.kind !== 'gesture') return;
    if (Number.isFinite(e.scale) && e.scale > 0) gesture.target = gesture.ppd0 * e.scale;
    if (Number.isFinite(e.clientX)) gesture.cx = e.clientX - gesture.left;
    schedule();
    if (e.type === 'gestureend') end();
  };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) sc.addEventListener(type, pinchGesture);

  // A scale change eases to its zoom in place, over a few frames like the
  // other short motions; a wheel or pinch takes over from wherever it is.
  let scaled = null;
  let scaleFrame = 0;
  function stopScale(finish = true) {
    if (scaleFrame) cancelAnimationFrame(scaleFrame);
    scaleFrame = 0;
    if (finish && scaled && sc.isConnected) zoomRoadmap(view, scaled.ppd, scaled.day, scaled.cx);
    scaled = null;
  }
  const stepScale = (time) => {
    scaleFrame = 0;
    if (!scaled || !sc.isConnected) return;
    scaled.started ??= time - 1000 / 60;
    const progress = Math.min(1, (time - scaled.started) / UIMotion.normal), eased = 1 - (1 - progress) ** 3;
    zoomRoadmap(view, progress < 1 ? clampZoom(scaled.from * Math.exp(Math.log(scaled.ppd / scaled.from) * eased)) : scaled.ppd, scaled.day, scaled.cx);
    if (progress < 1) scaleFrame = requestAnimationFrame(stepScale); else { scaled = null; loadMore(view); }
  };
  view.zoomTo = (ppd) => {
    if (gesture) end();
    stopScale();
    hideEpicTip(); closeTimelineList();
    const { day, cx } = scaleAnchor(view);
    if (UIMotion.reduced() || Math.abs(ppd - view.ppd) < 1e-3) { zoomRoadmap(view, ppd, day, cx); loadMore(view); return; }
    scaled = { ppd, day, cx, from: view.ppd, started: null };
    scaleFrame = requestAnimationFrame(stepScale);
  };
  roadmapGestureCleanup = () => {
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    stopLanes();
    clearTimeout(idle); if (frame) cancelAnimationFrame(frame);
    frame = 0; gesture = null; sc.removeEventListener('touchmove', movePinch);
    stopScale();
    if (mountedRoadmap === view) mountedRoadmap = null;
  };
}

document.addEventListener('scroll', (e) => { if (!EPIC_TIP.el?.contains(e.target)) hideEpicTip(); }, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && EPIC_TIP.el) { e.preventDefault(); e.stopImmediatePropagation(); hideEpicTip(); }
}, true);

// W, M and Q switch the Roadmap's scale while focus is on the Roadmap page,
// or on the page itself, as after a click on empty space or, in Safari, on a
// button. Not in a text field, a menu or a dialog: single-letter keys work
// only there, so they can't fire by accident elsewhere.
document.addEventListener('keydown', (event) => {
  if (state.view !== 'roadmap' || event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const scale = ROADMAP_SCALES.find((item) => item.shortcut === String(event.key).toUpperCase());
  const onPage = event.target === document.body || event.target === document.documentElement || event.target.closest?.('#main,.page-header');
  if (!scale || !onPage || event.target.closest('input,textarea,select,[contenteditable="true"]') || state.modal || state.peek || state.menu || state.sideOpen && innerWidth <= 900 || POP.el || pendingConfirmation || document.querySelector('.confirmation-layer,.file-overlay,#roadmap-list') || document.getElementById('app').inert) return;
  event.preventDefault();
  App.setRoadmapScale(scale.key);
  announce(`Roadmap scale: ${scale.label}`);
});

document.addEventListener('pointerdown', (e) => {
  if (EPIC_TIP.el && !EPIC_TIP.el.contains(e.target) && !EPIC_TIP.anchor?.contains(e.target)) hideEpicTip();
});

/** The Roadmap as it is now, drawn once when a press that delayed it ends. */
const refreshShownRoadmap = () => App.refreshRoadmap();

Object.assign(App, {
  refreshEpic() {
    if (!state.peek) return;
    const peek=document.querySelector('#overlay-root > .peek'),rows=peek?.querySelector('.peek-rows');
    if (!rows) return;
    const template=document.createElement('template');setHTML(template,renderPeek());
    const next=template.content.querySelector('.peek-rows');
    if (!next) return;
    const total=peek.querySelector('[data-epic-task-total]'),nextTotal=template.content.querySelector('[data-epic-task-total]');
    if(total&&nextTotal)total.textContent=nextTotal.textContent;
    const focus=rows.contains(document.activeElement)?rememberOpener(document.activeElement):null;
    const peekScroll=peek.scrollTop,rowsScroll=rows.scrollTop;
    rows.replaceWith(next);peek.scrollTop=peekScroll;next.scrollTop=rowsScroll;
    if (focus && !peek.inert && !document.querySelector('.confirmation-layer,.file-overlay')) restoreOpener(focus);
  },
  /**
   * Draw the Roadmap again in place: the same date stays at the left edge,
   * the focused control stays, and lanes slide to their new places. A track
   * moved here, `moved`, first comes into view with focus on its grip, so
   * its lane slides from where it showed instead of jumping.
   */
  refreshRoadmap(moved) {
    // A change from elsewhere waits for a press on the page to end, as on a
    // held grip: lanes drawn again under the pointer would drop the drag.
    if(!moved&&App.afterPress(refreshShownRoadmap))return;
    refreshEpicSummary();
    if(state.view!=='roadmap'){App.refreshBackground();return;}
    const content=document.querySelector('.content'),scroll=document.getElementById('rmScroll');
    if(!content||!scroll){App.refresh();return;}
    roadmapGestureCleanup();
    closeTimelineList();
    const before=UIMotion.positions('.lane'),top=scroll.scrollTop;
    // More done work can move day 0 earlier: the same date stays at the left edge, not the same pixels.
    const leftDay=scroll.scrollLeft/state.pxPerDay+Number(scroll.dataset.rangeStart)/DAY;
    const focus=content.contains(document.activeElement)?rememberOpener(document.activeElement):null;
    const nav=document.activeElement?.closest?.('.rt-body [data-nav]')?.dataset.nav;
    setHTML(content,renderRoadmap());
    const next=document.getElementById('rmScroll');
    if(next){state.rmScrollLeft=Math.max(0,Math.round((leftDay-Number(next.dataset.rangeStart)/DAY)*state.pxPerDay));state.rmScrollTop=top;}
    mountRoadmap();
    // The header counts what the lanes now show.
    const stats=document.querySelector('.topbar .roadmap-structure-stats'),counted=roadmapStatsHtml();
    if(stats&&stats.outerHTML!==counted){const template=document.createElement('template');setHTML(template,counted);stats.replaceWith(template.content);}
    if(moved)focusMovedTrack(moved);
    else if(nav)([...content.querySelectorAll('.rt-body [data-nav][tabindex="0"]')].find((el)=>el.dataset.nav===nav)||[...content.querySelectorAll('.rt-body [data-nav]')].find((el)=>el.dataset.nav===nav))?.focus({preventScroll:true});
    else if(focus)restoreOpener(focus);
    App.updateDocumentTitle();
    // Lanes slide up or down to their new places. Every lane shares its left edge, which a new scroll
    // position moves sideways at once, so that is no motion.
    const shift=(content.querySelector('.lane')?.getBoundingClientRect().left??0)-([...before.values()][0]?.left??0);
    UIMotion.layout(new Map([...before].map(([track,box])=>[track,{left:box.left+shift,top:box.top}])),'.lane');
    App.refreshCounts();
  },
  /** "Overdue N": focus the next late task on the timeline and show its card. */
  focusOverdue() {
    const sc = document.getElementById('rmScroll'), late = lateTasks();
    if (!sc || !late.length) return;
    const at = late.findIndex((task) => task.id === overdueShown);
    for (let step = 1; step <= late.length; step++) {
      const task = late[(at + step) % late.length];
      if (!focusTask(sc, task.id, RAIL)) continue;
      overdueShown = task.id;
      announce(`Overdue ${late.indexOf(task) + 1} of ${late.length}: ${task.title}`);
      return;
    }
  },
  /** Zoom the Roadmap to a fixed scale, in place, keeping the selected task or epic, or today, where it is. */
  setRoadmapScale(key) {
    const scale = ROADMAP_SCALES.find((item) => item.key === key);
    if (!scale) return;
    picked = true;
    if (state.view === 'roadmap' && mountedRoadmap?.sc.isConnected) { mountedRoadmap.zoomTo(scale.ppd); return; }
    state.pxPerDay = scale.ppd; syncRoadmapScale();
  },
  goToday() {
    const view = mountedRoadmap;
    if (!view?.sc.isConnected || state.view !== 'roadmap') { state.rmScrollLeft = null; App.refresh(); return; }
    // Scroll the mounted Roadmap in place; drawing the page again would only repeat it.
    view.sc.scrollLeft = state.rmScrollLeft = todayScroll(view.sc, view.model.today, view.ppd, view.place);
  },
  /** A milestone's card: at once on keyboard focus, after a short pause on hover. */
  milestoneHover(ev, id, keyboard = false) {
    if (!keyboard && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    hideEpicTip();
    const anchor = ev.currentTarget;
    if (keyboard) showMilestoneTip(anchor, id);
    else EPIC_TIP.showTimer = setTimeout(() => showMilestoneTip(anchor, id), 220);
  },
  milestoneClick(ev, id) {
    if (canRoadmap()) App.openModal('milestone', id);
    else showMilestoneTip(ev.currentTarget, id);
  },
  roadmapTipKey(ev) {
    const tip = EPIC_TIP.el;
    if (!tip || EPIC_TIP.anchor !== ev.currentTarget) return;
    const distance = { ArrowDown:40, ArrowUp:-40, PageDown:tip.clientHeight*.8, PageUp:-tip.clientHeight*.8 }[ev.key];
    if (distance !== undefined) { ev.preventDefault(); tip.scrollTop += distance; }
  },
  epicLeave() {
    clearTimeout(EPIC_TIP.showTimer); clearTimeout(EPIC_TIP.hideTimer);
    EPIC_TIP.hideTimer = setTimeout(hideEpicTip, 140);
  },
  openPeek(id) { if(!canReadProject(trackById(epicById(id)?.trackId)?.projectId)){App.toast('This project is unavailable','error');return;}if (state.peek !== id) peekOpened(); state.peek = id; roadmapSelection = `e:${id}`; App.refreshOverlays(); },
  trackMenu(ev, id) {
    ev.stopPropagation();
    if (!App.require('manage_roadmap')) return;
    // The grip moves a track; the menu only renames and deletes it.
    openMenu([
      { label: 'Rename track', fn: () => { state.modal = { type: 'track', id }; App.refreshOverlays(); } },
      { sep: true },
      { label: 'Delete track', danger: true, fn: () => App.deleteTrack(id) },
    ], 0, 0, {trigger:ev.currentTarget, trackId:id});
  },
});
