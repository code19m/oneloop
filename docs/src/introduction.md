# Introduction

oneloop is a lightweight task manager for small teams. You host it yourself.
It is a single program with a built-in database, so it runs well on a small
server or in one container.

![The Board, with task cards in the Planning, In Progress, In Review and Done columns](assets/screenshots/board.png)

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

## What oneloop doesn't do

oneloop stays small on purpose.

- **No custom workflows.** Every task has the same four statuses. There are no
  sprints, story points, time tracking, automation rules or plugins.
- **No email.** Notifications appear in the Inbox. An admin creates accounts and
  resets passwords; people can't sign up on their own.
- **One server.** oneloop runs as one process with one database. There is no
  clustering. Use projects to separate the work of different teams.
- **English interface.** Your own content can be in any language.

## Project status

The current version is 0.1.0-rc.2, a release candidate. Small teams can use it,
but expect some bugs. Read the [changelog](changelog.md) before you
upgrade.

oneloop runs on Linux (x86_64 and arm64) and on macOS with Apple silicon, either
directly or in Docker. Windows is not supported. Use a current version of
Chrome, Firefox or Safari.

oneloop is open source under the MIT license. The code, the issue tracker and
the contributor guide are on [GitHub](https://github.com/code19m/oneloop).
Please report security problems privately, as described in
[SECURITY.md](https://github.com/code19m/oneloop/blob/main/SECURITY.md).

Next: [Install](install.md) oneloop.
