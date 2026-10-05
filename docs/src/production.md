# Production setup

Before your team uses oneloop, set up three things:

1. **HTTPS**, with a reverse proxy such as Caddy or nginx in front of oneloop.
2. **A service** that starts oneloop automatically and restarts it after a crash.
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
- Reach oneloop itself over HTTP/1.1. It doesn't accept HTTP/2 without TLS
  (h2c).
- Don't buffer or time out `/api/events`. This live-update stream stays open as
  long as the tab.
- Allow request bodies of at least 27 MB, for file uploads.

To test the proxy, open oneloop in two tabs and change a task in one. The change
should appear in the other tab without reloading.

<a id="start-at-boot"></a>

## Start automatically

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
fails, systemd restarts it after five seconds. Invalid settings (exit code 2)
stop the service instead, because a restart can't fix them. Fix the unit file,
then run `sudo systemctl daemon-reload` and `sudo systemctl restart oneloop`.

### launchd (macOS)

This LaunchAgent runs while you are signed in to macOS. It starts at login and
stops at logout. To run before login, use a LaunchDaemon in the system domain.

Complete the [source install](install.md#from-source), including the database
and first admin, then stop the manually started server. The template uses
`~/.cargo/bin/oneloop`, your home as its working directory, and `~/oneloop-data`.
If you chose other locations, use absolute paths to your installed binary,
an existing working directory and the initialized data directory.

Create the job and log folders:

```sh
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
```

The [deploy/launchd](https://github.com/code19m/oneloop/tree/main/deploy/launchd)
folder has three files to download:

- `com.oneloop.example.plist` is the job. Replace every `REPLACE_ME`, set your
  environment, and save it as `~/Library/LaunchAgents/com.oneloop.plist`.
- `oneloop-launchd.sh` starts oneloop. It runs `oneloop serve --check` first.
  If the binary is missing, a setting is invalid or the data folder has no
  database, it stops the job and writes the reason to the log, because a
  restart can't help. After other failures, launchd starts oneloop again, at
  most once a minute.
- `oneloop.newsyslog.conf.example` rotates the log. Replace `REPLACE_ME` and
  save it as `~/oneloop.newsyslog.conf`.

From the folder where you saved the launcher, install it and load the job:

```sh
sudo install -d /usr/local/libexec
sudo install -m 0755 oneloop-launchd.sh /usr/local/libexec/oneloop-launchd.sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.oneloop.plist
```

After you change the plist, or after the job stopped because of a mistake,
unload the job with
`launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.oneloop.plist` and
load it again.

The log is `~/Library/Logs/oneloop.log`. launchd doesn't rotate it. Rotate it
only while the job is unloaded, because a running job keeps writing to the old
file:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.oneloop.plist
newsyslog -r -f ~/oneloop.newsyslog.conf
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.oneloop.plist
```

`-r` lets newsyslog run without root. It rotates the log when it is larger than
10 MiB, and it keeps seven old logs.

### Stopping and restarting

When oneloop gets `SIGTERM` or Ctrl+C, it stops taking new connections and
gives open requests up to 30 seconds to finish. When it is back, browsers
reconnect by themselves. Nobody has to sign in again.

## Knowledge base connections

To sync [knowledge bases](admin-guide.md#knowledge-base), oneloop runs `git`
2.31 or later, and `ssh` for SSH URLs. The Docker image includes both. On other
servers, install them, for example with `apt install git openssh-client`.

- **Network.** The server needs outgoing HTTPS, or SSH on port 22 or the port in
  the URL, to your Git hosts. oneloop passes `HTTPS_PROXY`, `HTTP_PROXY`,
  `ALL_PROXY` and `NO_PROXY` to Git.
- **Private certificate authorities.** Set `GIT_SSL_CAINFO` (a file) or
  `GIT_SSL_CAPATH` (a folder) for the oneloop service. oneloop also passes
  `SSL_CERT_FILE` and `SSL_CERT_DIR`.
- **Isolation.** Git runs with an empty configuration of its own: it ignores
  the server's Git settings, credential helpers and hooks, never asks for a
  password, and speaks only HTTPS and SSH.
- **Credentials.** Access tokens and deploy keys are encrypted with
  `keys/knowledge.key` in the data directory, which backups include.
- **SSH host keys.** oneloop trusts a host's key on the first connection and
  keeps it in `keys/knowledge_known_hosts`.

The example systemd unit already allows this. With your own sandbox, allow the
service to run `git` and `ssh` and to open outgoing connections.

## AI assistant connections

By default, an AI assistant registers itself when it connects, and its sign-in
callback must be on its own computer (`localhost`, `127.0.0.1` or `[::1]`) or
use `https://`. Three settings, all off by default, let more clients connect.
Turn on only what your clients need.

- **App callbacks.** Some desktop apps receive the sign-in through a link of
  their own, such as `cursor://…`. List those schemes in
  `ONELOOP_MCP_REDIRECT_SCHEMES`, for example `cursor`. Any app on a computer
  can claim a scheme, but a code it catches is useless without the secret that
  only the app that started the sign-in holds (PKCE). The **Connect** page shows
  the whole callback address.
- **Browser clients.** Tools that run in a web page, such as MCP Inspector, call
  oneloop from another site. List their exact origins in
  `ONELOOP_MCP_ALLOWED_ORIGINS`, for example `http://localhost:6274`. Only these
  pages may register an app and call `/mcp` from a browser. Any site may read
  oneloop's OAuth metadata and use its token and revocation endpoints, because
  they use no cookies, and a request needs a code or token that the site
  doesn't have.
- **Client metadata documents.** With
  `ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS=true`, an assistant may use an HTTPS
  address as its client ID. oneloop then fetches the document at that address
  for the app's name and callbacks, and the **Connect** page shows the
  document's host. A fetch happens only for someone who is signed in. To
  protect your network, oneloop fetches only `https` addresses with a path, on
  the default port, and only when every address the host name resolves to is
  public; never a private, loopback, link-local or other special address. It
  connects to an address it checked, follows no redirects, and reads at most
  5 KiB within 5 seconds. It keeps a document as long as its `Cache-Control`
  header says, from 1 to 60 minutes (10 minutes if it doesn't say), and fetches
  at most 30 documents a minute. The server needs outgoing HTTPS for this.
  oneloop connects directly, without a proxy, and trusts the system's
  certificate authorities, which the Docker image includes. It refuses to start
  with this setting if it finds none. Turning the setting off stops new
  connections this way; apps that are already connected keep working until
  someone disconnects them.

## Security checklist

- Serve oneloop only over HTTPS, and keep the redirect from HTTP to HTTPS.
  Browsers learn oneloop's HSTS rule only on their first HTTPS visit.
- Let only the proxy reach port 8080. A direct connection skips HTTPS.
- Set `ONELOOP_TRUSTED_PROXIES` to your proxy's address, and nothing else.
- Keep oneloop's security headers. They protect sign-in and isolate uploaded
  files.
- Run oneloop under its own system account, and run maintenance commands as
  that account. The data directory holds password hashes, private files,
  and `keys/knowledge.key`, which encrypts Knowledge credentials. oneloop makes
  it readable only by its owner, and it warns at startup if others can read it.
- Keep backups and logs private. Backups contain everything, and logs contain
  usernames and IP addresses.
- Install new releases, because security fixes come in new versions.
- Turn on the [AI assistant connection](#ai-assistant-connections) settings
  only for clients that need them.
- `/healthz` is public and shows the version. If you want, allow it only from
  your monitoring network; the nginx example shows how.

oneloop also protects you by itself:

- Its sign-in cookie works only over HTTPS and only for your exact host name.
- It answers only requests for its own host name, and accepts changes only from
  its own pages.
- It slows down repeated failed sign-ins, for each account and each address.
- It never runs uploaded or synced files on the server. Downloads are always
  saved as files, HTML previews run in a sandbox, and Markdown is cleaned
  before display.

Report security problems privately, as described in
[SECURITY.md](https://github.com/code19m/oneloop/blob/main/SECURITY.md).
