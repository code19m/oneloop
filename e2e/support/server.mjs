// Runs the real oneloop binary for the e2e harness and the screenshot script: its
// commands, its server and its command API.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';

const ADDRESS_IN_USE = /address already in use|EADDRINUSE|os error (?:48|98|10048)/i;

/** Environment for the binary, never inheriting a developer's live instance configuration. */
function environment(directory, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('ONELOOP_')) delete env[name];
  return Object.assign(env, { ONELOOP_DATA_DIR: directory }, extra);
}

/** Run `oneloop <args>` on the data directory, with `input` on standard input. */
export function cli(binary, directory, args, input) {
  const result = spawnSync(binary, args, { env: environment(directory), input, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`oneloop ${args.join(' ')} failed: ${result.error?.message || result.stderr}`);
}

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

/** Start `oneloop serve` on the port and resolve once it logs that its listener is bound. */
async function start(binary, directory, port, extra) {
  const url = `http://127.0.0.1:${port}`;
  const env = environment(directory, { ...extra, ONELOOP_LISTEN: `127.0.0.1:${port}`, ONELOOP_PUBLIC_URL: url });
  const child = spawn(binary, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = { url, child, output: '' };
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
    await Promise.race([listening, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`oneloop serve did not start:\n${server.output}`)), 15_000); })]);
  } catch (error) {
    await stopServer(server);
    error.addressInUse = ADDRESS_IN_USE.test(server.output);
    throw error;
  } finally { clearTimeout(timer); }
  return server;
}

/**
 * Serve the data directory on the first of `ports` that is free, with `extra` environment.
 * Another process can take a probed port before the server binds it; only that case moves
 * on to the next port. The server has the `url`, the `child` process and its recent `output`.
 */
export async function serve(binary, directory, ports, extra = {}) {
  for (const port of ports) {
    if (!await portIsFree(port)) continue;
    try { return await start(binary, directory, port, extra); } catch (error) { if (!error.addressInUse) throw error; }
  }
  throw new Error(`No free port among ${ports.join(', ')}`);
}

export async function stopServer({ child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try { await exited; } finally { clearTimeout(force); }
}

/** Send one command to `/api/commands` and return the response; a failure throws. */
export async function command(api, operation, payload, expectedRevision) {
  const response = await api.post('/api/commands', {
    data: { operation, payload, expectedRevision, idempotencyKey: randomUUID() },
  });
  if (!response.ok()) throw new Error(`${operation}: ${await response.text()}`);
  return response.json();
}
