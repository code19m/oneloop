// @ts-check

/** Helpers for the app's HTML templates, shared by the views and the modules in src/. */

const ESCAPES = /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/** Escape a value for a template's text or a quoted attribute. @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/**
 * The attributes that make a click on the element run `App[method](...args)`
 * through src/app/view-actions.js. `UIAction.on(type, method, ...args)` does the
 * same for another event. `UIAction.event`, `.element`, `.value` and `.checked`
 * stand for the event, the element, and the element's value and checked state.
 * @param {string} method @param {...unknown} args
 */
export function UIAction(method, ...args) { return UIAction.on('click', method, ...args); }
/** @param {string} type @param {string} method @param {...unknown} args */
UIAction.on = (type, method, ...args) => {
  const suffix = type === 'click' ? '' : `-${type}`;
  return `data-action${suffix}="${escapeHtml(method)}"${args.length ? ` data-args${suffix}="${escapeHtml(JSON.stringify(args))}"` : ''}`;
};
UIAction.event = Object.freeze({ $: 'event' });
UIAction.element = Object.freeze({ $: 'element' });
UIAction.value = Object.freeze({ $: 'value' });
UIAction.checked = Object.freeze({ $: 'checked' });
