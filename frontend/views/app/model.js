// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* The state of the views and the projection they read: the open page, data
   lookups and permissions. */

export const D = window.DATA;
export const collaboration=window.Collab;
export const instanceNow = () => window.OneloopRuntime?.now?.() ?? Date.now();
/** Run a server-backed action of the runtime; it reports a failure itself. */
export const invoke = (action, payload = {}) => window.OneloopRuntime.invoke(action, payload).catch(window.OneloopRuntime.report);

export const state = {
  sideOpen: false,
  view: (location.hash.replace('#/', '') || 'roadmap'),
  taskId: null,
  rail: (() => { try { return localStorage.getItem('oneloop.sidebar') === 'rail'; } catch { return false; } })(),
  poolTab: 'mine',
  projectId: 'p1',
  pxPerDay: 8.5,
  rmScrollLeft: null, rmScrollTop: 0,
  boardTracks: [], boardEpics: [], boardAssignees: [], boardQ: '', boardBlocked:false,
  peek: null, modal: null, menu: null,
  boardLimits:{planning:50,progress:50,review:50,done:50}, usersLimit:50,
};
/** The actions that markup and the view bridge call by name. Each part of the views adds its own. */
export const App = {};
/** Addresses the views drew themselves, which the address listener then skips once. */
export const locallyRenderedHashes = [];
export function setLocalHash(hash) {
  if (location.hash === hash) return;
  location.hash = hash;
  locallyRenderedHashes.push(location.href);
}

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
export const userById = (id) => collaboration?.userById ? collaboration.userById(id) : D.users.find((u) => u.id === id);
export const userHandle = (user) => user?.username || user?.id || '';
export const me = () => (D.session ? userById(D.session.userId) : null);
export const isAdmin = () => !!(me() && me().admin);
export const visibleProjects = () => D.projects.filter(p=>canReadProject(p.id));
const memberRecord = (userId, projectId) => {
  const p = D.projects.find((x) => x.id === (projectId || state.projectId));
  if (!p) return null;
  const raw = (p.members || []).find((m) => (typeof m === 'string' ? m : m.userId) === userId);
  return typeof raw === 'string' ? { userId: raw, permissions: [] } : raw || null;
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
  .map((m) => userById(typeof m === 'string' ? m : m.userId))
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
