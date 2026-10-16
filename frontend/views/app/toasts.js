// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* Notifications and Undo. They live outside #app, so a render never restarts
   them or clears entered text. */

import { UIMotion } from '../../src/app/motion.js';
import { commandKey } from '../../src/app/save-shortcut.js';
import { I, cleanStr, esc, setHTML } from './format.js';
import { App, state } from './model.js';
import { POP, pendingConfirmation } from './overlays.js';

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

export function ensureToastRegion() {
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

export function announce(text, kind = 'polite') {
  const node = ensureToastRegion().querySelector(`[data-announce="${esc(kind)}"]`);
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
    if (added.has(toast.id)) UIMotion.animate(toast.el, [{ opacity:0, transform:'translateX(12px)' },{ opacity:1, transform:'none' }]);
    else if (before.has(toast.id)) {
      const from = before.get(toast.id), to = toast.el.getBoundingClientRect();
      if (Math.abs(from.rect.top - to.top) > 1) UIMotion.animate(toast.el, [{ opacity:from.opacity, transform:`translateY(${from.rect.top - to.top}px)` },{ opacity:1, transform:'none' }]);
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
// it does nothing.
const UNDO_KEY = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || '')
  ? { label: '⌘Z', aria: 'Meta+Z', spoken: 'Command+Z' } : { label: 'Ctrl+Z', aria: 'Control+Z', spoken: 'Control+Z' };
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat || event.isComposing || !commandKey(event, 'z')) return;
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
    const animation = UIMotion.animate(el, [{opacity,transform:'none'},{opacity:0,transform:'translateX(8px)'}], UIMotion.quick);
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

Object.assign(App, {
  toast: pushToast,
  offerUndo,
  announce,
  dismissToast,
});
