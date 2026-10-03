# Install from source

This page builds oneloop from its source code with Cargo and runs it without Docker.

You need Linux or macOS, Rust 1.92 or newer, and a C compiler, because oneloop builds its own copy of SQLite.

## Install and start

1. Build and install the binary from a release tag:

   ```sh
   cargo install --git https://github.com/code19m/oneloop --tag v0.1.0-rc.1 --locked
   ```

   Cargo downloads that release's source, builds it in a few minutes and installs `oneloop` into `~/.cargo/bin`. Pick a tag from the [releases](https://github.com/code19m/oneloop/releases). Without `--tag`, you get the latest unreleased code from `main`.

2. Choose where oneloop keeps its data and the address you'll open it at:

   ```sh
   export ONELOOP_DATA_DIR="$HOME/oneloop-data"
   export ONELOOP_PUBLIC_URL=http://localhost:8080
   ```

   The data directory holds the database and every uploaded file. oneloop doesn't read `.env` files, so set these in your shell or service manager.

3. Create the database. oneloop creates the directory if it doesn't exist:

   ```sh
   oneloop db migrate
   ```

4. Create your admin account and enter a password twice when asked:

   ```sh
   oneloop user add admin --admin --name "Your Name"
   ```

5. Start the server:

   ```sh
   oneloop serve
   ```

6. Open <http://localhost:8080>, sign in and choose **Create project**.

Run every `oneloop` command with the same `ONELOOP_DATA_DIR` as the server. Otherwise the command works on a different, empty instance.

## Check that it worked

In a second terminal:

```sh
curl http://localhost:8080/healthz
```

You should see a line that starts with `{"status":"ok"`.

`oneloop serve --check` checks your settings and database without starting the server. Run it after you change the configuration.

## What's next

- To run oneloop for your team, give it its own system account and start it at boot: [Running as a service](running-as-a-service.md).
- Put it behind HTTPS before anyone else uses it: [HTTPS and reverse proxy](reverse-proxy.md).
- See every setting: [Configuration](configuration.md).
- Upgrade with a backup first: [Backups and upgrades](backups-and-upgrades.md).
