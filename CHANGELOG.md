# Changelog

All notable changes to oneloop are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and oneloop uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Sign out** now signs out your other open tabs in the browser at once.
  They forget their project, the Board's filters and open dialogs too, so the
  next person who signs in there starts from their own project. A session that
  ends by itself still keeps each tab's address.
- Creating a project, or losing access to the one on screen, now adds one step
  to the browser's history, so **Back** returns to the page you were on.
- Choosing another project on **Page not found** or **Access denied** now opens
  that project's page of the same kind, such as its **Knowledge**, or else its
  **Board**.
- While another project's **Roadmap** loads, its header and the sidebar's
  **Board** count show no numbers instead of 0. The header's counts of tracks,
  epics and milestones now also follow changes made elsewhere.
- **Reload now** reloads the tab once. On a slow network, switching to another
  tab before the new page arrived made the tab start a second reload, and the
  new page then said **oneloop was updated**.
- Dragging selected text no longer causes an error in Firefox.
- Focus stays on a file's name, **Download**, **Delete**, **Temporary** and its
  other controls when the task's files are drawn again, such as after a move
  or a change made elsewhere. When the file is deleted, focus goes to the same
  control of the file in its place.
- Esc or Ctrl+Enter in an empty description now keeps focus on its field,
  instead of losing it to the page.
- A click on a task's description now puts the cursor where you clicked, and
  a double-click selects the word you clicked, instead of the cursor going to
  the end.
- A footnote link in a description now brings its footnote into view, and the
  footnote's back link returns to the reference. Before, it scrolled only the
  description's own box, so the footnote could stay out of view.

## [0.1.0-rc.6] - 2026-10-17

The sixth release candidate. It adds task checklists, shows descriptions as
formatted Markdown, keeps the project and the Board's filters in the address,
and puts moved and new tasks at the top of their column. It also makes the web
app faster on slow networks and fixes many bugs. Read the upgrade notes before
you upgrade; if you upgrade from 0.1.0-rc.4, read those of 0.1.0-rc.5 too.

### Upgrade notes

- Stop oneloop, install the new version, and run
  `oneloop db migrate --backup-dir <directory>`. It saves a backup first, then
  upgrades the database from schema 6, which 0.1.0-rc.4 and 0.1.0-rc.5 use,
  to schema 8. Older versions refuse a schema 8 database. To go back to one,
  restore the backup that `db migrate` made.
- If you upgrade from 0.1.0-rc.4, also follow the upgrade notes of
  0.1.0-rc.5: Knowledge folders have size limits now, and some MCP errors and
  `read_pool` cursors changed.
- Browser tabs that are open during the upgrade still run the old version.
  They show **oneloop was updated**, but reload by themselves only where
  **Reload after updates** was on, so ask people to reload them. From this
  version on, every tab reloads by itself at a safe moment, and the setting is
  gone from the account menu.
- The addresses of the **Board**, the **Roadmap**, **Knowledge** and
  **Settings** now name the project, and the Board's address holds its
  filters. Older bookmarks and links still work: they open the project you
  last switched to in that browser, or else your first project. Links to a
  task don't change.
- In MCP, `task.move` without `position`, `beforeTaskId` or `afterTaskId` now
  puts the task at the top of its new column, and new tasks, also from
  `pool.promote`, start at the top of Planning. Before, most went to the
  bottom. Pass a place to put a task anywhere else. A task's `position` in
  reads can now be below zero; use it only to order a column.
- In MCP, `read_activity` with a task that doesn't exist now fails with
  `not_found`. Before, it returned an empty page.
- AI assistants that are already connected don't need to connect again. The
  new checklist operations need **Create and manage tasks and Pool items**, and
  `task.checklist.delete` also needs delete access, as `task.delete` does.

### Added

- A task's description now shows as formatted Markdown, as people and AI
  assistants write it: headings, lists, tables, code and more. Task keys of
  your projects, such as `WEB-042`, link to their tasks. Click the text, or
  choose **Edit**, to change it; leaving the field, Esc or Ctrl+Enter
  (Cmd+Enter on macOS) saves it and shows it formatted again. An epic's
  description shows formatted too.
- Ctrl+S (Cmd+S on macOS) now saves the field you are typing in at once and
  keeps you there. In a dialog, or while you edit a comment, it does what the
  main button does. It never sends a new comment, and it no longer downloads
  the page.
- In MCP, `create_attachment_upload` can replace a file that you uploaded:
  pass its ID as `replacesAttachmentId`. When the upload completes, the new
  file takes the old one's place, and the old one is deleted as
  `delete_attachment` deletes it. This needs no destructive access, so an
  assistant can update its own documents without asking you to delete the old
  version. If the upload fails, the old file stays.
- Tasks have a **Checklist**: short steps that you add, tick, rename, move and
  remove on the task's page. A Board card shows how many steps are done, such
  as 2/5, in green once all are. In MCP, `task.create` takes the steps in
  `checklist`, `read_task` returns them, `search_tasks` and `read_epic` count
  them, and `task.checklist.add`, `task.checklist.update`,
  `task.checklist.move` and `task.checklist.delete` change them.

