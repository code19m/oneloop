# Contributing to oneloop

Thanks for helping. This guide gets you from a fresh clone to a merged pull
request. For a map of the code and the rules it keeps, read
[ARCHITECTURE.md](ARCHITECTURE.md).

## Getting set up

You need:

- **Rust.** `rust-toolchain.toml` pins the toolchain, which is also the
  minimum supported version. rustup installs it on first use.
- **A C compiler.** SQLite is compiled in, so `cc` must work.
- **Node.js 22 or newer**, for frontend checks and browser tests. The exact
  range is in `frontend/package.json`.
- **mdBook 0.5.4**, the version CI uses, only if you change the documentation
  site.

Install the JavaScript tools. They are needed only for checks and tests; the
app itself has no JavaScript build step.

```sh
npm --prefix frontend ci
npm --prefix e2e ci
npm --prefix e2e exec -- playwright install chromium firefox webkit
```

## Running the app locally

Use a throwaway data directory. `.local/` is ignored by Git.

```sh
export ONELOOP_PUBLIC_URL=http://localhost:8080
export ONELOOP_DATA_DIR="$PWD/.local/dev-data"
cargo run -- db migrate
cargo run -- user add admin --admin
cargo run -- serve
```

Open <http://localhost:8080> and sign in. Use the same host name as
`ONELOOP_PUBLIC_URL`; oneloop rejects requests for any other host.

The web client in `frontend/` is embedded in the binary. A debug build reads
it from disk, so frontend changes need no rebuild. Browsers cache the client's
files for good, so use a hard reload (Shift+Cmd+R or Ctrl+Shift+R) to see a
change. A release build needs a rebuild.

## Checks before a pull request

Run these from the repository root:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix e2e run test:smoke

# If you changed repository scripts:
node --test "scripts/tests/*.test.mjs"
# If you changed dependencies, vendored files or the Markdown preview styles:
node scripts/third-party-notices.mjs --check
node scripts/vendor-verify.mjs --local
node scripts/vendor-audit.mjs --check
node scripts/markdown-preview-css.mjs --check
# If you changed the docs:
mdbook build docs
node scripts/check-doc-links.mjs
```

The smoke tests run the `target/debug/oneloop` that `cargo test` builds, so
don't run `cargo build` as well. Tests turn on extra Tokio and SQLite
features, so `cargo build` compiles many dependencies and oneloop a second
time.

CI runs all of these, plus a dependency audit, a Docker build, the full
end-to-end suite on `main` and the tests on macOS. If you change something on a
hot path, compare `cargo bench --bench workload` before and after.

## Tests

| Kind | Where | Add one when |
| --- | --- | --- |
| Unit | A `#[cfg(test)] mod tests` next to the code, inline or in a sibling `tests.rs` | A private function has logic worth pinning down on its own |
| Integration | `tests/integration/`, one test crate (`main.rs`) with one module per area and shared helpers in `support/` | Behavior is visible through HTTP, MCP or the CLI. Most backend changes belong here |
| Frontend unit | `frontend/tests/` | You change a module in `frontend/src/` or rendering in `frontend/views/` |
| End-to-end | `e2e/journeys/`, Playwright against the real binary | A user journey needs a real browser. Tag the fast, essential ones `@smoke` |

Run one integration area with `cargo test --locked --test integration files::`.
[e2e/README.md](e2e/README.md) explains the browser harness.

Name a test after the behavior it checks, for example
`revoked_session_cannot_open_event_stream`, and check one behavior per test.
Tests must not depend on sleeps, the wall clock, the host time zone or locale.
Use the smallest input that exercises the logic, such as one item more than a
batch. Scale and speed belong in `benches/workload.rs`, which CI runs in full
every week.

Keep the suites fast. Warm `cargo test` should finish in under 60 seconds on a
10-core laptop, frontend unit tests in under 10 seconds, the end-to-end smoke
set in under 2 minutes, and the full end-to-end suite in a few minutes locally
(about 12 on CI's two workers). CI doesn't enforce these budgets: its job
timeouts only stop runs that hang. When you add slow tests, compare the step
times in CI.

## Pull requests

- Keep each pull request small and about one thing. Leave unrelated cleanup for
  another one.
- For a large change, a new feature or anything that changes behavior people
  rely on, open an issue first so we can agree on the approach.
- Describe the problem, the new behavior and the checks you ran.
- Update the documentation and the `Unreleased` section of
  [CHANGELOG.md](CHANGELOG.md) in the same pull request when users would notice
  the change.
- Never edit a migration that has been released. Add a new one; see
  [ARCHITECTURE.md](ARCHITECTURE.md#migrations).
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

By contributing, you license your work under the [MIT license](LICENSE). Only
contribute work you have the right to license.

## Writing documentation

The site in `docs/src/` is for people who use or run oneloop. Preview it with
`mdbook serve docs`.

- Write plain English that non-native speakers can follow: short sentences,
  common words, "you" and the active voice.
- Say each thing once, on the page where readers look for it, and link to it
  from other pages. Each page has one job:

  | Page | Covers |
  | --- | --- |
  | `install.md` | Getting oneloop running on one computer |
  | `user-guide.md`, `admin-guide.md` | Using the app, and managing people, projects and storage |
  | `mcp.md` | Connecting AI assistants, and the MCP tool reference |
  | `production.md` | HTTPS, the reverse proxy, services and security |
  | `backups-and-upgrades.md`, `troubleshooting.md` | Running oneloop over time |
  | `reference.md` | Every setting, command and limit |

- Start with what the reader needs, not with a sentence about the page. Show the
  command or the setting first, then explain what isn't obvious.
- Explain rules and behavior that readers can't see in the app. Skip
  click-by-click steps for things the interface already makes clear.
- Use UI labels exactly as the app shows them, such as **Board**, **Pool** and
  **Planning**.
- Keep the sidebar short: add a section to a page before you add a page. When
  you rename or remove a page or heading that people may have linked to, add a
  redirect in `docs/book.toml`.
- Change the docs in the same pull request as the behavior. A new environment
  variable or command goes in `reference.md`, and a new MCP tool or operation in
  `mcp.md`; tests in `src/config.rs` and `tests/integration/docs.rs` check
  them. The pages include
  `deploy/compose.yaml` and the nginx example directly, so edit those files
  instead of copying them.

## Releases and dependencies

Maintainers release oneloop and keep its dependencies up to date as
[RELEASING.md](RELEASING.md) describes.
