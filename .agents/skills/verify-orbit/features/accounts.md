# Account isolation

Check that two test accounts keep their chats, memories, provider connections, and GitHub tokens private. The sandbox creates the second account directly so public Personal signup can stay closed.

## Run the browser scenario

Start `node scripts/qa/mock-ollama.mjs` and note the port it prints. Set `ORBIT_OLLAMA_URL` to that loopback address. Use the same `ORBIT_VERIFY_PORT` for each command.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs seed-member
node .agents/skills/verify-orbit/verify.mjs browse accounts-scope
node .agents/skills/verify-orbit/verify.mjs cleanup
```

Stop the mock Ollama process you started. You can omit `seed-member` when running the browser scenario. It creates the same test account if needed.

## Check the evidence

Require every step in `.verify/evidence/accounts-scope/summary.txt` to pass. The member signs in through `/login` in a separate browser context and adds its own connection. The member gets a 404 when opening the admin's chat or the Admin page. The admin settings API returns 403 to the member.

The member starts with an empty Memory page. Its own notes appear in its next model request, and the admin's notes and GitHub tools stay private. Switching Memory off removes the member's notes and memory tools from its next request. The admin retains its note and Memory setting.

Open `member-memory-empty.png`, `member-admin-404.png`, `forget-refused.png`, and `memory-off.png`. Inspect `admin-page.png`, `admin-page-390.png`, and `admin-page-360.png` for the saved Search URL and page width. `member-provider-requests.jsonl` records the observed notes and tool names without session cookies or key values.

On a fresh, non-mock launch, `drive signup` checks that the first account becomes admin, `GET /api/setup` closes signup, and a second public signup returns 403.
