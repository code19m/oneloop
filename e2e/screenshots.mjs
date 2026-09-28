// Regenerates the product screenshots in docs/src/assets/screenshots/.
//
//   cargo build --locked --release
//   node e2e/screenshots.mjs
//
// The script seeds a fictional team project through the real CLI and HTTP API
// into a disposable data directory under target/screenshots/, then moves the
// seeded timestamps into the past so the history reads like two weeks of work.
// It serves the result on a local port, captures the Board, the Roadmap and a
// task page in Chromium, and stops the server. Dates are relative to today, so
// the pictures always look current. pngquant and oxipng compress the images
// when they are installed.
//
// Set ONELOOP_TEST_BINARY to use another build. CI does not run this script.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request } from '@playwright/test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.ONELOOP_TEST_BINARY
  ? resolve(process.env.ONELOOP_TEST_BINARY)
  : join(repository, 'target', 'release', 'oneloop');
const dataDir = join(repository, 'target', 'screenshots', 'data');
const output = join(repository, 'docs', 'src', 'assets', 'screenshots');
const PORTS = [19950, 19951, 19952, 19953, 19954];
const VIEWPORT = { width: 1440, height: 900 };

// ---------------------------------------------------------------------------
// The story: Harbor, a five-person team redesigning a mobile banking app.

const people = {
  maya: { name: 'Maya Lindqvist', admin: true }, // Product lead; the screenshots show her view.
  daniel: { name: 'Daniel Okafor' },
  priya: { name: 'Priya Raman' },
  kenji: { name: 'Kenji Watanabe' },
  sofia: { name: 'Sofía Marín' },
};

const tracks = [
  { key: 'design', name: 'Design', description: 'Visual language, flows and research.' },
  { key: 'mobile', name: 'Mobile apps', description: 'The iOS and Android apps.' },
  { key: 'platform', name: 'Platform', description: 'APIs and services behind the apps.' },
];

// Start and end are days from today. A `done` epic is completed after its tasks.
const epics = [
  { key: 'system', track: 'design', title: 'Design system 2.0', start: -30, end: -5, done: true,
    description: 'Tokens, type scale and icons shared by both apps.' },
  { key: 'onboarding', track: 'design', title: 'Onboarding redesign', start: -12, end: 16,
    description: 'A shorter sign-up with identity checks up front.' },
  { key: 'home', track: 'mobile', title: 'Accounts home', start: -18, end: 10,
    description: 'The new first screen: balances, recent activity and quick actions.' },
  { key: 'cards', track: 'mobile', title: 'Card controls', start: 6, end: 34,
    description: 'Freeze cards, set limits and manage online payments.' },
  { key: 'payments', track: 'platform', title: 'Payments API v2', start: -24, end: 8,
    description: 'Faster transfers with idempotent requests and payee search.' },
  { key: 'push', track: 'platform', title: 'Push notifications', start: 12, end: 40,
    description: 'Real-time alerts for payments and card activity.' },
];

const milestones = [
  { title: 'Private beta', day: 14, description: 'Two hundred customers on the beta builds.' },
  { title: 'Public launch', day: 45, description: 'The redesign ships to everyone.' },
];

const featured = 'Balance cards carousel';
const blocked = 'Instant transfer confirmation sheet';

