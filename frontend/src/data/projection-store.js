// @ts-check

import {formatInstant, secondsToMilliseconds} from './time.js';
import {refreshPageWindow} from './page-window.js';
import {byStatus, toLegacyScope, toLegacyStatus} from './wire.js';

/**
 * Which session of which person `data` belongs to. Work started in one
 * session never lands in another.
 * @param {{session?:{id?:string|null,userId?:string}|null}} data
 */
export const sessionKey = (data) => `${data.session?.id ?? ''}:${data.session?.userId ?? ''}`;

/** Create the one mutable root consumed by the compatibility client. */
export function createLegacyData() {
  return {
    limits:/** @type {{maxAttachmentBytes:number,maxAvatarBytes:number,maxAttachmentsPerTask:number}|null} */(null), projectionGeneration:0, timeZone: 'UTC', users: [], projects: [], tracks: [], epics: [], milestones: [],
    tasks: [], pool: [], notifications: [], browserSessions: [], appGrants: [], session: null,
    inboxUnreadCount: 0, boardPageInfo: null, projectTaskCounts: {}, poolPageInfo: {}, bootstrapView:null, bootstrapProjectId:null, syncCursor:null,
    epicPageInfo: {}, adminUsers: { ids: [], nextCursor: null, loaded: false },
    roadmap: /** @type {RoadmapLanes|null} */ (null),
  };
}

function replace(array, next) {
  array.splice(0, array.length, ...next);
  return array;
}

/** An account as the server lists it, in the client's shape. */
export function mapUser(user) {
  return {
    id: user.id, username: user.username, name: user.name ?? user.displayName ?? user.username,
    admin: !!(user.isAdmin ?? user.admin), active: user.isActive !== false && user.active !== false,
    mustChange: !!user.mustChangePassword, avatar: user.avatarUrl ?? user.avatar ?? null, revision: user.revision,
  };
}

function mapMembership(membership) {
  const permissions = [];
  if (membership.manageRoadmap) permissions.push('manage_roadmap');
  if (membership.manageBoard) permissions.push('manage_board');
  return { userId: membership.userId, permissions, revision: membership.revision };
}

const text = (value) => value ?? '';
const orNull = (value) => value ?? null;
const orZero = (value) => value ?? 0;
const milliseconds = (value) => secondsToMilliseconds(value);
const millisecondsOrNull = (value) => secondsToMilliseconds(value) ?? null;

/**
 * Each entity's fields as [server name, client name, convert]. The client
 * keeps some names from its first version, such as `desc`. A read carries
 * every field, and a command result only the fields that changed.
 * @type {Record<string,[string,string?,((value:any)=>any)?][]>}
 */
const FIELDS = {
  project: [['name'], ['taskPrefix', 'key'], ['taskPrefix'], ['earlierPrefixes', 'earlierPrefixes', (prefixes) => [...(prefixes ?? [])]]],
  track: [['projectId'], ['name'], ['position', 'order']],
  epic: [
    ['projectId'], ['trackId'], ['title'], ['description', 'desc', text], ['startDate', 'start'], ['endDate', 'end', orNull], ['state'], ['position', 'order'],
    // Only Roadmap reads carry the task counts.
    ['taskDone', 'done', orZero], ['taskTotal', 'total', orZero], ['taskOpen', 'open'], ['completedThisWeek', 'closedThisWeek'], ['completedSinceStart'], ['weeklyCompletions', 'weekly'],
  ],
  milestone: [['projectId'], ['title', 'name'], ['description', 'desc', text], ['milestoneDate', 'date']],
  task: [
    ['projectId'], ['trackId'], ['epicId', 'epicId', orNull], ['taskKey', 'id'], ['title'], ['description', 'desc', text], ['status', 'state', toLegacyStatus], ['position', 'order'],
    ['deadline', 'deadline', orNull], ['createdAt', 'created', milliseconds], ['updatedAt', 'updatedAt', milliseconds], ['startedAt', 'startedAt', millisecondsOrNull], ['completedAt', 'completedAt', millisecondsOrNull],
    ['completionOrder', 'completionOrder', orNull], ['assigneeIds', 'assignees', (ids) => [...(ids ?? [])]], ['activeBlock', 'block', (block) => mapBlock(block)],
    // Only detail reads carry the checklist; every read carries its counts and version.
    ['checklistVersion', 'checklistVersion', orZero], ['checklistDone', 'checklistDone', orZero], ['checklistTotal', 'checklistTotal', orZero],
    ['checklist', 'checklist', (items) => items?.map(mapChecklistItem)],
  ],
  checklistItem: [['taskId'], ['title'], ['done']],
  poolItem: [['projectId'], ['scope', 'scope', toLegacyScope], ['ownerUserId', 'ownerId', orNull], ['title'], ['description', 'desc', text], ['createdAt', 'created', milliseconds]],
  taskBlock: [['reason'], ['createdBy', 'by'], ['createdAt', 'at', milliseconds], ['mentions', 'mentions', (mentions) => mentions ?? []], ['resolution', 'resolution', orNull]],
};

