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
- The other commands read only `ONELOOP_DATA_DIR`, and `user add` and
  `user passwd` also read the [password settings](#passwords). Still, run them
  as the same system account and with the same environment as the server.

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
| `ONELOOP_PASSWORD_MIN_LENGTH` | `5` | The fewest characters in a new password, from 5 to 1,024. See [Passwords](#passwords). |
| `ONELOOP_ADMIN_PASSWORD_MIN_LENGTH` | `ONELOOP_PASSWORD_MIN_LENGTH` | The fewest characters in a new admin password. It can't be lower than `ONELOOP_PASSWORD_MIN_LENGTH`. |
| `ONELOOP_PASSWORD_BLOCKLIST` | None | A file of passwords that nobody may choose, one per line. See [Passwords](#passwords). |
| `ONELOOP_TEMPORARY_PASSWORD_LIFETIME` | None (no expiry) | How long a temporary password works for signing in, in hours or days, such as `36h` or `7d`, up to `365d`. |
| `ONELOOP_MCP_REDIRECT_SCHEMES` | None | Link schemes of apps, such as `cursor`, that AI assistants may use for their sign-in callback, separated by commas. `http`, `https` and the schemes browsers handle themselves, such as `javascript` and `data`, aren't allowed. See [AI assistant connections](production.md#ai-assistant-connections). |
| `ONELOOP_MCP_ALLOWED_ORIGINS` | None | Origins of browser-based MCP clients, such as `http://localhost:6274`, separated by commas. Each is `https://` and a host, or `http://` and a loopback host, with an optional port and no path. |
| `ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS` | `false` | `true` lets AI assistants use an HTTPS address of a client ID metadata document as their client ID. oneloop fetches the document. |

Logs go to standard error. In a terminal they are colored, unless `NO_COLOR` is
set.

### Timezone

One timezone applies to the whole instance. It decides when a deadline day ends,
where today is on the Roadmap, and how dates and times are shown. Use an IANA
name, such as `Europe/Berlin` or `America/New_York`.

oneloop takes the rules for this name from the server's timezone database, in
`/usr/share/zoneinfo` or the folder that `TZDIR` names, when it is at least as
new as the copy built into oneloop. Otherwise it uses the built-in copy.
Browsers show dates and times with their own copy of the rules. The server's
clock settings and the `TZ` variable have no effect. `oneloop serve --check`
prints the copy in use and its version, such as `2026c (built in)`.

If your region changes its clock rules, a newer `tzdata` package on the server
brings them before a new oneloop release does; the Docker image includes the
one of its Debian release. Until then, times can be an hour off, and you can
set a fixed offset such as `Etc/GMT+7`, which means UTC−07 (the sign is
reversed).

### Passwords

The password settings are off until you set them. They apply whenever someone
chooses a new password: when they change it, when they replace a temporary
password at their first sign-in, and when you set one with `oneloop user add`
or `oneloop user passwd`. The temporary passwords that admins get in the app
are random and always long enough.

Signing in never checks the rules, so existing passwords keep working when you
make them stricter. A person who becomes an admin keeps a shorter password
until they change it.

- `ONELOOP_PASSWORD_BLOCKLIST` names a text file with one password per line,
  such as a list of common passwords, of at most 16 MiB. Letter case doesn't
  matter, and empty lines are skipped. With a list, a password that equals the
  username is refused too. oneloop reads the file when it starts, and refuses
  to start if it can't.
- With `ONELOOP_TEMPORARY_PASSWORD_LIFETIME`, a temporary password that is older
  than this no longer signs in. The person sees "This temporary password has
  expired", and an admin resets it again. Temporary passwords come from
  **Create user** and **Reset password** in the app, and from
  `oneloop user add` and `oneloop user passwd`.

### Storage

The storage limit covers uploaded files (attachments and avatars), their
previews and unfinished uploads. The database doesn't count, and neither do
Knowledge files, which oneloop keeps in the database.

When usage reaches 80% of the limit, oneloop removes all image thumbnails, then
temporary attachments that nobody has opened for 24 hours, until usage is back
at 70%. It also removes them, at any usage, when an upload would leave less
free disk space than `ONELOOP_DISK_MIN_FREE`. It makes a thumbnail again when
someone views the image, unless usage is at 80%. It never removes other files
by itself.

oneloop refuses an upload when the limit is reached, or when the upload would
still leave less free disk space than `ONELOOP_DISK_MIN_FREE`. Space that
running uploads and Knowledge downloads need counts as used. A deleted file
still counts, as pending deletion, until oneloop removes it after the
[Undo](user-guide.md#undo-a-deletion) window.

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
| Image thumbnails | PNG, JPEG and WebP images up to 8192 px per side and about 40 megapixels; at most 256 × 256 px |
| Avatar | 5 MiB and at most 8192 px per side; stored as 256 × 256 px |
| Upload in progress | Fails if it stalls for 60 seconds, or takes over an hour |

Text and Markdown previews need the whole file to be valid UTF-8 text.

Tasks load the original file for other images, such as GIFs, and for images
that oneloop can't read. A new image has its thumbnail a moment after the
upload.

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
| Password | At least 5 characters, or more with the [password settings](#passwords); at most 16,384 UTF-8 bytes |
| Sessions per account | 10; sign out of one to sign in somewhere new |
| Session length | Ends after 7 days without use, and after 30 days at most. Automatic background requests, such as live updates and image or HTML previews, don't extend it. |
| Sensitive admin actions | Need a sign-in within the last 30 minutes |
| Failed sign-ins | Within 15 minutes, delays start after 5 failures for one account/address pair, 20 failures from one address across accounts, or 15 failures for one account across addresses. Delays start at 30 seconds and double, up to 15 minutes for pair/address limits or 60 seconds for the account limit. |

**Collaboration**

| Limit | Value |
| --- | --- |
| `@everyone` | Once a minute per person in each project |
| Archived Inbox items | Removed after 90 days; cannot be restored |
| Undo of a deletion | Within 5 minutes; then oneloop removes the deleted files and comment text |
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
| Request body size | 256 KiB for normal requests; 1 MiB for MCP calls |
| Request body speed | May pause for up to 60 seconds; after the first minute, must arrive at 1 KiB per second on average |
| Response | After the first minute of waiting, the client must read 1 KiB per second on average, or the connection closes. A client that stops reading is disconnected within 5 minutes. |
| Busy database | A request waits up to 5 seconds, then gets "try again" |
| Shutdown | Open requests get up to 30 seconds to finish |