### Changed

- oneloop now compresses the web app's files with gzip, so a first visit
  downloads about 60% less and the app opens faster on slow networks. A
  reverse proxy no longer needs to compress them, and the nginx example no
  longer does.
- The app asks for all of its start-up scripts at once, instead of one level
  of imports at a time, so it opens faster on slow networks.
- The app reads your workspace while it checks your session, instead of
  after, so every visit opens one round trip sooner.
- When a Board tab shows again, reconnects, or hears of a change to an epic,
  track, milestone or member, it now reads the Board once instead of twice.
- A tab no longer checks your access every 30 seconds while it is hidden or
  gets live updates. Live updates already report lost access, and a hidden
  tab refreshes when it shows again.
- The web app does less work on slow computers and phones. Turning off a
  Board filter or emptying the search no longer draws the whole page again,
  so the cards move smoothly into place. A change to one card, a drop or a
  filter no longer redraws every loaded card, and dragging a card is
  smoother. Opening a task draws its page two times instead of three, and a
  change from another tab to the open task reads its comments and activity
  once instead of twice.
- A Board search, a Board filter or a project switch that takes more than a
  moment now dims the page until the result arrives. Before, a slow search
  looked as if nothing happened.
- The **Board**, its counts and, in MCP, `search_tasks` without a status no
  longer slow down on an instance with many tasks where no task was ever
  blocked. Before, counting the blocked tasks could read every task of the
  instance, which took tens of milliseconds at 100,000 tasks.
- An open connection, such as the one each browser tab keeps for live
  updates, now uses about 20 KB of server memory. Before, each one kept its
  own copy of the routes, about 300 KB, so 100 open tabs took 30 MB.
- After many writes in a short time, such as an import through MCP, the first
  write a day later no longer holds up all other writes while it removes the
  expired retry keys. Database maintenance now removes them, a batch at a
  time. Before, 50,000 expired keys held up writes for a few hundred
  milliseconds.
- Uploads, and the storage check that runs every minute, now count stored
  files and unfinished uploads but not image thumbnails, so they no longer
  slow down as an instance collects images. Thumbnails go when files and
  unfinished uploads reach 80% of the storage limit. **Clean up now** still
  counts them, as the **Storage** page does.
- oneloop now looks for files that nothing refers to, such as files that a
  crash left behind, once an hour instead of every minute.
- Image thumbnails, and files and avatars that the browser already has, no
  longer wait for other changes to finish, such as a Knowledge sync. An
  attachment's `lastAccessedAt` now changes only while the attachment is
  temporary, and the 24 hours of a temporary attachment start again when
  someone marks it temporary.
- Large Knowledge files download faster.
- The address now names the project on the **Board**, the **Roadmap**,
  **Knowledge** and **Settings**, and the Board's address also holds its
  filters and search. A refresh, a bookmark or a link opens the same project
  and filters, switching projects is a step in the browser's history, and
  **Back** leaves the Board instead of undoing filters. An address without a
  project, such as an older bookmark, opens the project you last switched to in
  this browser. Signing out clears the project and filters from the tab's
  address, so the next person to sign in there starts from their own. Before, a
  refresh opened the first project by name and lost the filters.
- Every open tab now reloads by itself after an upgrade, when nothing you typed
  would be lost, nothing such as a dialog, a menu or an **Undo** offer is open,
  and the tab is hidden or unused for five minutes. **Reload after updates** is
  gone from the account menu. The bar says that the page reloads by itself and
  offers **Reload now**, and after such a reload the page says "oneloop was
  updated".
- Markdown previews and the Knowledge base now load the math renderer, about
  80 KB, only for text with math. Before, any `$`, such as in a price or a
  shell variable, loaded it.
- A task that changes status without a place now goes to the top of its new
  column, Done too: with **Move to**, the task's **Status**, **Unblock and
  complete**, or `task.move` in MCP without `position`, `beforeTaskId` or
  `afterTaskId`. New tasks, also ones made from a Pool idea, start at the top
  of **Planning**. Before, most of these went to the bottom, where a long
  column hid them until **Load more**, and Done mixed both orders. A drag,
  **Move up** and **Move down** still put a task exactly there, and
  **Newest first** still lists Done by completion time. A task at the top
  takes a position above the first one, which leaves the other tasks where
  they are, so a task's `position` in MCP reads can be below zero. **Undo**
  puts a deleted task back at the same place in its column, also when a new
  task took its place; before, it went to the end.
- In MCP, every tool that names a task now also accepts its key, such as
  `WEB-042`: `read_comments`, `read_activity`, `discussion.comment.create`,
  `task.delete` and every other `task.*` operation, also in `beforeTaskId` and
  `afterTaskId`. Moving a blocked task to Done now fails with a message that
  names `task.unblock-and-complete`, and `set_attachment_temporary` is marked
  as safe to repeat.
- **Newest first** is now a small sort button at the top of **Done**, so
  Done's header is as tall as the others and its cards line up with theirs.
  The button shows your choice at once, and the page dims while a slow Board
  read loads the new order.

### Fixed

