import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient, prepareCommand } from '../../../src/data/api-client.js';
import { createCommandGateway } from '../../../src/data/command-gateway.js';
import { saveDoneOrder } from '../../../src/data/done-order.js';

test('retries preserve immutable logical command identity without automatic retry', async () => {
  const payload = { title: 'Initial', assignees: ['a'] };
  const command = prepareCommand('task.create', payload);
  payload.title = 'Changed'; payload.assignees.push('b');
  assert.equal(command.payload.title, 'Initial');
  assert.deepEqual(command.payload.assignees, ['a']);
  assert.throws(() => command.payload.assignees.push('c'), TypeError);
  const calls = [];
  const api = createApiClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new TypeError('network failure after commit');
    return Response.json({ replayed: true, entities: {} });
  }});
  await assert.rejects(api.command(command), error => error instanceof ApiError && error.uncertain);
  assert.equal(calls.length, 1);
  assert.equal((await api.command(command)).replayed, true);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.redirect, 'error');
});

test('preserves actionable conflicts and retry hints', async () => {
  const api = createApiClient({ fetchImpl: async () => Response.json({ error: {
    code: 'revision_conflict', message: 'This task changed', details: { revision: 3 },
  }}, { status: 409, headers: { 'Retry-After': '2' } }) });
  await assert.rejects(api.command(prepareCommand('task.update', { taskId: 't1' }, { expectedRevision: 2 })), error =>
    error.status === 409 && error.code === 'revision_conflict' && error.details.revision === 3 && error.retryAfter === '2' && !error.uncertain);
});

test('rejects credential routing outside API and marks interrupted writes uncertain', async () => {
  let calls = 0;
  const api = createApiClient({ fetchImpl: async () => { calls++; throw new DOMException('Aborted', 'AbortError'); } });
  for (const path of ['https://example.com/api/test', '//example.com/api/test', '/api/../other', '/api/%2e%2e/other', '/api/\\evil']) {
    await assert.rejects(api.request(path), TypeError);
  }
  assert.equal(calls, 0);
  await assert.rejects(api.request('/api/bootstrap'), error => error.code === 'aborted' && !error.uncertain);
  await assert.rejects(api.command(prepareCommand('task.create', {})), error => error.code === 'aborted' && error.uncertain);
});

test('bootstrap uses encoded identifiers, supports empty responses, and rejects malformed successful writes', async () => {
  let requested;
  const api = createApiClient({ fetchImpl: async (url) => { requested = url; return new Response(null, { status: 204 }); } });
  assert.equal(await api.bootstrap({ projectId: 'my project', taskId: 'BIR-001' }), null);
  assert.equal(requested, '/api/bootstrap?projectId=my+project&taskId=BIR-001');
  await api.bootstrap({ view: 'metadata', lastSwitch: { userId: 'u1', projectId: 'my project' } });
  assert.equal(requested, '/api/bootstrap?view=metadata&switchedTo=my+project&switchedBy=u1');
  const invalid = createApiClient({ fetchImpl: async () => new Response('bad', { status: 200 }) });
  await assert.rejects(invalid.command(prepareCommand('task.update', {})), error => error.code === 'invalid_response' && error.uncertain);
});

test('a Board bootstrap asks for Done in the order this browser chose', async (t) => {
  const requested = [];
  const api = createApiClient({ fetchImpl: async (url) => { requested.push(url); return new Response(null, { status: 204 }); } });
  await api.bootstrap({ projectId: 'p1', view: 'board' });
  saveDoneOrder('completed', undefined); t.after(() => saveDoneOrder('manual', undefined));
  await api.bootstrap({ projectId: 'p1', view: 'board' });
  await api.bootstrap({ projectId: 'p1', view: 'roadmap' });
  // The Roadmap's days in view, and the days each of its marks stands for.
  await api.bootstrap({ projectId: 'p1', view: 'roadmap', roadmap: { from: '2026-01-01', to: '2026-03-01', anchor: '2026-02-01', cell: 4 } });
  // A filtered Board's pages come for its filters, named as a Board read names them.
  await api.bootstrap({ projectId: 'p1', view: 'board', filters: { search: 'x', trackIds: ['t1', 't2'], blocked: true } });
  assert.deepEqual(requested, [
    '/api/bootstrap?projectId=p1&view=board',
    '/api/bootstrap?projectId=p1&view=board&doneOrder=completed',
    '/api/bootstrap?projectId=p1&view=roadmap',
    '/api/bootstrap?projectId=p1&view=roadmap&roadmapFrom=2026-01-01&roadmapTo=2026-03-01&roadmapAnchor=2026-02-01&roadmapCell=4',
    '/api/bootstrap?projectId=p1&view=board&search=x&trackIds=t1%2Ct2&blocked=true&doneOrder=completed',
  ]);
});

