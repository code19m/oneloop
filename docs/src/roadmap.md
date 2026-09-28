# Roadmap

This page shows you how to plan a project on the Roadmap with tracks, epics and milestones, and how an epic moves from Planning to Done.

![The Roadmap: tracks stacked on the left, epics as bars on a timeline, milestones as vertical lines and a marker for today](assets/screenshots/roadmap.png)

The Roadmap is the first thing you see after signing in. Time runs from left to
right, and each track has its own row. Day-to-day work on tasks happens on the
[Board](board-and-tasks.md).

## How a project is organized

| Item | What it is | Example |
| --- | --- | --- |
| Project | Everything your team plans together. Switch with the project selector at the top of the sidebar. | Customer portal |
| Track | A long-running stream of work. | Backend & API |
| Epic | Work on one track, with a start date and an optional end date. Every task belongs to one epic. | Payment integration |
| Milestone | A dated goal across all tracks. | Public launch |

An epic with no end date is **ongoing**. Use one for recurring work, such as
"Small fixes". Its bar fades out to the right and doesn't imply a deadline.

## Find your way around

- The Roadmap opens on today, and **Today** brings you back.
- Scroll to move through time. To zoom, hold Cmd (macOS) or Ctrl (Windows and
  Linux) while scrolling, or pinch on a touch screen.
- Hover over an epic or a milestone to see its dates and details. Click an epic
  to open its panel with progress, description, tasks and activity.
- Epics that overlap on one track get separate rows, so nothing is hidden.

## Plan the work

You need the **Roadmap** permission in the project, or to be an admin. Everyone
else sees the Roadmap as **read only**.

1. Choose **+ Track** above the track names, enter a name and choose **Create track**.
2. Choose **+ Epic** in the top bar. Enter a **Title**, choose a **Track** and
   a **Start** date, and optionally an **End** date and a **Description**.
   Choose **Create epic**.
3. Choose **Milestone** in the top bar. Enter a **Name**, a **Date** and
   optionally a **Goal**. Choose **Create milestone**.

To change things later:

- Reorder tracks by dragging the grip beside a track's name, or focus the grip
  and use the arrow keys. The track's **⋯** menu can also move, rename or delete it.
- Open an epic and choose **Edit epic**. Its dates decide where the bar sits.
- Click a milestone to edit or delete it.

You can only delete a track with no epics and an epic with no tasks. Move them
elsewhere first.

## How an epic starts and closes

| State | Meaning | How it gets there |
| --- | --- | --- |
| Planning | Nothing has started. | Every new epic starts here. |
| In progress | Work is underway. | Automatically, when one of its tasks first moves to In Progress or In Review. |
| Done | The team has closed it. | Someone chooses **Mark as done** in the epic panel. |

- oneloop never closes an epic for you. Finishing every task leaves it In progress
  until someone marks it as done.
- If tasks are still open, oneloop asks you to confirm. Those tasks stay where
  they are.
- A Done epic can't receive new tasks. Its existing tasks can still be edited
  and moved, and that never reopens the epic.
- **Reopen** returns an epic to In progress if any of its tasks are In Progress
  or In Review, and to Planning otherwise.

## Progress

An epic with an end date shows its done tasks against the total, such as
"7 of 12 tasks complete · 58%". An ongoing epic shows tasks closed this week,
closed since it started, and still open. Weeks start on Monday in your team's
timezone.

## Projects

Admins create projects with **New project** in the project selector. A project
needs a name and a task prefix of 2 to 4 letters or digits. Task IDs
use the prefix, such as `APP-042`. If the prefix changes later, only new tasks
use it. See [Users and permissions](users-and-permissions.md) for members and
permissions.

To delete a project, an admin opens **Settings**, chooses **Delete project** and
types the project's name to confirm. This permanently removes all of its work
and files, and can't be undone. The last remaining project can't be deleted.
