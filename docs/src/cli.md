# Command line

This page lists every `oneloop` command, with an example of each.

| Command | What it does | Options |
| --- | --- | --- |
| `oneloop serve` | Runs the web app and the MCP server in the foreground | `--check`: validate the configuration and database, then exit |
| `oneloop db migrate` | Creates a new database, or upgrades an existing one after backing it up | `--backup-dir <directory>`: where to write the pre-upgrade backup; required when upgrading |
| `oneloop user add <username>` | Creates an account | `--admin`: make it an admin<br>`--name <full name>`: defaults to the username<br>`--password-stdin`: read the password from standard input |
| `oneloop user passwd <username>` | Sets a new password and signs the account out everywhere | `--password-stdin` |
| `oneloop backup create <destination>` | Writes a complete, verified backup to a new directory | |
| `oneloop backup restore <backup>` | Restores a backup into a new or empty data directory | |

A few things hold for every command:

- `-h` or `--help` shows help, and `oneloop --version` prints the version.
  Running `oneloop` with no command prints help and changes nothing.
- Settings come from the environment, never from flags. `serve` needs the full
  [configuration](configuration.md); the other commands only use
  `ONELOOP_DATA_DIR`. An unknown `ONELOOP_*` variable is an error, so typos
  don't go unnoticed.
- Results go to standard output, and errors and logs go to standard error.
- The exit code is `0` on success, `2` for a mistake in the command,
  configuration or input, and `1` for any other failure.

With Docker, run the same commands inside the container, as shown in
[Quick start with Docker](quick-start.md) and
[Backups and upgrades](backups-and-upgrades.md).

## serve

```sh
export ONELOOP_PUBLIC_URL=https://tasks.example.com
export ONELOOP_DATA_DIR=/var/lib/oneloop/data
oneloop serve
```

The server stays in the foreground, so let a service manager run it (see
[Running as a service](running-as-a-service.md)). On Ctrl+C or `SIGTERM` it
stops taking new connections and gives open requests up to 30 seconds to
finish. It refuses to start if the database needs `db migrate`, or if another
oneloop server already uses the data directory.

To check a configuration without starting anything:

```console
$ oneloop serve --check
configuration and schema are valid (schema 1, data /var/lib/oneloop/data)
```

It also prints the SQLite and time zone database versions. `--check` never
creates a database, opens a port or changes data.

## db migrate

On a new instance, this creates the database:

```sh
oneloop db migrate
```

To upgrade, stop the server first, then:

```console
$ oneloop db migrate --backup-dir /var/backups/oneloop
database migrated from 1 to 2
pre-upgrade backup: /var/backups/oneloop/oneloop-pre-migration-v1-1790000000
```

oneloop writes and verifies a complete backup before it changes anything. If
the database is already current, it says so and exits without a backup. The
server never migrates on its own, and there is no downgrade. A database created
before 0.1.0 is converted the same way; see
[Databases from before 0.1.0](backups-and-upgrades.md#databases-from-before-010).

## user add

```console
$ oneloop user add alice --name "Alice Martin"
Password:
Confirm password:
created user alice
```

Most accounts are created by an admin on the **Users** page. Use this command
for the first admin (`--admin`) and for scripts. The first admin on an empty
instance keeps the password you typed; everyone else must choose a new one at
first sign-in. For scripts, read the password from a file rather than an
argument or variable:

```sh
oneloop user add ci-bot --password-stdin < password.txt
```

`--password-stdin` expects exactly one line and drops its line ending; every other
character, including spaces, is part of the password. Without it, the command
needs a terminal to prompt in.

## user passwd

```console
$ oneloop user passwd alice
Password:
Confirm password:
password reset; existing credentials revoked
```

This is how you recover an account, including the last admin. It works whether
the server is running or not. It signs the person out of every browser,
disconnects their AI assistants and asks them to choose a new password at their
next sign-in. It does not reactivate a deactivated account or change the admin
role.

## backup create

```console
$ oneloop backup create /var/backups/oneloop/2026-09-28
backup created at /var/backups/oneloop/2026-09-28
```

The backup holds the database and every stored file, and oneloop verifies it
before reporting success. The destination must not exist yet and must be outside
the data directory. The server can keep running; file uploads may pause for a
moment. Schedules and old-backup cleanup are up to you; see
[Backups and upgrades](backups-and-upgrades.md).

## backup restore

```console
$ export ONELOOP_DATA_DIR=/var/lib/oneloop-restored
$ oneloop backup restore /var/backups/oneloop/2026-09-28
backup restored to /var/lib/oneloop-restored; all restored credentials were revoked
```

The target data directory must be new or empty, so a restore never overwrites a
working instance. Stop the server, then start it on the restored directory.
Everyone signs in again and reconnects their AI assistants. If the backup comes
from an older version, run `oneloop db migrate` before you start the server.
