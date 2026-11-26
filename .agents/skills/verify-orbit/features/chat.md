# Chat

Chat sends one user message, streams the assistant reply, and shows both after a reload.

## Sub-features

- `chat-send` posts one turn and reads streamed text.
- `chat-reload` reads the user and assistant messages from the API and from SQLite.
- `chat-new` creates another chat from `POST /api/chats`. The sidebar button name is `New chat`.

## How to get to it (user POV)

- Sign in. The home page opens the latest chat or creates one.
- Type in the box whose placeholder is `Ask anything`, then send.
- `New chat` in the sidebar starts another thread. Each thread is a link `/c/<id>`.

## Driving it with verify-orbit

Preconditions:

- `node .agents/skills/verify-orbit/verify.mjs doctor` prints `doctor ok`.
- The sandbox database is empty, or its only user is `smoke@orbit.local`. `scripts/smoke.ts` signs up that account and cannot run after a different first user. If `drive signup` already ran, this drive fails. Use a fresh launch.
- `ORBIT_BASE_URL` and `ORBIT_API_KEY` are set in the environment. If either is missing, the drive fails before calling the provider.

- **Stream and reload.** The drive runs `npx tsx scripts/smoke.ts` with cwd `.verify/sandbox` and `ORBIT_QA_ORIGIN` set to the sandbox origin. The script signs up `smoke@orbit.local`, falls back to signing in when that account exists, adds a connection from `ORBIT_BASE_URL` and `ORBIT_API_KEY` (or reuses the one with that base URL), makes `ORBIT_MODEL` or `deepseek-v4.1-flash` the default model, lists the connection's models, posts one chat turn, checks streamed text, reloads `GET /api/chats/:id`, and reads `data/orbit.db`.
- **Command.** Run `node .agents/skills/verify-orbit/verify.mjs drive chat`.
- **Proof.** `.verify/evidence/chat/summary.txt` contains the smoke exit code and the redacted smoke log, including `smoke passed` on success.

## Gotchas

- One user per database. Signup as `verify@orbit.local` blocks smoke. Do not delete the user to force a pass. Launch a new sandbox instead.
- The smoke log must not contain the provider key. The helper replaces `ORBIT_API_KEY` with `[redacted]`. If the raw key appears, the drive is not safe to keep.
- `New chat` is a separate entry point. `drive chat` creates the chat smoke needs. It does not click the sidebar button. Say so when you report the proof.