- In MCP, `read_activity` with a task key, or with a task that doesn't exist,
  returned an empty page. It now returns the task's activity, or fails with
  `not_found`.
- A Mermaid diagram in a Markdown preview no longer fails when its renderer
  takes more than 30 seconds to download, as on a slow mobile connection.
  When the renderer can't load, the preview now says to check the
  connection, instead of blaming the diagram's syntax.
- Long comments on a task page no longer fold to nothing and grow back when
  the page draws again, such as after a change from another tab or a saved
  field. The page also stays at the comment you were reading. Before, it
  could jump away by several comments.
- The Board now shows its loading placeholder while its cards load, when you
  open it from another page, such as the Roadmap or a task you opened from a
  link. Before, it said "No tasks yet" and offered **Create task**, or showed
  only that task, until the cards arrived.
- Closing a file preview now gives focus back to the file name that opened
  it, also when the task's attachments changed while the preview showed.
  Before, keyboard users landed at the top of the page.
- When several sign-in limits apply at once, "Try again in …" and the
  `Retry-After` header now give the longest wait. Before, they could give a
  shorter one, and the next attempt was refused again.
- After oneloop could not be reached for a while, a tab without live updates,
  such as one whose updates a newer tab took over, again checks every 30
  seconds that you still have access. Before, it stopped checking until you
  reloaded the page or signed in again, so it didn't notice when you lost
  access to a project.
- A task page no longer stays at "Loading activity…" when the task loads
  faster than its comments, as could happen when you opened it from the
  **Board**. Before, the comments and activity appeared only when something
  else drew the page again.
- Creating a task, deleting one or undoing that, and turning a Pool item into
  a task no longer empty the **Board** in a project that isn't the first by
  name. Before, the Board said "No tasks yet" until something else loaded it
  again. The new card also shows one request sooner.
- After you follow a link into another project, such as a **Knowledge** link,
  its **Board** shows the project's cards. Before, it said "No tasks yet",
  because the first project's tracks and epics stayed loaded.
- The account menu shows only the version, such as `v0.1.0-rc.6`. Before, it
  also showed the commit the build came from, which made the menu scroll
  sideways in release images. `/healthz` and `oneloop --version` still give
  the commit.
- After **Load more** on the **Board**, typing in the search and erasing it
  quickly, or turning a filter on and off before its cards arrive, keeps every
  loaded card in view. Before, each column fell back to its first 50 cards with
  no **Load more**, while its count still showed more.
- A link to a oneloop page in a Markdown preview or a Knowledge file, such as
  `[the task](#/task/WEB-042)` or the page's full address, now opens that
  page. Before, it went nowhere.
- Code blocks in the Knowledge base now have a visible background in the dark
  theme. Before, it matched the page.
- When someone else changes the open task, such as a teammate, another tab or
  an AI assistant, its status in the page header and in **Status**, its title
  and its description now show at once, also while you type in another of its
  fields. Before, they changed only after you left the task's fields.
