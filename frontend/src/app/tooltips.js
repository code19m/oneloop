// @ts-check

/**
 * One tooltip for details that the browser's own `title` showed only on mouse
 * hover: a full time, the reason a task is blocked, a name that is cut off.
 * An element with `data-tip` shows that text on hover after a short delay, on
 * keyboard focus and on a tap; Escape, a press elsewhere and resizing hide it,
 * and the pointer can move onto it. Scrolling hides it too, unless its
 * element has focus: then the tip moves with it. With `data-tip-overflow`, it
 * shows only while the element's text is cut off or hidden. A tap shows a tip
 * unless the element is a control, or sits inside one, so tapping a card still
 * opens it; a tip marked `data-tip-tap`, such as a Blocked badge, takes the
 * tap instead. A tip marked `data-tip-keyboard` shows on keyboard focus only,
 * such as a Blocked reason on a card's title, for people who can't hover the
 * badge. Screen readers hear the tip as a description, unless it only repeats
 * the element's name or description.
 * @param {Document} [doc]
 * @param {{delay?:number,hideDelay?:number}} [options]
 */
export function installTooltips(doc = document, { delay = 300, hideDelay = 120 } = {}) {
  const win = /** @type {Window & typeof globalThis} */ (doc.defaultView);
  /** @type {HTMLElement|null} */ let tip = null;
  /** @type {HTMLElement|null} */ let anchor = null;
  /** @type {string|null} */ let describedBy = null;
  let showTimer = 0, hideTimer = 0, placeFrame = 0, touch = false, described = false;
  const observer = new win.MutationObserver(() => {
    if (!anchor) return;
    if (!anchor.isConnected) { hide(); return; }
    // A redraw that patches the element in place, such as a live Board update, may drop the description.
    if (described && tip && !anchor.getAttribute('aria-describedby')?.split(/\s+/).includes(tip.id)) describe(anchor);
  });

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

  /** Add the tip to the element's description, after what describes it already. @param {HTMLElement} element */
  function describe(element) {
    if (!tip) return;
    describedBy = element.getAttribute('aria-describedby');
    element.setAttribute('aria-describedby', [describedBy, tip.id].filter(Boolean).join(' '));
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
    // A cut-off name, or a tip that repeats the label or the description, would be heard twice.
    const description = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => id && doc.getElementById(id)?.textContent).join(' ');
    described = !element.hasAttribute('data-tip-overflow') && element.getAttribute('aria-label')?.trim() !== text.trim() && !description.includes(text.trim());
    if (described) describe(element);
    place();
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-describedby'] });
  }

  function hide() {
    win.clearTimeout(showTimer); win.clearTimeout(hideTimer);
    win.cancelAnimationFrame(placeFrame); placeFrame = 0;
    observer.disconnect();
    if (anchor && tip && anchor.getAttribute('aria-describedby')?.split(/\s+/).includes(tip.id)) {
      if (describedBy) anchor.setAttribute('aria-describedby', describedBy); else anchor.removeAttribute('aria-describedby');
    }
    anchor = null; describedBy = null; described = false;
    tip?.remove();
  }

  /** Keep a focused element's tip beside it while the page scrolls; hide it once the element leaves the view. */
  function follow() {
    if (placeFrame) return;
    placeFrame = win.requestAnimationFrame(() => {
      placeFrame = 0;
      if (!anchor) return;
      const box = anchor.getBoundingClientRect();
      const x = Math.min(Math.max(box.left + box.width / 2, 0), win.innerWidth - 1), y = Math.min(Math.max(box.top + box.height / 2, 0), win.innerHeight - 1);
      const top = doc.elementFromPoint?.(x, y);
      const shows = box.bottom > 0 && box.top < win.innerHeight && box.right > 0 && box.left < win.innerWidth && (!top || anchor.contains(top) || !!tip?.contains(top));
      if (shows) place(); else hide();
    });
  }

  const scheduleHide = () => { win.clearTimeout(hideTimer); hideTimer = win.setTimeout(hide, hideDelay); };

  doc.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const element = anchorOf(event.target);
    if (tip?.contains(/** @type {Node} */ (event.target))) { win.clearTimeout(hideTimer); return; }
    if (!element || element.hasAttribute('data-tip-keyboard')) return;
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
    if (!element || element.matches(CONTROL) || element.hasAttribute('data-tip-keyboard')) return;
    const takesTap = element.hasAttribute('data-tip-tap');
    if (!takesTap && element.parentElement?.closest(CONTROL)) return;
    if (takesTap) { event.preventDefault(); event.stopPropagation(); }
    if (anchor === element) hide(); else show(element);
  }, true);
  // Escape closes the tip first, so the dialog or menu under it stays open.
  win.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !anchor) return;
    event.preventDefault(); event.stopImmediatePropagation(); hide();
  }, true);
  doc.addEventListener('scroll', (event) => {
    if (!anchor || tip?.contains(/** @type {Node} */ (event.target))) return;
    // Tab scrolls the element it moves to into view, so a focused element keeps its tip.
    if (anchor.contains(doc.activeElement)) follow(); else hide();
  }, true);
  win.addEventListener('resize', () => hide());
  return Object.freeze({ hide, get anchor() { return anchor; } });
}
