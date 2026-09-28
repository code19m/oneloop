<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/brand/horizontal-white.svg">
    <img src="docs/src/assets/brand/horizontal-ink.svg" alt="oneloop" width="220">
  </picture>
</p>

<p align="center">Lightweight, self-hosted task management for small teams, in a single binary.</p>

<p align="center">
  <a href="https://github.com/code19m/oneloop/actions/workflows/ci.yml"><img src="https://github.com/code19m/oneloop/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://crates.io/crates/oneloop"><img src="https://img.shields.io/crates/v/oneloop" alt="crates.io"></a>
  <a href="https://code19m.github.io/oneloop/"><img src="https://img.shields.io/badge/docs-code19m.github.io-blue" alt="Documentation"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

![The oneloop Board, with task cards in the Planning, In Progress, In Review and Done columns](docs/src/assets/screenshots/board.png)

oneloop gives a small team one calm place to plan and track work: a Roadmap for
the big picture, a Board for day-to-day tasks, and task pages that keep the
discussion, files and history together. It runs as one binary with SQLite, so
hosting it is as simple as running a single container.

## Features

- **Roadmap**: tracks, epics and milestones on a timeline.
- **Board**: Planning, In Progress, In Review and Done, with drag and drop, filters and a Pool for loose ideas.
- **Task pages**: assignees, deadlines, blocking, comments with replies and mentions, and attachments with safe previews for images, PDF, Markdown, diagrams and HTML.
- **Inbox**: mentions, replies, assignments and unblocked tasks that concern you.
- **Live updates**: changes appear for everyone without a refresh.
- **AI assistants**: connect Claude Code, Codex or any MCP client, with access you choose per project.
- **Simple to run**: one binary, SQLite, built-in backup and restore, light and dark themes.

## Install

With Docker:

```sh
docker run --rm -v oneloop-data:/data ghcr.io/code19m/oneloop:0.1.0-rc.1 db migrate
docker run --rm -it -v oneloop-data:/data ghcr.io/code19m/oneloop:0.1.0-rc.1 user add admin --admin
docker run -d --name oneloop --restart unless-stopped -v oneloop-data:/data -p 127.0.0.1:8080:8080 \
  -e ONELOOP_PUBLIC_URL=http://localhost:8080 ghcr.io/code19m/oneloop:0.1.0-rc.1
```

Then open <http://localhost:8080> and sign in.

With Cargo:

```sh
cargo install oneloop --locked --version 0.1.0-rc.1
```

The [quick start](https://code19m.github.io/oneloop/quick-start.html) walks you
through Docker Compose step by step, and
[Install with Cargo](https://code19m.github.io/oneloop/install-cargo.html)
covers the binary. For anything beyond trying oneloop on your own computer, put
it behind HTTPS; see
[HTTPS and reverse proxy](https://code19m.github.io/oneloop/reverse-proxy.html).

## Documentation

Everything else is in the [documentation](https://code19m.github.io/oneloop/):
using the Roadmap and Board, configuration, users and permissions, backups and
upgrades, and connecting AI assistants.

## Status

oneloop is at its first release candidate. It's ready for small teams to try.
Expect rough edges, and read the [changelog](CHANGELOG.md) before you upgrade.
It runs on Linux and macOS, natively or in Docker. Windows is not supported.

## Contributing

Bug reports and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md).
Please report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT. Third-party components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The oneloop name and logo
identify this project; please don't use them to suggest that a fork or service
is the official project or endorsed by it.