/** The client's name of an entity's field. @param {string} entityType @param {string} field */
export const clientField = (entityType, field) => FIELDS[entityType]?.find(([wire]) => wire === field)?.[1] ?? field;

/**
 * An entity from a read, in the client's shape.
 * @param {string} entityType @param {any} view @returns {any}
 */
function fromWire(entityType, view) {
  /** @type {any} */
  const item = { id: view.id };
  for (const [wire, client = wire, convert = (value) => value] of FIELDS[entityType]) item[client] = convert(view[wire]);
  item.revision = view.revision;
  return item;
}

function mapProject(project, memberships) {
  return { ...fromWire('project', project), members: memberships.filter((item) => item.projectId === project.id).map(mapMembership) };
}

const mapTrack = (track) => fromWire('track', track);

function mapEpic(epic) {
  return { ...fromWire('epic', epic), counted: epic.taskTotal !== undefined, activity: [] };
}

/** Only Roadmap reads carry epic task counts; other reads keep the last ones known. */
function keepEpicCounts(mapped, view, previous) {
  if (view.taskTotal !== undefined || !previous) return mapped;
  for (const key of ['done','total','open','closedThisWeek','completedSinceStart','weekly','counted']) mapped[key] = previous[key];
  return mapped;
}

const mapMilestone = (milestone) => fromWire('milestone', milestone);

function mapBlock(block) {
  return block ? fromWire('taskBlock', block) : null;
}

const mapChecklistItem = (item) => fromWire('checklistItem', item);

function mapTask(task) {
  return {
    internalId: task.id, ...fromWire('task', task), detailsLoaded: typeof task.description === 'string',
    attachments: task.attachments ?? [], comments: task.comments ?? [], activity: task.activity ?? [],
  };
}

const mapPoolItem = (item) => fromWire('poolItem', item);

/** @param {{revision?:number}|null|undefined} existing @param {{revision?:number}|null|undefined} incoming */
function isOlder(existing, incoming) {
  return Number.isFinite(existing?.revision) && Number.isFinite(incoming?.revision) && incoming.revision < existing.revision;
}

/** The fields of a task's checklist, which its version orders. */
const CHECKLIST_FIELDS = ['checklistVersion', 'checklistDone', 'checklistTotal', 'checklist'];

/**
 * Give `target` the checklist that a task keeps when `incoming` brings one for
 * it, as the client shows it in `current`. A checklist change leaves the
 * task's revision as it is, so only the checklist's version tells which is
 * newer: an older checklist never replaces one with its items, and a card,
 * which has no items, keeps those of the same version.
 * @param {any} target @param {any} current @param {any} incoming
 */
function keepNewerChecklist(target, current, incoming) {
  const { checklist: items, checklistVersion: version } = current;
  const older = Number.isFinite(version) && Number.isFinite(incoming.checklistVersion) && incoming.checklistVersion < version;
  const source = older && (items || !incoming.checklist) ? current : incoming;
  for (const key of CHECKLIST_FIELDS) target[key] = source[key];
  if (!target.checklist && target.checklistVersion === version) target.checklist = items;
}

function retainTaskDetails(previous, mapped) {
  if (isOlder(previous, mapped)) return previous;
  if (!previous) return mapped;
  keepNewerChecklist(mapped, previous, mapped);
  // A card has no description either; it keeps the one of the same revision,
  // and has its details once it has the checklist's items too.
  if(!mapped.detailsLoaded&&previous.detailsLoaded&&previous.revision===mapped.revision&&mapped.checklist){mapped.desc=previous.desc;mapped.detailsLoaded=true;}
  for (const key of ['attachments','comments','activity']) if (previous[key]) mapped[key]=previous[key];
  return mapped;
}

export function replaceBoardTasks(data, projectId, taskViews) {
  const previous=new Map(data.tasks.map((item)=>[item.internalId,item]));
  const retained=data.tasks.filter((item)=>item.projectId!==projectId);
  const mapped=taskViews.map((item)=>retainTaskDetails(previous.get(item.id),mapTask(item)));
  replace(data.tasks,[...retained,...mapped]);return data;
}

