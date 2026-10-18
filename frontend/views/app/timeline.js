// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* The Roadmap's lanes: each track's done work, its work in progress and its
   dated plans, in its own work and its epics, with their cards, lists and
   keys. roadmap.js owns the page, the axis and the zoom. */

import { UIMotion } from '../../src/app/motion.js';
import {
  DAY, I, STATUS, UIAction, d, esc, formatInstant, humanShort, setHTML, stIcon, today,
} from './format.js';
import { App, D, epicById, epics, instanceNow, state, taskById, trackById, tracks, userById } from './model.js';
import { EPIC_TIP, hideEpicTip, mountRoadmapTip } from './overlays.js';

// ---------- geometry: one 32 px row, an 8 px rhythm, three type sizes ----------
/**
 * Every lane is built from one row: an epic's header, the line (done work,
 * and dated plans at their dates), then one row per task in progress. The
 * first row's middle lines up with the track's name.
 */
export const ROW = 32;
const PAD = 8, SECTION_GAP = 8;
/** An epic's box: its padding around its work, left and right, and below its last row. */
const BOX_PAD = 12, BOX_FOOT = 4;
const DOT = 6, RING = 12, HIT = 20, BAR_HIT = 20;
/** Titles stop at this width; a title shortened below LABEL_MIN is left out (its card has it). */
const TITLE_MAX = 240, LABEL_MIN = 100;
/** Bars a section shows before "+N in progress". */
const MAX_BARS = 3;
/** A bar is never shorter than this; without a deadline it fades out over OPEN_FADE; a late end is at least LATE_MIN. */
const MIN_BAR = 16, OPEN_FADE = 12, LATE_MIN = 8;
/** An epic with nothing on the timeline: its header alone, this far after now. */
const EPIC_GAP = 24;

// ---------- the model: tasks as day offsets ----------
/** The Roadmap's lanes of the project on screen, once its read has them. */
export const roadmapLanes = () => (D.roadmap?.projectId === state.projectId ? D.roadmap : null);

const instantDays = new Map();
/** The date and the share of its day of an instant, in the instance time zone. */
function instantDay(ms) {
  let parts = instantDays.get(ms);
  if (!parts) {
    const text = formatInstant(ms);
    const [h, m, s] = text.slice(11).split(':').map(Number);
    parts = { date: text.slice(0, 10), fraction: (h * 3600 + m * 60 + s) / 86400 };
    if (instantDays.size > 5000) instantDays.clear();
    instantDays.set(ms, parts);
  }
  return parts;
}
/** Day offsets from `start`: whole days for dates, fractions for times in the instance time zone. */
export function dayScale(start) {
  const base = +start;
  const ofDate = (date) => Math.round((d(date) - base) / DAY);
  const ofInstant = (ms) => { const { date, fraction } = instantDay(ms); return ofDate(date) + fraction; };
  return { ofDate, ofInstant };
}

export const isLate = (task) => !!task.deadline && task.state !== 'done' && d(task.deadline) < today;
const daysLate = (task) => Math.round((today - d(task.deadline)) / DAY);
const blockedOf = (task) => !!task.block && task.state !== 'done';
/** When work on a task started: when it first entered In Progress, or its last change for data from before that was kept. */
const startOf = (task) => task.startedAt ?? task.updatedAt;

/** A task as a mark: done at the day it finished, planned at its deadline, or a bar of work in progress. Plans without a date are not drawn. */
function taskItem(task, scale, now) {
  const blocked = blockedOf(task), late = isLate(task);
  if (task.state === 'done') return task.completedAt ? { kind: 'done', task, at: Math.min(scale.ofInstant(task.completedAt), now) } : null;
  if (task.state === 'planning') return task.deadline ? { kind: 'planned', task, at: scale.ofDate(task.deadline) + 0.5, blocked, late } : null;
  const from = Math.min(scale.ofInstant(startOf(task)), now);
  const end = task.deadline ? scale.ofDate(task.deadline) + 1 : null;
  return {
    kind: 'flight', task, from, blocked, late, open: end === null,
    to: late ? Math.max(from, end) : Math.max(from, end ?? now),
    slip: late ? [Math.max(from, end), now] : null,
  };
}

/** An epic with an end date sits on the time scale; one without is drawn from its work. */
export const epicDated = (epic) => !!epic?.end;

/** The tasks of the project on screen that its lanes draw. */
function laneTasks() {
  const lanes = roadmapLanes(), ids = new Set(lanes?.taskIds), tracked = new Set(tracks().map((track) => track.id));
  return lanes ? D.tasks.filter((task) => ids.has(task.internalId) && tracked.has(task.trackId)) : [];
}

/** The first and last dates the lanes' tasks reach: when work finished or started, and deadlines; null without any. */
export function laneDates() {
  let min = null, max = null;
  const take = (date) => { if (!min || date < min) min = date; if (!max || date > max) max = date; };
  for (const task of laneTasks()) {
    if (task.state === 'done') { if (task.completedAt) take(instantDay(task.completedAt).date); continue; }
    if (task.state !== 'planning') take(instantDay(startOf(task)).date);
    if (task.deadline) take(task.deadline);
  }
  return min && { min: d(min), max: d(max) };
}

/**
 * Each track's lane: its own work (tasks without an epic), then its epics by
 * start date, with their tasks. A track's head counts its work in progress
 * and its plans, dated or not, as the Board's columns do.
 */
