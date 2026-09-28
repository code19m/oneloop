# Configuration

This page shows how to configure oneloop with environment variables, with ready-made settings for common setups and a table of every option.

## Minimal example

Only one variable is required: the address people open in their browser.

```sh
export ONELOOP_PUBLIC_URL=https://tasks.example.com
export ONELOOP_DATA_DIR=/var/lib/oneloop/data
oneloop serve --check
oneloop serve
```

`ONELOOP_DATA_DIR` has a default, but an absolute path means your data doesn't depend on the folder you start oneloop from.

## How configuration works

- oneloop reads only environment variables. There is no configuration file, and it doesn't load `.env` files by itself. Your service manager or Docker can load an environment file for it.
- Settings are read at startup. Restart oneloop after changing them.
- oneloop refuses to start if a value is invalid, or if it finds an unknown variable starting with `ONELOOP_`. A typo can't go unnoticed.
- `oneloop serve --check` validates the configuration, and the database if one exists, then exits without starting the server. Run it after every change.
- The maintenance commands (`db migrate`, `backup` and `user`) only read `ONELOOP_DATA_DIR`. Still, run them as the same system account and with the same environment as the server.

## Common setups

### Docker

The image already sets `ONELOOP_DATA_DIR=/data` and `ONELOOP_LISTEN=0.0.0.0:8080`. Leave those alone and set the rest under `environment:` in the quick start's `compose.yaml`:

```yaml
services:
  oneloop:
    environment:
      ONELOOP_PUBLIC_URL: https://tasks.example.com
      ONELOOP_TIMEZONE: Europe/Berlin
      ONELOOP_TRUSTED_PROXIES: 172.18.0.1 # your Compose network's gateway
```

Run `docker compose up -d` to apply the change. With `docker run`, pass the same variables with `-e` or `--env-file`. Keep the port published on `127.0.0.1` only, so the one way in is through your HTTPS proxy. [Trusted proxy](reverse-proxy.md#trusted-proxy) shows how to find the gateway address.

### Behind nginx or Caddy on the same machine

```sh
ONELOOP_PUBLIC_URL=https://tasks.example.com
ONELOOP_LISTEN=127.0.0.1:8080
ONELOOP_TRUSTED_PROXIES=127.0.0.1
```

The proxy handles HTTPS and forwards requests to `127.0.0.1:8080`. [HTTPS and reverse proxy](reverse-proxy.md) has complete nginx and Caddy examples and explains why the proxy must be trusted.

### A different port

`ONELOOP_LISTEN` is the internal address the proxy connects to. `ONELOOP_PUBLIC_URL` is what people type. They are independent:

```sh
ONELOOP_LISTEN=127.0.0.1:9000
ONELOOP_PUBLIC_URL=https://tasks.example.com:8443
```

If the public address uses a non-standard port, include it in `ONELOOP_PUBLIC_URL`, and make sure the proxy passes the `Host` header with the port. oneloop must live at the root of its host name, so `https://example.com/oneloop` doesn't work. Use a subdomain instead.

### Your team's timezone

```sh
ONELOOP_TIMEZONE=Asia/Tashkent
```

One timezone applies to the whole instance. It decides when a deadline day ends, where Today sits on the Roadmap, and how dates and times are shown to everyone. Use an IANA name such as `Europe/Berlin` or `America/New_York`. oneloop includes its own timezone database, so the server's clock settings and a container's `TZ` variable have no effect.

`oneloop serve --check` prints the version of that database, such as `2025b`. If your region changed its clock rules after that version, times can be an hour off until a oneloop release brings newer data. Meanwhile, you can set a fixed offset such as `Etc/GMT+7`, which means UTC−07 (the sign is inverted), and switch back after upgrading.

### Trying it on your own computer

```sh
ONELOOP_PUBLIC_URL=http://localhost:8080
```

Plain HTTP works only for `localhost`, `127.0.0.1` and `[::1]`. Open exactly the configured address: to a browser, `localhost` and `127.0.0.1` are different sites. To try oneloop from other machines on your network, you need HTTPS; see [HTTPS and reverse proxy](reverse-proxy.md).

### Attachment storage

```sh
ONELOOP_STORAGE_LIMIT=50GiB
ONELOOP_DISK_MIN_FREE=5GiB
```

The storage limit covers uploaded files (attachments and avatars), their previews and uploads in progress. The database doesn't count toward it. When usage reaches 80% of the limit, oneloop removes temporary attachments that nobody has used for 24 hours, until usage is back at 70%. Permanent attachments are never removed automatically. New uploads are refused when the limit is reached, or when they would leave less free disk space than `ONELOOP_DISK_MIN_FREE`. Admins can follow usage on the **Storage** page.

Sizes are a whole number followed directly by a unit: `B`, `KB`, `MB`, `GB`, `TB` (powers of 1000) or `KiB`, `MiB`, `GiB`, `TiB` (powers of 1024). Units are case-sensitive. Spaces, fractions and zero are rejected.

## All variables

<!-- config-table:start -->

| Variable | Default | What it does |
| --- | --- | --- |
| `ONELOOP_PUBLIC_URL` | None, required | The address people open, such as `https://tasks.example.com`. Used for links, sign-in checks and AI assistant connections. Must be HTTPS, except for `localhost`, `127.0.0.1` and `[::1]`. No path, query or credentials. |
| `ONELOOP_LISTEN` | `127.0.0.1:8080` | IP address and port to listen on, such as `0.0.0.0:8080` or `[::1]:8080`. Host names don't work here. The Docker image sets `0.0.0.0:8080`. |
| `ONELOOP_DATA_DIR` | `./data` | Folder for the database, uploaded files and internal keys. A relative path starts from the working directory. Must be on a local filesystem; NFS and SMB aren't supported. The Docker image sets `/data`. |
| `ONELOOP_TIMEZONE` | `UTC` | IANA timezone for deadlines, the Roadmap's Today and displayed dates and times. |
| `ONELOOP_STORAGE_LIMIT` | `10GiB` | Space budget for uploaded files, their previews and uploads in progress. |
| `ONELOOP_DISK_MIN_FREE` | `1GiB` | Uploads are refused if they would leave less free disk space than this. |
| `ONELOOP_TRUSTED_PROXIES` | Empty (trust none) | Comma-separated IP addresses or CIDR ranges of your reverse proxies. Only these may supply the visitor's address in `X-Forwarded-For`. |
| `ONELOOP_LOG_LEVEL` | `info` | How much to log: `error`, `warn`, `info`, `debug` or `trace`. |

<!-- config-table:end -->

Logs go to standard error. In a terminal they're colored unless `NO_COLOR` is set.
