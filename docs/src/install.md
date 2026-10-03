# Install

The easiest way to run oneloop is with Docker Compose. You can also build it
from source. Either way, oneloop starts at <http://localhost:8080>, and only
your own computer can open it. To give your team access, continue with
[Production setup](production.md) afterwards.

## With Docker

You need Docker with Compose. Check that it works with `docker compose version`.

Create a folder, for example `oneloop`, and save this file in it as
`compose.yaml`:

```yaml
{{#include ../../deploy/compose.yaml}}
```

Or download the file:

```sh
curl -fsSLO https://raw.githubusercontent.com/code19m/oneloop/v0.1.0-rc.1/deploy/compose.yaml
```

Run the next commands in that folder. First, create the database:

<!-- quickstart -->
```sh
docker compose run --rm oneloop db migrate
```

oneloop never creates or upgrades its database by itself. You run `db migrate`
now, and again after each upgrade.

Create your admin account. Use your own username instead of `admin`, and type a
password of at least 5 characters when asked:

```sh
docker compose run --rm oneloop user add admin --admin --name "Your Name"
```

Start oneloop:

<!-- quickstart -->
```sh
docker compose up -d
```

oneloop now runs in the background, and Docker starts it again after a crash or
a reboot. To stop it, run `docker compose down`. Your data stays in the
`oneloop-data` volume. If something goes wrong, `docker compose logs oneloop`
shows the reason.

Continue with [First steps](#first-steps).

## From source

You need Linux or macOS, Rust 1.92 or newer, and a C compiler, because oneloop
builds its own copy of SQLite.

Build and install a release. This takes a few minutes and puts `oneloop` in
`~/.cargo/bin`:

```sh
cargo install --git https://github.com/code19m/oneloop --tag v0.1.0-rc.1 --locked
```

You can choose another tag from the
[releases](https://github.com/code19m/oneloop/releases). Without `--tag`, you
get the unreleased code from `main`.

Set the data folder and the address you will open. oneloop doesn't read `.env`
files, so set these in your shell or service manager:

```sh
export ONELOOP_DATA_DIR="$HOME/oneloop-data"
export ONELOOP_PUBLIC_URL=http://localhost:8080
```

Create the database and your admin account, then start the server:

```sh
oneloop db migrate
oneloop user add admin --admin --name "Your Name"
oneloop serve
```

The server runs until you press Ctrl+C. Run every `oneloop` command with the
same `ONELOOP_DATA_DIR` as the server. Otherwise the command works on a
different, empty instance.

## First steps

1. Open <http://localhost:8080> and sign in with your admin account.
2. Choose **Create project**. Enter a name and a task prefix of 2 to 4 letters
   or digits, such as `APP`. Tasks in the project get IDs like `APP-001`.

If oneloop runs on a remote server, open an SSH tunnel with
`ssh -L 8080:localhost:8080 you@your-server`, and use the same address.

Where to go next:

- Learn the Roadmap and the Board in the [User guide](user-guide.md).
- Add your teammates with the [Admin guide](admin-guide.md).
- Set up HTTPS and start oneloop at boot with [Production setup](production.md).
- Protect your data with [Backups and upgrades](backups-and-upgrades.md).
