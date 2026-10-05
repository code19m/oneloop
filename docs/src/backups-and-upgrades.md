# Backups and upgrades

The examples use the [systemd setup](production.md#systemd-linux) for an
install from source, with data in `/var/lib/oneloop/data`, and the example
`compose.yaml` for Docker. Run `oneloop` commands as the account that runs
oneloop, with the same environment, for example
`sudo -u oneloop env ONELOOP_DATA_DIR=/var/lib/oneloop/data /usr/local/bin/oneloop backup create …`.

## Back up

A backup is a complete, verified copy of the database, all uploaded files and
the `keys` folder. That folder holds the key that encrypts Knowledge
credentials, so a restored instance can still sync. oneloop keeps running
while you make a backup. While the backup copies the database, file uploads
and downloads wait. One that waits more than 5 seconds fails, and you can try
it again. Image thumbnails aren't copied; oneloop makes them again when people
view the images.

First, create a backup folder that only the account that runs oneloop can use:

```sh
sudo install -d -m 0700 -o oneloop -g oneloop /var/backups/oneloop
```

Then make a backup in a new folder inside it:

```sh
oneloop backup create /var/backups/oneloop/2026-09-28
```

The destination folder must not exist yet, but its parent folder must. It must
be outside the data directory.

A backup builds its copy in a hidden folder next to the destination, such as
`.2026-09-28.partial-…`, and renames it when the copy is complete and verified.
If a backup stops halfway, for example because the server restarted, the next
backup into the same folder removes that hidden folder; `db migrate` does the
same in its backup folder. oneloop removes it only when it can tell that the
backup that wrote it has ended: the backup ran on the same computer, and its
process no longer runs. Otherwise oneloop prints the folder's path. Delete it
yourself once you are sure that no backup is running. oneloop tells computers
apart by their host name, so don't share a backup folder between computers
that have the same host name.

With Docker, first create a backup folder that the container can write to. The
container runs as user 10001:

```sh
sudo install -d -m 0700 -o 10001 -g 10001 /srv/oneloop-backups
```

In `compose.yaml`, add `- /srv/oneloop-backups:/backups` to the service's
`volumes:`, next to `- oneloop-data:/data`. Run `docker compose up -d`, and
then:

```sh
docker compose exec oneloop oneloop backup create /backups/2026-09-28
```

> [!WARNING]
> A backup contains password hashes and every private file. Keep it private,
> and encrypt copies that you store elsewhere. Don't copy the data directory by
> hand while oneloop runs, because the copy can be broken.

### Back up every night

Run the command every night with cron or a systemd timer. For example, add this
line to the crontab of the account that runs oneloop, with
`sudo crontab -u oneloop -e`:

```
0 2 * * * ONELOOP_DATA_DIR=/var/lib/oneloop/data /usr/local/bin/oneloop backup create /var/backups/oneloop/$(date -u +\%Y\%m\%dT\%H\%M\%SZ)
```

With Docker, use
`docker compose -f /path/to/compose.yaml exec -T oneloop oneloop backup create …`
in the host's crontab. oneloop never deletes old backups, so delete them on
your own schedule.

### Test your backups

From time to time, restore a backup into a test folder and look around. Only
the account that runs oneloop can read the backup, so use a test folder that
this account can write to:

```sh
sudo -u oneloop env ONELOOP_DATA_DIR=/var/lib/oneloop/restore-test \
  /usr/local/bin/oneloop backup restore /var/backups/oneloop/2026-09-28
sudo -u oneloop env ONELOOP_DATA_DIR=/var/lib/oneloop/restore-test \
  ONELOOP_LISTEN=127.0.0.1:19220 ONELOOP_PUBLIC_URL=http://127.0.0.1:19220 \
  /usr/local/bin/oneloop serve
```

Sign in at `http://127.0.0.1:19220` and open a few tasks and files. Then stop
the test server with Ctrl+C, and delete the folder with
`sudo rm -rf /var/lib/oneloop/restore-test`.

## Restore

`oneloop backup restore` writes into the configured data directory. This
directory must be empty or not exist, so a restore never overwrites an
instance.

1. Stop oneloop.
2. Move the current data directory aside. Keep it until you are sure that the
   restore worked:
   ```sh
   mv /var/lib/oneloop/data /var/lib/oneloop/data.old
   ```
3. Restore the backup:
   ```sh
   oneloop backup restore /var/backups/oneloop/2026-09-28
   ```
4. If the backup comes from an older version, run
   `oneloop db migrate --backup-dir /var/backups/oneloop`.
5. Start oneloop.

With Docker, run `docker compose down`, and restore into a new volume:

```sh
docker volume create oneloop-restored
docker run --rm -v oneloop-restored:/data -v /srv/oneloop-backups:/backups:ro \
  ghcr.io/code19m/oneloop:0.1.0-rc.2 backup restore /backups/2026-09-28
```

In `compose.yaml`, change the volume's `name:` to `oneloop-restored`. If the
backup comes from an older version, migrate it as described in
[Upgrade](#upgrade). Then run `docker compose up -d`. Keep the old volume until
you are sure that the restore worked.

After a restore, everyone must sign in again and reconnect their AI assistants,
because oneloop cancels all sessions and connections from the backup.

If a restore stops halfway, oneloop refuses to use that directory. Run the same
restore again: it first removes what the stopped restore left, and nothing
else. If oneloop can't tell that the stopped restore has ended, for example
because it ran on another computer, the restore says so. Then make sure that no
restore is running, empty the directory completely, including hidden files, and
restore again.

## Upgrade

oneloop never changes its database by itself. After you install a new version,
you run `oneloop db migrate`. It first saves a verified backup in the folder
you choose, and it changes nothing if the backup fails.

1. Read the [changelog](changelog.md) for every version you are moving past.
2. Stop oneloop.
3. Install the new version:
   ```sh
   cargo install --git https://github.com/code19m/oneloop --tag v0.1.0-rc.2 --locked
   sudo install ~/.cargo/bin/oneloop /usr/local/bin/oneloop
   ```
4. Upgrade the database, and check the result. `db migrate` saves its backup
   in the backup folder from [Back up](#back-up):
   ```sh
   oneloop db migrate --backup-dir /var/backups/oneloop
   oneloop serve --check
   ```
5. Start oneloop.

With Docker, set up the backup folder as described in [Back up](#back-up), and
change the image tag in `compose.yaml`. Then run:

```sh
docker compose pull
docker compose stop
docker compose run --rm oneloop db migrate --backup-dir /backups
docker compose up -d
```

`db migrate` prints `database in <data folder> migrated from 2 to 5` and the
folder of its backup, or `database in <data folder> is current (schema 5)` if
there was nothing to do.

Browser tabs that were open during the upgrade show **oneloop was updated**.
Reloading the page loses unsaved text, so people can reload when they are ready.

### Choose a version

Stable versions look like `0.1.0`. Release candidates, such as `0.1.0-rc.2`,
let you try the next version early.

- The Docker tags `latest` and `0.1` follow stable versions only. A release
  candidate gets only its exact tag.
- In production, use an exact version, such as
  `ghcr.io/code19m/oneloop:0.1.0-rc.2` or `--tag v0.1.0-rc.2`.

<a id="databases-from-before-010"></a>

### Databases from before the first release candidate

If you ran oneloop from source before its first release candidate, upgrade the
same way. `db migrate` makes a backup and converts the old database in one step.
It prints something like `database in <data folder> migrated from 16 to 5`.
Until you do this, `oneloop serve` refuses to start.

## Roll back

Upgrades only go forward, and an older version refuses to open a newer database.
To go back, restore the backup that `db migrate` made:

1. Stop oneloop. Move the data directory aside, or create a new Docker volume.
2. Install the previous version, or set the previous image tag.
3. Restore the backup that `db migrate` printed. Its name looks like
   `oneloop-pre-migration-v2-1790000000`.
4. Start oneloop.

Changes made after the upgrade are not in that backup.