- Opening a Markdown file with a very long run of backticks (`` ` ``) or
  tildes (`~`) no longer freezes the tab. Before, such a 200 KB file could
  freeze it for more than a minute.
- A click on a task's file, or on **browse files**, now works also while the
  task changes, such as right after you edit one of its fields. Before, the
  change drew the files again under the pointer, and the click did nothing.
- After you move a file with the arrow keys, focus now stays on it, so you
  can move it again. Before, it fell to the page once oneloop saved the new
  order.
- When you turn **Newest first** on or off in one tab, the browser's other
  **Board** tabs keep showing live changes, in the order they show, and use
  the new choice when they load again. Before, they stopped showing changes
  until they read the Board again.

### Distribution

- Docker: `ghcr.io/code19m/oneloop:0.1.0-rc.6`, for linux/amd64 and
  linux/arm64
- From source:
  `cargo install --git https://github.com/code19m/oneloop --tag v0.1.0-rc.6 --locked`

## [0.1.0-rc.5] - 2026-10-16

The fifth release candidate. It fixes many bugs in the web app, in MCP and in
the commands, limits the size of Knowledge folders, and updates rustls for a
security fix. Read the upgrade notes before you upgrade.

### Upgrade notes

- A Knowledge folder now stops syncing, and shows that it is too large, when
  it has more than 5,000 subfolders, or more than 5,000 files counting links
  and other files that the sync leaves out. A knowledge base that synced in
  0.1.0-rc.4 can reach these limits: choose a smaller folder, or remove files
  or subfolders from it. Before, such a folder could fill the disk with
  folders or left-out files, and many deep subfolders could make search use
  gigabytes of memory.
- In MCP, the command tools now answer every edit and deletion without
  `expectedRevision` with `precondition_failed`, as the documentation says.
  Before, `discussion.comment.edit` failed with `validation_failed`, and
  `execute_destructive_command` refused the call as invalid arguments.
  `discussion.comment.create` and the `inbox.*` operations now refuse an
  `expectedRevision` with `validation_failed`, as creating a task does.
  Before, they ignored it.
- In MCP, a `read_pool` `nextCursor` from an earlier version now fails with
  `validation_failed`, because Pool cursors have a new form. Start again from
  the first page.

### Changed

- `ONELOOP_TRUSTED_PROXIES` now ignores empty items, such as a trailing
  comma, like the other lists. Before, oneloop refused to start.
- An MCP download now names the file in its `Content-Disposition` header, as
  a browser download does.
- In MCP, `list_attachments` and `reorder_attachment` now accept a task key,
  such as `WEB-042`, in `taskId`, as `create_attachment_upload` does.

### Fixed

- `oneloop serve`, `oneloop backup` and the other commands no longer fail
  when nothing reads their standard error and they have a warning or notice
  to print, such as a copy left by an interrupted backup. The `serve` warning
  about an empty `ONELOOP_TRUSTED_PROXIES` is now a log line like the others.
- Times such as "5m ago" on comments, activity and the Inbox now count from
  the server's clock. Before, a computer clock that ran fast or slow made a
  new comment read "5m ago", or stay "just now" too long.
- The Inbox's counts, activity feeds, a block's history and, in MCP,
  `search_tasks` without a status now show the data of one moment. Before, a
  change that landed while they were read could show twice, not at all, or
  with counts that didn't match the items.
- When a person opens more than 16 tabs, the oldest one now always says that
  its live updates are paused, with **Resume**. Before, it could look
  connected and show no new changes until you used it, or reconnect at once
  and close another tab.
- One person's slow avatar uploads can no longer hold up avatar changes for
  everyone. Each person now has one avatar upload at a time; another one
  gets "try again" at once. When the server is busy, a refused avatar upload
  now gets that answer instead of a network error.
- After you change a task's status on its page, the status in the page header,
  the Status icon and **Block task** now change at once. Before, they changed
  only after you left the task's fields. **Overdue** also follows a changed
  deadline at once.
- Choosing **Done** in the Status of a blocked task now asks you to unblock and
  complete it, as the Board does. Before, the change failed with an error.
- Saving a changed block reason now says "Block reason updated", and unblocking
  and completing a task says "Task unblocked and completed". Before, they said
  "Task blocked" and "Task unblocked".
- A block reason with several spaces in a row before a mention keeps the
  mention. Before, the mention was dropped and the person was not notified.
- oneloop asks before you leave a task whose new deadline could not be saved
  because the connection was lost, also after you left the deadline field. A
  link to the page you are on no longer asks to discard your changes.
- When you press **Back** or **Forward** with text you haven't sent and then
  **Cancel**, the browser history stays as it was. Before, the next **Back**
  skipped a page.
- When someone else renamed a milestone while you edited its name, the
  question about the change now shows their name. Before, it showed no saved
  value.
- The **Temporary** switch in a file preview works. Before, it did nothing.
- After you add a Pool item with a description, the description field closes,
  so the next item starts with its title. Before, it stayed open and empty.
- Dropping a track back in its own place on the Roadmap no longer shows an
  error.
- On a 320-pixel-wide screen, the Roadmap header shows the whole **Epic**
  button. Before, part of it was cut off. Screen readers still read the
  Roadmap heading there.
- An epic's activity now comes in pages of up to 100 items, like all other
  activity, as the limits in the documentation say. It stopped at 50.
- With a very large `ONELOOP_STORAGE_LIMIT`, above about 200 PiB, the storage
  page for administrators shows the right cleanup points of 80% and 70%.
  Before, it showed wrong values.
- When a Knowledge folder is too large to sync, oneloop now says to remove
  files or subfolders. Before, it said to remove large files, which doesn't
  help a folder with too many files or subfolders.
- Knowledge search now says when some files are searched by name only,
  because their text doesn't fit in the search index. Before, a word in such
  a file gave "No results" without a reason. In MCP, `search_knowledge` and
  `read_knowledge_overview` replies then include `"partial": true`.
- Markdown in **Knowledge** shows at the reader's own width and spacing.
  Before, it used the wider layout of file previews.
- A Knowledge file download now always sends the file, as an attachment
  download does. Before, a download request with `If-None-Match` could get an
  empty "not modified" answer.
- The page where you connect an AI app lists projects in the same order as
  the app, without regard to upper and lower case.

### Security

- Updated rustls to 0.23.46 (RUSTSEC-2026-0349). oneloop uses it when it
  fetches the metadata document of an AI assistant that connects.

### Distribution

- Docker: `ghcr.io/code19m/oneloop:0.1.0-rc.5`, for linux/amd64 and
  linux/arm64
- From source:
  `cargo install --git https://github.com/code19m/oneloop --tag v0.1.0-rc.5 --locked`

## [0.1.0-rc.4] - 2026-10-07

The fourth release candidate. 0.1.0-rc.3 was tagged but never published,
because a browser test failed in its release checks; this release has
everything it would have had. It adds Undo for deletions, image thumbnails,
Roadmap scales, a system theme, optional password rules and more ways for AI
assistants to connect. It also fixes many bugs and security problems, so read
the upgrade notes before you upgrade.

### Upgrade notes

- Stop oneloop, install the new version, and run
  `oneloop db migrate --backup-dir <directory>`. It saves a backup first, then
  upgrades the database to schema 6. Older versions refuse a schema 6
  database. To go back to one, restore the backup that `db migrate` made.
- If you installed from source with the rc.2 steps, create the backup folder
  first, because those steps left it out:
  `sudo install -d -m 0700 -o oneloop -g oneloop /var/backups/oneloop`.
- Give the server at least 512 MB of memory. Making a thumbnail or an avatar
  can briefly use about 200 MiB more.
- oneloop now accepts only HTTP/1.1 and refuses HTTP/2 without TLS (h2c). If
  your reverse proxy reaches oneloop over h2c, switch it to HTTP/1.1.
- An unusable `ONELOOP_DATA_DIR` is now an invalid setting: `oneloop serve`
  and the other commands exit with code 2.
- systemd: add `RestartPreventExitStatus=2` to your unit, or copy the new
  example, and run `sudo systemctl daemon-reload`. Invalid settings then stop
  the service instead of restarting it every 5 seconds. The example also stops
  after 10 starts in 10 minutes.
- launchd (macOS): install the new `oneloop-launchd.sh`, which stops the job
  when a restart can't help, and add `ExitTimeOut` 35 to your plist, so that
  open requests can finish when oneloop stops. If you copy the new example
  plist instead, keep your own binary and data paths in it. Rotate the log
  with `newsyslog -r`, which works without root.
- A `..` after a symbolic link in `ONELOOP_DATA_DIR` now leads to the parent of
  the folder that the link points to, as the operating system resolves it.
  rc.2 removed the link and the `..` together.
- If a project was deleted while an AI assistant had it selected together with
  other projects, that connection still works for the other projects. Its
  owner should revoke it in **Profile** > **Connected apps**. From this
  version on, deleting a project ends such connections.
- Some Knowledge section links change. A link copied from rc.2 to a heading
  with emoji, underscores or some non-Latin scripts may no longer jump to the
  heading, and AI assistants get new section targets for repeated headings,
  such as `setup-1`.
- Browser preflight requests to `/mcp`, `/oauth/register` and `/mcp/files/*`
  from origins that aren't in `ONELOOP_MCP_ALLOWED_ORIGINS` now get 403. The
  `/mcp` origin check now compares the port too: an `Origin` header must match
  `ONELOOP_PUBLIC_URL`, or a listed origin, exactly.
- Changes made by other processes, such as `oneloop user passwd`, now reach
  open tabs within 5 seconds instead of half a second.
- Avatars that need more than about 192 MiB of memory to decode are now
  refused. Existing images get thumbnails when someone first views them.
- Don't share a backup folder between computers with the same host name.
  oneloop uses the host name to tell whether an interrupted backup or restore
  has ended before it cleans up after it.

### Added

- **Undo** after you delete a task, comment or file, in the message that
  confirms the deletion, or with Ctrl+Z (Cmd+Z on macOS) when no text field
  has focus and no dialog is open. oneloop keeps deleted files and comment
  text for 5 minutes, then removes them for good. Deletions by AI assistants
  can't be undone.
- Image thumbnails: PNG, JPEG and WebP attachments show thumbnails of at most
  256 × 256 px, so tasks with large photos load much less data. Storage
  cleanup removes thumbnails first, and oneloop makes them again when someone
  views the image. Backups don't include them.
- Roadmap scales **Weeks**, **Months** and **Quarters**, also on the keys W, M
  and Q. A new scale keeps the epic you last opened, or today, in view, and
  close zoom shows each week.
- **Newest first** in the Board's **Done** column lists the most recently
  finished tasks first. Each browser remembers the choice.
- **Reload after updates** in the account menu: when it is on, a tab reloads
  by itself after an upgrade, once nothing you typed would be lost and the tab
  is hidden or unused for a minute.
- oneloop asks before you go to another page, also with **Back** and
  **Forward**, or close a dialog while text you typed isn't sent or saved yet.
  Most browsers also ask before a reload or before closing the tab.
- If your session ends while you type, or while a comment is still being sent,
  sign in again in the same tab to keep your text and get back to the project
  you had open. Nobody else who signs in there sees the text.
- A task title or description that can't be saved, for example while you are
  offline, stays on the page marked **Not saved** and saves by itself when the
  connection returns.
- Optional password rules, all off by default: minimum lengths
  (`ONELOOP_PASSWORD_MIN_LENGTH`, `ONELOOP_ADMIN_PASSWORD_MIN_LENGTH`) and a
  list of refused passwords (`ONELOOP_PASSWORD_BLOCKLIST`), which sign-in
  never checks, so existing passwords keep working; and a lifetime for
  temporary passwords (`ONELOOP_TEMPORARY_PASSWORD_LIFETIME`), after which a
  temporary password no longer signs in.
- More AI assistants can connect, each with a setting that is off by default:
  apps that receive the sign-in through their own link scheme, such as
  `cursor://` (`ONELOOP_MCP_REDIRECT_SCHEMES`); tools that run in a web page,
  such as MCP Inspector (`ONELOOP_MCP_ALLOWED_ORIGINS`); and clients that
  identify themselves with a client ID metadata document
  (`ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS`).
- MCP task results include `completedAt` and `completionOrder` for done tasks.

### Changed

- The theme follows your device's light or dark setting until you pick one.
  The menu offers **Light**, **Dark** and **System**.
- Full times, the reason on a **Blocked** badge and cut-off names also show as
  a tooltip when you tap them, and on keyboard focus where they can take focus.
  The **Blocked** badge is easier to read in the light theme.
- Zooming the Roadmap is smooth. It no longer rebuilds the Roadmap or stretches
  text, the date under the pointer stays in place, and a touchpad pinch
  follows your fingers, also in Safari.
- Right-to-left text, such as Arabic, Hebrew or Persian, reads right to left
  in descriptions, comments, block reasons, Pool notes, Markdown attachments
  and Knowledge pages.
- In a long Board column, **Move to** puts the card at the top unless the
  column shows its last card, and the moved card stays in view.
- Only the Roadmap loads epic statistics, which makes other pages faster. It
  shows "…" until they arrive.
- Notifications are delivered in batches: a burst of 300 Inbox updates now
  arrives in about 0.1 seconds instead of 10 to 13 seconds.
- Any web page may read oneloop's OAuth metadata and use its token and
  revocation endpoints. They use no cookies, so a page needs a code or token
  that it already has.
- Deleting a file no longer waits for a backup or a download. Its space is
  freed about 5 minutes later. Until then it counts as pending deletion, like
  the files of a deleted task.
- `oneloop backup create`, `backup restore` and `db migrate --backup-dir`
  remove what an interrupted run on the same computer left behind, so you can
  simply run them again. A restore checks the backup before it removes
  anything.
- Knowledge needs less memory and time: downloads and previews are sent in
  small pieces instead of whole files, and a folder of 5,000 files syncs in
  about 6 seconds.
- Time zone rules come from the server's time zone database when it is at
  least as new as oneloop's own copy, which is now IANA 2026e instead of 2025b.
  This brings the 2026 changes for British Columbia, Alberta, Morocco,
  Manitoba and the Northwest Territories.
  `oneloop serve --check` shows which copy is in use.
- `oneloop --version` also shows the source revision. Setup and upgrade
  messages and the help are clearer, and `user add --help` and
  `user passwd --help` say that the password you set is temporary.
- The Docker image starts oneloop under `tini`, which cleans up Git helpers
  that a stopped Knowledge sync leaves behind. Its SBOM now lists oneloop's
  Rust crates, including the bundled SQLite, for image scanners.
- The documentation site describes the newest release instead of unreleased
  changes, and links to the deploy templates of that release.

### Fixed

- oneloop no longer drops SQLite's lock on the live database. Without the lock,
  an older SQLite program (before 3.51) that opened the database while oneloop
  ran could delete the file that holds the newest changes (the write-ahead
  log). Recent changes could then be missing from backups or lost after a
  crash, or the database could be damaged.
- A backup that is missing a file's bytes, or the Knowledge key while
  encrypted Knowledge credentials exist, is now refused when it is made and
  when it is restored. Before, it passed as verified.
- `oneloop backup create`, `user passwd` and `serve --check` no longer fail
  with "data lease is busy" while people keep downloading files.
- Files deleted after a backup stopped halfway are removed from disk within a
  minute, instead of staying until the next backup.
- Retries now work for an upload that failed during a backup, for deleting a
  file that storage cleanup already removed, and for changing a file's
  **Temporary** setting.
- An upload that finishes after its task was deleted gets "task not found"
  instead of a server error.
- Comments and block reasons of a deleted task can no longer be edited.
- Changing your avatar no longer shows an error when the change was saved.
- After the server clock steps back, editing a field no longer fails, and
  background cleanup of expired data keeps running. Cleanup also catches up on
  busy servers.
- After someone is removed from a project and added back, an old change to
  their membership can no longer apply to the new membership.
- Comments no longer show one version's text with another version's mentions
  while an edit is saved.
- Archived Inbox items older than 90 days can no longer be restored, and they
  no longer appear when the app loads.
- `oneloop` commands no longer crash, and keep their exit code, when the
  program that reads their output stops early, such as `grep -q`.
- A password can no longer be long enough to set but too long to sign in with.
- The history records a file deletion, with who asked and through which app,
  even when removing the file takes more than a day.
- Behind a reverse proxy named in `ONELOOP_TRUSTED_PROXIES`, requests no longer
  fail with 502 when the proxy reuses an idle connection: oneloop keeps such
  connections open for 5 minutes instead of 15 seconds.
- Current Codex versions can sign in: oneloop accepts a repeated `resource`
  parameter when every value is its MCP address, and the Codex steps in the
  docs use `~/.codex/config.toml`.
- AI assistants may write the `Bearer` scheme in any letter case.
- MCP: `create_attachment_upload` accepts a task key, such as `WEB-042`;
  finishing a sign-in for a project that was deleted meanwhile gets
  `invalid_grant`; and a broken upload body is a client error. All three were
  server errors.
- Mentions inside inline code or a quote no longer notify anyone, as the user
  guide says.
- Editing a comment or block reason that keeps a mention of someone who left
  the project works again. Editing someone else's comment no longer notifies
  an unchanged mention again.
- Editing a block reason updates the Inbox of the people it mentions, and
  adding a member updates that person's project list.
- Knowledge search results, copied section links and AI assistant section
  reads use the reader's heading anchors, also for repeated headings and in
  every script. Links to other headings in a document scroll there, and links
  to the knowledge base root work.
- A long Git history no longer fails a Knowledge sync as too large. A commit
  that doesn't change the folder no longer counts as a sync, so the reader
  keeps its place. Files with `"` in their names get their own **Updated**
  dates.
- A cancelled Knowledge sync stops all of Git's helper processes, a fast
  download keeps within the 300 MiB limit, and on a disk that ignores letter
  case, files whose names differ only in case show their own contents.
- Knowledge syncs and uploads that run at the same time share one disk-space
  reservation, so together they never go below `ONELOOP_DISK_MIN_FREE`.
- Disconnecting a knowledge base can no longer remove one that was connected
  again meanwhile, and open Knowledge pages update after a reconnect or a sync.
- A `.md` file with binary content is offered only as a download, not as a
  Markdown preview. The AI assistant overview leaves out a README that isn't
  text.
- Diagrams show math in their labels as plain text, such as `$$x^2$$`, instead
  of empty labels, and they take the new colors when the theme changes.
- Saving never replaces a newer change by someone else without asking: comment
  edits, a field after **Keep my changes** on another field, and a dialog that
  you save again now ask first.
- **Keep my changes** in **Edit epic**, **Edit milestone** and Pool promotion
  saves only the fields you changed, so a teammate's other changes stay.
- **Use latest** shows the saved values in task fields, comments and dialogs.
- Saves no longer lose what you typed: a second edit of a field during its save
  is saved too, two fields or two comment edits saved close together no longer
  conflict, and a late save or conflict no longer clears newer text or closes
  another dialog.
- On a slow connection, text typed after sending a comment, reply or Pool item
  no longer joins the one being sent or gets sent twice.
- A conflict prompt on a task title or description stays open when a live
  update redraws the page.
- Losing Board permission or project membership while you type keeps your
  text and says why.
- A temporary password stays available after you close the **New user** or
  **Reset password** dialog during the save.
- An upload, deletion or **Temporary** change that the server accepted no
  longer shows as failed during a live update, and a retried upload is no
  longer added twice.
- Live updates no longer cancel or undo what a page loaded: a task no longer
  stays on the loading screen, a project switch sticks, also from a task page,
  and **Users**, the Pool and the epic drawer keep the items they loaded.
- The Inbox no longer stops working after a project refresh, and opening an
  item whose task was deleted keeps you in the Inbox instead of showing
  **Page not found**.
- The Board shows live moves in the right card order, and search ignores
  spaces around the words.
- Open Pool rows show the latest title and description.
- An open epic drawer updates when a teammate changes one of its tasks, and it
  names statuses as the Roadmap does, such as "Ongoing · Done".
- **Load more** on the Board and in the epic drawer shows the next items after
  a change.
- Blocking and unblocking show on the task page as soon as the server accepts
  them.
- A first project replaces the empty page without a reload.
- Changing two members' permissions at once no longer fails, and
  **Add member** finds accounts beyond the first page with **Load more users**.
- Losing the admin role while on **Users**, **Storage** or **Settings** moves
  you to the **Board** with a message, instead of leaving controls that do
  nothing.
- A refused avatar says why: its type, its data or its size.
- The **Users** header shows "50+" while more accounts can load, and a pasted
  title is no longer cut in the middle of an emoji.
- A late-starting epic with no end date stays on the Roadmap.
- Track menus open at their button from the keyboard and close with one
  Escape, and tracks moved with the keyboard scroll into view.
- Focus returns to the menu button when you cancel a dialog, and it stays on
  the task heading during a slow load and on the epic drawer's close button.
- Escape in **Confirm your identity** closes only that prompt, and whether the
  prompt appears depends on the server's clock, not the computer's.
- On phones and narrow windows, a dragged card reaches columns that are off
  screen.
- In Firefox, dropping a Board card no longer opens its task page.
- On a systemd server, the docs run `oneloop` commands as the `oneloop`
  account with the unit's settings, so backups, test restores and upgrades
  work as written, and the upgrade steps name a release tag that exists.
  Troubleshooting covers uploads that fail because the server's disk is nearly
  full.
- The launchd example points to the binary and the data folder that the
  source install creates, so a job set up from the guide starts.

### Security

- A display name with markup shows as text in the **Member has open work**
  dialog. Before, it could run app actions when an admin opened that dialog.
- The app page uses only its own scripts and styles, and adds HTML only
  through its own templates and HTML cleaner, which the browser enforces
  (Trusted Types). Mermaid draws diagrams in a separate document.
- A label in a Markdown attachment or Knowledge page can no longer click the
  app's own controls.
- HTML previews of attachments and Knowledge files no longer run scripts or
  load anything from other sites. An interactive page shows as a static page;
  download it to use it fully.
- A tab that still shows someone who signed out no longer reads or saves data
  as the next person to sign in on that browser, and signing out in that tab
  no longer ends the newer session. The tab shows "Your session ended"
  instead.
- Automatic background requests, such as live updates, Knowledge refreshes and
  previews, no longer keep an unused session alive past the 7-day idle limit.
- A request that started just before its session was revoked can no longer
  change the profile, end sessions or disconnect apps, and an AI assistant
  approval sent at that moment creates no sign-in code.
- A password change or reset also cancels AI assistant sign-ins that aren't
  finished.
- An AI assistant connection ends at once when its owner loses access to one
  of its projects: when the project is deleted, when the owner is removed from
  it, even if added back before the app's next request (admins keep access to
  every project), and when an admin who isn't a member loses the admin role.
