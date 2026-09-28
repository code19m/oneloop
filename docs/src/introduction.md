# Introduction

This page explains what oneloop is, who it's for and what it deliberately leaves out.

oneloop is a lightweight task manager for small teams that want to host their own. It gives your team one calm place to plan and track work: a Roadmap for the big picture, a Board for day-to-day tasks, and task pages that keep the discussion, files and history together.

![The Roadmap, with epics laid out on a timeline in tracks and milestones marked across them](assets/screenshots/roadmap.png)

![The Board, with task cards in the Planning, In Progress, In Review and Done columns](assets/screenshots/board.png)

![A task page with an attachment, its activity and comments, and properties such as status, epic, assignees and deadline](assets/screenshots/task.png)

## What you get

- **Roadmap**: tracks, epics and milestones on a timeline.
- **Board**: tasks move through Planning, In Progress, In Review and Done. Drag cards, filter the view, and keep loose ideas in the Pool.
- **Task pages**: assignees, deadlines, blocking, comments with replies and mentions, attachments with previews, and a full history.
- **Inbox**: mentions, replies, assignments and unblocked tasks, in one private list.
- **Live updates**: changes appear for everyone without a refresh.
- **AI assistants**: connect Claude Code, Codex or any MCP client, with access you choose per project.
- **Simple to run**: one binary with the web app built in, SQLite for storage, and backups with one command.

## Who it's for

oneloop suits a small team that wants its plan and its daily work in the same place, without a heavy process. You run it yourself, on a small server or in a single container, and your data stays with you.

## What oneloop is not

- **No automation.** There are no workflow rules, custom statuses, sprints, story points, time tracking or plugins. Every task follows the same four statuses.
- **No email.** oneloop never sends email. Notifications arrive in the Inbox. An admin creates accounts and resets forgotten passwords; nobody signs themselves up.
- **One instance, one workspace.** oneloop runs as a single process with one SQLite database on one machine. There is no clustering. Projects and memberships separate work inside the workspace.
- **English interface.** The interface is in English only. Your content can be in any language.

## Project status

oneloop is at its first release candidate, 0.1.0-rc.1. It's ready for small teams to try. Expect rough edges, and read the [changelog](changelog.md) before you upgrade.

oneloop runs on Linux (x86_64 and arm64) and on macOS with Apple silicon, natively or as a Docker image for linux/amd64 and linux/arm64. Windows is not supported. Use a current version of Chrome, Firefox or Safari.

oneloop is open source under the MIT license.

Ready? Start with the [Quick start](quick-start.md).
