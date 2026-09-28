# AI assistants (MCP)

This page shows you how to connect an AI assistant such as Claude Code or Codex
to oneloop, choose what it may do, and take that access away again.

oneloop has a built-in [MCP](https://modelcontextprotocol.io) server. A
connected assistant can find, create, update and move tasks, plan on the
Roadmap, comment, handle attachments and go through your Inbox. It always acts
as you, never with more rights than you have, and only in the projects you pick.

## Before you start

- Your MCP address is the public address in `ONELOOP_PUBLIC_URL` plus `/mcp`,
  for example `https://tasks.example.com/mcp`. Use exactly that host name.
- The computer running the assistant must be able to reach that address.
- Any oneloop account works; you don't need to be an admin.

## Connect Claude Code

1. Add oneloop as an MCP server:

   ```sh
   claude mcp add --transport http --scope local oneloop https://tasks.example.com/mcp
   ```

2. Start the sign-in:

   ```sh
   claude mcp login oneloop
   ```

   On a machine without a browser, run `claude mcp login --no-browser oneloop`
   and open the link it prints on another device. After you choose **Connect**,
   that browser ends up on a `localhost` address that doesn't load; copy the
   address and paste it where Claude Code asks for it.

3. oneloop opens in your browser. Sign in if asked, then choose projects and
   capabilities on the **Connect** page (see below) and choose **Connect**.

## Connect Codex

1. Add oneloop as an MCP server:

   ```sh
   codex mcp add oneloop \
     --url https://tasks.example.com/mcp \
     --oauth-resource https://tasks.example.com/mcp \
     --oauth-client-registration dcr
   ```

2. Sign in, listing the capabilities you may want to grant:

   ```sh
   codex mcp login oneloop \
     --oauth-client-registration dcr \
     --scopes project_read,discussion,board_manage,roadmap_manage,inbox_private,my_pool_private,attachments,destructive
   ```

   Leave out any capability you know you won't grant.

3. Choose projects and capabilities on the **Connect** page, then choose
   **Connect**.

## Connect another MCP client

Any client that supports the Streamable HTTP transport and OAuth sign-in with
dynamic client registration and PKCE works. Give it your MCP address; it
discovers the rest from `/.well-known/oauth-protected-resource/mcp`. Its
callback must be on its own computer (`localhost`, `127.0.0.1` or `[::1]`) or
an `https://` address. oneloop is tested with MCP protocol version 2025-11-25.

MCP is the way to build on oneloop. The JSON API under `/api` exists only for
oneloop's own web app; it isn't documented and can change in any release.

## Choose projects and capabilities

The **Connect** page shows who you are signed in as and where you'll be sent
afterwards; check both, because oneloop can't verify the app's name. Tick at
least one project; the assistant sees nothing else. Then choose capabilities:

| Capability on the Connect page | Scope | Lets the assistant | Ticked at first |
| --- | --- | --- | --- |
| Read selected projects | `project_read` | Read the Roadmap, Board, tasks, comments, activity and members | Always on |
| Read and write comments and replies | `discussion` | Post comments and replies, and edit your own | Yes |
| Create and manage tasks and Pool items | `board_manage` | Create, edit, move and block tasks; manage the Team Pool | Yes |
| Create and manage roadmap work | `roadmap_manage` | Create and edit tracks, epics and milestones | Yes |
| Read and manage your private Inbox (selected projects only) | `inbox_private` | Read your Inbox, mark items read, archive them | No |
| Read and manage your private My Pool | `my_pool_private` | Read and manage your My Pool items | No |
| Read and manage attachments | `attachments` | List and download files; upload and reorder them if it may also manage tasks | Yes |
| Permanently delete permitted work and files | `destructive` | Delete tasks, epics, tracks, milestones, Pool items, attachments and your own comments | No |

The page lists only the capabilities the assistant asked for. Delete access
also needs at least one management capability.

A capability never adds a permission: if you can't manage the Board in a
project, neither can the assistant. Admin work, such as creating projects or
managing members and accounts, is never available to an assistant, even an
admin's. Your password, sessions and connected apps change only in the browser.

- Anything the assistant reads can reach its AI provider, so tick only the
  projects it needs.
- Delete tools are marked destructive, so a good client asks you before each
  one. oneloop can't see that prompt; grant delete access only to a client you
  trust.

The assistant's changes show in activity under your name, followed by "via" and
the app name. [MCP tools](mcp-tools.md) lists every tool and what it needs.

## Check that it worked

1. Ask the assistant: "Which oneloop projects can you see?" It should list the
   projects you ticked.
2. In oneloop, open **Profile**. Under **Connected apps** you'll see the app,
   its projects and its permissions.

## Change or remove access

Open **Profile**, find the app under **Connected apps** and choose **Revoke**.
It stops working at once. To change projects or capabilities, revoke the app and
sign in from the assistant again.

oneloop also ends a connection when:

- you change your password, or an admin resets it;
- an admin deactivates your account;
- you are removed from one of its projects, or that project is deleted;
- a backup is restored;
- it goes unused for 30 days, or 90 days have passed since you connected it.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The Connect page offers only **Read selected projects** | The assistant didn't ask for more. With Codex, sign in again with `--scopes` |
| The assistant can't reach oneloop | Check that its computer can open your public address, and that you used that exact host name |
| The assistant stops working and asks you to sign in again | The connection ended (see above). Connect it again |
| Tool calls fail with `forbidden` | You, or the connection, lack that permission in this project |