// Created in this order, which is also their order within each column; the
// Planning tasks are added later than the rest. `status` is where each task
// ends up; a deadline is in days from today.
const tasks = [
  { title: 'Typography and spacing tokens', epic: 'system', status: 'done', assignees: ['priya'] },
  { title: 'Icon set export for iOS and Android', epic: 'system', status: 'done', assignees: ['priya'] },
  { title: 'Rate limiting on the payments gateway', epic: 'payments', status: 'done', assignees: ['kenji'] },
  { title: 'Skeleton loading states', epic: 'home', status: 'done', assignees: ['daniel'] },
  { title: 'Phone number verification', epic: 'onboarding', status: 'done', assignees: ['sofia'] },
  { title: featured, epic: 'home', status: 'in_progress', assignees: ['daniel'], deadline: 3,
    description: 'Swipeable balance cards at the top of the accounts home, one per account. The next card '
      + 'peeks in from the edge, and tapping a card opens the account. Three cards for the beta; the rest '
      + 'go behind All accounts.' },
  { title: blocked, epic: 'payments', status: 'in_progress', assignees: ['sofia'],
    description: 'The sheet that confirms an instant transfer: amount, fee, payee and arrival time.' },
  { title: 'Recent transactions list', epic: 'home', status: 'in_progress', assignees: ['sofia', 'daniel'] },
  { title: 'Welcome screen illustrations', epic: 'onboarding', status: 'in_progress', assignees: ['priya'] },
  { title: 'Idempotent transfer requests', epic: 'payments', status: 'in_progress', assignees: ['kenji'] },
  { title: 'Payee search with fuzzy matching', epic: 'payments', status: 'in_review', assignees: ['kenji'], deadline: 1 },
  { title: 'Biometric sign-in on Android', epic: 'onboarding', status: 'in_review', assignees: ['sofia'] },
  { title: 'Dark mode for the accounts home', epic: 'home', status: 'in_review', assignees: ['priya', 'daniel'] },
  { title: 'Accessibility review of the accounts home', epic: 'home', status: 'planning', assignees: ['priya'], deadline: 9 },
  { title: 'Card freeze and unfreeze', epic: 'cards', status: 'planning', assignees: ['daniel'] },
  { title: 'Per-category spending limits', epic: 'cards', status: 'planning', assignees: [] },
  { title: 'Notification preferences screen', epic: 'push', status: 'planning', assignees: ['sofia'] },
  { title: 'Device token registration service', epic: 'push', status: 'planning', assignees: ['kenji'] },
];

const ideas = ['Round-up savings on card payments', 'Split a bill with contacts'];

const blockReason = 'Waiting for the final fee wording from compliance. @Maya Lindqvist is following up with them this week.';

// The discussion on the featured task. `@Full Name` becomes a mention.
const discussion = [
  { phase: 'comment-1', author: 'priya', text: 'Updated the mockup: the next card now peeks in by 24 px, so the row reads as swipeable. @Daniel Okafor can you check it on the smaller iPhones?' },
  { phase: 'comment-2', author: 'daniel', replyTo: 0, text: 'Checked on the SE and the 13 mini. The peek works, but balances over 1,000,000 wrap onto two lines, so I’ll step the figure down one size for long amounts.' },
  { phase: 'comment-3', author: 'maya', text: 'Looks good. Let’s keep it to three cards for the beta and send the rest to All accounts.' },
  { phase: 'comment-4', author: 'daniel', text: 'Long amounts fit now, and the build is on TestFlight. I’ll move this to review once the snapshot tests pass.' },
];

// How long before now each seeding phase appears to have happened, in seconds.
const HOUR = 3600, DAY = 24 * HOUR;
const phases = {
  setup: 14 * DAY,
  finished: 6 * DAY,
  backlog: 5 * DAY,
  started: 3 * DAY + 4 * HOUR,
  blocked: 2 * DAY + HOUR,
  mockup: 27 * HOUR + 20 * 60,
  'comment-1': 27 * HOUR,
  'comment-2': 25 * HOUR,
  'comment-3': 6 * HOUR,
  'comment-4': 2 * HOUR,
};

// ---------------------------------------------------------------------------
// The instance

const today = new Date();
function day(offset) {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)).toISOString().slice(0, 10);
}

/** Environment for the binary, never inheriting a developer's own instance configuration. */
function environment(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('ONELOOP_')) delete env[name];
  return Object.assign(env, { ONELOOP_DATA_DIR: dataDir }, extra);
}