test('auth helpers use the fixed same-origin routes and JSON contracts', async () => {
  const calls = [];
  const api = createApiClient({ fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return url.endsWith('/logout') ? new Response(null, { status: 204 }) : Response.json({ ok: true });
  }});
  await api.login({ username: 'taylorwu', password: 'secret' });
  await api.changePassword({ currentPassword: 'old', newPassword: 'new' });
  await api.recentAuth('secret');
  await api.revokeSession('session one');
  await api.logout();
  assert.deepEqual(calls.map(([url]) => url), [
    '/api/auth/login', '/api/auth/change-password', '/api/auth/recent-auth',
    '/api/auth/sessions/session%20one', '/api/auth/logout',
  ]);
  assert.equal(JSON.parse(calls[0][1].body).username, 'taylorwu');
  assert.equal(JSON.parse(calls[2][1].body).password, 'secret');
});

test('every request names the person the page shows, so the server never answers for whoever signed in after them',async()=>{
  const calls=[];let person='u1';
  const api=createApiClient({getRequestContext:()=>({sessionGeneration:1,userId:person}),fetchImpl:async(_url,options)=>{calls.push(options.headers);return Response.json({});}});
  await api.bootstrap();await api.command(prepareCommand('task.update',{taskId:'t1'}));await api.uploadAvatar(new Blob(['x']));
  person=null;await api.login({username:'u',password:'p'});
  assert.deepEqual(calls.map(headers=>headers['X-Oneloop-User']),['u1','u1','u1',undefined]);
});

test('automatic reconciliation is explicitly passive while interactive reads remain meaningful',async()=>{
  const calls=[];const api=createApiClient({fetchImpl:async(_url,options)=>{calls.push(options);return Response.json({});}});
  await api.bootstrap({background:true});await api.board('p1',{status:'planning'},{background:true});await api.bootstrap();
  assert.equal(calls[0].headers['X-Oneloop-Background'],'1');
  assert.equal(calls[1].headers['X-Oneloop-Background'],'1');
  assert.equal(calls[2].headers['X-Oneloop-Background'],undefined);
});

test('every read a live update repeats can be sent as passive',async()=>{
  const calls=[];const api=createApiClient({fetchImpl:async(url,options)=>{calls.push([url,options.headers['X-Oneloop-Background']]);return Response.json({});}});
  const reads={
    attachments:options=>api.attachments('t1',options),sessions:options=>api.sessions(options),connectedApps:options=>api.connectedApps(options),
    users:options=>api.users(options),storageUsage:options=>api.storageUsage(options),pool:options=>api.pool('p1',{scope:'personal'},options),
    me:options=>api.me(options),task:options=>api.task('t1',options),comment:options=>api.comment('t1','c1',options),block:options=>api.block('t1','b1',options),
  };
  for(const read of Object.values(reads)){await read({background:true});await read();}
  assert.deepEqual(calls.map(([,header])=>header),Object.keys(reads).flatMap(()=>['1',undefined]),calls.map(([url])=>url).join(' '));
});

test('collection filters use stable comma-separated project identifiers',async()=>{
  const urls=[];const api=createApiClient({fetchImpl:async(url)=>{urls.push(url);return Response.json({items:[]});}});
  await api.inbox({projectIds:['p1','p two'],unreadOnly:true});
  await api.board('p1',{status:'planning',trackIds:['t1','t two']});
  await api.boardView('p1',{trackIds:['t1','t two']});
  assert.match(urls[0],/projectIds=p1%2Cp\+two/);
  assert.match(urls[1],/trackIds=t1%2Ct\+two/);
  assert.match(urls[2],/board-view\?trackIds=t1%2Ct\+two/);
});

