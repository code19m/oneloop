# Reference

## Configuration

oneloop reads its settings only from environment variables. There is no
configuration file, and oneloop doesn't load `.env` files itself. Docker or your
service manager can load them for it.

- oneloop reads the settings when it starts, so restart it after a change.
- It refuses to start if a value is invalid, or if it finds an unknown variable
  that starts with `ONELOOP_`. This way, a typo can't go unnoticed.
- `oneloop serve --check` checks the settings, and the database if there is
  one, without starting the server. Run it after every change.
- The other commands read only `ONELOOP_DATA_DIR`. Still, run them as the same
  system account and with the same environment as the server.

| Variable | Default | What it does |
| --- | --- | --- |
| `ONELOOP_PUBLIC_URL` | None, required | The address people open, such as `https://tasks.example.com`. oneloop uses it for links, sign-in checks and AI assistant connections. It must use HTTPS, except for `localhost`, `127.0.0.1` and `[::1]`. Include the port if it isn't the standard one. No path, query or credentials. |
| `ONELOOP_LISTEN` | `127.0.0.1:8080` | The IP address and port to listen on, such as `0.0.0.0:8080` or `[::1]:8080`. Host names don't work here. The Docker image sets `0.0.0.0:8080`. |
| `ONELOOP_DATA_DIR` | `./data` | The folder for the database, uploaded files and internal keys. A relative path starts from the working directory. A symbolic link followed by `..` uses the linked folder's parent, so the link must point to an existing folder. The data folder must be on a local disk; NFS and SMB aren't supported. The Docker image sets `/data`. |
| `ONELOOP_TIMEZONE` | `UTC` | Your team's timezone. See [Timezone](#timezone). |
| `ONELOOP_STORAGE_LIMIT` | `10GiB` | Space for uploaded files, their previews and unfinished uploads. See [Storage](#storage). |
| `ONELOOP_DISK_MIN_FREE` | `1GiB` | oneloop refuses an upload that would leave less free disk space than this. A Knowledge sync needs more; see [Limits](#limits). |
| `ONELOOP_TRUSTED_PROXIES` | Empty (trust none) | IP addresses or CIDR ranges of your reverse proxies, separated by commas. Only these may send the visitor's address in `X-Forwarded-For`. See [Trusted proxy](production.md#trusted-proxy). |
| `ONELOOP_LOG_LEVEL` | `info` | How much to log: `error`, `warn`, `info`, `debug` or `trace`. |

Logs go to standard error. In a terminal they are colored, unless `NO_COLOR` is
set.

### Timezone

One timezone applies to the whole instance. It decides when a deadline day ends,
where today is on the Roadmap, and how dates and times are shown. Use an IANA
name, such as `Europe/Berlin` or `America/New_York`.

oneloop has its own timezone database, so the server's clock settings and the
`TZ` variable of a container have no effect. `oneloop serve --check` prints the
version of this database, such as `2025b`. If your region changed its clock
rules after that version, times can be an hour off until a new oneloop release
brings newer data. Until then, you can set a fixed offset such as `Etc/GMT+7`,
which means UTC−07 (the sign is reversed).

### Storage

The storage limit covers uploaded files (attachments and avatars), their
previews and unfinished uploads. The database doesn't count, and neither do
Knowledge files, which oneloop keeps in the database.

When usage reaches 80% of the limit, oneloop removes temporary attachments that
nobody has opened for 24 hours, until usage is back at 70%. It never removes
other files by itself. It refuses new uploads when the limit is reached, or when
an upload would leave less free disk space than `ONELOOP_DISK_MIN_FREE`.
Uploads, and Knowledge syncs that download a new commit, reserve space from the
same disk budget before they start. A reservation stays in place until
publication or temporary-file cleanup finishes.
When a delayed attachment deletion finishes, activity records the person and
app that requested it.

Write sizes as a whole number followed by a unit, without a space: `B`, `KB`,
`MB`, `GB` or `TB` (powers of 1000), or `KiB`, `MiB`, `GiB` or `TiB` (powers of
1024). Units are case-sensitive, and zero isn't allowed.

## Commands

| Command | What it does |
| --- | --- |
| `oneloop serve` | Runs the web app and the MCP server in the foreground. With `--check`, it only checks the settings and the database, then exits. |
| `oneloop db migrate` | Creates the database, or upgrades it to the current version. When it upgrades, `--backup-dir <folder>` is required, and oneloop saves a verified backup there first. |
| `oneloop user add <username>` | Creates an account. `--admin` makes it an admin, and `--name "<full name>"` sets the name (the default is the username). |
| `oneloop user passwd <username>` | Sets a new password and signs the account out everywhere. |
| `oneloop backup create <folder>` | Writes a complete, verified backup to a new folder. |
| `oneloop backup restore <folder>` | Restores a backup into a new or empty data directory. |

`oneloop --help` and `oneloop <command> --help` show help, and
`oneloop --version` prints the version. With Docker, run the commands in the
container, for example `docker compose exec oneloop oneloop backup create …`.

- Results go to standard output; errors and logs go to standard error. The exit
  code is `0` on success, `2` for an invalid setting, argument or value, such as
  an unknown `ONELOOP_` variable, a data directory that isn't a folder, or a
  username with spaces, and `1` for anything else, such as a username that is
  taken or a backup folder that already exists.
- `serve` refuses to start if the database needs `db migrate`, or if another
  oneloop server uses the same data directory. `serve --check` never creates a
  database, opens a port or changes data. It also prints the versions of SQLite
  and of the timezone database.
- `db migrate` needs the data directory to itself, even when there is nothing
  to upgrade: stop the server, and wait for backups and other `oneloop`
  commands to finish. `serve --check` works while the server runs and shows
  whether an upgrade is needed. There is no downgrade.
- `user add` and `user passwd` ask for the password twice. In scripts, use
  `--password-stdin` and send the password as one line, for example
  `oneloop user add ci-bot --password-stdin < password.txt`. oneloop removes the
  line ending; every other character, including spaces, is part of the
  password.
- New accounts must choose their own password at first sign-in. The only
  exception is the first admin of an empty instance.
- `user passwd` works while the server runs. It also disconnects the person's AI
  assistants and makes them choose a new password at their next sign-in. It
  doesn't reactivate a deactivated account or change the admin role.

## Limits

These limits are fixed. Only the [storage](#storage) limits are settings.

**Files**

| Limit | Value |
| --- | --- |
| Attachment size | 25 MiB per file |
| Attachments per task | 25 |
| Text and Markdown previews | The first 200 KiB |
| HTML previews | Files up to 1 MiB |
| Avatar | 5 MiB and at most 8192 px per side; stored as 256 × 256 px |
| Upload in progress | Fails if it stalls for 60 seconds, or takes over an hour |

Text and Markdown previews require valid text throughout the file. A Markdown
filename does not enable a text preview for binary content. Recognized images
and PDFs can still preview.

**Knowledge**

| Limit | Value |
| --- | --- |
| Folder | 5,000 files and 100 MiB of files to show; a larger folder doesn't sync |
| File | Files over 10 MiB are left out |
| Sync disk use | 300 MiB for the folder's files and Git's copy of them, files left out included; a larger folder doesn't sync |
| Free disk space | A download reserves 400 MiB on top of `ONELOOP_DISK_MIN_FREE`; a check that finds no new commit needs none |
| File path | 1,024 bytes |
| Sync | Checks the branch every minute; after a failure, every 5 minutes |
| Sync time | A check stops after 30 seconds, a download after 5 minutes |
| Search | 8 words and 200 characters |
| Searchable text | Markdown and text files up to 1 MiB; only the first 5,000 lines of plain-text files |

All query words must occur in the same file or folder path, Markdown section,
or plain-text line. Matching ignores letter case. Files outside the searchable
text limits can still be found by name.

**Text**

| Limit | Value |
| --- | --- |
| Project name | 60 characters |
| Task prefix | 2 to 4 uppercase letters or digits, never reused |
| Track | Name 60 characters, description 2,000 |
| Epic | Title 120 characters, description 2,000 |
| Milestone | Title 60 characters, description 500 |
| Task | Title 140 characters, description 4,000 |
| Pool item | Title 140 characters, description 2,000 |
| Block reason | 500 characters; unblock note 500 |
| Comment or reply | 2,000 characters |

Some emoji count as two characters.

**Accounts**

| Limit | Value |
| --- | --- |
| Username | 3 to 32 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit |
| Full name | 80 characters |
| Password | At least 5 characters; at most 16,384 UTF-8 bytes |
| Sessions per account | 10; sign out of one to sign in somewhere new |
| Session length | Ends after 7 days without use, and after 30 days at most; automatic image and HTML previews do not extend it |
| Sensitive admin actions | Need a sign-in within the last 30 minutes |
| Failed sign-ins | Within 15 minutes, delays start after 5 failures for one account/address pair, 20 failures from one address across accounts, or 15 failures for one account across addresses. Delays start at 30 seconds and double, up to 15 minutes for pair/address limits or 60 seconds for the account limit. |

**Collaboration**

| Limit | Value |
| --- | --- |
| `@everyone` | Once a minute per person in each project |
| Archived Inbox items | Removed after 90 days; cannot be restored |
| Activity | Edits by one person to the same field within 5 minutes show as one entry. History is kept forever. |

**AI assistants**

| Limit | Value |
| --- | --- |
| Connection | Ends after 30 days without use, and after 90 days at most |
| App registrations | 10 per hour from one address; 300 per hour in total |
| File tickets | Work once and expire after 5 minutes |
| Items per page | 50 (100 for comments, activity and the Inbox) |
| Retry keys | Remembered for 24 hours |
| Knowledge overview | 200 files, and 20,000 characters of the README |
| Knowledge file | 100,000 characters |

**Server**

| Limit | Value |
| --- | --- |
| Open connections | 1,024; extra connections get 503 with `Retry-After: 1` |
| Request headers | Must arrive within 15 seconds of opening the connection, or of the previous response |
| Request body | May pause for up to 60 seconds; after the first minute, must arrive at 1 KiB per second on average |
| Response | After the first minute of waiting, the client must read 1 KiB per second on average, or the connection closes |
| Busy database | A request waits up to 5 seconds, then gets "try again" |
| Shutdown | Open requests get up to 30 seconds to finish |
