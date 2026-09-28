// @ts-check

/** Explicit boundary for discussion/files/live-update modules owned outside app composition. */
export function createRuntimeHooks({ api, gateway, data, reload }) {
  const listeners = new Set();
  return Object.freeze({
    api,
    data,
    commands: Object.freeze({
      execute: (...args) => gateway.execute(...args),
      retry: (interactionKey) => gateway.retry(interactionKey),
      hasUncertain: (interactionKey) => gateway.hasUncertain(interactionKey),
      discard: (interactionKey) => gateway.discard(interactionKey),
    }),
    reload,
    publish(change) { for (const listener of [...listeners]) listener(change); },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Expected a store listener');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
