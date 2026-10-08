import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';

/** Fill and submit the sign-in form that is already on screen. */
export async function signIn(page, { username, password }) {
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Wait until the signed-in application shell has rendered. */
export async function expectSignedIn(page) {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.auth')).toHaveCount(0);
}

const watchedPages = new WeakSet();

/** Record the live event stream's opening event ('ready' or 'reconcile') in each document. */
async function watchLiveChannel(page) {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        for (const kind of ['ready', 'reconcile']) this.addEventListener(kind, () => { window.__oneloopLiveChannel ??= kind; });
      }
    };
  });
}

/**
 * Open a route as a signed-in user and wait until its live event stream is
 * subscribed, so changes made after this call reach the page. The browser
 * context gets its own session through the API (page.request shares the
 * context's cookies); only tests about the sign-in screen use the form.
 */
export async function openApp(page, instance, route = `task/${instance.projects[0].task.taskKey}`) {
  await watchLiveChannel(page);
  const { username, password } = instance;
  const login = await page.request.post(`${instance.url}/api/auth/login`, { data: { username, password }, headers: { Origin: instance.url } });
  expect(login.ok(), `sign in ${username}: ${await login.text()}`).toBeTruthy();
  const target = `${instance.url}/#/${route}`;
  const sameDocument = page.url().split('#')[0] === target.split('#')[0];
  await page.goto(target, { waitUntil: 'commit' });
  // A hash change keeps the signed-out document; load it again with the session.
  if (sameDocument) await page.reload({ waitUntil: 'commit' });
  await expectSignedIn(page);
  await waitForLiveChannel(page);
}

/** Wait until this document's live event stream has opened, for example after page.reload(). */
export async function waitForLiveChannel(page) {
  await expect.poll(() => page.evaluate(() => window.__oneloopLiveChannel ?? null), { message: 'live event stream opens' }).not.toBeNull();
}

/** Start every document in this page with the given stored theme. */
export async function useTheme(page, theme) {
  await page.addInitScript(value => localStorage.setItem('oneloop.theme', value), theme);
}

/**
 * Answer matching GET requests with `failure` until the user presses a Retry
 * button; that press and everything after it reach the real server. Automatic
 * background refreshes before the press keep failing, so the Retry control
 * cannot disappear before the test uses it. Call before the page loads.
 * With `gate`, the first failure waits until that promise settles.
 */
export async function failUntilRetry(page, pattern, failure, { gate } = {}) {
  await page.addInitScript(() => {
    document.addEventListener('click', event => {
      if (event.target.closest?.('button')?.textContent.trim() === 'Retry') window.__retryPressed = true;
    }, true);
  });
  let first = true;
  await page.route(pattern, async route => {
    if (route.request().method() !== 'GET' || await page.evaluate(() => !!window.__retryPressed).catch(() => false)) return route.continue();
    if (first && gate) { first = false; await gate; }
    return route.fulfill({ contentType: 'application/json', ...failure });
  });
}

/** Hold matching server responses until released; writes still reach the real backend. */
export async function holdResponses(page, pattern) {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Set();
  const handler = async route => {
    const work = (async () => {
      const response = await route.fetch();
      entered();
      await gate;
      await route.fulfill({ response }).catch(() => {}); // Superseded reads may be aborted.
    })();
    pending.add(work);
    try { await work; } finally { pending.delete(work); }
  };
  await page.route(pattern, handler);
  return {
    started,
    async release() {
      release();
      await page.unroute(pattern, handler);
      await Promise.allSettled([...pending]);
    },
  };
}

/**
 * Scan the entire page with axe, including contrast and landmarks, and fail on
 * serious or critical violations. Do not suppress rules. By default AxeBuilder
 * runs axe in each frame and merges the results in an extra blank page. A page
 * without frames needs only one run in the page itself (legacy mode), which
 * gives the same results in about half the time.
 */
export async function scan(page, label) {
  const builder = new AxeBuilder({ page });
  if (page.frames().length === 1) builder.setLegacyMode();
  const result = await builder.analyze();
  const failures = result.violations.filter(item => ['serious', 'critical'].includes(item.impact));
  expect(failures.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })), label).toEqual([]);
}
