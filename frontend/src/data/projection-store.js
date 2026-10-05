// @ts-check

import {secondsToMilliseconds} from './time.js';
import {mapInboxItem} from './inbox-mapper.js';

import {refreshPageWindow} from './page-window.js';

import { sessionBrowserLabel, sessionDeviceLabel } from '../auth/session-label.js';

const STATUS_TO_LEGACY = Object.freeze({ planning: 'planning', in_progress: 'progress', in_review: 'review', done: 'done' });
const SCOPE_TO_LEGACY = Object.freeze({ personal: 'mine', team: 'project' });

/** Create the one mutable root consumed by the compatibility client. */
export function createLegacyData() {
  return {
    limits:/** @type {{maxAttachmentBytes:number,maxAvatarBytes:number,maxAttachmentsPerTask:number}|null} */(null), projectionGeneration:0, timeZone: 'UTC', users: [], projects: [], tracks: [], epics: [], milestones: [],
    tasks: [], pool: [], notifications: [], browserSessions: [], appGrants: [], session: null,
    inboxUnreadCount: 0, boardPageInfo: null, projectTaskCounts: {}, poolPageInfo: {}, bootstrapView:null, syncCursor:null,
    epicPageInfo: {}, adminUsers: { ids: [], nextCursor: null, loaded: false },
  };
}

function replace(array, next) {
  array.splice(0, array.length, ...next);
  return array;
}


