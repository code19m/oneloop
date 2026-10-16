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
const REMEMBERED = 'oneloop.project';

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
 * The address of a project page. The Board's adds the filters that are on,
 * each list as comma-separated IDs in a fixed order.
 * @param {string} page @param {string} projectId @param {import('../data/board-filters.js').BoardFilters|null} [filters]
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
 * The project this browser switched to last, which an address that names no
 * project opens.
 * @param {Storage} [storage] the browser's local storage unless given
 */
export function rememberedProject(storage) {
  try { return (storage ?? globalThis.localStorage)?.getItem(REMEMBERED) || null; } catch { return null; }
}

/**
 * Remember a switch to `projectId`; null forgets the project, such as one that
 * is gone. Without storage, as in some private windows, new tabs open the
 * first project instead.
 * @param {string|null} projectId @param {Storage} [storage] the browser's local storage unless given
 */
export function rememberProject(projectId, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    if (projectId) store?.setItem(REMEMBERED, projectId);
    else store?.removeItem(REMEMBERED);
  } catch { /* The switch still holds for this tab. */ }
}
