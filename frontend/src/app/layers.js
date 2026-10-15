// @ts-check

/** Helpers for layers above the page: modal dialogs, keeping focus in them, and placing a layer by its anchor. */

/**
 * Keep Tab inside a layer: Tab on its last control moves to the first, and
 * Shift+Tab on the first to the last. `controls` are the layer's controls in
 * order; other keys pass.
 * @param {KeyboardEvent} event @param {HTMLElement[]} controls
 */
export function trapFocus(event, controls) {
  if (event.key !== 'Tab' || !controls.length) return;
  const first = controls[0], last = controls[controls.length - 1], active = globalThis.document.activeElement;
  if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}

/**
 * Show `form` as a modal dialog, in a layer with a scrim over the page. The
 * `inert` elements, such as #app, take no input while it shows. Tab stays
 * among the form's enabled inputs and buttons, and Escape runs `onEscape`.
 * `close()` takes the layer away and gives each element back the inert state
 * it had; focus is the caller's to return.
 * @param {{form:HTMLElement,className?:string,inert:(HTMLElement|null)[],onEscape:()=>void}} options
 */
export function openDialog({ form, className = 'confirmation-layer', inert, onEscape }) {
  const doc = globalThis.document;
  const layer = doc.createElement('div'), scrim = doc.createElement('div'), wrap = doc.createElement('div');
  layer.className = className; scrim.className = 'scrim'; wrap.className = 'confirmation-wrap';
  wrap.append(form); layer.append(scrim, wrap);
  /** @type {[HTMLElement,boolean][]} */
  const inerted = inert.filter((element) => !!element).map((element) => [element, element.inert]);
  for (const [element] of inerted) element.inert = true;
  /** @param {KeyboardEvent} event */
  const keydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onEscape(); }
    else trapFocus(event, /** @type {HTMLElement[]} */ ([...form.querySelectorAll('input,button')]).filter((control) => !/** @type {HTMLButtonElement} */ (control).disabled));
  };
  doc.addEventListener('keydown', keydown, true);
  doc.body.append(layer);
  return Object.freeze({
    layer,
    close() {
      doc.removeEventListener('keydown', keydown, true);
      layer.remove();
      for (const [element, wasInert] of inerted) element.inert = wasInert;
    },
  });
}

/**
 * Where a layer of `element`'s size goes beside `box`, the anchor's box:
 * below it when it fits, otherwise above, `gap` pixels away, lined up with
 * its start, center or end, and at least 8 pixels inside the viewport.
 * @param {{left:number,right:number,top:number,bottom:number,width:number}} box
 * @param {HTMLElement} element
 * @param {{align?:'start'|'center'|'end',gap?:number}} [options]
 */
export function placeNear(box, element, { align = 'start', gap = 6 } = {}) {
  const view = element.ownerDocument.defaultView, width = element.offsetWidth, height = element.offsetHeight;
  const viewWidth = view?.innerWidth ?? 0, viewHeight = view?.innerHeight ?? 0;
  const x = align === 'center' ? box.left + box.width / 2 - width / 2 : align === 'end' ? box.right - width : box.left;
  const below = box.bottom + gap + height <= viewHeight - 8;
  return {
    left: Math.max(8, Math.min(x, viewWidth - width - 8)),
    top: Math.max(8, Math.min(below ? box.bottom + gap : box.top - height - gap, viewHeight - height - 8)),
  };
}