export function appendBoardTasks(data, taskViews) {
  const byId=new Map(data.tasks.map((item)=>[item.internalId,item]));
  for(const view of taskViews)byId.set(view.id,retainTaskDetails(byId.get(view.id),mapTask(view)));
  const doneOrder=data.boardPageInfo?.filters?.doneOrder;
  replace(data.tasks,[...byId.values()].sort((left,right)=>compareTaskOrder(left,right,doneOrder)));return data;
}

/**
 * Match the server's order within each column: position, then opaque ID. A
 * newest-first Done orders by completion time, newest first, then by
 * completion order and ID the other way round; a task without a completion
 * time comes last. Done tasks then sort after all others, so the order stays
 * consistent across columns.
 * @param {{order:number,internalId:string,state?:string,completedAt?:number|null,completionOrder?:number|null}} left
 * @param {{order:number,internalId:string,state?:string,completedAt?:number|null,completionOrder?:number|null}} right
 * @param {string} [doneOrder]
 */
export function compareTaskOrder(left, right, doneOrder) {
  const byId=left.internalId < right.internalId ? -1 : left.internalId > right.internalId ? 1 : 0;
  if(doneOrder==='completed'){
    const leftDone=left.state==='done',rightDone=right.state==='done';
    if(leftDone!==rightDone)return leftDone?1:-1;
    if(leftDone)return (right.completedAt??-1)-(left.completedAt??-1) || (right.completionOrder??0)-(left.completionOrder??0) || -byId;
  }
  return left.order-right.order || byId;
}

export function mergeEpicTaskPage(data, epicId, taskViews, page, append=false) {
  const byId=new Map(data.tasks.map((item)=>[item.internalId,item]));
  for(const view of taskViews)byId.set(view.id,retainTaskDetails(byId.get(view.id),mapTask(view)));
  replace(data.tasks,[...byId.values()]);
  const current=data.epicPageInfo[epicId]??{taskIds:[],tasksCursor:null,tasksTotal:0,activityCursor:null,loaded:false};
  const taskIds=append?[...current.taskIds]:[];
  const seen=new Set(taskIds);
  for(const view of taskViews)if(!seen.has(view.id)){seen.add(view.id);taskIds.push(view.id);}
  data.epicPageInfo[epicId]={...current,taskIds,tasksCursor:page.nextCursor??null,tasksTotal:Number(page.total??taskIds.length),loaded:true};
  return data.epicPageInfo[epicId];
}

export function mergeEpicActivityPage(data, epicId, items, nextCursor, append=false) {
  const epic=data.epics.find((item)=>item.id===epicId);
  if(!epic)return null;
  const previous=data.epicPageInfo[epicId];
  const retained=append?epic.activity:refreshPageWindow(epic.activity??[],items,!!nextCursor,item=>item.ts);
  const byId=new Map(retained.map((item)=>[item.id,item]));
  for(const item of items)if(item)byId.set(item.id,item);
  epic.activity=[...byId.values()].sort((left,right)=>left.ts-right.ts||String(left.id).localeCompare(String(right.id)));
  const current=data.epicPageInfo[epicId]??{taskIds:[],tasksCursor:null,tasksTotal:0,activityCursor:null,loaded:false};
  data.epicPageInfo[epicId]={...current,activityLoaded:true,activityCursor:!append&&previous?.activityLoaded&&nextCursor?previous.activityCursor:nextCursor??null,loaded:true};
  return data.epicPageInfo[epicId];
}

export function mergeAdminUsersPage(data, accounts, {append=false,nextCursor=null}={}) {
  data.peopleVersion=(data.peopleVersion??0)+1;
  const byId=new Map(data.users.map((item)=>[item.id,item]));
  for(const account of accounts)byId.set(account.id,{...byId.get(account.id),...account});
  replace(data.users,[...byId.values()]);
  const ids=append?[...data.adminUsers.ids]:[];
  const seen=new Set(ids);
  for(const account of accounts)if(!seen.has(account.id)){seen.add(account.id);ids.push(account.id);}
  data.adminUsers={ids,nextCursor,loaded:true};
  return data.adminUsers;
}

/**
 * A project's tracks, epics and milestones, and its Roadmap's lanes when the
 * read has them: for the days of a view, or, after a change made elsewhere,
 * for the tasks it `named`, with the `sections` whose work in progress they
 * were drawn in.
 * @param {any} data @param {any} projection @param {string[]} [named] @param {string[]} [sections]
 */
