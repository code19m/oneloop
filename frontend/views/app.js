// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* Application view renderer, an ES module that frontend/src/app/boot.js
   imports once it has set DATA and loaded the classic view scripts. The view
   bridge then adds the server-backed actions to `App`. See
   frontend/README.md before changing an action. */

import {
  MOTION, animateHeight, animateLayout, exitVisual, exitVisuals, fadeContent, motionRects,
  reducedMotion, uiAnimate, uiAnimations,
} from './app/effects.js';
import {
  DAY, I, STATUS, ago, avatarHtml, cleanStr, d, esc, formatInstant, human, humanFull,
  humanInstant, humanShort, instanceDateKey, instanceTimeZone, instanceToday, iso, overdue,
  previousDate, setHTML, stIcon, today,
} from './app/format.js';
import {
  App, D, activeAdmins, canBoard, canReadProject, canReadTask, canRoadmap, collaboration, counts,
  epicById, epics, hasPermission, instanceNow, invoke, isAdmin, locallyRenderedHashes, me,
  milestones, poolItems, project, projectMembers, setLocalHash, state, taskById, tasks, trackById,
  tracks, userById, userHandle, visibleProjects,
} from './app/model.js';
import {
  EPIC_TIP, POP, askConfirmation, askToDiscard, closePop, dismissMenu, hideEpicTip,
  mountRoadmapTip, openPop, overlayKey, peekOpened, pendingConfirmation, placeMenu, placePop,
  rememberOpener, renderMenu, restoreOpener, showWaitingPassword, stampOverlays, syncOverlayFocus,
  syncSidebar,
} from './app/overlays.js';

const NO_ASSIGNEE = '__unassigned__';
const TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const actFeed = (list, limit) => (list || []).slice(-(limit || 8)).reverse().map((a) =>
  `<div class="act-row"><span class="act-dot"></span><span class="act-text"><b>${esc(userById(a.who)?.name||a.actorName||a.who)}</b> ${esc(a.text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,''))}</span><time class="act-time" datetime="${new Date(a.ts).toISOString()}" aria-label="${formatInstant(a.ts)}" data-tip="${esc(formatInstant(a.ts))}">${ago(a.ts)}</time></div>`).join('')
  || '<div class="empty-note" style="border:0;text-align:left;padding:4px 0">nothing yet</div>';
const boardScrollMemory=new Map();
function prepareRenderMotion(overlaysOnly=false) {
  const page = overlaysOnly?null:document.querySelector('.content');
  const previous = new Map();
  if(page?.dataset.pageKey?.includes(':board:'))boardScrollMemory.set(`${D.session?.userId}:${page.dataset.pageKey}`, [...document.querySelectorAll('.board,.col-cards')].map(el=>[el.closest('[data-col]')?.dataset.col,el.scrollLeft,el.scrollTop]));
  const scrim = document.querySelector('#overlay-root > .scrim');
  if (state.modal || state.peek || state.menu) {
    exitVisuals.forEach(el => { uiAnimations.get(el)?.cancel(); el.remove(); }); exitVisuals.clear();
  } else if (scrim) exitVisual(scrim);
  ['.modal','.peek','.menu'].forEach((selector) => {
    const el = document.querySelector('#app ' + selector);
    if (!el) return;
    previous.set(selector, el.dataset.motionKey || '');
    if (!overlayKey(selector)) exitVisual(el);
  });
  return { previous, hadBlock:!!document.querySelector('.task-block'), pageState:page?.querySelector('.page-error,.loading-state')?.className||'ready', hadScrim: !!scrim, pageKey: page?.dataset.pageKey, scrolls: [...(overlaysOnly?[]:document.querySelectorAll('.content,.task-page,.settings,.board,.col-cards'))].map(el => [el.className, el.closest('[data-col]')?.dataset.col, el.scrollLeft, el.scrollTop]) };
}
function finishRenderMotion(before,overlaysOnly=false) {
  if (before.hadScrim) document.querySelectorAll('#overlay-root > .scrim').forEach(el => { el.style.animation = 'none'; });
  const page = overlaysOnly?null:document.querySelector('.content');
  const key = `${state.projectId}:${state.view}:${state.view === 'task' ? state.taskId : ''}`;
  if (page) {
    page.dataset.pageKey = key;
    if (before.pageKey && before.pageKey !== key) {
      fadeContent(page);
      if(state.view==='board')for(const [col,left,top] of boardScrollMemory.get(`${D.session?.userId}:${key}`)||[]){const el=document.querySelector(col?`[data-col="${UIEscape(col)}"] .col-cards`:'.board');if(el){el.scrollLeft=left;el.scrollTop=top;}}
    }
    else if (before.pageKey === key) before.scrolls.forEach(([classes, col, left, top]) => {
      const selector = '.' + classes.trim().split(/\s+/).join('.');
      const el = document.querySelector(col ? `[data-col="${UIEscape(col)}"] ${selector}` : selector);
      if (el) { el.scrollLeft = left; el.scrollTop = top; }
    });
  }
  if(!overlaysOnly&&!before.hadBlock)UIMotion.enter(document.querySelector('.task-block'));
  ['.modal','.peek','.menu'].forEach((selector) => {
    const el = document.querySelector('#app ' + selector);
    if (!el) return;
    const key = overlayKey(selector); el.dataset.motionKey = key;
    if (before.previous.get(selector) === key) el.style.animation = 'none';
  });
}

// Notifications live outside #app so renders never restart them or clear entered text.
const toastQueue = [];
const toastPaused = new Set(document.hidden ? ['hidden'] : []);
let toastSequence = 0;
function setToastPause(reason, paused) {
  const wasPaused = toastPaused.size > 0;
  if (paused) toastPaused.add(reason); else toastPaused.delete(reason);
  if (!wasPaused && toastPaused.size) toastQueue.forEach(toast => {
    if (toast.timer != null) { clearTimeout(toast.timer); toast.timer = null; toast.remaining = Math.max(0, toast.remaining - (Date.now() - toast.started)); }
  });
  else if (wasPaused && !toastPaused.size) toastQueue.filter(toast => toast.el).forEach(startToastTimer);
}
function startToastTimer(toast) {
  clearTimeout(toast.timer); toast.timer = null;
  if (!toast.el || toastPaused.size) return;
  toast.started = Date.now();
  toast.timer = setTimeout(() => dismissToast(toast.id), toast.remaining);
}
function ensureToastRegion() {
  let region = document.getElementById('toast-region');
  if (region) return region;
  region = document.createElement('section'); region.id = 'toast-region'; region.className = 'toast-region';
  region.setAttribute('aria-label', 'Notifications');
  setHTML(region,'<div class="sr-only" data-announce="polite" role="status" aria-live="polite" aria-atomic="true"></div><div class="sr-only" data-announce="assertive" role="alert" aria-atomic="true"></div><div class="toast-stack"></div><div class="toast-queued" hidden></div>');
  region.addEventListener('pointerenter', () => setToastPause('hover', true));
  region.addEventListener('pointerleave', () => setToastPause('hover', false));
  region.addEventListener('focusin', () => setToastPause('focus', true));
  region.addEventListener('focusout', event => { if (!region.contains(event.relatedTarget)) setToastPause('focus', false); });
  document.body.append(region); return region;
}
const announcements = { polite: [], assertive: [] };
function announce(text, kind = 'polite') {
  const node = ensureToastRegion().querySelector(`[data-announce="${UIEscape(kind)}"]`);
  const queue = announcements[kind]; queue.push(text);
  if (queue.length > 1) return;
  const next = () => {
    node.textContent = '';
    requestAnimationFrame(() => {
      node.textContent = queue[0];
      setTimeout(() => { queue.shift(); if (queue.length) next(); }, 150);
    });
  };
  next();
}
function toastPositions() {
  return new Map(toastQueue.filter(toast => toast.el).map(toast => [toast.id, { rect: toast.el.getBoundingClientRect(), opacity: getComputedStyle(toast.el).opacity }]));
}
function showQueuedToasts(before = toastPositions()) {
  const region = ensureToastRegion(), stack = region.querySelector('.toast-stack');
  let visible = toastQueue.filter(toast => toast.el).length;
  const added = new Set();
  for (const toast of toastQueue) {
    if (toast.el || visible >= 3) continue;
    const el = document.createElement('div'); el.className = 'toast'; el.dataset.toastId = toast.id; el.dataset.kind = toast.kind;
    const icon = document.createElement('span'); icon.className = 'toast-icon'; icon.setAttribute('aria-hidden', 'true');
    const path = toast.kind === 'success' ? '<path d="m6 10 3 3 5-6"/>' : toast.kind === 'error' ? '<path d="m7 7 6 6m0-6-6 6"/>' : '<path d="M10 9v5m0-8v.1"/>';
    setHTML(icon,`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/>${path}</svg>`);
    const message = document.createElement('div'); message.className = 'toast-message'; message.textContent = toast.text;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', 'Dismiss notification'); setHTML(close,I.close);
    close.addEventListener('click', () => dismissToast(toast.id));
    el.append(icon, message);
    const undo = toast.action?.label === 'Undo';
    if (toast.action) {
      // The action runs once, and the message goes with it.
      const action = document.createElement('button'); action.type = 'button'; action.className = 'btn toast-action'; action.textContent = toast.action.label;
      if (undo) { action.setAttribute('aria-keyshortcuts', UNDO_KEY.aria); const key = document.createElement('kbd'); key.className = 'toast-key'; key.setAttribute('aria-hidden', 'true'); key.textContent = UNDO_KEY.label; action.append(key); }
      action.addEventListener('click', () => { const run = toast.action.run; dismissToast(toast.id); run(); }, { once: true });
      el.append(action);
    }
    el.append(close); stack.append(el); toast.el = el; added.add(toast.id); visible++;
    announce(undo ? `${/[.!?]$/.test(toast.text) ? toast.text : `${toast.text}.`} Press ${UNDO_KEY.spoken} to undo.` : toast.text, toast.kind === 'error' ? 'assertive' : 'polite');
    startToastTimer(toast);
  }
  const waiting = toastQueue.filter(toast => !toast.el).length;
  const count = region.querySelector('.toast-queued'); count.hidden = !waiting; count.textContent = waiting ? `${waiting} queued` : '';
  toastQueue.filter(toast => toast.el).forEach(toast => {
    if (added.has(toast.id)) uiAnimate(toast.el, [{ opacity:0, transform:'translateX(12px)' },{ opacity:1, transform:'none' }]);
    else if (before.has(toast.id)) {
      const from = before.get(toast.id), to = toast.el.getBoundingClientRect();
      if (Math.abs(from.rect.top - to.top) > 1) uiAnimate(toast.el, [{ opacity:from.opacity, transform:`translateY(${from.rect.top - to.top}px)` },{ opacity:1, transform:'none' }]);
    }
  });
}
/**
 * `action` adds a button, such as Undo, that runs `action.run` once. With
 * `until`, a time, the message stays until then.
 */
function pushToast(text, kind = 'success', { action = null, until = null } = {}) {
  const message = cleanStr(text, 500);
  if (!message) return null;
  if (!['success','error','info'].includes(kind)) kind = 'info';
  action = typeof action?.run === 'function' ? { label: cleanStr(action.label, 40) || 'Undo', run: action.run } : null;
  const lifetime = Number.isFinite(until) ? Math.max(0, until - Date.now()) : Math.max(action ? 10000 : kind === 'error' ? 8000 : 4000, Math.min(message.length * 40, 12000));
  // Each action belongs to its own change, so those messages never merge.
  const existing = !action && toastQueue.find(toast => !toast.action && toast.kind === kind && toast.text === message);
  if (existing) { existing.remaining = lifetime; startToastTimer(existing); return existing.id; }
  const toast = { id: String(++toastSequence), text: message, kind, action, remaining: lifetime, timer:null, el:null, restoreFocus:document.activeElement };
  toastQueue.push(toast); showQueuedToasts(); return toast.id;
}
// The server keeps a deleted item for five minutes, when it can still be restored.
const UNDO_WINDOW_MS = 5 * 60_000;
/**
 * Offer Undo for a deletion the server just accepted. `restore(again)`
 * brings the item back. When that fails in a way worth trying again, such
 * as no connection, a busy server or an unknown result, it calls
 * `again(message)`: the message then offers Undo again, and stays for as
 * long as the server can still restore the item.
 */
