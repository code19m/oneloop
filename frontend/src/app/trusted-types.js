// @ts-check

/**
 * Trusted Types policies. The page writes HTML only from the app's own
 * templates, which escape what they insert, through the `oneloop` policy.
 * A string script URL, such as pdf.js starting its worker, passes only when it
 * points into the app's own script folders. Every other string sent to an
 * HTML or script sink is refused. Without Trusted Types, strings pass as they
 * are.
 */

const SCRIPT_FOLDER = /^\/(?:v\/[^/]+\/)?(?:src|views|vendor)\//;

/** @type {{createHTML(source:string):unknown,createScriptURL(url:string):unknown}|null} */
let policy = null;

/** @param {string} value @param {string} base */
export function appScriptURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch { return null; }
  return url.origin === new URL(base).origin && SCRIPT_FOLDER.test(url.pathname) ? url.href : null;
}

/** Create the policies once, before anything writes HTML or loads a script. @param {any} [win] */
export function installTrustedTypes(win = globalThis) {
  const factory = win.trustedTypes;
  if (policy || typeof factory?.createPolicy !== 'function') return;
  const base = () => win.location.href;
  policy = factory.createPolicy('oneloop', {
    createHTML: (/** @type {string} */ source) => source,
    createScriptURL: (/** @type {string} */ value) => appScriptURL(value, base()),
  });
  factory.createPolicy('default', { createScriptURL: (/** @type {string} */ value) => appScriptURL(value, base()) });
}

/** HTML from the app's own templates, ready for an HTML sink. @param {string} source */
export function trustedHTML(source) {
  return /** @type {string} */ (policy ? policy.createHTML(source) : source);
}

/**
 * Write the app's own markup into `element`, or into a template's content:
 * parsed through the `oneloop` policy in an inert template, then moved in.
 * The views reach it as `UIHTML`.
 * @param {Element} element @param {string} source
 */
export function setTrustedHTML(element, source) {
  const template = element.ownerDocument.createElement('template');
  template.innerHTML = trustedHTML(source);
  (element.tagName === 'TEMPLATE' ? /** @type {HTMLTemplateElement} */ (element).content : element).replaceChildren(template.content);
}

/** A script URL inside the app's own folders, ready for a script sink. @param {string} url */
export function trustedScriptURL(url) {
  return /** @type {string} */ (policy ? policy.createScriptURL(url) : url);
}
