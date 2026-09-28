# Quick start with Docker

In about five minutes you'll have oneloop running on your computer, with your own admin account and a first project.

You need Docker with Compose. Check with `docker compose version`.

## 1. Create compose.yaml

Create an empty folder, for example `oneloop`, and save this file in it as `compose.yaml`:

```yaml
# oneloop with Docker Compose.
# Walkthrough: https://code19m.github.io/oneloop/quick-start.html
name: oneloop

services:
  oneloop:
    image: ghcr.io/code19m/oneloop:0.1.0-rc.1
    restart: unless-stopped
    stop_grace_period: 35s
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      ONELOOP_PUBLIC_URL: http://localhost:8080
      ONELOOP_TIMEZONE: UTC # Your team's timezone, for example Europe/Berlin
    volumes:
      - oneloop-data:/data

volumes:
  oneloop-data:
    name: oneloop-data
```

<!-- Keep this block identical to deploy/compose.yaml; a test checks it. -->

Run the commands below from that folder.

## 2. Create the database

<!-- quickstart -->
```sh
docker compose run --rm oneloop db migrate
```

Docker downloads the image and creates the `oneloop-data` volume. oneloop then creates an empty database in it.

oneloop never creates or upgrades its database on its own. You run `db migrate` now, and again after each upgrade.

## 3. Create your admin account

```sh
docker compose run --rm oneloop user add admin --admin --name "Your Name"
```

Replace `admin` with the username you want: 3 to 32 lowercase letters, digits, dots, underscores or hyphens. Enter a password twice when asked. It needs at least 5 characters.

## 4. Start oneloop

<!-- quickstart -->
```sh
docker compose up -d
```

oneloop now runs in the background, and Docker restarts it if it stops unexpectedly.

## 5. Sign in and create a project

1. Open <http://localhost:8080>.
2. Sign in with the username and password from step 3.
3. You'll see **No projects available**. Choose **Create project**.
4. Enter a **Name** and a **Task prefix** of 2 to 4 letters or digits, such as `APP`. Your tasks get IDs like `APP-001`.
5. Choose **Create project**. oneloop opens the project's Roadmap.

## Check that it worked

```sh
curl http://localhost:8080/healthz
```

You should see a line that starts with `{"status":"ok"`. If not, `docker compose logs oneloop` shows what went wrong.

To stop oneloop, run `docker compose down`. Your data stays in the `oneloop-data` volume.

> This setup answers only at `http://localhost:8080` on this computer. Trying it on a remote server? Open a tunnel with `ssh -L 8080:localhost:8080 you@your-server` and use the same address.

## What's next

- Plan the big picture on the [Roadmap](roadmap.md), then track daily work on the [Board](board-and-tasks.md).
- Add your teammates: [Users and permissions](users-and-permissions.md).
- Let your team in over HTTPS: [HTTPS and reverse proxy](reverse-proxy.md).
- Set the timezone and other options: [Configuration](configuration.md).
- Protect your data: [Backups and upgrades](backups-and-upgrades.md).
- Connect Claude Code, Codex or another assistant: [AI assistants (MCP)](mcp.md).
