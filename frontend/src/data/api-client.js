// @ts-check

import { savedDoneOrder } from './done-order.js';

/** HTTP transport only. Product validation and permissions belong to the server. */
/** @typedef {{status?:number,code?:string,details?:unknown,retryAfter?:string|null,uncertain?:boolean,cause?:unknown,requestContext?:any}} ApiErrorOptions */
/** @typedef {{method?:string,body?:unknown,signal?:AbortSignal,background?:boolean,headers?:Record<string,string>}} RequestOptions */
/** @typedef {{signal?:AbortSignal,background?:boolean}} SignalOptions */
export class ApiError extends Error {
  /** @param {string} message @param {ApiErrorOptions} [options] */
  constructor(message, { status = 0, code = 'request_failed', details, retryAfter = null, uncertain = false, cause, requestContext } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
    this.uncertain = uncertain;
    this.cause = cause;
    this.requestContext = requestContext;
  }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Create once per logical action; reuse this object after an uncertain outcome. */
/** @param {string} operation @param {Record<string,unknown>} payload @param {{expectedRevision?:number,idempotencyKey?:string}} [options] */
export function prepareCommand(operation, payload, { expectedRevision, idempotencyKey = crypto.randomUUID() } = {}) {
  if (!/^[a-z][a-zA-Z0-9_.-]{0,99}$/.test(operation)) throw new TypeError('Invalid operation name');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Expected a command payload object');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 128) throw new TypeError('Invalid idempotency key');
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new TypeError('Invalid revision');
  return freeze(JSON.parse(JSON.stringify({ operation, payload, idempotencyKey, expectedRevision })));
}

// Internal bounds include receiving and decoding the response body.
export const REQUEST_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 300_000;

/** A cancellation race also bounds transports that do not settle after abort. */
function requestDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  let rejectCancellation;
  const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
  const cancel = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectCancellation(reason);
  };
  const abort = () => cancel(new DOMException('Request cancelled', 'AbortError'));
  const timer = setTimeout(() => cancel(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    signal: controller.signal,
    run: (work) => Promise.race([cancelled, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return work();
    })]),
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
  };
}

/**
 * The error that a refused response's body describes.
 * @param {number} status @param {any} body
 * @param {{retryAfter:string|null,uncertain:boolean,requestContext:any}} options
 */
function responseError(status, body, { retryAfter, uncertain, requestContext }) {
  const metadata = body?.error && typeof body.error === 'object' ? body.error : body;
  return new ApiError(typeof metadata?.message === 'string' ? metadata.message : 'The request could not be completed', {
    status,
    code: typeof metadata?.code === 'string' ? metadata.code : 'request_failed',
    details: metadata?.details,
    retryAfter,
    uncertain,
    requestContext,
  });
}

/**
 * The query string of Board filters: set values only, lists joined with commas.
 * @param {Record<string,unknown>} filters
 */
function boardQuery(filters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value)) { if (value.length) query.set(key, value.join(',')); }
    else query.set(key, String(value));
  }
  return query.size ? `?${query}` : '';
}

