# End-to-end tests

Playwright journeys that drive the real `oneloop` binary in Chromium, Firefox
and WebKit.

```sh
cargo build --locked                  # or: cargo build --locked --release
npm --prefix e2e ci
npm --prefix e2e exec -- playwright install chromium firefox webkit
npm --prefix e2e run test:smoke       # @smoke journeys in Chromium, under 2 minutes
npm --prefix e2e test                 # every journey in all three browsers, under 10 minutes
```

The harness runs `target/debug/oneloop` by default. A debug build serves the
frontend from disk, so frontend edits need no rebuild. Set `ONELOOP_TEST_BINARY`
to test another build, such as the release binary CI uses:

```sh
ONELOOP_TEST_BINARY=target/release/oneloop npm --prefix e2e test
```

A relative path is resolved from the directory you run the command in.
`ONELOOP_TEST_BINARY` belongs to this harness only; the application does not
read it. Pass Playwright options after `--`, for example
`npm --prefix e2e test -- --project=firefox journeys/pool.spec.mjs`.

## Layout

- `journeys/` groups tests by what a user does: `startup`, `board`, `roadmap`,
  `task`, `attachments`, `pool`, `inbox`, `administration`, `accessibility`,
  `dates` and `integrations` (MCP and OAuth clients). Tag a journey
  `{ tag: '@smoke' }` when it guards a core path and stays fast.
- `support/test.mjs` is the only import a journey needs: `test`, `expect`,
  `command` and the helpers below.
- `playwright.config.mjs` is the single configuration. Traces, screenshots and
  reports go to `target/e2e-results` and `target/e2e-report`.

## What every test gets

- **A disposable instance.** Each test serves its own copy of a seeded data
  directory from `target/e2e-instances/` on its own port, and stops it
  afterwards. Nothing is shared between tests, so they run fully in parallel.
  Each worker builds the seed once through the real CLI and API: two
  administrators (`instance.api` for the owner, `instance.writer` as another
  client), two projects with a track, epic and task each, and one Pool item.
- **Ports 19800–19899.** Each worker owns ten ports below the ephemeral range,
  so up to ten workers can run at once.
- **Strict browser errors.** An uncaught page error or unexpected console error
  fails the test. A test that injects a failure lists the console text it
  expects in `allowedConsoleErrors`; a security probe declares its exact page
  error in `expectedPageErrors`, and that error must occur.

## Helpers

- `openApp(page, instance, route)` signs the browser in through the API,
  opens the route and waits until the live event stream is subscribed, so
  changes made afterwards reach the page. Tests of the sign-in screen use
  `signIn` instead.
- `holdResponses(page, pattern)` holds real server responses until released,
  to reproduce slow reads without faking them.
- `failUntilRetry(page, pattern, failure)` fails reads until the user presses
  Retry, so background refreshes cannot remove the Retry button first.
- `command(api, operation, payload, revision)` sends one domain command.

## Writing reliable journeys

- Wait for a condition, never for time: use web-first assertions,
  `expect.poll`, a held response or the response a click causes. Drive timers
  with `page.clock`.
- Set up data through `command` or the API before `openApp`, or wait for the
  change to render when the page is already open.
- Firefox runs with Cross-Origin-Opener-Policy process switching disabled; see
  `playwright.config.mjs`. The startup journey still checks the header.

## Documentation screenshots

`screenshots.mjs` regenerates the images in `docs/src/assets/screenshots/`. It
seeds a fictional project into `target/screenshots/`, serves it on a port from
19950 to 19954, captures the Board, the Roadmap and a task page in Chromium,
and stops the server. It uses the release build unless `ONELOOP_TEST_BINARY`
is set, and compresses the images with pngquant and oxipng when they are
installed.

```sh
cargo build --locked --release
node e2e/screenshots.mjs
```
