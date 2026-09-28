# Security

This page lists what you need to do to run oneloop safely, and what oneloop already does for you.

## Checklist

| Do this | Why |
| --- | --- |
| Serve oneloop over HTTPS and redirect HTTP to HTTPS | Passwords and sign-in cookies must never cross a network unencrypted. |
| Keep port 8080 reachable only by your proxy | A direct connection bypasses HTTPS. |
| Set `ONELOOP_TRUSTED_PROXIES` to your proxy's address only | Sign-in limits depend on the real visitor address. |
| Leave oneloop's security headers alone at the proxy | They isolate uploaded files and protect sign-in. |
| Run oneloop under its own system account | The data directory holds password hashes, private files and signing keys. |
| Keep backups and logs private | Backups contain everything; logs contain usernames and IP addresses. |
| Keep oneloop up to date | Security fixes ship in new releases. |

## HTTPS and the proxy

oneloop leaves certificates to a reverse proxy; see [HTTPS and reverse proxy](reverse-proxy.md). With an `https://` address in `ONELOOP_PUBLIC_URL`, oneloop:

- limits its sign-in cookie to HTTPS and your exact host name;
- sends `Strict-Transport-Security` for one year, without subdomains;
- answers only requests for its own host name, and accepts changes only from its own pages.

Keep the proxy's redirect from HTTP to HTTPS, because browsers only learn the HSTS rule on their first HTTPS visit.

oneloop reads the visitor's address from `X-Forwarded-For` only when the request comes from an address in `ONELOOP_TRUSTED_PROXIES`. Never list a network your visitors connect from, or anyone could fake their address to dodge sign-in limits; see [Trusted proxy](reverse-proxy.md#trusted-proxy).

## The data directory

oneloop creates its files readable only by the account that runs it (folders `0700`, files `0600`), and warns at startup if others can read them.

- Keep the data directory on a local disk. NFS and SMB aren't supported.
- Run one server per data directory. oneloop refuses to start a second one.
- Run maintenance commands as the service account, so new files get the right permissions.
- Restoring a backup signs everyone out and disconnects every AI assistant, so an old backup can't bring back revoked access.

## Accounts

- Repeated failed sign-ins are slowed down, per account and per address.
- Browser sessions expire; [Limits](limits.md) lists how long they last.
- Passwords need only 5 characters, so encourage long passphrases, especially for admins.
- Password resets and deactivation sign the person out everywhere and revoke their AI assistant connections.

## Uploaded files

Anyone with **Board** permission can upload files, so oneloop treats every upload as untrusted:

- Files are stored under generated names and never run or unpacked on the server.
- Downloads are always sent as files to save, never shown as web pages.
- HTML previews run in a sandbox with an isolated origin. Their scripts can't read oneloop's pages, cookies or storage, and can't use forms or network APIs such as `fetch`. They can still load images, styles and scripts from HTTPS sites.
- Markdown and diagram previews are cleaned before display.

Don't remove or rewrite oneloop's `Content-Security-Policy` headers at the proxy. They are part of this isolation.

## AI assistants

Each AI assistant connection belongs to one person, who chooses what it may do in the browser. A connection:

- covers only the projects they select;
- can never do more than they can do in the app, and loses access the moment they do;
- can delete work only if they tick **Permanently delete permitted work and files**;
- never has admin powers, even for admins.

Access is checked again on every call, so a revoked connection stops at once. Everyone can revoke their own connections under **Connected apps** on their profile. Whatever an assistant reads becomes part of its context, which may go to whoever runs the model. See [AI assistants (MCP)](mcp.md).

## Version information

`/healthz` is public and shows the version and source revision. You can limit it to your monitoring network at the proxy, but the app still shows its version after sign-in.

## Reporting a vulnerability

Report security problems privately, as described in [SECURITY.md](https://github.com/code19m/oneloop/blob/main/SECURITY.md), not in a public issue.
