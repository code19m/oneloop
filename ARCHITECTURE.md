# Architecture

This document describes how oneloop is put together. Read it to find where a
change belongs and which rules the code must keep. It names modules and types
rather than linking to lines; use symbol search to jump to them.

## Bird's-eye view

oneloop is one Rust binary. `oneloop serve` starts an HTTP server (axum on
tokio) that provides:

- the web client: plain JavaScript, HTML and CSS embedded in the binary and
  served as-is, with no bundler;
- a private JSON API under `/api` for that client, which may change in any
  release (MCP is the supported integration surface);
- live updates as Server-Sent Events at `/api/events`;
- an MCP server at `/mcp`, with its own OAuth authorization server under
  `/oauth`.

Everything the instance knows lives in one data directory: the SQLite database
`oneloop.sqlite3` in WAL mode, file bytes under `files/`, keys under `keys/`,
and working directories for uploads, previews and Git syncs. The other commands
(`db migrate`, `user`, `backup`) open that directory directly, with no server
involved.

A browser action and an MCP tool call take the same path:

```text
browser ── /api ──▶ http::*      ─┐
                                  ├─▶ services ──▶ Db (SQLite)
AI client ─ /mcp ──▶ mcp::tools  ─┘            └─▶ FileStore (data directory)
```

The services are `DomainService`, `CollaborationService`, `FileService`,
`KnowledgeService` and `AuthService`. Every write is one SQLite transaction
that checks access, validates input, compares the expected revision, records
the idempotency receipt, changes the data, appends audit activity and adds a
message to the outbox. After it commits, `CollaborationRuntime` delivers the
outbox: it creates Inbox notifications and sends small hints over SSE, and
clients then fetch what changed.

## Codemap

### `src/`

- `main.rs`, `cli/`: the `Cli` definition (clap) and one handler per command.
  `serve` wires everything together and owns graceful shutdown.
- `lib.rs`: `application()` builds the router: `/healthz`, account routes, work
  routes, MCP routes and the asset fallback, wrapped in host checks, security
  headers and a request span.
- `state.rs`: `AppState` holds the `Config`, the `Db` and one instance of each
  service. It is built once and cloned into handlers, tools and workers.
- `config.rs`: `Config` (everything `serve` needs) and `DataConfig` (only the
  data directory, for maintenance commands), read from `ONELOOP_*` variables.
- `db/`: `Db` runs SQLite on a fixed pool of blocking workers behind a single
  writer permit. `DataLayout` knows the paths and lock files of a data
  directory. `migration` applies migrations; `backup` creates and restores
  backups.
- `access.rs`: the one project access policy. It combines account status,
  admin role, membership, the **Board** and **Roadmap** permissions, and an MCP
  grant's projects and scopes. It also validates mentions.
- `auth/`: `AuthService` for accounts, Argon2id password hashes, browser
  sessions, sign-in throttling and connected-app grants. `Actor` is the caller
  of any request, from either a browser session or an MCP grant.
- `domain/`: projects, members, tracks, epics, milestones, tasks, blocking and
  the Pool. `DomainService::execute` is the single write entry point; it takes
  a `CommandEnvelope` whose `DomainOperation` names the change. `reads` builds
  Board, Roadmap, task and Pool views with cursor paging.
- `collaboration/`: comments, the consolidated activity feed, notifications
  and the Inbox. `CollaborationRuntime` runs the outbox worker and the SSE fan
  out.
- `files/`: `FileService` handles attachments and avatars: upload admission,
  capacity and cleanup, previews, read leases and crash recovery. `FileStore`
  owns the bytes on disk.
- `knowledge/`: `KnowledgeService` shows one folder of a Git repository per
  project, read-only. Its commands manage the source, and each connect or
  change starts a new source generation; results from an older one are
  dropped. A background worker in `sync` checks each branch every minute and
  stores the folder's files in SQLite; a change or disconnect stops the
  project's running sync. `git` runs the `git` program with a private home and
  configuration, only over HTTPS and SSH, without prompts or hooks, within time
  and size limits, and in its own process group, so a stop also ends Git's
  helpers. `search` and `markdown` index Markdown sections for search and MCP,
  and `secrets` encrypts access tokens and deploy keys.
- `http/`: thin axum adapters. `commands` is `POST /api/commands`, the one
  endpoint for every browser write. `domain`, `collaboration`, `files`,
  `knowledge` and `auth` serve reads and file transfers. `security` checks host
  and origin, resolves client addresses through trusted proxies and sets
  headers. `assets` serves the embedded client. `server` bounds connections and
  shutdown.
- `mcp/`: `OneloopMcp` in `tools` defines the tools, `oauth` implements
  registration, the Connect page and tokens, and `mod.rs` wires the transport
  and file transfer endpoints.
- `idempotency.rs`: one retry ledger shared by browser and MCP writes.
- `text.rs`: validation for display text such as titles and comments.
- `runtime.rs`, `retention.rs`: background maintenance, pruning of expired
  transient rows and worker supervision.
- `error.rs`: `AppError`. `clock.rs`: `unix_now`. `timezone.rs`: the instance
  timezone, with rules from the server's zoneinfo when it is at least as new as
  the IANA database built into oneloop.

### `frontend/`

The web client, served file-for-file from the binary. The entry point is
`index.html`, then `src/app/main.js` and `boot.js`. New code goes in `src/` as
ES modules with JSDoc types, checked by TypeScript's `checkJs`. `views/` holds
the older renderer. [frontend/README.md](frontend/README.md) explains how it
loads and where code goes.

### `migrations/`

