# Troubleshooting

## Health check

```sh
curl --fail --max-time 5 https://tasks.example.com/healthz
```

```json
{"status":"ok","version":"0.1.0-rc.1","revision":"…","schemaVersion":1}
```

`/healthz` needs no sign-in. It returns HTTP 200 when the server is up and its
database answers. If you check it through the public address, you also test the
proxy. It doesn't check backups, files or live updates.

Set up alerts for these cases:

- `/healthz` fails or times out.
- The service keeps restarting.
- The nightly backup fails.
- The disk is almost full, or the **Storage** page shows
  **Cleanup threshold reached** or **Storage full**.

## Logs

| Setup | Logs |
| --- | --- |
| Docker | `docker compose logs oneloop` |
| systemd | `journalctl -u oneloop` |
| launchd | `~/Library/Logs/oneloop.log` |

- `oneloop listening` means that the server started. The line shows the
  version, the address and the data directory.
- `oneloop stopped` means that it shut down cleanly.
- When someone sees "The request could not be completed. Reference: …", search
  the logs for that reference.

For more detail, set `ONELOOP_LOG_LEVEL=debug` and restart oneloop. Logs contain
usernames, IP addresses and file paths, so keep them private.

## Common problems

| Problem | Cause | Solution |
| --- | --- | --- |
| `invalid configuration: …` at startup | A variable is missing, misspelled or has a wrong value. Unknown `ONELOOP_` names count as mistakes too. | Fix it using the [configuration reference](reference.md#configuration), then run `oneloop serve --check`. |
| `HTTP is allowed only for loopback development addresses` | `ONELOOP_PUBLIC_URL` uses `http://` with a real host name or network address. | Set up [HTTPS](production.md#https-with-a-reverse-proxy). |
| `database is not initialized …` | This is a new instance, or `ONELOOP_DATA_DIR` points to the wrong folder. | Check the folder, then run `oneloop db migrate`. |
| `database schema … requires migration` | A new version is installed, but the database isn't upgraded yet. | Follow [Upgrade](backups-and-upgrades.md#upgrade). |
| `legacy pre-release database requires the baseline conversion` | The database is from before 0.1.0. | Follow [Databases from before 0.1.0](backups-and-upgrades.md#databases-from-before-010). |
| `database schema … is newer than this binary supports` | An older version runs with an upgraded database. | Install the newer version again, or [roll back](backups-and-upgrades.md#roll-back). |
| `stop the oneloop server first` | `db migrate` can't upgrade while the server runs. | Stop the server and try again. |
| `another oneloop server is already using …` | A second server started with the same data directory. | Run only one server for each data directory. |
| `incomplete restore at …` | A restore stopped halfway. | Empty the directory, including hidden files, and restore again. |
| Permission errors for files in the data directory | The files belong to another account, often after a command ran as root. | Give them back to the service account with `chown -R`. For Docker bind mounts, the owner is user 10001. |
| "Open oneloop at its configured address" or "This address is not configured for sign-in" | The address in the browser, or the `Host` header, doesn't match `ONELOOP_PUBLIC_URL`. `localhost` and `127.0.0.1` count as different addresses. | Open the exact configured address. Make the proxy pass `Host` unchanged, with the port. |
| Many people see "Too many attempts" when they sign in | oneloop doesn't trust the proxy, so all visitors share its address. The log says `ignoring X-Forwarded-For from an untrusted peer`. | Set [`ONELOOP_TRUSTED_PROXIES`](production.md#trusted-proxy). |
| Changes appear only after reloading | The proxy buffers the live-update stream. | Turn off buffering for `/api/events`. |
| The app gets slow with many open tabs | The browser reaches the proxy over HTTP/1.1, which allows only six connections to a site. | Turn on HTTP/2 in the proxy. |
| Large uploads fail with HTTP 413 | The proxy's limit for request bodies is too small. | Allow at least 27 MB (in nginx, `client_max_body_size 27m`). |
| Uploads fail with "There is not enough storage for this file" | The storage limit is reached, or free disk space is below `ONELOOP_DISK_MIN_FREE`. | On the **Storage** page, clean up temporary files. Or delete files, or raise the limit. |
| An admin forgot their password | No other admin can reset it. | Run `oneloop user passwd <username>` on the server. |
