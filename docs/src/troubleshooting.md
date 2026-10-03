# Monitoring and troubleshooting

This page shows how to check that oneloop is healthy, where to find its logs, and how to fix the problems operators run into most.

## Health check

```sh
curl --fail --max-time 5 https://tasks.example.com/healthz
```

```json
{"status":"ok","version":"0.1.0-rc.1","revision":"…","schemaVersion":1}
```

`/healthz` needs no sign-in and returns HTTP 200 when the server is up and its database answers. Checking through the public address tests your proxy too. An install from source also answers at `http://127.0.0.1:8080/healthz` on the server itself. The check doesn't cover backups, attachments or live updates.

## Logs

| Setup | Where |
| --- | --- |
| systemd | `journalctl -u oneloop` |
| Docker | `docker compose logs oneloop` |
| launchd | `~/Library/Logs/oneloop.log` |

Lines to know:

- `oneloop listening`: the server started. Shows the version, address and data directory.
- `oneloop stopped`: it shut down cleanly.
- `application request failed` comes with a `reference`. When someone sees "The request could not be completed. Reference: …", search the logs for that reference.

For more detail, set `ONELOOP_LOG_LEVEL=debug` and restart. Logs contain usernames, IP addresses and file paths, so keep them private.

## What to alert on

- `/healthz` fails or times out.
- The service keeps restarting.
- The nightly backup exits with an error.
- The data volume runs low on disk space, or the **Storage** page shows **Cleanup threshold reached** or **Storage full**.

## Common problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| `invalid configuration: …` at startup | A variable is missing, misspelled or has a bad value. Unknown `ONELOOP_` names are rejected too. | Correct it using [Configuration](configuration.md), then run `oneloop serve --check`. |
| `HTTP is allowed only for loopback development addresses` | `ONELOOP_PUBLIC_URL` uses `http://` with a real host name or LAN address. | Put HTTPS in front: [HTTPS and reverse proxy](reverse-proxy.md). |
| `database is not initialized …` | New instance, or `ONELOOP_DATA_DIR` points at the wrong folder. | Check the path, then run `oneloop db migrate`. |
| `database schema … requires migration` | You installed a new version but didn't migrate. | Follow [Upgrade](backups-and-upgrades.md#upgrade). |
| `legacy pre-release database requires the baseline conversion` | The database was created before 0.1.0. | Follow [Databases from before 0.1.0](backups-and-upgrades.md#databases-from-before-010). |
| `database schema … is newer than this binary supports` | An older version is running against a migrated database. | Install the newer version again, or [roll back](backups-and-upgrades.md#roll-back). |
| `stop the oneloop server first` | `db migrate` needs the server stopped. | Stop the service and retry. |
| `another oneloop server is already using …` | A second server was started on the same data directory. | Run one server per data directory. |
| `incomplete restore at …` | A restore was interrupted. | Empty the directory, including hidden files, and restore again. |
| Permission errors on files in the data directory | The files belong to another account, often after running a command as root. | Give them back to the service account (`chown -R`). For Docker bind mounts, UID 10001. |
| The browser shows "Open oneloop at its configured address" or "This address is not configured for sign-in" | The address or `Host` header doesn't match `ONELOOP_PUBLIC_URL`. `localhost` and `127.0.0.1` count as different. | Open the exact configured address. Make the proxy pass `Host` unchanged, with any port. |
| Many people see "Too many attempts" at sign-in | oneloop doesn't trust the proxy, so all visitors share its address. The log says `ignoring X-Forwarded-For from an untrusted peer`. | Set [`ONELOOP_TRUSTED_PROXIES`](reverse-proxy.md#trusted-proxy). |
| Changes appear only after a refresh | The proxy buffers the live-update stream. | Turn buffering off for `/api/events`. |
| The app stalls when many tabs are open | The browser reaches the proxy over HTTP/1.1, which allows only six connections per site. | Enable HTTP/2 on the proxy. |
| Larger uploads fail with HTTP 413 | The proxy's request size limit is too small. | Allow at least 27 MB (nginx: `client_max_body_size 27m`). |
| Uploads fail with "There is not enough storage for this file" | The storage limit is reached, or free disk space is below `ONELOOP_DISK_MIN_FREE`. | Clean up temporary files on the **Storage** page, delete attachments, or raise the limit. |
| An admin forgot their password | No other admin can reset it. | Run `oneloop user passwd <username>` on the server. |
