// @ts-check

import { hydrateLegacyData } from './projection-store.js';

/**
 * Guards navigation against stale bootstrap responses. A newer load replaces
 * an older one, except that a background (live) load never replaces a load
 * someone started: callers wait for `idle()` and refresh what is shown then.
 */
export function createBootstrapController({ api, data, onReady = (_projection) => {}, onError = (_error) => {} }) {
  let generation = 0;
  let controller = null;
  /** @type {Promise<unknown>|null} */ let foreground = null;
  return Object.freeze({
    async load(scope = {}) {
      if (scope.background && foreground) return { stale: true };
      const current = ++generation;
      controller?.abort();
      controller = new AbortController();
      const work = (async () => {
        try {
          const projection = await api.bootstrap({ ...scope, signal: controller.signal });
          if (current !== generation) return { stale: true };
          hydrateLegacyData(data, projection);
          onReady(projection);
          return { stale: false, projection };
        } catch (error) {
          if (current !== generation || error?.code === 'aborted') return { stale: true };
          onError(error);
          throw error;
        }
      })();
      if (!scope.background) {
        const pending = work.catch(() => {}).finally(() => { if (foreground === pending) foreground = null; });
        foreground = pending;
      }
      return work;
    },
    /** Settles once no load someone started is running and its caller had a turn to apply it. */
    async idle() {
      while (foreground) {
        await foreground;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    cancel() { generation++; controller?.abort(); },
    get generation() { return generation; },
  });
}
