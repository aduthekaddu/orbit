# Slice 1 result

Walking skeleton is on branch `slice-1`. A local user can sign up, store a provider on the server, and stream a chat that is still there after reload.

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

`GET {baseURL}/models` on that host returns 404, so the settings model control stays a text field. `POST {baseURL}/chat/completions` with the key and `reasoning_effort` returns text. A direct probe (status and length only) got HTTP 200 and a 4-character reply before the app smoke.

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
