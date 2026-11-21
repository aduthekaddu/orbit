# Sign in

Sign in takes the existing account from `/login` back to a chat.

## Sub-features

- `signin-page` shows the sign-in form.
- `signin-session` accepts the verify account and opens a chat.

## How to get to it (user POV)

- Open `http://127.0.0.1:<port>/login`.
- Submit Email, Password, and `Sign in`.
- From a chat, the sidebar `Sign out` button returns to `/login`.

## Driving it with verify-orbit

Preconditions:

- `node .agents/skills/verify-orbit/verify.mjs doctor` prints `doctor ok`.
- `drive signup` has already created `verify@orbit.local` in this sandbox. If `signupOpen` is still `yes`, this drive fails. Run signup first. Do not invent a second account.

- **Open the form.** Visit `/login`. The drive checks HTTP 200 and the text `Sign in`.
- **Sign in.** The drive posts `verify@orbit.local` and the fixture password to `/api/auth/sign-in/email`. Status 200.
- **Land in a chat.** `GET /` with the session cookie returns 302 or 307 and the location contains `/c/`.
- **Command.** Run `node .agents/skills/verify-orbit/verify.mjs drive signin`.
- **Proof.** `.verify/evidence/signin/summary.txt` contains the page check, the sign-in status, and the redirect.

## Gotchas

- A wrong password returns an error body and does not redirect. Treat that as a failed sign-in, not as a closed signup.
- This drive does not click `Sign out`. The logged-out gate is the 401 in the signup proof.
