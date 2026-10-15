// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* The Roadmap: tracks, epics and milestones on a zoomable timeline, the epic
   drawer, and moving tracks. */

import { MOTION, animateLayout, motionRects, reducedMotion } from './effects.js';
import {
  DAY, I, STATUS, ago, d, esc, formatInstant, human, humanShort, setHTML, stIcon, today,
} from './format.js';
import { descriptionReadHtml } from './forms.js';
import {
  App, D, canReadProject, canRoadmap, epicById, epics, milestones, project, report, runtime,
  state, taskById, tasks, trackById, tracks, userById,
} from './model.js';
import {
  EPIC_TIP, POP, hideEpicTip, mountRoadmapTip, peekOpened, pendingConfirmation, rememberOpener,
  restoreOpener,
} from './overlays.js';
import { announce } from './toasts.js';

// ---------- roadmap geometry ----------
// The model holds dates as whole days from the range start; pixels are days
// times the zoom level (pixels per day). A zoom step rewrites the positions
// of the existing elements instead of rebuilding the Roadmap, and the same
// functions produce them for the render and for every step.
let RAIL = 208;
const AXIS = 70, MONTH_ROW = 32, BAR_H = 58, ROW_GAP = 8, LANE_PAD = 14, EPIC_GAP = 8, EPIC_MIN_WIDTH = 60, GOAL_ROW = 58;
const ZOOM_MIN = 2.2, ZOOM_MAX = 42;
/** Fixed scales of the timeline, in pixels per day. Months is the zoom a Roadmap opens at. */
const ROADMAP_SCALES = [
  { key: 'weeks', label: 'Weeks', ppd: 30, shortcut: 'W' },
  { key: 'months', label: 'Months', ppd: 8.5, shortcut: 'M' },
  { key: 'quarters', label: 'Quarters', ppd: 2.6, shortcut: 'Q' },
];
/** Closer to Weeks than to Months, the axis shows weeks instead of months: a week is 126 px or more. */
const WEEK_AXIS_PPD = 18;
const roadmapScale = () => ROADMAP_SCALES.find((scale) => Math.abs(scale.ppd - state.pxPerDay) < 0.005) || null;
/** The epic last focused or opened on the Roadmap, which a scale change keeps in view. */
let roadmapSelection = null;

/** The data's dates: `start` anchors day 0 and `end` is the last date the timeline must reach before it fills the view. */
function rmRange() {
  let min = today, max = new Date(today.getTime() + 60 * DAY);
  epics().forEach((e) => {
    // An ongoing epic's start also extends the range, or a late one would fall past the end.
    const s = d(e.start); if (s < min) min = s; if (s > max) max = s;
    if (e.end) { const en = d(e.end); if (en > max) max = en; }
  });
  milestones().forEach((m) => { const md = d(m.date); if (md < min) min = md; if (md > max) max = md; });
  return { start: new Date(min.getTime() - 10 * DAY), end: new Date(max.getTime() + 45 * DAY) };
}

/** The Roadmap's tracks, epics and milestones as day offsets; nothing here depends on the zoom level. */
function roadmapModel() {
  const { start, end } = rmRange();
  const day = (dt) => Math.round((dt - start) / DAY);
  const all = epics();
  const lanes = tracks().map((track) => ({
    track,
    epics: all.filter((e) => e.trackId === track.id).sort((a, b) => d(a.start) - d(b.start))
      .map((epic) => ({ epic, from: day(d(epic.start)), to: epic.end ? day(d(epic.end)) : null })),
  }));
  const goals = milestones().slice().sort((a, b) => d(a.date) - d(b.date)).map((m) => {
    const date = d(m.date);
    const days = Math.round((date.getTime() - today.getTime()) / DAY);
    const past = days < 0;
    const name = m.name.charAt(0).toUpperCase() + m.name.slice(1);
    const dateLabel = humanShort(date) + (days > 0 ? ` · ${days}d away` : days === 0 ? ' · Today' : '');
    const width = Math.min(240, Math.max(112, name.length * (past ? 7.5 : 8.5) + (past ? 50 : 62), dateLabel.length * 6 + (past ? 50 : 62)));
    return { m, past, name, dateLabel, width, at: day(date) };
  });
  return { start, span: day(end), today: day(today), lanes, goals };
}

/**
 * The parts of the layout that change at a zoom level: which row each epic
 * and goal label takes, the lane heights and the axis height. `width` and
 * `height` are the content area's size.
 */
function roadmapLayout(model, ppd, { barHeight, width, height }) {
  const x = (days) => dayX(days, ppd);
  const timeline = timelineWidth(model, ppd, width);
  // Goal labels pack independently of epic lanes, including room for Today.
  const todayX = x(model.today);
  const labelRows = [[{ left: todayX - 34, right: todayX + 34 }]];
  const goalRows = model.goals.map((goal) => {
    const left = Math.max(6, Math.min(x(goal.at) - goal.width / 2, timeline - goal.width - 6));
    let row = labelRows.findIndex((items) => items.every((other) => left + goal.width + 12 <= other.left || left >= other.right + 12));
    if (row < 0) { row = labelRows.length; labelRows.push([]); }
    labelRows[row].push({ left, right: left + goal.width });
    return row;
  });
  const axisHeight = AXIS + (labelRows.length - 1) * GOAL_ROW;
  // Date intervals and minimum card widths must both fit before reusing a row.
  // An ongoing epic runs to the end of the range, so nothing later shares its row.
  const packed = model.lanes.map((lane) => {
    const rows = [];
    const assigned = lane.epics.map((item) => {
      const left = x(item.from);
      const right = item.to === null ? Infinity : left + Math.max(x(item.to) - left, EPIC_MIN_WIDTH);
      let row = rows.findIndex((last) => item.from > last.to && left >= last.right + EPIC_GAP);
      if (row < 0) row = rows.length;
      rows[row] = { to: item.to ?? Infinity, right };
      return row;
    });
    return { assigned, count: Math.max(rows.length, 1) };
  });
  // Packed minimum heights, then leftover viewport height shared evenly.
  const rowsHeight = (count) => count * barHeight + (count - 1) * ROW_GAP;
  const minHs = packed.map((lane) => Math.max(2 * LANE_PAD + rowsHeight(lane.count), 88));
  const availH = height - axisHeight - MONTH_ROW - 8;
  const extra = packed.length ? Math.max((availH - minHs.reduce((a, b) => a + b, 0)) / packed.length, 0) : 0;
  const lanes = packed.map((lane, i) => {
    const laneHeight = Math.round(minHs[i] + extra);
    return { rows: lane.assigned, count: lane.count, height: laneHeight, pad: Math.round((laneHeight - rowsHeight(lane.count)) / 2) };
  });
  return { ppd, axisHeight, goalRows, lanes };
}

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
const barLeft = (item, ppd) => `${dayX(item.from, ppd)}px`;
/** An ongoing bar has no width: CSS runs it to the end of its lane. */
const barWidth = (item, ppd) => `${Math.max(dayX(item.to, ppd) - dayX(item.from, ppd), EPIC_MIN_WIDTH)}px`;
const barTop = (lane, row, barHeight) => `${lane.pad + row * (barHeight + ROW_GAP)}px`;
const timelineWidth = (model, ppd, width) => Math.max(dayX(model.span, ppd), width - RAIL);
/** A goal label's center: under its date, but kept inside the timeline. */
const goalCenter = (goal, ppd, timeline) => `${Math.max(6, Math.min(dayX(goal.at, ppd) - goal.width / 2, timeline - goal.width - 6)) + goal.width / 2}px`;

