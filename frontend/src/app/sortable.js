// @ts-check

/**
 * Moving a row of a list by its grip: with the pointer, while a label with the
 * row's name follows it and a line shows where it would land, or with the
 * arrow keys, Home and End. The list's owner moves the row and saves the order.
 */

/**
 * @typedef {object} SortableList
 * @property {string} grip What a grip of the list matches.
 * @property {string} row What a row of the list matches.
 * @property {string} list What the list around the rows matches; a drop lands only inside it.
 * @property {string} scroll What scrolls while a row is held near its top or bottom.
 * @property {(row: Element) => string} label The name the row shows while it moves.
 * @property {(grip: HTMLElement) => boolean} [ready] Whether the grip's row may move now. While it may not, a drag doesn't start and the grip's keys do nothing.
 * @property {(grip: HTMLElement, target: Element, after: boolean) => void} move Moves the grip's row just before or after `target`.
 */

/** A move under a dialog, drawer, file preview or confirmation would change what it covers. */
const COVERED = '.file-overlay,.confirmation-layer,.modal,.peek';

/** @type {SortableList[]} */
const lists = [];
/** @type {{list:SortableList,handle:HTMLElement,row:Element,pointerId:number,startX:number,startY:number,x:number,y:number,active?:boolean,ghost?:HTMLElement,marker?:HTMLElement,target?:Element|null,after?:boolean,frame?:number}|null} */
let sorting = null;

/** The list whose grip `target` is in, with that grip, unless a layer covers it. @param {EventTarget|null} target */
function gripOf(target) {
  for (const list of lists) {
    const handle = /** @type {HTMLElement|null} */ (/** @type {Element} */ (target)?.closest?.(list.grip) ?? null);
    if (handle && !handle.closest('[inert]') && !document.querySelector(COVERED)) return { list, handle };
  }
  return null;
}
/** Whether a grip's row may move now. @param {{list:SortableList,handle:HTMLElement}} found */
const ready = ({ list, handle }) => list.ready?.(handle) ?? true;

function stop() {
  if (!sorting) return;
  const current = sorting; sorting = null;
  cancelAnimationFrame(current.frame ?? 0); current.row.classList.remove('is-sorting'); current.ghost?.remove(); current.marker?.remove();
  document.body.classList.remove('list-sorting');
  try { current.handle.releasePointerCapture(current.pointerId); } catch { /* The pointer already left. */ }
}

/** Where the held row would land, which the line shows. */
function locate() {
  const s = sorting; if (!s?.active || !s.ghost || !s.marker) return;
  const zone = s.row.closest(s.list.list), bounds = zone?.getBoundingClientRect();
  if (!zone || !bounds || !s.row.isConnected) { stop(); return; }
  s.ghost.style.left = Math.min(innerWidth - 210, Math.max(8, s.x + 12)) + 'px'; s.ghost.style.top = Math.max(8, Math.min(innerHeight - 48, s.y + 12)) + 'px';
  s.target = null; s.marker.hidden = true;
  if (s.x < bounds.left || s.x > bounds.right || s.y < bounds.top || s.y > bounds.bottom) return;
  const candidates = [...zone.querySelectorAll(s.list.row)].filter(row => row !== s.row);
  const target = candidates.find(row => s.y < row.getBoundingClientRect().bottom) || candidates.at(-1); if (!target) return;
  const r = target.getBoundingClientRect(); s.target = target; s.after = s.y > r.top + r.height / 2;
  // A row wider than its list, such as a Roadmap lane, gets a line only as wide as the list.
  const left = Math.max(r.left, bounds.left), right = Math.min(r.right, bounds.right);
  s.marker.hidden = false; Object.assign(s.marker.style, { left: left + 'px', top: (s.after ? r.bottom + 4 : r.top - 4) + 'px', width: right - left + 'px' });
}

function scroll() {
  const s = sorting; if (!s?.active) return; if (!s.row.isConnected) { stop(); return; }
  const panel = s.row.closest(s.list.scroll), r = panel?.getBoundingClientRect();
  if (panel && r && s.x >= r.left && s.x <= r.right) { const amount = s.y < r.top + 56 ? -10 : s.y > r.bottom - 56 ? 10 : 0; if (amount) panel.scrollTop += amount; }
  locate(); if (sorting) s.frame = requestAnimationFrame(scroll);
}

function listen() {
  document.addEventListener('pointerdown', event => {
    // A second finger, as in a pinch, ends the drag instead of moving the row on.
    if (sorting && event.pointerId !== sorting.pointerId) { stop(); return; }
    const found = event.button === 0 ? gripOf(event.target) : null; if (!found || !ready(found)) return;
    const { list, handle } = found, row = handle.closest(list.row); if (!row) return;
    stop(); sorting = { list, handle, row, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    handle.focus({ preventScroll: true }); try { handle.setPointerCapture(event.pointerId); } catch { /* jsdom and old browsers. */ }
  });
  document.addEventListener('pointermove', event => {
    const s = sorting; if (!s || event.pointerId !== s.pointerId) return; s.x = event.clientX; s.y = event.clientY;
    if (!s.active && Math.hypot(s.x - s.startX, s.y - s.startY) < 6) return;
    event.preventDefault();
    if (!s.active) {
      s.active = true; s.row.classList.add('is-sorting'); document.body.classList.add('list-sorting');
      s.ghost = document.createElement('div'); s.ghost.className = 'sort-label'; s.ghost.textContent = s.list.label(s.row); s.ghost.setAttribute('aria-hidden', 'true');
      s.marker = document.createElement('div'); s.marker.className = 'sort-marker'; s.marker.setAttribute('aria-hidden', 'true');
      document.body.append(s.ghost, s.marker); scroll();
    }
    locate();
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    const s = sorting; if (!s || event.pointerId !== s.pointerId) return;
    locate(); stop();
    if (s.active && s.target) s.list.move(s.handle, s.target, !!s.after);
    // WebKit takes focus off a pressed button, so the grip gets it back, as after the arrow keys.
    if (s.active && s.handle.isConnected) s.handle.focus({ preventScroll: true });
  });
  document.addEventListener('pointercancel', stop); window.addEventListener('blur', stop); window.addEventListener('hashchange', stop);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && sorting) { event.preventDefault(); event.stopImmediatePropagation(); stop(); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const found = gripOf(event.target); if (!found) return;
    const { list, handle } = found, zone = handle.closest(list.list), row = handle.closest(list.row); if (!zone || !row) return;
    // The key belongs to the grip even while its row may not move, so the page doesn't scroll instead.
    event.preventDefault();
    if (!ready(found)) return;
    const rows = [...zone.querySelectorAll(list.row)], index = rows.indexOf(row);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1), target = rows[next];
    if (target && target !== row) list.move(handle, target, next > index);
  }, true);
}

/** Let the grips of `list` move its rows. @param {SortableList} list */
export function sortable(list) {
  if (!lists.length) listen();
  lists.push(list);
}
