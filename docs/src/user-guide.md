# User guide

## How work is organized

| Item | What it is | Example |
| --- | --- | --- |
| Project | All the work that one team plans together. Switch projects at the top of the sidebar. | Customer portal |
| Track | A long-running stream of work in a project. | Backend and API |
| Epic | A piece of work on one track, with a start date and an optional end date. | Payment integration |
| Milestone | A goal with a date, across all tracks. | Public launch |
| Task | One thing to do. Every task belongs to an epic. | Add card payments |

An epic without an end date is **ongoing**. Use ongoing epics for recurring
work, such as "Small fixes".

The address of the **Board**, the **Roadmap**, **Knowledge** and **Settings**
names the project, so a refresh, a bookmark or a link opens the same project.
An address without a project, such as an older bookmark, opens the project you
last switched to in this browser, or else your first project. A link to a
project you can't open shows **Page not found**. When you sign out, the tab's
address drops the project and the Board's filters, so the next person who signs
in there starts from their own project.

What you can change depends on your access to the project. Without the
**Roadmap** or **Board** permission, that page is **read only**, but you can
still comment. See [Permissions](admin-guide.md#permissions).

## Roadmap

![The Roadmap: tracks on the left, epics as bars on a timeline, milestones as vertical lines and a marker for today](assets/screenshots/roadmap.png)

The Roadmap shows epics and milestones on a timeline, with one row for each
track. It is the first page you see after you sign in.

- Scroll to move through time. **Weeks**, **Months** and **Quarters** set the
  scale, and so do the keys W, M and Q. A new scale keeps the epic you last
  opened, or today, in view. To zoom freely, hold Ctrl (Cmd on macOS) while you
  scroll, or pinch on a touchpad or touch screen. On a narrow screen, the scale
  buttons make room for the others; pinch or use the keys instead. **Today**
  takes you back to today.
- Hover over an epic or a milestone to see its details. Click an epic to open
  its progress, tasks and activity, or to edit it. Click a milestone to edit it.
- Add work with **+ Track**, **+ Epic** and **Milestone**. To reorder tracks,
  drag the grip next to a track's name, or use the arrow keys on it.
- You can delete a track only when it has no epics, and an epic only when it has
  no tasks.

### Epic status

| Status | Meaning |
| --- | --- |
| Planning | Not started yet. Every new epic starts here. |
| In progress | Work has started. oneloop sets this when one of the epic's tasks first moves to In Progress or In Review. |
| Done | Someone closed the epic with **Mark as done**. |

oneloop never closes an epic by itself, even when all its tasks are done. A Done
epic can't get new tasks, but its existing tasks can still change. **Reopen**
moves an epic back to In progress if some of its tasks are in progress or in
review, and to Planning otherwise.

An epic with an end date shows how many of its tasks are done. An ongoing epic
shows the tasks closed this week, closed since it started, and still open.
Weeks start on Monday.

## Board

![The Board with four columns, Planning, In Progress, In Review and Done, and filters above them](assets/screenshots/board.png)

The Board shows the project's tasks in four columns:

| Status | Meaning |
| --- | --- |
| Planning | Defined, but not started. New tasks start here. |
| In Progress | Someone is working on it. |
| In Review | Ready for someone to check. |
| Done | Complete. |

A task can move to any status at any time, for example back to In Progress after
a review.

- **+ Task** creates a task. It needs a title and an epic that isn't Done.
- Drag a card to change its status or its place in the column. On a touch
  screen, drag it by its **⋮** button. The **⋮** menu can also move it, which
  works well with a keyboard.
- A new task, also one made from a Pool idea, starts at the top of
  **Planning**. A task that changes status without a place, such as with
  **Move to** or its **Status**, goes to the top of its new column. A card you
  drag, or move with **Move up** and **Move down**, goes exactly there.
- Use the filters to find tasks by text, track, epic or assignee, or to show
  only blocked tasks. Several choices in one filter show more tasks; several
  filters together show fewer. The filters are part of the page's address, so
  a refresh keeps them and you can share a filtered Board as a link. Changing
  them adds no step to the browser's history, so **Back** leaves the Board. A
  choice the project no longer has, such as a deleted track, is dropped.
- **Newest first**, the sort button at the top of **Done**, lists the most
  recently finished tasks first. Each browser remembers this choice. While it
  is on, you can't reorder Done by hand; turn it off to see and change Done's
  own order.

### Pool

The **Pool** holds ideas that aren't tasks yet. An idea has a title and an
optional description. Your **My** Pool is private, even from admins. The
**Team** Pool is shared with the project. When an idea is ready, click it to
turn it into a task.

## Tasks

![A task page with an attachment, its activity and comments, and its properties on the right](assets/screenshots/task.png)

Click a card to open the task. Your changes save automatically. To save the
field you are typing in at once, press Ctrl+S (Cmd+S on macOS); you stay where
you are. In a dialog, such as **New task**, or while you edit a comment, Ctrl+S
does what the dialog's main button does. It never sends a new comment or reply,
and it doesn't save the page as a file, except from inside an HTML file preview.

- The **Description** shows formatted Markdown (GitHub style), such as
  headings, lists, tables and code, and keeps the line breaks you type. Click
  the text, or choose **Edit**, to change it. Leave the field, or press Esc or
  Ctrl+Enter (Cmd+Enter on macOS), to save it and see it formatted again.
  Task keys of your projects, such as `WEB-042`, link to their tasks. Boxes in
  a task list show what the text says; to tick one, edit the text.
- Links to other sites open in a new tab. Links to oneloop pages, such as a
  task, open in the same tab, in descriptions and in Markdown files alike.
- **Assignees** can be any project members. They get an Inbox notification when
  you assign them.
- **Deadline** is a date. When that day ends in your team's timezone, a task
  that isn't Done shows **Overdue**.
- **Activity** shows comments and changes in one timeline.
- If someone else changes a task field or comment while you are editing it,
  oneloop keeps your text and shows theirs next to it. Choose **Use latest** or
  **Keep my changes**.
- A title or description you change while offline stays on the page, marked
  **Not saved**, and saves when the connection returns.
- oneloop asks before you go to another page, also with the browser's **Back**
  and **Forward** buttons, while text you typed, such as a comment, isn't sent
  or saved yet. Most browsers also ask before you reload or close the tab. A
  dialog with text you typed asks before **Escape** closes it.
- To delete a task, use the **⋮** menu at the top of the page.

### Checklist

A task's **Checklist**, below its description, splits the work into steps.

- **Add an item** stays ready after Enter, so you can type the next step at
  once. A task has up to 50 steps, each one line of up to 140 characters.
- A step's text saves when you press Enter or leave it. To move a step, drag
  its handle, or focus the handle and use the arrow keys, Home and End.
- **×** removes a step at once, without Undo.
- The heading and the Board card count the done steps, such as **2/5**. The
  card's count turns green once every step is done. Steps don't move the task,
  so a task can be Done with steps open.
- People who can't change the Board see the steps, but not an empty checklist.

### Blocking

When something stops the work, choose **Block task** and write the reason.
Mention people in the reason with `@` to notify them. The card then shows a
**Blocked** badge.

- The task keeps its status while it is blocked. **Unblock task** removes the
  block and notifies the assignees.
- Done tasks can't be blocked. If you move a blocked task to Done, oneloop
  offers to unblock and complete it in one step.

### Files

Drop files on a task, or click **browse files**. Any file type is fine, within
the [file limits](reference.md#limits). Everyone in the project can open the
files. Comments can't have files.

Click a file to preview it. oneloop shows images, PDFs, Markdown (with tables,
math and Mermaid diagrams), HTML pages, text and code. You can download any
file. Diagrams show math in their labels as plain text, such as `$$x^2$$`.

HTML previews show the page without running its scripts or loading anything
from other sites, such as images, styles and fonts. Styles, images and fonts
inside the file still show. To use the page fully, download it.

Mark a file **Temporary** if oneloop may remove it when storage runs low. A
removed file then shows **Cleaned up**. oneloop never removes other files by
itself.

### Undo a deletion

After you delete a task, a file or a comment, the message that confirms it has
an **Undo** button while it is shown. Ctrl+Z (Cmd+Z on macOS) does the same
while focus is not in a text field and no dialog is open. The message stays
while the pointer or focus is on it. Undo puts the item back where it was,
with its comments and files. A task goes back to the same place in its column,
also when a new task took its place meanwhile; another item goes at the end of
its list then. People who left the project meanwhile are no longer assigned to
a restored task, unless it is done. The history keeps the deletion, the undo
and these changes.

If Undo fails because the connection dropped or the server was busy, the
message that says so offers **Undo** again until the item can no longer be
restored.

Deleted files and comment text stay on the server for the
[Undo window](reference.md#limits), so that Undo can work. Soon after that,
oneloop removes them for good, together with the files of a deleted task. A
deleted task's own text and its comments stay in the database; only its files
are removed.

## Knowledge

**Knowledge** in the sidebar opens the project's **Knowledge base**: your
team's guides, product rules and decisions, from one folder of a Git repository
that an admin connects. It is read-only and stands on its own, without links to
tasks or epics. To change a file, change it in Git; oneloop shows the change
after its next [sync](reference.md#limits).

- A folder's **README.md** appears below its list of files. **Updated** is
  estimated from the Git history oneloop fetched. If that history does not
  include a file's last change, the date can be newer than the change.
- Files that oneloop previews [on tasks](#files) open inside the page; other
  files can only be downloaded. **Full view** opens the same viewer as task
  files.
- Relative links in Markdown open the linked file or folder here, and relative
  images appear in the text.
- To copy a link to part of a document, hover over a heading and choose
  **#**.

Search with the field at the top, or press `/`. It looks at file and folder
names, and at the text of Markdown and text files, within the
[search rules and limits](reference.md#limits). Use the arrow keys and Enter to
open a result, and Esc to close the search.

When a sync fails, the page shows **Knowledge may be out of date** and keeps the
files from the last successful sync. Admins can choose **Retry sync**.

## Comments and mentions

Write a comment under the task's activity and press Enter to send it.
Shift+Enter starts a new line. Every project member can comment, even with a
read-only Board.

- **Reply** answers a comment in its thread.
- You can edit and delete your own comments. Admins can edit and delete any
  comment. You can [undo a deletion](#undo-a-deletion).
- To mention someone, type `@` and pick the person from the list. Only people
  you pick get a notification. A name you type yourself, or a mention inside
  `code` or a quote, is plain text.
- **@everyone** notifies all active members of the project except you. It has a
  [rate limit](reference.md#limits) in each project.
- When you edit a comment or block reason, only people you newly mention get a
  notification. Editing keeps mentions of people who have left the project.

## Inbox

The Inbox shows what needs your attention in all your projects. Open it with the
icon next to the oneloop logo. A dot means you have unread items. Nobody else
can see your Inbox, not even an admin.

You get a notification when:

- someone mentions you, or uses @everyone, in a comment or a block reason;
- someone replies to your comment;
- someone assigns a task to you;
- a task assigned to you is unblocked.

You never get notifications for your own actions. Status changes and new
files don't notify anyone.

Click an item to open the task at the right place; this also marks the item
read. **Archive** puts an item away. You can filter by project or show only
unread items. **Mark all as read** and **Archive all** affect every item matching
the current filters, including later pages. While a project or **Unread** filter
is on, they read **Mark filtered as read** and **Archive filtered**. There is no
bulk undo, but you can restore individual items from **Archived** and use
**Mark unread**. See
[retention limits](reference.md#limits) for how long archived items remain.

## Your account

Click your name at the bottom of the sidebar. The menu has **Profile**,
**Sign out**, and the theme: **Light**, **Dark** or **System**. **System**, the
default, follows your device's light or dark setting, and the theme you choose
applies to this browser only.

When oneloop is upgraded, open tabs show **oneloop was updated** and reload by
themselves at a safe moment: nothing you typed would be lost, nothing is open,
such as a dialog, a menu, a file preview or an **Undo** offer, and the tab is
hidden or you haven't used it for five minutes. A temporary password that is
still on screen counts as something that would be lost. **Reload now** reloads
at once. A reloaded page shows the same address, so you keep your project and
Board filters.

On your **Profile**:

- Change your avatar (PNG, JPEG or WebP) and your full name. See the
  [file limits](reference.md#limits). Your username can't change.
- Change your password. This signs out your other sessions and your connected
  apps.
- **Sessions** lists every browser where you are signed in. You can sign out
  any of them; your connected apps stay connected.
- **Connected apps** lists your AI assistants, and you can revoke them. See
  [AI assistants](mcp.md).

Sessions end by themselves after a while; see
[session length](reference.md#limits).

If your session ends while you type, sign in again in the same tab and your
text comes back. The tab keeps it only in memory, and drops it if someone else
signs in there. Tabs of one browser share a session, so when you sign out and
someone else signs in, your other open tabs show that your session ended
instead of their work.

If you forget your password, ask an admin to reset it. You get a temporary
password and choose a new one when you sign in.