export function laneModels(start) {
  const scale = dayScale(start), now = scale.ofInstant(instanceNow()), lanes = roadmapLanes();
  const byTrack = new Map(tracks().map((track) => [track.id, []]));
  for (const task of laneTasks()) byTrack.get(task.trackId).push(task);
  const all = epics();
  return {
    now, ready: !!lanes,
    lanes: tracks().map((track) => {
      const own = { epic: null, items: [] };
      const boxes = all.filter((epic) => epic.trackId === track.id).sort((a, b) => d(a.start) - d(b.start) || a.order - b.order)
        .map((epic) => ({ epic, items: [], ...(epicDated(epic) ? { from: scale.ofDate(epic.start), to: scale.ofDate(epic.end) + 1 } : { from: scale.ofDate(epic.start) }) }));
      for (const task of byTrack.get(track.id)) {
        const item = taskItem(task, scale, now);
        if (item) (boxes.find((box) => box.epic.id === task.epicId) || own).items.push(item);
      }
      const counts = lanes?.trackCounts[track.id] ?? { planning: 0, progress: 0, review: 0, done: 0 };
      return {
        track, sections: [own, ...boxes],
        flight: counts.progress + counts.review, planned: counts.planning,
        total: counts.planning + counts.progress + counts.review + counts.done,
      };
    }),
  };
}

// ---------- layout at one zoom level ----------
let measureContext = null, fontFamily = '';
const widths = new Map();
/** The width of `text` in `font` (such as "500 13px") in the app's sans-serif, measured once per text. */
export function textWidth(text, font) {
  const key = font + '|' + text;
  let width = widths.get(key);
  if (width === undefined) {
    if (measureContext === null) {
      measureContext = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('2d') || false : false;
      // Read once: reading a style during a zoom would make the browser work out styles again.
      fontFamily = measureContext ? getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'sans-serif' : '';
    }
    if (measureContext) {
      measureContext.font = `${font} ${fontFamily}`;
      width = Math.ceil(measureContext.measureText(text).width);
    } else {
      // Without a canvas, as in tests, a close estimate: about 0.55 em a character.
      width = Math.ceil(text.length * parseFloat(font.split(' ')[1]) * 0.55);
    }
    if (widths.size > 4000) widths.clear();
    widths.set(key, width);
  }
  return width;
}
const TITLE_FONT = '500 13px', SMALL_FONT = '500 12px';
const titleWidth = (task) => Math.min(TITLE_MAX, textWidth(task.title, TITLE_FONT));
const personOf = (task) => userById((task.assignees || []).find(userById));
const firstName = (task) => personOf(task)?.name.split(' ')[0] || '';
const dayText = (ms) => humanShort(d(formatInstant(ms).slice(0, 10)));
/** A count's span of days, for its list and its name. */
function countSpan(items, done) {
  const days = items.map((item) => done ? dayText(item.task.completedAt) : humanShort(d(item.task.deadline)));
  return days[0] === days[days.length - 1] ? days[0] : `${days[0]} – ${days[days.length - 1]}`;
}

/** Marks closer than they can be drawn merge into a count: one small number in the middle of what it holds. */
function cluster(items, ppd, size) {
  const groups = [];
  for (const item of items.slice().sort((a, b) => a.at - b.at)) {
    const x = item.at * ppd, group = groups[groups.length - 1];
    if (group && x - group.last < Math.max(size, 18) + 4) { group.items.push(item); group.last = x; continue; }
    groups.push({ items: [item], first: x, last: x });
  }
  for (const group of groups) {
    const mid = (group.first + group.last) / 2, half = group.items.length > 1 ? (String(group.items.length).length > 1 ? 12 : 9) : size / 2;
    Object.assign(group, { x: mid, extent: [mid - half, mid + half] });
  }
  return groups;
}

/** Which bars a section shows: late, then blocked, then the nearest deadline, then the oldest start. */
const dueKey = (item) => item.open ? Infinity : item.to;
const byUrgency = (a, b) => (b.late - a.late) || (b.blocked - a.blocked) || (dueKey(a) - dueKey(b)) || (a.from - b.from);

/**
 * A bar: a thin line from when work started to its deadline (red past it
 * when late, at least LATE_MIN), or to now, fading out, without one; never
 * shorter than MIN_BAR. Its icon and title lead it.
 */
function barGeometry(item, ppd) {
  const slipEnd = item.slip ? Math.round(item.slip[1] * ppd) : Math.round(item.to * ppd);
  const end = item.slip ? Math.min(Math.round(item.to * ppd), slipEnd - LATE_MIN) : slipEnd;
  const left = Math.min(Math.round(item.from * ppd), slipEnd - MIN_BAR);
  const solid = Math.max(0, end - left), slip = slipEnd - Math.max(end, left), fade = item.open ? OPEN_FADE : 0;
  return { left, solid, slip, fade, width: solid + slip + fade, lead: 13 + 6 + titleWidth(item.task) + 2 };
}

/** An epic's dates as its header shows them, when it has an end date. */
const epicDates = (epic) => epicDated(epic) ? `${humanShort(d(epic.start))} – ${humanShort(d(epic.end))}` : '';
/** An epic header's width: in full (title, dates if set, count and bar), and short (title and count). */
function epicHeadWidth(epic) {
  const progress = `${epic.done}/${epic.total}`, dates = epicDates(epic);
  const short = (epic.state === 'done' ? 20 : 0) + textWidth(epic.title, '600 13px') + 8 + textWidth(progress, SMALL_FONT) + 8;
  return { short, full: short + (dates ? textWidth(dates, SMALL_FONT) + 8 : 0) + (epic.total ? 40 : 0), dates, progress };
}

/** Whether an epic shows with nothing of its own on the timeline: while it has dates, or is not done. */
const epicShown = (section) => section.items.length || epicDated(section.epic) || section.epic.state !== 'done';

/**
 * The room the view keeps after now: the widest header of an epic with
 * nothing on the timeline, and, with nothing dated ahead, a little margin so
 * the work in progress ends clear of the edge.
 */
