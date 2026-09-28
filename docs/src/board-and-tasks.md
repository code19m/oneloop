# Board and tasks

This page shows you how to move work across the Board, find tasks, capture ideas in the Pool, and use a task's page for details, blocking and files.

![The Board with four columns, Planning, In Progress, In Review and Done, and a filter bar above them](assets/screenshots/board.png)

## Statuses

| Status | Meaning |
| --- | --- |
| Planning | Defined, but not started. New tasks start here. |
| In Progress | Someone is working on it. |
| In Review | Ready for someone to check. |
| Done | The team considers it complete. |

A task can move to any status at any time, for example back to In Progress
after review. [Blocking](#blocking) is separate from the status.

Changing tasks needs the **Board** permission in the project, or being an admin.
Without it the Board is **read only**, but you can still comment.

## Create a task

1. On the Board, choose **+ Task**.
2. Enter a **Title** and choose an **Epic**. **Assignees**, **Deadline** and
   **Description** are optional.
3. Choose **Create task**. It appears in Planning with an ID such as `APP-042`.

Only epics that aren't Done are offered. If there are none, create or reopen
one on the [Roadmap](roadmap.md).

## Move tasks

- Drag a card to another column to change its status, or up and down to
  reorder it. On a touch screen, drag it by its **⋯** button.
- Or use the card's **⋯** menu, which works well from the keyboard: **Move to …**,
  **Move up** or **Move down**.
- Or change **Status** on the task page.

The menu and the status picker put the task at the bottom of its new column.
Columns load 50 tasks at a time; choose **Load more** for the rest.

## Find tasks

| Filter | Shows |
| --- | --- |
| **Search tasks** | Tasks whose ID or title contains your text |
| **All tracks** | Tasks in epics on the chosen tracks |
| **All epics** | Tasks in the chosen epics |
| **All assignees** | Tasks for the chosen people. **My tasks** is you; **No assignee** finds unassigned work. |
| **Blocked** | Blocked tasks that aren't Done |

Choices inside one filter widen the results; different filters narrow them.
If nothing matches, choose **Clear filters**.

## The Pool

Choose **Pool** on the Board to keep ideas that aren't tasks yet: a title and
an optional description, with no status or dates.

- **My** is private. Nobody else sees it, admins included.
- **Team** is shared with the project. Changing it needs the Board permission.

Type a title and press Enter to add it. When an idea is ready, click it to
open a filled-in task form (this needs the Board permission). The item leaves
the Pool once the task is created.

## The task page

![A task page with an attachment, its activity and comments, and a Properties panel on the right](assets/screenshots/task.png)

Click a card to open its page. **Properties** holds **Status**, **Epic**,
**Assignees**, **Deadline** and **Created at**. Changes save as you make them;
text saves when you leave the field.

- **Epic:** any epic that isn't Done.
- **Assignees:** any number of project members. Newly assigned people get an
  [Inbox](comments-and-inbox.md) notification.
- **Deadline:** a date without a time. A task that isn't Done turns red and
  shows **Overdue** once that day has ended in your team's timezone.
- **Activity:** comments and changes in one timeline, oldest first. Changes
  one person makes to the same field within five minutes show as one entry,
  and a change undone within those five minutes disappears.

If someone else saves the same field while you're editing it, oneloop keeps
your text and shows theirs next to it. Choose **Use latest** or **Keep my
changes**.

To delete a task, open the **⋯** menu in the top bar and choose **Delete task**.

## Blocking

1. On the task page, choose **Block task**.
2. Write the **Reason**, up to 500 characters. Type `@` to mention people who
   should know.
3. Choose **Save**.

The card gets a **Blocked** badge that shows the reason on hover. The task page
offers **Edit reason** and **Unblock task**, with an optional **Resolution**.

- Done tasks can't be blocked.
- A block stays while the task moves between Planning, In Progress and In Review.
- Moving a blocked task to Done asks you to **Unblock and complete** it.
- Only people mentioned in the reason are notified. Unblocking notifies the
  assignees.

## Attachments and previews

Drop files on **Drag & drop or browse files**, or click it. Any file type is
fine, up to 25 MB each and 25 files per task. Everyone in the project can
preview and download; uploading, deleting and reordering need the Board
permission. Comments can't hold files.

Turn on **Temporary** for a file that oneloop may remove when storage runs low
([how cleanup works](configuration.md#attachment-storage)). A removed file stays
listed as **Cleaned up**. Other files are never removed automatically.

Click a file's name or thumbnail to preview it:

| File | Preview |
| --- | --- |
| Images (PNG, JPEG, WebP, GIF, AVIF) | Zoom and fit |
| PDF | Pages and zoom |
| Markdown | GitHub-style, with tables, task lists, math and Mermaid diagrams |
| HTML, up to 1 MiB | A live page; **Reload preview** restarts it |
| Text and code | The first 200 KB |
| Anything else | **Download** only |

Use the arrows to step through a task's files, and hold Ctrl or Cmd while
scrolling to zoom. HTML previews run their scripts in a
[sealed frame](security.md#uploaded-files) that can't reach oneloop or your
account.
