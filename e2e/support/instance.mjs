import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from './browser-errors.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = join(repository, 'target', 'e2e-instances');
// A relative ONELOOP_TEST_BINARY is relative to where npm or npx was started.
const binary = process.env.ONELOOP_TEST_BINARY
  ? resolve(process.env.INIT_CWD || process.cwd(), process.env.ONELOOP_TEST_BINARY)
  : join(repository, 'target', 'debug', 'oneloop');

// Each concurrently running worker owns ten ports. The range sits below the
// operating system's ephemeral ports, so outgoing browser connections cannot
// take a port between the probe and the server's bind.
const PORT_BASE = 19800;
const PORTS_PER_WORKER = 10;
const MAX_WORKERS = 10;
const ADDRESS_IN_USE = /address already in use|EADDRINUSE|os error (?:48|98|10048)/i;

async function portIsFree(port) {
  const socket = createServer();
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => socket.close(resolve));
    return true;
  } catch (error) {
    if (error.code === 'EADDRINUSE') return false;
    throw error;
  }
}

async function freePorts(parallelIndex) {
  if (parallelIndex >= MAX_WORKERS) throw new Error(`The e2e harness supports at most ${MAX_WORKERS} workers`);
  const first = PORT_BASE + parallelIndex * PORTS_PER_WORKER;
  const ports = [];
  for (let port = first; port < first + PORTS_PER_WORKER; port++) if (await portIsFree(port)) ports.push(port);
  if (!ports.length) throw new Error(`No free port in ${first}–${first + PORTS_PER_WORKER - 1}`);
  return ports;
}

/** Environment for the binary, never inheriting a developer's live instance configuration. */
function environment(directory, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('ONELOOP_')) delete env[name];
  return Object.assign(env, { ONELOOP_DATA_DIR: directory }, extra);
}

function cli(args, env, input) {
  const result = spawnSync(binary, args, { env, input, encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(`oneloop ${args.join(' ')} failed: ${result.error?.message || result.stderr}`);
}

/** Start `oneloop serve` and resolve once it logs that its listener is bound. */
async function startServer(env) {
  const child = spawn(binary, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = { child, output: '' };
  const listening = new Promise((resolve, reject) => {
    const collect = chunk => {
      server.output = (server.output + chunk).slice(-12_000);
      if (server.output.includes('oneloop listening')) resolve();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`oneloop serve exited (${signal || code}):\n${server.output}`)));
  });
  let timer;
  try {
    await Promise.race([listening, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`oneloop serve did not start:\n${server.output}`)), 10_000); })]);
  } catch (error) {
    await stopServer(server);
    error.addressInUse = ADDRESS_IN_USE.test(server.output);
    throw error;
  } finally { clearTimeout(timer); }
  return server;
}

async function stopServer(server) {
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try { await exited; } finally { clearTimeout(force); }
}

/** Serve `directory` on one of the worker's ports. */
async function serve(directory, parallelIndex, extra) {
  // Another process can take a probed port before the server binds it; only
  // that case moves on to the worker's next free port.
  for (const port of await freePorts(parallelIndex)) {
    const url = `http://127.0.0.1:${port}`;
    const env = environment(directory, { ...extra, ONELOOP_LISTEN: `127.0.0.1:${port}`, ONELOOP_PUBLIC_URL: url });
    try { return { url, server: await startServer(env) }; } catch (error) { if (!error.addressInUse) throw error; }
  }
  throw new Error('Every candidate port was taken before the server could bind it');
}