export function replaceRoadmap(data, projection, named = [], sections = []) {
  const projectId=projection.projectId ?? projection.tracks?.[0]?.projectId ?? projection.epics?.[0]?.projectId ?? projection.milestones?.[0]?.projectId;
  if(!projectId)return data;
  const history=new Map(data.epics.map((/** @type {ReturnType<typeof mapEpic>} */ item)=>[item.id,item.activity]));
  const epics=(projection.epics??[]).map((/** @type {{id:string}} */ view)=>({...mapEpic(view),activity:history.get(view.id)??[]}));
  // A read of the tasks a change named has the epics it changed alone, and leaves the tracks and milestones be.
  if(projection.lanes?.tasks){
    const changed=new Set(epics.map((/** @type {{id:string}} */ epic)=>epic.id));
    replace(data.epics,[...data.epics.filter((item)=>!changed.has(item.id)),...epics]);
    patchRoadmapLanes(data,projectId,projection.lanes,named,sections);
    return data;
  }
  replace(data.tracks,[...data.tracks.filter((item)=>item.projectId!==projectId),...(projection.tracks??[]).map(mapTrack)]);
  replace(data.epics,[...data.epics.filter((item)=>item.projectId!==projectId),...epics]);
  replace(data.milestones,[...data.milestones.filter((item)=>item.projectId!==projectId),...(projection.milestones??[]).map(mapMilestone)]);
  if(projection.lanes)replaceRoadmapLanes(data,projectId,projection.lanes);
  return data;
}

/** The most tasks one read of the lanes' changed tasks names. */
export const NAMED_TASKS_LIMIT = 50;

/**
 * @typedef {{planning:number,progress:number,review:number,done:number}} StatusCounts
 * @typedef {{done:number,plans:number,blocked:number}} DayCounts
 * @typedef {{internalId:string,id:string,projectId:string,trackId:string,epicId:string|null,title:string,state:string,deadline:string|null,startedAt:number|null,completedAt:number|null,assignees:string[],block:{}|null,day:string|null}} RoadmapMark
 * @typedef {{from:string,to:string,anchor?:string}} RoadmapDaysWanted
 * @typedef {{projectId:string,window:{from:string,to:string},shown:RoadmapDaysWanted|null,sections:Record<string,StatusCounts>,trackCounts:Record<string,StatusCounts>,overdue:number,firstDay:string|null,lastDay:string|null,open:string[],late:RoadmapMark[],days:Record<string,Record<string,DayCounts>>,marks:Record<string,RoadmapMark>}} RoadmapLanes
 * What the Roadmap's lanes draw and count. `open` is the work in progress
 * they draw, which `data.tasks` holds. `days` counts each section's done
 * tasks and dated plans by day for the days of `window`, and `marks` holds,
 * by ID, the task of a day that has one, as far as the reads gave them.
 * `shown` is the days the view shows, with some to spare, which a read of
 * the lanes asks for again. `sections` counts each track's own work, keyed
 * `trackId/`, and each epic, keyed `trackId/epicId`.
 */

/** The key of a track's own work, or of one of its epics, in `sections` and `days`. @param {string} trackId @param {string|null|undefined} epicId */
export const sectionKey = (trackId, epicId) => `${trackId}/${epicId ?? ''}`;

/** The day `count` days after `day`, both `YYYY-MM-DD`. @param {string} day @param {number} count */
const dayAfter = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);

/** Put a read's tasks among the projection's, each with the details it already had. */
function mergeTasks(data, taskViews) {
  const byId=new Map(data.tasks.map((item)=>[item.internalId,item]));
  for(const view of taskViews)byId.set(view.id,retainTaskDetails(byId.get(view.id),mapTask(view)));
  replace(data.tasks,[...byId.values()]);
}

/**
 * A task as the lanes' marks show it, from a mark or a task of a read: on
 * the day it was done, or is due.
 * @param {any} data @param {any} view @returns {RoadmapMark}
 */
export function mapRoadmapMark(data, view) {
  const state=toLegacyStatus(view.status),completedAt=secondsToMilliseconds(view.completedAt)??null;
  return {
    internalId:view.id,id:view.taskKey,projectId:view.projectId??data.roadmap?.projectId,trackId:view.trackId,epicId:view.epicId??null,title:view.title,state,
    deadline:view.deadline??null,startedAt:secondsToMilliseconds(view.startedAt)??null,completedAt,assignees:[...(view.assigneeIds??[])],
    block:view.blocked||view.activeBlock?{}:null,
    day:state==='done'?(completedAt===null?null:formatInstant(completedAt,data.timeZone||'UTC',()=>{}).slice(0,10)):view.deadline??null,
  };
}

