// @ts-nocheck: the views are untyped, and tsc reaches them through boot.js.
/* Redrawing a list in place: rows that stay keep their elements, so focus,
   a pressed button and loaded images survive. */

import { UIMotion } from '../../src/app/motion.js';

/**
 * Make `current` look like `next` and return it. Its elements and their
 * listeners stay, so a row keeps focus and images while its text changes.
 * Inline `on…` attributes are never copied.
 */
export function patchInPlace(current, next) {
  for (const attribute of [...current.attributes])
    if (!attribute.name.startsWith('on') && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of next.attributes)
    if (!attribute.name.startsWith('on') && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  const children = [...next.childNodes];
  children.forEach((child, index) => {
    const old = current.childNodes[index];
    if (!old) { current.append(child); return; }
    if (old.nodeType !== child.nodeType || old.nodeName !== child.nodeName) { old.replaceWith(child); return; }
    if (child.nodeType === Node.ELEMENT_NODE) patchInPlace(old, child);
    else if (old.nodeValue !== child.nodeValue) old.nodeValue = child.nodeValue;
  });
  while (current.childNodes.length > children.length) current.lastChild.remove();
  return current;
}

/**
 * Make `rows` the children of `list`, in order, and remove the rest. Only rows
 * whose place changed move: browsers cancel a click whose pressed element
 * left the document, even briefly.
 */
export function placeRows(list, rows) {
  let cursor = list.firstChild;
  for (const row of rows) {
    if (row === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(row, cursor);
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}

/**
 * Fade out copies of rows that left `list`, where they were drawn, in an inert
 * layer `height` tall over the list. `gone` pairs each row with its old
 * rectangle, and `listRect` is where the list was; rows outside `viewport`
 * get no copy.
 */
export function fadeOutRows(list, gone, { listRect, viewport, height, className }) {
  if (UIMotion.reduced()) return;
  const layer = document.createElement('div');
  if (className) layer.className = className;
  layer.inert = true; layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { position: 'absolute', inset: '0 0 auto', height: height + 'px', pointerEvents: 'none' });
  for (const [row, rect] of gone) {
    if (!rect?.height || viewport && (rect.bottom < viewport.top || rect.top > viewport.bottom)) continue;
    const ghost = UIMotion.ghost(row);
    Object.assign(ghost.style, { position: 'absolute', top: rect.top - listRect.top + 'px', left: rect.left - listRect.left + 'px', width: rect.width + 'px', height: rect.height + 'px', margin: '0' });
    layer.append(ghost);
  }
  if (!layer.children.length) return;
  list.append(layer);
  const animation = UIMotion.animate(layer, [{ opacity: 1 }, { opacity: 0 }], 140);
  if (animation) animation.finished.then(() => layer.remove(), () => layer.remove());
  else layer.remove();
}