export function roomAfterNow(model, ahead) {
  const boxes = model.lanes.flatMap((lane) => lane.sections).filter((section) => section.epic && !epicDated(section.epic) && !section.items.length && epicShown(section))
    .map((section) => EPIC_GAP + 2 * BOX_PAD + epicHeadWidth(section.epic).full + 24);
  return Math.max(ahead ? 0 : 96, ...boxes);
}

/**
 * A section's rows, the same in every lane: the line (done work as dots and
 * counts, dated plans as rings at their dates, titled where there is room),
 * then one row per task in progress, at most three, then "+N in progress".
 */
function layoutSection(section, ppd, now) {
  const nowX = now * ppd, marks = [];
  for (const group of cluster(section.items.filter((item) => item.kind === 'done'), ppd, DOT)) marks.push({ type: group.items.length > 1 ? 'doneCluster' : 'done', row: 0, group, x: group.x, box: group.extent });
  for (const group of cluster(section.items.filter((item) => item.kind === 'planned'), ppd, RING)) {
    marks.push(group.items.length > 1
      ? { type: 'plannedCluster', row: 0, group, x: group.x, box: group.extent }
      : { type: 'planned', row: 0, item: group.items[0], x: group.x, box: group.extent });
  }
  const line = marks.length > 0, first = line ? 1 : 0;
  // A dated plan's title, where it fits before the next mark on the line.
  const onLine = marks.slice().sort((a, b) => a.box[0] - b.box[0]);
  onLine.forEach((mark, index) => {
    if (mark.type !== 'planned') return;
    const room = (onLine[index + 1]?.box[0] ?? Infinity) - 8 - (mark.box[1] + 8);
    const width = titleWidth(mark.item.task);
    if (room >= Math.min(width, LABEL_MIN)) mark.title = Math.min(width, room);
  });
  // Work in progress: a row each.
  const ranked = section.items.filter((item) => item.kind === 'flight').sort(byUrgency);
  const bars = ranked.slice(0, MAX_BARS).sort((a, b) => a.from - b.from || a.task.order - b.task.order), hidden = ranked.slice(MAX_BARS);
  bars.forEach((item, index) => marks.push({ type: 'bar', row: first + index, item, x: Math.round(item.from * ppd), ...barGeometry(item, ppd) }));
  if (hidden.length) {
    const label = `+${hidden.length} in ${hidden.every((item) => item.task.state === 'review') ? 'review' : 'progress'}`;
    const left = Math.min(...marks.filter((mark) => mark.type === 'bar').map((mark) => mark.left - mark.lead - 8));
    marks.push({ type: 'more', row: first + bars.length, items: hidden, x: left, left, width: textWidth(label, SMALL_FONT) + 4, label });
  }
  const rows = Math.max(first, ...marks.map((mark) => mark.row + 1));
  // The line joins its marks, solid before now and dotted after it; a single mark needs none.
  const xs = line ? marks.filter((mark) => mark.row === 0).map((mark) => mark.x) : [];
  const spine = xs.length > 1 ? { from: Math.min(...xs), to: Math.max(...xs) } : null;
  // An epic's box holds its dates, when it has them, and its work with its titles. Without an end date it
  // runs from its first work to now, at least as wide as its header; with nothing on the timeline it is
  // its header alone, just after now, or at its start when that is later.
  let span = null;
  if (section.epic) {
    const head = epicHeadWidth(section.epic).full;
    const starts = marks.map((mark) => mark.type === 'bar' ? mark.left - mark.lead - 8 : mark.box ? mark.box[0] : mark.left);
    const ends = [...marks.map((mark) => mark.type === 'bar' ? mark.left + mark.width : mark.title ? mark.box[1] + 8 + mark.title : mark.box ? mark.box[1] : mark.left + mark.width), ...(marks.length ? [nowX + 8] : [])];
    if (epicDated(section.epic)) { starts.push(section.from * ppd + BOX_PAD); ends.push(Math.max(section.from * ppd + 16, section.to * ppd) - BOX_PAD); }
    if (!starts.length) { const at = Math.max(nowX + EPIC_GAP, section.from * ppd) + BOX_PAD; starts.push(at); ends.push(at + head); }
    span = [Math.round(Math.min(...starts) - BOX_PAD), Math.round(Math.max(...ends) + BOX_PAD)];
    if (!epicDated(section.epic)) span[1] = Math.max(span[1], span[0] + Math.round(head) + 2 * BOX_PAD);
  }
  return { marks, rows, line, spine, span };
}

/** Where everything in a lane goes at `ppd`, and how tall the lane is. */
export function layoutLane(lane, ppd, now) {
  let top = PAD;
  const sections = [];
  for (const section of lane.sections) {
    if (section.epic ? !epicShown(section) : !section.items.length) continue;
    const laid = layoutSection(section, ppd, now);
    const head = section.epic ? ROW : 0, height = head + Math.max(laid.rows, section.epic ? 0 : 1) * ROW + (section.epic ? BOX_FOOT : 0);
    if (sections.length) top += SECTION_GAP;
    sections.push({ section, top, head, height, ...laid });
    top += height;
  }
  const blank = !sections.length;
  return { sections, height: (blank ? PAD + ROW : top) + PAD, blank };
}

// ---------- markup ----------
const RING_SVG = `<svg class="rt-ring" width="${RING}" height="${RING}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 1.9" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg>`;
const BLOCKED_SVG = `<svg class="rt-ring rt-ring-blocked" width="${RING}" height="${RING}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="5"/><path d="m2.8 2.8 6.4 6.4"/></svg>`;
/** Late: the error icon, in the danger color, in place of the status icon or ring; so late never relies on color alone. */
const lateIcon = (size) => `<svg class="rt-late-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.5v4.2" stroke="var(--surface-canvas)" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1.05" fill="var(--surface-canvas)"/></svg>`;
const navKey = (task) => `t:${task.id}`;
export const statusIcon = (task) => isLate(task) ? `<span class="rt-icon rt-icon-late">${lateIcon(13)}</span>` : blockedOf(task) ? `<span class="rt-icon rt-icon-blocked">${I.blocked}</span>` : `<span class="rt-icon">${stIcon(task.state)}</span>`;