/**
 * The Roadmap's lanes from a Roadmap read.
 * @param {any} data @param {string} projectId @param {any} timeline
 */
function replaceRoadmapLanes(data, projectId, timeline) {
  mergeTasks(data,timeline.open);
  const previous=data.roadmap?.projectId===projectId?data.roadmap:null;
  /** @type {RoadmapLanes} */
  const lanes={
    projectId,window:{from:timeline.days.from,to:timeline.days.to},shown:previous?.shown??null,
    open:timeline.open.map((/** @type {{id:string}} */ view)=>view.id),late:[],days:{},marks:{},
    ...laneCounts(timeline),
  };
  data.roadmap=lanes;
  lanes.late=timeline.late.map((/** @type {any} */ view)=>mapRoadmapMark(data,view));
  applyDays(data,lanes,timeline.days,true);
  return lanes;
}

/**
 * Add a read of days to the Roadmap's lanes of `projectId`. Days next to
 * the ones they hold join them; others, as after a jump, take their place.
 * @param {any} data @param {string} projectId @param {any} days
 */
export function appendRoadmapDays(data, projectId, days) {
  const lanes=data.roadmap;
  if(lanes?.projectId!==projectId)return null;
  const next=dayAfter(lanes.window.to,1)>=days.from&&dayAfter(days.to,1)>=lanes.window.from;
  applyDays(data,lanes,days,!next);
  return lanes;
}

/**
 * The days of a read in the lanes: what they held of those days goes, and
 * with `alone`, everything they held.
 * @param {any} data @param {RoadmapLanes} lanes @param {any} days @param {boolean} alone
 */
function applyDays(data, lanes, days, alone) {
  const {from,to}=days;
  if(alone){lanes.days={};lanes.marks={};lanes.window={from,to};}
  else{
    lanes.window={from:from<lanes.window.from?from:lanes.window.from,to:to>lanes.window.to?to:lanes.window.to};
    for(const counts of Object.values(lanes.days))for(const day of Object.keys(counts))if(day>=from&&day<=to)delete counts[day];
    for(const [id,mark] of Object.entries(lanes.marks))if(mark.day&&mark.day>=from&&mark.day<=to)delete lanes.marks[id];
  }
  addDays(data,lanes,days);
}

/** Each section's counts and marks of a read of days, in the lanes. @param {any} data @param {RoadmapLanes} lanes @param {any} days */
function addDays(data, lanes, days) {
  for(const section of days.sections){
    const held=lanes.days[sectionKey(section.trackId,section.epicId)]??={};
    const done=section.done??[],plans=section.plans??[],blocked=section.blocked??[];
    for(let index=0;index<Math.max(done.length,plans.length);index++){
      if(done[index]||plans[index])held[dayAfter(days.from,index)]={done:done[index]??0,plans:plans[index]??0,blocked:blocked[index]??0};
    }
    // The tasks of its days with one: the section names their track and epic.
    for(const view of section.marks??[])lanes.marks[view.id]=mapRoadmapMark(data,{...view,trackId:section.trackId,epicId:section.epicId});
  }
}

/**
 * The sections a read of named tasks changed: the ones it names, and the
 * ones its tasks are in now. Their work in progress and days came again.
 * @param {any} timeline @param {string[]} sections
 */
export function changedSections(timeline, sections) {
  return new Set([...sections,...[...timeline.open,...(timeline.tasks??[])].map((/** @type {any} */ view)=>sectionKey(view.trackId,view.epicId))]);
}

/**
 * A change made elsewhere in the Roadmap's lanes: their counts, and their
 * longest overdue when they came, the tasks it `named`, and the work in
 * progress and the days the lanes hold of the `sections` it may have
 * changed and of the ones the named tasks are in now. The other sections
 * stay as they are.
 * @param {any} data @param {string} projectId @param {any} timeline @param {string[]} named @param {string[]} sections
 */
