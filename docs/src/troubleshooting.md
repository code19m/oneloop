# Troubleshooting

## Health check

```sh
curl --fail --max-time 5 https://tasks.example.com/healthz
```

```json
{"status":"ok","version":"0.1.0-rc.2","revision":"…","schemaVersion":5}
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
| `legacy pre-release database requires the baseline conversion` | The database is from before the first release candidate. | Follow [the upgrade steps](backups-and-upgrades.md#databases-from-before-010). |
| `database schema … is newer than this binary supports` | An older version runs with an upgraded database. | Install the newer version again, or [roll back](backups-and-upgrades.md#roll-back). |
| `another oneloop server or command is using …` | `db migrate` needs the data directory to itself, but the server or another `oneloop` command, such as a backup, uses it. | Stop the server, wait for other `oneloop` commands to finish, and try again. |
| `another oneloop server is already using …` | A second server started with the same data directory. | Run only one server for each data directory. |
| `incomplete restore at …` | A restore stopped halfway. | Run the same `oneloop backup restore` again. See [Restore](backups-and-upgrades.md#restore). |
| Permission errors for files in the data directory | The files belong to another account, often after a command ran as root. | Give them back to the service account with `chown -R`. For Docker bind mounts, the owner is user 10001. |
| "Open oneloop at its configured address" or "This address is not configured for sign-in" | The address in the browser, or the `Host` header, doesn't match `ONELOOP_PUBLIC_URL`. `localhost` and `127.0.0.1` count as different addresses. | Open the exact configured address. Make the proxy pass `Host` unchanged, with the port. |
| People see "Too many attempts" when they sign in | A [sign-in limit](reference.md#limits) was reached. People can share an address even with correct forwarding. | Wait for the delay. If the log says `ignoring X-Forwarded-For from an untrusted peer`, set [`ONELOOP_TRUSTED_PROXIES`](production.md#trusted-proxy). |
| Changes appear only after reloading | The proxy buffers the live-update stream. | Turn off buffering for `/api/events`. |
| The app gets slow with many open tabs | The browser reaches the proxy over HTTP/1.1, which allows only six connections to a site. | Turn on HTTP/2 in the proxy. |
| Large uploads fail with HTTP 413 | The proxy's limit for request bodies is too small. | Allow at least 27 MB (in nginx, `client_max_body_size 27m`). |
| Uploads fail with "There is not enough storage for this file", and the **Storage** page shows **Storage full** or **Cleanup threshold reached** | The upload doesn't fit in the [storage limit](reference.md#storage). | Choose **Clean up now**, delete files, or raise `ONELOOP_STORAGE_LIMIT`. |
| Uploads fail with "There is not enough storage for this file", and the **Storage** page shows **Within capacity** | The server's disk is nearly full: the upload would leave less free disk space than `ONELOOP_DISK_MIN_FREE`. | Free disk space on the server, or lower `ONELOOP_DISK_MIN_FREE`. |
| An admin forgot their password | No other admin can reset it. | Run `oneloop user passwd <username>` on the server. |

## Knowledge sync

When a sync fails, the project's **Settings** shows the reason under
**Knowledge base**, and the log has a `knowledge sync failed` line with Git's
own message. People keep reading the last synced files.

| Settings shows | What to do |
| --- | --- |
| The server can't run Git 2.31 or later, or SSH. | Install Git 2.31 or later and an OpenSSH client. The Docker image has both. |
| The repository refused the access token or deploy key. | Check that the token is still valid and can read the repository, or that the deploy key is added to it. To change the token, use **Manage connection**. |
| The repository wasn't found, or the credentials can't read it. | Check the URL. Many hosts answer "not found" when the credentials can't read a private repository. |
| The repository moved to another address. Use its new URL. | Enter the new URL with **Manage connection**. If it's on another host, also enter a token for that host. |
| The branch wasn't found in the repository. | Check the branch name, including its letter case. |
| The folder wasn't found on the branch. | Check the folder. It starts at the repository root, and letter case matters. |
| The repository host couldn't be reached. | Check DNS and firewalls from the server. Behind a proxy, see [Knowledge base connections](production.md#knowledge-base-connections). |
| The server doesn't trust the host's HTTPS certificate. | For a private certificate authority, set `GIT_SSL_CAINFO` for the oneloop service; see [Knowledge base connections](production.md#knowledge-base-connections). |
| The host's SSH key changed since the first sync. | Ask the host's admin whether the key really changed. If it did, delete the host's line from `keys/knowledge_known_hosts` in the data directory; the next sync trusts the new key. |
| The folder is too large to sync. Choose a smaller folder or remove large files. | Choose a smaller folder, or move large files out of it. Files left out for their size still count toward a sync's disk use; see [Limits](reference.md#limits). |
| The sync took too long. | Check the connection to the host, then choose **Retry sync**. |
| The server is low on disk space. | Free some disk space; see [Limits](reference.md#limits) for what a sync needs. |
| The saved credentials can't be read. Enter them again. | `keys/knowledge.key` is missing or was replaced, for example when a database was copied without its `keys` folder. Replace the token, or disconnect and connect again for a new deploy key. |
| The sync failed. The server log has details. | Read the `knowledge sync failed` line in the log. |
