// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
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

export const state = {
  sideOpen: false,
  view: (location.hash.replace('#/', '') || 'roadmap'),
  taskId: null,
  rail: (() => { try { return localStorage.getItem('oneloop.sidebar') === 'rail'; } catch { return false; } })(),
  poolTab: 'mine',
  projectId: null,
  pxPerDay: 8.5,
  rmScrollLeft: null, rmScrollTop: 0,
  boardTracks: [], boardEpics: [], boardAssignees: [], boardQ: '', boardBlocked:false,
  peek: null, modal: null, menu: null,
  boardLimits:{planning:50,progress:50,review:50,done:50}, usersLimit:50,
};
/**
 * The actions that markup and the view bridge call by name. Each part of the
 * views adds its own. boot.js, which is type-checked, sees this type.
 * @type {import('../../src/data/contracts.js').LegacyApp}
 */
export const App = {};

// ---------- project-scoped accessors ----------
export const project = () => D.projects.find((p) => p.id === state.projectId && canReadProject(p.id));
export const tracks = () => D.tracks.filter((t) => t.projectId === state.projectId && canReadProject(t.projectId)).sort((a, b) => a.order - b.order);
export const epics = () => { const tids = new Set(tracks().map((t) => t.id)); return D.epics.filter((e) => tids.has(e.trackId)); };
export const epicById = (id) => D.epics.find((e) => e.id === id);
export const trackById = (id) => D.tracks.find((t) => t.id === id);
export const milestones = () => D.milestones.filter((m) => m.projectId === state.projectId && canReadProject(m.projectId));
export const tasks = () => { const eids = new Set(epics().map((e) => e.id)); return D.tasks.filter((t) => eids.has(t.epicId)); };
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
export const canReadTask = task => {const id=trackById(epicById(task?.epicId)?.trackId)?.projectId;return !!id&&canReadProject(id);};
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
export const counts = () => {
  const aggregate = D.projectTaskCounts?.[state.projectId];
  if (aggregate) return { open:aggregate.open, done:aggregate.done };
  const ts = tasks();
  return {
    open: ts.filter((t) => t.state !== 'done').length,
    done: ts.filter((t) => t.state === 'done').length,
  };
};
