# Running as a service

This page shows how to keep oneloop running in the background and start it at boot with systemd, launchd or Docker.

## systemd (Linux)

1. Create a system account with a private home, and install the binary where the unit expects it:
   ```sh
   sudo useradd --system --home-dir /var/lib/oneloop --shell /usr/sbin/nologin oneloop
   sudo install -d -m 0700 -o oneloop -g oneloop /var/lib/oneloop
   sudo install ~/.cargo/bin/oneloop /usr/local/bin/oneloop
   ```
2. Download the [unit template](https://github.com/code19m/oneloop/blob/main/deploy/systemd/oneloop.service.example) to `/etc/systemd/system/oneloop.service`. Set your `ONELOOP_PUBLIC_URL` and any other [settings](configuration.md). The template keeps data in `/var/lib/oneloop/data` and locks the service down with systemd's sandboxing options.
3. If this is a new instance, create the database and first admin as the service account:
   ```sh
   sudo -u oneloop env ONELOOP_DATA_DIR=/var/lib/oneloop/data /usr/local/bin/oneloop db migrate
   sudo -u oneloop env ONELOOP_DATA_DIR=/var/lib/oneloop/data /usr/local/bin/oneloop user add alice --admin
   ```
4. Start it now and at every boot:
   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now oneloop
   ```

Logs go to the journal: `journalctl -u oneloop -f`. If oneloop exits with an error, systemd restarts it after five seconds.

## launchd (macOS)

The [deploy/launchd](https://github.com/code19m/oneloop/tree/main/deploy/launchd) folder has three files:

- `com.oneloop.example.plist`: the job. Replace every `REPLACE_ME` and set your environment.
- `oneloop-launchd.sh`: a small launcher. Install it at `/usr/local/libexec/oneloop-launchd.sh`. It runs `oneloop serve --check` first. A configuration mistake then stops the job with a message in the log, instead of restarting it over and over. Other failures are retried at most once a minute.
- `oneloop.newsyslog.conf.example`: log rotation.

Save the job as `~/Library/LaunchAgents/com.oneloop.plist` and load it:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.oneloop.plist
```

After you edit the plist, run `launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.oneloop.plist`, then bootstrap it again.

Logs go to `~/Library/Logs/oneloop.log`. launchd doesn't rotate them. Rotate with `newsyslog -f` and the example file only while the job is booted out, because a running job keeps writing to the old file.

## Docker

The quick start's `compose.yaml` already does what you need:

```yaml
    restart: unless-stopped
    stop_grace_period: 35s
```

`restart: unless-stopped` brings oneloop back after a crash or a reboot, as long as the Docker service starts at boot. `stop_grace_period` gives oneloop time to finish open requests, which can take up to 30 seconds (see below); Docker's default of 10 seconds can cut off uploads. With `docker run`, use `--restart unless-stopped --stop-timeout 35`.

## Stopping gracefully

When oneloop receives `SIGTERM` or Ctrl-C, it stops accepting connections and gives open requests up to 30 seconds to finish, then logs `oneloop stopped`. Browsers reconnect by themselves once it's back, and connected AI assistants carry on with their next request. Nobody has to sign in again.

## Check that it worked

- `systemctl status oneloop`, `launchctl print "gui/$(id -u)/com.oneloop"` or `docker compose ps` shows the service running.
- The log contains `oneloop listening` with your address and data directory.
- `curl https://tasks.example.com/healthz` returns `"status":"ok"`.
