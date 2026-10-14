# Releasing

This guide is for maintainers. To contribute a change, read
[CONTRIBUTING.md](CONTRIBUTING.md).

Tags are `vX.Y.Z` for releases and `vX.Y.Z-rc.N` for release candidates, for
example `v0.1.0-rc.1`.

1. Set the version in `Cargo.toml` and run `cargo check` to update
   `Cargo.lock`. Then `node --test scripts/tests/pinned-versions.test.mjs`
   lists each place in `README.md`, `deploy/compose.yaml` and `docs/src/`
   that still shows the old version. If `CURRENT_SCHEMA_VERSION` changed
   since the previous release, also update the schema numbers in the docs:
   the sample output of `db migrate` and `/healthz`, and the name of the
   pre-upgrade backup;
   `rg 'migrated from|schema [0-9]|schemaVersion|pre-migration-v' docs/src`
   finds them. For the first stable release, also rewrite the **Status**
   section of `README.md`, which still calls oneloop a release candidate.
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
- checks the attestations before it tags the version. Each image's SBOM must
  list the Rust crates, which cargo-auditable records in the binary, besides
  the Debian packages. The browser libraries aren't in it;
  `THIRD_PARTY_NOTICES.md` lists them with their versions, and the
  Dependencies workflow audits them;
- creates a GitHub Release with the changelog notes and no binary files;
- runs the Docs workflow, which publishes the documentation site from the tag
  of the newest stable release, or of the newest release candidate while there
  is no stable release. So the site describes the version that production
  should run, and people can always install it. Docs changes on `main` appear
  on the site with the next such release. To publish the site again, run the
  Docs workflow on `main` by hand.

A release candidate gets only the `X.Y.Z-rc.N` image tag. A final release gets
the `X.Y.Z` tag. `X.Y` and `latest` only move forward: they move to the release
unless they already name a newer version. For example, 0.1.1 released after
0.2.0 moves `0.1` but leaves `latest` at 0.2.0. GitHub's Latest release follows
`latest`. oneloop is not published to crates.io; people who don't use Docker
install a tag from source with `cargo install --git`.

Afterwards, check the image and the GitHub Release. Publishing is not atomic:
if one step fails, look at what already went out before you retry. Retry with
**Re-run failed jobs** within a day of the build, while the run still has the
image digests; it reuses the images that were built. Tags must never move, so
fix forward with a new version when needed.

## Dependencies

Dependabot proposes monthly updates for Cargo, npm and GitHub Actions, and
security updates as soon as they are published. The Dependencies workflow runs
`cargo deny` (advisories, licenses, sources and bans), `npm audit` and a check
of the vendored browser files on pull requests, on pushes to `main` and weekly.
Browser libraries under `frontend/vendor/` are copied from exact npm releases
rather than installed; [frontend/vendor/README.md](frontend/vendor/README.md)
explains how to update one. After any dependency change, regenerate the notices.

To move to a newer Rust, change `rust-toolchain.toml`. The
`pinned-versions` test in `scripts/tests/` lists the other places to change.