test('transport outcomes are observed exactly once without changing retry behavior',async()=>{
  const events=[];let call=0;
  const api=createApiClient({onResponse:(event)=>events.push(event),fetchImpl:async()=>{
    call++;if(call===1)throw new TypeError('offline');return Response.json({ok:true});
  }});
  await assert.rejects(api.request('/api/bootstrap',{background:true}),error=>error.code==='network_error');
  assert.equal(call,1);
  await api.request('/api/bootstrap');
  assert.equal(call,2);assert.equal(events.length,2);
  assert.equal(events[0].ok,false);assert.equal(events[0].error.code,'network_error');assert.equal(events[0].background,true);
  assert.deepEqual(events[1],{ok:true,status:200,path:'/api/bootstrap',background:false});
});

for (const status of [429,503]) {
  test(`non-JSON HTTP ${status} retains retry guidance for JSON and file responses`, async () => {
    for (const route of ['request','uploadAvatar']) {
      const api=createApiClient({fetchImpl:async()=>new Response('<html>Proxy unavailable</html>',{status,headers:{'Retry-After':'120'}})});
      const promise=route==='request'?api.request('/api/bootstrap'):api.uploadAvatar(new Blob(['a']));
      await assert.rejects(promise,error=>error.status===status&&error.retryAfter==='120'&&error.code==='invalid_response');
    }
  });
}

test('response body interruptions retain cancellation and network failure causes',async()=>{
  for (const cause of [new TypeError('Disconnected'),new DOMException('Aborted','AbortError'),new SyntaxError('Unexpected token')]) {
    for(const upload of [false,true]){
      const api=createApiClient({fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.error(cause);}}))});
      await assert.rejects(upload?api.uploadAvatar(new Blob(['a'])):api.command(prepareCommand('task.update',{})),error=>
        error.code===(cause.name==='AbortError'?'aborted':cause.name==='SyntaxError'?'invalid_response':'network_error')&&error.status===200&&error.uncertain&&error.cause===cause);
    }
  }
});

test('application deadlines cover headers and body without automatic retry',async()=>{
  for(const phase of ['headers','body']){
    let signal,calls=0;
    const events=[];
    const api=createApiClient({requestTimeoutMs:15,onResponse:event=>events.push(event),fetchImpl:async(_url,options)=>{
      calls++;signal=options.signal;
      return phase==='headers'?new Promise(()=>{}):new Response(new ReadableStream({start(){}}));
    }});
    await assert.rejects(api.command(prepareCommand('task.create',{})),error=>error.code==='timeout'&&error.uncertain);
    assert.equal(signal.aborted,true);assert.equal(calls,1);assert.equal(events.length,1);
  }
});

test('caller cancellation after headers settles once and pre-cancelled writes are not sent',async()=>{
  let receivedHeaders;
  const ready=new Promise(resolve=>receivedHeaders=resolve);
  const controller=new AbortController(),events=[];
  const api=createApiClient({onResponse:event=>events.push(event),fetchImpl:async()=>{
    receivedHeaders();return new Response(new ReadableStream({start(){}}));
  }});
  const pending=api.request('/api/bootstrap',{signal:controller.signal});
  await ready;controller.abort();
  await assert.rejects(pending,error=>error.code==='aborted'&&!error.uncertain);
  assert.equal(events.length,1);
  let sent=false;
  const cancelled=createApiClient({fetchImpl:async()=>{sent=true;return Response.json({});}});
  await assert.rejects(cancelled.command(prepareCommand('task.create',{}),{signal:controller.signal}),error=>error.code==='aborted'&&!error.uncertain);
  assert.equal(sent,false);
});

test('transport preserves the context captured before sending through delayed response observers',async()=>{
  let resolveResponse,generation=1;
  const events=[];
  const api=createApiClient({getRequestContext:()=>({sessionGeneration:generation}),onResponse:event=>events.push(event),fetchImpl:()=>new Promise(resolve=>resolveResponse=resolve)});
  const pending=api.request('/api/bootstrap');await Promise.resolve();generation=2;
  resolveResponse(Response.json({error:{code:'unauthorized'}},{status:401}));
  await assert.rejects(pending,error=>error.requestContext.sessionGeneration===1);
  assert.equal(events[0].requestContext.sessionGeneration,1);
});


