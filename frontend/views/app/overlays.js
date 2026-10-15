// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* Layers above the page: popovers, menus, dialogs and their confirmations,
   and the Roadmap's rich tooltip. Each returns focus to where it opened. */

import { openDialog, placeNear, trapFocus } from '../../src/app/layers.js';
import { UIMotion } from '../../src/app/motion.js';
import { I, UIAction, esc, setHTML } from './format.js';
import {
  App, D, canReadProject, epicById, isAdmin, me, recovery, report, runtime, state, taskById,
  trackById,
} from './model.js';

export function overlayKey(selector) {
  if (selector === '.modal') return state.modal ? (state.modal.poolId || state.modal.type === 'pool' ? 'pool' : state.modal.type + ':' + (state.modal.id || 'new')) : '';
  if (selector === '.peek') return state.peek || '';
  if (selector === '.menu') return state.menu ? (state.menu.version ? 'profile' : state.menu.projectMenu ? 'project' : state.menu.items.map(i => i.label || '').join('|')) : '';
  return '';
}

// Each opened dialog or drawer gets a generation that its re-renders keep,
// so a late save can tell its own dialog from one opened after it.
let overlayOpens = 0, peekGeneration = 0;
const modalGenerations = new WeakMap();

/** A drawer opened anew gets a new generation. */
export function peekOpened() { peekGeneration = ++overlayOpens; }

export function stampOverlays() {
  if (state.modal && !modalGenerations.has(state.modal)) modalGenerations.set(state.modal, ++overlayOpens);
  const modal = document.querySelector('#app .modal'), peek = document.querySelector('#app .peek');
  if (modal && state.modal) modal.dataset.openGeneration = String(modalGenerations.get(state.modal));
  if (peek && state.peek) peek.dataset.openGeneration = String(peekGeneration);
}

export let pendingConfirmation = null;

// A `local` choice, such as discarding typed text, changes nothing on the server, so it works offline.
export function askConfirmation({ title, text, action, match, confirm, cancel, local = false }) {
  if (pendingConfirmation) return false;
  closePop(true);
  const returnFocus = document.activeElement;
  state.menu = null;
  document.querySelectorAll('#overlay-root > .menu, #overlay-root > .menu-scrim').forEach(el => el.remove());
  const form = document.createElement('form'); form.className = 'confirm-dialog'; form.noValidate = true;
  for (const [name, value] of Object.entries({ role:'alertdialog', 'aria-modal':'true', 'aria-labelledby':'confirmation-title', 'aria-describedby':'confirmation-description' })) form.setAttribute(name, value);
  setHTML(form,`<h2 id="confirmation-title">${esc(title)}</h2><p id="confirmation-description">${esc(text)}</p>
    ${match !== undefined ? `<label class="confirmation-match-label" for="confirmation-match">Type <strong>${esc(match)}</strong> to confirm</label><input id="confirmation-match" class="ctl" autocomplete="off" spellcheck="false" required>` : ''}
    <div class="modal-actions"><button type="button" class="btn quiet" data-confirm-cancel>Cancel</button><button type="submit" class="btn danger" data-confirm-accept ${match !== undefined ? 'disabled' : ''}>${esc(action)}</button></div>`);
  const dialog = openDialog({ form, inert:[...document.querySelectorAll('#app, #toast-region .toast-stack')], onEscape:() => close(false) });
  const record = { session:D.session?.id, hash:location.hash, close:null }; pendingConfirmation = record;
  const close = (accepted, restoreFocus = true) => {
    if (pendingConfirmation !== record) return;
    pendingConfirmation = null;
    UIMotion.exit(dialog.layer.querySelector('.scrim'));UIMotion.exit(form); dialog.close();
    if (!accepted) cancel?.();
    if (restoreFocus) {
      const focus = returnFocus?.isConnected && returnFocus !== document.body && !returnFocus.closest('[inert]') ? returnFocus :
        [...document.querySelectorAll('.modal button,.peek button,.me-chip,.menu-btn')].find(el => !el.closest('[inert]') && !el.disabled);
      focus?.focus({preventScroll:true});
    }
  };
  record.close = close;
  const input = form.querySelector('input'), accept = form.querySelector('[data-confirm-accept]'), dismiss = form.querySelector('[data-confirm-cancel]');
  input?.addEventListener('input', () => { accept.disabled = input.value !== match; });
  dismiss.addEventListener('click', () => close(false));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (pendingConfirmation !== record || (match !== undefined && input.value !== match)) return;
    if(!local && !recovery.ensureOnline())return;
    accept.disabled = true; close(true); confirm();
  });
  (input || dismiss).focus();
  return true;
}

