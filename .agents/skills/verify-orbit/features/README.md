# Orbit verification map

Read this index, then use one feature file as the recipe. The harness is `verify-orbit`.

## Baseline preconditions

- The port set by `ORBIT_VERIFY_PORT` on `127.0.0.1` is free, default `3210`. Export another port if the deployment owns `3210`.
- `npm run build` has produced `.next`.
- Launch with `node .agents/skills/verify-orbit/verify.mjs launch` so the server cwd is `.verify/sandbox` and `data/orbit.db` is created there.
- Run `node .agents/skills/verify-orbit/verify.mjs doctor` and require `doctor ok` plus the sandbox cwd.
- Drive only the server this launch started. A server whose cwd is the repo uses the repo database. Do not drive that one from this map.

## Driving conventions

- Start from the baseline unless the feature names a different precondition.
- `<port>` in a recipe is the port in `ORBIT_VERIFY_PORT`, default `3210`. The sandbox origin is `http://127.0.0.1:<port>`. Where the deployment owns `3210`, `http://127.0.0.1:3210` opens the deployment, not the sandbox.
- Page checks use the visible strings `Create account`, `Sign in`, `Ask anything`, and the settings labels `Base URL` and `API key`.
- Run every command through `node .agents/skills/verify-orbit/verify.mjs`.
- Keep `.verify/evidence/` after cleanup.

## Proof and skip reporting

- Record the action and the state after it. Status codes, redirect targets, and row counts belong in the evidence file.
- Report an unreachable path with the command and the unmet precondition.
- A skipped entry point is not verified by a different path.

## CI

`scripts/qa/ci-e2e.sh core|browse|sandbox` runs these recipes the way GitHub Actions does, one suite per job. It finds scenarios by file name, so a new scenario joins the `browse` suite, or the `sandbox` suite when its name starts with `sandbox`. Name a scenario that needs a real provider `*-real` and CI skips it.

## Features

- [Sign up](./signup.md) creates the only account, opens a chat, and closes signup.
- [Sign in](./signin.md) returns that account to a chat.
- [Settings](./settings.md) stores a provider without returning the key.
- [Chat](./chat.md) streams one turn and reads it back from SQLite.
- [Browse](./browse.md) drives Chrome for retry and stop, the palette, short-screen settings, the empty chat, and sign out.

- [Branching](./branching.md) keeps edited prompts and regenerated answers, switches versions, and restores the last written branch.
- [History search](./search.md) finds a message from the command palette and titles a new chat.
- [Artifacts](./artifacts.md) previews HTML, SVG and React, checks frame isolation, and restores the selected preview after reload.

- [Web search](./web-search.md) calls a search tool, reads its results, keeps source links after reload, and shows failed and cancelled runs.
- [Code sandbox](./sandbox.md) runs Python in real containers, shows code and output, rejects a network escape, and checks the real-provider hash.
- [GitHub](./github.md) checks a read-only token and links an issue card through a local MCP fixture.
- [Memory](./memory.md) saves a fact from chat, lists it on `/memory`, and sends it with a later question.
- [Dreaming](./dreaming.md) reads the day's chats into memory, then a second run leaves the counts unchanged.
- [Public URL](./public.md) checks that Cloudflare Access guards the public URL and that local sign-in still works.