/** What a screen reader hears for a task on the timeline: the same facts as its card. */
function taskLabel(task) {
  const epic = epicById(task.epicId), person = personOf(task);
  const parts = [task.title, blockedOf(task) ? `${STATUS[task.state]}, blocked` : STATUS[task.state]];
  if (epic) parts.push(`epic ${epic.title}`);
  if (task.state === 'done') parts.push(`done ${dayText(task.completedAt)}`);
  else if (task.state !== 'planning') parts.push(`started ${dayText(startOf(task))}`);
  if (task.deadline && task.state !== 'done') parts.push(`due ${humanShort(d(task.deadline))}${isLate(task) ? `, ${daysLate(task)} ${daysLate(task) === 1 ? 'day' : 'days'} late` : ''}`);
  if (person) parts.push(person.name);
  return parts.join(', ');
}

const px = (value) => `${Math.round(value)}px`;
/** Whole numbers joined with commas, for a data attribute. */
export const numbers = (...values) => values.map((value) => Math.round(value)).join(',');
/** The middle of a section's row, in the lane. */
const rowMid = (laid, row) => laid.top + laid.head + row * ROW + ROW / 2;
const tab = (focus, key) => `tabindex="${focus === key ? 0 : -1}"`;

function markHtml(laid, mark, focus) {
  const y = rowMid(laid, mark.row), boxed = laid.section.epic ? ' rt-in-box' : '';
  if (mark.type === 'done' || mark.type === 'planned') {
    const item = mark.group ? mark.group.items[0] : mark.item, task = item.task, x = mark.x, done = mark.type === 'done';
    const cls = ['rt-mark', done ? 'rt-done' : 'rt-planned', item.blocked ? 'rt-blocked' : '', item.late ? 'rt-late' : ''].filter(Boolean).join(' ') + boxed;
    // A dated plan's title: one line beside its ring; it hides rather than be cut.
    const title = mark.title ? `<span class="rt-tag" data-tag="${esc(numbers(mark.box[1] + 8, mark.box[1] + 8 + mark.title, x))}" data-least="${esc(numbers(Math.min(LABEL_MIN, mark.title)))}" style="left:${px(mark.box[1] + 8 - (x - HIT / 2))};width:${px(mark.title)}" aria-hidden="true">${esc(task.title)}</span>` : '';
    const face = done ? '<span class="rt-dot" aria-hidden="true"></span>' : item.late ? lateIcon(RING) : item.blocked ? BLOCKED_SVG : RING_SVG;
    return `<button type="button" class="${cls}" data-task="${esc(task.id)}" data-nav="${esc(navKey(task))}" ${tab(focus, navKey(task))} aria-label="${esc(taskLabel(task))}" style="left:${px(x - HIT / 2)};top:${px(y - HIT / 2)}">${face}${title}</button>`;
  }
  if (mark.type === 'doneCluster' || mark.type === 'plannedCluster') {
    const { items, extent } = mark.group, ids = items.map((item) => item.task.id);
    const key = `c:${ids[0]}`, done = mark.type === 'doneCluster', span = countSpan(items, done);
    const name = `${items.length} ${done ? 'done' : 'due'} · ${span}`, spoken = `${items.length} ${done ? 'done' : 'planned'} tasks, ${span}`;
    const tone = done ? '' : items.some((item) => item.late) ? ' rt-late' : items.some((item) => item.blocked) ? ' rt-blocked' : '';
    return `<button type="button" class="rt-count ${done ? 'rt-count-done' : 'rt-count-planned'}${tone}${boxed}" data-cluster="${esc(ids.join(' '))}" data-span="${esc(name)}" data-nav="${esc(key)}" ${tab(focus, key)} aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(spoken)}" style="left:${px(extent[0])};top:${px(y - 9)};width:${px(extent[1] - extent[0])}">${items.length}</button>`;
  }
  if (mark.type === 'more') {
    const ids = mark.items.map((item) => item.task.id), key = `f:${ids[0]}`;
    return `<button type="button" class="rt-more${boxed}" data-more="${esc(ids.join(' '))}" data-span="${esc(mark.label)}" data-left="${esc(numbers(mark.left))}" data-nav="${esc(key)}" ${tab(focus, key)} aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(`${mark.items.length} more in progress`)}" style="left:${px(mark.left)};top:${px(y - 10)}">${esc(mark.label)}</button>`;
  }
  // A bar: its icon and title lead a thin line; a firm end at its deadline (red past it when late), or a fade at now without one.
  const { item, left, width, solid, slip, fade, lead } = mark, task = item.task;
  const cls = ['rt-bar', `rt-${task.state}`, item.blocked ? 'rt-blocked' : '', item.late ? 'rt-late' : '', item.open ? 'rt-open' : ''].filter(Boolean).join(' ') + boxed;
  const parts = `<span class="rt-fill" aria-hidden="true"></span>${slip ? '<span class="rt-slip" aria-hidden="true"></span>' : ''}${fade ? '<span class="rt-tail" aria-hidden="true"></span>' : ''}`;
  // At the left edge the title moves onto its line, while some of the line still shows after it.
  const words = `<span class="rt-tag rt-lead" data-tag="${esc(numbers(left - 8 - lead, left - 8, left + 2))}" data-pin="${esc(numbers(left + width - 16))}" data-least="${esc(numbers(Math.min(lead, LABEL_MIN)))}" style="left:${px(-8 - lead)};width:${px(lead)}" aria-hidden="true">${statusIcon(task)}<span class="rt-title">${esc(task.title)}</span></span>`;
  return `<button type="button" class="${cls}" data-task="${esc(task.id)}" data-nav="${esc(navKey(task))}" ${tab(focus, navKey(task))} aria-label="${esc(taskLabel(task))}" style="left:${px(left)};top:${px(y - BAR_HIT / 2)};width:${px(width)};--solid:${px(solid)};--slip:${px(slip)};--fade:${px(fade)}">${parts}${words}</button>`;
}