/** Task counts arrive with the Roadmap's own read; until then, a placeholder. */
const countsLoading = '<span style="color:var(--ink-faint)" aria-hidden="true">…</span><span class="sr-only">Loading task counts</span>';

function epicBar(item, ppd, top) {
  const e = item.epic, s = d(e.start);
  const ongoing = item.to === null, counted = e.counted !== false;
  const cls = ['bar', e.state, ongoing ? 'ongoing' : '', (counted && ongoing && e.total === 0 && e.state !== 'done') ? 'quiet' : ''].join(' ');
  const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;

  const right = e.state === 'done' ? I.check : '';

  let meta;
  if (!counted && e.state !== 'done') meta = countsLoading;
  else if (e.state === 'done') meta = `${counted && e.total ? e.done+'/'+e.total+' · ' : ''}<span style="color:var(--ok)">complete</span>`;
  else if (ongoing && e.total === 0) meta = '<span style="color:var(--ink-faint)">ongoing</span>';
  else if (ongoing) meta = `<span style="color:var(--ink-soft)">ongoing</span> · ${e.completedSinceStart ?? e.done} done · ${e.open ?? e.total - e.done} open`;
  else if (e.state === 'planning') meta = `${e.done}/${e.total} · starts ${humanShort(s)}`;
  else meta = `${e.done}/${e.total}`;

  const prog = (!counted || ongoing || e.total === 0) ? '' :
    `<div class="prog"><i style="width:${pct}%;background:${e.state === 'done' ? 'var(--ok)' : 'var(--run)'}"></i></div>`;

  return `<div class="${cls}" data-epic="${UIEscape(e.id)}" role="button" tabindex="0" aria-label="${esc(e.title)}" style="left:${barLeft(item, ppd)};top:${top};${ongoing ? '' : `width:${barWidth(item, ppd)}`}" ${UIAction('openPeek', e.id)} ${UIAction.on('mouseenter', 'epicHover', UIAction.event, e.id)} ${UIAction.on('mouseleave', 'epicLeave')} ${UIAction.on('focus', 'epicHover', UIAction.event, e.id, true)} ${UIAction.on('blur', 'epicLeave')} ${UIAction.on('keydown', 'epicKey', UIAction.event, e.id)}>
    <div class="t"><span class="txt">${esc(e.title)}</span>${right}</div>
    <div class="m">${meta}</div>${prog}</div>`;
}
// The words the product uses for an epic's status.
const epicStatus = (epic) => ({ planning: 'Planning', active: 'In progress', done: 'Done' })[epic.state] || epic.state;

function showEpicTip(anchor, id) {
  const epic = epicById(id);
  if (!epic||!canReadProject(trackById(epic.trackId)?.projectId)) return;
  const status = epicStatus(epic);
  mountRoadmapTip(anchor, 'epic-tooltip', `<div class="epic-tip-title">${esc(epic.title)}</div>
    <div class="epic-tip-track">${esc(trackById(epic.trackId)?.name || '')}</div>
    <dl class="epic-tip-facts"><div><dt>Status</dt><dd>${esc(status)}</dd></div><div><dt>Tasks</dt><dd>${epic.counted === false ? countsLoading : `${epic.done} / ${epic.total} done`}</dd></div>
    <div><dt>Start</dt><dd>${esc(epic.start)}</dd></div><div><dt>End</dt><dd>${epic.end ? esc(epic.end) : 'No end date'}</dd></div></dl>
    ${epic.desc ? `<div class="epic-tip-description">${esc(epic.desc)}</div>` : ''}`);
}

function showMilestoneTip(anchor, id) {
  const milestone = milestones().find(m => m.id === id);
  if (!milestone) return;
  const days = Math.round((d(milestone.date) - today) / DAY);
  const timing = days === 0 ? 'Today' : `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} ${days > 0 ? 'away' : 'ago'}`;
  mountRoadmapTip(anchor, 'milestone-tooltip', `<div class="epic-tip-title">${esc(milestone.name)}</div>
    <div class="epic-tip-track">Milestone · ${esc(project().name)}</div>
    <dl class="epic-tip-facts"><div><dt>Date</dt><dd>${esc(milestone.date)}</dd></div><div><dt>Timing</dt><dd>${timing}</dd></div></dl>
    <div class="epic-tip-description">${milestone.desc ? esc(milestone.desc) : '<span style="color:var(--ink-ghost)">No description</span>'}</div>`);
}

/** @type {number|null} */
export let roadmapHeight=null;

function measureEpicHeight() {
  const probe = document.createElement('div');
  probe.className = 'bar planning';
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:300px';
  setHTML(probe, '<div class="t"><span class="txt">Epic</span></div><div class="m">0/1 · ongoing</div>');
  (document.querySelector('.content') || document.body).append(probe);
  const height = Math.max(BAR_H, Math.ceil(probe.getBoundingClientRect().height));
  probe.remove();
  return height;
}
/** @type {{model:any,layout:any,metrics:{barHeight:number,width:number,height:number}}|null} The latest rendered Roadmap, which mountRoadmap binds. */
let renderedRoadmap = null;

