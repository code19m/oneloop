## What and why

Describe the problem and the new behavior. Link the issue this closes, if any.

## Checks

Tick the checks you ran:

- [ ] `cargo fmt --check`
- [ ] `cargo clippy --locked --all-targets -- -D warnings`
- [ ] `cargo test --locked --all-targets`
- [ ] `npm --prefix frontend run typecheck`, `npm --prefix frontend run lint` and `npm --prefix frontend test`
- [ ] `npm --prefix e2e run test:smoke`
- [ ] Documentation and the `Unreleased` section of `CHANGELOG.md` updated, if users would notice the change
