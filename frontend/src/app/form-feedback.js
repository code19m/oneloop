// @ts-check

import { actionErrorFeedback, formFieldName, retryDelayMs, retryMessage } from './action-feedback.js';

/** Apply completion effects only while the submitting editor is still open. */
export function completeForm(form, complete) {
  if (!form) return false;
  const editor = form.closest?.('.modal,.peek');
  if (!editor) {
    if (form.isConnected === false) return false;
  } else {
    const current = form.ownerDocument.querySelector('.modal') ?? form.ownerDocument.querySelector('.peek');
    // A re-render replaces the editor's nodes but keeps its open generation.
    const generation = editor.dataset?.openGeneration;
    if (current !== editor && !(generation && current?.dataset?.openGeneration === generation)) return false;
  }
  complete();
  return true;
}

/** @typedef {{until:number,timer:ReturnType<typeof setTimeout>,buttons:Set<any>,error:unknown,text?:string,ticker?:ReturnType<typeof setTimeout>}} RetryGate */
/** @type {WeakMap<object,RetryGate>} */
const retryGates = new WeakMap();

/** @param {any} form */
export function isFormRetryPending(form) {
  return !!form && (retryGates.get(form)?.until ?? 0) > Date.now();
}

/** Keep text fields usable while a server-specified retry delay blocks another submit. */
/** @param {any} form @param {unknown} error */
export function holdFormRetry(form, error) {
  const value = /** @type {any} */ (error);
  if (!form || ![429,503].includes(value?.status) && !['rate_limited','unavailable'].includes(value?.code)) return 0;
  const delay = retryDelayMs(error);
  if (delay <= 0) return 0;
  const until = Date.now() + delay;
  const previous = retryGates.get(form);
  if (previous && previous.until >= until) return previous.until - Date.now();
  if (previous) { clearTimeout(previous.timer); clearTimeout(previous.ticker); }
  const buttons = previous?.buttons ?? new Set();
  for (const button of form.querySelectorAll?.('button') ?? []) {
    if (button.type === 'submit' || button.matches?.('.primary') || button.dataset?.save) {
      buttons.add(button);
      button.disabled = true;
    }
  }
  const release = () => {
    const current = retryGates.get(form);
    if (!current || current.until !== until) return;
    const remaining = until - Date.now();
    if (remaining > 0) {
      current.timer = setTimeout(release, Math.min(remaining, 2_147_000_000));
      return;
    }
    retryGates.delete(form);
    clearTimeout(current.ticker);
    for (const button of buttons) if (button.isConnected) button.disabled = false;
    const notice = form.querySelector?.('.server-feedback');
    if (notice?.isConnected) notice.textContent = 'You can try again now.';
  };
  retryGates.set(form, {until, buttons, error, timer:setTimeout(release, Math.min(delay, 2_147_000_000))});
  return delay;
}

/** Count the wait down once a second, while the notice still shows the retry message. */
/** @param {any} form @param {any} notice */
function countDown(form, notice) {
  const gate = retryGates.get(form);
  if (!gate) return;
  clearTimeout(gate.ticker);
  gate.text = notice.textContent;
  const schedule = () => { gate.ticker = setTimeout(tick, (gate.until - Date.now()) % 1000 || 1000); };
  const tick = () => {
    const remaining = gate.until - Date.now();
    if (retryGates.get(form) !== gate || !notice.isConnected || notice.textContent !== gate.text || remaining <= 0) return;
    gate.text = notice.textContent = retryMessage(gate.error, remaining);
    schedule();
  };
  schedule();
}

/** Show one local error and leave the user's entries intact. */
/** @param {any} form @param {unknown} error @param {any} [app] @param {{message?:string}} [options] */
export function presentFormError(form, error, app, {message} = {}) {
  if (!form?.isConnected) return false;
  const feedback = actionErrorFeedback(error);
  if (feedback.silent) return true;
  const copy = message ?? feedback.message;
  const field = feedback.field && formFieldName(feedback.field);
  const waiting = holdFormRetry(form, error) > 0;
  if (field && app?.fieldError && form.querySelector?.(`[name="${field}"]`)) {
    form.querySelector?.('.server-feedback')?.remove();
    app.fieldError(form, field, copy);
    return true;
  }
  let notice = form.querySelector?.('.server-feedback');
  if (!notice) {
    notice = document.createElement('p');
    notice.className = 'save-feedback server-feedback';
    notice.setAttribute('data-server-feedback', '');
    notice.setAttribute('role', 'alert');
    form.append(notice);
  }
  notice.textContent = copy;
  if (waiting && copy === feedback.message) countDown(form, notice);
  return true;
}