export function renderRoadmap() {
  // A scale change still easing finishes first, so the new Roadmap starts at its zoom.
  roadmapGestureCleanup();
  const barHeight = measureEpicHeight();
  RAIL = window.innerWidth <= 900 ? 132 : 208;
  const model = roadmapModel();
  const contentEl = document.querySelector('.content');
  roadmapHeight=contentEl ? contentEl.clientHeight : window.innerHeight - 80;
  const metrics = { barHeight, width: contentEl?.clientWidth || window.innerWidth, height: roadmapHeight };
  const ppd = state.pxPerDay;
  const layout = roadmapLayout(model, ppd, metrics);
  const { axisHeight } = layout;
  renderedRoadmap = { model, layout, metrics };

  // Calendar cells are mounted for the viewport, independent of date span.
  let lanes = '';
  model.lanes.forEach(({ track: t, epics: items }, ti) => {
    const lane = layout.lanes[ti];
    const list = items.map((item) => item.epic);
    const active = list.filter((e) => e.state === 'active').length;
    const doneN = list.filter((e) => e.state === 'done').length;
    const cont = list.some((e) => !e.end);
    const sub = list.length
      ? `${list.length} epic${list.length > 1 ? 's' : ''}${active ? ` · ${active} active` : ''}${doneN ? ` · ${doneN} done` : ''}${cont ? ' · continuous' : ''}`
      : 'no epics yet';
    const bars = items.map((item, i) => epicBar(item, ppd, barTop(lane, lane.rows[i], barHeight))).join('');
    lanes += `<div class="lane" data-track="${UIEscape(t.id)}" ${canRoadmap() ? `${UIAction.on('dragover', 'laneOver', UIAction.event)} ${UIAction.on('drop', 'trackDrop', UIAction.event, t.id)}` : ''} style="height:${lane.height}px">
      <div class="rail-cell lane-head" style="width:${RAIL}px">
        <h2 class="name" data-tip="${esc(t.name)}" data-tip-overflow>${esc(t.name)}</h2><div class="sub">${sub}</div>
        ${canRoadmap() ? `<div class="head-ctl">
          <button type="button" class="grip" aria-label="Reorder ${esc(t.name)}" ${UIAction.on('keydown', 'trackReorderKey', UIAction.event, t.id)} data-reorderable="true" ${UIAction.on('dragstart', 'trackDragStart', UIAction.event, t.id)} ${UIAction.on('dragend', 'dragEnd')} title="Drag to reorder or use arrow keys">${I.grip}</button>
          <button type="button" class="kebab icon-button" aria-label="Manage ${esc(t.name)} track" ${UIAction('trackMenu', UIAction.event, t.id)}>${I.kebab}</button>
        </div>` : ''}
      </div>
      <div class="lane-body">${bars}</div>
    </div>`;
  });

  // milestones + today (labels live in the sticky axis; lines span the canvas)
  const timeline = timelineWidth(model, ppd, metrics.width);
  let msHtml = '', msLabels = '';
  model.goals.forEach((goal, i) => {
    const { m, past, name, dateLabel, width, at } = goal, row = layout.goalRows[i];
    msHtml += `<div class="ms-line${past ? ' past' : ''}" aria-hidden="true" style="left:${RAIL + dayX(at, ppd)}px;top:${axisHeight}px;bottom:${MONTH_ROW}px"></div>`;
    msLabels += `<div class="ms-line goal-connector${past ? ' past' : ''}" aria-hidden="true" style="left:${dayX(at, ppd)}px;top:${12 + row * GOAL_ROW + 54}px;bottom:-1px"></div>`;
    msLabels += `<button type="button" class="ms-label${past ? ' past' : ''}" data-milestone="${UIEscape(m.id)}" style="left:${goalCenter(goal, ppd, timeline)};top:${12 + row * GOAL_ROW}px;width:${width}px" ${UIAction('milestoneClick', UIAction.event, m.id)} ${UIAction.on('mouseenter', 'milestoneHover', UIAction.event, m.id)} ${UIAction.on('mouseleave', 'epicLeave')} ${UIAction.on('focus', 'milestoneHover', UIAction.event, m.id, true)} ${UIAction.on('blur', 'epicLeave')} ${UIAction.on('keydown', 'roadmapTipKey', UIAction.event)}>
      ${I.diamond}<span class="txt"><span class="goal-name">${esc(name)}</span><span class="goal-date">${dateLabel}</span></span></button>`;
  });
  const todayX = dayX(model.today, ppd);
  const todayHtml = `<div class="today-line" style="left:${RAIL + todayX}px;top:${axisHeight}px;bottom:${MONTH_ROW}px"></div>`;
  const todayPill = `<div class="today-line today-connector" aria-hidden="true" style="left:${todayX}px;top:32px;bottom:-1px"></div><div class="today-pill" style="left:${todayX}px;top:12px">${human(today)}</div>`;

  // Month cells are day offsets that their container's --ppd scales.
  const calendar = `--ppd:${ppd}`, calendarLines = `${calendar};--rm-rail:${RAIL}px;--rm-axis-h:${axisHeight}px;--rm-month-h:${MONTH_ROW}px`;
  const emptyProject = model.lanes.length === 0;
  return `<div class="rm-scroll" id="rmScroll" data-bar-height="${UIEscape(barHeight)}" data-range-start="${UIEscape(+model.start)}">
    <div class="rm-canvas" style="width:${RAIL + dayX(model.span, ppd)}px">
      <div class="rm-axis" style="height:${axisHeight}px">
        <div class="rail-cell rm-track-head" style="width:${RAIL}px">${canRoadmap() ? `<button class="btn quiet" type="button" ${UIAction('openModal', 'track')}>${I.plus}<span>Track</span></button>` : '<span class="rm-track-title">Tracks</span>'}</div>
        <div class="rm-axis-labels"><span class="rm-calendar-axis" style="${calendar}"></span>${msLabels}${todayPill}</div>
      </div>
      <span class="rm-calendar-lines" style="${calendarLines}"></span>${msHtml}${todayHtml}${lanes}
      ${emptyProject ? `<div style="position:sticky;left:0;width:100%;padding:60px 0;text-align:center;color:var(--ink-ghost);font-size:var(--text-body)">No tracks yet.</div>` : ''}
      <div class="rm-month-row" style="height:${MONTH_ROW}px"><div class="rail-cell" style="width:${RAIL}px"></div><div class="rm-month-grid" style="${calendar}"></div></div>
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
  announce(`${trackById(id)?.name || 'Track'} moved to position ${tracks().findIndex(track=>track.id===id)+1}`);
}

// ---------- epic drawer ----------
const actFeed = (list, limit) => (list || []).slice(-(limit || 8)).reverse().map((a) =>
  `<div class="act-row"><span class="act-dot"></span><span class="act-text"><b>${esc(userById(a.who)?.name||a.actorName||a.who)}</b> ${esc(a.text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,''))}</span><time class="act-time" datetime="${new Date(a.ts).toISOString()}" aria-label="${formatInstant(a.ts)}" data-tip="${esc(formatInstant(a.ts))}">${ago(a.ts)}</time></div>`).join('')
  || '<div class="empty-note" style="border:0;text-align:left;padding:4px 0">nothing yet</div>';

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
  const ongoing = !e.end;
  const page=D.epicPageInfo?.[e.id];
  const eTasks = page?.loaded?page.taskIds.map(taskById).filter(Boolean):tasks().filter((x) => x.epicId === e.id);
  const order = { progress: 0, review: 1, planning: 2, done: 3 };
  eTasks.sort((a, b) => order[a.state] - order[b.state] || Number(a.id.slice(a.id.lastIndexOf('-')+1)) - Number(b.id.slice(b.id.lastIndexOf('-')+1)));
  const stateColor = { done: 'var(--ok)', review: 'var(--review)', progress: 'var(--run)', planning: 'var(--ink-faint)' };
  const stateBits = (x) => [stIcon(x.state), `<span style="color:${stateColor[x.state]}">${STATUS[x.state].toLowerCase()}</span>`];
  const rows = eTasks.map((x) => {
    const [dot, m] = stateBits(x);
    return `<div class="task-row">${dot}<span class="tid">${esc(x.id)}</span><span class="tt" data-tip="${esc(x.title)}" data-tip-overflow>${esc(x.title)}</span><span class="tm">${m}</span></div>`;
  }).join('') || '<div class="empty-note" style="margin:14px 0">no tasks yet</div>';

  const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
  const midBlock = e.counted === false ? '' : ongoing && e.weekly
    ? `<div data-epic-throughput style="padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px">${sparkline(e.weekly)}
        <div><div class="mono" style="font-size:var(--text-xs);color:var(--ink-soft)">${e.closedThisWeek} closed this week</div>
        <div class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${e.completedSinceStart ?? e.done} since ${humanShort(d(e.start))} · ${e.open ?? e.total - e.done} open</div></div></div>`
    : e.total ? `<div style="padding:16px 20px;border-bottom:1px solid var(--line)">
        <div style="position:relative;height:6px;background:rgb(var(--tone-rgb) / 0.07);border-radius:3px;overflow:hidden"><div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${e.state === 'done' ? 'var(--ok)' : 'var(--run)'}"></div></div>
        <div class="mono" style="font-size:var(--text-xs);color:var(--ink-faint);margin-top:8px">${e.done} of ${e.total} tasks complete · ${pct}%</div></div>` : '';

  return `<div class="scrim" ${UIAction('closeOverlays')}></div>
  <aside class="peek" role="dialog" aria-modal="true" aria-labelledby="peek-title">
    <div class="peek-head">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="mono" style="font-size:var(--text-xs);letter-spacing:0.1em;color:var(--ink-ghost)">${esc(t ? t.name : '')}</span>
        <button type="button" class="btn icon" aria-label="Close epic" ${UIAction('closeOverlays')}>${I.close}</button>
      </div>
      <h2 id="peek-title" style="font-size:17px;font-weight:600;letter-spacing:-0.01em">${esc(e.title)}</h2>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="chip idle">${ongoing ? 'Ongoing · ' : ''}${esc(epicStatus(e))}</span>
        <span class="mono" style="font-size:var(--text-xs);color:var(--ink-faint)">${humanShort(d(e.start))} → ${e.end ? humanShort(d(e.end)) : '<span style="color:var(--ink-soft)">no end date</span>'}</span>
      </div>
    </div>
    <div class="peek-body">
    ${midBlock}
    ${e.desc ? descriptionReadHtml(e.desc,'epic-description-'+e.id) : ''}
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px 10px">
      <div style="display:flex;align-items:baseline;gap:7px"><span style="font-size:var(--text-body);font-weight:600;color:var(--ink)">Tasks</span><span class="mono" data-epic-task-total style="font-size:var(--text-xs);color:var(--ink-ghost)">${page?.loaded?page.tasksTotal:eTasks.length}</span></div>
    </div>
    <div class="peek-rows">${rows}${page?.tasksCursor?`<button class="btn quiet" ${UIAction('loadMoreEpicTasks', e.id)}>Load more tasks</button>`:''}
      <div style="padding:14px 0 6px;font-size:var(--text-body);font-weight:600;color:var(--ink)">Activity</div>
      ${actFeed(e.activity, page?.loaded?Number.MAX_SAFE_INTEGER:8)}
      ${page?.activityCursor?`<button class="btn quiet" ${UIAction('loadMoreEpicActivity', e.id)}>Load older activity</button>`:''}
    </div>
    </div>
    <div class="peek-actions">
      ${canRoadmap() ? `${e.state === 'done'
        ? `<button class="btn" ${UIAction('reopenEpic', e.id)}>Reopen</button>`
        : `<button class="btn" ${UIAction('closeEpic', e.id)}>Mark as done</button>`}
      <button class="btn" ${UIAction('openModal', 'epic', e.id)}>Edit epic</button>
      <button class="btn danger" style="margin-left:auto" ${UIAction('deleteEpic', e.id)}>Delete</button>` : '<span class="access-note" style="margin:0">Read only</span>'}
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
const roadmapStat = (label,value) => `<span class="roadmap-stat"><span>${label}</span><strong>${value}</strong></span>`;

