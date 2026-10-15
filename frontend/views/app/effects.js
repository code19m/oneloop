// @ts-nocheck: TypeScript checks src/ only; see frontend/README.md.
/* Presentation effects of the views: content fades, exit copies and layout
   moves. Data changes never wait for them, and they own no application callbacks. */

export const MOTION = { quick: 140, normal: 180, ease: 'cubic-bezier(.2,.8,.2,1)' };
export const uiAnimations = new WeakMap();
export const exitVisuals = new Set();
const canAnimate = (el) => !!el?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export function uiAnimate(el, frames, duration = MOTION.normal) {
  uiAnimations.get(el)?.cancel();
  if (!canAnimate(el)) return;
  const animation = el.animate(frames, { duration, easing: MOTION.ease });
  uiAnimations.set(el, animation);
  animation.finished.then(() => { if (uiAnimations.get(el) === animation) uiAnimations.delete(el); }, () => {});
  return animation;
}
export function fadeContent(el) {
  if (el) uiAnimate(el, [{ opacity: .35 }, { opacity: 1 }]);
}
export function animateHeight(el, before) {
  if (!el) return;
  const after = el.getBoundingClientRect().height;
  if (Math.abs(before - after) > 1) uiAnimate(el, [{ height: before + 'px' }, { height: after + 'px' }]);
}
export function exitVisual(source) {
  if (!canAnimate(source)) return;
  const rect = source.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return;
  // A presentation-only copy cannot intercept input, reuse IDs, or match app selectors.
  const clone = source.cloneNode(true);
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  const properties = ['display','position','box-sizing','width','height','min-width','min-height','max-width','max-height','padding','margin','border','border-radius','background','box-shadow','backdrop-filter','color','font','line-height','letter-spacing','text-align','white-space','overflow','text-overflow','flex','flex-direction','align-items','justify-content','gap','opacity'];
  copies.forEach((copy, i) => {
    const original = originals[i], style = getComputedStyle(original);
    [...copy.attributes].forEach((attr) => {
      if (attr.name === 'id' || attr.name === 'class' || attr.name === 'name' || attr.name.startsWith('data-') || attr.name.startsWith('on') || attr.name === 'draggable') copy.removeAttribute(attr.name);
    });
    properties.forEach((property) => copy.style.setProperty(property, style.getPropertyValue(property)));
    if ('value' in original) copy.value = original.value;
    copy.scrollTop = original.scrollTop;
  });
  clone.className = 'motion-exit'; clone.inert = true; clone.setAttribute('aria-hidden', 'true');
  Object.assign(clone.style, { position:'fixed', left:rect.left+'px', top:rect.top+'px', width:rect.width+'px', height:rect.height+'px', margin:'0', minWidth:'0', maxWidth:'none', minHeight:'0', maxHeight:'none', pointerEvents:'none', zIndex:'96', animation:'none' });
  if (exitVisuals.size >= 4) { const oldest = exitVisuals.values().next().value; uiAnimations.get(oldest)?.cancel(); oldest.remove(); exitVisuals.delete(oldest); }
  document.body.append(clone); exitVisuals.add(clone);
  const animation = uiAnimate(clone, [{ opacity: getComputedStyle(source).opacity }, { opacity: 0 }], MOTION.quick);
  const cleanup = () => { clone.remove(); exitVisuals.delete(clone); };
  if (animation) animation.finished.then(cleanup, cleanup); else cleanup();
}

// Layout motion uses the current painted positions, so a new drag can interrupt it.
export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const layoutAnimations = new WeakMap();
const motionKey = (el) => el.dataset.task || el.dataset.track;
export const motionRects = (selector) => new Map([...document.querySelectorAll(selector)].map((el) => [motionKey(el), el.getBoundingClientRect()]));
export function animateLayout(before, selector, skipId) {
  document.querySelectorAll(selector).forEach((el) => {
    const from = before.get(motionKey(el));
    layoutAnimations.get(el)?.cancel();
    if (!from || motionKey(el) === skipId || reducedMotion.matches) return;
    const to = el.getBoundingClientRect();
    const x = from.left - to.left, y = from.top - to.top;
    if (Math.abs(x) + Math.abs(y) < 1) return;
    const animation = el.animate([
      { transform: `translate(${x}px, ${y}px)` },
      { transform: 'translate(0, 0)' },
    ], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    layoutAnimations.set(el, animation);
  });
}
