# Security policy

## Report a vulnerability

Report security problems privately. Open the repository's **Security** tab, choose **Report a vulnerability**, and describe the problem with steps to reproduce it. Do not open a public issue for a security problem.

You can expect a first reply within 7 days. A fix for a confirmed problem goes into `main` and is listed under **Security** in [CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest commit on `main` gets security fixes.

## What Orbit protects

Every Orbit account has its own chats, memories, and credentials.

- **Provider key fields stay on the server.** `GET /api/connections` reports `keySet` and `keyReadable`. Provider keys are encrypted at rest and decrypted for server-side use and redaction. Connection and settings URLs mask userinfo and credential parameters. Orbit rejects connection labels that contain known credentials covered by text redaction. Model lists mask display labels and omit model IDs that would require masking.
- **Chat output masks known credentials.** Orbit masks values of 12 or more characters in live replies, saved prompts and replies, chat titles, and memories. It recognizes literal, percent-encoded, Base64 and Basic-auth, JSON-escaped, and terminal-control-split forms, including credentials split across streamed text fragments. Shorter values such as the `ollama` placeholder remain in ordinary text. If a server diagnostic or streamed error detail contains a known credential of any length, Orbit withholds the detail. These rules apply where Orbit reads and redacts content. Earlier saved rows remain as stored.
- **GitHub settings belong to the signed-in account.** `GET /api/settings` returns `githubTokenSet`, `githubTokenReadable`, and the masked MCP URL. GitHub tools are read-only and limited to repositories, issues, and pull requests. A check calls `get_me` and returns the login or an error, not the token. The token is sent only to `https://api.githubcopilot.com`, `https://github.com`, or `https://api.github.com`, and only on port 443. Plain HTTP and any other host are refused before the request. `ORBIT_GITHUB_MCP_FIXTURE=1` also allows `127.0.0.1`, `localhost`, and `::1` so the local test fixture can run. Leave that variable unset outside tests. The verify harness sets it for its own server.
- **Admin settings require the admin account.** `GET /api/admin/settings` returns the masked search URL and `tavilyKeySet` and `tavilyKeyReadable` flags. The API returns 403 to signed-in members. The Admin page is accessible to the admin only.
- **Every page and API route needs a session**, except the login, signup, and invite pages, `/api/auth/*`, and `/api/setup`.
- **API writes come from a trusted origin.** A `POST`, `PUT`, `PATCH`, or `DELETE` under `/api`, other than `/api/auth/*`, gets 403 when it carries a `Sec-Fetch-Site` other than `same-origin`, or, without Fetch Metadata, an `Origin` that is not a trusted origin. The browser sets `Sec-Fetch-Site` and a page cannot forge it, so a write it marks `same-origin` passes. A write with neither header, such as curl, passes. `/api/auth/*` uses better-auth's origin check, which can accept wildcard patterns; for the `Origin` match here, a wildcard entry counts for nothing. A page on another port of the same host cannot write with your session.
- **Local files are private.** The data directory is mode `0700`. The database, `data/auth-secret`, and `data/secret-key` are mode `0600`.
- **Local only by default.** Docker Compose publishes port 3210 on `127.0.0.1`, so other machines cannot reach Orbit.
- **The Docker server is not root.** The process runs as the `node` user. The entrypoint may start as root only to give the data directory to that user, and it drops root before the server listens.

## Accounts

The first account is the only admin. Personal mode closes signup after that account. In other modes, the admin can create seven-day, single-use invites. Orbit stores a hash of each invite token and shows the link once. Opening the link leaves it available until someone completes signup. Changing hosting modes revokes unspent invites.

The admin can list and remove members. Every account, including the admin, can read and change only its own chats, memories, preferences, and GitHub settings. Removal stops the member’s active replies, signs them out, and permanently deletes their data.

Team members can send requests through the admin’s connections. Orbit shows them the connection id, kind, and label. The admin pays for requests made on those connections.

Community accounts manage their own connections. Orbit checks provider URLs for public HTTPS when you save them and when it opens a socket or follows a redirect. The environment flag `ORBIT_PROVIDER_FIXTURE=1` allows loopback for local tests. Leave it unset on a deployed instance.

Orbit does not verify email addresses. An Orbit account’s email is a sign-in name.

## Known limits

- Orbit encrypts provider keys, the Tavily key, and GitHub tokens with AES-256-GCM under `data/secret-key` or `ORBIT_SECRET_KEY`. The key file sits next to the database. A person who reads the whole data directory can decrypt its credentials. Enter the saved credentials again if the encryption key is lost.
- Use a fine-grained GitHub personal access token that can read only the repositories you want Orbit to see.
- Sign-in and signup each allow three attempts per ten seconds through better-auth. Orbit ignores `X-Forwarded-For`, which clients can forge. Everyone shares one bucket per auth path. If someone fills it, other people must wait for the window to reset. This applies to open Community signup as well. Cloudflare Access can limit who reaches the app. Orbit's own verification of the Access token is future work.
- Model output is untrusted. Markdown renders without raw HTML. Generated UI specs are checked against a fixed component catalog before they render.

## Cloudflare Access

The `public` Compose profile runs a `cloudflared` container that carries a Cloudflare tunnel to Orbit. The tunnel connects out to Cloudflare, so no port listens on a public interface. Compose still publishes port 3210 on `127.0.0.1` only.

When configured, Access checks every request before it enters the tunnel. Its Allow policy controls who can reach Orbit, including its sign-in, invite, and API routes. Orbit’s own account rules still apply.

The tunnel token lives in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Compose hands it to `cloudflared` as a file secret, so it does not appear in `docker compose config` or in the container's environment.

Known limits:

- **Orbit does not check the Access JWT yet.** Access adds a signed `Cf-Access-Jwt-Assertion` header to each request. Orbit trusts that the tunnel is the only public path and does not verify that header. Anything that reaches port 3210 without the tunnel skips Access, such as another process or user on the same machine, or a misconfigured port mapping. This is a follow-up: verify the JWT against the team's public keys and the application's audience tag, and reject requests without it when `ORBIT_PUBLIC_URL` is set.
- Anyone who can read `.env` can run the tunnel. Keep that file at mode `0600`.

## Response headers

`next.config.ts` sends `X-Content-Type-Options: nosniff` on every response outside `/s/`. Most routes send `Referrer-Policy: same-origin`. Invite pages use `Referrer-Policy: no-referrer` and `Cache-Control: no-store` to protect their links. Next.js omits `X-Powered-By`. The planned `/s/` share pages set their own headers ([slice 22](docs/slices/22.md)).

The app pages (`/`, `/login`, `/signup`, `/invite/<token>`, `/settings`, `/admin`, `/memory`, and `/c/<id>`) also send `Content-Security-Policy: frame-src 'none'; frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no other page can frame them. A page on another port of the same host is a same-site page that gets the session cookie, so this is the rule that stops it from showing a signed-in Orbit page in a hidden frame.

These rules list the pages by path. A matching Next.js header rule replaces a route handler's own header of the same name, and slice 20 plans `Content-Security-Policy: default-src 'none'; sandbox` on file downloads. Add a new page to the list. `src/next-config.test.ts` fails when a page lacks the frame rules or a route handler gets them.

There is no page-wide policy for scripts, styles, images or requests yet. That policy needs a per-request nonce and belongs to slice 22.

## Artifact previews

HTML, SVG, JSX and TSX code blocks run only in an iframe with `sandbox="allow-scripts"`. The frame has an opaque origin. It cannot read the parent page, cookies or local storage, and it has no permission to open popups, submit forms or navigate the app.

The frame document places this Content Security Policy before model code:

```text
default-src 'none'; script-src 'unsafe-inline' https://esm.sh; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'
```

This policy blocks fetch requests, including requests to Orbit's API. It allows inline scripts and scripts from esm.sh. React previews load React 19.3.1 from esm.sh, so they need a network connection. HTML and SVG previews work offline. React source can import only the supported React modules.

Orbit's pages also send `Content-Security-Policy: frame-src 'none'`. The browser checks this policy each time a frame on the page loads a URL, including a load the frame starts itself. When preview code sets `location.href`, follows a link or uses a meta refresh, the browser blocks the load before the request leaves, so the code cannot send data out in a URL. Chrome 155 and Firefox 157 block these loads. Safari is untested. The browser may show its own blocked page in the frame, and Reload brings the preview back. Orbit passes the preview document as `srcdoc`, not as a URL, so this policy does not block it.

Client-side links keep the current document's CSP. Give new pages that link into chat the same policy or use a link that loads a new document, as the 404 page does.

The app accepts an error report only from the preview frame's own window and shows the message as text. The frame does not limit CPU or memory use. Preview only code you are willing to run under these limits.

The [code sandbox](docs/slices/08.md) runs server-side code in a separate container. It is separate from artifact previews.

## Code sandbox

`run_code` is off unless the server sets `ORBIT_SANDBOX=on`. The browser cannot enable it. The model can supply only Python or JavaScript source, capped at 20,000 characters.

Each run uses a fresh container from a digest-pinned image and passes source through stdin. The container runs as `65534:65534` with no network, no host mounts, and a read-only root filesystem. Its only writable scratch space is a 64 MiB `/tmp` mount with `noexec` and `nosuid`. The limits are one CPU, 256 MiB of memory with no swap, 64 processes, and ten seconds. The container drops all capabilities and disallows new privileges.

Orbit keeps at most 64 KiB each of stdout and stderr. Docker log storage is disabled for these containers. The runner removes the container after success, program failure, timeout, or cancellation. The container also stops itself after ten seconds, so the limit holds when Orbit dies during a run. With the sandbox on, Orbit removes sandbox containers older than a minute when it starts and every minute after, which clears containers a crash left behind. No files last between runs. Images must be pulled separately. A code run never pulls an image.

During development, the server uses the local Docker socket. The default Compose deployment has no Docker proxy. The optional `docker-compose.sandbox.yml` override enables the tool and connects Orbit to a private socket proxy. Only that proxy mounts `/var/run/docker.sock`. The proxy permits container endpoints and their writes, and denies other Docker API groups.

The proxy does not validate container options. A compromised Orbit process with access to its container-create endpoint could request host mounts or a privileged container. The fixed `containerSpec` function is the boundary that prevents model input from doing that. The proxy reduces API access but does not make a compromised app safe for the host. Container isolation also depends on Docker and the host kernel.
