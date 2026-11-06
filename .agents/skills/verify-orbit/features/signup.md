# Sign up

Sign up creates the only account from `/signup`, opens a new chat, and rejects a second account.

## Sub-features

- `signup-page` shows the create-account form while the user table is empty.
- `signup-create` stores that account and opens a chat.
- `signup-closed` rejects another account.
- `signup-gate` hides chats from a logged-out request.

## How to get to it (user POV)

- Open `http://127.0.0.1:3210/signup` and submit Name, Email, Password, and `Create account`.
- After the account exists, `/signup` shows `Signup is closed` and a `Sign in` link.

## Driving it with verify-orbit

Preconditions:

- `node .agents/skills/verify-orbit/verify.mjs doctor` prints `doctor ok`.
- `signupOpen` is `yes`. An empty sandbox from launch has this. If it is `no`, the drive fails and the reason is a user already in the sandbox database.

- **Open the form.** Visit `/signup`. The drive checks HTTP 200 and the text `Create account`.
- **Create the account.** The drive posts name `Verify`, email `verify@orbit.local`, and the fixture password to `/api/auth/sign-up/email` with `Origin: http://127.0.0.1:3210`. Status 200.
- **Land in a chat.** `GET /` with the session cookie returns 302 or 307 to `/c/<id>`. `GET` that path returns 200 and the text `Connect a provider`, because the sandbox has no provider yet. After a provider is saved, the text is `Ask anything`.
- **See the chat in the list.** `GET /api/chats` returns 200 and at least one chat. The same request without a cookie returns 401.
- **Read the database.** `.verify/sandbox/data/orbit.db` has 1 row in `user` and at least 1 row in `chats`.
- **Second account.** A signup for `other@orbit.local` returns 403.
- **Command.** Run `node .agents/skills/verify-orbit/verify.mjs drive signup`.
- **Proof.** `.verify/evidence/signup/summary.txt` contains each status, the redirect, and the row counts.

## Gotchas

- Signup closes after the first user. A sandbox that already has a user fails this drive. Do not delete that user to force a pass.
- The home page creates a chat and redirects. A 200 on `/` with no redirect means the session was missing or the page did not run.
- The fixture password is not a provider key. Keep it out of the evidence file. The helper redacts it.
