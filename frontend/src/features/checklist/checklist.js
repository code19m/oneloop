// @ts-check

/**
 * A task's checklist on its page: short items in order, which people with
 * Board access tick, rename, move and remove in place, with a field that adds
 * the next one. Its controls use data attributes and delegated listeners.
 */

import { escapeHtml as esc } from '../../app/markup.js';
import { UIMotion } from '../../app/motion.js';
import { patchInPlace, placeRows } from '../../app/rows.js';
import { sortable } from '../../app/sortable.js';
import { setTrustedHTML } from '../../app/trusted-types.js';
import { fileIcons as icons } from '../files/preview.js';

/** @typedef {{id:string,taskId:string,title:string,done:boolean,revision:number}} ChecklistItem */
/** @typedef {{id:string,checklist?:ChecklistItem[]}} ChecklistTask */

/** The most items a checklist holds, as the server allows. */
const MAX_ITEMS = 50;
/** The server-backed checklist actions, which the view bridge adds. */
const runtime = () => /** @type {any} */ (globalThis).OneloopRuntime;
/** The title typed into `item` that is not saved yet, if any. @param {ChecklistItem} item @returns {{value:string,unsaved:boolean}|null} */
const draftOf = (item) => runtime()?.checklistDraft?.(item.taskId, item.id) ?? null;

/**
 * An item's row. Its fields have ids, so a redraw of the page puts focus and
 * typed text back in the same item.
 * @param {ChecklistItem} item @param {boolean} editable
 */
function itemHtml(item, editable) {
  const id = esc(item.id), title = esc(item.title), draft = editable ? draftOf(item) : null;
  return `<li class="checklist-item${item.done ? ' done' : ''}" data-checklist-item="${esc(item.id)}" data-revision="${esc(item.revision)}">${
    editable ? `<button type="button" class="checklist-grip" data-checklist-grip aria-label="Move ${title}" title="Drag to reorder · Arrow keys to move">${icons.grip}</button>` : ''
  }<label class="checklist-check"><input type="checkbox" id="checklist-done-${id}" class="checklist-done" data-checklist-done data-autosave aria-label="Done: ${title}"${item.done ? ' checked' : ''}${editable ? '' : ' disabled'}></label>${
    editable ? `<textarea id="checklist-title-${id}" class="checklist-title" rows="1" maxlength="140" aria-label="Checklist item" data-autosave data-checklist-title${draft?.unsaved ? ' data-unsaved aria-description="Not saved"' : ''}>${esc(draft?.value ?? item.title)}</textarea>` : `<span class="checklist-title">${title}</span>`
  }${editable ? `<button type="button" class="row-x icon-button" data-checklist-remove aria-label="Remove ${title}" title="Remove">${icons.close}</button>` : ''}</li>`;
}

/**
 * The checklist section of `task`'s page. Someone who can't change the Board
 * sees the items without controls, and no section when there are none.
 * @param {ChecklistTask} task @param {boolean} editable
 */
export function checklistHtml(task, editable) {
  const items = task.checklist ?? [];
  if (!items.length && !editable) return '';
  const done = items.filter(item => item.done).length, full = items.length >= MAX_ITEMS;
  const progress = items.length ? `<span class="mono subtle checklist-count" aria-hidden="true">${done}/${items.length}</span><span class="sr-only">${done} of ${items.length} done</span><span class="checklist-progress" aria-hidden="true"><span style="width:${Math.round(done * 100 / items.length)}%"></span></span>` : '';
  return `<div class="tp-sec task-checklist" data-checklist-task="${esc(task.id)}" data-editable="${esc(editable)}">
    <div class="checklist-heading"><h2 id="task-checklist-label">Checklist</h2>${progress}</div>
    <ul class="checklist" aria-labelledby="task-checklist-label">${items.map(item => itemHtml(item, editable)).join('')}</ul>${
    editable ? `<input class="ctl checklist-add" data-checklist-add maxlength="140" aria-label="Add a checklist item" placeholder="${full ? `${MAX_ITEMS} items is the limit` : 'Add an item'}"${full ? ' disabled' : ''}><p class="sr-only" role="status" data-checklist-status></p>` : ''}</div>`;
}

/** The checklist section that shows `taskId`'s items, when its page is open. @param {string} taskId */
function sectionOf(taskId) {
  return [...document.querySelectorAll('.task-checklist')].find(section => /** @type {HTMLElement} */ (section).dataset.checklistTask === taskId) ?? null;
}