/** The Roadmap's page header: its counts, scale, Today and add buttons. */
export function roadmapTopbarHtml() {
  return `<h1>Roadmap</h1><div class="roadmap-meta" role="group" aria-label="Roadmap summary"><span class="roadmap-structure-stats">${roadmapStat('Tracks',tracks().length)}${roadmapStat('Epics',epics().length)}${roadmapStat('Milestones',milestones().length)}</span></div>
  <div class="right">
    ${roadmapScaleHtml()}
    <button class="btn quiet" ${UIAction('goToday')}>Today</button>
    ${canRoadmap() ? `<button class="btn roadmap-milestone" data-tip="Milestone" data-tip-overflow ${UIAction('openModal', 'milestone')}><span class="ms-diamond" style="border-color:var(--ink-muted)"></span><span class="btn-label">Milestone</span></button>
    <button class="btn primary" ${UIAction('openModal', 'epic')}>${I.plus} Epic</button>` : '<span class="read-only-pill">read only</span>'}
  </div>`;
}

// ---------- roadmap mount: scroll + zoom ----------
/**
 * The mounted Roadmap: what was rendered, the elements a zoom step moves,
 * and the calendar window currently in the DOM.
 * @typedef {{sc:HTMLElement,canvas:HTMLElement,axis:HTMLElement,model:any,layout:any,metrics:{barHeight:number,width:number,height:number},ppd:number,
 *   lanes:{lane:HTMLElement,bars:{el:HTMLElement,item:any}[]}[],goals:{goal:any,line:HTMLElement,connector:HTMLElement,label:HTMLElement}[],
 *   today:HTMLElement[],cells:{axis:HTMLElement,lines:HTMLElement,months:HTMLElement},calendar:{from:number,to:number,labels:string}|null,zoomLeft:number}} RoadmapView
 */
