// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* The state of the views and the projection they read: the open page, data
   lookups and permissions. */

export const D = window.DATA;
// What boot.js installs before the views load: Recovery (connection, conflict
// and unsaved-input handling) and the collaboration and Knowledge controllers
// from src/features/.
export const recovery = window.Recovery;
export const collaborationController = window.OneloopCollaboration;
export const knowledge = window.OneloopKnowledge;
/** The view bridge's server-backed functions, which boot.js installs once the views have loaded. */
export const runtime = () => window.OneloopRuntime;
/** Report a failed runtime call as a failed save is reported. */
export const report = (error) => runtime().report(error);
export const instanceNow = () => runtime()?.now?.() ?? Date.now();

/** The Board's first page of each column, which a read from the server also starts at. */
export const firstBoardPages = () => ({ planning: 50, progress: 50, review: 50, done: 50 });
/** Fixed scales of the Roadmap's timeline, in pixels per day. */
export const ROADMAP_SCALES = [
  { key: 'weeks', label: 'Weeks', ppd: 30, shortcut: 'W' },
  { key: 'months', label: 'Months', ppd: 8.5, shortcut: 'M' },
  { key: 'quarters', label: 'Quarters', ppd: 2.6, shortcut: 'Q' },
];
/** Months: the zoom the Roadmap draws at until its lanes load and it fits their work, or a scale is picked. */
export const OPENING_SCALE = ROADMAP_SCALES.find((scale) => scale.key === 'months');

export const state = {
  sideOpen: false,
  view: (location.hash.replace('#/', '') || 'roadmap'),
  taskId: null,
  rail: (() => { try { return localStorage.getItem('oneloop.sidebar') === 'rail'; } catch { return false; } })(),
  poolTab: 'mine',
  // Where each Pool tab's list was scrolled, from when the Pool opened.
  poolScroll: {},
  projectId: null,
  pxPerDay: OPENING_SCALE.ppd,
  rmScrollLeft: null, rmScrollTop: 0,
  boardTracks: [], boardEpics: [], boardAssignees: [], boardQ: '', boardBlocked:false,
  peek: null, modal: null, menu: null,
  boardLimits: firstBoardPages(), usersLimit:50,
};
/**
 * The actions that markup and the view bridge call by name. Each part of the
 * views adds its own. boot.js, which is type-checked, sees this type.
 * @type {import('../../src/data/contracts.js').LegacyApp}
 */
export const App = {};

// ---------- project-scoped accessors ----------
/** Whether the tracks, epics and people of the project on screen are loaded; an address can name another project before they are. */
export const projectLoaded = () => D.bootstrapProjectId === state.projectId;
export const project = () => D.projects.find((p) => p.id === state.projectId && canReadProject(p.id));
export const tracks = () => D.tracks.filter((t) => t.projectId === state.projectId && canReadProject(t.projectId)).sort((a, b) => a.order - b.order);
export const epics = () => { const tids = new Set(tracks().map((t) => t.id)); return D.epics.filter((e) => tids.has(e.trackId)); };
export const epicById = (id) => D.epics.find((e) => e.id === id);
export const trackById = (id) => D.tracks.find((t) => t.id === id);
/** The track a task is on, when the project's tracks are loaded. */
export const taskTrack = (task) => trackById(task?.trackId);
export const milestones = () => D.milestones.filter((m) => m.projectId === state.projectId && canReadProject(m.projectId));
export const tasks = () => { const tids = new Set(tracks().map((t) => t.id)); return D.tasks.filter((t) => tids.has(t.trackId)); };
export const taskById = (id) => D.tasks.find((t) => t.id === id || t.internalId === id);
export const poolItems = (scope) => D.pool.filter((p) => p.projectId === state.projectId && canReadProject(p.projectId) && (scope ? p.scope === scope : true) && (p.scope !== 'mine' || p.ownerId === (me() || {}).id));
// Each lookup by id would scan every user, so a map follows the projection's people.
let usersSource = null, usersVersion = null, usersCount = -1, usersById = new Map();
export const userById = (id) => {
  if (usersSource !== D.users || usersVersion !== D.peopleVersion || usersCount !== D.users.length) {
    usersSource = D.users; usersVersion = D.peopleVersion; usersCount = D.users.length;
    usersById = new Map(D.users.map((user) => [user.id, user]));
  }
  return usersById.get(id);
};
export const userHandle = (user) => user?.username || user?.id || '';
export const me = () => (D.session ? userById(D.session.userId) : null);
export const isAdmin = () => !!(me() && me().admin);
export const visibleProjects = () => D.projects.filter(p=>canReadProject(p.id));
const memberRecord = (userId, projectId) => {
  const p = D.projects.find((x) => x.id === (projectId || state.projectId));
  if (!p) return null;
  return (p.members || []).find((m) => m.userId === userId) || null;
};
export const canReadProject = id => !!(me()?.active && D.projects.some(p=>p.id===id) && (me().admin||memberRecord(me().id,id)));
// A task's own project counts while its track loads, as after a move to a new track.
export const canReadTask = task => {const id=taskTrack(task)?.projectId??task?.projectId;return !!id&&canReadProject(id);};
export const hasPermission = (permission, projectId) => {
  const u = me();
  if (!u || !u.active) return false;
  if (u.admin) return true;
  const membership = memberRecord(u.id, projectId);
  return !!(membership && (membership.permissions || []).includes(permission));
};
export const canRoadmap = () => hasPermission('manage_roadmap');
export const canBoard = () => hasPermission('manage_board');
export const projectMembers = () => ((project() || {}).members || [])
  .map((m) => userById(m.userId))
  .filter((u) => u && u.active);
export const activeAdmins = () => D.users.filter((u) => u.admin && u.active);
/** The project's open blocked tasks, as the server counts them once it has. */
export const blockedCount = () => D.projectTaskCounts?.[state.projectId]?.blocked ?? tasks().filter((t) => t.block && t.state !== 'done').length;
/** Items in both of the project's Pools, as the server counts them once both are read. */
export const poolTotal = () => {
  const mine = D.poolPageInfo?.[`${state.projectId}:mine`]?.total, team = D.poolPageInfo?.[`${state.projectId}:project`]?.total;
  return Number.isFinite(mine) && Number.isFinite(team) ? mine + team : poolItems().length;
};
/** The open and done tasks of the project on screen; nothing until they are known, as while another project loads. */
export const counts = () => {
  const aggregate = D.projectTaskCounts?.[state.projectId];
  if (aggregate) return { open:aggregate.open, done:aggregate.done };
  if (!projectLoaded()) return { open:'', done:'' };
  const ts = tasks();
  return {
    open: ts.filter((t) => t.state !== 'done').length,
    done: ts.filter((t) => t.state === 'done').length,
  };
};
