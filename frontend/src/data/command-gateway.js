// @ts-check

import { ApiError, prepareCommand } from './api-client.js';
import { reconcileCommandResult } from './projection-store.js';

export function createCommandGateway({ api, data, getScope = () => '', onChange = (_result) => {}, onPending = (_key,_pending) => {}, onError = (_error,_context) => {} }) {
  const uncertain = new Map();
  const inFlight = new Map();

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
    discard: (interactionKey) => uncertain.delete(scopedKey(String(getScope() ?? ''),interactionKey)),
    invalidate() { uncertain.clear(); },
  });
}
