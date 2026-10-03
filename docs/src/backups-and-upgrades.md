# Backups and upgrades

This page shows how to back up and restore oneloop, how to upgrade it safely, and how to go back if an upgrade goes wrong.

Examples come in pairs. **From source** uses the data directory `/var/lib/oneloop/data`; run those commands as the account that runs oneloop, with the same environment. **Docker** uses the quick start's `compose.yaml`.

## Back up

A backup is a complete, verified copy of the database, attachments and avatars. oneloop keeps running while it's made; uploads may pause for a moment.

From source:

```sh
oneloop backup create /var/backups/oneloop/2026-09-28
```

Docker: first give the container a backup folder it can write to (it runs as UID 10001):

```sh
sudo install -d -m 0700 -o 10001 -g 10001 /srv/oneloop-backups
```

Add `- /srv/oneloop-backups:/backups` under the service's `volumes:` in `compose.yaml`, run `docker compose up -d`, then:

```sh
docker compose exec oneloop oneloop backup create /backups/2026-09-28
```

Keep in mind:

- The destination must not exist yet, its parent folder must exist, and it must be outside the data directory.
- Don't copy the data directory by hand while oneloop is running. The copy can be inconsistent.
- A backup holds password hashes and every private file. Keep it private, and encrypt copies you store elsewhere.
- oneloop never deletes old backups. Remove them on your own schedule.

To back up every night, schedule the command with cron or a systemd timer. For example, in the crontab of the account that runs oneloop:

```
0 2 * * * ONELOOP_DATA_DIR=/var/lib/oneloop/data /usr/local/bin/oneloop backup create /var/backups/oneloop/$(date -u +\%Y\%m\%dT\%H\%M\%SZ)
```

With Docker, use `docker compose -f /path/to/compose.yaml exec -T oneloop oneloop backup create …` in the host's crontab.

## Test a backup

Now and then, restore a backup next to your real instance and look around:

```sh
export TEST_DIR=$HOME/oneloop-restore-test
ONELOOP_DATA_DIR=$TEST_DIR oneloop backup restore /var/backups/oneloop/2026-09-28
ONELOOP_DATA_DIR=$TEST_DIR ONELOOP_LISTEN=127.0.0.1:19220 \
  ONELOOP_PUBLIC_URL=http://127.0.0.1:19220 oneloop serve
```

Sign in at `http://127.0.0.1:19220`, open a few tasks and attachments, then stop it and delete the folder.

## Restore

`oneloop backup restore` writes into the configured data directory, which must be empty or not exist yet. It never overwrites an instance.

1. Stop oneloop.
2. Move the current data directory aside. Keep it until you're sure the restore is good:
   ```sh
   mv /var/lib/oneloop/data /var/lib/oneloop/data.old
   ```
3. Restore:
   ```sh
   oneloop backup restore /var/backups/oneloop/2026-09-28
   ```
4. If the backup came from an older version, run `oneloop db migrate --backup-dir /var/backups/oneloop`.
5. Start oneloop.

With Docker, run `docker compose down`, then restore into a new volume:

```sh
docker volume create oneloop-restored
docker run --rm -v oneloop-restored:/data -v /srv/oneloop-backups:/backups:ro \
  ghcr.io/code19m/oneloop:0.1.0-rc.1 backup restore /backups/2026-09-28
```

In `compose.yaml`, change the volume's `name:` to `oneloop-restored`. If the backup came from an older version, run the `db migrate` step from [Upgrade](#upgrade). Then run `docker compose up -d`, and keep the old volume until you're sure.

After a restore, everyone signs in again and reconnects their AI assistants. oneloop revokes every session and app connection stored in the backup.

If a restore is interrupted, oneloop refuses to use that directory. Empty it completely, including hidden files, and restore again.

## Choose a version

Stable releases look like `0.1.0`. Release candidates, like `0.1.0-rc.1`, let you try the next version early.

- From source, install the release's tag, such as `--tag v0.1.0` or `--tag v0.1.0-rc.1`.
- The Docker tags `latest` and `0.1` follow stable releases only. Release candidates get only their exact tag.
- In production, pin an exact version, such as `ghcr.io/code19m/oneloop:0.1.0`.

## Upgrade

oneloop never changes its database on startup. After installing a new version, you run `oneloop db migrate`. It first saves a verified backup in the folder you give it, and changes nothing if that backup fails.

1. Read the [changelog](changelog.md) for every version you're moving past.
2. Stop oneloop.
3. Install the new version:
   ```sh
   cargo install --git https://github.com/code19m/oneloop --tag v0.1.0 --locked
   sudo install ~/.cargo/bin/oneloop /usr/local/bin/oneloop
   ```
4. Migrate, then check:
   ```sh
   oneloop db migrate --backup-dir /var/backups/oneloop
   oneloop serve --check
   ```
5. Start oneloop.

With Docker, set up the backup folder from [Back up](#back-up), change the image tag in `compose.yaml`, then:

```sh
docker compose pull
docker compose stop
docker compose run --rm oneloop db migrate --backup-dir /backups
docker compose up -d
```

### Check that it worked

- `db migrate` prints `database migrated from 1 to 2` and the path of its backup, or `database schema 2 is current` if there was nothing to do.
- `curl https://tasks.example.com/healthz` shows the new `version`.
- You can sign in, open tasks and download an attachment.

Tabs that were open during the upgrade show **oneloop was updated** with a **Reload** button. People reload when they're ready; reloading discards anything they haven't saved.

### Databases from before 0.1.0

If you ran oneloop from source before its first release candidate, upgrade the same way, with `--backup-dir`. `db migrate` recognizes the older database, backs it up, and converts it to the released schema in one step, so it prints something like `database migrated from 16 to 1`. Until you do, `oneloop serve` refuses to start and asks you to run `db migrate`.

## Roll back

Migrations only go forward, and an older version refuses to open a newer database. To go back, restore the backup that `db migrate` made:

1. Stop oneloop and move the data directory aside, or create a new Docker volume.
2. Reinstall the previous version, or set the previous image tag.
3. Restore the backup `db migrate` printed. Its name looks like `oneloop-pre-migration-v1-1790000000`.
4. Start oneloop.

Changes made after the upgrade are not in that backup.
