// @ts-check

/**
 * Delegated actions for the app's own markup, in place of inline event
 * handlers. An element names the method its click runs in `data-action`, and
 * the method another event runs in `data-action-<event>`, such as
 * `data-action-keydown`: a method of `App`, or `Recovery.<method>`. The
 * arguments are a JSON array in `data-args` (`data-args-<event>`), in which
 * {"$":"event"}, {"$":"element"}, {"$":"value"} and {"$":"checked"} stand for
 * the event, the element, and the element's value and checked state. With
 * `data-key`, a keydown action runs only for that key, and not while text is
 * being composed or the key repeats.
 *
 * Actions run as inline handlers did: from the target out to the document,
 * until one stops propagation, which also stops the event's later listeners.
 * During the call `event.currentTarget` is the element, a clicked button has
 * focus, and a result of `false` prevents the default. Focus and hover actions
 * run for their own element only. A file input's actions run even when a
 * render removed the input while its picker was open, as its inline handlers
 * did. Nothing runs inside rendered Markdown or a file preview, and a name
 * that isn't a method of `App` or `Recovery` does nothing.
 */

const BUBBLING = Object.freeze(['click', 'submit', 'input', 'change', 'keydown', 'dragstart', 'dragend', 'dragover', 'dragleave', 'drop']);
const OWN = Object.freeze(['focus', 'blur', 'mouseenter', 'mouseleave']);
/** The events an action can answer. */
export const actionEvents = Object.freeze([...BUBBLING, ...OWN]);
const UNTRUSTED = '.markdown-body,.file-preview-body';

/** @type {Record<string,(event:Event,element:any)=>unknown>} */
const PLACEHOLDERS = {
  event: (event) => event,
  element: (_event, element) => element,
  value: (_event, element) => element.value,
  checked: (_event, element) => element.checked,
};

/** @param {unknown} arg @param {Event} event @param {Element} element */
function resolve(arg, event, element) {
  const name = /** @type {{$?:unknown}} */ (arg)?.$;
  return arg && typeof arg === 'object' && Object.keys(arg).length === 1 && typeof name === 'string' && Object.hasOwn(PLACEHOLDERS, name) ? PLACEHOLDERS[name](event, element) : arg;
}

/**
 * Listen on `doc` for the events actions answer. Install it before any other
 * listener on the document, so actions run first there, as inline handlers
 * ran before the document heard the event. Returns a function that removes it.
 * @param {Document} [doc]
 * @param {{onError?:(error:unknown,element:Element)=>void}} [options]
 */
export function installViewActions(doc = document, { onError = (error, element) => console.error('Rejected view action', element, error) } = {}) {
  const view = /** @type {any} */ (doc.defaultView);

  /** Run `element`'s action for `event`. @param {Event} event @param {Element} element */
  function run(event, element) {
    const type = event.type, suffix = type === 'click' ? '' : `-${type}`;
    const name = element.getAttribute(`data-action${suffix}`);
    if (!name || element.closest(UNTRUSTED)) return;
    const target = /** @type {HTMLElement} */ (element), key = element.getAttribute('data-key'), press = /** @type {KeyboardEvent} */ (event);
    // Some browsers don't focus a clicked button; a dialog it opens returns focus to it.
    if (type === 'click' && element.matches('button') && !(/** @type {HTMLButtonElement} */ (element).disabled)) target.focus({ preventScroll: true });
    if (type === 'keydown' && key !== null && (press.key !== key || press.isComposing || press.keyCode === 229 || press.repeat)) return;
    const [ownerName, method] = name.startsWith('Recovery.') ? ['Recovery', name.slice('Recovery.'.length)] : ['App', name];
    const owner = view?.[ownerName];
    if (!owner || !Object.hasOwn(owner, method) || typeof owner[method] !== 'function') return;
    let args;
    try {
      args = JSON.parse(element.getAttribute(`data-args${suffix}`) ?? '[]');
      if (!Array.isArray(args)) throw new TypeError('Action arguments must be a JSON array');
    } catch (error) { onError(error, element); return; }
    if ((method === 'openModal' || method === 'openPeek') && element.matches('button,[role=button]')) target.focus({ preventScroll: true });
    const values = args.map((arg) => resolve(arg, event, element));
    // The methods read their element where inline handlers put it.
    Object.defineProperty(event, 'currentTarget', { configurable: true, value: element });
    let result;
    try { result = owner[method](...values); }
    finally { Reflect.deleteProperty(event, 'currentTarget'); }
    if (result === false) event.preventDefault();
  }

  /** @param {Event} event */
  function bubble(event) {
    for (const node of event.composedPath()) {
      if (/** @type {Node} */ (node).nodeType !== 1) continue;
      run(event, /** @type {Element} */ (node));
      if (event.cancelBubble) { event.stopImmediatePropagation(); return; }
    }
  }
  /** @param {Event} event */
  function own(event) {
    const target = /** @type {Node|null} */ (event.target);
    if (target?.nodeType === 1) run(event, /** @type {Element} */ (target));
  }

  // A file input answers once its picker closes, when a render may have
  // replaced it, and the document never hears an event on a removed element.
  // So every file input also listens itself, for the time it is removed.
  const watched = new WeakSet();
  /** @param {Element|Document} root */
  function watchFileInputs(root) {
    const inputs = [...root.querySelectorAll('input[type=file]')];
    if (root.nodeType === 1 && /** @type {Element} */ (root).matches('input[type=file]')) inputs.push(/** @type {Element} */ (root));
    for (const input of inputs) {
      if (watched.has(input)) continue;
      watched.add(input);
      for (const type of ['input', 'change']) input.addEventListener(type, (event) => { if (!input.isConnected) bubble(event); });
    }
  }
  const observer = new view.MutationObserver((/** @type {MutationRecord[]} */ records) => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) watchFileInputs(/** @type {Element} */ (node));
  });
  observer.observe(doc, { childList: true, subtree: true });
  watchFileInputs(doc);

  for (const type of BUBBLING) doc.addEventListener(type, bubble);
  // These don't bubble, so the document hears them while they travel down to their element.
  for (const type of OWN) doc.addEventListener(type, own, true);
  return () => {
    observer.disconnect();
    for (const type of BUBBLING) doc.removeEventListener(type, bubble);
    for (const type of OWN) doc.removeEventListener(type, own, true);
  };
}
