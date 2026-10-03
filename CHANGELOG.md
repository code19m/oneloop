# Changelog

All notable changes to oneloop are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and oneloop uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The documentation has fewer, shorter pages. Links to the old pages redirect
  to the new ones.

### Fixed

- A sidebar click is no longer lost when the page redraws at the same moment,
  for example while a task from another project is loading.

## [0.1.0-rc.1] - 2026-09-28

The first public release candidate. It's ready for small teams to try; please
report what you find.

### Highlights

- **Roadmap**: plan tracks, epics and milestones on a timeline. Epics can be
  ongoing, start by themselves when work begins, and close when you say so.
- **Board**: move tasks through Planning, In Progress, In Review and Done by
  drag and drop or from the keyboard, filter by track, epic, assignee or
  blocked state, and keep loose ideas in a private or shared Pool.
- **Task pages**: assignees, deadlines, blocking with a reason, comments with
  replies, mentions and `@everyone`, and a history of every change.
- **Attachments**: up to 25 files of any type per task, with previews for
  images, PDF, Markdown (with math and Mermaid diagrams), text and sandboxed
  HTML. Temporary files make room automatically when storage runs low.
- **Inbox**: a private list of mentions, replies, assignments and unblocked
  tasks across all your projects.
- **Live updates**: changes appear for everyone without a refresh.
- **Accounts and access**: admins create accounts and choose, per project, who
  can change the Roadmap or the Board. Everyone can see and end their sessions.
- **AI assistants**: a built-in MCP server lets Claude Code, Codex and other
  MCP clients work in the projects and with the capabilities you pick, never
  with more rights than you have.
- **Simple to run**: one binary with SQLite and the web app built in,
  configured with environment variables. `oneloop db migrate` backs up before
  every upgrade, and `oneloop backup` creates and restores complete backups.
- Light and dark themes.

### Distribution

- Docker: `ghcr.io/code19m/oneloop:0.1.0-rc.1`, for linux/amd64 and
  linux/arm64
- From source:
  `cargo install --git https://github.com/code19m/oneloop --tag v0.1.0-rc.1 --locked`.
  oneloop is not published to crates.io.
- A database created by a build from before this release upgrades with
  `oneloop db migrate --backup-dir <directory>`.

### Known limitations

- The interface is in English only.
- oneloop runs as one server with SQLite on a local disk. There is no
  clustering, and network filesystems such as NFS and SMB aren't supported.
- oneloop sends no email. Notifications stay in the Inbox, and an admin resets
  forgotten passwords.
- There is no single sign-on or two-factor authentication.
- There are no custom statuses, workflow automation, sprints or time tracking.
- Linux and macOS hosts only; Windows isn't supported.
- The bundled timezone database is IANA 2025b. Regions whose rules changed
  since may need a fixed offset until an update.
- Browser testing covers current Chromium, Firefox and WebKit. Phones and
  tablets have had less testing than desktop browsers.

[Unreleased]: https://github.com/code19m/oneloop/compare/v0.1.0-rc.1...HEAD
[0.1.0-rc.1]: https://github.com/code19m/oneloop/releases/tag/v0.1.0-rc.1
