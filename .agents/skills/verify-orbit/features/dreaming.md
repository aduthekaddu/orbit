# Dreaming

Run `node .agents/skills/verify-orbit/verify.mjs launch --mock` with `ORBIT_OLLAMA_URL` pointing at `scripts/qa/mock-ollama.mjs`. Then run `doctor`, `drive dream`, `drive dream` again, and `cleanup`.

The first drive seeds three chats where the user states facts and the model never called `remember`. It runs `npm run dream` against the sandbox database and prints the run counts and the memory count. The second drive prints the same counts. `/memory` shows those facts and a status line with the chat, added, and merged counts.

Screenshots land in `.verify/evidence/dreaming/` as `before.png`, `after.png`, and `mobile.png`. The phone shot is 390 by 844. Evidence stays after cleanup.