- The upload and download links that AI assistants get stop working when
  their connection loses access, like other MCP calls.
- Slow or silent clients can no longer take all connections: request bodies
  may pause for at most 60 seconds and must keep a minimum speed, clients that
  stop reading are disconnected, and extra connections get 503 with
  `Retry-After`.
- One person can keep at most 16 live-update connections. Another one closes
  their oldest, and that tab reconnects when it is shown or used again. Live
  updates open only from oneloop's own pages.
- Each person can have at most 10 AI assistant sign-ins waiting for approval,
  and an app's `state` value may be at most 4,096 bytes, so nobody can fill the
  database with them.
- Images are decoded one at a time and within a memory limit, and at most 4
  avatar uploads wait for their turn, so uploads can't use up the server's
  memory.
- AI assistant reads of large Markdown files in a knowledge base read only the
  start of the file, one file at a time, and wait at most 5 seconds. Very long
  lines and headings no longer cost extra memory.
- Knowledge searches run one at a time, so other requests stay fast, with one
  search per person and at most 5 seconds of waiting. Each project's search
  index stays within 64 MiB; files past that limit are found by name only.
- An error message no longer shows the server's data directory path. The
  details stay in the server log.
- A restore makes the `files` and `keys` folders readable only by the account
  that runs oneloop.
