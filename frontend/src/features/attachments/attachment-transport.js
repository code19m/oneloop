// @ts-check

import { ApiError, UPLOAD_TIMEOUT_MS } from '../../data/api-client.js';

/** @typedef {{api:Record<string,unknown>,data:unknown,commands:unknown,reload:Function,publish:Function,subscribe:Function}} RuntimeHooks */
/** @typedef {{xhrFactory?:()=>XMLHttpRequest,formDataFactory?:()=>FormData,uploadTimeoutMs?:number}} InstallOptions */

/**
 * Add upload progress to the shared production transport while preserving the
 * same API surface used by the legacy attachment view.
 * @param {RuntimeHooks} runtime
 * @param {InstallOptions} [options]
 */
export function installAttachmentTransport(
  runtime,
  {
    xhrFactory = () => new XMLHttpRequest(),
    formDataFactory = () => new FormData(),
    uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
  } = {},
) {
  if (!runtime?.api || typeof runtime.api !== 'object') {
    throw new TypeError('Expected runtime hooks with an API client');
  }

  /**
   * @param {string} taskId
   * @param {{file:Blob,ephemeral?:boolean,idempotencyKey?:string,signal?:AbortSignal,onProgress?:(percent:number)=>void}} options
   */
  function uploadAttachment(
    taskId,
    {
      file,
      ephemeral = false,
      idempotencyKey = crypto.randomUUID(),
      signal,
      onProgress,
    },
  ) {
    if (!(file instanceof Blob)) throw new TypeError('Expected a file');
    if (
      typeof idempotencyKey !== 'string'
      || !idempotencyKey
      || idempotencyKey.length > 128
      || !/^[\x21-\x7e]+$/.test(idempotencyKey)
    ) {
      throw new TypeError('Invalid idempotency key');
    }
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments?ephemeral=${String(!!ephemeral)}`;
    const body = formDataFactory();
    const fileName = typeof File !== 'undefined' && file instanceof File ? file.name : 'attachment';
    body.set('file', file, fileName);

    const recovery = globalThis.OneloopRecovery;
    const requestContext = recovery?.requestContext?.();
    const upload = new Promise((resolve, reject) => {
      const xhr = xhrFactory();
      let settled = false;
      const abort = () => xhr.abort();
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        callback();
      };
      const fail = (message, options) => finish(() => {
        const error=new ApiError(message,{...options,requestContext});
        recovery?.observeResponse?.({ok:false,error,path,background:false,requestContext});
        reject(error);
      });

      xhr.open('POST', path, true);
      xhr.withCredentials = true;
      xhr.timeout = uploadTimeoutMs;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Idempotency-Key', idempotencyKey);
      xhr.setRequestHeader('X-File-Size', String(file.size));
      // The person this page shows, as the API client names them.
      if (typeof requestContext?.userId === 'string' && requestContext.userId) xhr.setRequestHeader('X-Oneloop-User', requestContext.userId);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || !event.total) return;
        onProgress?.(Math.min(99, Math.max(0, Math.round(event.loaded / event.total * 100))));
      };
      xhr.onload = () => {
        let result;
        try { result = xhr.responseText ? JSON.parse(xhr.responseText) : null; }
        catch {
          fail('Invalid server response', {
            status: xhr.status,
            code: 'invalid_response',
            retryAfter: xhr.getResponseHeader('Retry-After'),
            uncertain: xhr.status >= 200 && xhr.status < 300 || xhr.status >= 500,
          });
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const metadata = result?.error ?? result;
          fail(metadata?.message || 'The upload could not be completed', {
            status: xhr.status,
            code: metadata?.code || 'request_failed',
            details: metadata?.details,
            retryAfter: xhr.getResponseHeader('Retry-After'),
            uncertain: xhr.status >= 500,
          });
          return;
        }
        finish(() => {
          recovery?.observeResponse?.({ok:true,status:xhr.status,path,background:false,requestContext});
          onProgress?.(100);
          resolve(result);
        });
      };
      xhr.onerror = () => fail('Unable to reach oneloop', { code: 'network_error', uncertain: true });
      xhr.ontimeout = () => fail('The upload timed out', { code: 'timeout', uncertain: true });
      xhr.onabort = () => fail('Request cancelled', { code: 'aborted', uncertain: true });
      if (signal?.aborted) {
        fail('Request cancelled', { code: 'aborted', uncertain: false });
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      xhr.send(body);
    });
    // Leaving the page while a file uploads would lose it.
    recovery?.trackWrite?.(upload);
    return upload;
  }

  const api = Object.freeze({ ...runtime.api, uploadAttachment });
  return Object.freeze({ ...runtime, api });
}