function offerUndo(text, restore, { until = Date.now() + UNDO_WINDOW_MS, kind = 'success' } = {}) {
  const again = (failure) => {
    if (Date.now() >= until) App.toast(failure, 'error');
    else offerUndo(failure, restore, { until, kind: 'error' });
  };
  return App.toast(text, kind, { action: { label: 'Undo', run: () => restore(again) }, until: kind === 'error' ? until : null });
}
// Undo also answers Ctrl+Z, or Command+Z on Apple devices, while its message
// shows, so the keyboard reaches it without moving focus. In a text field
// the key undoes typing, as always, and with a dialog, drawer or menu open
// it does nothing. On a layout without Latin letters, the key in the Z
// place counts too; on others that place can hold another letter, such as
// the Y of a German keyboard, so only the letter counts.
const UNDO_KEY = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || '')
  ? { label: '⌘Z', aria: 'Meta+Z', spoken: 'Command+Z' } : { label: 'Ctrl+Z', aria: 'Control+Z', spoken: 'Control+Z' };
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || (String(event.key).toLowerCase() !== 'z' && (/^[a-z]$/i.test(event.key) || event.code !== 'KeyZ'))) return;
  if (event.target?.closest?.('input,textarea,select,[contenteditable="true"],.confirmation-layer,.modal,[role="dialog"]') || state.modal || state.peek || state.menu || POP.el || pendingConfirmation || document.querySelector('.confirmation-layer,.file-overlay')) return;
  const toast = toastQueue.findLast(item => item.el && item.action?.label === 'Undo');
  if (!toast) return;
  event.preventDefault();
  toast.el.querySelector('.toast-action')?.click();
});
function dismissToast(id) {
  const index = toastQueue.findIndex(toast => toast.id === String(id));
  if (index < 0) return;
  const before = toastPositions(), [toast] = toastQueue.splice(index, 1);
  clearTimeout(toast.timer);
  const el = toast.el, restoreFocus = el?.contains(document.activeElement);
  if (el) {
    const rect = el.getBoundingClientRect(), opacity = getComputedStyle(el).opacity;
    el.removeAttribute('data-toast-id'); el.classList.add('toast-leaving'); el.inert = true; el.setAttribute('aria-hidden','true');
    Object.assign(el.style, { position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',margin:'0' });
    const animation = uiAnimate(el, [{opacity,transform:'none'},{opacity:0,transform:'translateX(8px)'}], MOTION.quick);
    if (animation) animation.finished.then(() => el.remove(), () => el.remove()); else el.remove();
  }
  showQueuedToasts(before);
  if (restoreFocus) {
    const target = toastQueue.find(item => item.el)?.el.querySelector('.toast-close') || (toast.restoreFocus?.isConnected ? toast.restoreFocus : document.querySelector('.menu-btn'));
    target?.focus({preventScroll:true});
  }
  if (!toastQueue.length) { setToastPause('hover', false); setToastPause('focus', false); }
}
document.addEventListener('visibilitychange', () => setToastPause('hidden', document.hidden));

// Popovers are imperative on purpose: opening one never re-renders the app,
// so text already typed into a form is never lost.
const SELS = {}, DPS = {};
function setFieldError(control, wrap, message, className = 'ferr') {
  if (!control || !wrap) return;
  if (!control.id) control.id = 'field-error-control-' + (++fieldSequence);
  const id = control.id + '-error';
  const descriptions = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  let error = document.getElementById(id) || wrap.querySelector('.ferr');
  if (message) {
    if (!error) { error = document.createElement('div'); wrap.append(error); }
    error.id = id; error.className = className; error.setAttribute('role', 'alert'); error.textContent = message;
    descriptions.add(id); control.classList.add('invalid'); control.setAttribute('aria-invalid', 'true');
  } else {
    if (error) descriptions.delete(error.id);
    descriptions.delete(id); error?.remove(); control.classList.remove('invalid'); control.removeAttribute('aria-invalid');
  }
  if (descriptions.size) control.setAttribute('aria-describedby', [...descriptions].join(' '));
  else control.removeAttribute('aria-describedby');
}
function clearFieldError(control) {
  setFieldError(control, control.closest('.field, .task-title-field, .date-field') || control.parentNode, '');
}
function failField(form, name, msg) {
  const inp = form.querySelector(`[name="${name}"]`);
  if (!inp) return false;
  const wrap = inp.closest('.field') || inp.parentNode;
  const ctl = inp.matches('input:not([type=hidden]),textarea') ? inp : wrap.querySelector('.ctl');
  setFieldError(ctl, wrap, msg);
  ctl?.focus();
  return false;
}

function selectHtml(key, def) {
  SELS[key] = def;
  const cur = def.options.find((o) => o.v === def.value);
  return `<div class="sel"${def.width ? ` style="width:${def.width}px"` : ''}>
    ${def.name ? `<input type="hidden" name="${def.name}" value="${esc(def.value ?? '')}">` : ''}
    <button type="button" id="select-${UIEscape(key)}" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${def.label ? `select-${key}-name ` : ''}select-${key}-value" class="ctl sel-btn${def.cls ? ' ' + def.cls : ''}${cur ? '' : ' empty'}" data-tip="${esc(cur ? cur.l : (def.placeholder || 'Select'))}" data-tip-overflow ${def.disabled ? 'disabled' : UIAction('popSelect', UIAction.event, key)}>${def.label ? `<span class="sr-only" id="select-${UIEscape(key)}-name">${esc(def.label)}</span>` : ''}${def.icon || ''}<span id="select-${UIEscape(key)}-value" class="sel-label">${esc(cur ? cur.l : (def.placeholder || 'Select'))}</span>${def.cls ? '' : I.chev}</button>
  </div>`;
}
const MULTI = {};
function multiHtml(key, def) {
  MULTI[key] = def;
  const label = def.summary();
  return `<div class="sel"${def.width ? ` style="width:${def.width}px"` : ''}>
    <button type="button" data-filter-key="${esc(key)}" aria-expanded="false" class="ctl sel-btn${def.cls ? ' ' + def.cls : ''}${def.values().length ? '' : ' empty'}" data-tip="${esc(label)}" data-tip-overflow ${def.label ? `aria-label="${esc(def.label)}"` : ''} ${def.disabled ? 'disabled' : UIAction('popMulti', UIAction.event, key)}>${def.icon ? def.icon() : ''}<span class="sel-label">${esc(label)}</span>${def.cls ? '' : I.chev}</button>
  </div>`;
}
// Date values always use ISO. The editor owns separators; users enter digits.
function parseDateInput(raw) {
  const text = String(raw ?? '');
  if (!text) return '';
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!parts) return null;
  const [, year, month, day] = parts;
  const y = Number(year), m = Number(month), n = Number(day);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || n < 1 || n > 31) return null;
  const dt = new Date(0); dt.setUTCFullYear(y, m - 1, n);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== n) return null;
  return text;
}
function formatDateDigits(raw) {
  const digits = String(raw).replace(/[^0-9]/g, '').slice(0, 8);
  return digits.slice(0, 4) + (digits.length >= 4 ? '-' + digits.slice(4, 6) : '') + (digits.length >= 6 ? '-' + digits.slice(6, 8) : '');
}
function digitCaret(value, count) {
  if (!count) return 0;
  let seen = 0, pos = 0;
  while (pos < value.length && seen < count) { if (/[0-9]/.test(value[pos])) seen++; pos++; }
  while (value[pos] === '-') pos++;
  return pos;
}
function inputKind(input) {
  if (input.classList.contains('date-text')) return 'date';
  if (input.name === 'username') return 'username';
  if (input.name === 'key') return 'key';
  return 'text';
}
function sanitizeInputValue(input, value) {
  if (input.type === 'password') return value;
  const kind = inputKind(input);
  if (input.classList.contains('tp-title')) value = value.replace(/[\r\n\t]+/g, ' ');
  if (kind === 'date') return formatDateDigits(value);
  if (kind === 'username') return value.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 32);
  if (kind === 'key') return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return value.replace(input.tagName === 'TEXTAREA' ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g, '');
}
// Cut text to `max` UTF-16 units, as maxlength counts them, without splitting
// a character: half of a surrogate pair cannot be saved.
function clampText(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 32);
  const parts = typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(head), part => part.segment) : Array.from(head);
  let out = '';
  for (const part of parts) { if (out.length + part.length > max) break; out += part; }
  return out;
}
function insertCleanText(input, text) {
  const kind = inputKind(input), old = input.value;
  const from = input.selectionStart ?? old.length, to = input.selectionEnd ?? from;
  let fragment = kind === 'username' ? text.toLowerCase().replace(/[^a-z0-9._-]/g, '')
    : kind === 'key' ? text.toUpperCase().replace(/[^A-Z0-9]/g, '')
    : sanitizeInputValue(input, text);
  if (!fragment && text) return;
  if (input.maxLength >= 0) fragment = clampText(fragment, Math.max(0, input.maxLength - (old.length - (to - from))));
  const prefix = old.slice(0, from) + fragment;
  input.value = sanitizeInputValue(input, prefix + old.slice(to));
  const caret = Math.min(sanitizeInputValue(input, prefix).length, input.value.length);
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function editableText(input) {
  return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement && ['text','search','url','email','tel','password'].includes(input.type);
}
function normalizeInput(input) {
  if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password') return;
  const old = input.value, caret = input.selectionStart ?? old.length;
  const value = sanitizeInputValue(input, old);
  if (value === old) return;
  const next = inputKind(input) === 'date' ? digitCaret(value, old.slice(0, caret).replace(/[^0-9]/g, '').length) : sanitizeInputValue(input, old.slice(0, caret)).length;
  input.value = value; input.setSelectionRange(next, next);
}
function editDateDigits(input, text, deletion) {
  const value = input.value;
  let from = value.slice(0, input.selectionStart).replace(/[^0-9]/g, '').length;
  let to = value.slice(0, input.selectionEnd).replace(/[^0-9]/g, '').length;
  const digits = value.replace(/[^0-9]/g, '');
  if (deletion && from === to) {
    if (deletion.includes('Backward')) from = Math.max(0, from - 1);
    else to = Math.min(digits.length, to + 1);
  }
  const inserted = text.replace(/[^0-9]/g, '').slice(0, Math.max(0, 8 - (digits.length - (to - from))));
  input.value = formatDateDigits(digits.slice(0, from) + inserted + digits.slice(to));
  const caret = digitCaret(input.value, from + inserted.length);
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function dateError(def, value) {
  if (value === null) return 'Enter a valid date in YYYY-MM-DD format.';
  if (!value) return def.clearable ? '' : 'Enter a date.';
  const min = def.min?.(), max = def.max?.();
  if (min && value < min) return def.minError || 'Date is before the allowed start.';
  if (max && value > max) return def.maxError || 'Date is after the allowed end.';
  return '';
}
function dateFieldError(wrap, message, focus = false) {
  const input = wrap.querySelector('.date-text');
  setFieldError(input, wrap, message, 'ferr date-error');
  if (message && focus) input.focus();
  return !message;
}
function dateValue(key) {
  const input = document.querySelector(`[data-date-key="${UIEscape(key)}"] .date-text`);
  return input ? parseDateInput(input.value) : '';
}
function commitDate(key, raw, focusError = false) {
  const def = DPS[key], wrap = document.querySelector(`[data-date-key="${UIEscape(key)}"]`);
  if (!def || def.disabled || !wrap) return false;
  const value = parseDateInput(raw), error = dateError(def, value);
  if (error) return dateFieldError(wrap, error, focusError);
  const sending = value !== (def.value || '') && !!def.pick, result = sending ? def.pick(value) : true;
  if (result === false) { if (def.autosave) wrap.querySelector('.date-text').toggleAttribute('data-unsaved', true); return false; }
  const previous = def.value;
  def.value = value;
  wrap.querySelector('input[type="hidden"]').value = value;
  wrap.querySelector('.date-text').value = value || '';
  // A date that saves itself counts as saved once the server accepted it,
  // though it may keep focus, as after Enter. One the server refused counts
  // again, also once focus leaves it, and the next Enter or Tab sends it again.
  if (def.autosave) {
    const settled = (saved) => {
      const current = document.querySelector(`[data-date-key="${UIEscape(key)}"]`), input = current?.querySelector('.date-text'), shown = !!input && parseDateInput(input.value) === value;
      if (saved !== false) { if (shown) { window.Recovery?.markSaved?.(input); input.removeAttribute('data-unsaved'); } return; }
      if (DPS[key] !== def || def.value !== value) return;
      def.value = previous;
      const hidden = current?.querySelector('input[type="hidden"]'); if (hidden) hidden.value = previous || '';
      if (shown) input.toggleAttribute('data-unsaved', true);
    };
    if (sending && typeof result?.then === 'function') { def.pending = value; result.then((saved) => { if (def.pending === value) def.pending = null; settled(saved); }); }
    else if (def.pending !== value) settled(result);
  }
  dateFieldError(wrap, '');
  // A corrected range can resolve the other field's error as well.
  const scope = wrap.closest('form') || wrap.parentElement;
  scope.querySelectorAll('.date-field').forEach((other) => {
    if (other === wrap) return;
    const input = other.querySelector('.date-text');
    if (input.getAttribute('aria-invalid') === 'true' && !dateError(DPS[other.dataset.dateKey], parseDateInput(input.value))) dateFieldError(other, '');
  });
  return true;
}
function validateFormDates(form) {
  let firstInvalid;
  form.querySelectorAll('.date-field').forEach((wrap) => {
    const input = wrap.querySelector('.date-text');
    if (!commitDate(wrap.dataset.dateKey, input.value) && !firstInvalid) firstInvalid = input;
  });
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}
function dateHtml(key, def) {
  DPS[key] = def;
  const label = def.label || ({ start: 'Start date', end: 'End date', date: 'Date', _start: 'Start date', _dl: 'Deadline' }[def.name]) || 'Date';
  const placeholder = def.disabled ? 'Not set' : def.placeholder || (label === 'Date' ? 'Select date' : 'Set ' + label.toLowerCase());
  return `<div class="sel date-field${def.cls ? ' ' + def.cls : ''}" data-date-key="${UIEscape(key)}">
    <input type="hidden" name="${def.name}" value="${esc(def.value || '')}">
    ${def.cls && !def.hideLabel ? `<div class="date-inline-label">${label}${def.clearable ? optionalMark : ''}</div>` : ''}<div class="date-control"><input type="text" class="ctl date-text" id="${UIEscape(key)}-input" ${def.autosave ? 'data-autosave ' : ''}${def.clearable ? 'aria-required="false"' : 'required aria-required="true"'} aria-label="${label}" value="${esc(def.value || '')}" placeholder="${esc(placeholder)}" aria-description="Type a date in YYYY-MM-DD format or use the calendar." maxlength="10" inputmode="numeric" autocomplete="off" spellcheck="false" ${def.disabled ? 'disabled' : `${UIAction.on('input', 'dateTyping', key)} ${UIAction.on('blur', 'dateBlur', UIAction.event, key)} ${UIAction.on('keydown', 'dateKey', UIAction.event, key)}`}>
    <button type="button" class="date-trigger sel-btn" aria-label="Open ${label.toLowerCase()} calendar" aria-haspopup="dialog" aria-expanded="false" ${def.disabled ? 'disabled' : UIAction('popDate', UIAction.event, key)}>${def.icon || I.cal}</button></div>
  </div>`;
}
function calHtml(view, selected, focusDate, def) {
  const [, mo] = view.split('-').map(Number);
  const first = d(view + '-01');
  const gridStart = new Date(first); gridStart.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const dt = new Date(gridStart); dt.setUTCDate(gridStart.getUTCDate() + i);
    const ds = iso(dt);
    const cls = ['cal-d', dt.getUTCMonth() !== mo - 1 ? 'out' : '', ds === iso(today) ? 'today' : '', ds === selected ? 'sel' : '', ds === focusDate ? 'focus' : ''].join(' ');
    cells += `<button type="button" class="${cls}" data-d="${UIEscape(ds)}" aria-label="${humanFull(ds)}" aria-pressed="${ds === selected}" tabindex="${ds === focusDate ? 0 : -1}" ${dateError(def, parseDateInput(ds)) ? 'disabled' : ''}>${dt.getUTCDate()}</button>`;
  }
  return `<div class="cal">
    <div class="cal-head">
      <button type="button" class="btn icon" data-nav="-1" aria-label="Previous month">‹</button>
      <span class="cal-title">${first.toLocaleDateString('en-US', { timeZone:'UTC', month: 'long', year: 'numeric' })}</span>
      <button type="button" class="btn icon" data-nav="1" aria-label="Next month">›</button>
    </div>
    <div class="cal-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => `<div class="cal-wd">${w}</div>`).join('')}${cells}</div>
    <div class="cal-foot">
      <button type="button" class="btn quiet" data-today ${dateError(def, iso(today)) ? 'disabled' : ''}>Today</button>
      ${def.clearable ? '<button type="button" class="btn quiet" data-clear>Clear</button>' : ''}
    </div>
  </div>`;
}

// ---------- roadmap geometry ----------
// The model holds dates as whole days from the range start; pixels are days
// times the zoom level (pixels per day). A zoom step rewrites the positions
// of the existing elements instead of rebuilding the Roadmap, and the same
// functions produce them for the render and for every step.
let RAIL = 208;
const AXIS = 70, MONTH_ROW = 32, BAR_H = 58, ROW_GAP = 8, LANE_PAD = 14, EPIC_GAP = 8, EPIC_MIN_WIDTH = 60, GOAL_ROW = 58;
const ZOOM_MIN = 2.2, ZOOM_MAX = 42;
/** Fixed scales of the timeline, in pixels per day. Months is the zoom a Roadmap opens at. */
const ROADMAP_SCALES = [
  { key: 'weeks', label: 'Weeks', ppd: 30, shortcut: 'W' },
  { key: 'months', label: 'Months', ppd: 8.5, shortcut: 'M' },
  { key: 'quarters', label: 'Quarters', ppd: 2.6, shortcut: 'Q' },
];
/** Closer to Weeks than to Months, the axis shows weeks instead of months: a week is 126 px or more. */
const WEEK_AXIS_PPD = 18;
const roadmapScale = () => ROADMAP_SCALES.find((scale) => Math.abs(scale.ppd - state.pxPerDay) < 0.005) || null;
/** The epic last focused or opened on the Roadmap, which a scale change keeps in view. */
let roadmapSelection = null;

/** The data's dates: `start` anchors day 0 and `end` is the last date the timeline must reach before it fills the view. */
function rmRange() {
  let min = today, max = new Date(today.getTime() + 60 * DAY);
  epics().forEach((e) => {
    // An ongoing epic's start also extends the range, or a late one would fall past the end.
    const s = d(e.start); if (s < min) min = s; if (s > max) max = s;
    if (e.end) { const en = d(e.end); if (en > max) max = en; }
  });
  milestones().forEach((m) => { const md = d(m.date); if (md < min) min = md; if (md > max) max = md; });
  return { start: new Date(min.getTime() - 10 * DAY), end: new Date(max.getTime() + 45 * DAY) };
}

/** The Roadmap's tracks, epics and milestones as day offsets; nothing here depends on the zoom level. */
function roadmapModel() {
  const { start, end } = rmRange();
  const day = (dt) => Math.round((dt - start) / DAY);
  const all = epics();
  const lanes = tracks().map((track) => ({
    track,
    epics: all.filter((e) => e.trackId === track.id).sort((a, b) => d(a.start) - d(b.start))
      .map((epic) => ({ epic, from: day(d(epic.start)), to: epic.end ? day(d(epic.end)) : null })),
  }));
  const goals = milestones().slice().sort((a, b) => d(a.date) - d(b.date)).map((m) => {
    const date = d(m.date);
    const days = Math.round((date.getTime() - today.getTime()) / DAY);
    const past = days < 0;
    const name = m.name.charAt(0).toUpperCase() + m.name.slice(1);
    const dateLabel = humanShort(date) + (days > 0 ? ` · ${days}d away` : days === 0 ? ' · Today' : '');
    const width = Math.min(240, Math.max(112, name.length * (past ? 7.5 : 8.5) + (past ? 50 : 62), dateLabel.length * 6 + (past ? 50 : 62)));
    return { m, past, name, dateLabel, width, at: day(date) };
  });
  return { start, span: day(end), today: day(today), lanes, goals };
}

/**
 * The parts of the layout that change at a zoom level: which row each epic
 * and goal label takes, the lane heights and the axis height. `width` and
 * `height` are the content area's size.
 */
function roadmapLayout(model, ppd, { barHeight, width, height }) {
  const x = (days) => dayX(days, ppd);
  const timeline = timelineWidth(model, ppd, width);
  // Goal labels pack independently of epic lanes, including room for Today.
  const todayX = x(model.today);
  const labelRows = [[{ left: todayX - 34, right: todayX + 34 }]];
  const goalRows = model.goals.map((goal) => {
    const left = Math.max(6, Math.min(x(goal.at) - goal.width / 2, timeline - goal.width - 6));
    let row = labelRows.findIndex((items) => items.every((other) => left + goal.width + 12 <= other.left || left >= other.right + 12));
    if (row < 0) { row = labelRows.length; labelRows.push([]); }
    labelRows[row].push({ left, right: left + goal.width });
    return row;
  });
  const axisHeight = AXIS + (labelRows.length - 1) * GOAL_ROW;
  // Date intervals and minimum card widths must both fit before reusing a row.
  // An ongoing epic runs to the end of the range, so nothing later shares its row.
  const packed = model.lanes.map((lane) => {
    const rows = [];
    const assigned = lane.epics.map((item) => {
      const left = x(item.from);
      const right = item.to === null ? Infinity : left + Math.max(x(item.to) - left, EPIC_MIN_WIDTH);
      let row = rows.findIndex((last) => item.from > last.to && left >= last.right + EPIC_GAP);
      if (row < 0) row = rows.length;
      rows[row] = { to: item.to ?? Infinity, right };
      return row;
    });
    return { assigned, count: Math.max(rows.length, 1) };
  });
  // Packed minimum heights, then leftover viewport height shared evenly.
  const rowsHeight = (count) => count * barHeight + (count - 1) * ROW_GAP;
  const minHs = packed.map((lane) => Math.max(2 * LANE_PAD + rowsHeight(lane.count), 88));
  const availH = height - axisHeight - MONTH_ROW - 8;
  const extra = packed.length ? Math.max((availH - minHs.reduce((a, b) => a + b, 0)) / packed.length, 0) : 0;
  const lanes = packed.map((lane, i) => {
    const laneHeight = Math.round(minHs[i] + extra);
    return { rows: lane.assigned, count: lane.count, height: laneHeight, pad: Math.round((laneHeight - rowsHeight(lane.count)) / 2) };
  });
  return { ppd, axisHeight, goalRows, lanes };
}

/** The zoom factor of one wheel event, as a natural logarithm. */
const WHEEL_NOTCH = Math.log(1.15), MAC_WHEEL_LINE = 4.000244140625;
function wheelZoom(event) {
  const delta = event.deltaY;
  if (!delta) return 0;
  // A mouse notch zooms 15%: line or page deltas, large pixel deltas, or the
  // multiples of 4.000244140625 px that macOS sends. A touchpad pinch arrives
  // as many small pixel deltas (100 × the log of its scale), so the Roadmap
  // follows the fingers.
  const notch = event.deltaMode !== 0 || Math.abs(delta) >= 50 || Math.abs(delta) % MAC_WHEEL_LINE === 0;
  return notch ? -Math.sign(delta) * WHEEL_NOTCH : Math.max(-WHEEL_NOTCH, Math.min(WHEEL_NOTCH, -delta / 100));
}
const clampZoom = (ppd) => Math.round(Math.min(Math.max(ppd, ZOOM_MIN), ZOOM_MAX) * 1e4) / 1e4;
// Horizontal places at a zoom level, in whole pixels so text stays on the pixel grid.
const dayX = (days, ppd) => Math.round(days * ppd);
const barLeft = (item, ppd) => `${dayX(item.from, ppd)}px`;
/** An ongoing bar has no width: CSS runs it to the end of its lane. */
const barWidth = (item, ppd) => `${Math.max(dayX(item.to, ppd) - dayX(item.from, ppd), EPIC_MIN_WIDTH)}px`;
const barTop = (lane, row, barHeight) => `${lane.pad + row * (barHeight + ROW_GAP)}px`;
const timelineWidth = (model, ppd, width) => Math.max(dayX(model.span, ppd), width - RAIL);
/** A goal label's center: under its date, but kept inside the timeline. */
const goalCenter = (goal, ppd, timeline) => `${Math.max(6, Math.min(dayX(goal.at, ppd) - goal.width / 2, timeline - goal.width - 6)) + goal.width / 2}px`;

/** Task counts arrive with the Roadmap's own read; until then, a placeholder. */
const countsLoading = '<span style="color:var(--ink-faint)" aria-hidden="true">…</span><span class="sr-only">Loading task counts</span>';
function epicBar(item, ppd, top) {
  const e = item.epic, s = d(e.start);
  const ongoing = item.to === null, counted = e.counted !== false;
  const cls = ['bar', e.state, ongoing ? 'ongoing' : '', (counted && ongoing && e.total === 0 && e.state !== 'done') ? 'quiet' : ''].join(' ');
  const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;

  const right = e.state === 'done' ? I.check : '';

  let meta;
  if (!counted && e.state !== 'done') meta = countsLoading;
  else if (e.state === 'done') meta = `${counted && e.total ? e.done+'/'+e.total+' · ' : ''}<span style="color:var(--ok)">complete</span>`;
  else if (ongoing && e.total === 0) meta = '<span style="color:var(--ink-faint)">ongoing</span>';
  else if (ongoing) meta = `<span style="color:var(--ink-soft)">ongoing</span> · ${e.completedSinceStart ?? e.done} done · ${e.open ?? e.total - e.done} open`;
  else if (e.state === 'planning') meta = `${e.done}/${e.total} · starts ${humanShort(s)}`;
  else meta = `${e.done}/${e.total}`;

  const prog = (!counted || ongoing || e.total === 0) ? '' :
    `<div class="prog"><i style="width:${pct}%;background:${e.state === 'done' ? 'var(--ok)' : 'var(--run)'}"></i></div>`;

  return `<div class="${cls}" data-epic="${UIEscape(e.id)}" role="button" tabindex="0" aria-label="${esc(e.title)}" style="left:${barLeft(item, ppd)};top:${top};${ongoing ? '' : `width:${barWidth(item, ppd)}`}" ${UIAction('openPeek', e.id)} ${UIAction.on('mouseenter', 'epicHover', UIAction.event, e.id)} ${UIAction.on('mouseleave', 'epicLeave')} ${UIAction.on('focus', 'epicHover', UIAction.event, e.id, true)} ${UIAction.on('blur', 'epicLeave')} ${UIAction.on('keydown', 'epicKey', UIAction.event, e.id)}>
    <div class="t"><span class="txt">${esc(e.title)}</span>${right}</div>
    <div class="m">${meta}</div>${prog}</div>`;
}
// The words the product uses for an epic's status.
const epicStatus = (epic) => ({ planning: 'Planning', active: 'In progress', done: 'Done' })[epic.state] || epic.state;
function showEpicTip(anchor, id) {
  const epic = epicById(id);
  if (!epic||!canReadProject(trackById(epic.trackId)?.projectId)) return;
  const status = epicStatus(epic);
  mountRoadmapTip(anchor, 'epic-tooltip', `<div class="epic-tip-title">${esc(epic.title)}</div>
    <div class="epic-tip-track">${esc(trackById(epic.trackId)?.name || '')}</div>
    <dl class="epic-tip-facts"><div><dt>Status</dt><dd>${esc(status)}</dd></div><div><dt>Tasks</dt><dd>${epic.counted === false ? countsLoading : `${epic.done} / ${epic.total} done`}</dd></div>
    <div><dt>Start</dt><dd>${esc(epic.start)}</dd></div><div><dt>End</dt><dd>${epic.end ? esc(epic.end) : 'No end date'}</dd></div></dl>
    ${epic.desc ? `<div class="epic-tip-description">${esc(epic.desc)}</div>` : ''}`);
}
function showMilestoneTip(anchor, id) {
  const milestone = milestones().find(m => m.id === id);
  if (!milestone) return;
  const days = Math.round((d(milestone.date) - today) / DAY);
  const timing = days === 0 ? 'Today' : `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} ${days > 0 ? 'away' : 'ago'}`;
  mountRoadmapTip(anchor, 'milestone-tooltip', `<div class="epic-tip-title">${esc(milestone.name)}</div>
    <div class="epic-tip-track">Milestone · ${esc(project().name)}</div>
    <dl class="epic-tip-facts"><div><dt>Date</dt><dd>${esc(milestone.date)}</dd></div><div><dt>Timing</dt><dd>${timing}</dd></div></dl>
    <div class="epic-tip-description">${milestone.desc ? esc(milestone.desc) : '<span style="color:var(--ink-ghost)">No description</span>'}</div>`);
}

/** @type {number|null} */
let roadmapHeight=null;
function measureEpicHeight() {
  const probe = document.createElement('div');
  probe.className = 'bar planning';
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:300px';
  setHTML(probe, '<div class="t"><span class="txt">Epic</span></div><div class="m">0/1 · ongoing</div>');
  (document.querySelector('.content') || document.body).append(probe);
  const height = Math.max(BAR_H, Math.ceil(probe.getBoundingClientRect().height));
  probe.remove();
  return height;
}
/** @type {{model:any,layout:any,metrics:{barHeight:number,width:number,height:number}}|null} The latest rendered Roadmap, which mountRoadmap binds. */
let renderedRoadmap = null;
function renderRoadmap() {
  // A scale change still easing finishes first, so the new Roadmap starts at its zoom.
  roadmapGestureCleanup();
  const barHeight = measureEpicHeight();
  RAIL = window.innerWidth <= 900 ? 132 : 208;
  const model = roadmapModel();
  const contentEl = document.querySelector('.content');
  roadmapHeight=contentEl ? contentEl.clientHeight : window.innerHeight - 80;
  const metrics = { barHeight, width: contentEl?.clientWidth || window.innerWidth, height: roadmapHeight };
  const ppd = state.pxPerDay;
  const layout = roadmapLayout(model, ppd, metrics);
  const { axisHeight } = layout;
  renderedRoadmap = { model, layout, metrics };

  // Calendar cells are mounted for the viewport, independent of date span.
  let lanes = '';
  model.lanes.forEach(({ track: t, epics: items }, ti) => {
    const lane = layout.lanes[ti];
    const list = items.map((item) => item.epic);
    const active = list.filter((e) => e.state === 'active').length;
    const doneN = list.filter((e) => e.state === 'done').length;
    const cont = list.some((e) => !e.end);
    const sub = list.length
      ? `${list.length} epic${list.length > 1 ? 's' : ''}${active ? ` · ${active} active` : ''}${doneN ? ` · ${doneN} done` : ''}${cont ? ' · continuous' : ''}`
      : 'no epics yet';
    const bars = items.map((item, i) => epicBar(item, ppd, barTop(lane, lane.rows[i], barHeight))).join('');
    lanes += `<div class="lane" data-track="${UIEscape(t.id)}" ${canRoadmap() ? `${UIAction.on('dragover', 'laneOver', UIAction.event)} ${UIAction.on('drop', 'trackDrop', UIAction.event, t.id)}` : ''} style="height:${lane.height}px">
      <div class="rail-cell lane-head" style="width:${RAIL}px">
        <h2 class="name" data-tip="${esc(t.name)}" data-tip-overflow>${esc(t.name)}</h2><div class="sub">${sub}</div>
        ${canRoadmap() ? `<div class="head-ctl">
          <button type="button" class="grip" aria-label="Reorder ${esc(t.name)}" ${UIAction.on('keydown', 'trackReorderKey', UIAction.event, t.id)} data-reorderable="true" ${UIAction.on('dragstart', 'trackDragStart', UIAction.event, t.id)} ${UIAction.on('dragend', 'dragEnd')} title="Drag to reorder or use arrow keys">${I.grip}</button>
          <button type="button" class="kebab icon-button" aria-label="Manage ${esc(t.name)} track" ${UIAction('trackMenu', UIAction.event, t.id)}>${I.kebab}</button>
        </div>` : ''}
      </div>
      <div class="lane-body">${bars}</div>
    </div>`;
  });

  // milestones + today (labels live in the sticky axis; lines span the canvas)
  const timeline = timelineWidth(model, ppd, metrics.width);
  let msHtml = '', msLabels = '';
  model.goals.forEach((goal, i) => {
    const { m, past, name, dateLabel, width, at } = goal, row = layout.goalRows[i];
    msHtml += `<div class="ms-line${past ? ' past' : ''}" aria-hidden="true" style="left:${RAIL + dayX(at, ppd)}px;top:${axisHeight}px;bottom:${MONTH_ROW}px"></div>`;
    msLabels += `<div class="ms-line goal-connector${past ? ' past' : ''}" aria-hidden="true" style="left:${dayX(at, ppd)}px;top:${12 + row * GOAL_ROW + 54}px;bottom:-1px"></div>`;
    msLabels += `<button type="button" class="ms-label${past ? ' past' : ''}" data-milestone="${UIEscape(m.id)}" style="left:${goalCenter(goal, ppd, timeline)};top:${12 + row * GOAL_ROW}px;width:${width}px" ${UIAction('milestoneClick', UIAction.event, m.id)} ${UIAction.on('mouseenter', 'milestoneHover', UIAction.event, m.id)} ${UIAction.on('mouseleave', 'epicLeave')} ${UIAction.on('focus', 'milestoneHover', UIAction.event, m.id, true)} ${UIAction.on('blur', 'epicLeave')} ${UIAction.on('keydown', 'roadmapTipKey', UIAction.event)}>
      ${I.diamond}<span class="txt"><span class="goal-name">${esc(name)}</span><span class="goal-date">${dateLabel}</span></span></button>`;
  });
  const todayX = dayX(model.today, ppd);
  const todayHtml = `<div class="today-line" style="left:${RAIL + todayX}px;top:${axisHeight}px;bottom:${MONTH_ROW}px"></div>`;
  const todayPill = `<div class="today-line today-connector" aria-hidden="true" style="left:${todayX}px;top:32px;bottom:-1px"></div><div class="today-pill" style="left:${todayX}px;top:12px">${human(today)}</div>`;

  // Month cells are day offsets that their container's --ppd scales.
  const calendar = `--ppd:${ppd}`, calendarLines = `${calendar};--rm-rail:${RAIL}px;--rm-axis-h:${axisHeight}px;--rm-month-h:${MONTH_ROW}px`;
  const emptyProject = model.lanes.length === 0;
  return `<div class="rm-scroll" id="rmScroll" data-bar-height="${UIEscape(barHeight)}" data-range-start="${UIEscape(+model.start)}">
    <div class="rm-canvas" style="width:${RAIL + dayX(model.span, ppd)}px">
      <div class="rm-axis" style="height:${axisHeight}px">
        <div class="rail-cell rm-track-head" style="width:${RAIL}px">${canRoadmap() ? `<button class="btn quiet" type="button" ${UIAction('openModal', 'track')}>${I.plus}<span>Track</span></button>` : '<span class="rm-track-title">Tracks</span>'}</div>
        <div class="rm-axis-labels"><span class="rm-calendar-axis" style="${calendar}"></span>${msLabels}${todayPill}</div>
      </div>
      <span class="rm-calendar-lines" style="${calendarLines}"></span>${msHtml}${todayHtml}${lanes}
      ${emptyProject ? `<div style="position:sticky;left:0;width:100%;padding:60px 0;text-align:center;color:var(--ink-ghost);font-size:var(--text-body)">No tracks yet.</div>` : ''}
      <div class="rm-month-row" style="height:${MONTH_ROW}px"><div class="rail-cell" style="width:${RAIL}px"></div><div class="rm-month-grid" style="${calendar}"></div></div>
    </div>
  </div>`;
}

/** The cards a Board column shows, in order. */
const shownColumn = (col) => boardTasks().filter((item) => item.state === col).slice(0, state.boardLimits[col] || 50);
/** Whether a column shows its last card: the server has no more, and every loaded card is drawn. */
function columnEndShown(col, except) {
  const page = D.boardPageInfo?.projectId === state.projectId ? D.boardPageInfo.pages?.[col] : null;
  return !page?.nextCursor && boardTasks().filter((item) => item.state === col && item !== except).length <= (state.boardLimits[col] || 50);
}
// Without a target card, a card follows the last card its column shows, or
// goes to the top with `atTop`.
function taskMovePlan(t, col, beforeId = null, atTop = false) {
  const originalColumn = tasks().filter((item) => item.state === col);
  const destination = originalColumn.filter((item) => item !== t);
  const last = beforeId || atTop ? null : shownColumn(col).filter((item) => item !== t).at(-1) ?? destination.at(-1);
  const index = beforeId ? destination.findIndex((item) => item.id === beforeId) : last ? destination.indexOf(last) + 1 : 0;
  if (beforeId && index < 0) return null;
  const nextColumn = [...destination]; nextColumn.splice(index, 0, t);
  if (t.state === col && originalColumn.length === nextColumn.length && originalColumn.every((item, at) => item === nextColumn[at])) return null;
  const placement = beforeId
    ? { beforeTaskId: taskById(beforeId)?.internalId || beforeId }
    : last
      ? { afterTaskId: last.internalId || last.id }
      : { position: 0 };
  return { destination, index, placement };
}

function applyTaskMove(t, col, beforeId = null, atTop = false) {
  // A newest-first Done shows a finished task on top and has no manual order to change.
  const newest = col === 'done' && doneNewest();
  if (newest) { if (t.state === 'done') return null; beforeId = null; atTop = true; }
  const plan = taskMovePlan(t, col, beforeId, atTop); if (!plan) return null;
  const shownBefore = shownColumn(col).filter((item) => item !== t);
  const previousState = t.state, projectId=t.projectId||trackById(epicById(t.epicId)?.trackId)?.projectId||state.projectId, sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`;
  const taskProject=(item)=>item.projectId||trackById(epicById(item.epicId)?.trackId)?.projectId;
  const previousProjectTasks=D.tasks.filter((item)=>taskProject(item)===projectId),taskIndex=previousProjectTasks.indexOf(t);
  const previousTaskBefore=taskIndex>0?previousProjectTasks[taskIndex-1]:null,previousTaskAfter=previousProjectTasks[taskIndex+1]||null;
  const previousOrders = new Map(tasks().map((item)=>[item,item.order]));
  const pageInfoReference=D.boardPageInfo;
  const previousPageInfo = D.boardPageInfo ? JSON.parse(JSON.stringify(D.boardPageInfo)) : null;
  const countsReference=D.projectTaskCounts?.[projectId]||null;
  const previousCounts = countsReference ? { ...countsReference } : null;
  const affectedEpics = new Map();
  for (const id of new Set([t.epicId])) { const item = epicById(id); if (item) affectedEpics.set(id, { item, state:item.state, done:item.done }); }
  D.tasks.splice(D.tasks.indexOf(t), 1);
  const next = plan.destination[plan.index], previous = plan.destination[plan.index - 1];
  const at = next ? D.tasks.indexOf(next) : previous ? D.tasks.indexOf(previous) + 1 : D.tasks.length;
  D.tasks.splice(Math.max(0, at), 0, t);
  t.state = col;
  if (newest) t.completedAt = Date.now();
  for (const status of new Set([previousState,col])) tasks().filter((item)=>item.state===status).forEach((item,index)=>{item.order=index;});
  // The column keeps showing every card it showed, and shows the moved card too.
  const column = boardTasks().filter((item) => item.state === col);
  state.boardLimits[col] = Math.max(state.boardLimits[col] || 50, ...[t, ...shownBefore].map((item) => column.indexOf(item) + 1));
  const epic = epicById(t.epicId);
  if (epic) {
    if (col === 'done') epic.done += 1;
    if (previousState === 'done') epic.done = Math.max(epic.done - 1, 0);
    if (col !== 'planning' && epic.state === 'planning') epic.state = 'active';
  }
  const pages=D.boardPageInfo?.projectId===projectId?D.boardPageInfo?.pages:null;
  if(previousState!==col&&pages){if(pages[previousState])pages[previousState].total=Math.max(0,pages[previousState].total-1);if(pages[col])pages[col].total+=1;}
  const counts=D.projectTaskCounts?.[projectId];
  if(previousState!==col&&counts){counts[previousState]=Math.max(0,(counts[previousState]||0)-1);counts[col]=(counts[col]||0)+1;counts.open=counts.planning+counts.progress+counts.review;}
  const optimisticOrders=new Map([...previousOrders.keys()].map((item)=>[item,item.order]));
  const optimisticEpics=new Map([...affectedEpics].map(([id])=>{const item=epicById(id);return[id,{item,state:item?.state,done:item?.done}];}));
  return {
    task:t, revision:t.revision, projectId, sessionKey, previousState, optimisticState:col,
    previousTaskBefore,previousTaskAfter,previousOrders,optimisticOrders,
    pageInfoReference,previousPageInfo,optimisticPageInfo:D.boardPageInfo?JSON.parse(JSON.stringify(D.boardPageInfo)):null,
    countsReference,previousCounts,optimisticCounts:countsReference?{...countsReference}:null,affectedEpics,optimisticEpics,
    payload:{ taskId:t.internalId||t.id, status:col, ...(newest ? {} : plan.placement), optimistic:true },
  };
}

function rollbackTaskMove(change) {
  const sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`;
  if (!change || sessionKey!==change.sessionKey || !D.tasks.includes(change.task) || change.task.revision !== change.revision || change.task.state!==change.optimisticState) return false;
  const currentIndex=D.tasks.indexOf(change.task);D.tasks.splice(currentIndex,1);
  if(change.previousTaskAfter&&D.tasks.includes(change.previousTaskAfter))D.tasks.splice(D.tasks.indexOf(change.previousTaskAfter),0,change.task);
  else if(change.previousTaskBefore&&D.tasks.includes(change.previousTaskBefore))D.tasks.splice(D.tasks.indexOf(change.previousTaskBefore)+1,0,change.task);
  else D.tasks.splice(Math.min(currentIndex,D.tasks.length),0,change.task);
  change.task.state=change.previousState;
  for(const [item,order] of change.previousOrders)if(D.tasks.includes(item)&&item.order===change.optimisticOrders.get(item))item.order=order;
  if(change.previousPageInfo&&D.boardPageInfo===change.pageInfoReference&&JSON.stringify(D.boardPageInfo)===JSON.stringify(change.optimisticPageInfo))D.boardPageInfo=change.previousPageInfo;
  if(change.previousCounts&&D.projectTaskCounts?.[change.projectId]===change.countsReference&&JSON.stringify(change.countsReference)===JSON.stringify(change.optimisticCounts))D.projectTaskCounts[change.projectId]=change.previousCounts;
  for(const [id,value] of change.affectedEpics){const item=epicById(id),optimistic=change.optimisticEpics.get(id);if(item===value.item&&item===optimistic?.item&&item.state===optimistic.state&&item.done===optimistic.done)Object.assign(item,{state:value.state,done:value.done});}
  return true;
}

function submitTaskMove(change,onRollback=()=>App.refresh()) {
  if (!change) return;
  const pending={};App._boardMovePending=pending;
  window.OneloopRuntime.invoke('task.move',change.payload).catch((error)=>{
    if(!error?.uncertain&&rollbackTaskMove(change)&&state.view==='board'&&state.projectId===change.projectId)onRollback();
    window.OneloopRuntime.report(error);
  }).finally(()=>{if(App._boardMovePending===pending)App._boardMovePending=false;});
}

function setTaskState(t, col) {
  if (!canBoard()) return;
  if (App._boardMovePending) return false;
  if (t.state === col) return;
  if (t.block && col === 'done') { App.openModal('completeBlocked', t.id); return false; }
  // A column that does not show its end takes the card at the top, where it stays in view.
  const change=applyTaskMove(t,col,null,!columnEndShown(col,t));if(!change)return false;submitTaskMove(change);
}

// Scroll a lane's head into the Roadmap's view, below its sticky date axis.
function revealLane(lane) {
  const scroll = document.getElementById('rmScroll'), head = lane?.querySelector('.lane-head');
  if (!scroll || !head) return;
  const view = scroll.getBoundingClientRect(), top = view.top + (scroll.querySelector('.rm-axis')?.offsetHeight || 0), box = head.getBoundingClientRect();
  if (box.top < top) scroll.scrollTop -= top - box.top;
  else if (box.bottom > view.bottom) scroll.scrollTop += Math.min(box.bottom - view.bottom, box.top - top);
}
function focusMovedTrack(id) {
  const lane = [...document.querySelectorAll('.lane[data-track]')].find(el=>el.dataset.track===id);
  revealLane(lane);
  lane?.querySelector('.grip')?.focus({preventScroll:true});
  announce(`${trackById(id)?.name || 'Track'} moved to position ${tracks().findIndex(track=>track.id===id)+1}`);
}
function focusMovedTask(id) {
  if (state.view !== 'board' || state.modal) return;
  const card = [...document.querySelectorAll('.card[data-task]')].find(el=>el.dataset.task===id);
  card?.scrollIntoView?.({block:'nearest',inline:'nearest'});
  (card?.querySelector('.card-move') || card?.querySelector('.card-title-button') || document.getElementById('main'))?.focus({preventScroll:true});
  announce(`${id} moved to ${STATUS[taskById(id)?.state] || 'new position'}`);
}

// ---------- board ----------
const COLS = [
  { key: 'planning', name: 'Planning' },
  { key: 'progress', name: 'In Progress' },
  { key: 'review', name: 'In Review' },
  { key: 'done', name: 'Done' },
];
/** Whether the loaded Done column lists the most recently completed task first. */
const doneNewest = () => D.boardPageInfo?.projectId === state.projectId && D.boardPageInfo?.filters?.doneOrder === 'completed';

function taskBits(t) {
  if (t.state === 'done') return { right: stIcon('done'), cls: 'done' };
  if (t.state === 'review') return { right: '', cls: 'review' };
  return { right: '', cls: '' };
}

function boardTasks() {
  let ts = tasks();
  if (state.boardTracks.length) { const eids = new Set(epics().filter((e) => state.boardTracks.includes(e.trackId)).map((e) => e.id)); ts = ts.filter((t) => eids.has(t.epicId)); }
  if (state.boardEpics.length) ts = ts.filter((t) => state.boardEpics.includes(t.epicId));
  if (state.boardAssignees.length) ts = ts.filter((t) => {
    const assignees = t.assignees || [];
    return (!assignees.length && state.boardAssignees.includes(NO_ASSIGNEE)) || assignees.some((a) => state.boardAssignees.includes(a));
  });
  if (state.boardBlocked) ts = ts.filter(t=>!!t.block && t.state!=='done');
  if (state.boardQ) { const q = state.boardQ.toLowerCase(); ts = ts.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)); }
  return ts;
}

