# HTTPS and reverse proxy

This page puts oneloop behind Caddy or nginx, so your team reaches it safely over HTTPS.

oneloop speaks plain HTTP and leaves certificates to a reverse proxy. It accepts an `http://` address only for `localhost` and loopback addresses, because passwords and sign-in cookies must never cross a network unencrypted.

## Set up HTTPS

1. Point a DNS name, such as `tasks.example.com`, at your server.
2. Configure oneloop. Keep it reachable only at `127.0.0.1:8080`, as the defaults and the quick start's `compose.yaml` do, so that only the proxy can reach it:

   | Variable | Value |
   | --- | --- |
   | `ONELOOP_PUBLIC_URL` | `https://tasks.example.com`, the exact address people open |
   | `ONELOOP_TRUSTED_PROXIES` | The proxy's address as oneloop sees it; see [Trusted proxy](#trusted-proxy) |

   With Docker, change these under `environment:` in `compose.yaml`, then run `docker compose up -d`. With a service, change its environment and restart it.
3. Configure the proxy with one of the examples below.
4. Sign in again at the new address.

## Caddy

Caddy gets and renews certificates for you:

```caddyfile
tasks.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

That's all. Caddy redirects HTTP to HTTPS, uses HTTP/2, streams live updates without delay and replaces any `X-Forwarded-For` header a visitor sends.

No public domain? For a trial on your local network, use a name like `tasks.home.arpa` in your local DNS, add `tls internal` inside the block, and install [Caddy's local certificate authority](https://caddyserver.com/docs/automatic-https#local-https) on each device.

## nginx

Replace the domain and certificate paths:

```nginx
upstream oneloop {
    server 127.0.0.1:8080;
    keepalive 16;
    keepalive_timeout 10s;
}

server {
    listen 80;
    listen [::]:80;
    server_name tasks.example.com;
    return 301 https://$host$request_uri;
}

server {
    # On nginx 1.25.1 or newer, use "listen 443 ssl;" and "http2 on;".
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name tasks.example.com;

    ssl_certificate /etc/ssl/certs/tasks.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/private/tasks.example.com/privkey.pem;

    # Attachments are up to 25 MiB.
    client_max_body_size 27m;

    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Connection "";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://oneloop;
        proxy_request_buffering off;
    }

    # Live updates: one long-lived stream per open tab.
    location = /api/events {
        proxy_pass http://oneloop;
        proxy_buffering off;
        proxy_cache off;
    }

    # Compress the web app's files, but not API responses.
    location ~ "^/(?:$|index\.html$|(?:v/[a-f0-9]{64}/)?(?:src|views|styles|icons|vendor)/)" {
        proxy_pass http://oneloop;
        gzip on;
        gzip_comp_level 5;
        gzip_min_length 1024;
        gzip_proxied no-cache;
        gzip_vary on;
        gzip_types text/css text/javascript application/javascript application/json image/svg+xml;
    }
}
```

Run `nginx -t` before you reload. To keep old nginx workers from holding live-update streams open long after a reload, set `worker_shutdown_timeout 30s;` in the main context of `nginx.conf`. The same configuration, with comments, is in [`deploy/nginx/oneloop.conf.example`](https://github.com/code19m/oneloop/blob/main/deploy/nginx/oneloop.conf.example).

## Trusted proxy

oneloop uses each visitor's IP address to slow down repeated failed sign-ins and to show where people are signed in. Behind a proxy, every request seems to come from the proxy. `ONELOOP_TRUSTED_PROXIES` names the proxy, so oneloop reads the visitor's real address from `X-Forwarded-For` instead. Without it, everyone shares one sign-in limit, and oneloop warns about it at startup.

| oneloop runs | The proxy runs | Set `ONELOOP_TRUSTED_PROXIES` to |
| --- | --- | --- |
| From Cargo | On the same machine | `127.0.0.1` |
| In Docker, from the quick start | On the host | The Docker network's gateway, shown by the command below |
| Anywhere | On another machine | That machine's IP address |

```sh
docker network inspect oneloop_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Separate several addresses or CIDR ranges with commas. Trust only real proxies, never a network your visitors connect from, and make sure the proxy replaces `X-Forwarded-For` rather than appending to it. oneloop ignores `Forwarded`, `X-Real-IP` and `X-Forwarded-Proto`.

## Rules for any proxy

- Serve oneloop at the root of its own hostname. Paths like `/oneloop/` are not supported.
- Pass the `Host` header through unchanged, including any port. oneloop answers other hostnames with "Open oneloop at its configured address".
- Don't add or replace `Content-Security-Policy`. oneloop sets its own security headers, including HSTS.
- Use HTTP/2 towards browsers. Over HTTP/1.1, a browser opens only six connections to your site, and each open tab keeps one for live updates.
- Don't buffer or time out the live-update stream at `/api/events`. It stays open for as long as a tab does.
- Allow request bodies of at least 27 MB for uploads.

## Check that it worked

```sh
curl https://tasks.example.com/healthz
```

You should see a line that starts with `{"status":"ok"`. Then open the site in two tabs and change a task in one. The change should appear in the other without a refresh.
