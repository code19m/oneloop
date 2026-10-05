import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient, prepareCommand } from '../../../src/data/api-client.js';
import { createCommandGateway } from '../../../src/data/command-gateway.js';

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
  const invalid = createApiClient({ fetchImpl: async () => new Response('bad', { status: 200 }) });
  await assert.rejects(invalid.command(prepareCommand('task.update', {})), error => error.code === 'invalid_response' && error.uncertain);
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

test('file upload sends reservation metadata without JSON encoding the bytes', async () => {
  let captured;
  const api=createApiClient({fetchImpl:async(url,options)=>{captured={url,options};return Response.json({id:'a1'},{status:201});}});
  const file=new Blob(['hello'],{type:'text/plain'});
  await api.uploadAttachment('task one',{file,ephemeral:true,idempotencyKey:'upload-1'});
  assert.equal(captured.url,'/api/tasks/task%20one/attachments?ephemeral=true');
  assert.equal(captured.options.headers['Idempotency-Key'],'upload-1');
  assert.equal(captured.options.headers['X-File-Size'],'5');
  assert.ok(captured.options.body instanceof FormData);
  assert.equal(captured.options.headers['Content-Type'],undefined);
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
    for (const route of ['request','uploadAttachment','uploadAvatar']) {
      const api=createApiClient({fetchImpl:async()=>new Response('<html>Proxy unavailable</html>',{status,headers:{'Retry-After':'120'}})});
      const promise=route==='request'?api.request('/api/bootstrap'):route==='uploadAvatar'?api.uploadAvatar(new Blob(['a'])):api.uploadAttachment('t1',{file:new Blob(['a'])});
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
