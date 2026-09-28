// @ts-check

import { actionErrorFeedback, formFieldName, retryDelayMs } from './action-feedback.js';

/** @type {WeakMap<object,{until:number,timer:ReturnType<typeof setTimeout>,buttons:Set<any>} >} */
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
  if (previous) clearTimeout(previous.timer);
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
    for (const button of buttons) if (button.isConnected) button.disabled = false;
    const notice = form.querySelector?.('.server-feedback');
    if (notice?.isConnected) notice.textContent = 'You can try again now.';
  };
  retryGates.set(form, {until, buttons, timer:setTimeout(release, Math.min(delay, 2_147_000_000))});
  return delay;
}

/** Show one local error and leave the user's entries intact. */
/** @param {any} form @param {unknown} error @param {any} [app] @param {{message?:string}} [options] */
export function presentFormError(form, error, app, {message} = {}) {
  if (!form?.isConnected) return false;
  const feedback = actionErrorFeedback(error);
  if (feedback.silent) return true;
  const copy = message ?? feedback.message;
  const field = feedback.field && formFieldName(feedback.field);
  holdFormRetry(form, error);
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
  return true;
}