function cli(args, input) {
  const result = spawnSync(binary, args, { env: environment(), input, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`oneloop ${args.join(' ')} failed: ${result.error?.message || result.stderr}`);
}

async function portIsFree(port) {
  const socket = createServer();
  try {
    await new Promise((done, fail) => { socket.once('error', fail); socket.listen(port, '127.0.0.1', done); });
    await new Promise(done => socket.close(done));
    return true;
  } catch { return false; }
}

async function serve() {
  for (const port of PORTS) {
    if (!await portIsFree(port)) continue;
    const url = `http://127.0.0.1:${port}`;
    const env = environment({ ONELOOP_LISTEN: `127.0.0.1:${port}`, ONELOOP_PUBLIC_URL: url, ONELOOP_TIMEZONE: 'UTC' });
    const child = spawn(binary, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const listening = new Promise((done, fail) => {
      const collect = chunk => { log = (log + chunk).slice(-8_000); if (log.includes('oneloop listening')) done(); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('exit', code => fail(new Error(`oneloop serve exited (${code}):\n${log}`)));
    });
    const timeout = new Promise((_, fail) => setTimeout(() => fail(new Error(`oneloop serve did not start:\n${log}`)), 15_000).unref());
    try { await Promise.race([listening, timeout]); } catch (error) { await stop({ child }); throw error; }
    return { url, child };
  }
  throw new Error(`No free port among ${PORTS.join(', ')}`);
}

async function stop({ child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(force); }
}

// ---------------------------------------------------------------------------
// Seeding

async function signIn(url, username, password) {
  const api = await request.newContext({ baseURL: url, extraHTTPHeaders: { Origin: url } });
  const login = await api.post('/api/auth/login', { data: { username, password } });
  if (!login.ok()) throw new Error(`sign in ${username}: ${await login.text()}`);
  return { api, user: (await login.json()).user };
}

async function command(api, operation, payload, expectedRevision) {
  const response = await api.post('/api/commands', { data: { operation, payload, expectedRevision, idempotencyKey: randomUUID() } });
  if (!response.ok()) throw new Error(`${operation}: ${await response.text()}`);
  return (await response.json()).entities[0];
}

function mentions(text, userIds) {
  const found = [];
  for (const [key, person] of Object.entries(people)) {
    const label = `@${person.name}`;
    const start = text.indexOf(label);
    if (start >= 0) found.push({ kind: 'user', userId: userIds[key], startOffset: start, endOffset: start + label.length, label });
  }
  return found;
}

/** A small phone mockup of the carousel, rendered in the browser, to attach to the featured task. */
async function renderMockup(browser) {
  const page = await browser.newPage({ viewport: { width: 360, height: 360 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><style>
    body { margin:0; height:360px; display:grid; place-items:center; background:#e9edf2; font:600 13px/1.3 system-ui, sans-serif; }
    .phone { width:210px; height:330px; margin-top:60px; padding:22px 0 0 16px; border-radius:30px; background:#fff; box-shadow:0 10px 30px #1a2a4022; overflow:hidden; }
    .row { display:flex; gap:10px; }
    .card { flex:0 0 150px; height:92px; padding:12px; box-sizing:border-box; border-radius:14px; color:#fff; }
    .card small { display:block; font-weight:500; opacity:.8; }
    .card b { display:block; margin-top:22px; font-size:17px; }
    .everyday { background:linear-gradient(135deg,#1f4e79,#2f7fb8); }
    .savings { background:linear-gradient(135deg,#1c6b5a,#39a58a); }
    .line { height:9px; margin:14px 16px 0 0; border-radius:5px; background:#e4e8ee; }
    .short { width:55%; }
  </style><div class="phone"><div class="row">
    <div class="card everyday"><small>Everyday</small><b>€2,418.50</b></div>
    <div class="card savings"><small>Savings</small><b>€12,960</b></div>
  </div><div class="line"></div><div class="line short"></div><div class="line"></div><div class="line short"></div></div>`);
  const png = await page.screenshot();
  await page.close();
  return png;
}

/**
 * Start the next phase on a whole second, so every timestamp the server
 * writes belongs to exactly one phase.
 */
async function phase(log, name) {
  const start = Math.floor(Date.now() / 1000) + 1;
  await new Promise(done => setTimeout(done, start * 1000 - Date.now() + 5));
  log.push({ name, start });
}

async function seed(browser, log) {
  await phase(log, 'setup');
  const passwords = {};
  for (const [username, person] of Object.entries(people)) {
    passwords[username] = randomUUID();
    cli(['user', 'add', username, '--name', person.name, '--password-stdin', ...(person.admin ? ['--admin'] : [])], `${passwords[username]}\n`);
  }
  const server = await serve();
  const clients = {};
  try {
    const userIds = {};
    for (const username of Object.keys(people)) {
      const { api, user } = await signIn(server.url, username, passwords[username]);
      clients[username] = api;
      userIds[username] = user.id;
      if (people[username].admin) continue;
      // Everyone but the first admin chooses a new password at first sign-in.
      const changed = await api.post('/api/auth/change-password', { data: { currentPassword: passwords[username], newPassword: randomUUID() } });
      if (!changed.ok()) throw new Error(`change password ${username}: ${await changed.text()}`);
    }
    const lead = clients.maya;
    const project = await command(lead, 'project.create', { name: 'Harbor', taskPrefix: 'HBR' });
    for (const [username, userId] of Object.entries(userIds)) {
      await command(lead, 'membership.add', { projectId: project.id, userId, manageRoadmap: username === 'maya', manageBoard: true });
    }
    const trackIds = {}, epicIds = {}, created = {};
    for (const track of tracks) {
      trackIds[track.key] = (await command(lead, 'track.create', { projectId: project.id, name: track.name, description: track.description })).id;
    }
    for (const epic of epics) {
      epicIds[epic.key] = (await command(lead, 'epic.create', {
        projectId: project.id, trackId: trackIds[epic.track], title: epic.title,
        description: epic.description, startDate: day(epic.start), endDate: day(epic.end),
      })).id;
    }
    for (const milestone of milestones) {
      await command(lead, 'milestone.create', { projectId: project.id, title: milestone.title, description: milestone.description, milestoneDate: day(milestone.day) });
    }
    const create = async task => {
      created[task.title] = await command(lead, 'task.create', {
        projectId: project.id, epicId: epicIds[task.epic], title: task.title, description: task.description ?? '',
        deadline: task.deadline === undefined ? null : day(task.deadline), assigneeIds: task.assignees.map(key => userIds[key]),
      });
    };
    for (const task of tasks.filter(item => item.status !== 'planning')) await create(task);
    // Each task's first assignee moves it, as they would on the Board.
    const move = async (task, status) => {
      const { id, revision } = created[task.title];
      created[task.title] = await command(clients[task.assignees[0] ?? 'maya'], 'task.move', { taskId: id, status }, revision);
    };

    await phase(log, 'finished');
    for (const task of tasks.filter(item => item.status === 'done')) await move(task, 'done');
    const roadmap = await (await lead.get(`/api/projects/${project.id}/roadmap`)).json();
    for (const epic of epics.filter(item => item.done)) {
      await command(lead, 'epic.complete', { id: epicIds[epic.key] }, findById(roadmap, epicIds[epic.key]).revision);
    }

    await phase(log, 'backlog');
    for (const task of tasks.filter(item => item.status === 'planning')) await create(task);
    for (const title of ideas) await command(lead, 'pool.create', { projectId: project.id, scope: 'team', title });

    await phase(log, 'started');
    for (const task of tasks.filter(item => item.status === 'in_progress' || item.status === 'in_review')) await move(task, 'in_progress');
    for (const task of tasks.filter(item => item.status === 'in_review')) await move(task, 'in_review');

    await phase(log, 'blocked');
    await command(clients.sofia, 'task.block', { taskId: created[blocked].id, reason: blockReason, mentions: mentions(blockReason, userIds) }, created[blocked].revision);

    await phase(log, 'mockup');
    const mockup = await renderMockup(browser);
    const upload = await clients.priya.post(`/api/tasks/${created[featured].id}/attachments`, {
      headers: { 'Idempotency-Key': randomUUID(), 'X-File-Size': String(mockup.length) },
      multipart: { file: { name: 'balance-cards-mockup.png', mimeType: 'image/png', buffer: mockup } },
    });
    if (!upload.ok()) throw new Error(`upload: ${await upload.text()}`);

    const comments = [];
    for (const comment of discussion) {
      await phase(log, comment.phase);
      comments.push(await command(clients[comment.author], 'discussion.comment.create', {
        taskId: created[featured].id, content: comment.text, mentions: mentions(comment.text, userIds),
        ...(comment.replyTo === undefined ? {} : { replyToId: comments[comment.replyTo].id }),
      }));
    }
    await phase(log, 'end');
    return { password: passwords.maya, taskKey: created[featured].taskKey };
  } finally {
    await Promise.all(Object.values(clients).map(api => api.dispose()));
    await stop(server);
  }
}

function findById(value, id) {
  if (!value || typeof value !== 'object') return null;
  if (value.id === id) return value;
  for (const item of Object.values(value)) {
    const found = findById(item, id);
    if (found) return found;
  }
  return null;
}

/**
 * Move every timestamp written during a phase to that phase's place in the
 * story. Order is preserved; expiry times are left alone. Run only while the
 * server is stopped.
 */
async function backdate(log) {
  // node:sqlite is still experimental in Node 22; keep its warning out of the output.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => { if (!String(warning).includes('SQLite')) emitWarning.call(process, warning, ...rest); };
  const { DatabaseSync } = await import('node:sqlite');
  process.emitWarning = emitWarning;

  const now = log.at(-1).start;
  const shifts = log.slice(0, -1).map((entry, i) => ({ from: entry.start, to: log[i + 1].start, by: entry.start - (now - phases[entry.name]) }));
  const shifted = column => `CASE ${shifts.map(({ from, to, by }) => `WHEN ${column} >= ${from} AND ${column} < ${to} THEN ${column} - ${by}`).join(' ')} ELSE ${column} END`;
  const db = new DatabaseSync(join(dataDir, 'oneloop.sqlite3'));
  try {
    db.exec('BEGIN');
    for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      const assignments = db.prepare(`PRAGMA table_info("${table}")`).all()
        .filter(column => column.type === 'INTEGER' && column.name.endsWith('_at') && !column.name.includes('expires'))
        .map(column => `"${column.name}" = ${shifted(`"${column.name}"`)}`);
      if (assignments.length) db.exec(`UPDATE "${table}" SET ${assignments.join(', ')}`);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Capture

async function settle(page) {
  await page.evaluate(async () => {
    document.activeElement?.blur();
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  // Give late background reads, such as counters, a moment to render.
  await page.waitForTimeout(500);
}

async function capture(browser, url, password, taskKey) {
  const context = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce',
    locale: 'en-US', timezoneId: 'UTC',
  });
  await context.addInitScript(() => localStorage.setItem('oneloop.theme', 'light'));
  const page = await context.newPage();
  const login = await page.request.post(`${url}/api/auth/login`, { data: { username: 'maya', password }, headers: { Origin: url } });
  if (!login.ok()) throw new Error(`sign in: ${await login.text()}`);

  const shots = {
    board: { route: 'board', ready: '.col .card' },
    roadmap: {
      route: 'roadmap', ready: '.bar',
      // Show the timeline from its first day, as after scrolling back.
      arrange: () => page.evaluate(() => {
        const timeline = document.getElementById('rmScroll');
        timeline.scrollLeft = 0;
        timeline.dispatchEvent(new Event('scroll'));
      }),
    },
    task: {
      route: `task/${taskKey}`, ready: '.tl-cmt',
      // The discussion sits below the fold: scroll until the upload area has
      // just left the view, so the attachment leads into the activity.
      arrange: () => page.evaluate(() => {
        const scroller = document.querySelector('.task-page');
        const upload = document.querySelector('.attachment-dropzone');
        scroller.scrollTop += upload.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 1;
      }),
    },
  };
  const files = [];
  for (const [name, shot] of Object.entries(shots)) {
    await page.goto(`${url}/#/${shot.route}`);
    await page.locator('.sidebar').waitFor();
    await page.locator(shot.ready).first().waitFor();
    await shot.arrange?.();
    await settle(page);
    const file = join(output, `${name}.png`);
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    files.push(file);
  }
  await context.close();
  return files;
}

/** Compress with pngquant and oxipng when they are installed; otherwise keep the originals. */
function optimize(file) {
  const installed = tool => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;
  if (installed('pngquant')) spawnSync('pngquant', ['--force', '--skip-if-larger', '--strip', '--quality=85-98', '--output', file, file]);
  if (installed('oxipng')) spawnSync('oxipng', ['--opt', '4', '--strip', 'safe', file]);
}

// ---------------------------------------------------------------------------

if (!existsSync(binary)) throw new Error(`Missing ${binary}. Build it with \`cargo build --locked --release\`, or set ONELOOP_TEST_BINARY.`);
await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(output, { recursive: true });
cli(['db', 'migrate']);

const browser = await chromium.launch();
try {
  const log = [];
  const { password, taskKey } = await seed(browser, log);
  await backdate(log);
  const server = await serve();
  try {
    for (const file of await capture(browser, server.url, password, taskKey)) {
      optimize(file);
      console.log(`${relative(repository, file)}  ${Math.round((await stat(file)).size / 1024)} KB`);
    }
  } finally {
    await stop(server);
  }
} finally {
  await browser.close();
}