/**
 * An epic: a softly tinted box with a hairline border around its work. Its
 * header names it, gives its dates when it has an end date, and its progress
 * ("0/3" and a short bar). The header follows the view's left edge; when all
 * of the box is off screen, a compact header at that edge points to it.
 */
function epicHtml(laid, focus) {
  const epic = laid.section.epic, [left, right] = laid.span, key = `e:${epic.id}`;
  const pct = epic.total ? Math.round((epic.done / epic.total) * 100) : 0;
  const { short, full, dates, progress } = epicHeadWidth(epic), compact = short + 20;
  return `<div class="rt-epic rt-epic-${esc(epic.state)}" data-epic-box="${esc(numbers(left, right, full, compact))}" style="left:${px(left)};top:${px(laid.top)};width:${px(right - left)};height:${px(laid.height)};--head-x:${px(BOX_PAD)}">
    <button type="button" class="rt-epic-label" data-epic="${esc(epic.id)}" data-nav="${esc(key)}" ${tab(focus, key)} ${UIAction('openPeek', epic.id)} aria-label="${esc(`Epic ${epic.title}, ${epic.done} of ${epic.total} tasks done${epic.state === 'done' ? ', complete' : dates ? `, ${dates}` : ''}`)}">${epic.state === 'done' ? I.check : ''}<span class="rt-epic-title">${esc(epic.title)}</span>${dates ? `<span class="rt-epic-dates">${esc(dates)}</span>` : ''}<span class="rt-epic-count">${progress}</span>${epic.total ? `<span class="rt-epic-prog" aria-hidden="true"><i style="width:${pct}%"></i></span>` : ''}</button></div>`;
}

/** The lane's items in keyboard order: each section from the top: its epic, its line by date, then its work by row. */
function laneOrder(layout) {
  const keys = [];
  for (const laid of layout.sections) {
    if (laid.section.epic) keys.push(`e:${laid.section.epic.id}`);
    for (const mark of laid.marks.slice().sort((a, b) => a.row - b.row || a.x - b.x)) keys.push(markKey(mark));
  }
  return keys;
}
const markItems = (mark) => mark.group ? mark.group.items : mark.items ? mark.items : [mark.item];
const markKey = (mark) => mark.type === 'more' ? `f:${mark.items[0].task.id}` : mark.group && mark.group.items.length > 1 ? `c:${mark.group.items[0].task.id}` : navKey(markItems(mark)[0].task);

/**
 * The key of the element that shows `key` at this zoom: the same task or
 * epic, or the count a task merged into, or the task a count split into.
 */
function resolveKey(layout, key) {
  if (!key) return null;
  if (laneOrder(layout).includes(key)) return key;
  if (!/^[tcf]:/.test(key)) return null;
  const id = key.slice(2), holder = layout.sections.flatMap((laid) => laid.marks).find((mark) => markItems(mark).some((item) => item.task.id === id));
  return holder ? markKey(holder) : null;
}

/** The item a lane's Tab stop starts on: the last one focused, else the first in progress, else the latest done. */
export function laneEntry(layout, remembered) {
  const known = resolveKey(layout, remembered);
  if (known) return known;
  const marks = layout.sections.flatMap((laid) => laid.marks);
  const flight = marks.find((mark) => mark.type === 'bar');
  if (flight) return markKey(flight);
  const done = marks.filter((mark) => mark.type === 'done' || mark.type === 'doneCluster').sort((a, b) => b.x - a.x)[0];
  if (done) return markKey(done);
  return laneOrder(layout)[0] || null;
}

/** A lane's timeline: each section's epic box, its line and its marks. */
export function laneBodyHtml(lane, layout, ppd, now, focus) {
  if (layout.blank) return `<div class="rt-empty-lane">${lane.total ? 'No dated work' : 'No tasks yet'}</div>`;
  const nowX = now * ppd;
  let html = '';
  for (const laid of layout.sections) {
    if (laid.section.epic) html += epicHtml(laid, focus);
    if (laid.spine) {
      const { from, to } = laid.spine, top = px(rowMid(laid, 0));
      const past = Math.min(to, nowX) - from, ahead = to - Math.max(from, nowX);
      if (past > 0) html += `<span class="rt-spine" aria-hidden="true" style="left:${px(from)};width:${px(past)};top:${top}"></span>`;
      if (ahead > 0) html += `<span class="rt-spine rt-spine-ahead" aria-hidden="true" style="left:${px(Math.max(from, nowX))};width:${px(ahead)};top:${top}"></span>`;
    }
    for (const mark of laid.marks) html += markHtml(laid, mark, focus);
  }
  return html;
}

/** A track's figures: how much it has in progress and planned, each left out at zero. */
export function headFigure(lane, ready) {
  if (!ready) return '<span class="skeleton rt-figure-skeleton" aria-hidden="true"></span><span class="sr-only">Loading tasks</span>';
  return [lane.flight ? `${lane.flight} in progress` : '', lane.planned ? `${lane.planned} planned` : ''].filter(Boolean).join(' · ');
}