/** @param {{column?:string|null,excludeIds?:Set<string>|null}} [options] */
function renderBoard({column=null,excludeIds=null}={}) {
  const ts = boardTasks();
  const filtered = state.boardBlocked || state.boardQ || state.boardTracks.length || state.boardEpics.length || state.boardAssignees.length;
  if (!ts.length) return `<div class="board board-empty"><div class="page-empty"><h2>${filtered ? 'No matching tasks' : 'No tasks yet'}</h2>${filtered ? `<button class="btn quiet" ${UIAction('clearBoardFilters')}>Clear filters</button>` : canBoard() ? `<button class="btn primary" ${UIAction('openModal', 'task')}>${I.plus} Create task</button>` : ''}</div></div>`;
  const cols = COLS.filter(c=>!column||c.key===column).map((c) => {
    const list = ts.filter((t) => t.state === c.key);
    const serverPage = D.boardPageInfo?.projectId === state.projectId ? D.boardPageInfo.pages?.[c.key] : null;
    const cards = list.slice(0,state.boardLimits[c.key] || 50).filter(t=>!excludeIds?.has(t.id)).map((t) => {
      const e = epicById(t.epicId);
      const b = taskBits(t);
      const av = (t.assignees || []).filter(userById);
      const avs = av.slice(0, 3).map((a) => avatarHtml(a, 18)).join('') + (av.length > 3 ? `<span class="avatar" style="width:18px;height:18px;font-size:var(--text-xs)">+${av.length - 3}</span>` : '');
      return `<div role="listitem" class="card ${b.cls}${t.block ? ' blocked' : ''}" data-task="${UIEscape(t.id)}" ${canBoard() ? `data-reorderable="true" ${UIAction.on('dragstart', 'taskDragStart', UIAction.event, t.id)} ${UIAction.on('dragend', 'dragEnd')}` : ''} ${UIAction('openTask', t.id)}>
        <div class="id-row"><span>${esc(t.id)}</span><span class="card-end">${t.block ? `<span class="blocked-badge" data-tip-tap data-tip="${esc(t.block.reason)} — ${esc(userById(t.block.by)?.name || t.block.by)} · ${esc(formatInstant(t.block.at))}">${I.blocked}Blocked</span>` : ''}${b.right}${canBoard() ? `<button type="button" class="card-move" aria-label="Move ${esc(t.id)}" ${UIAction('taskMoveMenu', UIAction.event, t.id)}>${I.kebab}</button>` : ''}</span></div>
        <button type="button" class="title card-title-button" aria-describedby="card-context-${esc(t.id)}"${t.block ? ` data-tip="${esc(t.block.reason)} — ${esc(userById(t.block.by)?.name || t.block.by)} · ${esc(formatInstant(t.block.at))}" data-tip-keyboard` : ''}>${esc(t.title)}</button>
        <span class="sr-only" id="card-context-${esc(t.id)}">${esc([t.id,c.name,e?.title,t.deadline ? 'Due '+t.deadline : '',overdue(t) ? 'Overdue' : '',t.block ? 'Blocked: '+t.block.reason+' — '+(userById(t.block.by)?.name||t.block.by)+' · '+formatInstant(t.block.at) : '',av.length ? 'Assigned to '+av.map(id=>userById(id).name).join(', ') : 'Unassigned'].filter(Boolean).join(' · '))}</span>
        <div class="epic" data-tip="${esc(e ? e.title : '')}" data-tip-overflow>${esc(e ? e.title : '')}</div>
        <div class="card-foot">
          <span class="mono card-created"${t.created ? ` data-tip="Created ${esc(formatInstant(t.created))}"` : ''}>${t.created ? humanInstant(t.created) : ''}</span>
          ${t.deadline ? `<span class="mono dl${overdue(t) ? ' late' : ''}" data-tip="Deadline ${esc(t.deadline)}">${I.clock}${humanShort(d(t.deadline))}${overdue(t) ? ' · Overdue' : ''}</span>` : ''}
          <span class="avs">${avs}</span>
        </div></div>`;
    }).join('');
    return `<section class="col" aria-labelledby="col-${c.key}" data-col="${UIEscape(c.key)}" ${canBoard() ? `${UIAction.on('dragover', 'colOver', UIAction.event)} ${UIAction.on('dragleave', 'colLeave', UIAction.event)} ${UIAction.on('drop', 'dropTask', UIAction.event, c.key)}` : ''}>
      <div class="col-head"><div class="row1">${stIcon(c.key)}<h2 id="col-${UIEscape(c.key)}">${c.name}</h2><span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${serverPage?.total ?? list.length}</span>${c.key === 'done' ? `<button type="button" class="btn quiet done-order" aria-pressed="${doneNewest()}" ${UIAction('toggleDoneOrder')}>Newest first</button>` : ''}</div>
      </div>
      <div class="col-cards" role="list" aria-labelledby="col-${c.key}">${cards || '<div class="empty-note" role="listitem">No tasks</div>'}${serverPage?.nextCursor ? `<div role="listitem" class="board-load-more"><button class="btn quiet" ${UIAction('loadMoreBoard', c.key)}>Load more</button></div>` : ''}</div></section>`;
  }).join('');
  return `<div class="board">${cols}</div>`;
}

const filterAnimations = new Set();
const filterExitLayers = new Set();
const filterScroll = new WeakMap();
const boardSnapshots = new WeakMap();
let boardSearchTimer;
function cancelBoardSearch() { clearTimeout(boardSearchTimer); boardSearchTimer = null; }
function boardSnapshot() {
  // Display dependencies, not just task revisions: access, parent names,
  // avatars and date boundaries can change independently of a task.
  return JSON.stringify([
    state.projectId, canBoard(), instanceTimeZone(), instanceDateKey(instanceNow()),
    !!(state.boardQ || state.boardBlocked || state.boardTracks.length || state.boardEpics.length || state.boardAssignees.length),
    state.boardLimits, D.boardPageInfo,
    boardTasks().map(t=>[t.id,t.state,t.title,t.epicId,t.created,t.deadline,t.assignees,t.block]),
    D.epics.map(e=>[e.id,e.title]), D.users.map(u=>[u.id,u.name,u.avatar]),
  ]);
}
function clearFilterMotion() {
  filterAnimations.forEach((animation) => animation.cancel());
  filterAnimations.clear();
  filterExitLayers.forEach((layer) => layer.remove());
  filterExitLayers.clear();
}
function filterAnimate(element, frames, cleanup) {
  const animation = element.animate(frames, { duration: MOTION.normal, easing: MOTION.ease });
  filterAnimations.add(animation);
  const finish = () => { filterAnimations.delete(animation); cleanup?.(); };
  animation.finished.then(finish, finish);
}
function boardRowKey(row, column) {
  if (row.dataset.task) return `task:${row.dataset.task}`;
  return `${column}:${row.classList.contains('empty-note') ? 'empty' : 'more'}`;
}
// Board rows have stable actions for their key. Preserve their DOM/listeners,
// focus and images while updating changed presentation. Permission changes
// replace a card so its drag handlers are installed/removed together.
function patchBoardRow(current, next) {
  for (const attribute of [...current.attributes])
    if (!attribute.name.startsWith('on') && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of next.attributes)
    if (!attribute.name.startsWith('on') && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  const children = [...next.childNodes];
  children.forEach((child, index) => {
    const old = current.childNodes[index];
    if (!old) { current.append(child); return; }
    if (old.nodeType !== child.nodeType || old.nodeName !== child.nodeName) { old.replaceWith(child); return; }
    if (child.nodeType === Node.ELEMENT_NODE) patchBoardRow(old, child);
    else if (old.nodeValue !== child.nodeValue) old.nodeValue = child.nodeValue;
  });
  while (current.childNodes.length > children.length) current.lastChild.remove();
  return current;
}
function applyBoardFilters(reset = true, fromServer = false, { animate: motion = true } = {}) {
  if (!fromServer) cancelBoardSearch();
  App.updateDocumentTitle();
  if(reset) state.boardLimits = {planning:50,progress:50,review:50,done:50};
  if(!fromServer){invoke('board.filter',App.context().board);return;}
  const board = document.querySelector('.board');
  if (!board || state.view !== 'board') return;
  const snapshot = boardSnapshot();
  if (boardSnapshots.get(board) === snapshot) return;
  today.setTime(instanceToday().getTime());
  // Snapshot painted positions before cancelling an interrupted transition.
  const previous = new Map([...board.querySelectorAll('.col-cards > *')].map((card) =>
    [boardRowKey(card,card.closest('.col').dataset.col), { card, rect: card.getBoundingClientRect(), opacity: getComputedStyle(card).opacity }]));
  clearFilterMotion();
  const animate = motion && !reducedMotion.matches && typeof board.animate === 'function' && !App._drag;
  const template = document.createElement('template');
  setHTML(template,renderBoard());
  if (!board.querySelector('.col') || !template.content.querySelector('.col')) {
    const next=template.content.firstElementChild;
    if (board.classList.contains('board-empty') && next.classList.contains('board-empty')
      && board.textContent===next.textContent && board.querySelector('button')?.className===next.querySelector('button')?.className) {boardSnapshots.set(board,snapshot);return;}
    board.replaceWith(next); boardSnapshots.set(next,snapshot); fadeContent(next); return;
  }
  [...board.querySelectorAll('.col')].forEach((column) => {
    const list = column.querySelector('.col-cards');
    const next = template.content.querySelector(`[data-col="${UIEscape(column.dataset.col)}"]`);
    const desired = [...next.querySelector('.col-cards').children];
    const ids = new Set(desired.map((card) => card.dataset.task).filter(Boolean));
    const viewport = list.getBoundingClientRect();
    const oldCards = [...list.querySelectorAll('.card')];
    const memory = filterScroll.get(list);
    const scrollTop = memory && list.scrollTop === memory.applied ? memory.wanted : list.scrollTop;
    let exitLayer;
    if (animate) oldCards.forEach((card) => {
      const old = previous.get(boardRowKey(card,column.dataset.col));
      if (ids.has(card.dataset.task) || old.rect.bottom <= viewport.top || old.rect.top >= viewport.bottom) return;
      if (!exitLayer) {
        exitLayer = document.createElement('div');
        exitLayer.className = 'board-filter-exits';
        exitLayer.style.cssText = `left:${list.offsetLeft}px;top:${list.offsetTop}px;width:${list.clientWidth}px;height:${list.clientHeight}px`;
        exitLayer.setAttribute('aria-hidden', 'true'); exitLayer.inert = true;
        column.append(exitLayer); filterExitLayers.add(exitLayer);
      }
      const ghost = card.cloneNode(true);
      ghost.removeAttribute('data-task'); ghost.removeAttribute('data-reorderable');
      for (const name of ghost.getAttributeNames()) if (/^data-(?:action|args)\b/.test(name)) ghost.removeAttribute(name);
      ghost.style.cssText = `position:absolute;margin:0;left:${old.rect.left - viewport.left}px;top:${old.rect.top - viewport.top}px;width:${old.rect.width}px;height:${old.rect.height}px`;
      exitLayer.append(ghost);
      const layer = exitLayer;
      filterAnimate(ghost, [{ opacity: old.opacity }, { opacity: 0 }], () => {
        ghost.remove();
        if (!layer.children.length) { layer.remove(); filterExitLayers.delete(layer); }
      });
    });
    // Keep unchanged children connected; replaceChildren would detach focused
    // controls and restart empty-state/Load more entrance animations.
    let cursor=list.firstElementChild;
    for (const row of desired) {
      const old=previous.get(boardRowKey(row,column.dataset.col))?.card;
      const child=old && old.hasAttribute('data-reorderable')===row.hasAttribute('data-reorderable') ? patchBoardRow(old,row) : row;
      if (child===cursor) cursor=cursor.nextElementSibling;
      else list.insertBefore(child,cursor);
    }
    while(cursor){const next=cursor.nextElementSibling;cursor.remove();cursor=next;}
    const count=column.querySelector('.col-head .row1 .mono'),nextCount=next.querySelector('.col-head .row1 .mono').textContent;
    if(count.textContent!==nextCount)count.textContent=nextCount;
    const order=column.querySelector('.col-head .done-order'),pressed=next.querySelector('.col-head .done-order')?.getAttribute('aria-pressed');
    if(order&&pressed&&order.getAttribute('aria-pressed')!==pressed)order.setAttribute('aria-pressed',pressed);
    list.scrollTop = scrollTop;
    filterScroll.set(list, { wanted: scrollTop, applied: list.scrollTop });
    if (!animate) return;
    [...list.children].forEach((card) => {
      const to = card.getBoundingClientRect(), old = previous.get(boardRowKey(card,column.dataset.col));
      const visible = to.bottom > viewport.top && to.top < viewport.bottom;
      const wasVisible = old && old.rect.bottom > viewport.top && old.rect.top < viewport.bottom;
      if (!visible && !wasVisible) return;
      if (!old) {
        filterAnimate(card, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }]);
      } else {
        const dx = old.rect.left - to.left, dy = old.rect.top - to.top;
        if (Math.abs(dx) + Math.abs(dy) > .5 || Number(old.opacity) < 1)
          filterAnimate(card, [{ opacity: old.opacity, transform: `translate(${dx}px,${dy}px)` }, { opacity: 1, transform: 'none' }]);
      }
    });
  });
  boardSnapshots.set(board,snapshot);
}

// ---------- auth ----------
function renderAuth(mode) {
  // Someone typing when their session ended keeps typing into nothing, not into Username.
  const keptInput = !!window.Recovery?.keepsInput;
  const inner = mode === 'change'
    ? `<h1 tabindex="-1">Set a new password</h1>
      <form novalidate ${UIAction.on('submit', 'setPassword', UIAction.event)}>
        ${field('Current temporary password', `<input class="ctl" type="password" name="cur" autocomplete="current-password" autofocus>`)}
        ${field('New password', `<input class="ctl" type="password" name="pw" autocomplete="new-password">`)}
        ${field('Confirm', `<input class="ctl" type="password" name="pw2">`)}
        <div class="modal-actions"><button class="btn danger" type="button" ${UIAction('logout')}>Sign out</button><button class="btn primary" type="submit">Save password</button></div>
      </form>`
    : `<h1 tabindex="-1">Sign in</h1>
      <form novalidate ${UIAction.on('submit', 'login', UIAction.event)}>
        ${field('Username', `<input class="ctl mono" name="username" maxlength="32" autocomplete="username"${keptInput ? '' : ' autofocus'}>`)}
        ${field('Password', `<input class="ctl" type="password" name="password" autocomplete="current-password">`)}
        <div class="modal-actions"><button class="btn primary" type="submit" style="width:100%;justify-content:center">Sign in</button></div>
      </form>`;
  return `<main class="auth-wrap" id="main" tabindex="-1"><div class="auth-card">
    <div class="logo" role="img" aria-label="oneloop">${I.logo}<span>${I.wordmark}</span></div>${window.Recovery?.expired?`<p class="auth-notice" role="alert">${keptInput?'Your session ended. Sign in again to keep what you typed.':'Your session ended. Sign in to continue.'}</p>`:''}${inner}</div></main>`;
}

// ---------- shared descriptions ----------
const expandedDescriptions = new Set();
let descriptionObserver,descriptionResizeFrame=0;
function sizeDescription(animated = false) {
  document.querySelectorAll('.expandable-description').forEach(section=>{
    const input=section.querySelector('.description-content, textarea'),toggle=section.querySelector('.description-toggle');
    const before=input.getBoundingClientRect().height,scrollTop=input.scrollTop;
    uiAnimations.get(input)?.cancel();
    const expanded=expandedDescriptions.has(section.dataset.descriptionKey);
    input.style.overflowY='hidden';input.style.height='0px';
    const fullHeight=Math.max(input.tagName==='TEXTAREA'?96:0,input.scrollHeight+(input.tagName==='TEXTAREA'?2:0));
    const expandedLimit=Math.max(240,Math.round(innerHeight*.8));
    input.style.height=Math.min(fullHeight,expanded?expandedLimit:240)+'px';
    input.style.overflowY=expanded?'auto':'hidden';input.scrollTop=expanded?scrollTop:0;
    toggle.hidden=fullHeight<=240;section.classList.toggle('is-collapsed',fullHeight>240&&!expanded);
    toggle.textContent=expanded?'Show less':'Show more';toggle.setAttribute('aria-expanded',String(expanded));
    if(input.tagName!=='TEXTAREA'){if(fullHeight>240&&(!expanded||fullHeight>expandedLimit))input.setAttribute('tabindex','0');else input.removeAttribute('tabindex');}
    if(animated)animateHeight(input,before);
  });
}
function sizeDescriptionEditors() {
  document.querySelectorAll('[data-description-editor]').forEach(input=>{
    const scrollTop=input.scrollTop;input.style.overflowY='hidden';input.style.height='0px';
    input.style.height=Math.min(Math.max(96,input.scrollHeight+2),Math.max(96,Math.min(320,Math.round(innerHeight*.4))))+'px';
    input.style.overflowY='auto';input.scrollTop=scrollTop;
  });
}
function descriptionEditorHtml(value,limit,placeholder) {
  return `<textarea class="ctl description-editor" name="desc" data-description-editor maxlength="${limit}" ${placeholder?`placeholder="${esc(placeholder)}"`:''} ${UIAction.on('input', 'sizeDescriptionEditors')}>${esc(value||'')}</textarea>`;
}
function descriptionReadHtml(value,key) {
  return `<section class="peek-description expandable-description" data-description-key="${esc(key)}"><h3>Description</h3><div class="description-preview"><div class="description-content" id="${esc(key)}" role="group" aria-label="Epic description">${esc(value)}</div></div><button type="button" class="description-toggle" aria-controls="${esc(key)}" aria-expanded="false" ${UIAction('toggleDescription', UIAction.element)} hidden>Show more</button></section>`;
}
function sizeTaskTitle() {
  const input = document.querySelector('.tp-title');
  if (!input) return;
  input.style.height = '0px';
  input.style.height = (input.scrollHeight + 1) + 'px';
}
function mountDescription() {
  cancelAnimationFrame(descriptionResizeFrame);descriptionResizeFrame=0;
  sizeTaskTitle();descriptionObserver?.disconnect();sizeDescription();sizeDescriptionEditors();
  if(typeof ResizeObserver!=='undefined'){
    const widths=new WeakMap();
    descriptionObserver=new ResizeObserver(entries=>{
      let changed=false;for(const {target} of entries){if(widths.get(target)!==target.clientWidth){widths.set(target,target.clientWidth);changed=true;}}
      if(changed){cancelAnimationFrame(descriptionResizeFrame);descriptionResizeFrame=requestAnimationFrame(()=>{descriptionResizeFrame=0;sizeDescription();sizeDescriptionEditors();sizeTaskTitle();});}
    });
    document.querySelectorAll('.expandable-description,[data-description-editor]').forEach(el=>{widths.set(el,el.clientWidth);descriptionObserver.observe(el);});
  }
}