function patchRoadmapLanes(data, projectId, timeline, named, sections) {
  const lanes=data.roadmap;
  if(lanes?.projectId!==projectId)return null;
  mergeTasks(data,[...timeline.open,...timeline.tasks]);
  const changed=changedSections(timeline,sections),renamed=new Set(named),byId=new Map(data.tasks.map((item)=>[item.internalId,item]));
  lanes.open=[...lanes.open.filter((id)=>{const task=byId.get(id);return task&&!renamed.has(id)&&!changed.has(sectionKey(task.trackId,task.epicId));}),...timeline.open.map((/** @type {{id:string}} */ view)=>view.id)];
  const {from,to}=timeline.days;
  for(const key of changed)for(const day of Object.keys(lanes.days[key]??{}))if(day>=from&&day<=to)delete lanes.days[key][day];
  addDays(data,lanes,timeline.days);
  // The days come as counts alone: a mark the lanes hold stays while its day still has that one task.
  for(const [id,mark] of Object.entries(lanes.marks)){
    const counts=mark.day?lanes.days[sectionKey(mark.trackId,mark.epicId)]?.[mark.day]:null;
    if(renamed.has(id)||!counts||(mark.state==='done'?counts.done:counts.plans)!==1)delete lanes.marks[id];
  }
  for(const view of timeline.tasks)if(view.status==='done'||view.status==='planning'&&view.deadline)lanes.marks[view.id]=mapRoadmapMark(data,view);
  Object.assign(lanes,laneCounts(timeline));
  // The longest overdue come when they may have changed.
  if(timeline.late)lanes.late=timeline.late.map((/** @type {any} */ view)=>mapRoadmapMark(data,view));
  return lanes;
}

/**
 * What a read of the lanes counts: each section by status, each track by
 * adding its sections up, what is overdue, and the days the project's work
 * spans.
 * @param {{sections:{trackId:string,epicId:string|null,planning:number,inProgress:number,inReview:number,done:number}[],overdue:number,firstDay:string|null,lastDay:string|null}} timeline
 */
function laneCounts(timeline) {
  /** @type {Record<string,StatusCounts>} */ const sections={};
  /** @type {Record<string,StatusCounts>} */ const trackCounts={};
  for(const counts of timeline.sections){
    const mapped={planning:counts.planning,progress:counts.inProgress,review:counts.inReview,done:counts.done};
    sections[sectionKey(counts.trackId,counts.epicId)]=mapped;
    const track=trackCounts[counts.trackId]??={planning:0,progress:0,review:0,done:0};
    for(const [status,count] of Object.entries(mapped))track[/** @type {keyof StatusCounts} */ (status)]+=count;
  }
  return {sections,trackCounts,overdue:timeline.overdue,firstDay:timeline.firstDay??null,lastDay:timeline.lastDay??null};
}

export function replacePoolPage(data, projectId, scope, itemViews, append=false) {
  const legacyScope=toLegacyScope(scope);
  const keep=append?data.pool:[...data.pool.filter((item)=>item.projectId!==projectId||item.scope!==legacyScope)];
  const byId=new Map(keep.map((item)=>[item.id,item]));
  for(const item of itemViews)byId.set(item.id,mapPoolItem(item));
  replace(data.pool,[...byId.values()]);return data;
}

export function setBoardPageInfo(data, projectId, filters, pages) {
  data.boardPageInfo={projectId,filters:{...filters},pages};
  return data.boardPageInfo;
}

export function setProjectTaskCounts(data,projectId,{planning=0,progress=0,review=0,done=0,blocked=0}={}){
  data.projectTaskCounts[projectId]={planning,progress,review,done,blocked,open:planning+progress+review};
  return data.projectTaskCounts[projectId];
}

export function setPoolPageInfo(data,projectId,scope,page){
  const legacyScope=toLegacyScope(scope);
  data.poolPageInfo[`${projectId}:${legacyScope}`]={nextCursor:page.nextCursor??null,total:Number(page.total??0),loaded:true};
  return data.poolPageInfo[`${projectId}:${legacyScope}`];
}

export function replaceTaskDetail(data, taskView) {
  const index=data.tasks.findIndex((item)=>item.internalId===taskView.id||item.id===taskView.taskKey);
  const mapped=retainTaskDetails(index>=0?data.tasks[index]:null,mapTask(taskView));
  if(index>=0)data.tasks.splice(index,1,mapped);else data.tasks.push(mapped);
  return mapped;
}

