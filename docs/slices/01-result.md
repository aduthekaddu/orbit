# Slice 1 result

Walking skeleton is on branch `feat/walking-skeleton`. A local user can sign up, store a provider on the server, and stream a chat that is still there after reload.

## What was verified

Host tools: Node v26.13.0, npm 11.20.0. The Docker image is `node:22-bookworm-slim`. No browser was available, so page checks are HTTP status and redirect targets.

`npm run typecheck` (`tsc --noEmit`) exited 0.

`npm run build` (Next.js 16.4.3) exited 0. Routes: `/`, `/login`, `/signup`, `/settings`, `/c/[id]`, `/api/auth/[...all]`, `/api/setup`, `/api/settings`, `/api/models`, `/api/chats`, `/api/chats/[id]`, `/api/chat`.

`npm start -- -p 3210 -H 127.0.0.1` came up at `http://127.0.0.1:3210` (ready in 128ms). The server log did not contain the provider key. The process was stopped after the checks. Nothing else was left listening on 3210.

`docker compose build` exited 0 and tagged `orbit-orbit:latest`. The container was not started. `docker compose config` publishes `127.0.0.1:3210` to container port 3210 only.

Logged-out HTTP, without following redirects:

- `GET /`, `GET /settings`, `GET /c/does-not-exist` → 307 `Location: /login`
- `POST /api/chat`, `GET /api/settings`, `GET /api/chats` → 401 `{"error":"Unauthorized"}`
- A second `POST /api/auth/sign-up/email` → 403 `{"message":"Signup is closed"}`

## Provider key

`~/kodus/providers/opencode-go.env` names are `API_OPEN_AI_API_KEY`, `API_OPENAI_FORCE_BASE_URL`, and `API_LLM_PROVIDER_MODEL`. The key value in that file is empty (length 0). The base URL value length is 27, which is the internal proxy name, not the public OpenCode URL.

The same three names are set in `~/kodus/.env` for the provider that is already active. That key has length 51 and an `oc_sk` prefix. Smoke mapped it to `ORBIT_API_KEY` inside the process environment and did not print it. Kodus files were not edited, and Kodus containers were not restarted.

Base URL used for the run: `https://opencode.ai/inference/go/openai/v1`. Model saved by smoke: `deepseek-v4.1-flash`. Reasoning effort saved by smoke: `low`.

`GET {baseURL}/models` on that host returns 404. `POST {baseURL}/chat/completions` with the key and `reasoning_effort` returns text. A direct probe (status and length only) got HTTP 200 and a 4-character reply before the app smoke. The model list used after the follow-up is `https://opencode.ai/zen/go/v1/models`.

## Smoke

Command: `npx tsx scripts/smoke.ts` against the running server. Exit 0.

```
opencode session header: yes
signed up
settings before save keySet=yes
settings saved model=deepseek-v4.1-flash keySet=yes
streamed chars=4 preview="pong"
reload messages=2
db chat=1 messages=2 roles=assistant,user
smoke passed
```

`keySet=yes` before the save is the env seed: the server was started with `ORBIT_BASE_URL`, `ORBIT_API_KEY`, and `ORBIT_MODEL`, and the settings row did not exist yet. The save response had no `apiKey` field and did not echo the key.

After the server stopped, SQLite had 1 user, 1 chat, and 2 messages (user content length 31, assistant content length 4). Settings row: model `deepseek-v4.1-flash`, reasoning `low`, base URL `https://opencode.ai/inference/go/openai/v1`, key length 51. `data/orbit.db` and `data/auth-secret` are gitignored. The database file is mode 600 because it holds the key.

## Notes

- `json-render@0.21.3` is not on npm. Later generative UI will use `@json-render/core@0.21.3` and `@json-render/react@0.21.3`. They are not installed in this slice.
- `@ai-sdk/react` 4.0.163 is installed because `@assistant-ui/react-ai-sdk` 1.4.21 needs it. It was not in the original pin list.
- The chat UI was not clicked in a browser. Reload was checked with `GET /api/chats/:id` and by reading `data/orbit.db`.