- Knowledge's Git commands ignore the settings of a Git checkout that contains
  the data directory.
- The Mermaid bundle now includes KaTeX 0.18.9 instead of 0.16.47, which fixes
  a low-severity KaTeX advisory
  ([GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7)).

### Distribution

- Docker: `ghcr.io/code19m/oneloop:0.1.0-rc.4`, for linux/amd64 and
  linux/arm64
- From source:
  `cargo install --git https://github.com/code19m/oneloop --tag v0.1.0-rc.4 --locked`

## [0.1.0-rc.2] - 2026-10-04

The second release candidate. It adds a read-only knowledge base to each
project and fixes several interface bugs.

### Upgrade notes

- Stop oneloop, install the new version, and run
  `oneloop db migrate --backup-dir <directory>`. It saves a backup first, then
  upgrades the database to schema 2.
- Knowledge needs Git 2.31 or later and an SSH client on the server. The Docker
  image now includes both.

### Added

- **Knowledge**: each project can show one folder of a Git repository as a
  read-only knowledge base, with README files, inline previews and one search
  over names and text. Admins connect it in the project's Settings, from any
  Git host, over HTTPS with an access token or over SSH with a deploy key.
  oneloop checks the branch every minute.
- MCP tools `read_knowledge_overview`, `read_knowledge_file` and
  `search_knowledge` let assistants read the knowledge base.

