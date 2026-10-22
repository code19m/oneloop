// @ts-check

/**
 * The Board's filters: search text, tracks, epics, assignees and Blocked, as
 * App.context().board holds them. The views and the Board reads share these
 * rules, so a filter matches the same tasks on both sides.
 * @typedef {{search?:string,blocked?:boolean,trackIds?:string[],epicIds?:string[],assigneeIds?:string[]}} BoardFilters
 */

/** The assignee filter's entry for tasks that have no assignee. */
export const NO_ASSIGNEE = '__unassigned__';

/** The epic filter's entry for tasks that have no epic, as Board reads and addresses name it. */
export const NO_EPIC = 'none';

/**
 * The filters as a Board read sends them: trimmed search text, sorted IDs,
 * and "no assignee" as its own flag.
 * @param {BoardFilters} [filters]
 */
export function normalizeBoardFilters(filters = {}) {
  const assigneeIds = filters.assigneeIds ?? [];
  return {
    search: String(filters.search ?? '').trim() || undefined,
    trackIds: [...(filters.trackIds ?? [])].sort(),
    epicIds: [...(filters.epicIds ?? [])].sort(),
    assigneeIds: assigneeIds.filter((id) => id !== NO_ASSIGNEE).sort(),
    noAssignee: assigneeIds.includes(NO_ASSIGNEE) || undefined,
    blocked: filters.blocked || undefined,
  };
}

/**
 * Whether any filter is on, in either shape.
 * @param {(BoardFilters & {noAssignee?:boolean})|null|undefined} filters
 */
export function boardFiltered(filters) {
  return !!filters && !!(filters.search || filters.blocked || filters.trackIds?.length || filters.epicIds?.length || filters.assigneeIds?.length || filters.noAssignee);
}

/**
 * Whether two sets of filters that `normalizeBoardFilters` returned, such as
 * those a Board read loaded its cards for, choose the same tasks.
 * @param {Partial<ReturnType<typeof normalizeBoardFilters>>|null|undefined} left
 * @param {Partial<ReturnType<typeof normalizeBoardFilters>>|null|undefined} right
 */
export function sameBoardFilters(left, right) {
  const key = (filters) => JSON.stringify([filters?.search ?? '', filters?.trackIds ?? [], filters?.epicIds ?? [], filters?.assigneeIds ?? [], !!filters?.noAssignee, !!filters?.blocked]);
  return key(left) === key(right);
}

/**
 * Whether a task passes filters that `normalizeBoardFilters` returned.
 * @param {{title:string,key:string,epicId:string|null,trackId:string,assigneeIds:string[],blocked:boolean}} task
 * @param {ReturnType<typeof normalizeBoardFilters>} filters
 */
export function matchesBoardFilters(task, filters) {
  const search = filters.search?.toLowerCase();
  return (!search || task.title.toLowerCase().includes(search) || task.key.toLowerCase().includes(search))
    && (!filters.trackIds.length || filters.trackIds.includes(task.trackId))
    && (!filters.epicIds.length || filters.epicIds.includes(task.epicId ?? NO_EPIC))
    && (!(filters.assigneeIds.length || filters.noAssignee) || task.assigneeIds.some((id) => filters.assigneeIds.includes(id)) || !!filters.noAssignee && !task.assigneeIds.length)
    && (!filters.blocked || task.blocked);
}
