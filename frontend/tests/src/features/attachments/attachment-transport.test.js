import test from 'node:test';
import assert from 'node:assert/strict';
import { installAttachmentTransport } from '../../../../src/features/attachments/attachment-transport.js';

class MockFormData {
  values = [];
  set(...args) { this.values.push(args); }
}

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

function runtime(api = {}) {
  return { api, data: {}, commands: {}, reload() {}, publish() {}, subscribe() {} };
}

test('attachment transport reports byte progress and preserves the logical upload key', async () => {
  const xhr = new MockXhr();
  const form = new MockFormData();
  const progress = [];
  const installed = installAttachmentTransport(runtime({ attachments() {} }), {
    xhrFactory: () => xhr,
    formDataFactory: () => form,
  });
  const result = await installed.api.uploadAttachment('task/one', {
    file: new Blob(['ab']), ephemeral: true, idempotencyKey: 'logical-upload',
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result, { id: 'attachment-1' });
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.path, '/api/tasks/task%2Fone/attachments?ephemeral=true');
  assert.equal(xhr.headers['Idempotency-Key'], 'logical-upload');
  assert.equal(xhr.headers['X-File-Size'], '2');
  assert.deepEqual(progress, [50, 100]);
  assert.equal(form.values[0][0], 'file');
});

test('attachment transport aborts the request and keeps cancellation uncertain', async () => {
  const xhr = new MockXhr();
  xhr.send = () => {};
  const controller = new AbortController();
  const installed = installAttachmentTransport(runtime(), {
    xhrFactory: () => xhr,
    formDataFactory: () => new MockFormData(),
  });
  const pending = installed.api.uploadAttachment('task', {
    file: new Blob(['a']), signal: controller.signal, idempotencyKey: 'cancel-me',
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'aborted' && error.uncertain === true);
});

test('attachment transport rejects a pre-cancelled upload without sending bytes', async () => {
  const xhr = new MockXhr();
  let sent = false;
  xhr.send = () => { sent = true; };
  const controller = new AbortController();
  controller.abort();
  const installed = installAttachmentTransport(runtime(), {
    xhrFactory: () => xhr,
    formDataFactory: () => new MockFormData(),
  });
  await assert.rejects(
    installed.api.uploadAttachment('task', {
      file: new Blob(['a']), signal: controller.signal, idempotencyKey: 'cancelled-before-send',
    }),
    (error) => error.code === 'aborted' && error.uncertain === false,
  );
  assert.equal(sent, false);
});

test('attachment transport surfaces structured retryable server errors', async () => {
  const xhr = new MockXhr();
  xhr.status = 503;
  xhr.responseText = JSON.stringify({ error: { code: 'unavailable', message: 'Storage is full' } });
  const installed = installAttachmentTransport(runtime(), {
    xhrFactory: () => xhr,
    formDataFactory: () => new MockFormData(),
  });
  await assert.rejects(
    installed.api.uploadAttachment('task', { file: new Blob(['a']), idempotencyKey: 'retry-me' }),
    (error) => error.status === 503 && error.code === 'unavailable' && error.uncertain === true,
  );
});

test('streaming upload outcomes reach the shared authentication recovery observer',async()=>{
  const previous=globalThis.OneloopRecovery,events=[];globalThis.OneloopRecovery={observeResponse:(event)=>events.push(event)};
  try{
    const xhr=new MockXhr();xhr.status=401;xhr.responseText=JSON.stringify({error:{code:'unauthorized',message:'Sign in'}});
    const installed=installAttachmentTransport(runtime(),{xhrFactory:()=>xhr,formDataFactory:()=>new MockFormData()});
    await assert.rejects(installed.api.uploadAttachment('task',{file:new Blob(['a']),idempotencyKey:'expired'}),error=>error.status===401);
    assert.equal(events.length,1);assert.equal(events[0].ok,false);assert.equal(events[0].error.status,401);
  }finally{if(previous===undefined)delete globalThis.OneloopRecovery;else globalThis.OneloopRecovery=previous;}
});

test('streaming uploads have a transfer deadline and preserve non-JSON retry headers',async()=>{
  const xhr=new MockXhr();xhr.status=503;xhr.responseText='<html>Unavailable</html>';xhr.getResponseHeader=()=> '120';
  const installed=installAttachmentTransport(runtime(),{xhrFactory:()=>xhr,formDataFactory:()=>new MockFormData()});
  await assert.rejects(installed.api.uploadAttachment('task',{file:new Blob(['a']),idempotencyKey:'retry'}),error=>error.status===503&&error.retryAfter==='120'&&error.uncertain);
  assert.equal(xhr.timeout,300_000);
  xhr.send=()=>xhr.ontimeout();
  await assert.rejects(installed.api.uploadAttachment('task',{file:new Blob(['a']),idempotencyKey:'retry'}),error=>error.code==='timeout'&&error.uncertain);
  assert.equal(xhr.headers['Idempotency-Key'],'retry');
});

test('streaming upload observers carry the session context from before send',async()=>{
  const previous=globalThis.OneloopRecovery,events=[];let generation=1;
  globalThis.OneloopRecovery={requestContext:()=>({sessionGeneration:generation}),observeResponse:event=>events.push(event)};
  try{
    const xhr=new MockXhr();xhr.send=()=>{};
    const installed=installAttachmentTransport(runtime(),{xhrFactory:()=>xhr,formDataFactory:()=>new MockFormData()});
    const pending=installed.api.uploadAttachment('task',{file:new Blob(['a']),idempotencyKey:'old'});
    generation=2;xhr.status=401;xhr.responseText='{}';xhr.onload();
    await assert.rejects(pending,error=>error.requestContext.sessionGeneration===1);
    assert.equal(events[0].requestContext.sessionGeneration,1);
  }finally{if(previous===undefined)delete globalThis.OneloopRecovery;else globalThis.OneloopRecovery=previous;}
});

test('an upload counts as unsaved work until it settles',async()=>{
  const previous=globalThis.OneloopRecovery,tracked=[];
  globalThis.OneloopRecovery={trackWrite:promise=>tracked.push(promise)};
  try{
    const xhr=new MockXhr();xhr.send=()=>{};
    const installed=installAttachmentTransport(runtime(),{xhrFactory:()=>xhr,formDataFactory:()=>new MockFormData()});
    const upload=installed.api.uploadAttachment('task',{file:new Blob(['a']),idempotencyKey:'leaving'});
    assert.deepEqual(tracked,[upload]);
    xhr.onload();await upload;
  }finally{if(previous===undefined)delete globalThis.OneloopRecovery;else globalThis.OneloopRecovery=previous;}
});

test('an upload names the person the page shows', async () => {
  const xhr = new MockXhr();
  const previous = globalThis.OneloopRecovery;
  globalThis.OneloopRecovery = { requestContext: () => ({ sessionGeneration: 1, userId: 'u1' }), observeResponse() {}, trackWrite() {} };
  try {
    const installed = installAttachmentTransport(runtime(), { xhrFactory: () => xhr, formDataFactory: () => new MockFormData() });
    await installed.api.uploadAttachment('task', { file: new Blob(['a']), idempotencyKey: 'named-upload' });
    assert.equal(xhr.headers['X-Oneloop-User'], 'u1');
  } finally {
    if (previous === undefined) delete globalThis.OneloopRecovery; else globalThis.OneloopRecovery = previous;
  }
});