/** Mutate the stable data root so legacy modules never retain a stale object. */
export function hydrateLegacyData(data, bootstrap, auth = null) {
  if (!data || !bootstrap) throw new TypeError('Expected data and bootstrap projections');
  data.peopleVersion=(data.peopleVersion??0)+1;
  data.projectionGeneration=(data.projectionGeneration??0)+1;
  const previousSession=data.session;
  const previousTasks=new Map(data.tasks.map(task=>[task.internalId,task]));
  const memberships = bootstrap.memberships ?? [];
  const identity = auth?.user ?? bootstrap.session;
  const sameUser=previousSession?.userId===(identity?.id??identity?.userId);
  const history=new Map((sameUser?data.epics:[]).map((/** @type {ReturnType<typeof mapEpic>} */ item)=>[item.id,item]));
  // A bootstrap lists only the selected project's people. An administrator's
  // loaded account pages stay until the Users or Settings page reloads them.
  const directory=sameUser&&identity?.isAdmin&&data.adminUsers?.loaded?data.adminUsers:null;
  const listed=new Map(directory?data.users.filter((/** @type {{id:string}} */ user)=>directory.ids.includes(user.id)).map((/** @type {{id:string}} */ user)=>[user.id,user]):[]);
  data.timeZone = bootstrap.timeZone || 'UTC';
  data.limits = bootstrap.limits ?? null;
  replace(data.users, (bootstrap.users ?? []).map(mapUser));
  for (const [id, user] of listed) if (!data.users.some((item) => item.id === id)) data.users.push(user);
  replace(data.projects, (bootstrap.projects ?? []).map((project) => {
    const mapped=mapProject(project,memberships),actorId=identity?.id??identity?.userId;
    // Other accessible projects carry actor capabilities, not their member lists.
    if(actorId&&!identity?.isAdmin&&!mapped.members.some(member=>member.userId===actorId)){
      mapped.members.push(mapMembership({...project,userId:actorId,revision:null}));
    }
    return mapped;
  }));
  replace(data.tracks, (bootstrap.tracks ?? []).map(mapTrack));
  replace(data.epics, (bootstrap.epics ?? []).map((/** @type {{id:string,taskTotal?:number}} */ view)=>keepEpicCounts({...mapEpic(view),activity:history.get(view.id)?.activity??[]},view,history.get(view.id))));
  replace(data.milestones, (bootstrap.milestones ?? []).map(mapMilestone));
  replace(data.tasks, (bootstrap.tasks ?? []).map(view=>retainTaskDetails(sameUser?previousTasks.get(view.id):null,mapTask(view))));
  // An epic drawer keeps its loaded tasks until it reads them again. Board
  // cards must match the Board's loaded window, so a bootstrap that carries
  // them keeps no other tasks.
  const epicPages=sameUser?Object.entries(data.epicPageInfo??{}).filter(([id])=>data.epics.some((/** @type {{id:string}} */ item)=>item.id===id)):[];
  if(!Object.keys(bootstrap.boardPages??{}).length)for(const [,page] of epicPages)for(const id of page.taskIds??[]){
    const kept=previousTasks.get(id);
    if(kept&&!data.tasks.some((item)=>item.internalId===id)&&data.projects.some((project)=>project.id===kept.projectId))data.tasks.push(kept);
  }
  // The Pool, Inbox, sessions and app grants load with their own reads; only
  // drop Pool items this person can no longer see.
  replace(data.pool,data.pool.filter(item=>data.projects.some(project=>project.id===item.projectId)&&(item.scope!=='mine'||item.ownerId===(identity?.id??identity?.userId))));
  data.inboxUnreadCount=Number(bootstrap.inboxUnreadCount??0);
  data.boardPageInfo=null;
  data.roadmap=null;
  data.projectTaskCounts={};
  data.poolPageInfo={};
  data.bootstrapView=bootstrap.view??null;data.syncCursor=bootstrap.syncCursor??null;
  // The project whose tracks, epics, milestones and people the bootstrap loaded.
  data.bootstrapProjectId=bootstrap.selectedProjectId??null;
  const projectId=data.bootstrapProjectId;
  if(projectId&&bootstrap.boardCounts)setProjectTaskCounts(data,projectId,byStatus(bootstrap.boardCounts));
  if(projectId&&Object.keys(bootstrap.boardPages??{}).length){
    const pages=Object.fromEntries(Object.entries(bootstrap.boardPages).map(([status,page])=>[toLegacyStatus(status),page]));
    // The pages are a Board read's for the filter and Done order they name.
    const {doneOrder,...filter}=bootstrap.boardFilter??{};
    setBoardPageInfo(data,projectId,{...filter,...(doneOrder==='completed'?{doneOrder}:{})},pages);
  }
  if(projectId&&bootstrap.roadmap)replaceRoadmapLanes(data,projectId,bootstrap.roadmap);
  if(projectId&&bootstrap.poolCounts)for(const scope of ['personal','team']){
    const page=setPoolPageInfo(data,projectId,scope,{total:bootstrap.poolCounts[scope]??0});page.loaded=false;
  }
  data.epicPageInfo=Object.fromEntries(epicPages);
  data.adminUsers=directory??{ids:[],nextCursor:null,loaded:false};
  data.session = identity ? {
    id: auth?.sessionId ?? bootstrap.sessionId ?? previousSession?.id ?? null,
    userId: identity.id ?? identity.userId,
    authenticatedAt: secondsToMilliseconds(auth?.authenticatedAt ?? bootstrap.authenticatedAt) ?? previousSession?.authenticatedAt,
    temporary: !!auth?.mustChangePassword,
  } : null;
  return data;
}