function mapUser(user) {
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

function mapProject(project, memberships) {
  return {
    id: project.id, name: project.name, key: project.taskPrefix, taskPrefix: project.taskPrefix,
    revision: project.revision,
    members: memberships.filter((item) => item.projectId === project.id).map(mapMembership),
  };
}

function mapTrack(track) {
  return { id: track.id, projectId: track.projectId, name: track.name, desc: track.description ?? '', order: track.position, revision: track.revision };
}

function mapEpic(epic) {
  return {
    id: epic.id, projectId: epic.projectId, trackId: epic.trackId, title: epic.title,
    desc: epic.description ?? '', start: epic.startDate, end: epic.endDate ?? null,
    state: epic.state, order: epic.position, revision: epic.revision,
    done: epic.taskDone ?? epic.done ?? 0, total: epic.taskTotal ?? epic.total ?? 0,
    // Only Roadmap reads carry task counts; until one arrives, they are unknown.
    counted: epic.taskTotal !== undefined || epic.total !== undefined,
    open: epic.taskOpen, closedThisWeek: epic.completedThisWeek,
    completedSinceStart: epic.completedSinceStart,
    weekly: epic.weeklyCompletions ?? epic.weekly, activity: [],
  };
}

/** Only Roadmap reads carry epic task counts; other reads keep the last ones known. */
function keepEpicCounts(mapped, view, previous) {
  if (view.taskTotal !== undefined || !previous) return mapped;
  for (const key of ['done','total','open','closedThisWeek','completedSinceStart','weekly','counted']) mapped[key] = previous[key];
  return mapped;
}

function mapMilestone(milestone) {
  return {
    id: milestone.id, projectId: milestone.projectId, name: milestone.title,
    desc: milestone.description ?? '', date: milestone.milestoneDate, revision: milestone.revision,
  };
}

function mapBlock(block) {
  return block ? {
    id: block.id, reason: block.reason, by: block.createdBy, at: secondsToMilliseconds(block.createdAt),
    revision: block.revision, mentions: block.mentions ?? [], resolution: block.resolution ?? null,
  } : null;
}

function mapTask(task) {
  return {
    internalId: task.id, id: task.taskKey, projectId: task.projectId, epicId: task.epicId,
    title: task.title, desc: task.description ?? '', detailsLoaded:typeof task.description==='string', state: STATUS_TO_LEGACY[task.status] ?? task.status,
    order: task.position, deadline: task.deadline ?? null, created: secondsToMilliseconds(task.createdAt), updatedAt: secondsToMilliseconds(task.updatedAt),
    completedAt: secondsToMilliseconds(task.completedAt) ?? null, revision: task.revision, assignees: [...(task.assigneeIds ?? [])], block: mapBlock(task.activeBlock),
    attachments: task.attachments ?? [], comments: task.comments ?? [], activity: task.activity ?? [],
  };
}

function mapPoolItem(item) {
  return {
    id: item.id, projectId: item.projectId, scope: SCOPE_TO_LEGACY[item.scope] ?? item.scope,
    ownerId: item.ownerUserId ?? null, title: item.title, desc: item.description ?? '',
    created: secondsToMilliseconds(item.createdAt), revision: item.revision,
  };
}

/** @param {{revision?:number}|null|undefined} existing @param {{revision?:number}|null|undefined} incoming */
function isOlder(existing, incoming) {
  return Number.isFinite(existing?.revision) && Number.isFinite(incoming?.revision) && incoming.revision < existing.revision;
}

function retainTaskDetails(previous, mapped) {
  if (isOlder(previous, mapped)) return previous;
  if (!previous) return mapped;
  if(!mapped.detailsLoaded&&previous.detailsLoaded&&previous.revision===mapped.revision){mapped.desc=previous.desc;mapped.detailsLoaded=true;}
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
 * newest-first Done orders by completion time, newest first, then by ID the
 * other way round; a task without a completion time comes last. Done tasks
 * then sort after all others, so the order stays consistent across columns.
 * @param {{order:number,internalId:string,state?:string,completedAt?:number|null}} left
 * @param {{order:number,internalId:string,state?:string,completedAt?:number|null}} right
 * @param {string} [doneOrder]
 */
export function compareTaskOrder(left, right, doneOrder) {
  const byId=left.internalId < right.internalId ? -1 : left.internalId > right.internalId ? 1 : 0;
  if(doneOrder==='completed'){
    const leftDone=left.state==='done',rightDone=right.state==='done';
    if(leftDone!==rightDone)return leftDone?1:-1;
    if(leftDone)return (right.completedAt??-1)-(left.completedAt??-1) || -byId;
  }
  return left.order-right.order || byId;
}

export function mergeEpicTaskPage(data, epicId, taskViews, page, append=false) {
  const previous=new Map(data.tasks.map((item)=>[item.internalId,item]));
  const byId=new Map(data.tasks.map((item)=>[item.internalId,item]));
  for(const view of taskViews)byId.set(view.id,retainTaskDetails(previous.get(view.id),mapTask(view)));
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

export function replaceRoadmap(data, projection) {
  const projectId=projection.projectId ?? projection.tracks?.[0]?.projectId ?? projection.epics?.[0]?.projectId ?? projection.milestones?.[0]?.projectId;
  if(!projectId)return data;
  replace(data.tracks,[...data.tracks.filter((item)=>item.projectId!==projectId),...(projection.tracks??[]).map(mapTrack)]);
  const history=new Map(data.epics.map((/** @type {ReturnType<typeof mapEpic>} */ item)=>[item.id,item.activity]));
  replace(data.epics,[...data.epics.filter((item)=>item.projectId!==projectId),...(projection.epics??[]).map((/** @type {{id:string}} */ view)=>({...mapEpic(view),activity:history.get(view.id)??[]}))]);
  replace(data.milestones,[...data.milestones.filter((item)=>item.projectId!==projectId),...(projection.milestones??[]).map(mapMilestone)]);
  return data;
}

export function replacePoolPage(data, projectId, scope, itemViews, append=false) {
  const legacyScope=SCOPE_TO_LEGACY[scope]??scope;
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
  const legacyScope=SCOPE_TO_LEGACY[scope]??scope;
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
  if(!bootstrap.view)replace(data.pool, (bootstrap.pool ?? []).map(mapPoolItem));
  else replace(data.pool,data.pool.filter(item=>data.projects.some(project=>project.id===item.projectId)&&(item.scope!=='mine'||item.ownerId===(identity?.id??identity?.userId))));
  if(!bootstrap.view)replace(data.notifications, (bootstrap.notifications ?? []).map(mapInboxItem));
  if(!bootstrap.view)replace(data.browserSessions, (bootstrap.browserSessions ?? []).map((session) => ({
    ...session, userId:session.userId ?? identity?.id ?? identity?.userId,
    device:sessionDeviceLabel(session), browser:sessionBrowserLabel(session), createdAt:secondsToMilliseconds(session.createdAt) ?? session.createdAt,
    lastActiveAt:secondsToMilliseconds(session.lastActivityAt) ?? session.lastActiveAt, current:!!session.current,
  })));
  if(!bootstrap.view)replace(data.appGrants, bootstrap.appGrants ?? []);
  data.inboxUnreadCount=Number(bootstrap.inboxUnreadCount??0);
  data.boardPageInfo=null;
  data.projectTaskCounts={};
  data.poolPageInfo={};
  data.bootstrapView=bootstrap.view??null;data.syncCursor=bootstrap.syncCursor??null;
  const projectId=bootstrap.selectedProjectId;
  if(projectId&&bootstrap.boardCounts){const counts=bootstrap.boardCounts;setProjectTaskCounts(data,projectId,{planning:counts.planning,progress:counts.inProgress,review:counts.inReview,done:counts.done,blocked:counts.blocked});}
  if(projectId&&Object.keys(bootstrap.boardPages??{}).length){
    const pages=Object.fromEntries(Object.entries(bootstrap.boardPages).map(([status,page])=>[STATUS_TO_LEGACY[status]??status,page]));
    setBoardPageInfo(data,projectId,bootstrap.doneOrder==='completed'?{doneOrder:'completed'}:{},pages);
  }
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
    case 'project': return { id: entity.id, name: entity.name, key: entity.taskPrefix, taskPrefix: entity.taskPrefix, revision: entity.revision, members: [] };
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
  const set=(wire,legacy=wire,transform=(value)=>value)=>{if(Object.hasOwn(entity,wire))target[legacy]=transform(entity[wire]);};
  set('revision');
  if(entity.entityType==='project'){set('name');set('taskPrefix','key');set('taskPrefix');}
  if(entity.entityType==='track'){set('projectId');set('name');set('description','desc');set('position','order');}
  if(entity.entityType==='epic'){set('projectId');set('trackId');set('title');set('description','desc');set('startDate','start');set('endDate','end');set('state');set('position','order');set('taskDone','done');set('taskTotal','total');if(Object.hasOwn(entity,'taskTotal'))target.counted=true;set('taskOpen','open');set('completedThisWeek','closedThisWeek');set('completedSinceStart');set('weeklyCompletions','weekly');}
  if(entity.entityType==='milestone'){set('projectId');set('title','name');set('description','desc');set('milestoneDate','date');}
  if(entity.entityType==='task'){set('projectId');set('epicId');set('taskKey','id');set('title');set('description','desc');set('status','state',(value)=>STATUS_TO_LEGACY[value]??value);set('position','order');set('deadline');set('createdAt','created',secondsToMilliseconds);set('updatedAt','updatedAt',secondsToMilliseconds);set('completedAt','completedAt',(value)=>secondsToMilliseconds(value)??null);set('assigneeIds','assignees',(value)=>[...value]);set('activeBlock','block',mapBlock);}
  if(entity.entityType==='poolItem'){set('projectId');set('scope','scope',(value)=>SCOPE_TO_LEGACY[value]??value);set('ownerUserId','ownerId');set('title');set('description','desc');set('createdAt','created',secondsToMilliseconds);}
  if(entity.entityType==='taskBlock'){set('reason');set('createdBy','by');set('createdAt','at',secondsToMilliseconds);set('mentions');set('resolution');}
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

export const wireStatus = (status) => ({ progress: 'in_progress', review: 'in_review' })[status] ?? status;
