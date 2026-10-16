// @ts-check

/**
 * The view bridge's checklist actions: adding, ticking, renaming, moving and
 * removing the items of a task's checklist. The task page shows each change
 * in place, through `refreshTaskChecklist`.
 */

/** @param {import('../view-bridge.js').BridgeContext} ctx */
export function installChecklist(ctx) {
  const { app, task, execute, skipped, sessionScope, drafts, draftKey, pruneDrafts, unsavedDraft } = ctx;

  /** The item `itemId` of task `taskId`'s checklist. @param {string} taskId @param {string} itemId */
  const itemOf = (taskId, itemId) => task(taskId)?.checklist?.find((/** @type {{id:string}} */ item) => item.id === itemId);
  /** The draft field of an item's title, among the task's drafts. @param {string} itemId */
  const titleField = (itemId) => `checklist:${itemId}`;

  /**
   * Run checklist command `operation` for task `taskId`. Its result carries
   * the task with its checklist, which the page then shows, with Saved in its
   * top bar unless the page holds text not saved yet. Saves of one item run
   * one at a time.
   * @param {string} taskId @param {string} operation @param {Record<string,unknown>} payload @param {any} item @param {Record<string,unknown>} [options]
   */
  async function change(taskId, operation, payload, item, options = {}) {
    try {
      const result = await execute(operation, payload, item, null, { paint: false, ...options });
      const current = task(taskId);
      if (!result?.stale && !result?.skipped && current && !unsavedDraft(current.internalId)) app.noteTaskSaved(current.id);
      return result;
    } finally { app.refreshTaskChecklist(taskId); }
  }

  /**
   * Show task `taskId`'s checklist as `next` at once, and as before when the
   * server refuses the change `send` makes.
   * @param {string} taskId @param {any[]} next @param {()=>Promise<any>} send
   */
  async function showing(taskId, next, send) {
    const item = task(taskId), before = item.checklist;
    item.checklist = next; app.refreshTaskChecklist(taskId);
    try { return await send(); }
    catch (error) {
      const current = task(taskId);
      if (current?.checklist === next) { current.checklist = before; app.refreshTaskChecklist(taskId); }
      throw error;
    }
  }

  /**
   * Save a typed title. It shows until it is saved, as a task's title does,
   * and stays Not saved when the save is refused.
   * @param {string} taskId @param {any} item @param {string} title @param {{expectedRevision?:number,conflictElement?:()=>Element|null}} options
   */
  function saveTitle(taskId, item, title, options) {
    pruneDrafts();
    const draft = draftKey(item.taskId, titleField(item.id)), previous = drafts.get(draft);
    // Text typed over a Not saved title still builds on the revision that title was typed on.
    const expectedRevision = previous?.unsaved ? previous.base ?? options.expectedRevision : options.expectedRevision;
    drafts.set(draft, { taskId: item.taskId, field: titleField(item.id), value: title, base: expectedRevision, scope: sessionScope(), unsaved: false, retryOnline: false });
    return change(taskId, 'task.checklist.update', { itemId: item.id, title }, item, { ...options, expectedRevision, draft, draftValue: title }).catch((error) => {
      // An item someone removed meanwhile has nothing left to save.
      if (error?.code === 'not_found' && drafts.get(draft)?.value === title) { drafts.delete(draft); app.refreshTaskChecklist(taskId); }
      throw error;
    });
  }

  return {
    /** The title typed into item `itemId` of task `taskId` that is not saved yet. @param {string} taskId @param {string} itemId */
    checklistDraft(taskId, itemId) {
      pruneDrafts();
      const draft = drafts.get(draftKey(taskId, titleField(itemId)));
      return draft ? { value: draft.value, unsaved: draft.unsaved } : null;
    },
    /** Add an item titled `title` at the end of task `taskId`'s checklist. @param {string} taskId @param {string} title */
    addChecklistItem(taskId, title) {
      const item = task(taskId);
      if (!item) return Promise.resolve(skipped());
      // Adds to one checklist run in order; a new item has no revision to send.
      return change(taskId, 'task.checklist.add', { taskId: item.internalId, title }, null);
    },
    /**
     * Change an item's title, or tick it or clear its tick, which shows at
     * once. `options` can name the revision a title builds on and the field a
     * conflict shows by.
     * @param {string} taskId @param {string} itemId @param {{title:string}|{done:boolean}} fields @param {{expectedRevision?:number,conflictElement?:()=>Element|null}} [options]
     */
    updateChecklistItem(taskId, itemId, fields, options = {}) {
      const item = itemOf(taskId, itemId);
      if (!item) return Promise.resolve(skipped());
      if ('title' in fields) return saveTitle(taskId, item, fields.title, options);
      const next = task(taskId).checklist.map((/** @type {any} */ entry) => entry === item ? { ...entry, done: fields.done } : entry);
      return showing(taskId, next, () => change(taskId, 'task.checklist.update', { itemId, done: fields.done }, item, options));
    },
    /**
     * Move an item just before or after another item of the checklist.
     * @param {string} taskId @param {string} itemId @param {{beforeItemId:string}|{afterItemId:string}} placement
     */
    moveChecklistItem(taskId, itemId, placement) {
      const item = itemOf(taskId, itemId), list = task(taskId)?.checklist;
      if (!item) return Promise.resolve(skipped());
      const rest = list.filter((/** @type {any} */ entry) => entry !== item), after = 'afterItemId' in placement;
      const anchor = after ? placement.afterItemId : placement.beforeItemId;
      const next = [...rest]; next.splice(rest.findIndex((/** @type {any} */ entry) => entry.id === anchor) + Number(after), 0, item);
      if (next.every((entry, index) => entry === list[index])) return Promise.resolve(skipped());
      return showing(taskId, next, () => change(taskId, 'task.checklist.move', { itemId, ...placement }, item));
    },
    /** Remove an item, at once and without Undo. @param {string} taskId @param {string} itemId */
    deleteChecklistItem(taskId, itemId) {
      const item = itemOf(taskId, itemId), list = task(taskId)?.checklist;
      if (!item) return Promise.resolve(skipped());
      return showing(taskId, list.filter((/** @type {any} */ entry) => entry !== item), () => change(taskId, 'task.checklist.delete', { id: itemId }, item));
    },
  };
}
