import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';

/**
 * A local HTTPS Git host for Knowledge journeys: `git http-backend` behind a
 * throwaway self-signed certificate. The oneloop server trusts it through
 * `GIT_SSL_CAINFO`, as an operator would for a private certificate authority.
 * A repository created with a token answers only Basic authentication with
 * that token, like a private repository on a hosting service.
 */
export async function startGitServer(directory) {
  await mkdir(directory, { recursive: true });
  const key = join(directory, 'key.pem'), certificate = join(directory, 'certificate.pem');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', key, '-out', certificate]);
  const root = join(directory, 'repositories');
  await mkdir(root, { recursive: true });
  /** @type {Map<string,string>} */
  const tokens = new Map();
  /** @type {Set<string>} */
  const unavailable = new Set();
  const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    if (unavailable.has(new URL(request.url, 'https://127.0.0.1').pathname.split('/')[1])) { response.writeHead(503); response.end(); return; }
    serveGit(request, response, root, tokens);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `https://127.0.0.1:${server.address().port}`;
  let commits = 0;

  return {
    url,
    caFile: certificate,
    /**
     * Create `<name>.git` with `files` committed on `main` and return its URL.
     * `time` (Unix seconds) dates the commit.
     */
    async repository(name, files, { token, time = 1_758_000_000 } = {}) {
      const work = join(directory, 'work', name);
      await mkdir(work, { recursive: true });
      git(work, ['init', '--quiet', '--initial-branch=main']);
      await writeFiles(work, files);
      commit(work, time + commits++);
      git(root, ['clone', '--quiet', '--bare', work, `${name}.git`]);
      git(join(root, `${name}.git`), ['config', 'uploadpack.allowFilter', 'true']);
      git(work, ['remote', 'add', 'origin', join(root, `${name}.git`)]);
      if (token) tokens.set(`${name}.git`, token);
      return `${url}/${name}.git`;
    },
    /** Commit `files` (null removes a file) to `<name>.git`. */
    async update(name, files, { time = 1_758_100_000 } = {}) {
      const work = join(directory, 'work', name);
      await writeFiles(work, files);
      commit(work, time + commits++);
      git(work, ['push', '--quiet', 'origin', 'main']);
    },
    /** Answer 503 for `<name>.git` until called again with `false`. */
    unavailable(name, down = true) { if (down) unavailable.add(`${name}.git`); else unavailable.delete(`${name}.git`); },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

async function writeFiles(work, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(work, path);
    if (content === null) { git(work, ['rm', '--quiet', '-r', '--', path]); continue; }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function commit(work, time) {
  git(work, ['add', '--all']);
  git(work, ['commit', '--quiet', '--allow-empty', '--message', 'Update the handbook'], { GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` });
}

const gitEnvironment = (home) => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' });

function git(cwd, args, extra = {}) {
  run('git', ['-c', 'user.name=Handbook', '-c', 'user.email=handbook@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...gitEnvironment(cwd), ...extra } });
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30_000, ...options });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed: ${result.error?.message || result.stderr}`);
}

/** Run `git http-backend` as a CGI program for one request. */
function serveGit(request, response, root, tokens) {
  const url = new URL(request.url, 'https://127.0.0.1');
  const token = tokens.get(url.pathname.split('/')[1]);
  if (token && request.headers.authorization !== `Basic ${Buffer.from(`oneloop:${token}`).toString('base64')}`) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Git"' });
    response.end();
    return;
  }
  const child = spawn('git', ['http-backend'], {
    env: {
      ...gitEnvironment(root),
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      ...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}),
      HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
      GIT_PROTOCOL: request.headers['git-protocol'] ?? '',
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  request.pipe(child.stdin);
  let head = Buffer.alloc(0), started = false;
  child.stdout.on('data', chunk => {
    if (started) { response.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const text = head.toString('latin1'), end = text.search(/\r?\n\r?\n/);
    if (end < 0) return;
    const separator = text.slice(end).match(/^\r?\n\r?\n/)[0];
    let status = 200;
    const headers = {};
    for (const line of text.slice(0, end).split(/\r?\n/)) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    started = true;
    const rest = head.subarray(end + separator.length);
    if (rest.length) response.write(rest);
  });
  child.stdout.on('end', () => { if (!started) response.writeHead(502); response.end(); });
  child.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on('aborted', () => child.kill());
}