/** Ask before typed text is lost: Discard runs `leave`; Cancel, or a question already open, runs `stay`. */
export function askToDiscard(leave, stay = () => {}, text = 'Text you typed on this page will be lost.') {
  if (askConfirmation({ title:'Discard changes?', text, action:'Discard', local:true, confirm:leave, cancel:stay }) === false) stay();
}

export const POP = { el: null, id: null, onKey: null, anchor: null, dateTrigger: null, onClose: null, trigger: null };

export function closePop(silent) {
  if (!POP.el) return;
  if (!silent) UIMotion.exit(POP.el);
  POP.el.remove(); POP.el = null; POP.id = null; POP.anchor = null;
  if (POP.onKey) { document.removeEventListener('keydown', POP.onKey, true); POP.onKey = null; }
  const cb = POP.onClose; POP.onClose = null;
  POP.dateTrigger?.setAttribute('aria-expanded', 'false'); POP.dateTrigger = null;
  POP.trigger?.setAttribute('aria-expanded','false');POP.trigger?.removeAttribute('aria-controls');POP.trigger=null;
  if (cb && !silent) cb();
}

export function openPop(anchor, width) {
  closePop();
  const el = document.createElement('div');
  el.className = 'pop';
  if (width) el.style.width = width + 'px'; else el.style.minWidth = anchor.getBoundingClientRect().width + 'px';
  document.body.appendChild(el);
  POP.el = el; POP.anchor = anchor;
  return el;
}

export function placePop(anchor) {
  const el = POP.el;
  if (!el || !anchor.isConnected) return;
  el.style.minWidth = Math.min(parseFloat(el.style.minWidth) || 0, innerWidth - 16) + 'px';
  el.style.maxHeight = Math.min(340, innerHeight - 16) + 'px';
  const { left, top } = placeNear(anchor.getBoundingClientRect(), el);
  el.style.left = left + 'px'; el.style.top = top + 'px';
}

export function placeMenu() {
  const el = document.querySelector('.menu');
  if (!el || !state.menu) return;
  if (state.menu.version || state.menu.projectMenu) {
    const anchor = document.querySelector(state.menu.projectMenu ? '.switcher-btn' : '.me-chip').getBoundingClientRect();
    el.style.width = Math.min(anchor.width < 100 ? 208 : anchor.width, innerWidth - 16) + 'px';
    state.menu.x = anchor.left; state.menu.y = state.menu.projectMenu ? anchor.bottom + 6 : anchor.top;
  }
  // Menus that belong to a button sit next to it, whether a mouse or a key opened them.
  if(state.menu.commentId||state.menu.taskActions||state.menu.trackId){
    const anchor=state.menu.taskActions?document.querySelector('.task-actions-button')
      :state.menu.trackId?[...document.querySelectorAll('.lane[data-track]')].find(lane=>lane.dataset.track===state.menu.trackId)?.querySelector('.kebab')
      :[...document.querySelectorAll('[data-comment]')].find(row=>row.dataset.comment===state.menu.commentId)?.querySelector('.comment-menu-button');
    if(anchor){const place=placeNear(anchor.getBoundingClientRect(),el,{align:'end',gap:4});state.menu.x=place.left;state.menu.y=place.top;}
  }
  el.style.left = Math.max(8, Math.min(state.menu.x, innerWidth - el.offsetWidth - 8)) + 'px';
  const top = state.menu.above ? state.menu.y - el.offsetHeight - 6 : state.menu.y;
  el.style.top = Math.max(8, Math.min(top, innerHeight - el.offsetHeight - 8)) + 'px';
}

