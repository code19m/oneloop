// @ts-check

/**
 * One tooltip for details that the browser's own `title` showed only on mouse
 * hover: a full time, the reason a task is blocked, a name that is cut off.
 * An element with `data-tip` shows that text on hover after a short delay, on
 * keyboard focus and on a tap; Escape, a press elsewhere, scrolling and
 * resizing hide it, and the pointer can move onto it. With
 * `data-tip-overflow`, it shows only while the element's text is cut off or
 * hidden. A tap shows a tip unless the element is a control, or sits inside one
 * without being focusable itself, so tapping a card still opens it; a
 * focusable tip, such as a Blocked badge, takes the tap instead.
 * @param {Document} [doc]
 * @param {{delay?:number,hideDelay?:number}} [options]
 */
export function installTooltips(doc = document, { delay = 300, hideDelay = 120 } = {}) {
  const win = /** @type {Window & typeof globalThis} */ (doc.defaultView);
  /** @type {HTMLElement|null} */ let tip = null;
  /** @type {HTMLElement|null} */ let anchor = null;
  /** @type {string|null} */ let describedBy = null;
  let showTimer = 0, hideTimer = 0, touch = false;
  const observer = new win.MutationObserver(() => { if (anchor && !anchor.isConnected) hide(); });

  const anchorOf = (/** @type {EventTarget|null} */ target) => /** @type {HTMLElement|null} */ (target instanceof win.Element ? target.closest('[data-tip]') : null);
  const CONTROL = 'button,a[href],input,select,textarea,summary,label,[role="button"],[onclick],[data-oneloop-onclick]';

  /** Whether some text in the element is cut off, or not shown at all. @param {HTMLElement} element */
  function cutOff(element) {
    for (const item of [element, ...element.querySelectorAll('*')]) {
      if (!item.textContent?.trim() || item.matches('.sr-only')) continue;
      if (!item.getClientRects().length || item.scrollWidth > item.clientWidth + 1 || item.scrollHeight > item.clientHeight + 1) return true;
    }
    return false;
  }

  function place() {
    if (!tip || !anchor) return;
    const box = anchor.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
    const below = box.bottom + 6 + height <= win.innerHeight - 8;
    tip.style.left = `${Math.max(8, Math.min(box.left + box.width / 2 - width / 2, win.innerWidth - width - 8))}px`;
    tip.style.top = `${Math.max(8, below ? box.bottom + 6 : box.top - height - 6)}px`;
  }

  function show(/** @type {HTMLElement} */ element) {
    win.clearTimeout(showTimer); win.clearTimeout(hideTimer);
    const text = element.dataset.tip ?? '';
    if (!text || !element.isConnected || element.hasAttribute('data-tip-overflow') && !cutOff(element)) { hide(); return; }
    if (anchor !== element) hide();
    if (!tip) { tip = doc.createElement('div'); tip.id = 'app-tip'; tip.className = 'app-tip'; tip.setAttribute('role', 'tooltip'); }
    tip.textContent = text;
    if (!tip.isConnected) doc.body.append(tip);
    anchor = element;
    describedBy = element.getAttribute('aria-describedby');
    element.setAttribute('aria-describedby', [describedBy, tip.id].filter(Boolean).join(' '));
    place();
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  function hide() {
    win.clearTimeout(showTimer); win.clearTimeout(hideTimer);
    observer.disconnect();
    if (anchor && tip && anchor.getAttribute('aria-describedby')?.split(/\s+/).includes(tip.id)) {
      if (describedBy) anchor.setAttribute('aria-describedby', describedBy); else anchor.removeAttribute('aria-describedby');
    }
    anchor = null; describedBy = null;
    tip?.remove();
  }

  const scheduleHide = () => { win.clearTimeout(hideTimer); hideTimer = win.setTimeout(hide, hideDelay); };

  doc.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const element = anchorOf(event.target);
    if (tip?.contains(/** @type {Node} */ (event.target))) { win.clearTimeout(hideTimer); return; }
    if (!element) return;
    win.clearTimeout(hideTimer);
    if (element === anchor) return;
    win.clearTimeout(showTimer);
    showTimer = win.setTimeout(() => show(element), delay);
  });
  // Leaving the element or its tip, other than for one another, hides the tip.
  doc.addEventListener('pointerout', (event) => {
    if (event.pointerType !== 'mouse') return;
    const next = /** @type {Node|null} */ (event.relatedTarget);
    const element = tip?.contains(/** @type {Node} */ (event.target)) ? anchor : anchorOf(event.target);
    if (!element || element.contains(next) || tip?.contains(next)) return;
    win.clearTimeout(showTimer);
    if (element === anchor) scheduleHide();
  });
  doc.addEventListener('focusin', (event) => {
    const element = anchorOf(event.target);
    if (element && element === event.target && element.matches(':focus-visible')) show(element);
  });
  doc.addEventListener('focusout', (event) => { if (anchor && event.target === anchor) hide(); });
  doc.addEventListener('pointerdown', (event) => {
    touch = event.pointerType === 'touch' || event.pointerType === 'pen';
    if (anchor && !anchor.contains(/** @type {Node} */ (event.target)) && !tip?.contains(/** @type {Node} */ (event.target))) hide();
  }, true);
  doc.addEventListener('click', (event) => {
    if (!touch) return;
    const element = anchorOf(event.target);
    if (!element || element.matches(CONTROL)) return;
    const focusable = element.tabIndex >= 0;
    if (!focusable && element.parentElement?.closest(CONTROL)) return;
    if (focusable) { event.preventDefault(); event.stopPropagation(); }
    if (anchor === element) hide(); else show(element);
  }, true);
  // Escape closes the tip first, so the dialog or menu under it stays open.
  win.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !anchor) return;
    event.preventDefault(); event.stopImmediatePropagation(); hide();
  }, true);
  doc.addEventListener('scroll', (event) => { if (anchor && !tip?.contains(/** @type {Node} */ (event.target))) hide(); }, true);
  win.addEventListener('resize', () => hide());
  return Object.freeze({ hide, get anchor() { return anchor; } });
}
