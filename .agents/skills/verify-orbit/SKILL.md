---
name: verify-orbit
description: Drive Orbit, the local Next.js chat app, on 127.0.0.1:3210 and record proof. Use for /verify-orbit, to prove signup, sign-in, settings, or chat, or when a change needs a scripted user-path check.
---

# Verify Orbit

Orbit is a web app. The scripted drive sends the same HTTP requests the pages send. There is no browser harness in this repo. A passing HTTP check is not a click in Chrome.

The database path is `process.cwd()/data/orbit.db`. Launch uses a sandbox cwd so a run does not open the repo `data/` directory. Auth trusts only `http://127.0.0.1:3210` and `http://localhost:3210`, so the port stays 3210. One server at a time. If something else owns 3210, launch stops and names that process. It does not kill it.

Run the commands from the repo root.

## Launch

Done when the command prints `ready` and `signupOpen=yes` on an empty sandbox.

1. Run `npm run build` if `.next` is missing. `npm start` serves that build.
2. Run `node .agents/skills/verify-orbit/verify.mjs launch`.
3. The command symlinks the build into `.verify/sandbox`, creates an empty `.verify/sandbox/data`, and starts `npm start -- -p 3210 -H 127.0.0.1` with that cwd.
4. Ready means `GET /api/setup` returns JSON with a boolean `signupOpen`. A live port alone is not ready.

A second launch while that sandbox server is healthy prints `already running` and leaves the data directory in place.

## Doctor

Run `node .agents/skills/verify-orbit/verify.mjs doctor` before a drive when anything looks wrong.

Done when it prints `doctor ok`. That means the recorded pid is alive, its cwd is `.verify/sandbox`, a process with that cwd is listening on `127.0.0.1:3210`, and `GET /api/setup` returns `signupOpen`.

## Drive

The helper is the harness. Prefer the commands below over ad hoc curls. Page checks look for the visible label text `Create account`, `Sign in`, and `Message`.

- Signup. `node .agents/skills/verify-orbit/verify.mjs drive signup`
- Sign in. `node .agents/skills/verify-orbit/verify.mjs drive signin`
- Settings. `node .agents/skills/verify-orbit/verify.mjs drive settings`
- Chat. `node .agents/skills/verify-orbit/verify.mjs drive chat`

Feature recipes live in `features/`. Read `features/README.md` first. Drive one feature from that map. A proof that uses a different entry point does not cover the ones you skipped.

`drive chat` runs `scripts/smoke.ts` with cwd `.verify/sandbox`. It needs `ORBIT_BASE_URL` and `ORBIT_API_KEY` in the environment. The helper redacts those values in its output. If they are missing, the command fails before any provider call.

## Evidence

Each drive writes `.verify/evidence/<feature>/summary.txt`. The file records the action and the resulting status, redirect, and database counts. It does not record cookies or key values.

A proof shows the request and the state after it. For signup, that is the page text, the signup status, the redirect to `/c/<id>`, the composer page, `GET /api/chats`, a logged-out 401, the `user` and `chats` row counts, and a second signup status 403. A final screen with no prior action is not proof.

The settings drive uses the fake key `test-key-not-real` and checks that the response has no `apiKey` field and does not contain that key. It does not call a provider.

## Cleanup

Run `node .agents/skills/verify-orbit/verify.mjs cleanup`.

Done when the sandbox pid is gone, `.verify/sandbox` is gone, and `.verify/evidence/` is still there. Cleanup signals the process group started by launch. It does not kill by process name. If the recorded pid is not the sandbox server, cleanup refuses to kill it.

Run cleanup after a failed drive too, so the port is free. Then confirm the evidence file is still on disk.

## Helpers

`node .agents/skills/verify-orbit/verify.mjs` with one of `launch`, `doctor`, `cleanup`, or `drive` plus `signup`, `signin`, `settings`, or `chat`.

The script is the only helper. Feature files name these commands and the visible result.
