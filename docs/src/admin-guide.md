# Admin guide

Admins manage people, projects and storage, and they can see and change every
project. As an admin, you find **Users** and **Storage** in the menu under your
name at the bottom of the sidebar.

## Permissions

Access is set for each project. A person you add to a project becomes a member
with read-only access. Tick **Roadmap** or **Board** to let them change things.

| Action | Member | + Roadmap | + Board | Admin |
| --- | --- | --- | --- | --- |
| See the project's Roadmap, Board, tasks, files, Team Pool and Knowledge | Yes | Yes | Yes | Every project |
| Comment, reply and mention people | Yes | Yes | Yes | Every project |
| Edit or delete comments | Own | Own | Own | Any |
| Use their private My Pool | Yes | Yes | Yes | Yes |
| Be assigned tasks | Yes | Yes | Yes | Where also a member |
| Change tracks, epics and milestones | No | Yes | No | Yes |
| Create, move, block and delete tasks, upload files, change the Team Pool | No | No | Yes | Yes |
| Manage projects, members, the knowledge base, users and storage | No | No | No | Yes |

People don't see projects they aren't members of. Changes apply at once, also
to their connected AI assistants.

## Add people

You create the first admin on the server when you [install](install.md)
oneloop. Add everyone else in the app:

1. Open **Users** and choose **New user**.
2. Enter a **Username** and a **Full name**. Tick **Admin** only for people who
   should manage the whole instance.
3. Choose **Create user**. oneloop shows a temporary password once. Send it to
   the person privately. They choose their own password when they first sign
   in.

Usernames have 3 to 32 lowercase letters, digits, dots, underscores or hyphens,
and they can't be changed later. Passwords need at least 5 characters. Ask
people, especially admins, to use long passphrases.

You can also create accounts on the server with
[`oneloop user add`](reference.md#commands).

## Give access to a project

1. Select the project and open **Settings** in the sidebar.
2. Under **Project access**, pick a person in **Add member**.
3. Tick **Roadmap**, **Board** or both.

To remove someone, choose **Remove from project** (×) on their row. You can't
remove a person while they have open tasks in the project, so reassign those
tasks first.

## Reset a password or deactivate someone

Open **Users** and click the person.

- **Reset password** shows a new temporary password once.
- To deactivate the person, clear **Active** and choose **Save**. Their work
  and history stay, because accounts are never deleted. Tick **Active** again
  to restore them with their old project access.

Both actions sign the person out everywhere and disconnect their AI assistants.
The last active admin can't be deactivated or lose the admin role.

If no admin can sign in, reset a password on the server. This works while
oneloop is running:

```sh
oneloop user passwd alice
```

## Projects

To create a project, choose **New project** in the project selector. A project
needs a name and a task prefix of 2 to 4 letters or digits. Task IDs use the
prefix, such as `APP-042`. If you change the prefix later, only new tasks use
it.

To delete a project, open its **Settings**, choose **Delete project** and type
the project's name. This deletes all of the project's work and files, and you
can't undo it. The last project can't be deleted.

## Knowledge base

Each project can show one folder of a Git repository as its
[Knowledge](user-guide.md#knowledge). oneloop only reads the repository; people
change the files in Git, with the review your team already uses.

1. Open the project's **Settings** and choose **Connect repository** under
   **Knowledge base**.
2. Enter the **Repository URL**, the **Branch** and the **Folder**. Leave
   **Folder** empty to show the whole repository.
3. Give oneloop read access, as described below, and choose **Connect**.

The first sync starts at once. After that, oneloop checks the branch every
minute and downloads the folder again only when it has changed.

Any Git host works: GitLab, GitHub, Gitea, Bitbucket or your own server. The
URL decides how oneloop signs in:

| URL | Example | Access |
| --- | --- | --- |
| HTTPS | `https://git.example.com/team/docs.git` | An **Access token** with read-only access to the repository. Leave it empty for a public repository. |
| SSH | `git@git.example.com:team/docs.git` or `ssh://git@git.example.com:2222/team/docs.git` | A **Deploy key**. oneloop creates one for the project and shows it in the dialog. Add it to the repository as a read-only deploy key. |

- Create a token that can only read this repository, such as a GitLab project
  access token with `read_repository`, or a GitHub fine-grained token with
  read access to contents.
- oneloop sends the token with the username `oneloop`. If your host needs a
  particular username, put it in the URL, such as
  `https://x-token-auth@bitbucket.org/team/docs.git`. Never put a password in
  the URL.
- A saved token is never shown again. **Manage connection** offers **Replace**
  and **Remove**.
- On the first SSH connection, oneloop remembers the host's key. If the key
  changes later, syncs fail until you check why; see
  [Troubleshooting](troubleshooting.md#knowledge-sync).

**Settings** shows the repository, the branch and folder, and when the last
sync succeeded. If a sync fails, it also shows the reason, and oneloop tries
again every 5 minutes. People keep reading the last synced files. To try at
once, choose **Retry sync** on the Knowledge page.

When you change the URL, branch or folder, the old files disappear and the new
ones appear after the next sync. **Disconnect** removes the synced files, the
token and the deploy key from oneloop. The repository itself is never changed.

Files larger than 10 MB are left out. A folder with more than 5,000 files or
100 MB in total doesn't sync; see [Limits](reference.md#limits).

## Storage

The **Storage** page shows how much space uploaded files use, in total and for
each project. When storage runs low, oneloop removes old temporary files by
itself, and **Clean up now** does it at once. [Storage](reference.md#storage)
explains the rules. When storage is full, uploads fail. Then delete files, or
raise `ONELOOP_STORAGE_LIMIT`.