export const EPIC_TIP = { el: null, anchor: null, showTimer: null, hideTimer: null };

export function hideEpicTip() {
  clearTimeout(EPIC_TIP.showTimer); clearTimeout(EPIC_TIP.hideTimer);
  EPIC_TIP.anchor?.removeAttribute('aria-describedby');
  if(EPIC_TIP.el)UIMotion.exit(EPIC_TIP.el);EPIC_TIP.el?.remove(); EPIC_TIP.el = null; EPIC_TIP.anchor = null;
}

export function mountRoadmapTip(anchor, id, html) {
  if (!anchor.isConnected || state.modal || state.peek || state.menu) return;
  hideEpicTip();
  const el = document.createElement('div'); el.className = 'epic-tooltip'; el.id = id; el.setAttribute('role', 'tooltip');
  setHTML(el,html);
  document.body.append(el); EPIC_TIP.el = el; EPIC_TIP.anchor = anchor;
  anchor.setAttribute('aria-describedby', el.id);
  const { left, top } = placeNear(anchor.getBoundingClientRect(), el, { gap: 8 });
  el.style.left = left + 'px'; el.style.top = top + 'px';UIMotion.enter(el);
  el.addEventListener('mouseenter', () => clearTimeout(EPIC_TIP.hideTimer));
  el.addEventListener('mouseleave', () => App.epicLeave());
}

export function renderMenu() {
  const m = state.menu;
  if (!m) return '';
  const themeControl = () => `<div class="seg theme-options" role="group" aria-label="Theme">${[['light', 'Light', I.sun], ['dark', 'Dark', I.moon], ['system', 'System', I.device]].map(([theme, label, icon]) => `<button type="button" data-theme-option="${esc(theme)}" class="${window.Theme.choice === theme ? 'on' : ''}" aria-pressed="${window.Theme.choice === theme}" ${UIAction('setTheme', theme)}><span class="menu-icon" aria-hidden="true">${icon}</span>${label}</button>`).join('')}</div>`;
  const autoReload = recovery.autoReload;
  // A choice for this browser, like the theme, so it keeps the menu open.
  const autoReloadControl = () => `<button type="button" data-auto-reload aria-pressed="${!!autoReload}" ${UIAction('toggleAutoReload')}><span class="menu-icon" aria-hidden="true">${I.reload}</span>Reload after updates<span class="menu-check" aria-hidden="true">${autoReload ? I.tick : ''}</span></button>`;
  const items = m.items.map((it) => it.theme ? themeControl() : it.autoReload ? autoReloadControl() : it.sep ? '<div class="sep"></div>' : it.projectId ? `<button type="button" class="project-option${it.projectId===state.projectId?' selected':''}" aria-current="${it.projectId===state.projectId}" data-tip="${esc(it.projectName)}" data-tip-overflow ${UIAction('menuAction', it.i)}><span class="project-option-avatar" aria-hidden="true">${esc(it.projectName.slice(0,1).toUpperCase())}</span><span class="project-option-name">${esc(it.projectName)}</span><span class="project-option-check" aria-hidden="true">${it.projectId===state.projectId?I.tick:''}</span></button>` :
    `<button class="${it.danger ? 'danger' : ''}" ${UIAction('menuAction', it.i)}>${it.icon ? `<span class="menu-icon" aria-hidden="true">${it.icon}</span>` : ''}${esc(it.label)}</button>`).join('');
  return `<div class="scrim menu-scrim" ${UIAction('closeOverlays')}></div>
    <div ${m.projectMenu?'id="project-switcher-menu" role="group" aria-label="Projects"':'id="action-menu"'} class="menu${m.version ? ' profile-menu' : m.projectMenu ? ' project-menu' : m.commentId||m.taskActions ? ' comment-menu' : ''}" style="left:${m.x}px;top:${m.y}px">${items}${m.version && window.ONELOOP_BUILD ? `<div class="menu-version"><span aria-hidden="true">v${esc(window.ONELOOP_BUILD.version)} · ${esc(window.ONELOOP_BUILD.build)}</span><span class="sr-only">Version ${esc(window.ONELOOP_BUILD.version)}, build ${esc(window.ONELOOP_BUILD.build)}</span></div>` : ''}</div>`;
}
let lastMenuTrigger = null;