/** @returns {RoadmapView} */
function bindRoadmap(sc, rendered) {
  const all = (/** @type {string} */ selector) => /** @type {HTMLElement[]} */([...sc.querySelectorAll(selector)]);
  const lines = all('.rm-canvas > .ms-line'), connectors = all('.goal-connector'), labels = all('.ms-label');
  const laneEls = all('.lane');
  return {
    sc, canvas: sc.querySelector('.rm-canvas'), axis: sc.querySelector('.rm-axis'), ...rendered, ppd: rendered.layout.ppd, calendar: null, zoomLeft: NaN,
    lanes: rendered.model.lanes.map((lane, i) => {
      const bars = /** @type {HTMLElement[]} */([...(laneEls[i]?.querySelector('.lane-body')?.children || [])]);
      return { lane: laneEls[i], bars: lane.epics.map((item, j) => ({ el: bars[j], item })).filter((bar) => bar.el) };
    }),
    goals: rendered.model.goals.map((goal, i) => ({ goal, line: lines[i], connector: connectors[i], label: labels[i] })).filter((goal) => goal.line && goal.connector && goal.label),
    today: [sc.querySelector('.rm-canvas > .today-line'), sc.querySelector('.today-connector'), sc.querySelector('.today-pill')],
    cells: { axis: sc.querySelector('.rm-calendar-axis'), lines: sc.querySelector('.rm-calendar-lines'), months: sc.querySelector('.rm-month-grid') },
  };
}

/** Apply a zoom level's rows and heights, writing only what changed. */
function applyRoadmapLayout(view, next) {
  const prev = view.layout, { barHeight } = view.metrics;
  if (next.axisHeight !== prev.axisHeight) {
    const top = `${next.axisHeight}px`;
    view.axis.style.height = top;
    for (const el of [...view.goals.map((goal) => goal.line), view.today[0]]) if (el) el.style.top = top;
    view.cells.lines?.style.setProperty('--rm-axis-h', top);
  }
  view.goals.forEach(({ connector, label }, i) => {
    const row = next.goalRows[i];
    if (row === prev.goalRows[i]) return;
    connector.style.top = `${12 + row * GOAL_ROW + 54}px`;
    label.style.top = `${12 + row * GOAL_ROW}px`;
  });
  next.lanes.forEach((lane, i) => {
    const before = prev.lanes[i], bound = view.lanes[i];
    if (!bound?.lane) return;
    if (lane.height !== before.height) bound.lane.style.height = `${lane.height}px`;
    bound.bars.forEach((bar, j) => { if (lane.pad !== before.pad || lane.rows[j] !== before.rows[j]) bar.el.style.top = barTop(lane, lane.rows[j], barHeight); });
  });
  view.layout = next;
}

/**
 * One zoom step: move and size the mounted elements for `ppd`, move the
 * rows that the new widths change, and keep `day` at `cx` pixels from the
 * scroller's left edge. Only the positioned elements change, so the browser
 * restyles those and not the text inside them.
 */