test('timed-out commands release pending and deliberate retry keeps their idempotency key',async()=>{
  const calls=[];
  const api=createApiClient({requestTimeoutMs:15,fetchImpl:async(_url,options)=>{
    calls.push(JSON.parse(options.body));
    return calls.length===1?new Promise(()=>{}):Response.json({entities:[]});
  }});
  const gateway=createCommandGateway({api,data:{},getScope:()=> 'session-a'});
  await assert.rejects(gateway.execute('task.create',{title:'New task'},{interactionKey:'create'}),error=>error.code==='timeout');
  assert.equal(gateway.isPending('create'),false);assert.equal(gateway.hasUncertain('create'),true);assert.equal(calls.length,1);
  await gateway.retry('create');
  assert.equal(calls.length,2);assert.equal(calls[1].idempotencyKey,calls[0].idempotencyKey);assert.equal(gateway.hasUncertain('create'),false);
});


test('accepted Inbox operation casing reaches the wire while invalid operation characters are rejected',async()=>{
  const received=[];
  const api=createApiClient({fetchImpl:async(_path,options)=>{received.push(JSON.parse(options.body).operation);return Response.json({entities:[]});}});
  const operations=['inbox.markRead','inbox.markUnread','inbox.archive','inbox.restore','inbox.bulkMarkRead','inbox.bulkArchive'];
  for(const operation of operations)await api.command(prepareCommand(operation,{notificationId:'n1'}));
  assert.deepEqual(received,operations);
  for(const operation of ['inbox.markRead()','inbox markRead','inbox/markRead','Inbox.markRead','inbox.markRead\n','inbox.'+'x'.repeat(100)]){
    assert.throws(()=>prepareCommand(operation,{}),TypeError);
  }
});

test('server time ignores device skew, invalid/slow dates and older concurrent responses', async () => {
  let wall = Date.parse('2026-09-20T00:00:00Z'), monotonic = 10;
  const responses=[];
  const api=createApiClient({wallNow:()=>wall,monotonicNow:()=>monotonic,fetchImpl:()=>new Promise(resolve=>responses.push(resolve))});
  assert.equal(api.serverNow(),wall);
  const reply=async(promise,date,status=200)=>{await Promise.resolve();responses.shift()(Response.json({}, {status,headers:date?{Date:date}:{}}));await promise;};
  const server=Date.parse('2026-09-27T23:59:30Z');
  await reply(api.me(),new Date(server).toUTCString());assert.equal(api.serverNow(),server);
  wall+=86400000;monotonic+=31000;assert.equal(api.serverNow(),server+31000);
  await reply(api.me(),'invalid');assert.equal(api.serverNow(),server+31000);
  await reply(api.me(),null);assert.equal(api.serverNow(),server+31000);
  const slow=api.me();monotonic+=11000;await reply(slow,new Date(server-86400000).toUTCString());assert.equal(api.serverNow(),server+42000);
  const older=api.me(),newer=api.me();await Promise.resolve();
  responses.pop()(Response.json({}, {headers:{Date:new Date(server+60000).toUTCString()}}));await newer;
  responses.shift()(Response.json({}, {headers:{Date:new Date(server).toUTCString()}}));await older;
  assert.equal(api.serverNow(),server+60000);
  const failed=api.me();await Promise.resolve();responses.shift()(Response.json({}, {status:503,headers:{Date:new Date(server-86400000).toUTCString()}}));await assert.rejects(failed);assert.equal(api.serverNow(),server+60000);
});

/** An XMLHttpRequest that answers 201 at once, unless a test changes it. */
class MockXhr {
  upload = {};
  headers = {};
  status = 201;
  responseText = JSON.stringify({ id: 'attachment-1' });
  open(method, path) { this.method = method; this.path = path; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  getResponseHeader() { return null; }
  send(body) {
    this.body = body;
    this.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 });
    this.onload();
  }
  abort() { this.onabort?.(); }
}
const uploader = (xhr, options = {}) => createApiClient({ fetchImpl: async () => { throw new Error('An upload does not use fetch'); }, xhrFactory: () => xhr, ...options });