export function dismissMenu(restoreFocus=true){
  const trigger=state.menu?.trigger;
  if (trigger) lastMenuTrigger = trigger;
  state.menu=null;document.querySelector('#overlay-root > .menu-scrim')?.remove();document.querySelector('#overlay-root > .menu')?.remove();
  if(trigger?.isConnected){trigger.setAttribute('aria-expanded','false');if(restoreFocus)trigger.focus({preventScroll:true});}
}

// Full SPA renders replace the opener as well as the dialog. Remember its
// identifying attributes so dismissing a dialog can focus its new counterpart.
const overlayReturn = { modal:null, peek:null };
// What a click on the element runs, which its redrawn copy runs too.
const clickAction = el => el.hasAttribute('data-action') ? `${el.getAttribute('data-action')} ${el.getAttribute('data-args') ?? ''}` : null;

export function rememberOpener(element) {
  const el = element?.closest?.('button,a[href],[role="button"],input,textarea') || element;
  if (!el || el === document.body) return null;
  return { element:el, id:el.id, action:clickAction(el), label:el.getAttribute('aria-label'), name:el.getAttribute('name'), tag:el.tagName,
    epic:el.dataset.epic, milestone:el.dataset.milestone, text:el.textContent.trim(),
    selection: typeof el.selectionStart === 'number' ? [el.selectionStart,el.selectionEnd,el.selectionDirection] : null,
    scope:el.closest('.topbar') ? '.topbar' : el.closest('.sidebar') ? '.sidebar' : el.closest('.peek') ? '.peek' : el.closest('.modal') ? '.modal' : '#app' };
}

export function restoreOpener(record) {
  const app = document.getElementById('app');
  let target = record?.element?.isConnected && !record.element.closest('[inert],[hidden]') ? record.element : null;
  if (!target && record?.id) target = document.getElementById(record.id);
  if (!target && record?.epic) target = [...app.querySelectorAll('[data-epic]')].find(el => el.dataset.epic === record.epic);
  if (!target && record?.milestone) target = [...app.querySelectorAll('[data-milestone]')].find(el => el.dataset.milestone === record.milestone);
  // A scrim and a close button can share an action; prefer the same kind of control in the same place.
  if (!target && record?.action) target = [...app.querySelectorAll(`${record.scope} [data-action]`), ...app.querySelectorAll('[data-action]')].find(el => el.tagName === record.tag && clickAction(el) === record.action);
  if (!target && record?.label) target = [...app.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label') === record.label);
  if (!target && record?.name) target = app.querySelector(`${record.tag?.toLowerCase() || 'input'}[name="${record.name}"]`);
  if (!target && record?.text) target = [...app.querySelectorAll(`${record.scope} ${record.tag.toLowerCase()}`)].find(el => el.textContent.trim() === record.text);
  if (!target || target.closest('[inert],[hidden]') || target.disabled) target = ['.modal button','.peek button','.topbar button','.menu-btn']
    .flatMap(selector => [...app.querySelectorAll(selector)]).find(el => !el.closest('[inert],[hidden]') && !el.disabled);
  target?.focus({preventScroll:true});
  if(record?.selection && typeof target?.setSelectionRange === 'function')try{target.setSelectionRange(...record.selection);}catch{}
}

const overlayControls = panel => [...panel.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])')]
  .filter(el => !el.closest('[hidden],[inert]') && el.getAttribute('tabindex') !== '-1');
export function syncSidebar() {
  const app = document.getElementById('app'), open = innerWidth <= 900 && state.sideOpen;
  const overlay = !!app.querySelector('.modal,.peek');
  const sidebar = app.querySelector('.sidebar'), main = app.querySelector('.main');
  if (sidebar) sidebar.inert = overlay || innerWidth <= 900 && !state.sideOpen;
  if (main) {
    main.inert = overlay;
    for (const child of main.children) child.inert = open && !child.classList.contains('page-header');
    const topbar = main.querySelector('.topbar'); if (topbar) topbar.inert = open;
  }
  const skip = app.querySelector('.skip-link'); if (skip) skip.inert = open || overlay;
  app.querySelector('.menu-btn')?.setAttribute('aria-expanded', String(innerWidth <= 900 ? !!state.sideOpen : !state.rail));
}

