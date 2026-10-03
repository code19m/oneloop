# Production setup

Before your team uses oneloop, set up three things:

1. **HTTPS**, with a reverse proxy such as Caddy or nginx in front of oneloop.
2. **A service** that starts oneloop at boot and restarts it after a crash.
3. **Nightly backups**, as described in [Backups and upgrades](backups-and-upgrades.md).

## HTTPS with a reverse proxy

oneloop serves plain HTTP and leaves certificates to the proxy. It accepts an
`http://` address only for `localhost`, because passwords and sign-in cookies
must never cross a network unencrypted.

1. Point a DNS name, such as `tasks.example.com`, to your server.
2. Set these variables for oneloop, then restart it:

   | Variable | Value |
   | --- | --- |
   | `ONELOOP_PUBLIC_URL` | `https://tasks.example.com`, the exact address people open |
   | `ONELOOP_TRUSTED_PROXIES` | The address of the proxy; see [Trusted proxy](#trusted-proxy) |

   With Docker, change them under `environment:` in `compose.yaml`, then run
   `docker compose up -d`.
3. Set up the proxy, as shown below for Caddy and nginx.
4. Open the new address and sign in again.

Keep oneloop itself reachable only at `127.0.0.1:8080`, as the default settings
and the Docker example do. Then the proxy is the only way in.

### Caddy

Caddy gets and renews certificates for you:

```caddyfile
tasks.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

No public domain? On a local network, use a name such as `tasks.home.arpa` in
your local DNS, and add `tls internal` inside the block. Then install
[Caddy's local certificate authority](https://caddyserver.com/docs/automatic-https#local-https)
on each device.

### nginx

This example is also in the repository as
[`deploy/nginx/oneloop.conf.example`](https://github.com/code19m/oneloop/blob/main/deploy/nginx/oneloop.conf.example):

```nginx
{{#include ../../deploy/nginx/oneloop.conf.example}}
```

### Trusted proxy

oneloop uses each visitor's IP address to slow down repeated failed sign-ins,
and to show where people are signed in. Behind a proxy, all requests seem to
come from the proxy. `ONELOOP_TRUSTED_PROXIES` names your proxy, so oneloop can
read the visitor's real address from the `X-Forwarded-For` header. Without it,
all visitors share one sign-in limit, and oneloop logs a warning at startup.

| oneloop runs | The proxy runs | Set `ONELOOP_TRUSTED_PROXIES` to |
| --- | --- | --- |
| From source | On the same machine | `127.0.0.1` |
| In Docker, with the example `compose.yaml` | On the host | The gateway of the Docker network, from the command below |
| Anywhere | On another machine | The IP address of that machine |

```sh
docker network inspect oneloop_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Separate several addresses or CIDR ranges with commas. List only real proxies,
never a network that visitors use. The proxy must replace `X-Forwarded-For`,
not add to it. oneloop ignores `Forwarded`, `X-Real-IP` and
`X-Forwarded-Proto`.

### Rules for any proxy

- Serve oneloop at the root of its own host name. A path such as `/oneloop/`
  doesn't work.
- Pass the `Host` header unchanged, with the port if there is one.
- Don't add or change `Content-Security-Policy` or other security headers.
  oneloop sets its own, including HSTS.
- Use HTTP/2 to browsers. With HTTP/1.1, a browser opens only six connections
  to a site, and every open tab uses one for live updates.
- Don't buffer or time out `/api/events`. This live-update stream stays open as
  long as the tab.
- Allow request bodies of at least 27 MB, for file uploads.

To test the proxy, open oneloop in two tabs and change a task in one. The change
should appear in the other tab without reloading.

## Start at boot

### Docker

The example `compose.yaml` is already set up:

- `restart: unless-stopped` starts oneloop again after a crash or a reboot, if
  Docker itself starts at boot.
- `stop_grace_period: 35s` gives oneloop time to finish open requests when it
  stops. Docker's default of 10 seconds can cut off uploads.

With `docker run`, use `--restart unless-stopped --stop-timeout 35`.

### systemd (Linux)

1. Create a system account and install the binary:

   ```sh
   sudo useradd --system --home-dir /var/lib/oneloop --shell /usr/sbin/nologin oneloop
   sudo install -d -m 0700 -o oneloop -g oneloop /var/lib/oneloop
   sudo install ~/.cargo/bin/oneloop /usr/local/bin/oneloop
   ```

2. Save the
   [unit file](https://github.com/code19m/oneloop/blob/main/deploy/systemd/oneloop.service.example)
   as `/etc/systemd/system/oneloop.service`. Set your `ONELOOP_PUBLIC_URL` and
   any other [settings](reference.md#configuration) in it. The unit keeps data
   in `/var/lib/oneloop/data` and uses systemd's sandbox options.

3. For a new instance, create the database and the first admin as the service
   account:

   ```sh
   sudo -u oneloop env ONELOOP_DATA_DIR=/var/lib/oneloop/data /usr/local/bin/oneloop db migrate
   sudo -u oneloop env ONELOOP_DATA_DIR=/var/lib/oneloop/data /usr/local/bin/oneloop user add alice --admin
   ```

4. Start oneloop now and at every boot:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now oneloop
   ```

Logs go to the journal; read them with `journalctl -u oneloop -f`. If oneloop
fails, systemd restarts it after five seconds.

### launchd (macOS)

The [deploy/launchd](https://github.com/code19m/oneloop/tree/main/deploy/launchd)
folder has three files:

- `com.oneloop.example.plist` is the job. Replace every `REPLACE_ME`, set your
  environment, and save it as `~/Library/LaunchAgents/com.oneloop.plist`.
- `oneloop-launchd.sh` starts oneloop. Install it as
  `/usr/local/libexec/oneloop-launchd.sh`. It runs `oneloop serve --check`
  first, so a configuration mistake stops the job with a message in the log,
  instead of restarting it again and again.
- `oneloop.newsyslog.conf.example` rotates the log.

Load the job:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.oneloop.plist
```

After you change the plist, unload the job with
`launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.oneloop.plist` and
load it again.

The log is `~/Library/Logs/oneloop.log`. launchd doesn't rotate it. Rotate it
with `newsyslog -f` and the example file, but only while the job is unloaded,
because a running job keeps writing to the old file.

### Stopping and restarting

When oneloop gets `SIGTERM` or Ctrl+C, it stops taking new connections and
gives open requests up to 30 seconds to finish. When it is back, browsers
reconnect by themselves. Nobody has to sign in again.

## Security checklist

- Serve oneloop only over HTTPS, and keep the redirect from HTTP to HTTPS.
  Browsers learn oneloop's HSTS rule only on their first HTTPS visit.
- Let only the proxy reach port 8080. A direct connection skips HTTPS.
- Set `ONELOOP_TRUSTED_PROXIES` to your proxy's address, and nothing else.
- Keep oneloop's security headers. They protect sign-in and isolate uploaded
  files.
- Run oneloop under its own system account, and run maintenance commands as
  that account. The data directory holds password hashes, private files and
  signing keys. oneloop makes it readable only by its owner, and it warns at
  startup if others can read it.
- Keep backups and logs private. Backups contain everything, and logs contain
  usernames and IP addresses.
- Install new releases, because security fixes come in new versions.
- `/healthz` is public and shows the version. If you want, allow it only from
  your monitoring network; the nginx example shows how.

oneloop also protects you by itself:

- Its sign-in cookie works only over HTTPS and only for your exact host name.
- It answers only requests for its own host name, and accepts changes only from
  its own pages.
- It slows down repeated failed sign-ins, for each account and each address.
- It never runs uploaded files on the server. Downloads are always saved as
  files, HTML previews run in a sandbox, and Markdown is cleaned before display.

Report security problems privately, as described in
[SECURITY.md](https://github.com/code19m/oneloop/blob/main/SECURITY.md).
