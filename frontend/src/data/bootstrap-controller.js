// @ts-check

import { hydrateLegacyData } from './projection-store.js';

/** Guards navigation against stale bootstrap responses. */
export function createBootstrapController({ api, data, onReady = (_projection) => {}, onError = (_error) => {} }) {
  let generation = 0;
  let controller = null;
  return Object.freeze({
    async load(scope = {}) {
      const current = ++generation;
      controller?.abort();
      controller = new AbortController();
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
    },
    cancel() { generation++; controller?.abort(); },
    get generation() { return generation; },
  });
}