export function syncOverlayFocus({ oldModal, oldPeek, oldFocus, oldModalKey, oldPeekKey, oldPanelFocus }) {
  const app = document.getElementById('app');
  const modal = app.querySelector('.modal'), peek = app.querySelector('.peek');
  const shellInert = !!(modal || peek);
  for (const selector of ['.main','.sidebar','.side-scrim']) {
    const node = app.querySelector(`:scope > ${selector}`); if (node) node.inert = shellInert || selector === '.sidebar' && window.innerWidth <= 900 && !state.sideOpen;
  }
  syncSidebar();
  if (peek) peek.inert = !!modal;
  if (modal && !oldModal) overlayReturn.modal = rememberOpener(oldFocus?.closest?.('.menu') ? lastMenuTrigger : oldFocus);
  if (peek && !oldPeek) overlayReturn.peek = rememberOpener(oldFocus);
  if (modal || peek) {
    const panel = modal || peek;
    const externalLayer = document.querySelector('.confirmation-layer,.file-overlay') || app.inert;
    const samePanel = modal ? oldModal && oldModalKey === overlayKey('.modal') : oldPeek && !oldModal && oldPeekKey === overlayKey('.peek');
    if (oldModal && !modal && !externalLayer) restoreOpener(overlayReturn.modal);
    else if (!externalLayer && samePanel && oldPanelFocus) restoreOpener(oldPanelFocus);
    else if (!externalLayer && (!samePanel || document.activeElement === document.body)) {
      const preferred = modal?.querySelector('[autofocus]:not(:disabled)') || (state.modal?.type === 'pool' ? modal?.querySelector('#poolAdd:not([hidden])') : null) || (peek && !modal ? peek.querySelector('button') : null);
      (preferred || overlayControls(panel)[0] || panel)?.focus({preventScroll:true});
    }
  } else if (oldModal || oldPeek) {
    restoreOpener(overlayReturn.modal || overlayReturn.peek);
    overlayReturn.modal = overlayReturn.peek = null;
  }
  if (oldModal && !modal) overlayReturn.modal = null;
  if (oldPeek && !peek) overlayReturn.peek = null;
}

const waitingPasswords=[];
// A temporary password is shown once. While it shows, or waits for another
// dialog to close, a reload or leaving oneloop would lose it for good.
recovery.trackUnsaved(()=>!!D.session&&(state.modal?.type==='temppw'||waitingPasswords.length>0));

export function showWaitingPassword(){
  while(!state.modal&&waitingPasswords.length){const next=waitingPasswords.shift();if(D.session&&next.ownerSession===D.session.id&&next.ownerId===me()?.id&&isAdmin())state.modal=next;}
}

document.addEventListener('focusin', (event) => {
  if (state.menu && !event.target.closest?.('#overlay-root > .menu')) dismissMenu(false);
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || pendingConfirmation || document.querySelector('.confirmation-layer,.file-overlay') || POP.el?.contains(document.activeElement)) return;
  const panel = document.querySelector('#overlay-root > .modal-wrap .modal') || document.querySelector('#overlay-root > .peek');
  if (!panel && innerWidth <= 900 && state.sideOpen && !state.menu) {
    const controls = [...overlayControls(document.querySelector('.sidebar')), document.querySelector('.menu-btn')].filter(Boolean);
    const index = controls.indexOf(document.activeElement);
    event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus(); return;
  }
  if (!panel) return;
  const controls = overlayControls(panel), first = controls[0], last = controls.at(-1);
  if (!first) { event.preventDefault(); panel.focus(); return; }
  if (!panel.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  else trapFocus(event, controls);
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sideOpen && !state.menu && !state.modal && !state.peek && !POP.el) { e.preventDefault(); App.toggleSidebar(false); return; }
  if (e.key === 'Escape' && state.modal?.poolId) { App.dismissOverlays(); return; }
  if (e.key === 'Escape' && state.menu&&!state.modal&&!state.peek) {e.preventDefault();dismissMenu();return;}
  if (e.key === 'Escape' && (state.modal || state.menu || state.peek)) { e.preventDefault(); App.dismissOverlays(); }
});

