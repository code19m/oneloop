# Contributing to oneloop

Thanks for helping. This guide gets you from a fresh clone to a merged pull
request. For a map of the code and the rules it keeps, read
[ARCHITECTURE.md](ARCHITECTURE.md).

## Getting set up

You need:

- **Rust.** `rust-toolchain.toml` pins the toolchain (1.92.0, the minimum
  supported version), and rustup installs it on first use.
- **A C compiler.** SQLite is compiled in, so `cc` must work.
- **Node.js 22 or newer**, for frontend checks and browser tests. The exact
  range is in `frontend/package.json`.
- **mdBook**, only if you change the documentation site.

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
cargo build --locked
npm --prefix e2e run test:smoke

# If you changed repository scripts:
node --test "scripts/tests/*.test.mjs"
# If you changed dependencies or vendored files:
node scripts/third-party-notices.mjs --check
node scripts/vendor-verify.mjs --local
# If you changed the docs:
mdbook build docs
node scripts/check-doc-links.mjs
```

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
  `mcp.md`; tests in `tests/integration/docs.rs` check both. The pages include
  `deploy/compose.yaml` and the nginx example directly, so edit those files
  instead of copying them.

## Releasing (maintainers)

Tags are `vX.Y.Z` for releases and `vX.Y.Z-rc.N` for release candidates, for
example `v0.1.0-rc.1`.

1. Set the version in `Cargo.toml` and run `cargo check` to update
   `Cargo.lock`. Update the version that `README.md`, `deploy/compose.yaml`
   and the pages in `docs/src/` show; `rg -F` with the previous version finds
   them. If `CURRENT_SCHEMA_VERSION` changed since the previous release, also
   update the schema numbers in the docs: the sample output of `db migrate`
   and `/healthz`, and the name of the pre-upgrade backup;
   `rg 'migrated from|schema [0-9]|schemaVersion|pre-migration-v' docs/src`
   finds them.
2. In `CHANGELOG.md`, move the `Unreleased` entries into a new
   `## [X.Y.Z] - YYYY-MM-DD` section, update the comparison links at the
   bottom, and note any upgrade steps.
3. Check the version and notes:

   ```sh
   node scripts/release-metadata.mjs vX.Y.Z
   ```
4. Review what ships besides our own code:
   - regenerate and review the notices with `node scripts/third-party-notices.mjs`,
     then run `node scripts/vendor-audit.mjs --check`;
   - look at the latest Dependencies workflow run;
   - compare the bundled SQLite version with SQLite's release and security
     notes, because the Rust advisory database doesn't cover it.
5. Build the image and try it on both architectures if you can: first run,
   an upgrade from the previous release, and a backup restore.
6. Merge to `main`. Then tag the merged release commit, usually `origin/main`,
   and push the tag:

   ```sh
   git fetch origin
   git tag vX.Y.Z origin/main
   git push origin vX.Y.Z
   ```

The Release workflow then:

- checks that the tag is on `main`, is not released yet and matches
  `Cargo.toml` and `CHANGELOG.md`, then runs the full verification and the
  dependency checks;
- builds the linux/amd64 and linux/arm64 image and pushes it to
  `ghcr.io/code19m/oneloop` with SBOM and provenance attestations. If the
  version's image tag already exists with other images, it stops before it
  changes any tag;
- creates a GitHub Release with the changelog notes and no binary files;
- runs the Docs workflow, which publishes the documentation. Docs pushed to
  `main` go live only when the version in `Cargo.toml` is released, so the site
  never names a version that people can't install yet.

A release candidate gets only the `X.Y.Z-rc.N` image tag. A final release gets
the `X.Y.Z` tag. `X.Y` and `latest` only move forward: they move to the release
unless they already name a newer version. For example, 0.1.1 released after
0.2.0 moves `0.1` but leaves `latest` at 0.2.0. GitHub's Latest release follows
`latest`. oneloop is not published to crates.io; people who don't use Docker
install a tag from source with `cargo install --git`.

Afterwards, check the image and the GitHub Release. Publishing is not atomic:
if one step fails, look at what already went out before you retry. Retry with
**Re-run failed jobs**, which reuses the images that were built. Tags must never
move, so fix forward with a new version when needed.

### Dependencies

Dependabot proposes monthly updates for Cargo, npm and GitHub Actions, and
security updates as soon as they are published. The Dependencies workflow runs
`cargo deny` (advisories, licenses, sources and bans), `npm audit` and a check
of the vendored browser files on pull requests, on pushes to `main` and weekly.
Browser libraries under `frontend/vendor/` are copied from exact npm releases
rather than installed; [frontend/vendor/README.md](frontend/vendor/README.md)
explains how to update one. After any dependency change, regenerate the notices.
