# Security policy

## Supported versions

Security fixes go into the latest release. Please check that a problem still
happens there before you report it.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's security advisory form](https://github.com/code19m/oneloop/security/advisories/new),
not in a public issue, discussion or pull request. We'll acknowledge your
report, keep you updated while we work on a fix, and credit you in the
advisory if you'd like.

Please include:

- the oneloop version (`oneloop --version`) and how you run it: Docker or
  Cargo, operating system, reverse proxy and browser;
- which account and permissions the attack needs, if any;
- the steps to reproduce, with what you expected and what happened;
- the impact as you see it.

Use test accounts and made-up data. Remove passwords, session cookies, tokens
and personal information from logs and screenshots.

## Scope

In scope is anything in this repository: the `oneloop` binary, its web app,
the MCP server and its sign-in flow, the Docker image, and the example
configurations in `deploy/`. For example:

- someone reading or changing data in a project they aren't a member of;
- an AI assistant connection doing more than its person and grant allow;
- an uploaded file running script in oneloop's origin, or escaping its preview
  sandbox;
- a way to get or keep access after a sign-out, password reset, deactivation,
  revocation or backup restore.

oneloop expects to run behind an HTTPS reverse proxy, under its own system
account, with a private data directory and private backups. It trusts the
people who can reach its host, read its data directory or run its commands, and
it relies on the proxy for TLS. Problems that need one of those protections to
be missing, or that sit in a third-party client or AI model, are out of scope.
The [security page](https://code19m.github.io/oneloop/security.html) of the
documentation describes the deployment boundary in detail.