test('an attachment upload reports byte progress and keeps its logical upload key', async () => {
  const xhr = new MockXhr(), progress = [];
  const result = await uploader(xhr).uploadAttachment('task/one', {
    file: new Blob(['ab']), ephemeral: true, idempotencyKey: 'logical-upload',
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result, { id: 'attachment-1' });
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.path, '/api/tasks/task%2Fone/attachments?ephemeral=true');
  assert.equal(xhr.headers['Idempotency-Key'], 'logical-upload');
  assert.equal(xhr.headers['X-File-Size'], '2');
  assert.deepEqual(progress, [50, 100]);
  assert.ok(xhr.body.get('file') instanceof Blob);
});

test('a cancelled upload aborts its request and stays uncertain', async () => {
  const xhr = new MockXhr(), controller = new AbortController();
  xhr.send = () => {};
  const pending = uploader(xhr).uploadAttachment('task', { file: new Blob(['a']), signal: controller.signal, idempotencyKey: 'cancel-me' });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'aborted' && error.uncertain === true);
});

test('an upload cancelled before it starts sends no bytes', async () => {
  const xhr = new MockXhr(), controller = new AbortController();
  let sent = false;
  xhr.send = () => { sent = true; };
  controller.abort();
  await assert.rejects(
    uploader(xhr).uploadAttachment('task', { file: new Blob(['a']), signal: controller.signal, idempotencyKey: 'cancelled-before-send' }),
    (error) => error.code === 'aborted' && error.uncertain === false,
  );
  assert.equal(sent, false);
});

test('an upload refused by a busy server says why and may be sent again', async () => {
  const xhr = new MockXhr();
  xhr.status = 503;
  xhr.responseText = JSON.stringify({ error: { code: 'unavailable', message: 'Storage is full' } });
  await assert.rejects(
    uploader(xhr).uploadAttachment('task', { file: new Blob(['a']), idempotencyKey: 'retry-me' }),
    (error) => error.status === 503 && error.code === 'unavailable' && error.message === 'Storage is full' && error.uncertain === true,
  );
});

test('an upload\'s outcome reaches the response observer with the session context from before it was sent', async () => {
  const events = [];
  let generation = 1;
  const xhr = new MockXhr();
  xhr.send = () => {};
  const pending = uploader(xhr, { getRequestContext: () => ({ sessionGeneration: generation }), onResponse: (event) => events.push(event) })
    .uploadAttachment('task', { file: new Blob(['a']), idempotencyKey: 'old' });
  generation = 2; xhr.status = 401; xhr.responseText = JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' } }); xhr.onload();
  await assert.rejects(pending, (error) => error.status === 401 && error.requestContext.sessionGeneration === 1);
  assert.equal(events.length, 1); assert.equal(events[0].ok, false); assert.equal(events[0].requestContext.sessionGeneration, 1);
});

test('an upload has a transfer deadline and keeps the retry hint of a response that is not JSON', async () => {
  const xhr = new MockXhr();
  xhr.status = 503; xhr.responseText = '<html>Unavailable</html>'; xhr.getResponseHeader = () => '120';
  const api = uploader(xhr);
  await assert.rejects(api.uploadAttachment('task', { file: new Blob(['a']), idempotencyKey: 'retry' }), (error) => error.status === 503 && error.retryAfter === '120' && error.uncertain);
  assert.equal(xhr.timeout, 300_000);
  xhr.send = () => xhr.ontimeout();
  await assert.rejects(api.uploadAttachment('task', { file: new Blob(['a']), idempotencyKey: 'retry' }), (error) => error.code === 'timeout' && error.uncertain);
  assert.equal(xhr.headers['Idempotency-Key'], 'retry');
});

test('an upload names the person the page shows', async () => {
  const xhr = new MockXhr();
  await uploader(xhr, { getRequestContext: () => ({ sessionGeneration: 1, userId: 'u1' }) }).uploadAttachment('task', { file: new Blob(['a']), idempotencyKey: 'named-upload' });
  assert.equal(xhr.headers['X-Oneloop-User'], 'u1');
});
