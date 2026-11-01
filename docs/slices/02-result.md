# Slice 2 result

The model can call `render_ui`. The chat stores that spec, and a reload still has it.

## What was verified

Host tools: Node v26.13.0, npm 11.20.0. The browser QA is in `docs/qa/2026-11-01-genui-qa.md`. A server render check and the HTTP smoke cover the rest.

`npm run typecheck` (`tsc --noEmit`) exited 0.

`npx tsx --test src/lib/genui/spec.test.ts src/components/genui/render.test.tsx` exited 0. Seven tests passed. A card with a numeric title fails and does not throw. A metric value of `1` is stored as the string `"1"`. `renderToStaticMarkup` of a Card plus a Metric includes the title Smoke, the label Checks, and the value 1.

The first `npm run build` failed while 15 page-data workers raced the SQLite migration (`table account already exists`). That race is in the existing database startup. The retry exited 0. Later builds, after the auth origin change and after numeric values were accepted, also exited 0. Routes are unchanged from slice 1: `/`, `/login`, `/signup`, `/settings`, `/c/[id]`, and the same API routes.

`npm start -- -p 3211 -H 127.0.0.1` came up at `http://127.0.0.1:3211` (ready in 108ms). The server log showed the provider key length 51 and did not contain the key. The process was stopped after the check. Port 3211 was free afterward. Port 3210 stayed in use by another Next server and was not touched.

## Provider key

The key was read from `API_OPEN_AI_API_KEY` in `~/kodus/.env` inside the server and smoke processes. It was mapped to `ORBIT_API_KEY` and not printed. Kodus files were not edited.

Base URL for the run was `https://opencode.ai/inference/go/openai/v1`. The model was `deepseek-v4.1-flash`.

## Smoke

Command: `npx tsx scripts/smoke-genui.ts` against `http://127.0.0.1:3211`. Exit 0.

```
signed in
settings saved model=deepseek-v4.1-flash keySet=yes
stream bytes=3076 types=start,start-step,reasoning-start,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta,reasoning-delta
reload spec root=card elements=2
db spec root=card elements=2
genui smoke passed
```

The settings response had no `apiKey` field. `GET /api/chats/:id` returned an assistant message whose `tool-render_ui` part had `state` `output-available` and `output.ok` true. The spec root was `card` and the element types were Card and Metric. `parseRenderSpec` accepted it. The same part is in `data/orbit.db`. The assistant `content` column can be empty. The parts JSON is what reload uses.

An earlier call on the same server, before numeric values were accepted, did call `render_ui`. The saved result was `ok: false` because the metric value was the number 1. The catalog now stores that number as text, and the smoke above is the run after that change.

## Notes

- `@json-render/core` and `@json-render/react` are pinned at 0.21.3. The unscoped package `json-render` is not on npm.
- `catalog.zodSchema()` does not check prop types once the catalog has more than one component. `parseRenderSpec` checks each element's props, then `validateSpec`.
- `catalog.prompt()` asks for a JSONL patch stream, so the chat instructions are a short string in `src/lib/genui/catalog.ts`.
- The element field `on` is not in the spec schema, so the button action is the prop `action: "note"`.
- Auth no longer trusts the fixed 3211 origins. The smoke server must set `ORBIT_TRUSTED_ORIGINS=http://127.0.0.1:3211` when `BETTER_AUTH_URL` stays on port 3210.
- The chat UI was not clicked in the first run. The later browser QA is in `docs/qa/2026-11-01-genui-qa.md`.

## Review fixes

The review round added table-width validation, persistence for stopped `render_ui` replies, an ownership-checked migration lock, private data-directory and auth-secret modes, deployment-only auth origins, and the QA harness fixes. `npm test` runs 87 tests. The browser QA, smoke, lock interleaving, two-process migration, and auth-origin probes all pass on this branch. The details are in `docs/qa/2026-11-01-genui-qa.md` and the PR thread.