Object.assign(App, {
  confirm: askConfirmation,
  askToDiscard,
  showBlocked(title, text) { state.modal = { type:'confirm', title, text, blocked:true }; App.refreshOverlays(); },
  // With `wait`, a password that arrives while another dialog is open shows
  // when that dialog closes, so it neither replaces the dialog nor gets lost.
  showTemporaryPassword(id, password, { wait = false } = {}) {
    const modal = { type:'temppw', id, pw:password, ownerSession:D.session?.id, ownerId:me()?.id };
    if (wait && state.modal && !(state.modal.type === 'user' && state.modal.id === id)) { waitingPasswords.push(modal); return false; }
    state.modal = modal; App.refreshOverlays(); return true;
  },
  async copyTemporaryPassword() {
    const modal=state.modal;
    if(modal?.type!=='temppw'||!isAdmin()||modal.ownerSession!==D.session?.id||modal.ownerId!==me()?.id)return;
    try{
      await navigator.clipboard.writeText(modal.pw);
      if(state.modal===modal)App.toast('Copied');
    }catch{
      if(state.modal===modal)App.toast('Could not copy. Select the password and copy it manually.','error');
    }
  },
  /** Escape: a dialog with typed text asks before it closes. */
  dismissOverlays() {
    const close = () => state.modal?.poolId ? App.returnToPool() : App.closeOverlays();
    const dialog = state.modal ? document.querySelector('#overlay-root .modal') : null;
    if (dialog && recovery.hasTypedInputIn(dialog)) { askToDiscard(close, () => {}, 'Text you typed in this dialog will be lost.'); return; }
    close();
  },
  openModal(type, id, epicId) {
    if(type==='pool'&&!canReadProject(state.projectId))return;
    const targetProject=id&&(type==='epic'?trackById(epicById(id)?.trackId)?.projectId:type==='track'?trackById(id)?.projectId:type==='milestone'?D.milestones.find(m=>m.id===id)?.projectId:['block','unblock','completeBlocked'].includes(type)?trackById(epicById(taskById(id)?.epicId)?.trackId)?.projectId:null);
    if(targetProject&&!canReadProject(targetProject))return;
    if (['epic', 'milestone', 'track'].includes(type) && !App.require('manage_roadmap')) return;
    if (type === 'task' && !App.require('manage_board')) return;
    if (['project', 'user', 'knowledge'].includes(type) && !isAdmin()) return;
    state.sideOpen = false;
    state.modal = { type, id, epicId, trackId: null }; state.menu = null; if (type === 'pool') App._poolScroll = {}; App.refreshOverlays();
    if(type==='pool')runtime().openPool().catch(report);
  },
  // A Roadmap tooltip never shows over a menu, so one Escape closes the menu.
  _openMenu(items, x, y, options = {}) { items.forEach((it, i) => { it.i = i; });const trigger=options.trigger||document.activeElement;hideEpicTip();dismissMenu(false);state.menu = { items, x: Math.max(x, 8), y, trigger, ...options };const template=document.createElement('template');setHTML(template,renderMenu());document.getElementById('overlay-root').append(template.content);trigger?.setAttribute('aria-expanded','true');trigger?.setAttribute('aria-controls',options.projectMenu?'project-switcher-menu':'action-menu');placeMenu();document.querySelector('#overlay-root > .menu button')?.focus({preventScroll:true}); },
  // The action starts from the menu's button, so a dialog it opens returns focus there.
  menuAction(i) { const it = state.menu?.items[i],trigger=state.menu?.trigger;dismissMenu(false);if(trigger?.isConnected)trigger.focus({preventScroll:true});else if(trigger)restoreOpener(rememberOpener(trigger));it?.fn(); },
  /** Draw the open dialog again from the saved values, dropping what was typed in it. */
  redrawDialog(){if(state.modal)App.refreshOverlays();},
});
