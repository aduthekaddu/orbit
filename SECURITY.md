# Security policy

## Report a vulnerability

Report security problems privately. Open the repository's **Security** tab, choose **Report a vulnerability**, and describe the problem with steps to reproduce it. Do not open a public issue for a security problem.

You can expect a first reply within 7 days. A fix for a confirmed problem goes into `main` and is listed under **Security** in [CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest commit on `main` gets security fixes.

## What Orbit protects

Orbit is built for one person on their own machine. These are the protections it has today:

- **The provider key stays on the server.** The API never returns it. `GET /api/settings` reports only whether a key is set, and the chat route removes the key from error text before it logs.
- **One account.** An auth hook and a SQLite trigger both reject a second signup.
- **Every page and API route needs a session**, except the login and signup pages, `/api/auth/*`, and `/api/setup`.
- **Local files are private.** The data directory is mode `0700`. The database and `data/auth-secret` are mode `0600`.
- **Local only by default.** Docker Compose publishes port 3210 on `127.0.0.1`, so other machines cannot reach Orbit.

## Known limits

- The database stores the provider key in plain text. Anyone who can read `data/orbit.db` can read the key.
- Sign-in relies on better-auth's default rate limits. Orbit adds no lockout of its own. Keep it on `127.0.0.1`, or behind an access layer such as Cloudflare Access, which is planned in [slice 12](docs/slices/12.md).
- Model output is untrusted. Markdown renders without raw HTML. Generated UI specs are checked against a fixed component catalog before they render.

Planned features add their own protections. The [artifact panel](docs/slices/05.md) runs model code in a sandboxed frame. The [code sandbox](docs/slices/08.md) runs it in a container with no network. Each plan says what its feature must not be able to reach, and the slice adds a section here when it ships.
