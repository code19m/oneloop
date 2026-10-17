// @ts-check

import { ApiError, prepareCommand } from './api-client.js';
import { reconcileCommandResult } from './projection-store.js';

export function createCommandGateway({ api, data, getScope = () => '', onChange = (_result) => {}, onPending = (_key,_pending) => {}, onError = (_error,_context) => {} }) {
  const uncertain = new Map();
  const inFlight = new Map();
  // How many commands this tab has sent.
  let sent = 0;

  const scopedKey = (scope, interactionKey) => `${scope}\u0000${interactionKey}`;

  const sameIntent=(left,right)=>left.operation===right.operation
    && left.expectedRevision===right.expectedRevision
    && JSON.stringify(left.payload)===JSON.stringify(right.payload);

  function executePrepared(command, interactionKey = command.idempotencyKey, scope = String(getScope() ?? '')) {
    const key = scopedKey(scope, interactionKey);
    const pending=inFlight.get(key);
    if(pending){
      if(sameIntent(pending.command,command))return pending.promise;
      return Promise.reject(new ApiError('Another change is still being saved. Wait a moment and try again.',{code:'interaction_pending'}));
    }
    onPending(interactionKey, true);
    sent++;
    const promise = api.command(command).then((result) => {
      uncertain.delete(key);
      if (String(getScope() ?? '') !== scope) return { ...result, stale: true };
      reconcileCommandResult(data, result);
      onChange(result);
      return result;
    }).catch((error) => {
      if (String(getScope() ?? '') === scope) {
        if (error instanceof ApiError && error.uncertain) uncertain.set(key, command);
        onError(error, { command, interactionKey, uncertain: !!error?.uncertain });
      }
      throw error;
    }).finally(() => {
      inFlight.delete(key);
      if (String(getScope() ?? '') === scope) onPending(interactionKey, false);
    });
    inFlight.set(key, {command,promise});
    return promise;
  }

  /** Settles once no command is on its way to the server, also those sent meanwhile. */
  async function idle() {
    while (inFlight.size) await Promise.allSettled([...inFlight.values()].map((entry) => entry.promise));
  }

  return Object.freeze({
    execute(operation, payload, options = {}) {
      const scope=String(getScope() ?? ''), interactionKey=options.interactionKey;
      const previous=interactionKey&&uncertain.get(scopedKey(scope,interactionKey));
      const prepared=prepareCommand(operation,payload,options);
      if(previous&&sameIntent(previous,prepared))return executePrepared(previous,interactionKey,scope);
      if(previous)uncertain.delete(scopedKey(scope,interactionKey));
      return executePrepared(prepared, interactionKey, scope);
    },
    retry(interactionKey) {
      const scope=String(getScope() ?? '');
      const command = uncertain.get(scopedKey(scope,interactionKey));
      if (!command) throw new TypeError('No uncertain command exists for this interaction');
      return executePrepared(command, interactionKey,scope);
    },
    hasUncertain: (interactionKey) => uncertain.has(scopedKey(String(getScope() ?? ''),interactionKey)),
    isPending: (interactionKey) => inFlight.has(scopedKey(String(getScope() ?? ''),interactionKey)),
    /** Whether any command is still on its way to the server. */
    hasPending: () => inFlight.size > 0,
    /**
     * Read with `read` until its answer overlaps none of this tab's changes.
     * An answer that comes while one of the tab's commands is on its way, or
     * after one was sent, may be from before that change, and applying it
     * would undo the change. Such an answer is dropped, and the read runs
     * again once no command is on its way. `current()` says whether the
     * caller still wants an answer; once it doesn't, the last one returns,
     * for the caller to drop.
     * @template T @param {()=>Promise<T>} read @param {()=>boolean} [current] @returns {Promise<T>}
     */
    async readUnchanged(read, current = () => true) {
      for (;;) {
        const before = sent, pending = inFlight.size > 0;
        const answer = await read();
        if (!current() || !pending && !inFlight.size && sent === before) return answer;
        await idle();
        if (!current()) return answer;
      }
    },
    discard: (interactionKey) => uncertain.delete(scopedKey(String(getScope() ?? ''),interactionKey)),
    invalidate() { uncertain.clear(); },
  });
}
