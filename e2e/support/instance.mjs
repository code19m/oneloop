import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from './browser-errors.mjs';
import { cli, command, serve, stopServer } from './server.mjs';

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

function workerPorts(parallelIndex) {
  if (parallelIndex >= MAX_WORKERS) throw new Error(`The e2e harness supports at most ${MAX_WORKERS} workers`);
  const first = PORT_BASE + parallelIndex * PORTS_PER_WORKER;
  return Array.from({ length: PORTS_PER_WORKER }, (_, offset) => first + offset);
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
  if (!existsSync(binary)) throw new Error(`Missing ${binary}. Build it with \`cargo test --locked --all-targets --no-run\`, or set ONELOOP_TEST_BINARY.`);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'template-'));
  const username = 'smoke_owner', password = randomUUID();
  const writerTemporary = randomUUID(), writerPassword = randomUUID();
  cli(binary, directory, ['db', 'migrate']);
  cli(binary, directory, ['user', 'add', username, '--admin', '--name', 'Smoke Owner', '--password-stdin'], `${password}\n`);
  cli(binary, directory, ['user', 'add', 'smoke_writer', '--admin', '--name', 'Smoke Writer', '--password-stdin'], `${writerTemporary}\n`);
  const server = await serve(binary, directory, workerPorts(parallelIndex));
  const { url } = server;
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
      server = await serve(binary, directory, workerPorts(testInfo.parallelIndex), { ...instanceEnvironment, ONELOOP_TIMEZONE: instanceTimeZone });
      const { url } = server;
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
