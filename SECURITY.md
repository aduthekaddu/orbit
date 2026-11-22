# Security policy

## Report a vulnerability

Report security problems privately. Open the repository's **Security** tab, choose **Report a vulnerability**, and describe the problem with steps to reproduce it. Do not open a public issue for a security problem.

You can expect a first reply within 7 days. A fix for a confirmed problem goes into `main` and is listed under **Security** in [CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest commit on `main` gets security fixes.

## What Orbit protects

Orbit is built for one person on their own machine. These are the protections it has today:

- **The provider key stays on the server.** The API never returns it. `GET /api/settings` reports only whether a key is set, and the chat route removes the key from error text before it logs.
- **The GitHub token stays on the server.** `GET /api/settings` reports `githubTokenSet` and the MCP URL, never the token. GitHub tools are read-only and limited to repositories, issues, and pull requests. A check calls `get_me` and returns the login or an error, not the token. The token is sent only to `https://api.githubcopilot.com`, `https://github.com`, or `https://api.github.com`, and only on port 443. Plain HTTP and any other host are refused before the request. `ORBIT_GITHUB_MCP_FIXTURE=1` also allows `127.0.0.1`, `localhost`, and `::1` so the local test fixture can run. Leave that variable unset outside tests. The verify harness sets it for its own server.
- **One account.** An auth hook and a SQLite trigger both reject a second signup.
- **Every page and API route needs a session**, except the login and signup pages, `/api/auth/*`, and `/api/setup`.
- **Local files are private.** The data directory is mode `0700`. The database and `data/auth-secret` are mode `0600`.
- **Local only by default.** Docker Compose publishes port 3210 on `127.0.0.1`, so other machines cannot reach Orbit.
- **The Docker server is not root.** The process runs as the `node` user. The entrypoint may start as root only to give the data directory to that user, and it drops root before the server listens.

## Known limits

- The database stores the provider key in plain text. Anyone who can read `data/orbit.db` can read the key.
- The database stores the GitHub token in plain text, the same way. Use a fine-grained personal access token that can only read the repositories you want Orbit to see. Orbit does not use GitHub sign-in.
- Sign-in relies on better-auth's default rate limits. Orbit adds no lockout of its own. Keep it on `127.0.0.1`, or behind [Cloudflare Access](#cloudflare-access).
- Model output is untrusted. Markdown renders without raw HTML. Generated UI specs are checked against a fixed component catalog before they render.

## Cloudflare Access

The `public` Compose profile runs a `cloudflared` container that carries a Cloudflare tunnel to Orbit. The tunnel connects out to Cloudflare, so no port listens on a public interface. Compose still publishes port 3210 on `127.0.0.1` only.

Access checks each request at Cloudflare before it enters the tunnel. Only the emails in the Allow policy get through. Every page, every API route, and `/api/auth/*` sit behind it, so sign-in rate limits and the code sandbox are not reachable from the open internet. Orbit's own sign-in still runs after Access.

The tunnel token lives in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Compose hands it to `cloudflared` as a file secret, so it does not appear in `docker compose config` or in the container's environment.

Known limits:

- **Orbit does not check the Access JWT yet.** Access adds a signed `Cf-Access-Jwt-Assertion` header to each request. Orbit trusts that the tunnel is the only public path and does not verify that header. Anything that reaches port 3210 without the tunnel skips Access, such as another process or user on the same machine, or a misconfigured port mapping. This is a follow-up: verify the JWT against the team's public keys and the application's audience tag, and reject requests without it when `ORBIT_PUBLIC_URL` is set.
- Anyone who can read `.env` can run the tunnel. Keep that file at mode `0600`.

## Artifact previews

HTML, SVG, JSX and TSX code blocks run only in an iframe with `sandbox="allow-scripts"`. The frame has an opaque origin. It cannot read the parent page, cookies or local storage, and it has no permission to open popups, submit forms or navigate the app.

The frame document places this Content Security Policy before model code:

```text
default-src 'none'; script-src 'unsafe-inline' https://esm.sh; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'
```

This policy blocks fetch requests, including requests to Orbit's API. It allows inline scripts and scripts from esm.sh. React previews load React 19.3.1 from esm.sh, so they need a network connection. HTML and SVG previews work offline. React source can import only the supported React modules.

Orbit's pages also send `Content-Security-Policy: frame-src 'none'`. The browser checks this policy each time a frame on the page loads a URL, including a load the frame starts itself. When preview code sets `location.href`, follows a link or uses a meta refresh, the browser blocks the load before the request leaves, so the code cannot send data out in a URL. Chrome 155 and Firefox 157 block these loads. Safari is untested. The browser may show its own blocked page in the frame, and Reload brings the preview back. Orbit passes the preview document as `srcdoc`, not as a URL, so this policy does not block it.

`next.config.ts` sets this header on the named app pages. Route handlers outside those paths can set their own CSP. A matching Next.js header rule can replace a handler's CSP, so keep the rule limited to pages. Client-side links keep the current document's CSP. Give new pages that link into chat the same policy or use a link that loads a new document, as the 404 page does.

The app accepts an error report only from the preview frame's own window and shows the message as text. The frame does not limit CPU or memory use. Preview only code you are willing to run under these limits.

The [code sandbox](docs/slices/08.md) runs server-side code in a separate container. It is separate from artifact previews.

## Code sandbox

`run_code` is off unless the server sets `ORBIT_SANDBOX=on`. The browser cannot enable it. The model can supply only Python or JavaScript source, capped at 20,000 characters.

Each run uses a fresh container from a digest-pinned image and passes source through stdin. The container runs as `65534:65534` with no network, no host mounts, and a read-only root filesystem. Its only writable scratch space is a 64 MiB `/tmp` mount with `noexec` and `nosuid`. The limits are one CPU, 256 MiB of memory with no swap, 64 processes, and ten seconds. The container drops all capabilities and disallows new privileges.

Orbit keeps at most 64 KiB each of stdout and stderr. Docker log storage is disabled for these containers. The runner removes the container after success, program failure, timeout, or cancellation. No files last between runs. Images must be pulled separately. A code run never pulls an image.

During development, the server uses the local Docker socket. The default Compose deployment has no Docker proxy. The optional `docker-compose.sandbox.yml` override enables the tool and connects Orbit to a private socket proxy. Only that proxy mounts `/var/run/docker.sock`. The proxy permits container endpoints and their writes, and denies other Docker API groups.

The proxy does not validate container options. A compromised Orbit process with access to its container-create endpoint could request host mounts or a privileged container. The fixed `containerSpec` function is the boundary that prevents model input from doing that. The proxy reduces API access but does not make a compromised app safe for the host. Container isolation also depends on Docker and the host kernel.
