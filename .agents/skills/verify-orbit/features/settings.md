# Settings

Settings stores provider connections, the default model, and the search and GitHub settings on the server. Each connection's API key is encrypted in the database. The browser receives `keySet` and never a key.

## Sub-features

- `settings-page` shows the Connections, Default model, and Models sections for a signed-in user.
- `connection-save` adds a connection after listing its models, and omits the key from the response.
- `connection-edit` changes a label, and refuses a new base URL without a new key.
- `default-model` saves the default connection, model, and effort.
- `connection-delete` removes a connection and clears the defaults that name it.

## How to get to it (user POV)

- Sign in, then open `Settings` in the sidebar. The link is `/settings` and the visible text is the account email.
- **Connections** lists each connection with **Add**, **Edit**, and **Delete**. **Default model** has a connection, a model, and the effort levels. **Models** shows or hides each model in the picker.

## Driving it with verify-orbit

Preconditions:

- `node .agents/skills/verify-orbit/verify.mjs doctor` prints `doctor ok`.
- The sandbox can sign in as `verify@orbit.local`. If signup is still open, the drive creates that account first. If another account already owns the database, the drive fails.

- **Open settings.** `GET /settings` with the session cookie returns 200 and shows `Connections` and `Default model`.
- **Unreachable provider.** `POST /api/connections` with a base URL that lists no models returns 502 and saves nothing.
- **Save.** `POST /api/connections` sends the mock's base URL and the fake key `test-key-not-real`. Status 201, `keySet` true, and no `apiKey` field. `GET /api/connections` lists it, and `GET /api/connections/<id>/models` lists `mock-genui`.
- **Edit.** `PATCH` with a new label returns the new label. `PATCH` with a new base URL and no key returns 400 naming the API key, and the saved base URL stays.
- **Default model.** `PUT /api/preferences/model` with `mock-genui` at `high` returns those values. An effort outside the six levels returns 400.
- **Delete.** `DELETE /api/connections/<id>` removes it, and `GET /api/preferences/model` no longer names it. The drive then restores the defaults it found.
- **Command.** Run `node .agents/skills/verify-orbit/verify.mjs drive settings`.
- **Proof.** `.verify/evidence/settings/summary.txt` records each status, the key checks on every response, the settings fields, and whether `orbit.db` holds the key.

### Connection and effort regressions in Chromium

With `launch --mock`, run `node .agents/skills/verify-orbit/verify.mjs browse settings-review`.
The scenario runs at 1280×800 and 390×844. It replaces or repairs a connection from an empty chat's setup screen, then saves a model and opens the composer. It tries to dismiss pending Add, Edit, and Delete dialogs and checks that switching provider types clears the previous draft. It saves a custom model with an available effort and opens the composer with an older default to check that no disabled effort is selected.

The summary and screenshots are in `.verify/evidence/settings-review/`.

## Gotchas

- Adding a connection, or changing its base URL or key, lists the provider's models first. The drive starts the mock provider when none runs, and `cleanup` stops it.
- `GET /api/settings` holds only the search, GitHub, and sandbox fields. A `PUT /api/settings` with provider fields returns 200 and changes nothing, because the route drops unknown fields.
- A real provider check is the chat drive, which needs `ORBIT_BASE_URL` and `ORBIT_API_KEY`.