### Changed

- The documentation has fewer, shorter pages. Links to the old pages redirect
  to the new ones.

### Fixed

- A sidebar click is no longer lost when the page redraws at the same moment,
  for example while a task from another project is loading.
- On narrow screens, the Board's filters no longer sit against the top edge,
  and its first column no longer touches the left edge.
- Page titles no longer show a focus ring after a refresh or a page change.
- A card dropped in another column now settles there directly, instead of
  flying back to its old place first.
- "Try again in … seconds" after too many sign-in attempts now counts down,
  and says when you can try again.
- Exact times, such as a task's creation time, no longer end with the time
  zone name. They are still shown in the instance time zone.
- Inbox items have a small gap between them, so highlighted items no longer
  touch.
- A long comment's "Show more" preview now fades out smoothly, like a long
  description, instead of ending at a hard edge.
- Clicking "Load older activity" is no longer lost when a new comment or
  change arrives at the same moment.

### Distribution

- Docker: `ghcr.io/code19m/oneloop:0.1.0-rc.2`, for linux/amd64 and
  linux/arm64
- From source:
  `cargo install --git https://github.com/code19m/oneloop --tag v0.1.0-rc.2 --locked`

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

[Unreleased]: https://github.com/code19m/oneloop/compare/v0.1.0-rc.6...HEAD
[0.1.0-rc.6]: https://github.com/code19m/oneloop/compare/v0.1.0-rc.5...v0.1.0-rc.6
[0.1.0-rc.5]: https://github.com/code19m/oneloop/compare/v0.1.0-rc.4...v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/code19m/oneloop/compare/v0.1.0-rc.2...v0.1.0-rc.4
[0.1.0-rc.2]: https://github.com/code19m/oneloop/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/code19m/oneloop/releases/tag/v0.1.0-rc.1