Numbered SQL files, applied in order by `oneloop db migrate` and listed in
`MIGRATIONS` in `src/db/migration.rs`. `0001_initial.sql` is the baseline for
the first public release. `schema_migrations` records each applied version with
a checksum, and a changed migration is refused.

To change the schema, add the next numbered file and its `MIGRATIONS` entry.
A migration may also run a Rust hook in the same transaction; give it a
`hook_revision`, which the checksum covers. A migration that rebuilds a table
other tables reference sets `foreign_keys_off`, so the runner turns foreign
keys off outside the transaction and checks them all before it commits.

`src/db/legacy/` is a frozen copy of the chain that databases created before
0.1.0 went through. `db migrate` recognizes those databases by their exact
versions, names and checksums, applies the remaining old steps and re-stamps
them as the baseline in one transaction. Nothing else uses it; never edit it.

### `tests/` and `e2e/`

`tests/integration/` is one Rust integration test crate (`main.rs`), with a
module per area and shared helpers in `support/`. It starts the real
application against a temporary data directory and drives it over HTTP, MCP
and the CLI. Unit tests sit next to the code, in `#[cfg(test)]` modules or
sibling `tests.rs` files. `e2e/journeys/` holds Playwright journeys that run
the built binary in Chromium, Firefox and WebKit. Frontend unit tests live in
`frontend/tests/`.

### Elsewhere

`docs/` is the documentation site (mdBook). `deploy/` has example Compose,
service-manager and reverse proxy configurations. `scripts/` holds the Node
scripts that CI and releases run. `benches/` has a workload benchmark against a
disposable database.

## Invariants

These rules hold everywhere. A change that breaks one needs a very good reason
and an update here.

- **The server never creates or migrates the database.** `serve` refuses a
  schema that is older or newer than it supports. Only `db migrate` changes the
  schema, and it writes a verified backup first. Migrations run forward only;
  a released migration is never edited.
- **Every access check happens in the service layer**, which browser and MCP
  share. HTTP handlers and MCP tools only translate input and output; they
  don't decide who may do what. Checks read current data on every request, so
  a removed member or revoked grant loses access at once.
- **An MCP grant only narrows access.** What a tool call may do is the
  intersection of the person's current permissions, the grant's projects and
  its scopes. `DomainOperation::mcp_tool` classifies every operation
  exhaustively, so a new operation stays out of MCP until someone decides where
  it belongs. Administration never goes through MCP.
- **Private data stays private, even from admins.** My Pool items and Inbox
  items are visible only to the person they belong to.
- **Uploaded and synced HTML is never same-origin.** Previews of attachments
  and Knowledge files are served with a `Content-Security-Policy` whose
  `sandbox` allows neither scripts nor the same origin and that loads nothing
  from other sites, so a preview can't read cookies, call the API or tell
  another site it was opened. Downloads are `application/octet-stream` with
  `nosniff`.
- **The app page runs and styles only its own code.** Its
  `Content-Security-Policy` allows scripts and style elements from the app
  only, and Trusted Types let HTML reach the page only through the app's
  `oneloop` policy and DOMPurify. Mermaid lays out diagrams in a separate
  document, `views/diagram-renderer.html`, the one app page that allows
  inline style elements.
- **A write and its record commit together.** Data, audit activity and outbox
  messages share one transaction. Nothing reaches clients that was not
  committed.
- **The audit trail is append-only.** Activity and security events are only
  ever inserted. Deleting a project detaches its events but keeps them. When a
  stored value is renamed, readers map the old value; history is not rewritten.
- **Every write is safe to retry and never overwrites blindly.** Writes carry
  an idempotency key, and edits carry the revision they were based on.
- **Secrets are stored only as hashes.** Passwords use Argon2id; session
  tokens, app tokens and transfer tickets are stored as SHA-256 hashes. No
  secret appears in logs or audit payloads. The one exception is a credential
  oneloop itself presents to another server: a Knowledge access token or deploy
  key can't be hashed, so it is encrypted with the instance key in
  `keys/knowledge.key`, bound to its project, sent only to the host it was
  entered for, and never returned by any API.
- **User input never becomes a path.** Stored files use generated keys, and
  original file names are metadata only.
- **One server per data directory.** A lock file enforces it; maintenance
  commands coordinate through their own locks.

## Cross-cutting concerns

**Errors.** Code returns `AppError`. Its `code()` is a stable string that
clients match on. HTTP responses carry
`{"error": {"code", "message", "details", "reference"}}`. Server faults are
logged with a reference ID and shown to clients only as a safe message with
that reference. MCP tools return the same codes as error results. The CLI exits
with `2` for configuration and validation errors and `1` otherwise.

**Logging.** `tracing` writes to standard error at `ONELOOP_LOG_LEVEL`. Each
request runs in a span with a generated ID, returned as `x-request-id`. Logs
never contain passwords, tokens or request bodies.

**Time.** Timestamps are Unix seconds (`i64`) from `clock::unix_now`. Calendar
dates such as deadlines are `YYYY-MM-DD` strings in the instance time zone,
`ONELOOP_TIMEZONE`, which also defines "today" and "this week".

**IDs.** Records have UUIDv7 string IDs, created by the server. Tasks also get
a readable key such as `WEB-042` from the project prefix and a per-project
counter. A prefix stays reserved even after its project is deleted.

**Load.** Work is bounded rather than queued forever: the database admits a
fixed number of waiting operations, HTTP caps connections, and an overloaded
request gets `503` with `Retry-After`. The fixed limits are listed in the
documentation under Limits.
