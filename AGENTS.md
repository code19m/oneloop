# Notes for coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md)
first, keep each change focused, and run the checks from CONTRIBUTING that fit
it. Update the documentation and CHANGELOG as CONTRIBUTING describes.

Commit only when the maintainer or the task asks. Never add AI co-author or
tool trailers to commits or pull requests.

## The bar for every change

Build every task, however small, to this bar:

- **Clean:** one owner per job. Reuse the existing modules and patterns. No
  duplication, dead code or test-only seams. Plain names, and short comments
  that say why.
- **Fast:** no N+1 queries, extra round trips, full scans on hot paths, or
  whole-page redraws where an in-place patch exists. Check new SQL with
  `EXPLAIN QUERY PLAN`. Nothing new on the first load that only some pages
  need.
- **Reliable:** keep the invariants in ARCHITECTURE.md. Handle concurrent
  edits, other tabs, live updates, slow networks and failures.
- **Complete:** empty, loading, error and read-only states; keyboard and
  screen readers; narrow screens; light and dark; MCP where it applies; docs
  and CHANGELOG.
- **Tested:** each behavior at the cheapest level that proves it, and each
  bug fix with a regression test that fails on the old code.

Before a change merges, review it on its own against this bar and try to
break it. Fix what the review finds, small issues included; don't leave known
problems for later.