/** Apply authentication before a full projection is available (including forced password change). */
export function applyAuthSession(data, auth) {
  if (!auth?.user) { data.session = null; return data; }
  const user = {
    id: auth.user.id, username: auth.user.username, name: auth.user.displayName,
    admin: !!auth.user.isAdmin, active: true, mustChange: !!auth.mustChangePassword,
    avatar: auth.user.avatarUrl ?? null,
  };
  data.peopleVersion=(data.peopleVersion??0)+1;
  const index = data.users.findIndex((item) => item.id === user.id);
  if (index >= 0) data.users.splice(index, 1, { ...data.users[index], ...user });
  else data.users.push(user);
  data.session = { id: auth.sessionId, userId: user.id, authenticatedAt: secondsToMilliseconds(auth.authenticatedAt), temporary: !!auth.mustChangePassword };
  return data;
}

function collectionFor(data, entityType) {
  return ({ project: data.projects, track: data.tracks, epic: data.epics, milestone: data.milestones, task: data.tasks, poolItem: data.pool })[entityType];
}

function mapEntity(entity) {
  switch (entity.entityType) {
    case 'project': return { ...fromWire('project', entity), members: [] };
    case 'membership': return mapMembership(entity);
    case 'track': return mapTrack(entity);
    case 'epic': return mapEpic(entity);
    case 'milestone': return mapMilestone(entity);
    case 'task': return mapTask(entity);
    case 'poolItem': return mapPoolItem(entity);
    default: return null;
  }
}

function patchEntity(target,entity){
  if(isOlder(target,entity))return target;
  if(Object.hasOwn(entity,'revision'))target.revision=entity.revision;
  for(const [wire,client=wire,convert=(value)=>value] of FIELDS[entity.entityType]??[])if(Object.hasOwn(entity,wire)&&!CHECKLIST_FIELDS.includes(client))target[client]=convert(entity[wire]);
  if(entity.entityType==='task'&&Object.hasOwn(entity,'checklistVersion'))keepNewerChecklist(target,target,fromWire('task',entity));
  if(entity.entityType==='epic'&&Object.hasOwn(entity,'taskTotal'))target.counted=true;
  return target;
}

/** Merge canonical command entities without generating client-side activity. */
export function reconcileCommandResult(data, result) {
  for (const entity of result?.entities ?? []) {
    if (!entity || typeof entity !== 'object' || !entity.entityType) continue;
    if (entity.entityType === 'membership') {
      const project = data.projects.find((item) => item.id === entity.projectId);
      if (!project) continue;
      const index = project.members.findIndex((item) => item.userId === entity.userId);
      if (entity.deleted) { if (index >= 0) project.members.splice(index, 1); continue; }
      if(index>=0&&isOlder(project.members[index],entity))continue;
      const mapped = mapMembership(entity);
      if (index >= 0) project.members.splice(index, 1, mapped); else project.members.push(mapped);
      continue;
    }
    if(entity.entityType==='taskBlock'){
      const item=data.tasks.find((task)=>task.internalId===entity.taskId);
      if(!item)continue;
      if(entity.resolved){item.block=null;continue;}
      if(item.block&&item.block.id===entity.id)patchEntity(item.block,{entityType:'taskBlock',...entity});
      else item.block=mapBlock(entity);
      continue;
    }
    const collection = collectionFor(data, entity.entityType);
    if (!collection) continue;
    const identity = entity.entityType === 'task' ? (item) => item.internalId === entity.id : (item) => item.id === entity.id;
    const index = collection.findIndex(identity);
    if (entity.deleted) { if (index >= 0) collection.splice(index, 1); continue; }
    if(index>=0){patchEntity(collection[index],entity);continue;}
    const mapped = mapEntity(entity);
    if (!mapped) continue;
    collection.push(mapped);
  }
  return data;
}

