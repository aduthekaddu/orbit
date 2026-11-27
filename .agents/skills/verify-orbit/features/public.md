# Public URL

`drive public` checks Orbit from outside through the Cloudflare tunnel, and checks that local sign-in still works while `ORBIT_PUBLIC_URL` is set.

## Driving it with verify-orbit

Preconditions:

- `npm run build` has run.
- For the public checks, the tunnel runs with `docker compose --profile public up -d`, and the Access application exists. `scripts/deploy-wizard.sh` walks through that setup.

Steps:

1. Run `ORBIT_PUBLIC_URL=https://orbit.aduthekaddu.in node .agents/skills/verify-orbit/verify.mjs launch`. The sandbox server gets the same `ORBIT_PUBLIC_URL` as the Compose service.
2. Run `node .agents/skills/verify-orbit/verify.mjs doctor`.
3. Run `node .agents/skills/verify-orbit/verify.mjs drive public`.
4. Run `node .agents/skills/verify-orbit/verify.mjs cleanup`.

The drive does three things:

- **Public root.** `GET <public>/` with no Access cookie must answer `302` with a `Location` on `cloudflareaccess.com`.
- **Public API.** `GET <public>/api/chats` with no Access cookie must not answer `200`.
- **Local sign-in.** Chrome opens `http://127.0.0.1:<port>/login`, signs in as `verify@orbit.local`, lands on `/c/<id>`, then opens `/settings` and finds `GitHub`. On an empty sandbox the drive first creates that account. `GET /api/setup` answers without a session, so it does not count as sign-in proof.

When the tunnel is not up, the drive skips both public checks, still runs local sign-in, and exits 0 with `skipped the public checks`. The tunnel counts as not up when `GET <public>/` gets no DNS answer, fails TLS, or answers `530`, which Cloudflare sends for a tunnel with no connector. Any other answer runs the public checks, so a reachable URL without Access still fails.

## Proof

`.verify/evidence/public/summary.txt` holds the public URL, the public statuses or the skip line, the redirect target, the chat path after sign-in, the session cookie name and its `Secure` flag, and the `/settings` status. `local-settings.png` shows `/settings` after the browser sign-in. No file holds cookie values.

## Gotchas

- A DNS or TLS failure is recorded as `status 0` with the error code. When the root has answered, a `status 0` from `/api/chats` fails the drive, because a failed request does not show that the API is protected.
- Access answers before the tunnel, so the public checks pass while the tunnel is down once the Access application exists. `docker compose logs cloudflared` shows whether the tunnel connected.
- With an `https` public URL, better-auth names the session cookie `__Secure-better-auth.session_token` and marks it `Secure`. Chrome still keeps it on `http://127.0.0.1`, because it treats loopback as a secure origin.
- A launch with a different `ORBIT_PUBLIC_URL` than the running sandbox stops with a cleanup instruction.
