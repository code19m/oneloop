<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/brand/horizontal-white.svg">
    <img src="docs/src/assets/brand/horizontal-ink.svg" alt="oneloop" width="220">
  </picture>
</p>

<p align="center">Lightweight, self-hosted task management for small teams, in a single binary.</p>

<p align="center">
  <a href="https://github.com/code19m/oneloop/actions/workflows/ci.yml"><img src="https://github.com/code19m/oneloop/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/code19m/oneloop/releases"><img src="https://img.shields.io/github/v/release/code19m/oneloop?include_prereleases" alt="Latest release"></a>
  <a href="https://code19m.github.io/oneloop/"><img src="https://img.shields.io/badge/docs-code19m.github.io-blue" alt="Documentation"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

![The oneloop Board, with task cards in the Planning, In Progress, In Review and Done columns](docs/src/assets/screenshots/board.png)

oneloop is a lightweight task manager for small teams. You host it yourself.
It is a single program with a built-in database, so it runs well on a small
server or in one container.

## Features

- **Roadmap**: plan tracks, epics and milestones on a timeline.
- **Board**: move tasks through Planning, In Progress, In Review and Done. Keep
  loose ideas in the Pool.
- **Tasks**: assignees, deadlines, blocking, comments, mentions, and files with
  previews.
- **Inbox**: one private list of mentions, replies, assignments and unblocked
  tasks.
- **Knowledge**: read your team's guides, rules and decisions from a folder of
  any Git repository, with previews and one search over names and text.
- **Live updates**: everyone sees changes without reloading the page.
- **AI assistants**: connect Claude Code, Codex or another MCP client, with the
  access you choose.
- **Easy to run**: one binary, SQLite storage and backups with one command.

## Quick start

With Docker Compose:

```sh
mkdir oneloop && cd oneloop
curl -fsSLO https://raw.githubusercontent.com/code19m/oneloop/v0.1.0-rc.2/deploy/compose.yaml
docker compose run --rm oneloop db migrate
docker compose run --rm oneloop user add admin --admin
docker compose up -d
```

Then open <http://localhost:8080> and sign in. The
[install guide](https://code19m.github.io/oneloop/install.html) explains each
step and how to build from source. Before your team uses oneloop, set up HTTPS
with the [production guide](https://code19m.github.io/oneloop/production.html).

The [documentation](https://code19m.github.io/oneloop/) covers everything else:
the user and admin guides, AI assistants, backups and upgrades, and the
reference.

## Status

oneloop is at its first release candidate. Small teams can use it, but expect
some bugs, and read the [changelog](CHANGELOG.md) before you upgrade. It runs on
Linux and macOS, directly or in Docker. Windows is not supported.

## Contributing

Bug reports and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md).
Please report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT. Third-party components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The oneloop name and logo
identify this project; please don't use them to suggest that a fork or service
is the official project or endorsed by it.