## Follow-up

`npm run typecheck` and `npm run build` exited 0 again. Smoke against the same server and the same key mapping exited 0:

```
reasoning gate: yes
opencode session header on request: yes
signed in
settings before save keySet=yes
settings saved model=deepseek-v4.1-flash keySet=yes
models=28 deepseek-v4.1-flash reasoning=yes
streamed chars=4 preview="pong"
reload messages=2
db chat=1 messages=2 roles=assistant,user
smoke passed
```

The session-header line is from a captured chat request: for the OpenCode Go base URL the outgoing fetch carried `x-opencode-session: chat-1`, and the same call against `https://example.com/v1` did not. The model list tries `{baseURL}/models` first, then the Zen URL, and returns all 28 models. `deepseek-v4.1-flash` has reasoning metadata, so the effort slider stays available. A model whose metadata says reasoning is unsupported hides the slider. Missing metadata leaves it available. The settings dropdown lists every model and keeps a Custom text field.

The server log did not contain the provider key. The process was stopped after smoke. Port 3210 was left free. The container was not started.

## Open chat

assistant-ui replaced the first message's request id with a `__LOCALID_` thread id. The server stored that turn on a new chat. The open chat stayed empty. Chrome on `/c/06912e11-8862-4329-8b9f-724ff1e39a37` posted `__LOCALID_goc1iwqd026`. Reload of the open chat returned 0 messages.

`npx tsx scripts/smoke.ts` against the dev server exited 1 before the fix:

```
first message used id=__LOCALID_18ac68adb8b6 open=d321a1f5-72b7-4fbd-8dcf-2f6bbd222c40
```

`orbitChatTransport` sets the request id back to the open chat. The same smoke then exited 0:

```
streamed chars=4 preview="pong"
first message chat id matches open chat: yes
reload messages=2
db chat=1 messages=2 roles=assistant,user
smoke passed
```

Chrome on `/c/fef162ad-d85a-4842-8279-ab544685a86b` posted that same id. Reload returned 2 messages. The sidebar New chat button was not clicked. The chat came from `POST /api/chats`, then the page was opened.

`npm run typecheck` and `npm run build` (Next.js 16.4.3) exited 0. `npm start -- -p 3210 -H 127.0.0.1` was ready in 111ms. Smoke against that server exited 0 with the same passing lines. The server log did not contain the provider key. The process was stopped. Port 3210 was free afterward.

`node .agents/skills/verify-orbit/verify.mjs launch` printed `ready` and `signupOpen=yes` on an empty sandbox. `doctor` printed `doctor ok`. `drive chat` printed `drive chat passed` and `smoke passed`, including `first message chat id matches open chat: yes`. A second sandbox ran `drive signup`, `drive signin`, and `drive settings`. Each printed passed. Cleanup removed `.verify/sandbox` and left `.verify/evidence/`.

## Greptile fixes

All four findings reproduced in the code before the change.

P1. `saveSettings` reused `current.apiKey` when the submitted key was blank, even after the base URL changed. The settings route now compares the normalized new base URL with the saved one and returns 400 `Base URL changed. Enter the API key for the new provider.` when the key is blank. `saveSettings` also stops carrying the old key across a base URL change.

P2. `upsertMessage` looked up a message by id only, then updated by id. A message id reused under chat B could change chat A. The lookup now reads `chatId`, returns false on a mismatch, and `POST /api/chat` answers 409 `A message id belongs to a different chat.`

P3. `verify.mjs cleanup` killed the process group but waited only for the recorded npm pid. It now waits for that pid and port 3210 to be free, sends SIGKILL after five seconds, and leaves the sandbox in place if the port is still held.

P4. `driveSettings` now requests `/settings` and checks status 200 plus the labels `Base URL`, `API key`, `Model`, and `Save`. It checks the save and read status, `keySet`, `baseUrl`, `model`, and `reasoningEffort`, then checks that a base URL change with no key returns 400.

Commands run from `~/orbit`:

- `npm run typecheck` exited 0.
- `npm run build` (Next.js 16.4.3) exited 0 with the same route list as above.
- `npx tsx scripts/smoke.ts` against `npm start -- -p 3210 -H 127.0.0.1` exited 0:

