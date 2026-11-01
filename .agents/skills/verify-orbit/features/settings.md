# Settings

Settings stores a base URL, a model, and a key on the server. The browser receives `keySet` and never the key.

## Sub-features

- `settings-page` shows the form for a signed-in user.
- `settings-save` stores the provider and omits the key from the response.
- `settings-read` returns the same public shape.

## How to get to it (user POV)

- Sign in, then open `Settings` in the sidebar. The link is `/settings` and the visible text is the account email.
- Fields are `Base URL`, `API key`, `Model`, and `Save`. `Reasoning` is a slider labeled `Reasoning effort` when the selected model allows it.

## Driving it with verify-orbit

Preconditions:

- `node .agents/skills/verify-orbit/verify.mjs doctor` prints `doctor ok`.
- The sandbox can sign in as `verify@orbit.local`. If signup is still open, the drive creates that account first. If another account already owns the database, the drive fails.

- **Open settings.** `GET /settings` with the session cookie returns 200.
- **Save.** `PUT /api/settings` sends base URL `https://example.com/v1`, model `example-model`, reasoning `low`, and the fake key `test-key-not-real`. Status 200, `keySet` true, model `example-model`, and no `apiKey` field.
- **Read back.** `GET /api/settings` returns 200, has no `apiKey` field, and the body does not contain the fake key.
- **Command.** Run `node .agents/skills/verify-orbit/verify.mjs drive settings`.
- **Proof.** `.verify/evidence/settings/summary.txt` records the page status, both payloads' key checks, and `keySet`.

## Gotchas

- This drive does not call a model provider. `https://example.com/v1` is enough to prove the key stays on the server.
- A real provider check is the chat drive, which needs `ORBIT_BASE_URL` and `ORBIT_API_KEY`.
- The model dropdown loads `POST /api/models` when the base URL or the key field blurs. Overlapping loads must keep the newer response. This drive does not time that race.