function zoomRoadmap(view, ppd, day, cx) {
  const { sc, model } = view;
  if (ppd !== view.ppd) {
    view.ppd = state.pxPerDay = ppd;
    view.canvas.style.width = `${RAIL + dayX(model.span, ppd)}px`;
    for (const lane of view.lanes) for (const { el, item } of lane.bars) {
      el.style.left = barLeft(item, ppd);
      if (item.to !== null) el.style.width = barWidth(item, ppd);
    }
    const timeline = timelineWidth(model, ppd, view.metrics.width);
    for (const { goal, line, connector, label } of view.goals) {
      const x = dayX(goal.at, ppd);
      line.style.left = `${RAIL + x}px`;
      connector.style.left = `${x}px`;
      label.style.left = goalCenter(goal, ppd, timeline);
    }
    const [line, connector, pill] = view.today, todayX = dayX(model.today, ppd);
    if (line) line.style.left = `${RAIL + todayX}px`;
    for (const el of [connector, pill]) if (el) el.style.left = `${todayX}px`;
    for (const el of Object.values(view.cells)) el?.style.setProperty('--ppd', String(ppd));
    applyRoadmapLayout(view, roadmapLayout(model, ppd, view.metrics));
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
  return `<div class="seg roadmap-scale" role="group" aria-label="Timeline scale">${ROADMAP_SCALES.map((scale) => `<button type="button" data-scale="${UIEscape(scale.key)}" class="${pressedScale === scale.key ? 'on' : ''}" aria-pressed="${pressedScale === scale.key}" aria-keyshortcuts="${UIEscape(scale.shortcut)}" ${UIAction('setRoadmapScale', scale.key)}>${scale.label}</button>`).join('')}</div>`;
}

function syncRoadmapScale() {
  const current = roadmapScale()?.key ?? null;
  if (current === pressedScale) return;
  pressedScale = current;
  document.querySelectorAll('.roadmap-scale [data-scale]').forEach((button) => {
    const on = button.dataset.scale === current;
    button.setAttribute('aria-pressed', String(on)); button.classList.toggle('on', on);
  });
}

/** The selected epic's bar while it shows in the view, or null. */
function selectedEpicBar(view) {
  const found = roadmapSelection && view.lanes.flatMap((lane) => lane.bars).find((bar) => bar.el.dataset.epic === roadmapSelection);
  if (!found?.el.isConnected) return null;
  const box = found.el.getBoundingClientRect(), port = view.sc.getBoundingClientRect();
  const shows = box.right > port.left + RAIL && box.left < port.right && box.bottom > port.top + view.layout.axisHeight && box.top < port.bottom - MONTH_ROW;
  return shows ? found : null;
}

/**
 * What a scale change keeps in place: the selected epic while it shows,
 * else today while it shows, else the date in the middle of the view.
 * An epic that fits the view keeps its middle, moved into the view if
 * needed; a wider one keeps its start when that shows, and otherwise the
 * middle of the part that shows. Returns the day and its distance from the
 * scroller's left edge.
 */
function scaleAnchor(view, ppd) {
  const { sc, model } = view, width = sc.clientWidth, room = width - RAIL;
  const x = (day) => RAIL + day * view.ppd - sc.scrollLeft;
  const margin = Math.min(80, room / 4), inside = (cx) => Math.min(Math.max(cx, RAIL + margin), width - margin);
  const selected = selectedEpicBar(view);
  if (selected) {
    const { from, to } = selected.item;
    if (to !== null && (to - from) * ppd <= room) return { day: (from + to) / 2, cx: inside(x((from + to) / 2)) };
    if (x(from) >= RAIL) return { day: from, cx: x(from) };
    const shown = (Math.max(from, sc.scrollLeft / view.ppd) + Math.min(to ?? model.span, (sc.scrollLeft + room) / view.ppd)) / 2;
    return { day: shown, cx: x(shown) };
  }
  const today = x(model.today);
  if (today >= RAIL && today <= width) return { day: model.today, cx: today };
  const cx = RAIL + room / 2;
  return { day: (sc.scrollLeft + cx - RAIL) / view.ppd, cx };
}

const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', month:'short' });

/**
 * Month labels and lines cover the visible dates plus one view of overscan
 * each way, so the DOM stays bounded at every zoom level. From WEEK_AXIS_PPD,
 * weeks get lines too, and the bottom row labels each week with its Monday's
 * date instead of each month. The cells follow --ppd, so this redraws them
 * only when the view nears the window's edge, the window becomes much wider
 * than needed or passes the end of the range, a partial month at either end
 * gains or loses its label, or the axis changes between months and weeks.
 */
function mountRoadmapCalendar(view) {
  const { sc, model, ppd } = view, start = model.start, width = sc.clientWidth || window.innerWidth;
  const end = Math.max(model.span, (view.metrics.width - RAIL) / ppd);
  const day = (/** @type {Date} */ dt) => (dt - start) / DAY;
  const labeled = (/** @type {number} */ from, /** @type {number} */ to) => Math.round(to * ppd) - Math.round(from * ppd) > 46;
  const weeks = ppd >= WEEK_AXIS_PPD;
  const startMonth = new Date(start); startMonth.setUTCDate(1); startMonth.setUTCMonth(startMonth.getUTCMonth() + 1);
  const endMonth = new Date(+start + end * DAY); endMonth.setUTCDate(1); endMonth.setUTCHours(0, 0, 0, 0);
  const labels = `${weeks}:${labeled(0, Math.min(day(startMonth), end))}:${labeled(Math.max(day(endMonth), 0), end)}`;
  const margin = width / 2 / ppd;
  const need = { from: Math.max(0, sc.scrollLeft / ppd - margin), to: Math.min(end, (sc.scrollLeft + width - RAIL) / ppd + margin) };
  const shown = view.calendar;
  if (shown && shown.from <= need.from && shown.to >= need.to && shown.to <= end && shown.to - shown.from <= 4 * (width + RAIL) / ppd + 62 && shown.labels === labels) return;
  const first = new Date(+start + Math.max(0, (sc.scrollLeft - width - RAIL) / ppd) * DAY);
  first.setUTCDate(1); first.setUTCHours(0, 0, 0, 0);
  const last = Math.min(end, (sc.scrollLeft + width * 2) / ppd);
  let months = '', seps = '', axisSeps = '', covered = Math.max(0, day(first));
  for (const m = new Date(first); day(m) < last; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const next = new Date(m); next.setUTCMonth(next.getUTCMonth() + 1);
    const from = Math.max(day(m), 0), to = Math.min(day(next), end);
    const label = monthFormatter.format(m) + (m.getUTCMonth() === 0 || +m === +first ? ' ' + String(m.getUTCFullYear()).slice(2) : '');
    if (!weeks && labeled(from, to)) months += `<div class="rm-month" style="--d:${from};--n:${to - from}">${label}</div>`;
    if (day(next) < end) {
      seps += `<div class="rm-month-line" aria-hidden="true" style="--d:${day(next)}"></div>`;
      axisSeps += `<div class="rm-axis-divider" aria-hidden="true" style="--d:${day(next)}"></div>`;
    }
    covered = to;
  }
  // Each week starts on a Monday, labeled with its date and, outside this year, the year.
  let weekSeps = '';
  if (weeks) for (const monday = new Date(+first + ((8 - first.getUTCDay()) % 7) * DAY); day(monday) < Math.min(last, end); monday.setUTCDate(monday.getUTCDate() + 7)) {
    const at = day(monday);
    if (at <= 0) continue;
    if (monday.getUTCDate() !== 1) seps += `<div class="rm-week-line" aria-hidden="true" style="--d:${at}"></div>`;
    weekSeps += `<div class="rm-axis-divider" aria-hidden="true" style="--d:${at}"></div>`;
    months += `<div class="rm-week" style="--d:${at}">${humanShort(monday)}</div>`;
  }
  view.calendar = { from: Math.max(0, day(first)), to: covered, labels };
  setHTML(view.cells.axis, axisSeps);
  setHTML(view.cells.lines, seps);
  setHTML(view.cells.months, (weeks ? weekSeps : axisSeps) + months);
}

let roadmapGestureCleanup = () => {};
/** @type {(RoadmapView & {zoomTo:(ppd:number)=>void})|null} The Roadmap on the page, which a scale change zooms. */
let mountedRoadmap = null;

export function mountRoadmap() {
  roadmapGestureCleanup();
  const sc = /** @type {HTMLElement|null} */(document.getElementById('rmScroll'));
  if (!sc || !renderedRoadmap) return;
  const view = Object.assign(bindRoadmap(sc, renderedRoadmap), { zoomTo: (/** @type {number} */ _ppd) => {} });
  mountedRoadmap = view;
  sc.addEventListener('focusin', (event) => { const bar = /** @type {Element} */(event.target).closest?.('[data-epic]'); if (bar) roadmapSelection = bar.dataset.epic; });
  if (state.rmScrollLeft === null) state.rmScrollLeft = Math.max(RAIL + view.model.today * view.ppd - sc.clientWidth * 0.42, 0);
  sc.scrollLeft = state.rmScrollLeft;
  sc.scrollTop = state.rmScrollTop;
  mountRoadmapCalendar(view);
  /** @type {{kind:'wheel'|'pinch'|'gesture',left:number,cx:number,day:number,ppd0:number,log:number,target:number|null,distance:number,cy:number,dy:number}|null} The zoom gesture in progress. */
  let gesture = null;
  let calendarFrame = 0;
  sc.addEventListener('scroll', () => {
    state.rmScrollLeft = sc.scrollLeft; state.rmScrollTop = sc.scrollTop;
    // A scroll the zoom did not make, such as a touchpad pan during a
    // pinch, moves the content under the pointer: zoom around that day now.
    if (gesture && Math.abs(sc.scrollLeft - view.zoomLeft) > 1) { gesture.day = (sc.scrollLeft + gesture.cx - RAIL) / view.ppd; view.zoomLeft = sc.scrollLeft; }
    if (!calendarFrame) calendarFrame = requestAnimationFrame(() => {
      calendarFrame = 0;
      if (sc.isConnected) mountRoadmapCalendar(view);
    });
  });
  const sample = sc.querySelector('.bar');
  /** @type {number|null} */ let sizeFrame = null;
  const sizeObserver = typeof ResizeObserver === 'undefined' || !sample ? null : new ResizeObserver(() => {
    if(sizeFrame===null && sc.isConnected && Math.ceil(sample.getBoundingClientRect().height)!==Number(sc.dataset.barHeight)){
      sizeFrame=requestAnimationFrame(()=>{sizeFrame=null;if(sc.isConnected)App.refreshRoadmap();});
    }
  });
  if(sample)sizeObserver?.observe(sample);

  // Zoom: input events update one gesture, and one frame applies it. A
  // gesture keeps the day under the pointer, or under the pinch center as it
  // moves, in place.
  let frame = 0, pointerX = NaN;
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let idle;
  const begin = (/** @type {'wheel'|'pinch'|'gesture'} */ kind, /** @type {number} */ clientX, left = sc.getBoundingClientRect().left) => {
    stopScale(false);
    hideEpicTip();
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
  const center = (/** @type {TouchList} */ touches) => ({ x:(touches[0].clientX + touches[1].clientX) / 2, y:(touches[0].clientY + touches[1].clientY) / 2 });
  const spread = (/** @type {TouchList} */ touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  function movePinch(/** @type {TouchEvent} */ e) {
    if (gesture?.kind !== 'pinch' || e.touches.length !== 2) return;
    e.preventDefault();
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
  const endPinch = (/** @type {TouchEvent} */ e) => { if (gesture?.kind === 'pinch' && e.touches.length < 2) end(); };
  sc.addEventListener('touchend', endPinch, {passive:true});
  sc.addEventListener('touchcancel', endPinch, {passive:true});
  // Safari reports a touchpad pinch as gesture events, not ctrl+wheel. On
  // touch screens, touch events already drive the pinch.
  sc.addEventListener('pointermove', e => { pointerX = e.clientX; }, {passive:true});
  const pinchGesture = (/** @type {Event & {scale?:number,clientX?:number}} */ e) => {
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
  /** @type {{ppd:number,day:number,cx:number,from:number,started:number|null}|null} */ let scaled = null;
  let scaleFrame = 0;
  function stopScale(finish = true) {
    if (scaleFrame) cancelAnimationFrame(scaleFrame);
    scaleFrame = 0;
    if (finish && scaled && sc.isConnected) zoomRoadmap(view, scaled.ppd, scaled.day, scaled.cx);
    scaled = null;
  }
  const stepScale = (/** @type {number} */ time) => {
    scaleFrame = 0;
    if (!scaled || !sc.isConnected) return;
    scaled.started ??= time - 1000 / 60;
    const progress = Math.min(1, (time - scaled.started) / MOTION.normal), eased = 1 - (1 - progress) ** 3;
    zoomRoadmap(view, progress < 1 ? clampZoom(scaled.from * Math.exp(Math.log(scaled.ppd / scaled.from) * eased)) : scaled.ppd, scaled.day, scaled.cx);
    if (progress < 1) scaleFrame = requestAnimationFrame(stepScale); else scaled = null;
  };
  view.zoomTo = (ppd) => {
    if (gesture) end();
    stopScale();
    hideEpicTip();
    const { day, cx } = scaleAnchor(view, ppd);
    if (reducedMotion.matches || Math.abs(ppd - view.ppd) < 1e-3) { zoomRoadmap(view, ppd, day, cx); return; }
    scaled = { ppd, day, cx, from: view.ppd, started: null };
    scaleFrame = requestAnimationFrame(stepScale);
  };
  roadmapGestureCleanup = () => {
    if(calendarFrame)cancelAnimationFrame(calendarFrame);
    sizeObserver?.disconnect();if(sizeFrame!==null)cancelAnimationFrame(sizeFrame);sizeFrame=null;
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
  if (!scale || !onPage || event.target.closest('input,textarea,select,[contenteditable="true"]') || state.modal || state.peek || state.menu || state.sideOpen && innerWidth <= 900 || POP.el || pendingConfirmation || document.querySelector('.confirmation-layer,.file-overlay') || document.getElementById('app').inert) return;
  event.preventDefault();
  App.setRoadmapScale(scale.key);
  announce(`Roadmap scale: ${scale.label}`);
});

document.addEventListener('pointerdown', (e) => {
  if (EPIC_TIP.el && !EPIC_TIP.el.contains(e.target) && !EPIC_TIP.anchor?.contains(e.target)) hideEpicTip();
});

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
  refreshRoadmap() {
    refreshEpicSummary();
    if(state.view!=='roadmap'){App.refreshBackground();return;}
    const content=document.querySelector('.content'),scroll=document.getElementById('rmScroll');
    if(!content||!scroll){App.refresh();return;}
    roadmapGestureCleanup();
    const before=motionRects('.lane'),left=scroll.scrollLeft,top=scroll.scrollTop;
    const focus=document.activeElement,focusType=focus?.dataset?.epic?'epic':focus?.dataset?.milestone?'milestone':null,focusId=focusType?focus.dataset[focusType]:null;
    setHTML(content,renderRoadmap());mountRoadmap();
    const next=document.getElementById('rmScroll');if(next){next.scrollLeft=left;next.scrollTop=top;}
    if(focusId){const equivalent=[...content.querySelectorAll(`[data-${focusType}]`)].find(el=>el.dataset[focusType]===focusId);(equivalent||document.querySelector('.topbar button'))?.focus({preventScroll:true});}
    App.updateDocumentTitle();
    if(before)animateLayout(before,'.lane');
    App.refreshCounts();
  },
  /** Zoom the Roadmap to a fixed scale, in place, keeping the selected epic or today where it is. */
  setRoadmapScale(key) {
    const scale = ROADMAP_SCALES.find((item) => item.key === key);
    if (!scale) return;
    if (state.view === 'roadmap' && mountedRoadmap?.sc.isConnected) { mountedRoadmap.zoomTo(scale.ppd); return; }
    state.pxPerDay = scale.ppd; syncRoadmapScale();
  },
  goToday() {
    const sc = document.getElementById('rmScroll');
    const { start } = rmRange();
    state.rmScrollLeft = Math.max(RAIL + (today - start) / DAY * state.pxPerDay - (sc ? sc.clientWidth : 900) * 0.42, 0);
    // Scroll the mounted Roadmap in place; rebuilding the page would only repeat it.
    if (sc && state.view === 'roadmap' && Number(sc.dataset.rangeStart) === +start) sc.scrollLeft = state.rmScrollLeft;
    else App.refresh();
  },
  epicHover(ev, id, keyboard = false, kind = 'epic') {
    if (!keyboard && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    hideEpicTip();
    const anchor = ev.currentTarget;
    const show = kind === 'milestone' ? showMilestoneTip : showEpicTip;
    if (keyboard) show(anchor, id);
    else EPIC_TIP.showTimer = setTimeout(() => show(anchor, id), 220);
  },
  milestoneHover(ev, id, keyboard = false) { App.epicHover(ev, id, keyboard, 'milestone'); },
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
  epicKey(ev, id) {
    App.roadmapTipKey(ev);
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); App.openPeek(id); }
  },
  openPeek(id) { if(!canReadProject(trackById(epicById(id)?.trackId)?.projectId)){App.toast('This project is unavailable','error');return;}if (state.peek !== id) peekOpened(); state.peek = id; roadmapSelection = id; App.refreshOverlays(); },
  trackMenu(ev, id) {
    ev.stopPropagation();
    if (!App.require('manage_roadmap')) return;
    const list = tracks(), index = list.findIndex(track=>track.id===id);
    const moves = [];
    if (index > 0) moves.push({label:'Move up',fn:()=>App.moveTrack(id,index-1)}, {label:'Move to top',fn:()=>App.moveTrack(id,0)});
    if (index < list.length-1) moves.push({label:'Move down',fn:()=>App.moveTrack(id,index+1)}, {label:'Move to bottom',fn:()=>App.moveTrack(id,list.length-1)});
    App._openMenu([
      ...moves, ...(moves.length ? [{sep:true}] : []),
      { label: 'Rename track', fn: () => { state.modal = { type: 'track', id }; App.refreshOverlays(); } },
      { sep: true },
      { label: 'Delete track', danger: true, fn: () => App.deleteTrack(id) },
    ], 0, 0, {trigger:ev.currentTarget, trackId:id});
  },

  trackDragStart(ev, id) {
    if (!App.require('manage_roadmap')) { ev.preventDefault(); return; }
    if (pendingMove) { ev.preventDefault(); return; }
    App.dragEnd(false);
    ev.dataTransfer.setData('text/track', id);
    ev.dataTransfer.effectAllowed = 'move';
    const lane = ev.target.closest('.lane');
    App._drag = { kind: 'track', id };
    App._dragImage(ev, lane.querySelector('.lane-head'), true);
    document.body.classList.add('is-dragging');
    requestAnimationFrame(() => { if (App._drag?.id === id) lane.classList.add('dragging'); });
  },
  laneOver(ev) {
    if (!canRoadmap() || App._drag?.kind !== 'track') return;
    if (!ev.dataTransfer.types.includes('text/track')) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
    const lane = ev.currentTarget;
    const r = lane.getBoundingClientRect();
    App._laneBefore = ev.clientY < r.top + r.height / 2;
    const ind = App._mkInd(true);
    ind.style.top = (lane.offsetTop + (App._laneBefore ? -2 : lane.offsetHeight - 1)) + 'px';
    lane.parentNode.appendChild(ind);
  },
  trackDrop(ev, targetId) {
    if (!App.require('manage_roadmap')) return;
    if (pendingMove) { ev.preventDefault(); App.dragEnd(); return; }
    if (!ev.dataTransfer.types.includes('text/track') || App._drag?.kind !== 'track') return;
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/track');
    const beforeTarget = App._laneBefore;
    App.dragEnd(false);
    if (!id || id === targetId) return;
    const list = tracks().filter(track=>track.id!==id);
    const index = list.findIndex(track=>track.id===targetId);
    if (index < 0) return;
    App.moveTrack(id, index + (beforeTarget ? 0 : 1));
  },
  trackReorderKey(event, id) {
    const delta = {ArrowUp:-1,ArrowDown:1}[event.key];
    if (!delta || event.isComposing) return;
    event.preventDefault(); App.moveTrack(id, tracks().findIndex(track=>track.id===id) + delta);
  },
  moveTrack(id, position) {
    if (!App.require('manage_roadmap') || pendingMove) return;
    const list = tracks(), index = list.findIndex(track=>track.id===id);
    if (index < 0) return;
    const to = Math.max(0, Math.min(list.length-1, position));
    if (to === index) return;
    const before = motionRects('.lane');
    const original=[...list],originalOrders=new Map(original.map((item)=>[item,item.order]));
    const moved = list.splice(index, 1)[0];
    list.splice(to, 0, moved);
    list.forEach((t, i) => { t.order = i; });
    App.refresh();
    focusMovedTrack(id);
    animateLayout(before, '.lane');
    const pending={};pendingMove=pending;const revision=moved.revision,projectId=moved.projectId,sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`,optimisticOrders=new Map(original.map((item)=>[item,item.order]));
    runtime().moveTrack({trackId:id,position:to,optimistic:true}).catch((error)=>{
      const sameSession=sessionKey===`${D.session?.id||''}:${D.session?.userId||''}`;
      if(!error?.uncertain&&sameSession&&D.tracks.includes(moved)&&moved.revision===revision){for(const [item,order] of originalOrders)if(D.tracks.includes(item)&&item.order===optimisticOrders.get(item))item.order=order;if(state.view==='roadmap'&&state.projectId===projectId){const rollbackBefore=motionRects('.lane');App.refresh();animateLayout(rollbackBefore,'.lane');}}
      report(error);
    }).finally(()=>{if(pendingMove===pending)pendingMove=null;});
  },
});