// ---------- details: the card and lists ----------
/** The card, the same for every task: its status, title, track and epic, when it started (or was done), its deadline if it has one, and who. */
function taskTipHtml(task) {
  const epic = epicById(task.epicId), track = trackById(task.trackId), person = personOf(task);
  const status = `${statusIcon(task)}${blockedOf(task) ? 'Blocked' : STATUS[task.state]}`;
  const dates = [];
  if (task.state === 'done') dates.push(esc(`Done ${dayText(task.completedAt)}`));
  else if (task.state !== 'planning') dates.push(esc(`Started ${dayText(startOf(task))}`));
  if (task.deadline && task.state !== 'done') dates.push(`${esc(`Due ${humanShort(d(task.deadline))}`)}${isLate(task) ? ` · <span class="rt-tip-late">${daysLate(task)}d late</span>` : ''}`);
  const where = [track?.name, epic?.title].filter(Boolean).join(' · ');
  return `<div class="rt-tip-status">${status}</div>
    <div class="rt-tip-title">${esc(task.title)}</div>
    ${where ? `<div class="rt-tip-line">${esc(where)}</div>` : ''}
    ${dates.length ? `<div class="rt-tip-line">${dates.join(' · ')}</div>` : ''}
    ${person ? `<div class="rt-tip-line">${esc(person.name)}</div>` : ''}`;
}

/** The open list of a count or "+N in progress": its anchor, element and how it opened. */
const LIST = { el: null, anchor: null, hideTimer: 0, pinned: false };

export function closeTimelineList({ focusAnchor = false } = {}) {
  clearTimeout(LIST.hideTimer);
  if (!LIST.el) return;
  // Forget the list before removing it: removing it moves focus, and that closes it again.
  const { el, anchor } = LIST;
  Object.assign(LIST, { el: null, anchor: null, pinned: false });
  UIMotion.remove(el);
  anchor?.setAttribute('aria-expanded', 'false');
  if (focusAnchor && anchor?.isConnected) anchor.focus({ preventScroll: true });
}

/** One row for every list: icon, key, title, when (done, due, or started) and who. */
function listRows(list, kind) {
  // Done on one day: the time of day tells them apart, not the date.
  const days = new Set(kind === 'done' ? list.map((task) => formatInstant(task.completedAt).slice(0, 10)) : []);
  return list.map((task) => {
    const when = kind === 'done' ? (days.size === 1 ? formatInstant(task.completedAt).slice(11, 16) : dayText(task.completedAt))
      : task.deadline ? (isLate(task) ? `${daysLate(task)}d late` : humanShort(d(task.deadline))) : task.state === 'planning' ? '' : `since ${dayText(startOf(task))}`;
    return `<li><button type="button" class="rt-pop-row" ${UIAction('openTask', task.id)}>${statusIcon(task)}<span class="tid">${esc(task.id)}</span><span class="rt-pop-title">${esc(task.title)}</span><span class="rt-pop-when${isLate(task) && kind !== 'done' ? ' rt-late-text' : ''}">${esc(when)}</span><span class="rt-pop-who">${esc(firstName(task))}</span></button></li>`;
  }).join('');
}

function openList(anchor, { pinned, focusFirst = false }) {
  if (LIST.anchor === anchor && LIST.el) {
    if (pinned) LIST.pinned = true;
    if (focusFirst) LIST.el.querySelector('.rt-pop-row')?.focus();
    return;
  }
  closeTimelineList();
  hideEpicTip();
  const list = (anchor.dataset.cluster || anchor.dataset.more).split(' ').map(taskById).filter(Boolean);
  if (!list.length) return;
  const kind = anchor.dataset.more ? 'flight' : list[0].state === 'done' ? 'done' : 'planned';
  if (kind === 'done') list.sort((a, b) => b.completedAt - a.completedAt);
  const title = anchor.dataset.more ? `${list.length} more in progress` : anchor.dataset.span;
  const el = document.createElement('div');
  el.className = 'epic-tooltip rt-pop';
  el.id = 'roadmap-list';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  setHTML(el, `<div class="rt-pop-head">${esc(title)}</div><ul class="rt-pop-list">${listRows(list, kind)}</ul>`);
  document.body.append(el);
  Object.assign(LIST, { el, anchor, pinned });
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', el.id);
  const box = anchor.getBoundingClientRect(), width = el.offsetWidth, height = el.offsetHeight;
  const below = box.bottom + 8 + height <= innerHeight - 8;
  el.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
  el.style.top = `${Math.max(8, below ? box.bottom + 8 : box.top - height - 8)}px`;
  UIMotion.enter(el);
  el.addEventListener('pointerenter', () => clearTimeout(LIST.hideTimer));
  el.addEventListener('pointerleave', () => { if (!LIST.pinned) leaveList(); });
  el.addEventListener('keydown', (event) => {
    const rows = [...el.querySelectorAll('.rt-pop-row')], at = rows.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeTimelineList({ focusAnchor: true }); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus(); }
    else if (event.key === 'Tab') { event.preventDefault(); closeTimelineList({ focusAnchor: true }); }
  });
  el.addEventListener('focusout', (event) => { if (!el.contains(event.relatedTarget) && event.relatedTarget !== anchor) closeTimelineList(); });
  if (focusFirst) el.querySelector('.rt-pop-row')?.focus();
}
function leaveList() {
  clearTimeout(LIST.hideTimer);
  LIST.hideTimer = setTimeout(() => { if (!LIST.pinned && !LIST.el?.matches(':hover') && !LIST.el?.contains(document.activeElement) && document.activeElement !== LIST.anchor) closeTimelineList(); }, 160);
}

// The words the product uses for an epic's status.
export const epicStatus = (epic) => ({ planning: 'Planning', active: 'In progress', done: 'Done' })[epic.state] || epic.state;