export async function command(api, operation, payload, expectedRevision) {
  const response = await api.post('/api/commands', {
    data: { operation, payload, expectedRevision, idempotencyKey: randomUUID() },
  });
  expect(response.ok(), `${operation}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function seedProject(api, ownerId, name, taskPrefix) {
  const [project] = (await command(api, 'project.create', { name, taskPrefix })).entities;
  await command(api, 'membership.add', { projectId: project.id, userId: ownerId, manageRoadmap: true, manageBoard: true });
  const [track] = (await command(api, 'track.create', { projectId: project.id, name: `${taskPrefix} track` })).entities;
  const [epic] = (await command(api, 'epic.create', { projectId: project.id, trackId: track.id, title: `${taskPrefix} epic`, startDate: '2026-09-24' })).entities;
  const [task] = (await command(api, 'task.create', { projectId: project.id, epicId: epic.id, title: `${taskPrefix} seeded task` })).entities;
  return { project, track, epic, task };
}

/**
 * Build the seeded data directory once per worker through the real CLI and
 * API. Each test then serves its own copy, which is much cheaper than
 * migrating, hashing passwords and seeding again.
 */
async function buildTemplate(playwright, parallelIndex) {
  if (!existsSync(binary)) throw new Error(`Missing ${binary}. Build it with \`cargo build\`, or set ONELOOP_TEST_BINARY.`);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'template-'));
  const username = 'smoke_owner', password = randomUUID();
  const writerTemporary = randomUUID(), writerPassword = randomUUID();
  cli(['db', 'migrate'], environment(directory));
  cli(['user', 'add', username, '--admin', '--name', 'Smoke Owner', '--password-stdin'], environment(directory), `${password}\n`);
  cli(['user', 'add', 'smoke_writer', '--admin', '--name', 'Smoke Writer', '--password-stdin'], environment(directory), `${writerTemporary}\n`);
  const { url, server } = await serve(directory, parallelIndex);
  const context = () => playwright.request.newContext({ baseURL: url, extraHTTPHeaders: { Origin: url } });
  const [api, writer] = await Promise.all([context(), context()]);
  try {
    const [login] = await Promise.all([
      api.post('/api/auth/login', { data: { username, password } }),
      (async () => {
        expect((await writer.post('/api/auth/login', { data: { username: 'smoke_writer', password: writerTemporary } })).ok()).toBeTruthy();
        expect((await writer.post('/api/auth/change-password', { data: { currentPassword: writerTemporary, newPassword: writerPassword } })).ok()).toBeTruthy();
      })(),
    ]);
    expect(login.ok()).toBeTruthy();
    const identity = await login.json();
    // Creation order decides the default project, so seed sequentially.
    const projects = [
      await seedProject(api, identity.user.id, 'Browser primary', 'UIA'),
      await seedProject(api, identity.user.id, 'Browser secondary', 'UIB'),
    ];
    const [pool] = (await command(api, 'pool.create', { projectId: projects[0].project.id, scope: 'personal', title: 'Seeded Pool item' })).entities;
    return {
      directory, username, password, identity, projects, pool,
      // Sessions live in the database, so each copy accepts these cookies.
      apiState: await api.storageState(), writerState: await writer.storageState(),
    };
  } catch (error) {
    error.message += `\nServer output:\n${server.output}`;
    throw error;
  } finally {
    await Promise.allSettled([api.dispose(), writer.dispose()]);
    await stopServer(server);
  }
}

/**
 * Every test gets a disposable instance of the real binary: its own copy of
 * the seeded data directory under target/, its own port and server process.
 * Nothing is shared between tests, so one scenario cannot change another's
 * preconditions.
 *
 * - `smoke_owner` (instance.username/password, `instance.api`) is an
 *   administrator and a member of both seeded projects.
 * - `smoke_writer` (`instance.writer`) is a second administrator who acts as
 *   another client.
 * - Each project has one track, one epic and one task; the first project also
 *   has a personal Pool item.
 */
export const test = base.extend({
  instanceTemplate: [async ({ playwright }, use, workerInfo) => {
    const template = await buildTemplate(playwright, workerInfo.parallelIndex);
    try { await use(template); } finally { await rm(template.directory, { recursive: true, force: true }); }
  }, { scope: 'worker', timeout: 30_000 }],
  instanceTimeZone: ['UTC', { option: true }],
  /** Extra environment for the server, such as a test certificate authority. */
  instanceEnvironment: [{}, { option: true }],
  instance: [async ({ playwright, browserErrors, instanceTimeZone, instanceEnvironment, instanceTemplate: template }, use, testInfo) => {
    const directory = await mkdtemp(join(scratch, 'instance-'));
    let server, api, writer;
    try {
      await cp(template.directory, directory, { recursive: true });
      const served = await serve(directory, testInfo.parallelIndex, { ...instanceEnvironment, ONELOOP_TIMEZONE: instanceTimeZone });
      server = served.server;
      const { url } = served;
      api = await playwright.request.newContext({ baseURL: url, extraHTTPHeaders: { Origin: url }, storageState: template.apiState });
      writer = await playwright.request.newContext({ baseURL: url, extraHTTPHeaders: { Origin: url }, storageState: template.writerState });
      expect((await api.get('/healthz')).ok(), 'health check').toBeTruthy();
      const { username, password, identity, projects, pool } = template;
      await use({ url, username, password, api, writer, identity, projects, pool });
    } catch (error) {
      if (server) error.message += `\nServer output:\n${server.output}`;
      throw error;
    } finally {
      if (server && testInfo.status !== testInfo.expectedStatus) await testInfo.attach('server-output', { body: server.output, contentType: 'text/plain' });
      // Stopping the server is outside the scenario; pages may report it.
      browserErrors.stop();
      await Promise.allSettled([api?.dispose(), writer?.dispose()]);
      if (server) await stopServer(server);
      await rm(directory, { recursive: true, force: true });
    }
  }, { timeout: 30_000 }],
});

export { expect };