/** The row of item `itemId` in `list`. @param {Element} list @param {string} itemId */
function rowOf(list, itemId) {
  return [...list.querySelectorAll('[data-checklist-item]')].find(row => /** @type {HTMLElement} */ (row).dataset.checklistItem === itemId) ?? null;
}

/** The title field of item `itemId` as the page shows it now. @param {string} taskId @param {string} itemId */
function titleField(taskId, itemId) {
  const section = sectionOf(taskId), row = section && rowOf(section, itemId);
  return row?.querySelector('textarea[data-checklist-title]') ?? null;
}

/**
 * Show `task`'s checklist again where its page shows it. Rows that stay keep
 * their elements, so focus, a title being typed and a held grip survive; the
 * section keeps the editing mode its page was drawn with.
 * @param {ChecklistTask|null|undefined} task
 */
export function refreshChecklist(task) {
  const section = task ? sectionOf(task.id) : null;
  if (!task || !section) return;
  const template = document.createElement('template');
  setTrustedHTML(template, checklistHtml(task, /** @type {HTMLElement} */ (section).dataset.editable === 'true'));
  const next = template.content.querySelector('.task-checklist');
  if (!next) { section.remove(); return; }
  // A row that moves loses focus from what is in it, which gets it back below.
  const active = section.contains(document.activeElement) ? /** @type {HTMLTextAreaElement} */ (document.activeElement) : null;
  const selection = typeof active?.selectionStart === 'number' ? /** @type {const} */ ([active.selectionStart, active.selectionEnd, active.selectionDirection]) : null;
  const list = /** @type {HTMLElement} */ (section.querySelector('.checklist')), rows = UIMotion.rows(list, '[data-checklist-item]', 'data-checklist-item');
  const existing = new Map([...list.children].map(row => [/** @type {HTMLElement} */ (row).dataset.checklistItem, row]));
  const placed = [...(next.querySelector('.checklist')?.children ?? [])].map(row => {
    const old = existing.get(/** @type {HTMLElement} */ (row).dataset.checklistItem);
    return old ? patchInPlace(old, row) : row;
  });
  // Rows that went leave first, so the ones after them stay where they are.
  for (const row of existing.values()) if (row && !placed.includes(row)) row.remove();
  placeRows(list, placed);
  // Patching sets what the markup starts with; set what the controls show too,
  // except the title someone is typing.
  for (const item of task.checklist ?? []) {
    const row = rowOf(list, item.id);
    const done = /** @type {HTMLInputElement|null} */ (row?.querySelector('[data-checklist-done]')), title = /** @type {HTMLTextAreaElement|null} */ (row?.querySelector('textarea[data-checklist-title]'));
    if (done) done.checked = item.done;
    if (title && title !== active) title.value = title.defaultValue;
  }
  for (const selector of ['.checklist-heading', '.checklist-add']) {
    const now = section.querySelector(selector), then = next.querySelector(selector);
    if (now && then) patchInPlace(now, then);
  }
  if (active?.isConnected && document.activeElement !== active) {
    active.focus({ preventScroll: true });
    if (selection) active.setSelectionRange(...selection);
  }
  UIMotion.reflow(list, '[data-checklist-item]', 'data-checklist-item', rows);
}

/** The task and item of a control in a checklist. @param {Element} control */
function owner(control) {
  const taskId = /** @type {HTMLElement|null} */ (control.closest('[data-checklist-task]'))?.dataset.checklistTask;
  const itemId = /** @type {HTMLElement|null} */ (control.closest('[data-checklist-item]'))?.dataset.checklistItem;
  return { taskId, itemId };
}
const report = (/** @type {unknown} */ error) => runtime().report(error);

/** A title as one line, the way the server keeps it. @param {string} value */
const oneLine = (value) => value.replace(/\s+/g, ' ').trim();

/** Where focus goes when a row goes: the next row, else the one before, else the add field. @param {Element} row */
function focusAfter(row) {
  const neighbour = row.nextElementSibling ?? row.previousElementSibling;
  return /** @type {HTMLElement|null} */ (neighbour?.querySelector('[data-checklist-done]') ?? row.closest('.task-checklist')?.querySelector('[data-checklist-add]') ?? null);
}