/** An epic's card, as a task's: status, title, track, its dates, its progress. */
function epicTipHtml(epic) {
  const dates = epic.end ? `${humanShort(d(epic.start))} – ${humanShort(d(epic.end))}` : `From ${humanShort(d(epic.start))}`;
  return `<div class="rt-tip-status">Epic · ${esc(epicStatus(epic))}</div>
    <div class="rt-tip-title">${esc(epic.title)}</div>
    <div class="rt-tip-line">${esc(trackById(epic.trackId)?.name || '')}</div>
    <div class="rt-tip-line">${esc(dates)}</div>
    <div class="rt-tip-line">${esc(`${epic.done} of ${epic.total} tasks done`)}</div>`;
}

/** The card of the task or epic that `anchor` shows. */
function showCard(anchor) {
  const task = anchor.dataset.task ? taskById(anchor.dataset.task) : null, epic = task ? null : epicById(anchor.dataset.epic);
  if (!(task || epic) || !anchor.isConnected) return;
  closeTimelineList();
  mountRoadmapTip(anchor, task ? 'task-tooltip' : 'epic-tooltip', task ? taskTipHtml(task) : epicTipHtml(epic));
  EPIC_TIP.el?.classList.add('rt-tip');
}

// ---------- the view's edges: hide what they would cut ----------
/**
 * Text that the rail or the window's edge would cut is hidden, shortened or
 * moved instead. A bar's title moves onto its line at the left edge, and an
 * epic's header follows the left edge. Coordinates are the lanes'.
 */
export function syncLaneEdges(sc, rail) {
  const from = sc.scrollLeft + 2, to = sc.scrollLeft + sc.clientWidth - rail - 2;
  const pairs = (value) => value.split(',').map(Number);
  for (const tag of sc.querySelectorAll('.rt-body [data-tag]')) {
    const [left, right, anchor = Infinity] = pairs(tag.dataset.tag);
    // A bar's title whose start the rail covers moves to the view's edge, over its line, while some of the
    // line still shows after it; shortened to fit there, but not below its least.
    const least = Number(tag.dataset.least) || Infinity;
    const pin = Number(tag.dataset.pin) || 0, at = from + 6, room = pin - at;
    const shift = pin && left < from && room >= Math.min(right - left, least) ? at - left : 0;
    if (pin) { tag.style.transform = shift ? `translateX(${Math.round(shift)}px)` : ''; tag.classList.toggle('rt-pinned', !!shift); }
    // A title whose mark the rail covers would float alone: it hides with its mark.
    const orphan = !shift && anchor < from + 4;
    const cut = !shift && (left < from || right > to || orphan);
    const shorten = cut && !orphan && left >= from && to - left >= least;
    tag.dataset.width ??= tag.style.width;
    tag.style.width = shorten ? `${Math.floor(to - left)}px` : shift && room < right - left ? `${Math.floor(room)}px` : tag.dataset.width;
    tag.classList.toggle('rt-cut', cut && !shorten);
  }
  // "+N in progress" stays whole at the left edge, beside the titles that moved there.
  for (const more of sc.querySelectorAll('.rt-more')) {
    const shift = Math.max(0, from + 6 - Number(more.dataset.left));
    more.style.transform = shift ? `translateX(${Math.round(shift)}px)` : '';
  }
  for (const box of sc.querySelectorAll('[data-epic-box]')) {
    const [left, right, full, compact] = pairs(box.dataset.epicBox), label = box.querySelector('.rt-epic-label');
    // All of the box off screen, or too little of it for its title: a compact header at that edge points the
    // way it runs on. Else the header follows the view's left edge, drops its dates and bar where they don't
    // fit, and slides left to stay whole.
    const seen = Math.min(right, to) - Math.max(left, from), offLeft = left < from, offRight = right > to;
    const side = seen < compact + 8 && offLeft !== offRight ? (offLeft ? 'before' : 'after') : '';
    let x, short = false;
    if (side === 'before') x = from + 6 - left;
    else if (side === 'after') x = to - compact - left;
    else {
      x = Math.max(BOX_PAD, from + 6 - left);
      short = left + x + full > Math.min(to, right + 64);
      const width = short ? compact - 20 : full;
      if (left + x + width > to) x = Math.max(from + 6 - left, to - width - left);
    }
    box.style.setProperty('--head-x', `${Math.round(x)}px`);
    if ((label.dataset.side || '') !== side) { if (side) label.dataset.side = side; else delete label.dataset.side; }
    label.classList.toggle('rt-epic-short', short || !!side);
    label.classList.toggle('rt-cut', left + x < from - 1 || left + x + (side || short ? compact : full) > to + 24);
  }
}

// ---------- the mounted lanes: pointer and keyboard ----------
/** Each lane's last focused item, so Tab returns to it. */
export const laneFocus = new Map();

const fine = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const navItems = (lane) => [...lane.querySelectorAll('.rt-body [data-nav]')];
const OPENS_LIST = '[data-cluster],[data-more]';
const CARD = '[data-task],.rt-epic-label';
const DETAIL = `${CARD},${OPENS_LIST}`;

/** Move focus to `next`, which becomes its lane's Tab stop, and bring it into view. */
function moveFocus(sc, next, rail) {
  const lane = next.closest('.lane');
  for (const el of lane.querySelectorAll('[data-nav][tabindex="0"]')) el.tabIndex = -1;
  next.tabIndex = 0;
  laneFocus.set(lane.dataset.track, next.dataset.nav);
  const port = sc.getBoundingClientRect(), shown = next.getBoundingClientRect();
  const left = port.left + rail + 16, right = port.right - 16;
  if (shown.left < left) sc.scrollLeft -= left - shown.left;
  else if (shown.right > right) sc.scrollLeft += Math.min(shown.right - right, shown.left - left);
  next.focus({ preventScroll: true });
  const head = sc.querySelector('.rm-axis')?.offsetHeight || 0, view = sc.getBoundingClientRect(), box = next.getBoundingClientRect();
  if (box.top < view.top + head) sc.scrollTop -= view.top + head - box.top + 8;
  else if (box.bottom > view.bottom - 40) sc.scrollTop += box.bottom - view.bottom + 48;
}

