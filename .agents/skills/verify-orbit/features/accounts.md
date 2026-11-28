# Check hosting modes and account isolation

Use a fresh verify sandbox with the mock provider. The browsers use separate sessions for the admin, the Team member, and the Community member.

## Run the browser scenarios

Start `node scripts/qa/mock-ollama.mjs` and note the port it prints. Set `ORBIT_OLLAMA_URL` to that loopback address. Use the same `ORBIT_VERIFY_PORT` for each command.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse accounts
node .agents/skills/verify-orbit/verify.mjs browse accounts-scope
node .agents/skills/verify-orbit/verify.mjs cleanup
```

Stop the mock Ollama process you started.

## Check hosting modes

Read `.verify/evidence/accounts/summary.txt`. The Team member signs up using an invite, chooses a model, and chats on an admin connection. Check that the invite fails on reuse and that the Team member cannot manage connections.

The admin cannot switch to Personal while a member exists. Remove the member from the 360-pixel admin page and check that the member's session ends. In Community, verify open signup and check that the connection form refuses a private URL. Then use the local mock provider, send a message, and switch to Team to continue the same chat on an admin connection.

With other accounts present, switching between Team and Community opens a confirmation that Cancel dismisses with no request. The scenario also checks keyboard focus: Create invite lands on the selected invite link, and Revoke and Remove land on the next row or the section.

Inspect the admin captures at 1280, 390, and 360 pixels. The invite creation capture covers the one-time link.

## Check account isolation

Read `.verify/evidence/accounts-scope/summary.txt`. The scenario switches to Community and seeds a member directly. The member adds their own connection and gets a 404 when they open the admin's chat or the Admin page. The admin settings API returns 403 to the member.

The member starts with an empty Memory page. Their notes appear in their next model request. The admin's notes and GitHub tools stay private. Switching Memory off removes the member's notes and memory tools from their next request. The admin retains their note and Memory setting.

Inspect `member-memory-empty.png`, `member-admin-404.png`, `forget-refused.png`, and `memory-off.png`. Check `admin-page.png`, `admin-page-390.png`, and `admin-page-360.png` for the saved Search URL and page width. Read `member-provider-requests.jsonl` for the observed notes and tool names.

Both scenarios remove the fixture members and return the sandbox to Personal. On a fresh launch without the mock provider, `drive signup` checks that the first account becomes admin, `GET /api/setup` closes signup, and a second public signup returns 403.