```
reasoning gate: yes
opencode session header on request: yes
signed in
settings before save keySet=yes
settings saved model=deepseek-v4.1-flash keySet=yes
models=28 deepseek-v4.1-flash reasoning=yes
streamed chars=4 preview="pong"
first message chat id matches open chat: yes
reload messages=2
db chat=1 messages=2 roles=assistant,user
smoke passed
```

- A temporary database called `upsertMessage` with chat A's message id from chat B. It returned false, chat A kept its content, and the same-chat update still saved. Output: `message chat guard passed`.
- verify-orbit ran two sandboxes. The first ran `launch`, `doctor`, and `drive chat`; the second ran `launch`, `doctor`, `drive signup`, `drive signin`, and `drive settings`. Every command exited 0:

```
ready origin=http://127.0.0.1:3210 pid=3498080 signupOpen=yes
doctor ok
drive chat passed
cleanup done. evidence remains at /home/ubuntu/orbit/.verify/evidence
ready origin=http://127.0.0.1:3210 pid=3498290 signupOpen=yes
doctor ok
drive signup passed
drive signin passed
drive settings passed
cleanup done. evidence remains at /home/ubuntu/orbit/.verify/evidence
```

The settings evidence records the page and payload checks:

```
settings page status 200
settings page has labels yes
save status 200
save has apiKey no
save keySet yes
save baseUrl https://example.com/v1
save model example-model
save reasoningEffort low
read status 200
read has apiKey no
read keySet yes
read baseUrl https://example.com/v1
read model example-model
read reasoningEffort low
read contains key text no
base change without key status 400
base change without key error Base URL changed. Enter the API key for the new provider.
```

The smoke server log did not contain the provider key. Cleanup removed `.verify/sandbox`, left `.verify/evidence/`, and port 3210 was free after each phase.

## CodeAnt fixes

Five inline findings. Three reproduced and are fixed. Two did not reproduce.

1. `next-env.d.ts` imports `.next` types. Not reproduced. A `git archive` of HEAD with no `.next` ran `npm run typecheck` and exited 0. `skipLibCheck` covers the declaration file.
2. `POST /api/chat` rewrote every message in the client history on each send. Reproduced. `persistIncoming` now reads the stored rows in one query and writes only new or changed rows. A resend of three stored messages performs 0 writes. Adding one new message performs 1.
3. `normalizeBaseUrl` did not lowercase the host. Reproduced. It now canonicalizes through `new URL`, so `https://OpenCode.AI/...` gets the session header. Path case still identifies a different provider.
4. `loadModels` kept the old provider's models after a network failure. Fixed by clearing the list on the non-abort error path. The repo has no client test harness, so this one is covered by typecheck and build only.
5. SQLite sidecars. Not reproduced. The database file is chmod 600 before the first write. SQLite creates `-wal` and `-shm` with the database file's mode. The app's own module left `orbit.db`, `-wal`, and `-shm` at 600.

The Greptile blocking finding (`apiKey: ***` in `verify.mjs`) was not present at HEAD. `node --check` parsed the file.

The verify-orbit skill moved from `.cursor/skills/verify-orbit` to `.agents/skills/verify-orbit`. Its docs and this file point at the new path.

Commands run from `~/orbit`:

- `npm test` before the fixes: 6 tests, 2 pass, 4 fail. The failures were `3 !== 0` and `2 !== 1` for history writes, and `https://OpenCode.AI/...` versus `https://opencode.ai/...` for URL matching.
- `npm test` after the fixes: 6 tests, 6 pass, exit 0.
- `npm run typecheck` exited 0.
- `npm run build` (Next.js 16.4.3) exited 0.
- `node .agents/skills/verify-orbit/verify.mjs launch` printed `ready` and `signupOpen=yes`. `doctor` printed `doctor ok`. `drive chat` against a local fake OpenAI-compatible provider printed `smoke passed` and `drive chat passed`. `cleanup` removed the sandbox and left the evidence.