/**
 * Focus what shows task `id` (its own mark, or the count or "+N" that holds
 * it), bring it into view and show its card. Returns whether it shows.
 */
export function focusTask(sc, id, rail) {
  const el = [...sc.querySelectorAll('.rt-body [data-nav]')].find((item) => item.dataset.task === id || (item.dataset.cluster || item.dataset.more || '').split(' ').includes(id));
  if (!el) return false;
  hideEpicTip(); closeTimelineList();
  moveFocus(sc, el, rail);
  if (el.dataset.task) showCard(el);
  return true;
}

/**
 * Hover, focus, click and keys for the lanes in `sc`. Returns a function
 * that removes them. Arrows move between a lane's items (Left, Right, Home,
 * End) and between lanes (Up, Down); Enter opens a task, an epic or a list.
 */
export function mountLanes(sc, rail) {
  const off = [];
  const on = (target, type, fn, options) => { target.addEventListener(type, fn, options); off.push(() => target.removeEventListener(type, fn, options)); };
  // A press focuses what it presses; its card shows on hover, so focus shows the card only without a press.
  let hoverTimer = 0, pressedAt = -Infinity;
  on(sc, 'pointerdown', (event) => { pressedAt = event.timeStamp; }, { passive: true });
  on(sc, 'scroll', () => { if (LIST.el && !LIST.el.contains(document.activeElement)) closeTimelineList(); }, { passive: true });
  on(sc, 'pointerover', (event) => {
    if (!fine()) return;
    const target = event.target.closest?.(DETAIL);
    if (!target || target.contains(event.relatedTarget)) return;
    clearTimeout(hoverTimer); clearTimeout(EPIC_TIP.hideTimer); clearTimeout(LIST.hideTimer);
    if (target.matches(OPENS_LIST)) { if (!LIST.pinned || LIST.anchor === target) hoverTimer = setTimeout(() => openList(target, { pinned: false }), 220); }
    else hoverTimer = setTimeout(() => showCard(target), 220);
  });
  on(sc, 'pointerout', (event) => {
    const target = event.target.closest?.(DETAIL);
    if (!target || target.contains(event.relatedTarget)) return;
    clearTimeout(hoverTimer);
    if (target.matches(OPENS_LIST)) { if (!LIST.pinned) leaveList(); }
    else App.epicLeave();
  });
  on(sc, 'focusin', (event) => {
    const target = event.target.closest?.('.rt-body [data-nav]');
    if (!target) return;
    const lane = target.closest('.lane');
    laneFocus.set(lane.dataset.track, target.dataset.nav);
    for (const el of lane.querySelectorAll('[data-nav][tabindex="0"]')) if (el !== target) el.tabIndex = -1;
    target.tabIndex = 0;
    if (event.timeStamp - pressedAt < 600) return;
    requestAnimationFrame(() => {
      if (document.activeElement !== target) return;
      if (target.matches(CARD)) showCard(target);
      else openList(target, { pinned: false });
    });
  });
  on(sc, 'focusout', (event) => {
    if (event.target.closest?.(CARD) && !EPIC_TIP.el?.contains(event.relatedTarget)) hideEpicTip();
  });
  on(document, 'pointerdown', (event) => {
    if (LIST.el && !LIST.el.contains(event.target) && !LIST.anchor?.contains(event.target)) closeTimelineList();
  });
  on(sc, 'click', (event) => {
    // A compact epic header points to its box off screen: a press brings the box into view instead of opening the epic.
    const pointer = event.target.closest?.('.rt-epic-label[data-side]');
    if (pointer) {
      event.preventDefault(); event.stopPropagation();
      const box = pointer.closest('.rt-epic'), room = sc.clientWidth - rail;
      sc.scrollTo({ left: Math.max(0, pointer.dataset.side === 'after' ? box.offsetLeft - 24 : box.offsetLeft + box.offsetWidth - room + 24), behavior: UIMotion.reduced() ? 'auto' : 'smooth' });
      return;
    }
    const target = event.target.closest?.(DETAIL);
    if (!target) return;
    clearTimeout(hoverTimer);
    hideEpicTip();
    if (target.dataset.task) { App.openTask(target.dataset.task); return; }
    if (target.matches(CARD)) return;
    if (LIST.anchor === target && LIST.pinned) { closeTimelineList(); return; }
    openList(target, { pinned: true, focusFirst: event.detail === 0 });
  });
  on(sc, 'keydown', (event) => {
    const target = event.target.closest?.('.rt-body [data-nav]');
    if (!target || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const lane = target.closest('.lane'), items = navItems(lane), at = items.indexOf(target);
    let next = null;
    if (event.key === 'ArrowRight') next = items[at + 1];
    else if (event.key === 'ArrowLeft') next = items[at - 1];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const lanes = [...sc.querySelectorAll('.lane')];
      for (let index = lanes.indexOf(lane) + (event.key === 'ArrowDown' ? 1 : -1); !next && index >= 0 && index < lanes.length; index += event.key === 'ArrowDown' ? 1 : -1) {
        const x = target.getBoundingClientRect().left;
        next = navItems(lanes[index]).sort((a, b) => Math.abs(a.getBoundingClientRect().left - x) - Math.abs(b.getBoundingClientRect().left - x))[0];
      }
    } else if (event.key === 'Escape' && LIST.el) { event.preventDefault(); closeTimelineList({ focusAnchor: true }); return; }
    else return;
    event.preventDefault();
    if (next) { hideEpicTip(); closeTimelineList(); moveFocus(sc, next, rail); }
  });
  return () => { for (const fn of off) fn(); clearTimeout(hoverTimer); closeTimelineList(); };
}
