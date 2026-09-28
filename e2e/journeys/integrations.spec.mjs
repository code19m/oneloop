// MCP clients: OAuth consent in the browser and the official MCP SDK.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test, expect, openApp } from '../support/test.mjs';

test('the official MCP SDK completes OAuth, tools and file transfers', { tag: '@smoke' }, async ({ instance }) => {
  let registration, tokens, verifier, code;
  const scope = 'project_read board_manage attachments';
  // The consent step is answered directly, so nothing listens on this loopback URL.
  const redirectUrl = 'http://127.0.0.1:19899/callback';
  const provider = {
    redirectUrl,
    clientMetadata: { client_name: 'SDK regression', redirect_uris: [redirectUrl], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope },
    clientInformation: () => registration,
    saveClientInformation: value => { registration = value; },
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    codeVerifier: () => verifier,
    saveCodeVerifier: value => { verifier = value; },
    state: () => 'sdk-test-state',
    async redirectToAuthorization(url) {
      const response = await instance.api.get(url.toString());
      expect(response.ok()).toBeTruthy();
      const html = await response.text();
      const requestId = html.match(/name=request_id value="([^"]+)"/)[1];
      const form = new URLSearchParams({ request_id: requestId, decision: 'allow', project: instance.projects[0].project.id });
      for (const capability of scope.split(' ')) form.append('scope', capability);
      const consent = await instance.api.post('/oauth/authorize', { data: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, maxRedirects: 0 });
      expect(consent.status()).toBe(303);
      const callback = new URL(consent.headers().location);
      expect(callback.searchParams.get('state')).toBe('sdk-test-state');
      code = callback.searchParams.get('code');
    },
  };
  const serverUrl = new URL(`${instance.url}/mcp`);
  expect(await auth(provider, { serverUrl, scope })).toBe('REDIRECT');
  expect(Object.values(registration).every(value => value !== null)).toBeTruthy();
  const transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
  await transport.finishAuth(code);
  const client = new Client({ name: 'oneloop-sdk-check', version: '1.0.0' });
  try {
    await client.connect(transport);
    expect(transport.protocolVersion).toBe('2025-11-25');
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) if (tool.outputSchema) expect(tool.outputSchema.type).toBe('object');
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return result.structuredContent;
    };
    expect(await call('get_identity')).toBeTruthy();
    const created = await call('execute_work_command', { operation: 'task.create', payload: { projectId: instance.projects[0].project.id, epicId: instance.projects[0].epic.id, title: 'SDK task' }, idempotencyKey: randomUUID() });
    const taskId = created.entities[0].id;
    const bytes = Buffer.from('MCP SDK byte round trip 🦀');
    const upload = await call('create_attachment_upload', { taskId, fileName: 'sdk.txt', sizeBytes: bytes.length, idempotencyKey: randomUUID() });
    const uploaded = await fetch(upload.url, { method: upload.method, headers: { Authorization: upload.authorization, 'Content-Type': 'application/octet-stream' }, body: bytes });
    expect(uploaded.ok).toBeTruthy();
    const attachment = await uploaded.json();
    const download = await call('create_attachment_download', { attachmentId: attachment.value.id });
    const downloaded = await fetch(download.url, { headers: { Authorization: download.authorization } });
    expect(downloaded.ok).toBeTruthy();
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
  } finally { await client.close(); }
});

/** A native client's loopback redirect listener on a port the system assigns. */
async function loopbackCallback(host) {
  const callbacks = [];
  const server = createServer((request, response) => {
    const destination = new URL(request.url, 'http://loopback');
    if (destination.pathname !== '/callback') { response.writeHead(204); response.end(); return; }
    callbacks.push(destination);
    response.end('Callback received');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
  return { callbacks, redirect: `${origin}/callback`, close: () => new Promise(resolve => server.close(resolve)) };
}

for (const host of ['127.0.0.1', '::1']) {
  test(`browser consent completes Connect, the token exchange and Cancel (${host})`, { tag: host === '127.0.0.1' ? '@smoke' : [] }, async ({ page, instance }) => {
    const { callbacks, redirect, close } = await loopbackCallback(host);
    try {
      const registration = await instance.api.post('/oauth/register', { data: { client_name: 'Browser consent regression', redirect_uris: [redirect] } });
      expect(registration.status()).toBe(201);
      const client = (await registration.json()).client_id;
      await openApp(page, instance);
      for (const allow of [true, false]) {
        const verifier = randomBytes(32).toString('base64url');
        const state = randomBytes(16).toString('hex');
        const query = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${instance.url}/mcp`, scope: 'project_read', state });
        await page.goto(`${instance.url}/oauth/authorize?${query}`);
        if (allow) await page.locator(`input[name="project"][value="${instance.projects[0].project.id}"]`).check();
        await page.getByRole('button', { name: allow ? 'Connect' : 'Cancel', exact: true }).click();
        await expect.poll(() => page.url().startsWith(redirect)).toBeTruthy();
        await expect.poll(() => callbacks.some(url => url.searchParams.get('state') === state)).toBeTruthy();
        const received = callbacks.find(url => url.searchParams.get('state') === state);
        if (allow) {
          expect(received.searchParams.get('code')).toBeTruthy();
          const token = await instance.api.post('/oauth/token', { form: { grant_type: 'authorization_code', code: received.searchParams.get('code'), client_id: client, redirect_uri: redirect, code_verifier: verifier, resource: `${instance.url}/mcp` } });
          expect(token.status(), await token.text()).toBe(200);
          expect((await token.json()).access_token).toBeTruthy();
        } else expect(received.searchParams.get('error')).toBe('access_denied');
      }
    } finally { await close(); }
  });
}