/** Say where a moved item landed, for screen readers. @param {string} taskId @param {string} itemId */
function announceMove(taskId, itemId) {
  const section = sectionOf(taskId), row = section && rowOf(section, itemId), status = section?.querySelector('[data-checklist-status]');
  if (!row || !status) return;
  const rows = [...row.parentElement?.children ?? []], title = /** @type {HTMLTextAreaElement|null} */ (row.querySelector('textarea[data-checklist-title]'))?.value ?? '';
  status.textContent = `${title} moved to position ${rows.indexOf(row) + 1} of ${rows.length}`;
}

/**
 * Answer the checklists' controls in `doc`: ticks, titles that save
 * themselves as they lose focus, removal, the add field and moving by grip.
 * @param {Document} doc
 */
export function installChecklistControls(doc) {
  /** The revision each title had when someone started typing it, which its save builds on. */
  const bases = new WeakMap();
  doc.addEventListener('change', event => {
    const box = /** @type {HTMLInputElement} */ (event.target);
    if (!box.matches?.('[data-checklist-done]')) return;
    const { taskId, itemId } = owner(box);
    if (taskId && itemId) runtime().updateChecklistItem(taskId, itemId, { done: box.checked }).catch(report);
  });
  doc.addEventListener('click', event => {
    const button = /** @type {Element} */ (event.target).closest?.('[data-checklist-remove]'), row = button?.closest('[data-checklist-item]');
    if (!button || !row) return;
    const { taskId, itemId } = owner(button), next = focusAfter(row);
    if (taskId && itemId) runtime().deleteChecklistItem(taskId, itemId).catch(report);
    // The row is gone at once, and its button with it.
    next?.focus({ preventScroll: true });
  });
  doc.addEventListener('focusin', event => {
    const title = /** @type {HTMLTextAreaElement} */ (event.target);
    if (title.matches?.('textarea[data-checklist-title]') && !bases.has(title)) bases.set(title, Number(/** @type {HTMLElement} */ (title.closest('[data-checklist-item]'))?.dataset.revision));
  });
  // Blur doesn't bubble; listening as it travels down also hears the blur
  // that Cmd/Ctrl+S sends to the field itself, which saves it in place.
  doc.addEventListener('blur', event => {
    const title = /** @type {HTMLTextAreaElement} */ (event.target);
    if (!title.matches?.('textarea[data-checklist-title]')) return;
    const base = bases.get(title), value = oneLine(title.value), { taskId, itemId } = owner(title);
    // A title saved with the shortcut keeps focus, and its next save builds on the same revision.
    if (doc.activeElement !== title) bases.delete(title);
    if (!taskId || !itemId) return;
    // An emptied title puts back the one it showed.
    if (!value) { title.value = title.defaultValue; return; }
    title.value = value;
    // A title whose save was refused is sent again, even unchanged.
    if (value === title.defaultValue && !title.matches('[data-unsaved]')) return;
    runtime().updateChecklistItem(taskId, itemId, { title: value }, { expectedRevision: base, conflictElement: () => titleField(taskId, itemId) }).catch(report);
  }, true);
  doc.addEventListener('keydown', event => {
    const field = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (event.target);
    if (event.isComposing || event.keyCode === 229) return;
    if (field.matches?.('textarea[data-checklist-title]')) {
      // Enter leaves the field, which saves it; Escape puts back what it showed.
      if (event.key === 'Enter') { event.preventDefault(); field.blur(); }
      else if (event.key === 'Escape' && field.value !== field.defaultValue) { event.preventDefault(); event.stopPropagation(); field.value = field.defaultValue; }
      return;
    }
    if (!field.matches?.('[data-checklist-add]')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); field.value = ''; field.blur(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const title = oneLine(field.value), { taskId } = owner(field);
    if (!title || !taskId) return;
    // The field is ready for the next item at once, and gets this one back if it can't be added.
    field.value = '';
    runtime().addChecklistItem(taskId, title).catch((/** @type {unknown} */ error) => { if (!field.value) field.value = title; report(error); });
  });
  sortable({
    grip: '#app .task-checklist [data-checklist-grip]', row: '[data-checklist-item]', list: '.task-checklist', scroll: '.task-page',
    label: row => /** @type {HTMLTextAreaElement|null} */ (row.querySelector('textarea[data-checklist-title]'))?.value ?? '',
    move: (grip, target, after) => {
      const { taskId, itemId } = owner(grip), targetId = /** @type {HTMLElement} */ (target).dataset.checklistItem;
      if (!taskId || !itemId || !targetId) return;
      runtime().moveChecklistItem(taskId, itemId, after ? { afterItemId: targetId } : { beforeItemId: targetId }).catch(report);
      announceMove(taskId, itemId);
    },
  });
}