/** @param {{fetchImpl?: typeof fetch,xhrFactory?:()=>XMLHttpRequest,onResponse?:(event:any)=>void,getRequestContext?:()=>any,requestTimeoutMs?:number,uploadTimeoutMs?:number,wallNow?:()=>number,monotonicNow?:()=>number}} [options] */
export function createApiClient({
  fetchImpl = globalThis.fetch.bind(globalThis), xhrFactory = () => new XMLHttpRequest(), onResponse = (_event) => {},
  getRequestContext = () => undefined,
  requestTimeoutMs = REQUEST_TIMEOUT_MS, uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
  wallNow = Date.now, monotonicNow = () => performance.now(),
} = {}) {
  /** @type {{epoch:number,received:number}|null} */
  let clockSample = null;
  let clockSequence = 0, requestSequence = 0;
  // The Date header has one-second precision. Anchor to a monotonic clock so an
  // OS clock correction cannot move Today between successful API responses.
  const serverNow = () => clockSample ? clockSample.epoch + monotonicNow() - clockSample.received : wallNow();
  const publish = (event) => { try { onResponse(event); } catch {} };

  /**
   * Name the person this page shows. Tabs share one session cookie, so after
   * someone else signs in, the server refuses this page's requests instead of
   * answering as that person.
   * @param {any} requestContext @returns {Record<string,string>}
   */
  const personHeader = (requestContext) => typeof requestContext?.userId === 'string' && requestContext.userId ? { 'X-Oneloop-User': requestContext.userId } : {};

  /** Shared response handling for JSON and multipart requests. */
  async function send(path, { method, body, headers, signal, background = false, timeoutMs = requestTimeoutMs }) {
    const sequence = ++requestSequence, sent = monotonicNow();
    const requestContext = getRequestContext();
    const context = requestContext === undefined ? {} : { requestContext };
    headers = { ...headers, ...personHeader(requestContext) };
    const mutation = !['GET', 'HEAD'].includes(method);
    const deadline = requestDeadline(signal, timeoutMs);
    /** @type {Response | undefined} */
    let response;
    let started = false;
    try {
      const result = await deadline.run(async () => {
        started = true;
        response = await fetchImpl(path, { method, headers, body, signal: deadline.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        let result = null;
        if (response.status !== 204 && method !== 'HEAD') result = await response.json();
        if (!response.ok) throw responseError(response.status, result, { retryAfter: response.headers.get('Retry-After'), uncertain: mutation && response.status >= 500, requestContext });
        return result;
      });
      const received = monotonicNow(), epoch = Date.parse(response.headers.get('Date') || '');
      if (sequence > clockSequence && received - sent <= 10_000 && Number.isFinite(epoch)) {
        clockSample = { epoch, received }; clockSequence = sequence;
      }
      publish({ ok: true, status: response.status, path, background, ...context });
      return result;
    } catch (cause) {
      let error = cause;
      if (!(cause instanceof ApiError)) {
        const reason = deadline.signal.aborted ? deadline.signal.reason : cause;
        const code = reason?.name === 'TimeoutError' ? 'timeout'
          : reason?.name === 'AbortError' ? 'aborted'
          : reason instanceof SyntaxError ? 'invalid_response' : 'network_error';
        const messages = { timeout: 'The request timed out', aborted: 'Request cancelled', invalid_response: 'Invalid server response', network_error: 'Unable to reach oneloop' };
        error = new ApiError(messages[code], {
          status: response?.status ?? 0, code, cause: reason,
          retryAfter: response?.headers.get('Retry-After') ?? null,
          uncertain: mutation && started && (!response || response.ok || response.status >= 500),
          requestContext,
        });
      }
      publish({ ok: false, error, path, background, ...context });
      throw error;
    } finally { deadline.dispose(); }
  }

  /** @param {string} path @param {RequestOptions} [options] */
  async function request(path, { method = 'GET', body, signal, background = false, headers: extraHeaders } = {}) {
    // Credential-bearing requests never accept arbitrary hosts or protocol-relative URLs.
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('\\')) {
      throw new TypeError('Expected a same-origin API path');
    }
    const target = new URL(path, 'https://oneloop.invalid');
    if (target.origin !== 'https://oneloop.invalid' || !target.pathname.startsWith('/api/') || /(?:%2f|%5c|%2e)/i.test(target.pathname) || target.hash) {
      throw new TypeError('Expected a same-origin API path');
    }
    const headers = { Accept: 'application/json', ...extraHeaders };
    if (background) headers['X-Oneloop-Background'] = '1';
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined) headers['Content-Type'] = 'application/json';
    return send(path, { method: method.toUpperCase(), headers, body: serialized, signal, background });
  }

  /** Multipart is isolated so JSON commands can never accidentally accept file bodies. */
  async function uploadAvatar(file, { signal } = /** @type {SignalOptions} */ ({})) {
    if (!(file instanceof Blob)) throw new TypeError('Expected an image file');
    const body = new FormData();
    body.set('file', file, typeof File !== 'undefined' && file instanceof File ? file.name : 'avatar');
    return send('/api/auth/avatar', { method: 'PUT', headers: { Accept: 'application/json', 'X-File-Size': String(file.size) }, body, signal, timeoutMs: uploadTimeoutMs });
  }
  /**
   * Upload an attachment with XMLHttpRequest, which reports the bytes sent.
   * An upload sent again after an unknown result keeps its idempotency key.
   * @param {string} taskId
   * @param {{file:Blob,ephemeral?:boolean,idempotencyKey?:string,signal?:AbortSignal,onProgress?:(percent:number)=>void}} options
   */
  function uploadAttachment(taskId, { file, ephemeral = false, idempotencyKey = crypto.randomUUID(), signal, onProgress }) {
    if (!(file instanceof Blob)) throw new TypeError('Expected a file');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 128 || !/^[\x21-\x7e]+$/.test(idempotencyKey)) throw new TypeError('Invalid idempotency key');
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments?ephemeral=${String(!!ephemeral)}`;
    const body = new FormData();
    body.set('file', file, typeof File !== 'undefined' && file instanceof File ? file.name : 'attachment');
    const requestContext = getRequestContext();
    const context = requestContext === undefined ? {} : { requestContext };
    return new Promise((resolve, reject) => {
      const xhr = xhrFactory();
      let settled = false;
      const abort = () => xhr.abort();
      const finish = (/** @type {()=>void} */ callback) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        callback();
      };
      const fail = (/** @type {ApiError} */ error) => finish(() => { publish({ ok: false, error, path, background: false, ...context }); reject(error); });
      const failed = (/** @type {string} */ message, /** @type {ApiErrorOptions} */ options) => fail(new ApiError(message, { ...options, requestContext }));
      xhr.open('POST', path, true);
      xhr.withCredentials = true;
      xhr.timeout = uploadTimeoutMs;
      for (const [name, value] of Object.entries({ Accept: 'application/json', 'Idempotency-Key': idempotencyKey, 'X-File-Size': String(file.size), ...personHeader(requestContext) })) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || !event.total) return;
        onProgress?.(Math.min(99, Math.max(0, Math.round(event.loaded / event.total * 100))));
      };
      xhr.onload = () => {
        const retryAfter = xhr.getResponseHeader('Retry-After');
        let result;
        try { result = xhr.responseText ? JSON.parse(xhr.responseText) : null; }
        catch { failed('Invalid server response', { status: xhr.status, code: 'invalid_response', retryAfter, uncertain: xhr.status >= 200 && xhr.status < 300 || xhr.status >= 500 }); return; }
        if (xhr.status < 200 || xhr.status >= 300) { fail(responseError(xhr.status, result, { retryAfter, uncertain: xhr.status >= 500, requestContext })); return; }
        finish(() => { publish({ ok: true, status: xhr.status, path, background: false, ...context }); onProgress?.(100); resolve(result); });
      };
      xhr.onerror = () => failed('Unable to reach oneloop', { code: 'network_error', uncertain: true });
      xhr.ontimeout = () => failed('The upload timed out', { code: 'timeout', uncertain: true });
      xhr.onabort = () => failed('Request cancelled', { code: 'aborted', uncertain: true });
      if (signal?.aborted) { failed('Request cancelled', { code: 'aborted', uncertain: false }); return; }
      signal?.addEventListener('abort', abort, { once: true });
      xhr.send(body);
    });
  }

  return Object.freeze({
    serverNow,
    request,
    command: (command, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/commands', { method: 'POST', body: command, signal }),
    bootstrap: ({ projectId, taskId, view, signal, background } = /** @type {{projectId?:string,taskId?:string,view?:string,signal?:AbortSignal,background?:boolean}} */ ({})) => {
      const query = new URLSearchParams();
      if (projectId) query.set('projectId', projectId);
      if (taskId) query.set('taskId', taskId);
      if (view) query.set('view', view);
      // Board pages come in the order this browser chose for Done.
      if (view === 'board' && savedDoneOrder() === 'completed') query.set('doneOrder', 'completed');
      return request('/api/bootstrap' + (query.size ? '?' + query.toString() : ''), { signal, background });
    },
    board: (projectId, filters = {}, { signal,background } = /** @type {SignalOptions} */ ({})) => request(`/api/projects/${encodeURIComponent(projectId)}/board${boardQuery(filters)}`, { signal,background }),
    boardView: (projectId, filters = {}, { signal,background } = /** @type {SignalOptions} */ ({})) => request(`/api/projects/${encodeURIComponent(projectId)}/board-view${boardQuery(filters)}`, { signal,background }),
    counts: (projectId, { signal,background } = /** @type {SignalOptions} */ ({})) => request(`/api/projects/${encodeURIComponent(projectId)}/counts`, { signal,background }),
    roadmap: (projectId, { signal,background } = /** @type {SignalOptions} */ ({})) => request(`/api/projects/${encodeURIComponent(projectId)}/roadmap`, { signal,background }),
    epicTasks: (epicId,{cursor,limit=50,signal,background}=/** @type {{cursor?:string,limit?:number,signal?:AbortSignal,background?:boolean}} */({}))=>{const query=new URLSearchParams({limit:String(limit)});if(cursor)query.set('cursor',cursor);return request(`/api/epics/${encodeURIComponent(epicId)}/tasks?${query}`,{signal,background});},
    epicActivity: (epicId,{cursor,limit=50,signal,background}=/** @type {{cursor?:string,limit?:number,signal?:AbortSignal,background?:boolean}} */({}))=>{const query=new URLSearchParams({limit:String(limit)});if(cursor)query.set('cursor',cursor);return request(`/api/epics/${encodeURIComponent(epicId)}/activity?${query}`,{signal,background});},
    pool: (projectId, filters = {}, { signal,background } = /** @type {SignalOptions} */ ({})) => {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== ''));
      return request(`/api/projects/${encodeURIComponent(projectId)}/pool${query.size ? '?' + query : ''}`, { signal,background });
    },
    task: (taskId, { signal,background } = /** @type {SignalOptions} */ ({})) => request(`/api/tasks/${encodeURIComponent(taskId)}`, { signal,background }),
    login: (credentials, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/auth/login', { method: 'POST', body: credentials, signal }),
    logout: ({ signal } = /** @type {SignalOptions} */ ({})) => request('/api/auth/logout', { method: 'POST', signal }),
    me: ({ signal, background } = /** @type {SignalOptions} */ ({})) => request('/api/auth/me', { signal, background }),
    changePassword: (passwords, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/auth/change-password', { method: 'POST', body: passwords, signal }),
    recentAuth: (password, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/auth/recent-auth', { method: 'POST', body: { password }, signal }),
    sessions: ({ signal, background } = /** @type {SignalOptions} */ ({})) => request('/api/auth/sessions', { signal, background }),
    revokeSession: (id, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/auth/sessions/' + encodeURIComponent(id), { method: 'DELETE', signal }),
    revokeOtherSessions: ({ signal } = /** @type {SignalOptions} */ ({})) => request('/api/auth/sessions/revoke-others', { method: 'POST', signal }),
    updateProfile: (displayName, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/auth/me', { method: 'PATCH', body: { displayName }, signal }),
    users: ({ afterUsername, signal, background=false } = /** @type {{afterUsername?:string,signal?:AbortSignal,background?:boolean}} */ ({})) => {
      const query = new URLSearchParams();
      if (afterUsername) query.set('afterUsername', afterUsername);
      return request('/api/users' + (query.size ? '?' + query : ''), { signal,background });
    },
    createUser: (input, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/users', { method: 'POST', body: input, signal }),
    updateUser: (id, input, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/users/' + encodeURIComponent(id), { method: 'PATCH', body: input, signal }),
    resetUserPassword: (id, { signal } = /** @type {SignalOptions} */ ({})) => request('/api/users/' + encodeURIComponent(id) + '/reset-password', { method: 'POST', signal }),
    connectedApps: ({signal,background} = /** @type {SignalOptions} */ ({})) => request('/api/auth/apps',{signal,background}),
    revokeConnectedApp: (id,{signal}=/** @type {SignalOptions} */({}))=>request('/api/auth/apps/'+encodeURIComponent(id),{method:'DELETE',signal}),
    attachments: (taskId,{signal,background}=/** @type {SignalOptions} */({}))=>request(`/api/tasks/${encodeURIComponent(taskId)}/attachments`,{signal,background}),
    uploadAvatar,
    uploadAttachment,
    removeAvatar: ({signal}=/** @type {SignalOptions} */({}))=>request('/api/auth/avatar',{method:'DELETE',signal}),
    updateAttachment: (id,input,{signal}=/** @type {SignalOptions} */({}))=>request(`/api/attachments/${encodeURIComponent(id)}`,{method:'PATCH',body:input,signal}),
    reorderAttachment: (taskId,input,{signal}=/** @type {SignalOptions} */({}))=>request(`/api/tasks/${encodeURIComponent(taskId)}/attachments/reorder`,{method:'POST',body:input,signal}),
    deleteAttachment: (id,{expectedRevision,idempotencyKey=crypto.randomUUID(),signal})=>request(`/api/attachments/${encodeURIComponent(id)}?expectedRevision=${encodeURIComponent(expectedRevision)}`,{method:'DELETE',headers:{'Idempotency-Key':idempotencyKey},signal}),
    restoreAttachment: (id,input,{signal}=/** @type {SignalOptions} */({}))=>request(`/api/attachments/${encodeURIComponent(id)}/restore`,{method:'POST',body:input,signal}),
    comment: (taskId,commentId,{signal,background}=/** @type {SignalOptions} */({}))=>request(`/api/discussion/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`,{signal,background}),
    block: (taskId,blockId,{signal,background}=/** @type {SignalOptions} */({}))=>request(`/api/discussion/tasks/${encodeURIComponent(taskId)}/blocks/${encodeURIComponent(blockId)}`,{signal,background}),
    comments: (taskId,{cursor,limit=50,signal,background}=/** @type {{cursor?:string,limit?:number,signal?:AbortSignal,background?:boolean}} */({}))=>{
      const query=new URLSearchParams({limit:String(limit)});if(cursor)query.set('cursor',cursor);
      return request(`/api/discussion/tasks/${encodeURIComponent(taskId)}/comments?${query}`,{signal,background});
    },
    activity: (projectId,{taskId,cursor,limit=50,signal,background}=/** @type {{taskId?:string,cursor?:string,limit?:number,signal?:AbortSignal,background?:boolean}} */({}))=>{
      const query=new URLSearchParams({limit:String(limit)});if(taskId)query.set('taskId',taskId);if(cursor)query.set('cursor',cursor);
      return request(`/api/activity/projects/${encodeURIComponent(projectId)}?${query}`,{signal,background});
    },
    inbox: ({projectIds=[],unreadOnly=false,archived=false,cursor,limit=50,signal,background}=/** @type {{projectIds?:string[],unreadOnly?:boolean,archived?:boolean,cursor?:string,limit?:number,signal?:AbortSignal,background?:boolean}} */({}))=>{
      const query=new URLSearchParams({unreadOnly:String(unreadOnly),archived:String(archived),limit:String(limit)});if(projectIds.length)query.set('projectIds',projectIds.join(','));if(cursor)query.set('cursor',cursor);
      return request(`/api/inbox?${query}`,{signal,background});
    },
    storageUsage: ({signal,background}=/** @type {SignalOptions} */({}))=>request('/api/storage',{signal,background}),
    cleanupStorage: ({signal}=/** @type {SignalOptions} */({}))=>request('/api/storage/cleanup',{method:'POST',signal}),
  });
}
