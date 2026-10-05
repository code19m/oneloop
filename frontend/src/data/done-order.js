// @ts-check

/** @typedef {'manual'|'completed'} DoneOrder */

// How the Board orders Done: the manual order, or the most recently completed
// task first. Each browser keeps its own choice, like the sidebar width.
const KEY = 'oneloop.doneOrder';
/** @type {DoneOrder|null} */ let chosen = null;

/** @param {Storage|undefined} [storage] @returns {DoneOrder} */
export function savedDoneOrder(storage = globalThis.localStorage) {
  if (chosen) return chosen;
  try { return storage?.getItem(KEY) === 'completed' ? 'completed' : 'manual'; } catch { return 'manual'; }
}

/** Remember the choice; without storage, such as in some private windows, it lasts until the page reloads.
 * @param {DoneOrder} order @param {Storage|undefined} [storage] */
export function saveDoneOrder(order, storage = globalThis.localStorage) {
  chosen = order === 'completed' ? 'completed' : 'manual';
  try {
    if (chosen === 'completed') storage?.setItem(KEY, chosen);
    else storage?.removeItem(KEY);
  } catch { /* The page still uses the choice. */ }
}
