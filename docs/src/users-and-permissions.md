# Users and permissions

This page shows admins how to add people, give them access to projects and help them when they're locked out.

## What each person can do

Access is set per project. Someone you add to a project becomes a member with read-only access. Tick **Roadmap** or **Board** to let them change things.

| Action | Member | + Roadmap | + Board | Admin |
| --- | --- | --- | --- | --- |
| See the project's Roadmap, Board, tasks, attachments and Team Pool | Yes | Yes | Yes | Every project |
| Comment, reply and mention people | Yes | Yes | Yes | Every project |
| Edit or delete comments | Own | Own | Own | Any |
| Use their private My Pool | Yes | Yes | Yes | Yes |
| Be assigned tasks | Yes | Yes | Yes | Where also a member |
| Change tracks, epics and milestones | No | Yes | No | Yes |
| Create, move, block and delete tasks, upload attachments, edit the Team Pool | No | No | Yes | Yes |
| Manage projects, members, users and storage | No | No | No | Yes |

People can't see projects they aren't members of. Changes take effect immediately, including for connected AI assistants.

## Create the first admin

Nobody can sign in yet, so create the first account on the server:

```sh
oneloop user add alice --admin --name "Alice Martin"
```

oneloop asks for the password twice. With Docker, run it as `docker compose run --rm oneloop user add …`. In scripts, pass `--password-stdin` and send the password on standard input.

## Add people

1. Open the profile menu at the bottom of the sidebar and choose **Users**.
2. Choose **New user** and fill in **Username** and **Full name**. Tick **Admin** only for people who should manage the whole instance.
3. Choose **Create user**. oneloop shows a temporary password once. Send it to the person privately.
4. At first sign-in, they choose their own password.

Usernames are 3 to 32 lowercase letters, digits, dots, underscores or hyphens, and can't be changed later. Passwords need at least 5 characters; encourage long passphrases, especially for admins.

`oneloop user add` works for later accounts too. They also choose a new password at first sign-in.

## Give access to a project

1. Select the project and open **Settings** in the sidebar.
2. Under **Project access**, pick someone from **Add member**.
3. Tick **Roadmap**, **Board** or both.

To remove someone, choose **Remove from project** (×) on their row. oneloop blocks this while they have open tasks assigned in that project, so reassign those first.

## Deactivate someone

Open **Users**, click the person, clear **Active** and choose **Save**. They're signed out everywhere and their connected apps lose access. Their work and history stay; accounts are never deleted. Tick **Active** again to restore them with their old memberships.

The last active admin can't be deactivated or lose admin access.

## Reset a password

An admin opens **Users**, clicks the person and chooses **Reset password**. oneloop signs them out everywhere, revokes their connected apps and shows a temporary password once.

If no admin can sign in, reset the password on the server. This works while oneloop is running:

```sh
oneloop user passwd alice
```

The account is signed out everywhere, and the person picks a new password at their next sign-in.

## Check that it worked

Ask the person to sign in. They should see only the projects you added them to, and be able to change only what you ticked for them.
