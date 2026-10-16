// @ts-check

/**
 * The app's addresses. A project page names its project after the page, as in
 * `#/board/<projectId>`, and the Board adds the filters that are on as a query,
 * so a refresh, a bookmark or a link shows the same view.
 */

import { NO_ASSIGNEE } from '../data/board-filters.js';

/** @typedef {Required<import('../data/board-filters.js').BoardFilters>} BoardFilters */
/** @typedef {{page:string,projectId:string|null,taskId:string|null,filters:BoardFilters|null}} Address */

/** Pages that show one project. Knowledge's address goes on after the project. */
const PROJECT_PAGES = new Set(['board', 'roadmap', 'settings', 'knowledge']);
const OTHER_PAGES = new Set(['inbox', 'profile', 'users', 'storage']);
/** How a Board address names No assignee. */
const NONE = 'none';
const LAST_SWITCH = 'oneloop.project';

/** @param {string} part */
function decode(part) {
  try { return decodeURIComponent(part); } catch { return null; }
}

/** @param {string} query @returns {BoardFilters} */
function filtersIn(query) {
  const params = new URLSearchParams(query);
  const ids = (/** @type {string} */ key) => [...new Set((params.get(key) ?? '').split(',').filter(Boolean))];
  return {
    search: (params.get('search') ?? '').trim(),
    trackIds: ids('track'),
    epicIds: ids('epic'),
    assigneeIds: ids('assignee').map((id) => id === NONE ? NO_ASSIGNEE : id),
    blocked: params.get('blocked') === '1',
  };
}

/**
 * What an address shows: its page; the project of a project page, or null
 * when an older address such as `#/board` names none; a task page's task; and
 * the Board's filters. An address that can't be read shows `notfound`.
 * @param {string} hash
 * @returns {Address}
 */
export function readAddress(hash) {
  const route = String(hash ?? '').replace(/^#\/?/, '');
  /** @type {Address} */
  const notFound = { page: 'notfound', projectId: null, taskId: null, filters: null };
  if (route.startsWith('task/')) {
    const taskId = decode(route.slice(5));
    return taskId === null ? notFound : { ...notFound, page: 'task', taskId };
  }
  const at = route.indexOf('?'), [page, project, ...rest] = (at < 0 ? route : route.slice(0, at)).split('/');
  if (!page) return { ...notFound, page: 'roadmap' };
  if (OTHER_PAGES.has(page) && project === undefined) return { ...notFound, page };
  if (!PROJECT_PAGES.has(page) || page !== 'knowledge' && rest.length) return notFound;
  const projectId = project ? decode(project) : null;
  if (project && projectId === null) return notFound;
  return { page, projectId, taskId: null, filters: page === 'board' ? filtersIn(at < 0 ? '' : route.slice(at + 1)) : null };
}

/**
 * The address of a project's Board, Roadmap or Settings. The Board's adds the
 * filters that are on, each list as comma-separated IDs in a fixed order.
 * Knowledge builds its own (`routeHash`).
 * @param {'board'|'roadmap'|'settings'} page @param {string} projectId @param {import('../data/board-filters.js').BoardFilters|null} [filters]
 */
export function projectAddress(page, projectId, filters = null) {
  const address = `#/${page}/${encodeURIComponent(projectId)}`;
  if (page !== 'board' || !filters) return address;
  const query = [];
  if (filters.search) query.push(`search=${encodeURIComponent(filters.search)}`);
  /** @type {[string,string[]|undefined][]} */
  const lists = [['track', filters.trackIds], ['epic', filters.epicIds], ['assignee', filters.assigneeIds?.map((id) => id === NO_ASSIGNEE ? NONE : id)]];
  for (const [key, ids] of lists) if (ids?.length) query.push(`${key}=${[...ids].sort().map(encodeURIComponent).join(',')}`);
  if (filters.blocked) query.push('blocked=1');
  return query.length ? `${address}?${query.join('&')}` : address;
}

/**
 * The address without its query: it changes when someone goes to another
 * page, but not when they filter the Board or open a Knowledge section.
 * @param {string} hash
 */
export const pageOf = (hash) => hash.split('?')[0];

/**
 * The last project switch in this browser: who made it, and to which
 * project. An address that names no project opens that project again, but
 * only for the same person.
 * @param {Storage} [storage] the browser's local storage unless given
 * @returns {{userId:string,projectId:string}|null}
 */
export function lastSwitch(storage) {
  try {
    const saved = JSON.parse((storage ?? globalThis.localStorage)?.getItem(LAST_SWITCH) ?? 'null');
    return typeof saved?.userId === 'string' && typeof saved.projectId === 'string' ? { userId: saved.userId, projectId: saved.projectId } : null;
  } catch { return null; }
}

/**
 * Remember that `userId` switched to `projectId`. Null forgets their switch,
 * such as one to a project that is gone, and leaves anyone else's. Without
 * storage, as in some private windows, new tabs open the first project.
 * @param {string} userId @param {string|null} projectId @param {Storage} [storage] the browser's local storage unless given
 */
export function rememberSwitch(userId, projectId, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    if (projectId) store?.setItem(LAST_SWITCH, JSON.stringify({ userId, projectId }));
    else if (lastSwitch(store)?.userId === userId) store?.removeItem(LAST_SWITCH);
  } catch { /* The switch still holds for this tab. */ }
}