const currentBrowserSession = () => D.session ? (D.browserSessions || []).find(item => item.id === D.session.id && item.userId === D.session.userId && item.revokedAt == null) : null;
function renderProfileAccess() {
  const current = currentBrowserSession(), userId = me().id;
  const sessions = (D.browserSessions || []).filter(item => item.userId === userId && (window.Recovery ? Recovery.sessionActive(item) : item.revokedAt == null)).sort((a,b) => Number(b.id === current?.id) - Number(a.id === current?.id) || b.lastActiveAt - a.lastActiveAt);
  const grants = (D.appGrants || []).filter(item => item.userId === userId && item.revokedAt == null && (!item.expiresAt || item.expiresAt > Date.now())).sort((a,b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const fact = (label,value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  const date = value => value ? formatInstant(value) : 'Unavailable';
  const permissions = { read:'Read', manage_roadmap:'Manage Roadmap', manage_board:'Manage Board' };
  const sessionRows = sessions.map(item => `<div class="access-session-row" data-session-id="${esc(item.id)}">
    <div class="access-session-main"><div class="access-session-title">${esc(item.device || 'Unknown device')}${item.id === current?.id ? '<span class="current-session">Current</span>' : ''}</div>
    ${item.browser ? `<div class="access-session-sub">${esc(item.browser)}</div>` : ''}
    <dl class="access-session-facts">${fact('IP address',item.ip || 'Unavailable')}${fact('Last active',item.id === current?.id ? 'Now' : item.lastActiveAt ? date(item.lastActiveAt) : 'Never')}</dl></div>
    ${item.id !== current?.id ? `<button class="btn quiet danger" type="button" aria-label="Revoke ${esc(item.device)} session" ${UIAction('revokeSession', item.id)}>Revoke</button>` : ''}</div>`).join('');
  const appRows = grants.map(item => `<div class="access-session-row" data-grant-id="${esc(item.id)}"><div class="access-session-main">
    <div class="access-session-title">${esc(item.clientName)}<span class="access-client-type">${esc(item.protocol)}</span></div>
    <div class="app-access-scopes">${(item.access || []).map(grant => `<div><span class="access-project">${esc(visibleProjects().find(p=>p.id===grant.projectId)?.name || 'Unavailable project')}</span><span>${esc(grant.permissions.map(permission=>permissions[permission] || permission).join(' · '))}</span></div>`).join('')}</div>
    <dl class="access-session-facts">${fact('Last used',item.lastUsedAt ? date(item.lastUsedAt) : 'Never')}${fact('Connected',date(item.authorizedAt))}${fact('Expires',item.expiresAt ? date(item.expiresAt) : 'No expiry')}</dl>
    </div><button type="button" class="btn quiet danger" aria-label="Revoke ${esc(item.clientName)} access" ${UIAction('revokeAppAccess', item.id)}>Revoke</button></div>`).join('');
  return `<section class="section"><div class="access-section-heading"><h2 tabindex="-1">Sessions</h2><button type="button" class="btn quiet danger" ${UIAction('revokeOtherSessions')} ${sessions.some(item=>item.id!==current?.id) ? '' : 'disabled'}>Sign out other sessions</button></div><div class="access-session-list">${sessionRows || '<div class="access-empty">No active sessions</div>'}</div></section>
    <section class="section"><h2 tabindex="-1">Connected apps</h2><div class="access-session-list">${appRows || '<div class="access-empty">No connected apps</div>'}</div></section>`;
}
function refreshProfileAccess(status = {}) {
  const host = document.querySelector('.profile-access');
  if (!host) return;
  const hadFocus = host.contains(document.activeElement);
  const before=host.getBoundingClientRect().height;
  setHTML(host,renderProfileAccess() + (status.loading ? '<p class="access-note" role="status">Loading access…</p>' : status.error ? `<p class="access-note" role="alert">${esc(status.error)} <button type="button" class="btn quiet" ${UIAction('retryProfileAccess')}>Retry</button></p>` : ''));
  fadeContent(host);UIMotion.height(host,before);
  if (hadFocus) (host.querySelector('button:not(:disabled)') || host.querySelector('h2'))?.focus({preventScroll:true});
}

function renderProfile() {
  const u = me();
  return `<div class="settings">
    <div class="section">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
        ${avatarHtml(u.id, 56)}
        <div style="display:flex;gap:8px">
          <input type="file" id="avIn" accept="image/*" style="display:none" ${UIAction.on('change', 'setAvatar', UIAction.element)}>
          <button class="btn" ${UIAction('chooseAvatar')}>${u.avatar ? 'Change avatar' : 'Upload avatar'}</button>
          ${u.avatar ? `<button class="btn" ${UIAction('removeAvatar')}>Remove</button>` : ''}
        </div>
      </div>
      ${field('Username', `<input class="ctl mono" value="${esc(userHandle(u))}" disabled>`)}
      ${field('Full name', `<input class="ctl" name="name" value="${esc(u.name)}" maxlength="80" data-autosave ${UIAction.on('blur', 'updMe', UIAction.value)} data-key="Enter" ${UIAction.on('keydown', 'leaveField', UIAction.event, UIAction.element)}>`)}
    </div>
    <div class="section">
      <h2>Password</h2>
      <form novalidate ${UIAction.on('submit', 'changePassword', UIAction.event)}>
        ${field('Current password', `<input class="ctl" type="password" name="cur" autocomplete="current-password">`)}
        <div class="field-row">
          ${field('New password', `<input class="ctl" type="password" name="pw" autocomplete="new-password">`)}
          ${field('Confirm', `<input class="ctl" type="password" name="pw2" autocomplete="new-password">`)}
        </div>
        <div class="modal-actions" style="justify-content:flex-start;margin-top:4px"><button class="btn primary" type="submit">Change password</button></div>
      </form>
    </div>
    <div class="profile-access">${renderProfileAccess()}</div>
  </div>`;
}

let taskSaveFeedback = null, taskSaveTimer;
function clearTaskSaved() {
  clearTimeout(taskSaveTimer);taskSaveFeedback=null;
  const status=document.querySelector('.task-save-status');if(status)status.textContent='';
}
function taskSaved(id) {
  if(state.view!=='task'||state.taskId!==id)return;
  clearTimeout(taskSaveTimer);taskSaveFeedback={id,owner:me()?.id};
  const status=document.querySelector('.task-save-status');if(status)status.textContent='Saved';
  taskSaveTimer=setTimeout(clearTaskSaved,3000);
}
function taskSaving(id, token) {
  if(state.view!=='task'||state.taskId!==id)return;
  clearTimeout(taskSaveTimer);taskSaveFeedback={id,owner:me()?.id,token,saving:true};
  const status=document.querySelector('.task-save-status');if(status)status.textContent='Saving…';
}
function clearTaskSaving(token) {
  if(!taskSaveFeedback?.saving||taskSaveFeedback.token!==token)return;
  clearTaskSaved();
}

function documentTitle() {
  if(!D.session||!me()?.active||me()?.mustChange)return 'oneloop';
  if(window.Recovery?.pageError||['forbidden','notfound','no-projects'].includes(state.view))return 'oneloop';
  const names={board:'Board',roadmap:'Roadmap',knowledge:'Knowledge base',inbox:'Inbox',profile:'Profile',users:'Users',settings:'Settings',storage:'Storage'};
  if(state.view==='task'){
    const task=taskById(state.taskId);
    if(!task||!canReadTask(task))return 'oneloop';
    return `${task.id} · ${task.title} · oneloop`;
  }
  const label=names[state.view];if(!label)return 'oneloop';
  const p=['board','roadmap','knowledge','settings'].includes(state.view)?project():null;
  return `${label}${p&&canReadProject(p.id)?` · ${p.name}`:''} · oneloop`;
}
function updateDocumentTitle(){const title=documentTitle();if(document.title!==title)document.title=title;}
function awaitingServerTask() {
  return !!((state.view === 'notfound'||state.view==='task'&&taskById(state.taskId)?.detailsLoaded===false) && state.taskId &&
    location.hash.startsWith('#/task/') && !['403','404','deleted'].includes(window.Recovery?.pageError));
}

// ---------- task page ----------
function taskActivityHtml(task){
  const feed=collaboration.feedHtml(task),state=collaboration.taskFeedState(task.id);
  const retry=`<button class="btn quiet" ${UIAction('retryTaskActivity', task.id)}>Retry</button>`;
  if(!feed)return state?.error?`<div class="access-note" role="alert">Could not load activity. ${retry}</div>`:state?.loaded===false?'<div class="access-note" role="status">Loading activity…</div>':'<div class="access-note">No activity yet</div>';
  return state?.error?`<div class="access-note" role="alert">Could not refresh activity. ${retry}</div>${feed}`:feed;
}
const feedRowMarkup = new WeakMap();
function refreshTaskActivity(id,preserveComments=true) {
  if(state.view!=='task'||state.taskId!==id)return;
  updateDocumentTitle();
  const timeline=document.querySelector('.task-page .timeline');if(!timeline)return;
  const active=document.activeElement,before=timeline.getBoundingClientRect().height,rows=UIMotion.rows(timeline,'[data-feed-key]','data-feed-key'),existing=new Map([...timeline.children].filter(el=>el.dataset.feedKey).map(el=>[el.dataset.feedKey,el])),timelineRect=timeline.getBoundingClientRect();
  const template=document.createElement('template');setHTML(template,taskActivityHtml(taskById(id)));
  const next=[...template.content.children],wanted=new Set(next.map(el=>el.dataset.feedKey).filter(Boolean));
  const focusedKey=active?.closest?.('[data-feed-key]')?.dataset.feedKey;
  const focusedControl=active?.matches?.('button')?{comment:active.closest('[data-comment]')?.dataset.comment,replyRoot:active.dataset.replyRoot,action:active.getAttribute('aria-label'),className:active.className}:null;
  const changed=[];
  const children=next.map(el=>{const old=existing.get(el.dataset.feedKey),markup=el.outerHTML;if(old&&((preserveComments&&old.classList.contains('comment-conversation'))||feedRowMarkup.get(old)===markup))return old;feedRowMarkup.set(el,markup);if(old)changed.push(el);return el;});
  const exiting=document.createElement('div');exiting.inert=true;exiting.setAttribute('aria-hidden','true');Object.assign(exiting.style,{position:'absolute',inset:'0',height:before+'px',pointerEvents:'none'});
  const viewport=timeline.closest('.content')?.getBoundingClientRect(),removed=[...existing.keys()].filter(key=>!wanted.has(key)).length;
  if(removed<=20&&!UIMotion.reduced())existing.forEach((el,key)=>{const rect=rows.get(key);if(wanted.has(key)||!rect?.height||viewport&&(rect.bottom<viewport.top||rect.top>viewport.bottom))return;const ghost=el.cloneNode(true);[ghost,...ghost.querySelectorAll('*')].forEach(node=>[...node.attributes].forEach(attr=>{if(attr.name==='id'||attr.name==='name'||attr.name==='tabindex'||attr.name.startsWith('on')||attr.name.startsWith('data-')||attr.name.startsWith('aria-'))node.removeAttribute(attr.name);}));Object.assign(ghost.style,{position:'absolute',top:rect.top-timelineRect.top+'px',left:rect.left-timelineRect.left+'px',width:rect.width+'px',height:rect.height+'px',margin:'0'});exiting.append(ghost);});
  timeline.style.position='relative';
  // Move only rows whose place changed. replaceChildren would detach every row, and browsers cancel a click whose pressed element left the document, even briefly.
  let cursor=timeline.firstChild;for(const child of children){if(child===cursor)cursor=cursor.nextSibling;else timeline.insertBefore(child,cursor);}while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
  if(children.length<=100)changed.forEach(el=>UIMotion.fade(el));if(exiting.children.length){timeline.append(exiting);const animation=UIMotion.animate(exiting,[{opacity:1},{opacity:0}],140);if(animation)animation.finished.then(()=>exiting.remove(),()=>exiting.remove());else exiting.remove();}
  if(active?.isConnected&&timeline.contains(active))active.focus({preventScroll:true});
  else if(focusedKey&&focusedControl){const row=[...timeline.querySelectorAll('[data-feed-key]')].find(el=>el.dataset.feedKey===focusedKey);const target=focusedControl.replyRoot?[...row?.querySelectorAll('[data-reply-root]')||[]].find(el=>el.dataset.replyRoot===focusedControl.replyRoot):focusedControl.comment?[...row?.querySelectorAll('[data-comment] button')||[]].find(el=>el.closest('[data-comment]')?.dataset.comment===focusedControl.comment&&el.getAttribute('aria-label')===focusedControl.action):[...row?.querySelectorAll('button')||[]].find(el=>el.className===focusedControl.className);target?.focus({preventScroll:true});}
  UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-feed-key]','data-feed-key',rows);
}

// A title or description that is not saved yet stays as typed, with Save.
const taskDraft = (t, field) => window.OneloopRuntime?.taskDraft?.(t.internalId, field) || null;
function taskDraftNote(t, field) {
  if (!taskDraft(t, field)?.unsaved) return '';
  if (!canBoard()) return `<p class="save-feedback" data-draft-note="${UIEscape(field)}" role="alert">Not saved. You no longer have permission to edit this task.</p>`;
  return `<p class="save-feedback" data-draft-note="${UIEscape(field)}" role="status">Not saved <button type="button" class="btn quiet" ${UIAction('saveTaskDraft', t.id, field)}>Save</button></p>`;
}
// A field the person can no longer edit stays readable when it holds their unsaved text, so they can copy it.
const lockedField = (t, field) => taskDraft(t, field)?.unsaved ? 'readonly' : 'disabled';
/** The task page's status and Blocked badge in the top bar, and its Properties heading with Block task. */
const taskStatusHtml = (t) => `<span class="chip idle task-status-chip">${stIcon(t.state)}${STATUS[t.state]}</span>${t.block ? `<span class="blocked-badge">${I.blocked}Blocked</span>` : ''}`;
const taskPropertiesHeadingHtml = (t, canEdit) => `<div class="task-properties-heading"><h2 id="task-properties-heading">Properties</h2>${canEdit && t.state !== 'done' && !t.block ? `<button class="btn block-task-action" ${UIAction('openModal', 'block', t.id)}>${I.blocked}Block task</button>` : ''}</div>`;
function renderTask() {
  const t = taskById(state.taskId);
  if (!t) { state.view = 'board'; return renderBoard(); }
  const canEdit = canBoard();
  const title = taskDraft(t, 'title')?.value ?? t.title, desc = taskDraft(t, 'desc')?.value ?? t.desc ?? '';
  const atts = window.Uploads?.renderAttachments(t,canEdit) || '';

  const feed = taskActivityHtml(t);

  const late = overdue(t);
  return `<div class="task-page"><div class="task-layout${t.block ? ' has-block' : ''}">
      <div class="task-title-field"><textarea class="tp-title" name="title" aria-label="Task title" rows="1" placeholder="Fix payment validation" required aria-required="true" maxlength="140" data-autosave ${UIAction.on('input', 'sizeTaskTitle')} data-key="Enter" ${UIAction.on('keydown', 'leaveField', UIAction.event, UIAction.element)} ${canEdit ? UIAction.on('blur', 'updTask', t.id, 'title', UIAction.value) : lockedField(t, 'title')}>${esc(title)}</textarea>${taskDraftNote(t, 'title')}</div>
    ${t.block ? `<section class="task-block" data-block-id="${esc(t.block.id)}" tabindex="-1" aria-label="Task blocked"><div class="task-block-heading"><strong>${I.blocked}Blocked</strong>${canEdit ? `<button class="btn unblock-action" ${UIAction('openModal', 'unblock', t.id)}>Unblock task</button>` : ''}</div><p>${collaboration?.blockText(t.block) || esc(t.block.reason)}</p><div class="task-block-footer"><small>${esc(userById(t.block.by)?.name || t.block.by)} · ${ago(t.block.at)}</small>${canEdit ? `<button class="btn block-edit-action" ${UIAction('openModal', 'block', t.id)}>Edit reason</button>` : ''}</div></section>` : ''}
    <aside class="tp-rail" aria-labelledby="task-properties-heading">
      ${taskPropertiesHeadingHtml(t, canEdit)}
      <dl class="task-properties">
        <div class="task-property"><dt>Status</dt><dd>${selectHtml('tpState', { label: 'Status', cls: 'prop', disabled: !canEdit, icon: stIcon(t.state), value: t.state, options: Object.entries(STATUS).map(([v, l]) => ({ v, l, icon: stIcon(v) })), pick: (v) => App.updTask(t.id, 'state', v) })}</dd></div>
        <div class="task-property"><dt>Epic</dt><dd>${selectHtml('tpEpic', { label: 'Epic', cls: 'prop', disabled: !canEdit, icon: I.roadmap, value: t.epicId, search: true, options: epics().filter(e => e.state !== 'done' || e.id === t.epicId).slice().sort((a, b) => d(a.start) - d(b.start)).map((e) => ({ v: e.id, l: e.title })), pick: (v) => App.updTask(t.id, 'epicId', v) })}</dd></div>
        <div class="task-property"><dt>Assignees</dt><dd>${msHtml('tpAssign', t.id, !canEdit)}</dd></div>
        <div class="task-property task-property-date prop-row${late ? ' late' : ''}"><dt>Deadline</dt><dd>${dateHtml('tpDl', { hideLabel: true, cls: 'prop', disabled: !canEdit, icon: I.clock, name: '_dl', value: t.deadline || '', clearable: true, autosave: true, pick: (v) => App.updTask(t.id, 'deadline', v) })}<span class="task-overdue" ${late ? '' : 'hidden'}>Overdue</span></dd></div>
        <div class="task-property"><dt>Created at</dt><dd>${Number.isFinite(t.created)?`<time class="task-created-at" datetime="${new Date(t.created).toISOString()}">${formatInstant(t.created)}</time>`:'<span class="task-created-at">Unavailable</span>'}</dd></div>
      </dl>
    </aside>
    <div class="tp-main">
      <div class="tp-sec task-description expandable-description" data-task="${esc(t.id)}" data-description-key="task-${esc(t.id)}"><h2 id="task-description-label">Description</h2>
        <div class="description-preview"><textarea id="task-description" class="ctl" aria-labelledby="task-description-label" placeholder="${canEdit ? 'Add a description…' : 'No description'}" aria-required="false" maxlength="4000" data-autosave ${UIAction.on('focus', 'expandDescription')} ${UIAction.on('input', 'sizeDescription')} ${canEdit ? UIAction.on('blur', 'updTask', t.id, 'desc', UIAction.value) : lockedField(t, 'desc')}>${esc(desc)}</textarea></div>
        <button type="button" class="description-toggle" aria-controls="task-description" aria-expanded="false" ${UIAction('toggleDescription')} hidden>Show more</button>${taskDraftNote(t, 'desc')}</div>
      <div class="tp-sec task-attachments">${window.Uploads?.attachmentHeader(t,canEdit) || '<h2>Attachments</h2>'}
        ${canEdit ? `<input type="file" id="attIn" multiple style="display:none" ${UIAction.on('change', 'attachFiles', t.id, UIAction.element)}>` : ''}
        ${atts}<div class="upload-list"></div></div>
      <div class="tp-sec task-activity"><h2>Activity</h2>
        <div class="timeline">${feed}</div>
        <div class="comment-composer-home">${collaboration?.composerHtml(t) || ''}</div></div>
    </div>
  </div></div>`;
}

function msHtml(key, taskId, disabled) {
  return multiHtml(key, {
    label: 'Assignees',
    cls: 'prop',
    disabled,
    icon: () => { const a = (taskById(taskId)?.assignees || []).filter(userById); return a.length ? `<span class="avs">${a.slice(0, 3).map((x) => avatarHtml(x, 16)).join('')}</span>` : I.person; },
    options: projectMembers().map((u) => ({ v: u.id, l: u.name, sub: userHandle(u) })),
    values: () => taskById(taskId)?.assignees || [],
    toggle: (v) => { clearTaskSaved();if (!App.require('manage_board') || window.Recovery&&!Recovery.ensureOnline()) return; const t = taskById(taskId); if(!t){App.toast('This task is no longer available','error');return;} if(!(t.assignees||[]).includes(v)&&!projectMembers().some(u=>u.id===v)){App.toast('This person is no longer a project member','error');return;} invoke('task.assignees',{taskId:t.internalId,assigneeIds:t.assignees.includes(v)?t.assignees.filter(id=>id!==v):[...t.assignees,v]}); },
    summary: () => { const a = taskById(taskId)?.assignees || []; return a.length ? a.map((x) => (userById(x) || { name: x }).name).join(', ') : 'Unassigned'; },
    onClose: () => render(),
  });
}

// ---------- settings ----------
/** @type {{projectId:string|null,query:string,limit:number}} */
let memberWindow = {projectId:null, query:'', limit:100};
document.addEventListener('input', event => {
  const input=event.target;
  if(!(input instanceof HTMLInputElement)||!input.matches('.settings-wide [data-member-search]'))return;
  memberWindow.query=input.value;memberWindow.limit=100;App.refreshUsers();
});
document.addEventListener('click', event => {
  if(!(event.target instanceof Element)||!event.target.closest('.settings-wide [data-more-members]'))return;
  memberWindow.limit+=100;App.refreshUsers();
});
function renderSettings() {
  const p = project();
  if(memberWindow.projectId!==p.id)memberWindow={projectId:p.id,query:'',limit:100};
  const members = (p.members || []).map((raw) => ({
    record: typeof raw === 'string' ? { userId: raw, permissions: [] } : raw,
    user: userById(typeof raw === 'string' ? raw : raw.userId),
  })).filter((x) => x.user);
  const memberIds = new Set((p.members || []).map((/** @type {any} */ raw) => typeof raw === 'string' ? raw : raw.userId));
  const candidates = D.users.filter((u) => u.active && !memberIds.has(u.id));
  const query=memberWindow.query.toLowerCase();
  const matching=members.filter((/** @type {{user:any}} */ {user})=>!query||`${user.name} ${userHandle(user)}`.toLowerCase().includes(query));
  return `<div class="settings settings-wide">
    <div class="section">
      <h2>Project</h2>
      <div class="project-fields">
        <div class="field-row">
          ${field('Name', `<input class="ctl" name="name" value="${esc(p.name)}" maxlength="60" data-autosave ${UIAction.on('blur', 'updateProjectField', UIAction.element)} data-key="Enter" ${UIAction.on('keydown', 'leaveProjectField', UIAction.event, UIAction.element)}>`)}
          <div style="max-width:110px">${field('Task prefix', `<input class="ctl mono" name="key" value="${esc(p.key)}" maxlength="4" data-autosave ${UIAction.on('blur', 'updateProjectField', UIAction.element)} data-key="Enter" ${UIAction.on('keydown', 'leaveProjectField', UIAction.event, UIAction.element)}>`)}</div>
        </div>
      </div>
    </div>
    <div class="section">
      <h2>Project access <span class="mono" style="font-size:var(--text-sm);color:var(--ink-ghost)">${members.length}</span></h2>
      <input id="member-search" class="ctl" type="search" aria-label="Search project members" placeholder="Search members" value="${esc(memberWindow.query)}" data-member-search>
      <div class="member-access-list" aria-busy="${UIEscape(!!D.adminUsers?.loading)}">
        ${matching.slice(0,memberWindow.limit).map(({ user: u, record: m }) => `
          <div class="member-access-row ${u.active ? '' : 'off'}">
            <div class="member-person">${avatarHtml(u.id, 24)}<span><b data-tip="${esc(u.name)}" data-tip-overflow>${esc(u.name)}</b><small class="mono">${esc(userHandle(u))}</small></span>${u.active ? '' : '<span class="tag-off">deactivated</span>'}</div>
            <div class="member-grants">
              ${u.admin ? '<span class="admin-access">Full access</span>' : `
                <label class="permission-check"><input type="checkbox" data-autosave aria-label="${esc(u.name)}: manage Roadmap" ${(m.permissions || []).includes('manage_roadmap') ? 'checked' : ''} ${UIAction.on('change', 'setMemberPermission', u.id, 'manage_roadmap', UIAction.checked, UIAction.element)}><span><b>Roadmap</b></span></label>
                <label class="permission-check"><input type="checkbox" data-autosave aria-label="${esc(u.name)}: manage Board" ${(m.permissions || []).includes('manage_board') ? 'checked' : ''} ${UIAction.on('change', 'setMemberPermission', u.id, 'manage_board', UIAction.checked, UIAction.element)}><span><b>Board</b></span></label>`}
            </div>
            <button class="row-x icon-button" type="button" title="Remove from project" aria-label="Remove ${esc(u.name)} from project" ${UIAction('removeMember', u.id)}>${I.close}</button>
          </div>`).join('') || `<div class="empty-note" style="border:0;text-align:left;padding:4px 0">${query?'No matching members':'No members yet'}</div>`}
      </div>
      ${matching.length>memberWindow.limit?'<button type="button" class="btn quiet" data-more-members>Load more members</button>':''}
      <div style="margin-top:12px;width:260px">${D.adminUsers?.loading&&!D.adminUsers?.loaded ? '<span class="access-note" role="status">Loading users…</span>' : candidates.length
        ? selectHtml('addMember', { label:'Add member', value: '', placeholder: 'Add member…', search: true, options: candidates.map((u) => ({ v: u.id, l: `${u.name} · ${userHandle(u)}` })), pick: (v) => App.addMember(v) })
        : D.adminUsers?.nextCursor ? '' : '<div class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">No users to add</div>'}</div>
      ${D.adminUsers?.nextCursor ? `<button type="button" class="btn quiet" data-more-users ${UIAction('loadMoreUsers')} ${D.adminUsers.loading?'disabled':''}>Load more users</button>` : ''}
      ${D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" ${UIAction('retryUsers')}>Retry</button></p>` : ''}
    </div>
    ${window.OneloopKnowledge?.settingsHtml(p.id) || ''}
    <div class="section" style="border-color:color-mix(in srgb,var(--err) 25%,transparent)">
      <h2 style="color:var(--err)">Danger zone</h2>
      <button class="btn danger" ${UIAction('deleteProject')}>Delete project</button>
    </div>
  </div>`;
}

function usersCountLabel() {
  if(!D.adminUsers?.loaded)return D.adminUsers?.loading?'…':'';
  // While more pages wait on the server, the loaded count is only a lower bound.
  return `${D.adminUsers.ids.length}${D.adminUsers.nextCursor?'+':''}`;
}
function renderUsers() {
  const awaiting = D.adminUsers?.loading && !D.adminUsers.loaded;
  const listed=awaiting?[]:D.adminUsers?.loaded?D.adminUsers.ids.map(userById).filter(Boolean):D.users.slice(0,state.usersLimit);
  const hasMore=D.adminUsers?.loaded?!!D.adminUsers.nextCursor:D.users.length>state.usersLimit;
  return `<div class="settings">
    <div class="section">
      ${awaiting ? '<p class="access-note" role="status">Loading users…</p>' : D.adminUsers?.error ? `<p class="access-note" role="alert">${esc(D.adminUsers.error)} <button type="button" class="btn quiet" ${UIAction('retryUsers')}>Retry</button></p>` : ''}
      ${listed.map((u) => `
        <button type="button" class="user-row clickable ${u.active ? '' : 'off'}" data-user-id="${esc(u.id)}" ${UIAction('openModal', 'user', u.id)}>${avatarHtml(u.id, 22)}
          <span class="uname">${esc(u.name)}</span><span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${esc(userHandle(u))}</span>
          ${u.active ? '' : '<span class="tag-off">deactivated</span>'}
          ${u.mustChange ? '<span class="tag-off" style="color:var(--warn);border-color:color-mix(in srgb,var(--warn) 30%,transparent)">temporary password</span>' : ''}</button>`).join('')}${!awaiting && hasMore ? `<button class="btn quiet" ${UIAction('loadMoreUsers')}>Load more users</button>` : ''}
    </div>
  </div>`;
}

// ---------- peek ----------
function sparkline(weekly) {
  const max = Math.max(1,...weekly);
  const bars = weekly.map((v, i) => {
    const h = Math.max(Math.round((v / max) * 24), 4);
    const fill = i >= weekly.length - 2 ? 'var(--run)' : 'rgb(var(--tone-rgb) / 0.14)';
    return `<rect x="${i * 13}" y="${26 - h}" width="9" height="${h}" rx="1.5" fill="${fill}"/>`;
  }).join('');
  return `<svg width="${weekly.length * 13 - 4}" height="26" viewBox="0 0 ${weekly.length * 13 - 4} 26">${bars}</svg>`;
}

function renderPeek() {
  const e = epicById(state.peek);
  if (!e) return '';
  const t = trackById(e.trackId);
  const ongoing = !e.end;
  const page=D.epicPageInfo?.[e.id];
  const eTasks = page?.loaded?page.taskIds.map(taskById).filter(Boolean):tasks().filter((x) => x.epicId === e.id);
  const order = { progress: 0, review: 1, planning: 2, done: 3 };
  eTasks.sort((a, b) => order[a.state] - order[b.state] || Number(a.id.slice(a.id.lastIndexOf('-')+1)) - Number(b.id.slice(b.id.lastIndexOf('-')+1)));
  const stateColor = { done: 'var(--ok)', review: 'var(--review)', progress: 'var(--run)', planning: 'var(--ink-faint)' };
  const stateBits = (x) => [stIcon(x.state), `<span style="color:${stateColor[x.state]}">${STATUS[x.state].toLowerCase()}</span>`];
  const rows = eTasks.map((x) => {
    const [dot, m] = stateBits(x);
    return `<div class="task-row">${dot}<span class="tid">${esc(x.id)}</span><span class="tt" data-tip="${esc(x.title)}" data-tip-overflow>${esc(x.title)}</span><span class="tm">${m}</span></div>`;
  }).join('') || '<div class="empty-note" style="margin:14px 0">no tasks yet</div>';

  const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
  const midBlock = e.counted === false ? '' : ongoing && e.weekly
    ? `<div data-epic-throughput style="padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px">${sparkline(e.weekly)}
        <div><div class="mono" style="font-size:var(--text-xs);color:var(--ink-soft)">${e.closedThisWeek} closed this week</div>
        <div class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${e.completedSinceStart ?? e.done} since ${humanShort(d(e.start))} · ${e.open ?? e.total - e.done} open</div></div></div>`
    : e.total ? `<div style="padding:16px 20px;border-bottom:1px solid var(--line)">
        <div style="position:relative;height:6px;background:rgb(var(--tone-rgb) / 0.07);border-radius:3px;overflow:hidden"><div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${e.state === 'done' ? 'var(--ok)' : 'var(--run)'}"></div></div>
        <div class="mono" style="font-size:var(--text-xs);color:var(--ink-faint);margin-top:8px">${e.done} of ${e.total} tasks complete · ${pct}%</div></div>` : '';

  return `<div class="scrim" ${UIAction('closeOverlays')}></div>
  <aside class="peek" role="dialog" aria-modal="true" aria-labelledby="peek-title">
    <div class="peek-head">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="mono" style="font-size:var(--text-xs);letter-spacing:0.1em;color:var(--ink-ghost)">${esc(t ? t.name : '')}</span>
        <button type="button" class="btn icon" aria-label="Close epic" ${UIAction('closeOverlays')}>${I.close}</button>
      </div>
      <h2 id="peek-title" style="font-size:17px;font-weight:600;letter-spacing:-0.01em">${esc(e.title)}</h2>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="chip idle">${ongoing ? 'Ongoing · ' : ''}${esc(epicStatus(e))}</span>
        <span class="mono" style="font-size:var(--text-xs);color:var(--ink-faint)">${humanShort(d(e.start))} → ${e.end ? humanShort(d(e.end)) : '<span style="color:var(--ink-soft)">no end date</span>'}</span>
      </div>
    </div>
    <div class="peek-body">
    ${midBlock}
    ${e.desc ? descriptionReadHtml(e.desc,'epic-description-'+e.id) : ''}
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px 10px">
      <div style="display:flex;align-items:baseline;gap:7px"><span style="font-size:var(--text-body);font-weight:600;color:var(--ink)">Tasks</span><span class="mono" data-epic-task-total style="font-size:var(--text-xs);color:var(--ink-ghost)">${page?.loaded?page.tasksTotal:eTasks.length}</span></div>
    </div>
    <div class="peek-rows">${rows}${page?.tasksCursor?`<button class="btn quiet" ${UIAction('loadMoreEpicTasks', e.id)}>Load more tasks</button>`:''}
      <div style="padding:14px 0 6px;font-size:var(--text-body);font-weight:600;color:var(--ink)">Activity</div>
      ${actFeed(e.activity, page?.loaded?Number.MAX_SAFE_INTEGER:8)}
      ${page?.activityCursor?`<button class="btn quiet" ${UIAction('loadMoreEpicActivity', e.id)}>Load older activity</button>`:''}
    </div>
    </div>
    <div class="peek-actions">
      ${canRoadmap() ? `${e.state === 'done'
        ? `<button class="btn" ${UIAction('reopenEpic', e.id)}>Reopen</button>`
        : `<button class="btn" ${UIAction('closeEpic', e.id)}>Mark as done</button>`}
      <button class="btn" ${UIAction('openModal', 'epic', e.id)}>Edit epic</button>
      <button class="btn danger" style="margin-left:auto" ${UIAction('deleteEpic', e.id)}>Delete</button>` : '<span class="access-note" style="margin:0">Read only</span>'}
    </div>
  </aside>`;
}

// ---------- modals ----------
const optionalMark = '<span class="optional-mark">Optional</span>';
const fieldPlaceholders = {
  Username: 'alex', 'Full name': 'First and last name',
  Password: 'Enter password', 'Current password': 'Current password',
  'New password': 'New password', Confirm: 'Repeat password',
  Name: 'Customer portal', 'Task prefix': 'APP',
  Description: 'Scope and outcome', Goal: 'Target outcome',
};
let fieldSequence = 0;
/** Number field labels from the start again, so a page drawn again keeps its IDs. */
function resetFieldIds() { fieldSequence = 0; }
function field(label, inner, optional = false) {
  let targetId = '';
  inner = inner.replace(/<(input|textarea)\b([^>]*)>/g, (match, tag, attrs) => {
    if (/\bdisabled\b|type="(?:hidden|file|checkbox)"/.test(attrs)) return match;
    if (!/\bplaceholder=/.test(attrs)) attrs += ` placeholder="${esc(fieldPlaceholders[label] || label)}"`;
    attrs = attrs.replace(/\srequired\b/g, '').replace(/\saria-required="[^"]*"/g, '');
    return `<${tag}${attrs}${optional ? ' aria-required="false"' : ' required aria-required="true"'}>`;
  });
  inner = inner.replace(/<(input|textarea|button)\b([^>]*)>/g, (match, tag, attrs) => {
    if (targetId || /type="(?:hidden|file|checkbox)"/.test(attrs)) return match;
    if (tag === 'button' && !/\bsel-btn\b/.test(attrs)) return match;
    targetId = /\bid="([^"]+)"/.exec(attrs)?.[1] || `field-${++fieldSequence}`;
    if(tag==='button'&&/\bsel-btn\b/.test(attrs)&&attrs.includes('aria-haspopup="listbox"')){
      const valueId=/id="([^"]+)" class="sel-label"/.exec(inner)?.[1];
      attrs=attrs.replace(/\saria-labelledby="[^"]*"/,'')+` aria-labelledby="${targetId}-label${valueId?' '+valueId:''}"`;
    }
    return `<${tag}${/\bid=/.test(attrs) ? attrs : `${attrs} id="${UIEscape(targetId)}"`}>`;
  });
  return `<div class="field" data-required="${UIEscape(!optional)}"><label${targetId ? ` id="${esc(targetId)}-label" for="${esc(targetId)}"` : ''}>${label}${optional ? optionalMark : ''}</label>${inner}</div>`;
}

const taskDestinationEpics = () => epics().filter(epic => epic.state !== 'done');

function taskAssigneesHtml(m){
  m.assignees ||= [];
  const sync=()=>{const host=document.querySelector('.task-form-assignee-values');if(host)setHTML(host,m.assignees.map(id=>`<input type="hidden" name="assignees" value="${esc(id)}">`).join(''));};
  const select=multiHtml('mTaskAssignees',{label:'Assignees',search:true,icon:()=>I.person,options:projectMembers().map(u=>({v:u.id,l:u.name,sub:userHandle(u)})),values:()=>m.assignees,
    toggle:id=>{const index=m.assignees.indexOf(id);if(index<0)m.assignees.push(id);else m.assignees.splice(index,1);sync();},clear:()=>{m.assignees=[];sync();},summary:()=>m.assignees.length?m.assignees.map(id=>userById(id)?.name||id).join(', '):'Unassigned'});
  return `${select}<div class="task-form-assignee-values">${m.assignees.map(id=>`<input type="hidden" name="assignees" value="${esc(id)}">`).join('')}</div>`;
}

function taskModalHtml(m) {
  if(!taskDestinationEpics().length) return `<h2>New task</h2><div class="sub">No open epics are available.</div><div class="modal-actions"><button class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button>${canRoadmap()?`<button class="btn primary" ${UIAction('openModal', 'epic')}>Create epic</button>`:''}</div>`;
  return `<h2>New task</h2>
    <form novalidate ${UIAction.on('submit', 'saveTask', UIAction.event)}>
      ${field('Title', `<input class="ctl" name="title" placeholder="Fix payment validation" value="${esc(m.title || '')}" maxlength="140" required autofocus>`)}
      ${field('Epic', selectHtml('mEpic', { name: 'epicId', value: taskDestinationEpics().some((e) => e.id === m.epicId) ? m.epicId : '', placeholder: 'Choose an epic', options: taskDestinationEpics().slice().sort((a, b) => d(a.start) - d(b.start)).map((e) => ({ v: e.id, l: e.title })) }))}
      <div class="field-row">
        ${field('Assignees',taskAssigneesHtml(m),true)}
        ${field('Deadline',dateHtml('mTaskDeadline',{label:'Deadline',name:'deadline',value:'',clearable:true,placeholder:'Set deadline'}),true)}
      </div>
      ${field('Description', descriptionEditorHtml(m.desc||'',4000,'Scope and acceptance criteria'), true)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">Create task</button></div>
    </form>`;
}
function poolRowHtml(p) {
  const writable=p.scope==='mine'?p.ownerId===me()?.id:canBoard();
  return `<div class="pool-row${canBoard()?' promotable':''}" data-pool-item="${UIEscape(p.id)}"><div class="pool-item-main"><div class="pool-item-copy">${canBoard()?`<button type="button" class="txt pool-promote" aria-label="Create task from ${esc(p.title)}" data-tip="${esc(p.title)}" data-tip-overflow ${UIAction('promotePool',p.id)}>${esc(p.title)}</button>`:`<span class="txt">${esc(p.title)}</span>`}${p.desc?`<span class="pool-description-preview">${esc(p.desc)}</span>`:''}</div><span class="act">${writable||p.desc?`<button type="button" class="btn icon pool-note-toggle" aria-label="${writable?p.desc?'Edit description':'Add description':'View description'} for ${esc(p.title)}" title="${writable?p.desc?'Edit description':'Add description':'View description'}" aria-expanded="false" ${UIAction('editPoolDescription',UIAction.event,p.id)}>${I.note}</button>`:''}${canBoard()?`<button type="button" class="btn icon pool-promote-action" aria-label="Create task from ${esc(p.title)}" title="Create task" ${UIAction('promotePool',p.id)}>${I.arrow}</button>`:''}${writable?`<button type="button" class="btn icon pool-delete" aria-label="Delete ${esc(p.title)}" title="Delete item" ${UIAction('delPool',UIAction.event,p.id)}>${I.close}</button>`:''}</span></div></div>`;
}
function resetPoolCapture(){const capture=document.querySelector('.pool-capture');if(!capture)return;capture.classList.remove('is-expanded');const notes=capture.querySelector('#poolNewDesc');notes.value='';const content=capture.querySelector('.pool-capture-notes');content.inert=true;content.setAttribute('aria-hidden','true');const toggle=capture.querySelector('.pool-capture-toggle');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Add description');toggle.title='Add description';setHTML(toggle,I.note);}

function poolReadNotice(empty=false) {
  const page=D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`];
  if(page?.error)return `<div class="pool-read-status access-note" role="alert">Could not ${page.loaded?'refresh':'load'} items. <button class="btn quiet" ${UIAction('retryPool')}>Retry</button></div>`;
  if(!empty)return '';
  const pending=page?.loaded===false;
  return `<div class="empty-note"${pending?' role="status"':''}>${pending?'Loading items…':'No items'}</div>`;
}
function poolLoadMoreHtml() {
  return D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`]?.nextCursor?`<button class="btn quiet pool-load-more" ${UIAction('loadMorePool')}>Load more</button>`:'';
}
function updatePool({ completeItemId } = {}) {
  App.updateDocumentTitle();
  const view = document.querySelector('.pool-view');
  if (!view) return;
  const list = view.querySelector('.pool-list');
  const listScroll = list.scrollTop;
  const tabChanged = list.dataset.poolScope && list.dataset.poolScope !== state.poolTab;
  const beforeRows = new Map([...list.querySelectorAll('[data-pool-item]')].map(el => [el.dataset.poolItem, el.getBoundingClientRect()]));
  const items = poolItems(state.poolTab);
  const ids = new Set(items.map((item) => item.id));
  list.querySelectorAll('[data-pool-item]').forEach((row) => { if (!ids.has(row.dataset.poolItem)) { if (!tabChanged) exitVisual(row); row.remove(); } });
  list.querySelector('.empty-note')?.remove();
  list.querySelector('.pool-read-status')?.remove();
  let cursor = list.firstElementChild;
  items.forEach((item) => {
    let row = list.querySelector(`[data-pool-item="${UIEscape(item.id)}"]`);
    if (row) {
      const editor=row.querySelector('.pool-description-editor');
      const editedHere = !!editor?.contains(document.activeElement);
      const template = document.createElement('template'); setHTML(template,poolRowHtml(item));
      const fresh = template.content.firstElementChild;
      const actions=element=>[...element.querySelectorAll('.act > button')].map(button=>button.className).join('|');
      const sameActions=row.className===fresh.className&&actions(row)===actions(fresh);
      row.className=fresh.className;
      if(sameActions)patchBoardRow(row.querySelector('.pool-item-main'),fresh.querySelector('.pool-item-main'));
      else row.querySelector('.pool-item-main')?.replaceWith(fresh.querySelector('.pool-item-main'));
      if(item.id===completeItemId){editor?.remove();if(editedHere)row.querySelector('.pool-note-toggle')?.focus({preventScroll:true});}
      else if(editor){
        row.querySelector('.pool-note-toggle')?.setAttribute('aria-expanded','true');
        const reader=editor.querySelector('.pool-note-read');if(reader){reader.textContent=item.desc||'';reader.setAttribute('aria-label',`Description for ${item.title}`);}
      }
    }
    if (!row) { const template = document.createElement('template'); setHTML(template,poolRowHtml(item)); row = template.content.firstElementChild; }
    if (row !== cursor) list.insertBefore(row, cursor);
    cursor = row.nextElementSibling;
  });
  if (!items.length) setHTML(list,poolReadNotice(true));
  else if(D.poolPageInfo?.[`${state.projectId}:${state.poolTab}`]?.error){const note=document.createElement('template');setHTML(note,poolReadNotice());list.append(note.content);}
  list.querySelector('.pool-load-more')?.remove();
  const more=document.createElement('template');setHTML(more,poolLoadMoreHtml());list.append(more.content);
  view.querySelectorAll('[data-pool-tab]').forEach((button) => {
    const selected = button.dataset.poolTab === state.poolTab;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('span').textContent = D.poolPageInfo?.[`${state.projectId}:${button.dataset.poolTab}`]?.total ?? poolItems(button.dataset.poolTab).length;
  });
  const input = view.querySelector('#poolAdd');
  input.hidden = state.poolTab === 'project' && !canBoard();
  view.querySelector('.pool-capture').hidden=input.hidden;
  if(tabChanged){input.value='';resetPoolCapture();view.querySelectorAll('.pool-description-editor').forEach(el=>el.remove());view.querySelectorAll('.pool-note-toggle').forEach(el=>el.setAttribute('aria-expanded','false'));}
  const mineTotal=D.poolPageInfo?.[`${state.projectId}:mine`]?.total,teamTotal=D.poolPageInfo?.[`${state.projectId}:project`]?.total;
  document.querySelectorAll('[data-pool-count]').forEach((el) => { el.textContent = Number.isFinite(mineTotal)&&Number.isFinite(teamTotal)?mineTotal+teamTotal:poolItems().length; });
  list.dataset.poolScope = state.poolTab;
  if (!tabChanged) list.scrollTop = listScroll;
  if (tabChanged) fadeContent(list);
  else list.querySelectorAll('[data-pool-item]').forEach(row => {
    const from = beforeRows.get(row.dataset.poolItem), to = row.getBoundingClientRect();
    if (!from) uiAnimate(row, [{ opacity:0,transform:'translateY(4px)' },{ opacity:1,transform:'none' }]);
    else if (Math.abs(from.top - to.top) > 1) uiAnimate(row, [{transform:`translateY(${from.top - to.top}px)`},{transform:'none'}]);
  });
}

function renderModal() {
  const m = state.modal;
  if (!m) return '';
  let body = '';
  if (['block','unblock','completeBlocked'].includes(m.type)) {
    const task=taskById(m.id),blocking=m.type==='block',complete=m.type==='completeBlocked';
    if(!task)return '';
    body=`<h2>${blocking ? task.block ? 'Edit block reason' : 'Block task' : complete ? 'Unblock and complete task?' : 'Unblock task'}</h2>
      ${!blocking ? `<p class="sub">${esc(task.block?.reason || '')}</p>` : ''}
      <form novalidate data-block-action ${UIAction.on('submit', 'saveBlock', UIAction.event, task.id, m.type)}>
        ${field(blocking?'Reason':'Resolution',blocking ? Collab.blockReasonHtml(task) : `<textarea class="ctl" name="reason" maxlength="500" placeholder="How was this resolved?" ${UIAction.on('keydown', 'commentKey', UIAction.event)}></textarea>`,!blocking)}
        <div class="modal-actions"><button type="button" class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary">${blocking?'Save':complete?'Unblock and complete':'Unblock'}</button></div>
      </form>`;
  } else if (m.type === 'epic') {
    const e = m.id ? epicById(m.id) : null;
    body = `<h2>${e ? 'Edit epic' : 'New epic'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveEpic', UIAction.event, m.id || '')}>
      ${field('Title', `<input class="ctl" name="title" placeholder="Payment integration" value="${esc(e ? e.title : '')}" maxlength="120" required autofocus>`)}
      ${field('Track', selectHtml('mTrack', { name: 'trackId', value: e ? e.trackId : (m.trackId || ''), placeholder: 'Choose a track', options: tracks().map((t) => ({ v: t.id, l: t.name })) }))}
      <div class="field-row">
        ${field('Start', dateHtml('mStart', { name: 'start', value: e ? e.start : iso(today), max: () => dateValue('mEnd'), maxError: 'Start date cannot be after the end date.' }))}
        ${field('End', dateHtml('mEnd', { name: 'end', value: (e && e.end) || '', clearable: true, min: () => dateValue('mStart'), minError: 'End date cannot be before the start date.', placeholder: 'No end date' }), true)}
      </div>
      ${field('Description', descriptionEditorHtml(e?.desc,2000), true)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${e ? 'Save' : 'Create epic'}</button></div>
    </form>`;
  } else if (m.type === 'milestone') {
    const ms = m.id ? D.milestones.find((x) => x.id === m.id) : null;
    body = `<h2>${ms ? 'Edit milestone' : 'New milestone'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveMilestone', UIAction.event, m.id || '')}>
      ${field('Name', `<input class="ctl" name="name" placeholder="Public launch" value="${esc(ms ? ms.name : '')}" maxlength="60" required autofocus>`)}
      ${field('Date', dateHtml('mDate', { name: 'date', value: ms ? ms.date : iso(today) }))}
      ${field('Goal', descriptionEditorHtml(ms?.desc,500), true)}
      <div class="modal-actions">${ms ? `<button class="btn danger" type="button" style="margin-right:auto" ${UIAction('deleteMilestone', ms.id)}>Delete</button>` : ''}<button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${ms ? 'Save' : 'Create milestone'}</button></div>
    </form>`;
  } else if (m.type === 'track') {
    const t = m.id ? trackById(m.id) : null;
    body = `<h2>${t ? 'Rename track' : 'New track'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveTrack', UIAction.event, m.id || '')}>
      ${field('Name', `<input class="ctl" name="name" placeholder="Backend & API" value="${esc(t ? t.name : '')}" maxlength="60" required autofocus>`)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">${t ? 'Save' : 'Create track'}</button></div>
    </form>`;
  } else if (m.type === 'task') {
    body = taskModalHtml(m);
  } else if (m.type === 'project') {
    body = `<h2>New project</h2>
    <form novalidate ${UIAction.on('submit', 'saveProjectNew', UIAction.event)}>
      ${field('Name', `<input class="ctl" name="name" maxlength="60" required autofocus>`)}
      ${field('Task prefix', `<input class="ctl mono" name="key" placeholder="APP" maxlength="4">`)}
      <div class="modal-actions"><button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button><button class="btn primary" type="submit">Create project</button></div>
    </form>`;
  } else if (m.type === 'user') {
    const u = m.id ? userById(m.id) : null;
    const lastAdmin = u && u.admin && u.active && activeAdmins().length === 1;
    body = `<h2>${u ? 'Edit user' : 'New user'}</h2>
    <form novalidate ${UIAction.on('submit', 'saveUser', UIAction.event, m.id || '')}>
      ${field('Username', `<input class="ctl mono" name="username" value="${esc(u ? userHandle(u) : '')}" ${u ? 'disabled' : 'autofocus'} maxlength="32">`)}
      ${field('Full name', `<input class="ctl" name="name" value="${esc(u ? u.name : '')}" maxlength="80" ${u ? 'autofocus' : ''}>`)}
      <label class="check" style="margin-bottom:5px"><input type="checkbox" name="admin" ${u && u.admin ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}> Admin${lastAdmin ? ' <span class="mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">· last active admin</span>' : ''}</label>
      ${u ? `<label class="check" style="margin-bottom:14px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}> Active</label>` : ''}
      <div class="modal-actions">
        ${u ? `<button class="btn" type="button" style="margin-right:auto" ${UIAction('resetPassword', u.id)}>Reset password</button>` : ''}
        <button class="btn quiet" type="button" ${UIAction('closeOverlays')}>Cancel</button>
        <button class="btn primary" type="submit">${u ? 'Save' : 'Create user'}</button>
      </div>
    </form>`;
  } else if (m.type === 'temppw') {
    const user=userById(m.id),account=user?.username||user?.name||'Account';
    body = `<h2>Temporary password</h2>
    <div class="temporary-password-meta"><strong>${esc(account)}</strong><span>Shown once</span></div>
    <div class="pw-box"><span class="mono" id="tmpPw">${esc(m.pw)}</span><button class="btn" type="button" aria-label="Copy temporary password" ${UIAction('copyTemporaryPassword')}>Copy</button></div>
    <div class="modal-actions"><button class="btn primary" ${UIAction('closeOverlays')}>Done</button></div>`;
  } else if (m.type === 'pool') {
    const mine = poolItems('mine'), proj = poolItems('project');
    const pl = state.poolTab === 'mine' ? mine : proj;
    const canWritePool = state.poolTab === 'mine' || canBoard();
    const rows = pl.length?pl.map(poolRowHtml).join('')+poolReadNotice():poolReadNotice(true);
    body = `<div class="pool-view"><div class="pool-head"><h2>Pool</h2>
      <div class="seg" style="margin-left:auto">
        <button type="button" class="${state.poolTab === 'mine' ? 'on' : ''}" data-pool-tab="mine" aria-pressed="${state.poolTab === 'mine'}" ${UIAction('setPoolTab', 'mine')}>My <span class="mono" style="font-size:var(--text-xs);opacity:.7">${D.poolPageInfo?.[`${state.projectId}:mine`]?.total ?? mine.length}</span></button>
        <button type="button" class="${state.poolTab === 'project' ? 'on' : ''}" data-pool-tab="project" aria-pressed="${state.poolTab === 'project'}" ${UIAction('setPoolTab', 'project')}>Team <span class="mono" style="font-size:var(--text-xs);opacity:.7">${D.poolPageInfo?.[`${state.projectId}:project`]?.total ?? proj.length}</span></button>
      </div>
      <button type="button" class="btn icon" aria-label="Close pool" title="Close pool" ${UIAction('closeOverlays')}>${I.close}</button>
    </div>
    <div class="pool-capture" ${canWritePool?'':'hidden'}><div class="pool-capture-title"><input id="poolAdd" class="ctl" placeholder="Add an item" aria-label="Add pool item" maxlength="140" ${canWritePool?'':'hidden'} ${UIAction.on('keydown', 'poolKey', UIAction.event)}><button type="button" class="btn icon pool-capture-toggle" aria-label="Add description" title="Add description" aria-expanded="false" aria-controls="pool-capture-notes" ${UIAction('togglePoolDescription')}>${I.note}</button></div><div class="pool-capture-notes" id="pool-capture-notes" aria-hidden="true" inert><div><label for="poolNewDesc">Description ${optionalMark}</label><textarea id="poolNewDesc" class="ctl" maxlength="2000" placeholder="A little context for later…" ${UIAction.on('keydown', 'poolDescriptionKey', UIAction.event)}></textarea><div class="pool-description-actions"><button type="button" class="btn primary" ${UIAction('addPoolItem')}>Add item</button></div></div></div></div>
    <div class="pool-list" data-pool-scope="${UIEscape(state.poolTab)}">${rows}${poolLoadMoreHtml()}</div></div>`;
  } else if (m.type === 'knowledge') {
    body = window.OneloopKnowledge?.modalHtml() || '';
  } else if (m.type === 'confirm') {
    body = `<h2>${esc(m.title)}</h2><div class="sub">${esc(m.text)}</div>
    <div class="modal-actions"><button class="btn quiet" ${UIAction('closeOverlays')}>Cancel</button></div>`;
  }
  body = body.replace('<h2', '<h2 id="modal-title"');
  // The dialog's wrapper covers the backdrop, so a click beside the dialog does nothing.
  return `<div class="scrim"></div><div class="modal-wrap"><div class="modal${m.type === 'pool' ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">${body}</div></div>`;
}

// ---------- shell ----------
const roadmapStat = (label,value) => `<span class="roadmap-stat"><span>${label}</span><strong>${value}</strong></span>`;
function renderTopbar() {
  if (state.view === 'knowledge') return window.OneloopKnowledge?.topbar() || '<h1>Knowledge base</h1>';
  if (state.view === 'notfound') return awaitingServerTask() ? '<h1>Task</h1>' : '<h1>Page not found</h1>';
  if (state.view === 'no-projects') return '<h1>Projects</h1>';
  if (state.view === 'forbidden') return '<h1>Access denied</h1>';
  if (state.view === 'roadmap') {
    return `<h1>Roadmap</h1><div class="roadmap-meta" role="group" aria-label="Roadmap summary"><span class="roadmap-structure-stats">${roadmapStat('Tracks',tracks().length)}${roadmapStat('Epics',epics().length)}${roadmapStat('Milestones',milestones().length)}</span></div>
    <div class="right">
      ${roadmapScaleHtml()}
      <button class="btn quiet" ${UIAction('goToday')}>Today</button>
      ${canRoadmap() ? `<button class="btn roadmap-milestone" data-tip="Milestone" data-tip-overflow ${UIAction('openModal', 'milestone')}><span class="ms-diamond" style="border-color:var(--ink-muted)"></span><span class="btn-label">Milestone</span></button>
      <button class="btn primary" ${UIAction('openModal', 'epic')}>${I.plus} Epic</button>` : '<span class="read-only-pill">read only</span>'}
    </div>`;
  }
  if (state.view === 'board') {
    const applyBoard = applyBoardFilters;
    const epicOpts = (state.boardTracks.length ? epics().filter((e) => state.boardTracks.includes(e.trackId)) : epics()).slice().sort((a, b) => d(a.start) - d(b.start));
    const updateEpicFilter = () => {
      const choices = (state.boardTracks.length ? epics().filter(epic => state.boardTracks.includes(epic.trackId)) : epics()).slice().sort((a,b)=>d(a.start)-d(b.start));
      const allowed = new Set(choices.map(epic=>epic.id));
      state.boardEpics.splice(0,state.boardEpics.length,...state.boardEpics.filter(id=>allowed.has(id)));
      const def = MULTI.fEpic;
      if(def) { def.options=choices.map(epic=>({v:epic.id,l:epic.title})); const button=document.querySelector('[data-filter-key="fEpic"]');if(button){button.querySelector('.sel-label').textContent=def.summary();button.dataset.tip=def.summary();button.classList.toggle('empty',!state.boardEpics.length);} }
    };
    const mk = (key, arr, all, noun, options, extra) => multiHtml(key, Object.assign({
      options, search: options.length > 6,
      values: () => arr,
      toggle: (v) => { const i = arr.indexOf(v); if (i === -1) arr.push(v); else arr.splice(i, 1); if(key==='fTrack')updateEpicFilter(); applyBoard(); },
      clear: () => { arr.length = 0; if(key==='fTrack')updateEpicFilter(); applyBoard(); },
      summary: () => arr.length === 0 ? all : arr.length === 1 ? ((MULTI[key]?.options || options).find((o) => o.v === arr[0]) || {}).l || all : `${arr.length} ${noun}`,
    }, extra || {}));
    const meId = me().id;
    const assigneeOpts = [{ v: meId, l: me().name, sub: 'My tasks', pinned: true }, { v: NO_ASSIGNEE, l: 'No assignee', pinned: true }, ...projectMembers().filter((u) => u.id !== meId).map((u) => ({ v: u.id, l: u.name, sub: userHandle(u) }))];
    return `<h1>Board</h1>
    <div class="right board-filters">
      <input class="ctl" data-board-search style="width:170px" aria-label="Search tasks" placeholder="Search tasks" value="${esc(state.boardQ)}" ${UIAction.on('input', 'setBoardQ', UIAction.value, UIAction.event)} ${UIAction.on('keydown', 'boardSearchKey', UIAction.event)}>
      ${mk('fTrack', state.boardTracks, 'All tracks', 'tracks', tracks().map((t) => ({ v: t.id, l: t.name })), { width: 140 })}
      ${mk('fEpic', state.boardEpics, 'All epics', 'epics', epicOpts.map((e) => ({ v: e.id, l: e.title })), { search: true, width: 180 })}
      ${mk('fAssignee', state.boardAssignees, 'All assignees', 'assignees', assigneeOpts, { search: true, width: 150 })}
      <button class="btn blocked-filter" aria-pressed="${state.boardBlocked}" ${UIAction('setBlockedFilter', UIAction.element)}>${I.blocked}Blocked<span class="blocked-filter-count" title="Blocked tasks in this project">${D.projectTaskCounts?.[state.projectId]?.blocked ?? tasks().filter(t=>t.block && t.state!=='done').length}</span></button>
      <button class="btn quiet" ${UIAction('openModal', 'pool')}>Pool <span class="mono" data-pool-count style="font-size:var(--text-xs);color:var(--ink-ghost)">${Number.isFinite(D.poolPageInfo?.[`${state.projectId}:mine`]?.total)&&Number.isFinite(D.poolPageInfo?.[`${state.projectId}:project`]?.total)?D.poolPageInfo[`${state.projectId}:mine`].total+D.poolPageInfo[`${state.projectId}:project`].total:poolItems().length}</span></button>
      ${canBoard() ? `<button class="btn primary" ${UIAction('openModal', 'task')}>${I.plus} Task</button>` : '<span class="read-only-pill">read only</span>'}
    </div>`;
  }
  if (state.view === 'task') {
    const t = taskById(state.taskId);
    if (!t) return '<h1>Board</h1>';
    return `<button class="btn icon" ${UIAction('nav', 'board')} title="Back to Board" aria-label="Back to Board"><span aria-hidden="true">←</span></button>
    <h1 style="display:flex;align-items:center;gap:8px"><span class="mono">${esc(t.id)}</span></h1>
    ${taskStatusHtml(t)}<span class="task-save-status" role="status" aria-live="polite">${taskSaveFeedback?.id===t.id?taskSaveFeedback.saving?'Saving…':'Saved':''}</span>
    ${canBoard() ? `<div class="right"><button class="btn icon task-actions-button" aria-label="Task actions" title="Task actions" aria-controls="action-menu" aria-expanded="${!!state.menu?.taskActions}" ${UIAction('taskActions', UIAction.event, t.id)}>${I.kebab}</button></div>` : '<div class="right"><span class="read-only-pill">read only</span></div>'}`;
  }
  if (state.view === 'storage') return '<h1>Storage</h1><span class="meta">All projects</span>';
  if (state.view === 'inbox') return '<h1>Inbox</h1>';
  if (state.view === 'profile') return `<h1>Profile</h1><span class="meta">${esc(userHandle(me()))}</span>`;
  if (state.view === 'users') return `<h1>Users</h1><span class="meta users-count">${usersCountLabel()}</span><div class="right"><button class="btn primary" ${UIAction('openModal', 'user')}>${I.plus} New user</button></div>`;
  return `<h1>Settings</h1><span class="meta" data-tip="${esc(project().name)}" data-tip-overflow>${esc(project().name)}</span>`;
}

let paintedPage=null;
const pageScope=()=>JSON.stringify([D.session?.id,D.session?.userId,state.view,state.projectId,state.taskId]);
let rendering=false,paintedScope=null,backgroundRenderTimer=null,dialogPaintOwed=false,pressedTaskControl=false,pressedControlTimer=null;
const renderScope=()=>JSON.stringify([D.session?.id,D.session?.userId,location.hash,state.view,state.projectId,state.taskId,state.modal?.type,state.modal?.id,state.peek]);
// A render rebuilds an open dialog and loses its unsaved fields, so a change
// that arrives under one paints when that dialog closes.
function refreshAfterDialog(){
  if(state.modal){dialogPaintOwed=true;return;}
  render();
}
// Keep live metadata current without removing an active control or overlay.
function refreshBackground(){
  clearTimeout(backgroundRenderTimer);
  const authorized=D.session&&(!['task','board','roadmap','settings'].includes(state.view)||canReadProject(state.projectId))&&(!window.Recovery?.pageError);
  // WebKit may blur an editor without focusing the pressed button. Keep its
  // DOM target alive through pointer release/click, including slow presses.
  const busy=POP.el||state.modal||state.peek||pendingConfirmation||document.activeElement?.closest('.task-page,.peek,.modal')||pressedTaskControl;
  if(authorized&&busy&&!(state.view==='task'&&!canBoard()&&document.querySelector('.tp-title:not(:disabled):not([readonly])'))){backgroundRenderTimer=setTimeout(refreshBackground,100);return;}
  render();
}
// Snapshot immediately around the DOM swap, never across an awaited read.
function render(){
  clearTimeout(backgroundRenderTimer);dialogPaintOwed=false;
  if(!window.ONELOOP_DEFER_BOOT_RENDER)D.peopleVersion=(D.peopleVersion||0)+1;
  const scope=renderScope(),active=document.activeElement;
  const preserve=paintedScope===scope&&!window.Recovery?.pageError&&(!D.session||canReadProject(state.projectId)||['profile','users','inbox','storage'].includes(state.view));
  const focused=preserve&&active?.matches('input:not([type=file]),textarea')?{opener:rememberOpener(active),value:active.value,scrollTop:active.scrollTop}:null;
  // Text typed into a task field whose edit rights just ended stays as a Not saved draft.
  if(focused&&state.view==='task'&&!active.disabled&&!active.readOnly&&!canBoard()){
    const field=active.matches('.tp-title')?'title':active.id==='task-description'?'desc':null,t=taskById(state.taskId);
    if(field&&t)window.OneloopRuntime?.keepTaskDraft?.(t.id,field,active.value);
  }
  const focusedControl=preserve&&!focused&&active?.closest('#app')?rememberOpener(active):null;
  // The page heading and main area outlast any content render of the same page, such as
  // a loading skeleton during a slow read, so a keyboard user keeps their place.
  const landmark=active?.matches?.('.topbar h1')?'.topbar h1':active?.id==='main'?'#main':null,page=pageScope();
  const snapshot=focused?window.Recovery?.captureEditor?.():null;
  if(snapshot)snapshot.controls=snapshot.controls.filter(control=>control.key===snapshot.activeKey);
  rendering=true;
  try{
    renderContent();
    // An unanswered conflict prompt goes back beside its redrawn field before focus is restored.
    window.Recovery?.keepPrompts?.();
    const board=document.querySelector('.board');if(board)boardSnapshots.set(board,boardSnapshot());
    if(document.getElementById('rmScroll')&&document.querySelector('.content')?.clientHeight!==roadmapHeight)App.refreshRoadmap();
    if (paintedPage !== pageScope() && document.activeElement === document.body && !document.querySelector('.modal,.peek') && !document.getElementById('app').inert) {
      const target = document.querySelector('.topbar h1') || document.querySelector('.auth-card [autofocus]') || document.querySelector('.auth-card h1');
      target?.focus({preventScroll:true});
    }
    if(scope===renderScope()&&focused){
      if(snapshot)window.Recovery.restoreEditor(snapshot);
      restoreOpener(focused.opener);
      const target=document.activeElement;
      if(target?.matches('input,textarea')){target.value=focused.value;target.scrollTop=focused.scrollTop;if(focused.opener.selection)try{target.setSelectionRange(...focused.opener.selection);}catch{}}
    }
    if(focusedControl && document.activeElement===document.body)restoreOpener(focusedControl);
    if(landmark && document.activeElement===document.body && page===pageScope() && !document.querySelector('.modal,.peek'))document.querySelector(landmark)?.focus({preventScroll:true});
    const sidebar=document.querySelector('.sidebar');
    if(innerWidth<=900 && state.sideOpen && sidebar && !sidebar.inert && !sidebar.closest('[inert]') && document.activeElement===document.body)sidebar.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }finally{rendering=false;paintedScope=renderScope();paintedPage=pageScope();}
  window.Recovery?.resumeEditing?.();
}
function renderOverlays(){
  showWaitingPassword();
  const root=document.getElementById('overlay-root');
  if(!root||!D.session||!me()?.active){render();return;}
  const oldModalElement=/** @type {HTMLElement|null} */(root.querySelector('.modal')),oldPeekElement=/** @type {HTMLElement|null} */(root.querySelector('.peek')),oldFocus=document.activeElement;
  const focus={oldModal:!!oldModalElement,oldPeek:!!oldPeekElement,oldFocus,oldModalKey:oldModalElement?.dataset.motionKey,oldPeekKey:oldPeekElement?.dataset.motionKey,oldPanelFocus:(oldModalElement||oldPeekElement)?.contains(oldFocus)?rememberOpener(oldFocus):null};
  collaboration?.beforeRender({userId:me()?.id,projectId:state.projectId,view:state.view,taskId:state.taskId,modal:state.modal});
  const motion=prepareRenderMotion(true);hideEpicTip();closePop(true);
  const template=document.createElement('template');setHTML(template,`${state.peek?renderPeek():''}${renderModal()}${renderMenu()}`);
  // A modal over a drawer must retain that drawer's open editor and scroll.
  const nextPeek=template.content.querySelector('.peek');
  if(nextPeek&&oldPeekElement&&focus.oldPeekKey===state.peek)nextPeek.replaceWith(oldPeekElement);
  root.replaceChildren(template.content);
  document.getElementById('app').classList.toggle('side-open',!!state.sideOpen);
  document.querySelector('.switcher-btn')?.setAttribute('aria-expanded',String(!!state.menu?.projectMenu));
  document.querySelector('.me-chip')?.setAttribute('aria-expanded',String(!!state.menu?.version));
  mountDescription();collaboration?.mount();
  finishRenderMotion(motion,true);stampOverlays();if(state.menu)placeMenu();syncOverlayFocus(focus);
  paintedScope=renderScope();
}
function renderContent() {
  if(state.view!=='board'||!D.session)cancelBoardSearch();
  window.OneloopKnowledge?.beforeRender();
  const oldModalElement = document.querySelector('#overlay-root > .modal-wrap .modal');
  const oldPeekElement = document.querySelector('#overlay-root > .peek');
  const oldModal = !!oldModalElement, oldPeek = !!oldPeekElement;
  const oldFocus = document.activeElement;
  const oldModalKey = oldModalElement?.dataset.motionKey,oldPeekKey = oldPeekElement?.dataset.motionKey;
  const oldPanelFocus = (oldModalElement || oldPeekElement)?.contains(oldFocus) ? rememberOpener(oldFocus) : null;
  resetFieldIds();
  showWaitingPassword();
  if(state.modal?.type==='temppw'&&(!D.session||state.modal.ownerSession!==D.session.id||state.modal.ownerId!==me()?.id||!isAdmin()))state.modal=null;
  if(taskSaveFeedback&&(state.view!=='task'||state.taskId!==taskSaveFeedback.id||me()?.id!==taskSaveFeedback.owner))clearTaskSaved();
  today.setTime(instanceToday().getTime());
  if (pendingConfirmation && (pendingConfirmation.session !== D.session?.id || pendingConfirmation.hash !== location.hash || !D.session)) pendingConfirmation.close(false, false);
  window.Uploads?.validateAccess();
  collaboration?.beforeRender({userId:me()?.id,projectId:state.projectId,view:state.view,taskId:state.taskId,modal:state.modal});
  const renderMotion = prepareRenderMotion();
  clearFilterMotion();
  hideEpicTip();
  closePop(true);
  if (!D.session) { updateDocumentTitle();setHTML(document.getElementById('app'),renderAuth('login')); return; }
  if (me().mustChange) { updateDocumentTitle();setHTML(document.getElementById('app'),renderAuth('change')); return; }
  if(state.view==='task'&&!canReadTask(taskById(state.taskId))){state.view='forbidden';state.peek=null;state.modal=null;}
  if(state.peek&&!canReadProject(trackById(epicById(state.peek)?.trackId)?.projectId))state.peek=null;
  if(state.modal&&!canReadProject(state.projectId)&&!['user','project','temppw'].includes(state.modal.type))state.modal=null;
  if (!visibleProjects().find((p) => p.id === state.projectId)) state.projectId = (visibleProjects()[0] || {}).id;
  // The empty page keeps its address, so a first project returns to that page.
  if (state.view === 'no-projects' && project()) resolveRoute();
  if (['settings','users','storage'].includes(state.view) && !isAdmin()) state.view = 'forbidden';
  if(!project()&&['roadmap','board','knowledge','settings'].includes(state.view))state.view='no-projects';
  updateDocumentTitle();
  const c = counts();
  const p = project() || {name:'No projects'};
  const u = me();
  const error = window.Recovery?.pageError || (state.view === 'notfound' && !awaitingServerTask() ? '404' : state.view === 'forbidden' ? '403' : null);
  const view = state.view==='no-projects' ? `<div class="page-empty"><h2>No projects available</h2><p>${isAdmin()?'Create the first project to start planning work.':'Ask an admin to add you to a project.'}</p>${isAdmin()?`<button class="btn primary" ${UIAction('openModal', 'project')}>Create project</button>`:''}</div>` : error ? window.Recovery?.errorHtml(error) || `<div class="page-error"><h2>${error === '403' ? 'Access denied' : 'Page not found'}</h2><button class="btn quiet" ${UIAction('nav', 'board')}>Back to Board</button></div>` : awaitingServerTask() ? '<div class="pending-task-route" role="status" aria-label="Loading task"></div>' : state.view === 'knowledge' ? window.OneloopKnowledge?.render(state.projectId) || '' : state.view === 'roadmap' ? renderRoadmap() : state.view === 'board' ? renderBoard() : state.view === 'task' ? renderTask() : state.view === 'profile' ? renderProfile() : state.view === 'users' ? renderUsers() : state.view === 'inbox' ? collaboration?.inboxHtml() || '' : state.view === 'storage' ? `<div class="workspace-page storage-page">${window.Uploads?.storageHtml() || ''}</div>` : renderSettings();
  const appRoot = document.getElementById('app'), shell = document.createElement('template');
  setHTML(shell,`
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="side-scrim" ${UIAction('toggleSidebar', false)}></div>
    <nav class="sidebar" aria-label="Main navigation" ${window.innerWidth <= 900 && !state.sideOpen ? 'inert' : ''}>
      <div class="sidebar-brand has-inbox"><div class="logo" role="img" aria-label="oneloop">${I.logo}<span class="lbl">${I.wordmark}</span></div>${collaboration?.inboxNav(state.view) || ''}</div>
      <div class="switcher"><button class="switcher-btn btn" style="border-color:rgb(var(--tone-rgb) / 0.06)" ${!project()&&!isAdmin()?'disabled':''} ${UIAction('projectMenu', UIAction.event)} title="${esc(p.name)}" aria-label="Project: ${esc(p.name)}" aria-expanded="${!!state.menu?.projectMenu}" aria-controls="project-switcher-menu">
        <span class="project-identity"><span class="avatar">${esc(p.name[0].toUpperCase())}</span><span class="lbl project-name">${esc(p.name)}</span></span><span class="lbl project-chevron">${I.chev}</span></button></div>
      <div class="nav">
        <button class="nav-item ${state.view === 'roadmap' ? 'on' : ''}" ${state.view === 'roadmap' ? 'aria-current="page"' : ''} ${UIAction('nav', 'roadmap')} title="Roadmap">${I.roadmap}<span class="lbl">Roadmap</span></button>
        <button class="nav-item ${state.view === 'board' || state.view === 'task' ? 'on' : ''}" ${state.view === 'board' || state.view === 'task' ? 'aria-current="page"' : ''} ${UIAction('nav', 'board')} title="Board">${I.board}<span class="lbl">Board</span><span class="end lbl mono" style="font-size:var(--text-xs);color:var(--ink-ghost)">${c.open}</span></button>
        <button class="nav-item ${state.view === 'knowledge' ? 'on' : ''}" ${state.view === 'knowledge' ? 'aria-current="page"' : ''} ${UIAction('nav', 'knowledge')} title="Knowledge">${I.knowledge}<span class="lbl">Knowledge</span></button>
        ${isAdmin() ? `<button class="nav-item ${state.view === 'settings' ? 'on' : ''}" ${UIAction('nav', 'settings')} title="Settings">${I.settings}<span class="lbl">Settings</span></button>` : ''}
      </div>
      <div class="sidebar-bottom"><div class="profile-area"><button class="me-chip" ${UIAction('userMenu', UIAction.event)} title="${esc(u.name)}" aria-controls="action-menu" aria-expanded="${!!state.menu?.version}">${avatarHtml(u.id, 20)}
        <span class="lbl uname">${esc(u.name)}</span><span class="lbl profile-chevron">${I.chev}</span></button></div></div>
    </nav>
    <div class="main">
      <div class="page-header"><button type="button" class="btn icon menu-btn" aria-label="Toggle sidebar" aria-expanded="${window.innerWidth <= 900 ? !!state.sideOpen : !state.rail}">${I.menu}</button><header class="topbar${state.view === 'board' ? ' board-topbar' : ['settings','profile','users','inbox','storage'].includes(state.view) ? ' form-topbar'+(['inbox','storage'].includes(state.view)?' workspace-topbar':'') : ''}">${renderTopbar().replaceAll('<h1','<h1 tabindex="-1"')}</header></div>${window.Recovery?.connectionHtml() || ''}
      <main id="main" tabindex="-1" class="content${['settings','profile','users','inbox','storage'].includes(state.view) ? ' form-content'+(['inbox','storage'].includes(state.view)?' workspace-content':'') : ''}">${view}</main>

    </div>
    <div id="overlay-root" style="display:contents">${state.peek ? renderPeek() : ''}${renderModal()}${renderMenu()}</div>
    `);
  // Browsers drop a click when the pressed element leaves the document before
  // mouseup, even if it returns. So a render, such as the route-loading
  // indicator, must not detach an unchanged sidebar: replace only the nodes
  // around it, keeping its listeners and focus.
  const oldSidebar = appRoot.querySelector(':scope > .sidebar'), newSidebar = [...shell.content.children].find(node => node.classList.contains('sidebar'));
  const keptSidebar = !!oldSidebar && !!newSidebar && oldSidebar.isEqualNode(newSidebar);
  if (keptSidebar) {
    const nodes = [...shell.content.childNodes], at = nodes.indexOf(newSidebar);
    for (const node of [...appRoot.childNodes]) if (node !== oldSidebar) node.remove();
    oldSidebar.before(...nodes.slice(0, at));
    oldSidebar.after(...nodes.slice(at + 1));
  } else appRoot.replaceChildren(shell.content);

  document.querySelector('.skip-link')?.addEventListener('click', event => { event.preventDefault(); document.getElementById('main')?.focus(); });
  const appEl = document.getElementById('app');
  appEl.classList.toggle('side-open', !!state.sideOpen);
  appEl.classList.toggle('rail', !!state.rail);
  const mb = document.querySelector('.menu-btn');
  if (mb) mb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); App.toggleSidebar(); });
  if (TOUCH && !keptSidebar) {
    const sb = document.querySelector('.sidebar');
    if (sb) sb.addEventListener('click', (e) => {
      if (state.rail && window.innerWidth > 900 && !e.target.closest('.nav-item, .me-chip, .switcher-btn')) App.toggleSidebar(false);
    });
  }

  document.querySelectorAll('.timeline > [data-feed-key]').forEach(el=>feedRowMarkup.set(el,el.outerHTML));
  mountDescription();
  if (state.view === 'task') window.Uploads?.mount(state.taskId);
  if (state.view === 'roadmap' && !error) mountRoadmap();
  window.OneloopKnowledge?.mount();
  finishRenderMotion(renderMotion);
  stampOverlays();
  if (state.menu) placeMenu();
  collaboration?.mount();
  syncOverlayFocus({ oldModal, oldPeek, oldFocus, oldModalKey, oldPeekKey, oldPanelFocus });
}

// ---------- roadmap mount: scroll + zoom ----------
/**
 * The mounted Roadmap: what was rendered, the elements a zoom step moves,
 * and the calendar window currently in the DOM.
 * @typedef {{sc:HTMLElement,canvas:HTMLElement,axis:HTMLElement,model:any,layout:any,metrics:{barHeight:number,width:number,height:number},ppd:number,
 *   lanes:{lane:HTMLElement,bars:{el:HTMLElement,item:any}[]}[],goals:{goal:any,line:HTMLElement,connector:HTMLElement,label:HTMLElement}[],
 *   today:HTMLElement[],cells:{axis:HTMLElement,lines:HTMLElement,months:HTMLElement},calendar:{from:number,to:number,labels:string}|null,zoomLeft:number}} RoadmapView
 */
/** @returns {RoadmapView} */
function bindRoadmap(sc, rendered) {
  const all = (/** @type {string} */ selector) => /** @type {HTMLElement[]} */([...sc.querySelectorAll(selector)]);
  const lines = all('.rm-canvas > .ms-line'), connectors = all('.goal-connector'), labels = all('.ms-label');
  const laneEls = all('.lane');
  return {
    sc, canvas: sc.querySelector('.rm-canvas'), axis: sc.querySelector('.rm-axis'), ...rendered, ppd: rendered.layout.ppd, calendar: null, zoomLeft: NaN,
    lanes: rendered.model.lanes.map((lane, i) => {
      const bars = /** @type {HTMLElement[]} */([...(laneEls[i]?.querySelector('.lane-body')?.children || [])]);
      return { lane: laneEls[i], bars: lane.epics.map((item, j) => ({ el: bars[j], item })).filter((bar) => bar.el) };
    }),
    goals: rendered.model.goals.map((goal, i) => ({ goal, line: lines[i], connector: connectors[i], label: labels[i] })).filter((goal) => goal.line && goal.connector && goal.label),
    today: [sc.querySelector('.rm-canvas > .today-line'), sc.querySelector('.today-connector'), sc.querySelector('.today-pill')],
    cells: { axis: sc.querySelector('.rm-calendar-axis'), lines: sc.querySelector('.rm-calendar-lines'), months: sc.querySelector('.rm-month-grid') },
  };
}

/** Apply a zoom level's rows and heights, writing only what changed. */
function applyRoadmapLayout(view, next) {
  const prev = view.layout, { barHeight } = view.metrics;
  if (next.axisHeight !== prev.axisHeight) {
    const top = `${next.axisHeight}px`;
    view.axis.style.height = top;
    for (const el of [...view.goals.map((goal) => goal.line), view.today[0]]) if (el) el.style.top = top;
    view.cells.lines?.style.setProperty('--rm-axis-h', top);
  }
  view.goals.forEach(({ connector, label }, i) => {
    const row = next.goalRows[i];
    if (row === prev.goalRows[i]) return;
    connector.style.top = `${12 + row * GOAL_ROW + 54}px`;
    label.style.top = `${12 + row * GOAL_ROW}px`;
  });
  next.lanes.forEach((lane, i) => {
    const before = prev.lanes[i], bound = view.lanes[i];
    if (!bound?.lane) return;
    if (lane.height !== before.height) bound.lane.style.height = `${lane.height}px`;
    bound.bars.forEach((bar, j) => { if (lane.pad !== before.pad || lane.rows[j] !== before.rows[j]) bar.el.style.top = barTop(lane, lane.rows[j], barHeight); });
  });
  view.layout = next;
}

/**
 * One zoom step: move and size the mounted elements for `ppd`, move the
 * rows that the new widths change, and keep `day` at `cx` pixels from the
 * scroller's left edge. Only the positioned elements change, so the browser
 * restyles those and not the text inside them.
 */
function zoomRoadmap(view, ppd, day, cx) {
  const { sc, model } = view;
  if (ppd !== view.ppd) {
    view.ppd = state.pxPerDay = ppd;
    view.canvas.style.width = `${RAIL + dayX(model.span, ppd)}px`;
    for (const lane of view.lanes) for (const { el, item } of lane.bars) {
      el.style.left = barLeft(item, ppd);
      if (item.to !== null) el.style.width = barWidth(item, ppd);
    }
    const timeline = timelineWidth(model, ppd, view.metrics.width);
    for (const { goal, line, connector, label } of view.goals) {
      const x = dayX(goal.at, ppd);
      line.style.left = `${RAIL + x}px`;
      connector.style.left = `${x}px`;
      label.style.left = goalCenter(goal, ppd, timeline);
    }
    const [line, connector, pill] = view.today, todayX = dayX(model.today, ppd);
    if (line) line.style.left = `${RAIL + todayX}px`;
    for (const el of [connector, pill]) if (el) el.style.left = `${todayX}px`;
    for (const el of Object.values(view.cells)) el?.style.setProperty('--ppd', String(ppd));
    applyRoadmapLayout(view, roadmapLayout(model, ppd, view.metrics));
    syncRoadmapScale();
  }
  const left = Math.max(0, RAIL + day * ppd - cx);
  if (Math.abs(sc.scrollLeft - left) >= 0.5) sc.scrollLeft = left;
  state.rmScrollLeft = view.zoomLeft = sc.scrollLeft;
  mountRoadmapCalendar(view);
}

/** The scale the header shows as pressed; after a free zoom, none. */
let pressedScale = null;
function roadmapScaleHtml() {
  pressedScale = roadmapScale()?.key ?? null;
  return `<div class="seg roadmap-scale" role="group" aria-label="Timeline scale">${ROADMAP_SCALES.map((scale) => `<button type="button" data-scale="${UIEscape(scale.key)}" class="${pressedScale === scale.key ? 'on' : ''}" aria-pressed="${pressedScale === scale.key}" aria-keyshortcuts="${UIEscape(scale.shortcut)}" ${UIAction('setRoadmapScale', scale.key)}>${scale.label}</button>`).join('')}</div>`;
}
function syncRoadmapScale() {
  const current = roadmapScale()?.key ?? null;
  if (current === pressedScale) return;
  pressedScale = current;
  document.querySelectorAll('.roadmap-scale [data-scale]').forEach((button) => {
    const on = button.dataset.scale === current;
    button.setAttribute('aria-pressed', String(on)); button.classList.toggle('on', on);
  });
}

/** The selected epic's bar while it shows in the view, or null. */
function selectedEpicBar(view) {
  const found = roadmapSelection && view.lanes.flatMap((lane) => lane.bars).find((bar) => bar.el.dataset.epic === roadmapSelection);
  if (!found?.el.isConnected) return null;
  const box = found.el.getBoundingClientRect(), port = view.sc.getBoundingClientRect();
  const shows = box.right > port.left + RAIL && box.left < port.right && box.bottom > port.top + view.layout.axisHeight && box.top < port.bottom - MONTH_ROW;
  return shows ? found : null;
}
/**
 * What a scale change keeps in place: the selected epic while it shows,
 * else today while it shows, else the date in the middle of the view.
 * An epic that fits the view keeps its middle, moved into the view if
 * needed; a wider one keeps its start when that shows, and otherwise the
 * middle of the part that shows. Returns the day and its distance from the
 * scroller's left edge.
 */
function scaleAnchor(view, ppd) {
  const { sc, model } = view, width = sc.clientWidth, room = width - RAIL;
  const x = (day) => RAIL + day * view.ppd - sc.scrollLeft;
  const margin = Math.min(80, room / 4), inside = (cx) => Math.min(Math.max(cx, RAIL + margin), width - margin);
  const selected = selectedEpicBar(view);
  if (selected) {
    const { from, to } = selected.item;
    if (to !== null && (to - from) * ppd <= room) return { day: (from + to) / 2, cx: inside(x((from + to) / 2)) };
    if (x(from) >= RAIL) return { day: from, cx: x(from) };
    const shown = (Math.max(from, sc.scrollLeft / view.ppd) + Math.min(to ?? model.span, (sc.scrollLeft + room) / view.ppd)) / 2;
    return { day: shown, cx: x(shown) };
  }
  const today = x(model.today);
  if (today >= RAIL && today <= width) return { day: model.today, cx: today };
  const cx = RAIL + room / 2;
  return { day: (sc.scrollLeft + cx - RAIL) / view.ppd, cx };
}

const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', month:'short' });
/**
 * Month labels and lines cover the visible dates plus one view of overscan
 * each way, so the DOM stays bounded at every zoom level. From WEEK_AXIS_PPD,
 * weeks get lines too, and the bottom row labels each week with its Monday's
 * date instead of each month. The cells follow --ppd, so this redraws them
 * only when the view nears the window's edge, the window becomes much wider
 * than needed or passes the end of the range, a partial month at either end
 * gains or loses its label, or the axis changes between months and weeks.
 */
function mountRoadmapCalendar(view) {
  const { sc, model, ppd } = view, start = model.start, width = sc.clientWidth || window.innerWidth;
  const end = Math.max(model.span, (view.metrics.width - RAIL) / ppd);
  const day = (/** @type {Date} */ dt) => (dt - start) / DAY;
  const labeled = (/** @type {number} */ from, /** @type {number} */ to) => Math.round(to * ppd) - Math.round(from * ppd) > 46;
  const weeks = ppd >= WEEK_AXIS_PPD;
  const startMonth = new Date(start); startMonth.setUTCDate(1); startMonth.setUTCMonth(startMonth.getUTCMonth() + 1);
  const endMonth = new Date(+start + end * DAY); endMonth.setUTCDate(1); endMonth.setUTCHours(0, 0, 0, 0);
  const labels = `${weeks}:${labeled(0, Math.min(day(startMonth), end))}:${labeled(Math.max(day(endMonth), 0), end)}`;
  const margin = width / 2 / ppd;
  const need = { from: Math.max(0, sc.scrollLeft / ppd - margin), to: Math.min(end, (sc.scrollLeft + width - RAIL) / ppd + margin) };
  const shown = view.calendar;
  if (shown && shown.from <= need.from && shown.to >= need.to && shown.to <= end && shown.to - shown.from <= 4 * (width + RAIL) / ppd + 62 && shown.labels === labels) return;
  const first = new Date(+start + Math.max(0, (sc.scrollLeft - width - RAIL) / ppd) * DAY);
  first.setUTCDate(1); first.setUTCHours(0, 0, 0, 0);
  const last = Math.min(end, (sc.scrollLeft + width * 2) / ppd);
  let months = '', seps = '', axisSeps = '', covered = Math.max(0, day(first));
  for (const m = new Date(first); day(m) < last; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const next = new Date(m); next.setUTCMonth(next.getUTCMonth() + 1);
    const from = Math.max(day(m), 0), to = Math.min(day(next), end);
    const label = monthFormatter.format(m) + (m.getUTCMonth() === 0 || +m === +first ? ' ' + String(m.getUTCFullYear()).slice(2) : '');
    if (!weeks && labeled(from, to)) months += `<div class="rm-month" style="--d:${from};--n:${to - from}">${label}</div>`;
    if (day(next) < end) {
      seps += `<div class="rm-month-line" aria-hidden="true" style="--d:${day(next)}"></div>`;
      axisSeps += `<div class="rm-axis-divider" aria-hidden="true" style="--d:${day(next)}"></div>`;
    }
    covered = to;
  }
  // Each week starts on a Monday, labeled with its date and, outside this year, the year.
  let weekSeps = '';
  if (weeks) for (const monday = new Date(+first + ((8 - first.getUTCDay()) % 7) * DAY); day(monday) < Math.min(last, end); monday.setUTCDate(monday.getUTCDate() + 7)) {
    const at = day(monday);
    if (at <= 0) continue;
    if (monday.getUTCDate() !== 1) seps += `<div class="rm-week-line" aria-hidden="true" style="--d:${at}"></div>`;
    weekSeps += `<div class="rm-axis-divider" aria-hidden="true" style="--d:${at}"></div>`;
    months += `<div class="rm-week" style="--d:${at}">${humanShort(monday)}</div>`;
  }
  view.calendar = { from: Math.max(0, day(first)), to: covered, labels };
  setHTML(view.cells.axis, axisSeps);
  setHTML(view.cells.lines, seps);
  setHTML(view.cells.months, (weeks ? weekSeps : axisSeps) + months);
}

let roadmapGestureCleanup = () => {};
/** @type {(RoadmapView & {zoomTo:(ppd:number)=>void})|null} The Roadmap on the page, which a scale change zooms. */
let mountedRoadmap = null;
function mountRoadmap() {
  roadmapGestureCleanup();
  const sc = /** @type {HTMLElement|null} */(document.getElementById('rmScroll'));
  if (!sc || !renderedRoadmap) return;
  const view = Object.assign(bindRoadmap(sc, renderedRoadmap), { zoomTo: (/** @type {number} */ _ppd) => {} });
  mountedRoadmap = view;
  sc.addEventListener('focusin', (event) => { const bar = /** @type {Element} */(event.target).closest?.('[data-epic]'); if (bar) roadmapSelection = bar.dataset.epic; });
  if (state.rmScrollLeft === null) state.rmScrollLeft = Math.max(RAIL + view.model.today * view.ppd - sc.clientWidth * 0.42, 0);
  sc.scrollLeft = state.rmScrollLeft;
  sc.scrollTop = state.rmScrollTop;
  mountRoadmapCalendar(view);
  /** @type {{kind:'wheel'|'pinch'|'gesture',left:number,cx:number,day:number,ppd0:number,log:number,target:number|null,distance:number,cy:number,dy:number}|null} The zoom gesture in progress. */
  let gesture = null;
  let calendarFrame = 0;
  sc.addEventListener('scroll', () => {
    state.rmScrollLeft = sc.scrollLeft; state.rmScrollTop = sc.scrollTop;
    // A scroll the zoom did not make, such as a touchpad pan during a
    // pinch, moves the content under the pointer: zoom around that day now.
    if (gesture && Math.abs(sc.scrollLeft - view.zoomLeft) > 1) { gesture.day = (sc.scrollLeft + gesture.cx - RAIL) / view.ppd; view.zoomLeft = sc.scrollLeft; }
    if (!calendarFrame) calendarFrame = requestAnimationFrame(() => {
      calendarFrame = 0;
      if (sc.isConnected) mountRoadmapCalendar(view);
    });
  });
  const sample = sc.querySelector('.bar');
  /** @type {number|null} */ let sizeFrame = null;
  const sizeObserver = typeof ResizeObserver === 'undefined' || !sample ? null : new ResizeObserver(() => {
    if(sizeFrame===null && sc.isConnected && Math.ceil(sample.getBoundingClientRect().height)!==Number(sc.dataset.barHeight)){
      sizeFrame=requestAnimationFrame(()=>{sizeFrame=null;if(sc.isConnected)App.refreshRoadmap();});
    }
  });
  if(sample)sizeObserver?.observe(sample);

  // Zoom: input events update one gesture, and one frame applies it. A
  // gesture keeps the day under the pointer, or under the pinch center as it
  // moves, in place.
  let frame = 0, pointerX = NaN;
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let idle;
  const begin = (/** @type {'wheel'|'pinch'|'gesture'} */ kind, /** @type {number} */ clientX, left = sc.getBoundingClientRect().left) => {
    stopScale(false);
    hideEpicTip();
    const cx = clientX - left;
    view.zoomLeft = sc.scrollLeft;
    gesture = { kind, left, cx, day: (view.zoomLeft + cx - RAIL) / view.ppd, ppd0: view.ppd, log: 0, target: null, distance: 0, cy: 0, dy: 0 };
    return gesture;
  };
  const step = () => {
    frame = 0;
    const current = gesture;
    if (!current || !sc.isConnected) return;
    const ppd = clampZoom(current.target ?? view.ppd * Math.exp(current.log));
    current.log = 0;
    zoomRoadmap(view, ppd, current.day, current.cx);
    if (current.dy) { sc.scrollTop -= current.dy; current.dy = 0; }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(step); };
  function end() {
    clearTimeout(idle);
    if (frame) { cancelAnimationFrame(frame); step(); }
    gesture = null;
    sc.removeEventListener('touchmove', movePinch);
  }
  sc.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (gesture && gesture.kind !== 'wheel') return;
    const current = gesture || begin('wheel', e.clientX), cx = e.clientX - current.left;
    // A pointer that moved between events zooms around the day now under it.
    if (cx !== current.cx) { current.day = (sc.scrollLeft + cx - RAIL) / view.ppd; current.cx = cx; }
    current.log += wheelZoom(e);
    schedule();
    clearTimeout(idle); idle = setTimeout(end, 120);
  }, {passive:false});
  const center = (/** @type {TouchList} */ touches) => ({ x:(touches[0].clientX + touches[1].clientX) / 2, y:(touches[0].clientY + touches[1].clientY) / 2 });
  const spread = (/** @type {TouchList} */ touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  function movePinch(/** @type {TouchEvent} */ e) {
    if (gesture?.kind !== 'pinch' || e.touches.length !== 2) return;
    e.preventDefault();
    const point = center(e.touches);
    gesture.target = gesture.ppd0 * spread(e.touches) / gesture.distance;
    gesture.cx = point.x - gesture.left;
    gesture.dy += point.y - gesture.cy; gesture.cy = point.y;
    schedule();
  }
  sc.addEventListener('touchstart', e => {
    if (e.touches.length !== 2 || !spread(e.touches) || gesture?.kind === 'pinch') return;
    if (gesture) end();
    const point = center(e.touches), current = begin('pinch', point.x);
    current.distance = spread(e.touches); current.cy = point.y;
    sc.addEventListener('touchmove', movePinch, {passive:false});
  }, {passive:true});
  const endPinch = (/** @type {TouchEvent} */ e) => { if (gesture?.kind === 'pinch' && e.touches.length < 2) end(); };
  sc.addEventListener('touchend', endPinch, {passive:true});
  sc.addEventListener('touchcancel', endPinch, {passive:true});
  // Safari reports a touchpad pinch as gesture events, not ctrl+wheel. On
  // touch screens, touch events already drive the pinch.
  sc.addEventListener('pointermove', e => { pointerX = e.clientX; }, {passive:true});
  const pinchGesture = (/** @type {Event & {scale?:number,clientX?:number}} */ e) => {
    e.preventDefault();
    if (gesture?.kind === 'pinch') return;
    if (e.type === 'gesturestart') {
      if (gesture) end();
      const left = sc.getBoundingClientRect().left;
      begin('gesture', Number.isFinite(e.clientX) ? e.clientX : Number.isFinite(pointerX) ? pointerX : left + sc.clientWidth / 2, left);
      return;
    }
    if (gesture?.kind !== 'gesture') return;
    if (Number.isFinite(e.scale) && e.scale > 0) gesture.target = gesture.ppd0 * e.scale;
    if (Number.isFinite(e.clientX)) gesture.cx = e.clientX - gesture.left;
    schedule();
    if (e.type === 'gestureend') end();
  };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) sc.addEventListener(type, pinchGesture);

  // A scale change eases to its zoom in place, over a few frames like the
  // other short motions; a wheel or pinch takes over from wherever it is.
  /** @type {{ppd:number,day:number,cx:number,from:number,started:number|null}|null} */ let scaled = null;
  let scaleFrame = 0;
  function stopScale(finish = true) {
    if (scaleFrame) cancelAnimationFrame(scaleFrame);
    scaleFrame = 0;
    if (finish && scaled && sc.isConnected) zoomRoadmap(view, scaled.ppd, scaled.day, scaled.cx);
    scaled = null;
  }
  const stepScale = (/** @type {number} */ time) => {
    scaleFrame = 0;
    if (!scaled || !sc.isConnected) return;
    scaled.started ??= time - 1000 / 60;
    const progress = Math.min(1, (time - scaled.started) / MOTION.normal), eased = 1 - (1 - progress) ** 3;
    zoomRoadmap(view, progress < 1 ? clampZoom(scaled.from * Math.exp(Math.log(scaled.ppd / scaled.from) * eased)) : scaled.ppd, scaled.day, scaled.cx);
    if (progress < 1) scaleFrame = requestAnimationFrame(stepScale); else scaled = null;
  };
  view.zoomTo = (ppd) => {
    if (gesture) end();
    stopScale();
    hideEpicTip();
    const { day, cx } = scaleAnchor(view, ppd);
    if (reducedMotion.matches || Math.abs(ppd - view.ppd) < 1e-3) { zoomRoadmap(view, ppd, day, cx); return; }
    scaled = { ppd, day, cx, from: view.ppd, started: null };
    scaleFrame = requestAnimationFrame(stepScale);
  };
  roadmapGestureCleanup = () => {
    if(calendarFrame)cancelAnimationFrame(calendarFrame);
    sizeObserver?.disconnect();if(sizeFrame!==null)cancelAnimationFrame(sizeFrame);sizeFrame=null;
    clearTimeout(idle); if (frame) cancelAnimationFrame(frame);
    frame = 0; gesture = null; sc.removeEventListener('touchmove', movePinch);
    stopScale();
    if (mountedRoadmap === view) mountedRoadmap = null;
  };
}
function settleCard(card, from) {
  if (!card || !from || reducedMotion.matches) return;
  const to = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.removeAttribute('data-task');
  ghost.removeAttribute('data-reorderable');
  ghost.classList.remove('dragging');
  ghost.classList.add('drag-settle');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px`;
  document.body.appendChild(ghost);
  card.classList.add('settling');
  const animation = ghost.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(1.025)`, opacity: 0.9 },
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
  ], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  const cleanup = () => { ghost.remove(); card.classList.remove('settling'); };
  animation.finished.then(cleanup, cleanup);
}

function refreshEpicSummary() {
  if (!state.peek) return;
  const old = document.querySelector('[data-epic-throughput]');
  if (!old) return;
  const template = document.createElement('template'); setHTML(template,renderPeek());
  const next = template.content.querySelector('[data-epic-throughput]');
  if (next) old.replaceWith(next);
}

// ---------- actions ----------
Object.assign(App, {
  /** Production compatibility boundary. New modules must not reach private state directly. */
  context() { return { view:state.view, taskId:state.taskId, projectId:state.projectId, poolTab:state.poolTab, peek:state.peek, board:{trackIds:[...state.boardTracks],epicIds:[...state.boardEpics],assigneeIds:[...state.boardAssignees],search:state.boardQ,blocked:state.boardBlocked}, modal:state.modal ? { ...state.modal } : null }; },
  updateDocumentTitle,
  refreshCounts() {
    const badge=document.querySelector('.sidebar .nav-item[title="Board"] .end');
    const open=String(counts().open);if(badge&&badge.textContent!==open)badge.textContent=open;
    const blocked=document.querySelector('.blocked-filter-count');
    const blockedCount=String(D.projectTaskCounts?.[state.projectId]?.blocked??tasks().filter(task=>task.block&&task.state!=='done').length);
    if(blocked&&blocked.textContent!==blockedCount)blocked.textContent=blockedCount;
    const mine=D.poolPageInfo?.[`${state.projectId}:mine`]?.total,team=D.poolPageInfo?.[`${state.projectId}:project`]?.total;
    const poolTotal=Number.isFinite(mine)&&Number.isFinite(team)?mine+team:poolItems().length;
    document.querySelectorAll('[data-pool-count]').forEach(el=>{if(el.textContent!==String(poolTotal))el.textContent=String(poolTotal);});
  },
  refreshEpic() {
    if (!state.peek) return;
    const peek=document.querySelector('#overlay-root > .peek'),rows=peek?.querySelector('.peek-rows');
    if (!rows) return;
    const template=document.createElement('template');setHTML(template,renderPeek());
    const next=template.content.querySelector('.peek-rows');
    if (!next) return;
    const total=peek.querySelector('[data-epic-task-total]'),nextTotal=template.content.querySelector('[data-epic-task-total]');
    if(total&&nextTotal)total.textContent=nextTotal.textContent;
    const focus=rows.contains(document.activeElement)?rememberOpener(document.activeElement):null;
    const peekScroll=peek.scrollTop,rowsScroll=rows.scrollTop;
    rows.replaceWith(next);peek.scrollTop=peekScroll;next.scrollTop=rowsScroll;
    if (focus && !peek.inert && !document.querySelector('.confirmation-layer,.file-overlay')) restoreOpener(focus);
  },
  refreshPool: updatePool,
  refreshProfileAccess,
  refreshUsers({loadingOnly=false}={}) {
    if (loadingOnly) {
      document.querySelector(state.view==='settings'?'.member-access-list':'.content .settings')?.setAttribute('aria-busy', String(!!D.adminUsers?.loading));
      document.querySelectorAll('[data-more-users]').forEach(button=>button.disabled=!!D.adminUsers?.loading);
      return;
    }
    if (state.view === 'settings') {
      const settings = document.querySelector('.settings-wide');
      const section = settings?.querySelectorAll(':scope > .section')[1];
      if (!section) return;
      const focus = section.contains(document.activeElement) ? rememberOpener(document.activeElement) : null;
      closePop(true);
      const template = document.createElement('template'); setHTML(template,renderSettings());
      section.replaceWith(template.content.querySelectorAll('.section')[1]);
      if (focus) restoreOpener(focus);
      return;
    }
    if (state.view !== 'users') return;
    const content = document.querySelector('.content'), count = document.querySelector('.users-count');
    if (!content) return;
    const scroll = content.scrollTop, focus = document.activeElement, userId = focus?.matches?.('.user-row') ? focus.dataset.userId : null;
    setHTML(content,renderUsers()); content.scrollTop = scroll;
    if (count) count.textContent = usersCountLabel();
    if (userId) [...content.querySelectorAll('.user-row')].find(el => el.dataset.userId === userId)?.focus({preventScroll:true});
  },
  validateFormDates,
  /**
   * Show each title and description field's draft, or its saved value once
   * the draft is gone (such as after Use latest), with its Not saved note.
   * The field being edited keeps what the person is typing.
   */
  refreshTaskDrafts(id) {
    if (state.view !== 'task' || state.taskId !== id) return;
    const t = taskById(id); if (!t) return;
    for (const [field, selector, control] of [['title', '.task-title-field', '.tp-title'], ['desc', '.task-description', '#task-description']]) {
      const host = document.querySelector(`.task-page ${selector}`); if (!host) continue;
      const input = host.querySelector(control), value = taskDraft(t, field)?.value ?? (field === 'title' ? t.title : t.desc ?? '');
      if (input && input !== document.activeElement && input.value !== value) { input.value = value; if (field === 'title') sizeTaskTitle(); else sizeDescription(); }
      host.querySelector('[data-draft-note]')?.remove();
      const template = document.createElement('template'); setHTML(template, taskDraftNote(t, field));
      host.append(template.content);
    }
  },
  /**
   * Show the saved status, block and deadline of the open task around its
   * fields: the header chip and badge, the Status icon, Block task and
   * Overdue. A field save draws the page again only once focus leaves it.
   */
  refreshTaskHeader() {
    const t = state.view === 'task' ? taskById(state.taskId) : null, page = document.querySelector('.task-page');
    if (!t || !page) return;
    // Only these pieces: rendering the whole page again would register its
    // fields anew, and a save still in flight would no longer find its field.
    const html = (source) => { const next = document.createElement('template'); setHTML(next, source); return next.content; };
    const topbar = document.querySelector('.topbar');
    topbar?.querySelector('.blocked-badge')?.remove();
    topbar?.querySelector('.task-status-chip')?.replaceWith(html(taskStatusHtml(t)));
    const heading = page.querySelector('.task-properties-heading');
    if (heading && !heading.contains(document.activeElement)) heading.replaceWith(html(taskPropertiesHeadingHtml(t, canBoard())));
    page.querySelector('#select-tpState > svg')?.replaceWith(html(stIcon(t.state)));
    const late = overdue(t);
    page.querySelector('.task-property-date')?.classList.toggle('late', late);
    page.querySelector('.task-overdue')?.toggleAttribute('hidden', !late);
  },
  noteTaskSaving: taskSaving,
  clearTaskSaving,
  retryTaskActivity(id){collaboration?.retryTaskPage?.(id);},
  followAddress,
  fieldError: failField,
  selectProject(id) { if(!visibleProjects().some(project=>project.id===id))return;const leaveTask=state.view==='task'&&state.projectId!==id;state.projectId=id;state.rmScrollLeft=null;state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;if(leaveTask){state.view='board';state.taskId=null;setLocalHash('#/board');}if(state.view==='knowledge'){window.OneloopKnowledge?.route('knowledge',id);setLocalHash('#/knowledge');}render(); },
  // A drop animates its own card; it passes { animate: false } so the refresh does not move it again.
  refreshBoard(options) { applyBoardFilters(false,true,options); App.refreshCounts(); },
  refreshRoadmap() {
    refreshEpicSummary();
    if(state.view!=='roadmap'){App.refreshBackground();return;}
    const content=document.querySelector('.content'),scroll=document.getElementById('rmScroll');
    if(!content||!scroll){App.refresh();return;}
    roadmapGestureCleanup();
    const before=motionRects('.lane'),left=scroll.scrollLeft,top=scroll.scrollTop;
    const focus=document.activeElement,focusType=focus?.dataset?.epic?'epic':focus?.dataset?.milestone?'milestone':null,focusId=focusType?focus.dataset[focusType]:null;
    setHTML(content,renderRoadmap());mountRoadmap();
    const next=document.getElementById('rmScroll');if(next){next.scrollLeft=left;next.scrollTop=top;}
    if(focusId){const equivalent=[...content.querySelectorAll(`[data-${focusType}]`)].find(el=>el.dataset[focusType]===focusId);(equivalent||document.querySelector('.topbar button'))?.focus({preventScroll:true});}
    App.updateDocumentTitle();
    if(before)animateLayout(before,'.lane');
    App.refreshCounts();
  },
  acceptMoreBoard(col) {
    state.boardLimits[col]=(state.boardLimits[col]||50)+50;
    const board=document.querySelector('.board'),column=board?.querySelector(`[data-col="${UIEscape(col)}"]`),list=column?.querySelector('.col-cards');
    if(!list||state.view!=='board')return;
    const ids=new Set([...list.querySelectorAll(/** @type {'div'} */('[data-task]'))].map(card=>card.dataset.task));
    const template=document.createElement('template');setHTML(template,renderBoard({column:col,excludeIds:ids}));
    const next=template.content.querySelector('.col-cards'),more=list.querySelector('.board-load-more');
    for(const card of next.querySelectorAll('.card')){list.insertBefore(card,more);UIMotion.enter(card);}
    if(list.querySelector('.card'))list.querySelector('.empty-note')?.remove();
    const nextMore=next.querySelector('.board-load-more');
    if(!nextMore){const focused=more?.contains(document.activeElement);more?.remove();if(focused)list.querySelector(/** @type {'button'} */('.card:last-of-type .title'))?.focus({preventScroll:true});}
    else if(!more)list.append(nextMore);
    column.querySelector('.col-head .mono').textContent=template.content.querySelector('.col-head .mono').textContent;
    boardSnapshots.set(board,boardSnapshot());
  },
  acceptMoreUsers() { if(state.view==='settings'){App.refreshUsers();return;}state.usersLimit+=50;render(); },
  nav(v) { window.Recovery?.clearPageError(); state.view = v; state.menu = null; state.peek = null; state.modal = null; state.sideOpen = false; if (v === 'knowledge') window.OneloopKnowledge?.route(v, state.projectId); setLocalHash('#/' + v); render(); },
  require(permission) {
    if (hasPermission(permission)) return true;
    App.toast(`${permission === 'manage_roadmap' ? 'Roadmap' : 'Board'}: read only`, 'info');
    return false;
  },
  toggleSidebar(force) {
    // The shell binds only click, which covers pointer and keyboard activation.
    const appEl = document.getElementById('app');
    if (window.innerWidth <= 900) {
      // phone: a drawer under the top bar; the same button opens and closes it
      state.sideOpen = typeof force === 'boolean' ? force : !state.sideOpen;
      appEl.classList.toggle('side-open', state.sideOpen);
      syncSidebar();
      (state.sideOpen ? document.querySelector('.sidebar button:not(:disabled)') : document.querySelector('.menu-btn'))?.focus({preventScroll:true});
      return;
    }
    // desktop: full sidebar or icon rail, remembered
    state.rail = typeof force === 'boolean' ? force : !state.rail;
    appEl.classList.toggle('rail', state.rail);
    document.querySelector('.menu-btn').setAttribute('aria-expanded', String(!state.rail));
    try { localStorage.setItem('oneloop.sidebar', state.rail ? 'rail' : 'full'); } catch {}
  },
  /** What Sign out asks, which says when typed text would be lost. */
  signOutText() {
    return window.Recovery?.hasUnsavedInput?.() ? 'End your current browser session. Text you typed and have not saved will be lost.' : 'End your current browser session.';
  },
  chooseAvatar() { document.getElementById('avIn')?.click(); },
  userMenu(ev) {
    const r = ev.currentTarget.getBoundingClientRect();
    App._openMenu([
      { theme: true },
      ...(window.Recovery?.setAutoReload ? [{ autoReload: true }] : []),
      { sep: true },
      { label: 'Profile', icon: I.person, fn: () => App.nav('profile') },
      ...(isAdmin() ? [{ label: 'Users', icon: I.users, fn: () => App.nav('users') },{ label: 'Storage', icon: I.storage, fn: () => App.nav('storage') }] : []),
      { sep: true },
      { label: 'Sign out', icon: I.signOut, danger: true, fn: () => App.logout() },
    ], r.left, r.top, { version: true, above: true, trigger:ev.currentTarget });
  },
  setTheme(value) { window.Theme.set(value); },
  toggleAutoReload() {
    window.Recovery?.setAutoReload?.(!window.Recovery?.autoReload);
    App.autoReloadChanged();
  },
  /** Show Reload after updates as it is now, also after another tab changed it. */
  autoReloadChanged() {
    const on = !!window.Recovery?.autoReload, button = document.querySelector('[data-auto-reload]');
    if (!button || button.getAttribute('aria-pressed') === String(on)) return;
    button.setAttribute('aria-pressed', String(on));
    setHTML(button.querySelector('.menu-check'), on ? I.tick : '');
  },
  clearTaskSaved,
  noteTaskSaved:taskSaved,
  sizeDescription,
  sizeDescriptionEditors,
  sizeTaskTitle,
  /** Enter leaves a field that saves itself when it loses focus, and types nothing. */
  leaveField(event, field) { event.preventDefault(); field.blur(); },
  expandDescription() {
    const section = document.querySelector('.task-description');
    if (section) expandedDescriptions.add(section.dataset.descriptionKey);
    sizeDescription(true);
  },
  toggleDescription(button) {
    const section = button?.closest('.expandable-description') || document.querySelector('.task-description');
    if (!section) return;
    const id = section.dataset.descriptionKey;
    if (expandedDescriptions.has(id)) expandedDescriptions.delete(id);
    else expandedDescriptions.add(id);
    sizeDescription(true);
  },

  openTask(id) { const target=taskById(id),track=trackById(epicById(target?.epicId)?.trackId);if(!target||!track)return;if(!canReadTask(target)){state.view='forbidden';state.peek=null;state.modal=null;render();return;}state.projectId=track.projectId;state.sideOpen = false; state.view = 'task'; state.taskId = id; state.menu = null; setLocalHash('#/task/' + id); render(); },
  popMulti(ev, key) {
    ev.preventDefault();
    if (POP.id === 'ms:' + key) { closePop(); return; }
    const def = MULTI[key];
    const btn = ev.currentTarget;
    const el = openPop(btn, Math.max(btn.getBoundingClientRect().width, 220));
    POP.id = 'ms:' + key;
    el.id='multi-'+key;POP.trigger=btn;btn.setAttribute('aria-expanded','true');btn.setAttribute('aria-controls',el.id);
    POP.onClose = def.onClose || null;
    let q = '';
    const row = (o) => `<button type="button" class="pop-opt multi${def.values().includes(o.v) ? ' on' : ''}" aria-pressed="${def.values().includes(o.v)}" data-v="${esc(o.v)}">
        <span class="chk">${def.values().includes(o.v) ? I.tick : ''}</span>
        <span style="display:flex;flex-direction:column;min-width:0"><span class="l">${esc(o.l)}</span>${o.sub ? `<span class="s">${esc(o.sub)}</span>` : ''}</span></button>`;
    const paint = () => {
      const opts = q ? def.options.filter((o) => o.l.toLowerCase().includes(q) || (o.sub || '').toLowerCase().includes(q)) : def.options;
      const pinned = opts.filter((o) => o.pinned), rest = opts.filter((o) => !o.pinned);
      const list = el.querySelector('.pop-list');
      setHTML(list,(pinned.length ? pinned.map(row).join('') + '<div class="pop-sep"></div>' : '') + rest.map(row).join('') || '<div class="pop-empty">No matches</div>');
      const foot = el.querySelector('.pop-foot');
      if (foot) foot.style.display = def.values().length && def.clear ? '' : 'none';
      [...list.querySelectorAll('.pop-opt')].forEach((oel) => oel.addEventListener('click', () => {
        const focused=document.activeElement===oel,value=oel.dataset.v;def.toggle(value);
        btn.querySelector('.sel-label').textContent = def.summary(); btn.dataset.tip = def.summary();
        btn.classList.toggle('empty', !def.values().length);
        paint();if(focused)[...list.querySelectorAll('.pop-opt')].find(option=>option.dataset.v===value)?.focus({preventScroll:true});
      }));
      placePop(btn);
    };
    setHTML(el,`${def.search ? '<div class="pop-search-wrap"><input class="pop-search" type="text" placeholder="Search options" spellcheck="false"></div>' : ''}<div class="pop-list"></div>${def.clear ? '<div class="pop-foot"><button type="button" class="btn quiet">Clear</button></div>' : ''}`);
    paint();
    requestAnimationFrame(() => { if (POP.el === el) placePop(btn); });
    const input = el.querySelector('.pop-search');
    if (input) { input.focus(); input.addEventListener('input', () => { q = input.value.trim().toLowerCase(); paint(); }); }
    const foot = el.querySelector('.pop-foot button');
    if (foot) foot.addEventListener('click', () => { def.clear(); btn.querySelector('.sel-label').textContent = def.summary(); btn.dataset.tip = def.summary(); btn.classList.add('empty'); paint(); });
    POP.onKey = (e) => {
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePop();btn.focus({preventScroll:true});}
      else if(e.key==='Tab')closePop();
      else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const rows=[...el.querySelectorAll('.pop-opt')],index=rows.indexOf(document.activeElement),next=index<0?(e.key==='ArrowDown'?0:rows.length-1):Math.max(0,Math.min(rows.length-1,index+(e.key==='ArrowDown'?1:-1)));rows[next]?.focus();}
      else if((e.key==='Enter'||e.key===' ')&&document.activeElement?.matches('.pop-opt.multi')&&el.contains(document.activeElement)){e.preventDefault();document.activeElement.click();}
    };
    document.addEventListener('keydown', POP.onKey, true);
  },
  setBlockedFilter(button){state.boardBlocked=!state.boardBlocked;button?.setAttribute('aria-pressed',String(state.boardBlocked));applyBoardFilters();},
  /** Zoom the Roadmap to a fixed scale, in place, keeping the selected epic or today where it is. */
  setRoadmapScale(key) {
    const scale = ROADMAP_SCALES.find((item) => item.key === key);
    if (!scale) return;
    if (state.view === 'roadmap' && mountedRoadmap?.sc.isConnected) { mountedRoadmap.zoomTo(scale.ppd); return; }
    state.pxPerDay = scale.ppd; syncRoadmapScale();
  },
  goToday() {
    const sc = document.getElementById('rmScroll');
    const { start } = rmRange();
    state.rmScrollLeft = Math.max(RAIL + (today - start) / DAY * state.pxPerDay - (sc ? sc.clientWidth : 900) * 0.42, 0);
    // Scroll the mounted Roadmap in place; rebuilding the page would only repeat it.
    if (sc && state.view === 'roadmap' && Number(sc.dataset.rangeStart) === +start) sc.scrollLeft = state.rmScrollLeft;
    else App.refresh();
  },
  epicHover(ev, id, keyboard = false, kind = 'epic') {
    if (!keyboard && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    hideEpicTip();
    const anchor = ev.currentTarget;
    const show = kind === 'milestone' ? showMilestoneTip : showEpicTip;
    if (keyboard) show(anchor, id);
    else EPIC_TIP.showTimer = setTimeout(() => show(anchor, id), 220);
  },
  milestoneHover(ev, id, keyboard = false) { App.epicHover(ev, id, keyboard, 'milestone'); },
  milestoneClick(ev, id) {
    if (canRoadmap()) App.openModal('milestone', id);
    else showMilestoneTip(ev.currentTarget, id);
  },
  roadmapTipKey(ev) {
    const tip = EPIC_TIP.el;
    if (!tip || EPIC_TIP.anchor !== ev.currentTarget) return;
    const distance = { ArrowDown:40, ArrowUp:-40, PageDown:tip.clientHeight*.8, PageUp:-tip.clientHeight*.8 }[ev.key];
    if (distance !== undefined) { ev.preventDefault(); tip.scrollTop += distance; }
  },
  epicLeave() {
    clearTimeout(EPIC_TIP.showTimer); clearTimeout(EPIC_TIP.hideTimer);
    EPIC_TIP.hideTimer = setTimeout(hideEpicTip, 140);
  },
  epicKey(ev, id) {
    App.roadmapTipKey(ev);
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); App.openPeek(id); }
  },
  openPeek(id) { if(!canReadProject(trackById(epicById(id)?.trackId)?.projectId)){App.toast('This project is unavailable','error');return;}if (state.peek !== id) peekOpened(); state.peek = id; roadmapSelection = id; App.refreshOverlays(); },
  closeOverlays() { if (state.menu&&!state.modal&&!state.peek){dismissMenu();return;}if (state.modal?.poolId) { App.returnToPool(); return; } state.peek = state.peek && state.modal ? state.peek : null; state.modal = null; state.menu = null; if (dialogPaintOwed) render(); else renderOverlays(); },
  toast: pushToast,
  offerUndo,
  announce,
  dismissToast,

  // menus
  projectMenu(ev) {
    const r = ev.currentTarget.getBoundingClientRect();
    const items = visibleProjects().map((p) => ({ label: p.name, projectId:p.id, projectName:p.name, fn: () => invoke('workspace.select',{projectId:p.id}) }));
    if (isAdmin()) items.push({ sep: true }, { label: 'New project', icon:I.plus, fn: () => { state.modal = { type: 'project' }; renderOverlays(); } });
    App._openMenu(items, r.left, r.bottom + 6, { projectMenu: true, trigger:ev.currentTarget });
  },
  trackMenu(ev, id) {
    ev.stopPropagation();
    if (!App.require('manage_roadmap')) return;
    const list = tracks(), index = list.findIndex(track=>track.id===id);
    const moves = [];
    if (index > 0) moves.push({label:'Move up',fn:()=>App.moveTrack(id,index-1)}, {label:'Move to top',fn:()=>App.moveTrack(id,0)});
    if (index < list.length-1) moves.push({label:'Move down',fn:()=>App.moveTrack(id,index+1)}, {label:'Move to bottom',fn:()=>App.moveTrack(id,list.length-1)});
    App._openMenu([
      ...moves, ...(moves.length ? [{sep:true}] : []),
      { label: 'Rename track', fn: () => { state.modal = { type: 'track', id }; App.refreshOverlays(); } },
      { sep: true },
      { label: 'Delete track', danger: true, fn: () => App.deleteTrack(id) },
    ], 0, 0, {trigger:ev.currentTarget, trackId:id});
  },

  /** Enter saves a project field, then leaves it. */
  leaveProjectField(event, input) { event.preventDefault(); App.updateProjectField(input); input.blur(); },

  // Drag destinations and mutations retain their existing behavior.
  _ind() { return document.getElementById('dropInd'); },
  _mkInd(absolute) {
    let el = App._ind();
    if (!el) { el = document.createElement('div'); el.id = 'dropInd'; el.className = 'drop-ind'; }
    el.style.cssText = absolute ? 'position:absolute;left:0;right:0;margin:0;z-index:8' : '';
    el.classList.toggle('track-ind', absolute);
    return el;
  },
  dragEnd(animate = true) {
    const before = animate ? motionRects('.card[data-task]') : null;
    App._dropBefore = null; App._dropColumn = null; App._laneBefore = null;
    App._drag = null;
    App._dragPreview?.remove(); App._dragPreview = null;
    const ind = App._ind(); if (ind) ind.remove();
    document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    document.querySelectorAll('.col.drop').forEach((el) => el.classList.remove('drop'));
    document.body.classList.remove('is-dragging');
    if (before) animateLayout(before, '.card[data-task]');
  },
  _dragImage(ev, source, compact = false) {
    const image = source.cloneNode(true);
    image.removeAttribute('data-task'); image.removeAttribute('data-track');
    image.removeAttribute('data-reorderable'); image.setAttribute('aria-hidden', 'true'); image.inert = true;
    image.classList.add('drag-preview');
    const r = source.getBoundingClientRect();
    image.style.cssText = `position:fixed;left:-10000px;top:0;width:${compact ? 240 : r.width}px;height:auto;`;
    if (compact) image.querySelectorAll('.head-ctl').forEach((el) => el.remove());
    document.body.appendChild(image);
    App._dragPreview = image;
    ev.dataTransfer.setDragImage(image, compact ? 24 : ev.clientX - r.left, compact ? 20 : ev.clientY - r.top);
  },
  taskDragStart(ev, id) {
    clearFilterMotion();
    if (!App.require('manage_board')) { ev.preventDefault(); return; }
    if (App._boardMovePending) { ev.preventDefault(); return; }
    App.dragEnd(false);
    ev.dataTransfer.setData('text/task', id);
    ev.dataTransfer.effectAllowed = 'move';
    const card = ev.currentTarget;
    const r = card.getBoundingClientRect();
    App._drag = { kind: 'task', id, offsetX: ev.clientX - r.left, offsetY: ev.clientY - r.top };
    App._dragImage(ev, card);
    document.body.classList.add('is-dragging');
    requestAnimationFrame(() => { if (App._drag?.id === id) card.classList.add('dragging'); });
  },
  colOver(ev) {
    if (!canBoard() || App._drag?.kind !== 'task') return;
    if (!ev.dataTransfer.types.includes('text/task')) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
    const colEl = ev.currentTarget;
    const list = colEl.querySelector('.col-cards');
    const ind = App._ind();
    // Don't oscillate when the pointer is inside the insertion gap itself.
    if (ind?.parentNode === list) {
      const r = ind.getBoundingClientRect();
      if (ev.clientY >= r.top - 4 && ev.clientY <= r.bottom + 4) return;
    }
    const cards = [...colEl.querySelectorAll('.card:not(.dragging)')];
    const next = colEl.dataset.col === 'done' && doneNewest() ? cards[0] : cards.find((c) => {
      // Hit-test the final layout, not a sibling's in-flight transform.
      const y = list.getBoundingClientRect().top + c.offsetTop - list.scrollTop;
      return ev.clientY < y + c.offsetHeight / 2;
    });
    const beforeId = next ? next.dataset.task : null;
    if (App._dropColumn === colEl.dataset.col && App._dropBefore === beforeId && ind?.parentNode === list) return;
    const before = motionRects('.card[data-task]');
    document.querySelectorAll('.col.drop').forEach((el) => { if (el !== colEl) el.classList.remove('drop'); });
    colEl.classList.add('drop');
    App._dropColumn = colEl.dataset.col;
    App._dropBefore = beforeId;
    const marker = App._mkInd(false);
    if (next) list.insertBefore(marker, next); else list.appendChild(marker);
    animateLayout(before, '.card[data-task]', App._drag.id);
  },
  colLeave(ev) {
    if (ev.currentTarget.contains(ev.relatedTarget)) return;
    ev.currentTarget.classList.remove('drop');
    if (App._ind()?.parentNode === ev.currentTarget.querySelector('.col-cards')) {
      const before = motionRects('.card[data-task]');
      App._ind().remove(); App._dropColumn = null; App._dropBefore = null;
      animateLayout(before, '.card[data-task]', App._drag?.id);
    }
  },
  dropTask(ev, col) {
    if(window.Recovery?.blockDrag()){ev.preventDefault();App.dragEnd();return;}
    if (!App.require('manage_board')) return;
    if (App._boardMovePending) { ev.preventDefault(); App.dragEnd(); return; }
    if (!ev.dataTransfer.types.includes('text/task') || App._drag?.kind !== 'task') return;
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/task');
    const beforeId = App._dropBefore;
    const t = taskById(id);
    if (!t || id === beforeId) { App.dragEnd(); return; }
    if(t.block && col==='done'){App.dragEnd();App.openModal('completeBlocked',id);return;}
    const before=motionRects('.card[data-task]'),from={left:ev.clientX-App._drag.offsetX,top:ev.clientY-App._drag.offsetY};
    const scrolls=[...document.querySelectorAll('.col-cards')].map((el)=>[el.closest('.col').dataset.col,el.scrollTop]);
    const boardLeft=document.querySelector('.board').scrollLeft,change=applyTaskMove(t,col,beforeId);
    App.dragEnd(false);if(!change)return;
    App.refreshBoard({animate:false});document.querySelector('.board').scrollLeft=boardLeft;
    scrolls.forEach(([key,top])=>{const list=document.querySelector(`[data-col="${UIEscape(key)}"] .col-cards`);if(list)list.scrollTop=top;});
    animateLayout(before,'.card[data-task]',id);settleCard(document.querySelector(`[data-task="${UIEscape(id)}"]`),from);
    submitTaskMove(change,()=>{const rollbackBefore=motionRects('.card[data-task]');App.refreshBoard({animate:false});animateLayout(rollbackBefore,'.card[data-task]');});
  },

  trackDragStart(ev, id) {
    if (!App.require('manage_roadmap')) { ev.preventDefault(); return; }
    if (App._roadmapMovePending) { ev.preventDefault(); return; }
    App.dragEnd(false);
    ev.dataTransfer.setData('text/track', id);
    ev.dataTransfer.effectAllowed = 'move';
    const lane = ev.target.closest('.lane');
    App._drag = { kind: 'track', id };
    App._dragImage(ev, lane.querySelector('.lane-head'), true);
    document.body.classList.add('is-dragging');
    requestAnimationFrame(() => { if (App._drag?.id === id) lane.classList.add('dragging'); });
  },
  laneOver(ev) {
    if (!canRoadmap() || App._drag?.kind !== 'track') return;
    if (!ev.dataTransfer.types.includes('text/track')) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
    const lane = ev.currentTarget;
    const r = lane.getBoundingClientRect();
    App._laneBefore = ev.clientY < r.top + r.height / 2;
    const ind = App._mkInd(true);
    ind.style.top = (lane.offsetTop + (App._laneBefore ? -2 : lane.offsetHeight - 1)) + 'px';
    lane.parentNode.appendChild(ind);
  },
  trackDrop(ev, targetId) {
    if (!App.require('manage_roadmap')) return;
    if (App._roadmapMovePending) { ev.preventDefault(); App.dragEnd(); return; }
    if (!ev.dataTransfer.types.includes('text/track') || App._drag?.kind !== 'track') return;
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/track');
    const beforeTarget = App._laneBefore;
    App.dragEnd(false);
    if (!id || id === targetId) return;
    const list = tracks().filter(track=>track.id!==id);
    const index = list.findIndex(track=>track.id===targetId);
    if (index < 0) return;
    App.moveTrack(id, index + (beforeTarget ? 0 : 1));
  },
  trackReorderKey(event, id) {
    const delta = {ArrowUp:-1,ArrowDown:1}[event.key];
    if (!delta || event.isComposing) return;
    event.preventDefault(); App.moveTrack(id, tracks().findIndex(track=>track.id===id) + delta);
  },
  moveTrack(id, position) {
    if (!App.require('manage_roadmap') || App._roadmapMovePending) return;
    const list = tracks(), index = list.findIndex(track=>track.id===id);
    if (index < 0) return;
    const to = Math.max(0, Math.min(list.length-1, position));
    if (to === index) return;
    const before = motionRects('.lane');
    const original=[...list],originalOrders=new Map(original.map((item)=>[item,item.order]));
    const moved = list.splice(index, 1)[0];
    list.splice(to, 0, moved);
    list.forEach((t, i) => { t.order = i; });
    App.refresh();
    focusMovedTrack(id);
    animateLayout(before, '.lane');
    const pending={};App._roadmapMovePending=pending;const revision=moved.revision,projectId=moved.projectId,sessionKey=`${D.session?.id||''}:${D.session?.userId||''}`,optimisticOrders=new Map(original.map((item)=>[item,item.order]));
    window.OneloopRuntime.invoke('track.reorder',{trackId:id,position:to,optimistic:true}).catch((error)=>{
      const sameSession=sessionKey===`${D.session?.id||''}:${D.session?.userId||''}`;
      if(!error?.uncertain&&sameSession&&D.tracks.includes(moved)&&moved.revision===revision){for(const [item,order] of originalOrders)if(D.tracks.includes(item)&&item.order===optimisticOrders.get(item))item.order=order;if(state.view==='roadmap'&&state.projectId===projectId){const rollbackBefore=motionRects('.lane');App.refresh();animateLayout(rollbackBefore,'.lane');}}
      window.OneloopRuntime.report(error);
    }).finally(()=>{if(App._roadmapMovePending===pending)App._roadmapMovePending=false;});
  },

  taskActions(ev,id) {
    if(!canBoard()||!taskById(id))return;
    const r=ev.currentTarget.getBoundingClientRect();
    App._openMenu([{label:'Delete task',danger:true,fn:()=>App.deleteTask(id)}],r.right,r.bottom+4,{taskActions:true,trigger:ev.currentTarget});
  },

  togglePoolDescription(){const capture=document.querySelector('.pool-capture');if(!capture||capture.hidden)return;const open=!capture.classList.contains('is-expanded');if(!open){resetPoolCapture();document.getElementById('poolAdd').focus();return;}capture.classList.add('is-expanded');const content=capture.querySelector('.pool-capture-notes');content.inert=false;content.setAttribute('aria-hidden','false');const toggle=capture.querySelector('.pool-capture-toggle');toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Remove description');toggle.title='Remove description';setHTML(toggle,I.close);document.getElementById('poolNewDesc').focus();},
  addPoolItem(){const input=document.getElementById('poolAdd');if(input&&!input.hidden)App.poolKey({key:'Enter',target:input,preventDefault(){}});},
  poolDescriptionKey(ev,id){
    if(ev.defaultPrevented||ev.isComposing||ev.keyCode===229)return;
    if(ev.key==='Enter'&&ev.repeat){ev.preventDefault();return;}
    if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();if(id)App.cancelPoolDescription(id);else {resetPoolCapture();document.getElementById('poolAdd').focus();}return;}
    if(ev.key==='Enter'&&!ev.shiftKey&&!ev.altKey){ev.preventDefault();if(id){const form=ev.currentTarget.closest('form');if(form)App.savePoolDescription({target:form,preventDefault(){}},id);}else App.addPoolItem();}
  },
  editPoolDescription(ev,id){ev.stopPropagation();const item=poolItems(state.poolTab).find(p=>p.id===id),row=ev.currentTarget.closest('[data-pool-item]');if(!item||!row)return;const existing=row.querySelector('.pool-description-editor');if(existing){App.cancelPoolDescription(id);return;}document.querySelectorAll('.pool-description-editor').forEach(el=>App.cancelPoolDescription(el.closest('[data-pool-item]').dataset.poolItem,false));const writable=item.scope==='mine'?item.ownerId===me()?.id:canBoard(),editor=document.createElement('div');editor.className='pool-description-editor';const before=row.getBoundingClientRect().height;setHTML(editor,writable?`<form novalidate ${UIAction.on('submit','savePoolDescription',UIAction.event,id)}><label for="pool-desc-${UIEscape(id)}">Description ${optionalMark}</label><textarea class="ctl" id="pool-desc-${UIEscape(id)}" name="desc" maxlength="2000" ${UIAction.on('keydown','poolDescriptionKey',UIAction.event,id)} placeholder="A little context for later…">${esc(item.desc||'')}</textarea><div class="pool-description-actions"><button type="button" class="btn quiet" ${UIAction('cancelPoolDescription',id)}>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`:`<div class="pool-note-read" tabindex="-1" role="group" aria-label="Description for ${esc(item.title)}">${esc(item.desc||'')}</div>`);row.append(editor);const reader=editor.querySelector('.pool-note-read');if(reader&&reader.scrollHeight>reader.clientHeight)reader.setAttribute('tabindex','0');ev.currentTarget.setAttribute('aria-expanded','true');UIMotion.height(row,before);editor.querySelector('textarea,.pool-note-read')?.focus({preventScroll:true});},
  cancelPoolDescription(id,focus=true){const row=document.querySelector(`[data-pool-item="${UIEscape(id)}"]`);if(!row)return;const before=row.getBoundingClientRect().height;row.querySelector('.pool-description-editor')?.remove();const toggle=row.querySelector('.pool-note-toggle');toggle?.setAttribute('aria-expanded','false');UIMotion.height(row,before);if(focus)toggle?.focus({preventScroll:true});},
  promotePool(id) {
    if (!App.require('manage_board')) return;
    const item = poolItems(state.poolTab).find((x) => x.id === id);
    const view = document.querySelector('.pool-view');
    if (!item || !view) return;
    (App._poolScroll ||= {})[state.poolTab] = view.querySelector('.pool-list').scrollTop;
    document.querySelectorAll('.pool-description-editor').forEach(el=>App.cancelPoolDescription(el.closest('[data-pool-item]').dataset.poolItem,false));resetPoolCapture();document.getElementById('poolAdd').value='';
    state.modal = { type: 'task', poolId: id, title: item.title, desc:item.desc||'' };
    stampOverlays();
    view.hidden = true;
    const editor = document.createElement('div');
    editor.className = 'pool-editor';
    setHTML(editor,taskModalHtml(state.modal));
    view.parentElement.appendChild(editor);
    mountDescription();
    fadeContent(editor);
    editor.querySelector('[name="title"]').focus();
  },
  returnToPool() {
    closePop(true);
    document.querySelector('.pool-editor')?.remove();
    const view = document.querySelector('.pool-view');
    if (!view) return;
    state.modal = { type: 'pool' };
    stampOverlays();
    view.hidden = false;
    updatePool();
    view.querySelector('.pool-list').scrollTop = App._poolScroll?.[state.poolTab] || 0;
    fadeContent(view);
    view.querySelector('#poolAdd')?.focus();
  },
  setPoolTab(k) {
    if (!['mine', 'project'].includes(k) || k === state.poolTab) return;
    const list = document.querySelector('.pool-list');
    (App._poolScroll ||= {})[state.poolTab] = list.scrollTop;
    state.poolTab = k;
    updatePool();
    list.scrollTop = App._poolScroll[k] || 0;
    invoke('pool.select',{scope:k});
  },
  loadMorePool(){invoke('pool.more',{scope:state.poolTab});},

  // popover components
  popSelect(ev, key) {
    ev.preventDefault();
    if (POP.id === 'sel:' + key) { closePop(); return; }
    const def = SELS[key];
    const btn = ev.currentTarget;
    const hid = btn.parentNode.querySelector('input[type="hidden"]');
    const cur = hid ? hid.value : def.value;
    const searchable = def.search || def.options.length > 7;
    const el = openPop(btn);
    POP.id = 'sel:' + key;POP.trigger=btn;btn.setAttribute('aria-expanded','true');btn.setAttribute('aria-controls',`select-${key}-list`);
    setHTML(el,`${searchable ? '<div class="pop-search-wrap"><input class="pop-search" type="text" placeholder="Search options" spellcheck="false"></div>' : ''}<div class="pop-list"></div>`);
    const listEl = el.querySelector('.pop-list');
    const input = el.querySelector('.pop-search');
    listEl.id=`select-${key}-list`;listEl.setAttribute('role','listbox');listEl.setAttribute('aria-labelledby',btn.id);
    const focusOwner=input||listEl;focusOwner.tabIndex=0;
    if(input){input.setAttribute('role','combobox');input.setAttribute('aria-label',btn.textContent.trim());input.setAttribute('aria-expanded','true');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',listEl.id);}
    let q = '', filtered = def.options, idx = -1;

    const pick = (o) => {
      const returnFocus = rememberOpener(btn);
      closePop();
      if (hid) hid.value = o.v;
      def.value = o.v;
      btn.classList.toggle('empty', o.v === '' || o.v == null);
      btn.querySelector('.sel-label').textContent = o.l; btn.dataset.tip = o.l;
      clearFieldError(btn);
      if (def.pick) def.pick(o.v);
      restoreOpener(returnFocus);
    };
    const setIdx = (i) => {
      idx = i;
      [...listEl.children].forEach((oel, j) => oel.classList && oel.classList.toggle('focus', j === i));
      const f = listEl.children[i];if(f)focusOwner.setAttribute('aria-activedescendant',f.id);else focusOwner.removeAttribute('aria-activedescendant'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
    };
    const paintList = () => {
      filtered = q ? def.options.filter((o) => o.l.toLowerCase().includes(q)) : def.options;
      setHTML(listEl,filtered.length
        ? filtered.map((o,i) => `<button type="button" role="option" tabindex="-1" id="select-${UIEscape(key)}-option-${UIEscape(i)}" aria-selected="${o.v === cur}" class="pop-opt${o.v === cur ? ' on' : ''}"><span class="option-label">${o.icon || ''}<span>${esc(o.l)}</span></span>${o.v === cur ? I.tick : ''}</button>`).join('')
        : '<div class="pop-empty">No matches</div>');
      [...listEl.querySelectorAll('.pop-opt')].forEach((oel, i) => {
        oel.addEventListener('click', () => pick(filtered[i]));
        oel.addEventListener('mousemove', () => idx !== i && setIdx(i));
      });
      const curIdx = filtered.findIndex((o) => o.v === cur);
      setIdx(curIdx >= 0 ? curIdx : (filtered.length ? 0 : -1));
      placePop(btn);
    };
    paintList();
    if(!input)listEl.focus();
    requestAnimationFrame(() => { if (POP.el === el) placePop(btn); });
    if (input) {
      input.focus();
      input.addEventListener('input', () => { q = input.value.trim().toLowerCase(); paintList(); });
    }
    POP.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); restoreOpener(rememberOpener(btn)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (filtered.length) setIdx(Math.min(idx + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (filtered.length) setIdx(Math.max(idx - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (idx >= 0 && filtered[idx]) pick(filtered[idx]); }
      else if (e.key === 'Tab') { closePop(); if (btn.isConnected) btn.focus({preventScroll:true}); }
    };
    document.addEventListener('keydown', POP.onKey, true);
  },
  dateTyping(key) {
    const wrap = document.querySelector(`[data-date-key="${UIEscape(key)}"]`);
    if (wrap) { normalizeInput(wrap.querySelector('.date-text')); dateFieldError(wrap, ''); }
  },
  dateBlur(ev, key) {
    if(App.isRendering())return;
    if (POP.id === 'dp:' + key) return;
    commitDate(key, ev.target.value);
  },
  dateKey(ev, key) {
    if (ev.isComposing||ev.keyCode===229) return;
    if(ev.key==='Enter'&&ev.repeat){ev.preventDefault();return;}
    if (ev.key === 'Enter') { ev.preventDefault(); commitDate(key, ev.target.value, true); }
    else if (ev.key === 'Escape') {
      // Escape closes the calendar or undoes the typing first; with nothing to undo, it goes on to the dialog.
      const undoes = POP.id === 'dp:' + key || ev.target.value !== (DPS[key].value || '');
      closePop(true);
      ev.target.value = DPS[key].value || ''; ev.target.removeAttribute('data-unsaved');
      dateFieldError(ev.target.closest('.date-field'), '');
      if (undoes) { ev.preventDefault(); ev.stopPropagation(); }
    } else if (ev.key === 'ArrowDown' && ev.altKey) {
      ev.preventDefault(); ev.target.closest('.date-field').querySelector('.date-trigger').click();
    }
  },
  popDate(ev, key) {
    ev.preventDefault();
    const def = DPS[key];
    if (!def || def.disabled) return;
    const btn = ev.currentTarget, wrap = btn.closest('.date-field'), input = wrap.querySelector('.date-text');
    if (POP.id === 'dp:' + key) { closePop(true); input.focus(); return; }
    const enteredDate = parseDateInput(input.value);
    let focusDate = enteredDate || def.value || iso(today);
    let view = focusDate.slice(0, 7);
    const el = openPop(wrap.querySelector('.date-control'), 262);
    POP.id = 'dp:' + key; POP.dateTrigger = btn;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', input.getAttribute('aria-label') + ' calendar');
    btn.setAttribute('aria-expanded', 'true');
    POP.onClose = () => { if (input.isConnected) commitDate(key, input.value); };
    const pick = (ds) => {
      if (!commitDate(key, ds)) return;
      closePop(); input.focus();
    };
    const paint = (focus = false) => {
      const changedMonth=el.dataset.month&&el.dataset.month!==view;el.dataset.month=view;
      setHTML(el,calHtml(view, enteredDate === null ? def.value : enteredDate, focusDate, def));
      placePop(wrap.querySelector('.date-control'));if(changedMonth)fadeContent(el.querySelector('.cal-grid'));
      el.querySelectorAll('.cal-d').forEach((b) => b.addEventListener('click', () => pick(b.dataset.d)));
      el.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
        const target = d(view + '-01'); target.setUTCMonth(target.getUTCMonth() + Number(b.dataset.nav));
        if (target.getUTCFullYear() < 1 || target.getUTCFullYear() > 9999) return;
        view = iso(target).slice(0, 7); focusDate = iso(target); paint(true);
      }));
      el.querySelector('[data-today]').addEventListener('click', () => pick(iso(today)));
      const clear = el.querySelector('[data-clear]'); if (clear) clear.addEventListener('click', () => pick(''));
      if (focus) (el.querySelector(`.cal-d[data-d="${UIEscape(focusDate)}"]:not(:disabled)`) || el.querySelector('.cal-d:not(:disabled)') || el.querySelector('[data-nav]')).focus();
    };
    paint(true);
    POP.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(true); input.focus(); return; }
      if (e.key === 'Tab') { closePop(); input.focus(); return; }
      if (!el.contains(e.target) || !e.target.matches('.cal-d')) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (step) {
        e.preventDefault(); const next = d(e.target.dataset.d); next.setUTCDate(next.getUTCDate() + step);
        const candidate = parseDateInput(iso(next));
        if (!candidate || dateError(def, candidate)) return;
        focusDate = candidate; view = focusDate.slice(0, 7); paint(true);
      }
    };
    document.addEventListener('keydown', POP.onKey, true);
  },

  refresh: render,
  /** Draw the dialog, drawer and menu again, and leave the page as it is. */
  refreshOverlays: renderOverlays,
  refreshBackground,
  refreshAfterDialog,
  isRendering:()=>rendering,
  clearBoardFilters(){cancelBoardSearch();state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;state.boardLimits={planning:50,progress:50,review:50,done:50};invoke('board.filter',App.context().board);},
  retryPool(){invoke('pool.select',{scope:state.poolTab});},
  toggleDoneOrder(){invoke('board.doneOrder',{order:doneNewest()?'manual':'completed'});},
  loadMoreBoard(col){invoke('board.more',{status:col});},
  taskMoveMenu(event,id){
    event.stopPropagation(); // The card around the button would open the task.
    if(App._boardMovePending)return;
    if(!canBoard())return;const task=taskById(id),list=boardTasks().filter(t=>t.state===task.state),index=list.indexOf(task),r=event.currentTarget.getBoundingClientRect();
    const items=COLS.filter(c=>c.key!==task.state).map(c=>({label:'Move to '+c.name,fn:()=>{if(canBoard()){if(setTaskState(task,c.key)!==false){App.refresh();focusMovedTask(id);}}}}));
    const ordered=!(task.state==='done'&&doneNewest());
    if(ordered&&index>0)items.push({label:'Move up',fn:()=>App.moveTaskOrder(id,list[index-1].id,true)});
    if(ordered&&index<list.length-1)items.push({label:'Move down',fn:()=>App.moveTaskOrder(id,list[index+1].id,false)});
    App._openMenu(items,r.left,r.bottom+6,{trigger:event.currentTarget});
  },
  moveTaskOrder(id,anchor,before){if(!canBoard())return;const task=taskById(id),target=taskById(anchor);if(!task||!target||task.state!==target.state)return;const old=motionRects('.card[data-task]');D.tasks.splice(D.tasks.indexOf(task),1);D.tasks.splice(D.tasks.indexOf(target)+(before?0:1),0,task);App.refresh();focusMovedTask(id);animateLayout(old,'.card[data-task]');},

  // filters
  setBoardQ(v,event) {
    cancelBoardSearch();
    state.boardQ = v.trim();
    if (event?.isComposing) return;
    if (!event || !v) { applyBoardFilters(); return; }
    const projectId=state.projectId, sessionId=D.session?.id;
    boardSearchTimer=setTimeout(()=>{
      if(state.view==='board'&&state.projectId===projectId&&D.session?.id===sessionId)applyBoardFilters();
    },180);
  },
  boardSearchKey(event) {
    if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(boardSearchTimer)applyBoardFilters();}
  },
});
window.App = App;
export { App };

// Pointer gestures share the existing destination, optimistic-save and rollback
// paths. Touch/pen start on grips so the rest of the Board remains scrollable.
// The click that ends a drag is not a click on the card. Some browsers send
// it only after the drop has redrawn the Board, however long that takes, so
// a drag that started swallows the next click; the next press forgets it.
let pointerDrag = null, suppressDragClick = false;
function pointerEvent(event, currentTarget) {
  const drag = pointerDrag;
  return {target:drag.source,currentTarget,clientX:drag.x,clientY:drag.y,
    dataTransfer:drag.transfer,preventDefault:()=>event?.preventDefault()};
}
function updatePointerTarget() {
  const drag = pointerDrag; if (!drag?.started || !App._drag) return;
  const hit = document.elementFromPoint(drag.x,drag.y);
  const target = hit?.closest(drag.kind === 'task' ? '.col[data-col]' : '.lane[data-track]');
  if (drag.target && drag.target !== target) {
    drag.target.classList.remove('drop'); App._ind()?.remove(); App._dropBefore=null; App._laneBefore=null;
  }
  drag.target = target;
  if (target) {
    if (drag.kind === 'task') App.colOver(pointerEvent(null,target));
    else App.laneOver(pointerEvent(null,target));
  }
  const preview=App._dragPreview;
  if (preview) { preview.style.left=(drag.x-drag.offsetX)+'px'; preview.style.top=(drag.y-drag.offsetY)+'px'; }
}
function pointerScroll() {
  const drag=pointerDrag;if(!drag?.started)return;
  if(!drag.source.isConnected || !App._drag){finishPointerDrag(false);return;}
  const speed=(value,min,max)=>value<min+40?-Math.min(18,(min+40-value)/3):value>max-40?Math.min(18,(value-max+40)/3):0;
  const viewport=document.querySelector(drag.kind==='task'?'.board':'.rm-scroll');
  if(viewport){const rect=viewport.getBoundingClientRect();viewport.scrollLeft+=speed(drag.x,rect.left,rect.right);if(drag.kind==='track')viewport.scrollTop+=speed(drag.y,rect.top,rect.bottom);}
  const list=drag.target?.querySelector('.col-cards');
  if(list){const rect=list.getBoundingClientRect();list.scrollTop+=speed(drag.y,rect.top,rect.bottom);}
  updatePointerTarget();drag.frame=requestAnimationFrame(pointerScroll);
}
function finishPointerDrag(commit,event) {
  const drag=pointerDrag;if(!drag)return;
  cancelAnimationFrame(drag.frame);
  if(drag.started){
    suppressDragClick=true;
    if(commit && drag.source.isConnected){
      updatePointerTarget();
      if(drag.target && App._drag){
        if(drag.kind==='task')App.dropTask(pointerEvent(event,drag.target),drag.target.dataset.col);
        else App.trackDrop(pointerEvent(event,drag.target),drag.target.dataset.track);
      }
    }
    App.dragEnd(false);
  }
  pointerDrag=null;
  if(drag.source.hasPointerCapture?.(drag.pointerId))drag.source.releasePointerCapture(drag.pointerId);
}
document.addEventListener('pointerdown',event=>{
  suppressDragClick=false;
  if(!event.isPrimary){if(pointerDrag)finishPointerDrag(false);return;}
  if(event.button!==0 || pointerDrag || state.modal || state.peek || state.menu) return;
  const grip=event.target.closest('.grip'),card=event.target.closest('.card[data-task]');
  const kind=grip?'track':card?'task':null;
  if(!kind || (kind==='track'?!canRoadmap():!canBoard()))return;
  if(!grip && event.target.closest('button,a,input,textarea') && !event.target.closest('.card-move,.card-title-button'))return;
  if(!grip && ['touch','pen'].includes(event.pointerType) && !event.target.closest('.card-move'))return;
  const source=grip||card,rect=(grip?grip.closest('.lane').querySelector('.lane-head'):card).getBoundingClientRect();
  const values=new Map();
  pointerDrag={source,kind,id:grip?grip.closest('.lane').dataset.track:card.dataset.task,pointerId:event.pointerId,
    x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,offsetX:grip?24:event.clientX-rect.left,offsetY:grip?20:event.clientY-rect.top,
    transfer:{setData:(key,value)=>values.set(key,value),getData:key=>values.get(key),get types(){return [...values.keys()];},setDragImage(){}},started:false,target:null,frame:0};
});
document.addEventListener('pointermove',event=>{
  const drag=pointerDrag;if(!drag || drag.pointerId!==event.pointerId)return;
  if(!drag.source.isConnected){finishPointerDrag(false);return;}
  drag.x=event.clientX;drag.y=event.clientY;
  if(!drag.started){
    if(Math.hypot(drag.x-drag.startX,drag.y-drag.startY)<6)return;
    const synthetic=pointerEvent(event,drag.source);
    if(drag.kind==='task')App.taskDragStart(synthetic,drag.id);else App.trackDragStart(synthetic,drag.id);
    if(!App._drag){pointerDrag=null;return;}
    drag.started=true;drag.source.setPointerCapture?.(drag.pointerId);
    drag.frame=requestAnimationFrame(pointerScroll);
  }
  event.preventDefault();updatePointerTarget();
},{passive:false});
document.addEventListener('pointerup',event=>{if(pointerDrag?.pointerId===event.pointerId)finishPointerDrag(true,event);},true);
document.addEventListener('pointercancel',event=>{if(pointerDrag?.pointerId===event.pointerId)finishPointerDrag(false);},true);
document.addEventListener('lostpointercapture',event=>{if(pointerDrag?.pointerId===event.pointerId && event.target===pointerDrag.source && !pointerDrag.source.hasPointerCapture?.(event.pointerId))finishPointerDrag(false);},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&pointerDrag){event.preventDefault();event.stopImmediatePropagation();finishPointerDrag(false);}},true);
window.addEventListener('blur',()=>finishPointerDrag(false));
document.addEventListener('click',event=>{if(event.detail>0 && suppressDragClick){suppressDragClick=false;event.preventDefault();event.stopImmediatePropagation();}},true);
// Native HTML dragging would steal the pointer stream. Retain callable legacy
// handlers only as a compatibility surface for the shared mutation model.
document.addEventListener('dragstart',event=>{if(event.target.closest('.card,.grip')){event.preventDefault();event.stopImmediatePropagation();}},true);

// ---------- global listeners ----------
function resolveRoute() {
  const route=location.hash.replace(/^#\/?/,'') || 'roadmap';
  if(route.startsWith('task/')){
    let id;try{id=decodeURIComponent(route.slice(5));}catch{state.view='notfound';state.taskId=null;return;}
    state.taskId=id;
    const task=taskById(id);
    if(!task){state.view='notfound';state.taskId=id;return;}
    const epic=epicById(task.epicId),track=trackById(epic?.trackId);
    if(!track){state.view='notfound';return;}
    state.projectId=track.projectId;state.view=canReadTask(task)?'task':'forbidden';state.taskId=task.id;return;
  }
  state.taskId=null;
  if(route==='knowledge'||/^knowledge[/?]/.test(route)){
    const projectId=window.OneloopKnowledge?.route(route,state.projectId);
    if(projectId&&projectId!==state.projectId){
      if(!visibleProjects().some(project=>project.id===projectId)){state.view='notfound';return;}
      state.projectId=projectId;state.rmScrollLeft=null;state.boardTracks=[];state.boardEpics=[];state.boardAssignees=[];state.boardQ='';state.boardBlocked=false;
    }
    state.view='knowledge';return;
  }
  state.view=['roadmap','board','settings','profile','users','inbox','storage'].includes(route)?route:'notfound';
}
/** The address Discard let through, which routes without asking again. */
let discardedFor = null;
/** Go to an address that the person already chose to leave typed text for. */
function followAddress(hash) { discardedFor = new URL(hash, location.href).href; location.hash = hash; }
/**
 * Back, Forward or an address typed by hand: a field that saves itself saves
 * first, as no browser blurs it here. If typed text would still be lost, the
 * old address comes back while oneloop asks; Discard goes on.
 */
function mayFollowAddress(event) {
  if (event.newURL === discardedFor) { discardedFor = null; return true; }
  const active = document.activeElement;
  if (active?.matches?.('[data-autosave]')) active.blur();
  if (!window.Recovery?.hasUnsavedInput?.({ leaving:false })) return true;
  const { oldURL, newURL } = event;
  history.replaceState(history.state, '', oldURL);
  askToDiscard(() => {
    discardedFor = newURL;
    history.replaceState(history.state, '', newURL);
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL }));
  });
  return false;
}
window.addEventListener('hashchange',(event)=>{
  // Local navigation already painted its destination. Consume only that
  // exact history event, so external hashes and Back/Forward still route.
  const index=locallyRenderedHashes.indexOf(event.newURL);
  if(index!==-1){locallyRenderedHashes.splice(index,1);window.Recovery?.clearPageError();return;}
  if(event.newURL && event.newURL!==location.href)return;
  // Staying keeps the page, so the route loader must not load the new one either.
  if(!mayFollowAddress(event)){event.stopImmediatePropagation();return;}
  window.Recovery?.clearPageError();
  state.peek=null;state.modal=null;state.menu=null;resolveRoute();render();
});
document.addEventListener('scroll', (e) => { if (!EPIC_TIP.el?.contains(e.target)) hideEpicTip(); }, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && EPIC_TIP.el) { e.preventDefault(); e.stopImmediatePropagation(); hideEpicTip(); }
}, true);
// W, M and Q switch the Roadmap's scale while focus is on the Roadmap page,
// or on the page itself, as after a click on empty space or, in Safari, on a
// button. Not in a text field, a menu or a dialog: single-letter keys work
// only there, so they can't fire by accident elsewhere.
document.addEventListener('keydown', (event) => {
  if (state.view !== 'roadmap' || event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const scale = ROADMAP_SCALES.find((item) => item.shortcut === String(event.key).toUpperCase());
  const onPage = event.target === document.body || event.target === document.documentElement || event.target.closest?.('#main,.page-header');
  if (!scale || !onPage || event.target.closest('input,textarea,select,[contenteditable="true"]') || state.modal || state.peek || state.menu || state.sideOpen && innerWidth <= 900 || POP.el || pendingConfirmation || document.querySelector('.confirmation-layer,.file-overlay') || document.getElementById('app').inert) return;
  event.preventDefault();
  App.setRoadmapScale(scale.key);
  announce(`Roadmap scale: ${scale.label}`);
});
document.addEventListener('pointerdown', (e) => {
  if (EPIC_TIP.el && !EPIC_TIP.el.contains(e.target) && !EPIC_TIP.anchor?.contains(e.target)) hideEpicTip();
});
document.addEventListener('pointerdown', (e) => {
  clearTimeout(pressedControlTimer);
  pressedTaskControl=!!e.target.closest?.('.task-page,.peek,.modal');
});
const releasePressedControl=()=>{clearTimeout(pressedControlTimer);pressedControlTimer=setTimeout(()=>{pressedTaskControl=false;},0);};
// Retain the guard through click dispatch and intervening promise callbacks.
window.addEventListener('pointerup',releasePressedControl,true);
window.addEventListener('pointercancel',releasePressedControl,true);
window.addEventListener('click',releasePressedControl,true);
window.addEventListener('blur',()=>{clearTimeout(pressedControlTimer);pressedTaskControl=false;});
document.addEventListener('mousedown', (e) => {
  if (POP.el && !POP.el.contains(e.target) && !e.target.closest('.sel-btn')) closePop();
});
document.addEventListener('submit', (e) => {
  const form = e.target;
  for (const field of form.querySelectorAll('.field[data-required="true"]')) {
    const input = field.querySelector('input:not(:disabled), textarea:not(:disabled)');
    if (!input || ['checkbox','file'].includes(input.type)) continue;
    const value = input.type === 'password' ? input.value : input.value.trim();
    if (value) continue;
    e.preventDefault(); e.stopImmediatePropagation();
    const ctl = field.querySelector('.ctl');
    if (input.name) failField(form, input.name, 'This field is required.');
    else { ctl?.focus(); ctl?.classList.add('invalid'); }
    return;
  }
}, true);
document.addEventListener('beforeinput', (e) => {
  const input = e.target;
  if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password' || e.isComposing) return;
  if (input.classList.contains('tp-title') && ['insertLineBreak', 'insertParagraph'].includes(e.inputType)) { e.preventDefault(); return; }
  if (inputKind(input) === 'date') {
    if (e.inputType.startsWith('delete')) {
      if (!e.cancelable) return;
      e.preventDefault(); editDateDigits(input, '', e.inputType); return;
    }
    if (e.inputType.startsWith('insert') && e.data !== null) {
      if (!e.cancelable) return;
      e.preventDefault();
      const digits = e.data.replace(/[^0-9]/g, '');
      if (digits) editDateDigits(input, digits);
      return;
    }
  } else if (e.data !== null && e.inputType.startsWith('insert')) {
    const from = input.selectionStart, to = input.selectionEnd;
    const proposed = input.value.slice(0, from) + e.data + input.value.slice(to);
    const clean = sanitizeInputValue(input, proposed);
    if (clean !== proposed && e.cancelable) {
      e.preventDefault(); insertCleanText(input, e.data);
    }
  }
}, true);
document.addEventListener('paste', (e) => {
  const input = e.target;
  if (!editableText(input) || input.disabled || input.readOnly || input.type === 'password') return;
  const text = e.clipboardData?.getData('text');
  if (text === undefined) return;
  if (inputKind(input) === 'date') { e.preventDefault(); if (/[0-9]/.test(text)) editDateDigits(input, text); }
  else if (sanitizeInputValue(input, text) !== text) { e.preventDefault(); insertCleanText(input, text); }
}, true);
document.addEventListener('input', (e) => { if (!e.isComposing) normalizeInput(e.target); }, true);
document.addEventListener('compositionend', (e) => { normalizeInput(e.target); }, true);
document.addEventListener('compositionend', (e) => { if(e.target.matches?.('[data-board-search]'))App.setBoardQ(e.target.value,e); }, true);
document.addEventListener('input', (e) => { if(e.target.closest('.task-page'))clearTaskSaved(); }, true);
document.addEventListener('input', (e) => {
  if (e.target.classList && (e.target.classList.contains('ctl') || e.target.classList.contains('tp-title'))) clearFieldError(e.target);
});
let rsz;
window.addEventListener('resize', () => {
  hideEpicTip();
  clearTimeout(rsz);
  rsz = setTimeout(() => {
    syncSidebar();
    // Resize only the timeline; keep form input, focus, and open dialogs intact.
    const content = document.querySelector('.content');
    if (state.view === 'roadmap' && content && !window.Recovery?.pageError) {
      setHTML(content,renderRoadmap());
      mountRoadmap();
    }
    if (POP.el) {
      if (POP.anchor?.isConnected) placePop(POP.anchor);
      else closePop(true);
    }
    sizeDescription();
    sizeDescriptionEditors();
    placeMenu();
  }, 120);
});

collaboration?.bind(App,{task:taskById,projects:visibleProjects,view:()=>state.view,canBoard:task=>hasPermission('manage_board',trackById(epicById(task?.epicId)?.trackId)?.projectId),confirm:askConfirmation,refresh:render,refreshBackground,refreshActivity:refreshTaskActivity,exit:exitVisual,multi:multiHtml,ago,instant:formatInstant,dateKey:instanceDateKey,previousDate,avatar:avatarHtml,
  refreshComments:(id,composer=false)=>{if(state.view!=='task'||state.taskId!==id)return;const task=taskById(id),timeline=document.querySelector('.task-page .timeline'),before=timeline?.getBoundingClientRect().height,rows=UIMotion.rows(timeline,'[data-comment]','data-comment'),focused=document.activeElement?.dataset.replyRoot;if(timeline){setHTML(timeline,collaboration.feedHtml(task));UIMotion.height(timeline,before);UIMotion.reflow(timeline,'[data-comment]','data-comment',rows);if(focused)[...timeline.querySelectorAll('[data-reply-root]')].find(el=>el.dataset.replyRoot===focused)?.focus({preventScroll:true});}if(composer){const home=document.querySelector('.comment-composer-home');if(home)setHTML(home,Collab.composerHtml(task));UIMotion.enter(document.querySelector('.collaboration-composer .reply-context'));}},
});
window.Recovery?.bind(App,{refresh:render});
window.Uploads?.bind(App,{confirm:askConfirmation,task:taskById,canRead:id=>canReadTask(taskById(id)),can:id=>hasPermission('manage_board',trackById(epicById(taskById(id)?.epicId)?.trackId)?.projectId),refresh:render,me,instant:formatInstant,refreshAttachments:id=>{if(state.view!=='task'||state.taskId!==id)return;const template=document.createElement('template');setHTML(template,renderTask());const oldAttachments=document.querySelector('.task-attachments'),before=oldAttachments?.getBoundingClientRect().height,rows=UIMotion.rows(oldAttachments,'[data-attachment-id]','data-attachment-id');oldAttachments?.replaceWith(template.content.querySelector('.task-attachments'));const nextAttachments=document.querySelector('.task-attachments');UIMotion.height(nextAttachments,before);UIMotion.reflow(nextAttachments,'[data-attachment-id]','data-attachment-id',rows);refreshTaskActivity(id);window.Uploads.mount(id);}});
setInterval(()=>{
  const key=instanceDateKey(instanceNow());if(key===iso(today))return;today.setTime(+d(key));
  if(!D.session||me()?.mustChange)return;
  if (state.view==='roadmap'||state.peek) window.OneloopRuntime.invoke('date.rollover',{}).catch(()=>{});
  if(state.view==='task'){
    const late=overdue(taskById(state.taskId)),row=document.querySelector('.task-property-date');
    row?.classList.toggle('late',late);const label=row?.querySelector('.task-overdue');if(label)label.hidden=!late;
  }else if(state.view==='board')App.refreshBoard();
  else if(state.view==='roadmap')App.refreshRoadmap();
  else if(state.view==='inbox')refreshBackground();
},60000);
ensureToastRegion();
resolveRoute();
if(!window.ONELOOP_DEFER_BOOT_RENDER)render();
