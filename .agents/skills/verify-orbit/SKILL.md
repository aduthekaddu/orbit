---
name: verify-orbit
description: Drive Orbit, the local Next.js chat app, on a configurable loopback port and record proof. Use for /verify-orbit, to prove signup, sign-in, settings, or chat, to prove a click or layout in Chrome, or when a change needs a scripted user-path check.
---

# Verify Orbit

Orbit is a web app. The `drive` commands send the same HTTP requests the pages send. The `browse` command drives Chrome through Playwright. A passing HTTP check is not a click in Chrome, so prove a click or a layout with `browse`.

The database path is `process.cwd()/data/orbit.db`. Launch uses a sandbox cwd so a run does not open the repo `data/` directory.

Launch reads `ORBIT_VERIFY_PORT`, a whole number from 1 to 65535, default `3210`, and sets auth to trust `127.0.0.1` and `localhost` on that port. One server at a time. If something else owns the selected port, launch stops and names that process. It does not kill it.

Run the commands from the repo root. To use another port, export it for the whole session.

```sh
export ORBIT_VERIFY_PORT=3230
```

Keep the same value for `launch`, `doctor`, `drive`, and `browse`. `cleanup` stops the recorded server on the port it was launched with. Run `cleanup` before changing the port.

## Launch

Done when the command prints `ready` and `signupOpen=yes` on an empty sandbox.

1. Run `npm run build` if `.next` is missing. `npm start` serves that build.
2. Run `node .agents/skills/verify-orbit/verify.mjs launch`.
3. The command symlinks the build into `.verify/sandbox`, creates an empty `.verify/sandbox/data`, and starts `npm start -- -p <port> -H 127.0.0.1` with that cwd and the selected port.
4. Ready means `GET /api/setup` returns JSON with a boolean `signupOpen`. A live port alone is not ready.

The server labels its sandbox containers with an owner: `ORBIT_SANDBOX_OWNER` if set, else a new `verify-<uuid>`. Launch records it as `sandboxOwner` in `.verify/server.json`, and `browse` hands it to the scenario and its fixture processes, so a scenario watches only this server's containers. Another Orbit process on the same Docker host cannot fail it.

A second launch reuses a healthy sandbox server when the requested port, sandbox mode and any `ORBIT_SANDBOX_OWNER` match its recorded ones. A mismatch or unknown recorded mode exits with a cleanup instruction and leaves the server and data in place. Run `cleanup`, then launch with the intended `ORBIT_VERIFY_PORT` and `ORBIT_SANDBOX` values.

`launch --mock` also starts `scripts/qa/mock-provider.mjs` on `127.0.0.1:3299` and saves settings for it as `verify@orbit.local`. Done when it also prints `mock ready` and `settings baseUrl=http://127.0.0.1:3299/v1 model=mock-genui keySet=yes`. That account blocks `drive signup` and `drive chat` on the same sandbox.

## Doctor

Run `node .agents/skills/verify-orbit/verify.mjs doctor` before a drive when anything looks wrong.

Done when it prints `doctor ok`. That means the recorded pid is alive, its cwd is `.verify/sandbox`, a process with that cwd is listening on `127.0.0.1` at the selected port, and `GET /api/setup` returns `signupOpen`.

## Drive

The helper is the harness. Prefer the commands below over ad hoc curls. Page checks look for the visible label text `Create account`, `Sign in`, and `Ask anything`.

- Signup. `node .agents/skills/verify-orbit/verify.mjs drive signup`
- Sign in. `node .agents/skills/verify-orbit/verify.mjs drive signin`
- Settings. `node .agents/skills/verify-orbit/verify.mjs drive settings`
- Chat. `node .agents/skills/verify-orbit/verify.mjs drive chat`
- Dreaming. `node .agents/skills/verify-orbit/verify.mjs drive dream`
- Public URL. `node .agents/skills/verify-orbit/verify.mjs drive public`. Launch with `ORBIT_PUBLIC_URL` set. See `features/public.md`.
- Browser. `node .agents/skills/verify-orbit/verify.mjs browse <scenario>`. See `features/browse.md` and the [feature map](features/README.md). Sandbox recipes are in [Code sandbox](features/sandbox.md).

Feature recipes live in `features/`. Read `features/README.md` first. Drive one feature from that map. A proof that uses a different entry point does not cover the ones you skipped.

`drive chat` runs `scripts/smoke.ts` with cwd `.verify/sandbox` and `ORBIT_QA_ORIGIN` set to the sandbox origin. Run on its own, smoke calls `http://127.0.0.1:3210`. It needs `ORBIT_BASE_URL` and `ORBIT_API_KEY` in the environment. The helper redacts those values in its output. If they are missing, the command fails before any provider call.

## Evidence

Each drive writes `.verify/evidence/<feature>/summary.txt`. Each browse run writes `.verify/evidence/<scenario>/summary.txt` with its `PASS` and `FAIL` lines, plus one PNG per screenshot. Signup records the statuses, the redirect, the chat list count, and the `user` and `chats` row counts. Signin records the statuses and the redirect location. Settings records the statuses and the key-leak checks. Chat records the smoke exit code and the redacted log. No file records cookies or key values.

A proof shows the request and the state after it. For signup, that is the page text, the signup status, the redirect to `/c/<id>`, the composer page, `GET /api/chats`, a logged-out 401, the `user` and `chats` row counts, and a second signup status 403. A final screen with no prior action is not proof.

The settings drive uses the fake key `test-key-not-real` and checks that the response has no `apiKey` field and does not contain that key. It does not call a provider.

## Cleanup

Run `node .agents/skills/verify-orbit/verify.mjs cleanup`.

Done when the sandbox pid is gone, the mock provider is gone, `.verify/sandbox` is gone, and `.verify/evidence/` is still there. Cleanup signals the process groups started by launch. It does not kill by process name. If the recorded pid is not the sandbox server, cleanup refuses to kill it.

Run cleanup after a failed drive too, so the port is free. Then confirm the evidence file is still on disk.

## Helpers

`node .agents/skills/verify-orbit/verify.mjs` with one of `launch [--mock]`, `doctor`, `cleanup`, `drive` plus `signup`, `signin`, `settings`, `chat`, `dream`, or `public`, or `browse` plus a scenario name.

The script is the only helper. Browse scenarios live in `scenarios/`. Feature files name these commands and the visible result.
