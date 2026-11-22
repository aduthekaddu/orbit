# Memory

Run `node .agents/skills/verify-orbit/verify.mjs launch --mock` with `ORBIT_OLLAMA_URL` pointing at `scripts/qa/mock-ollama.mjs`. Then run `doctor`, `browse memory`, and `cleanup`.

The browser sends `[qa:remember] I deploy to Fly.io`. The mock provider calls `remember`. The remember card shows that text. `/memory` lists that fact and shows **Embeddings on**. A new chat sends `[qa:plain] Where should hosting live?` so the mock answers `pong`. The next mock request carries `I deploy to Fly.io` as quoted notes on the user message, and the system message does not contain that text. A 500 character memory with no spaces stays inside the remember card and the `/memory` row, on desktop and at 390 by 844. An edit of 501 characters shows the server's reason. A shorter edit changes the text. With the mock set to fail, the page shows the Ollama error and recall still has full text search. Delete asks once. The next chat does not send the deleted text.

The scenario saves `page.png`, `edited.png`, `ollama-down.png`, `long-card.png`, `long-row.png`, and `mobile.png` under `.verify/evidence/memory/`. The phone shot is 390 by 844.

`scripts/qa/mock-provider.mjs` appends each request body to `.verify/mock-requests.jsonl`.

`browse no-search-final-answer` turns search off and sends `[qa:remember-loop] keep notes`. The mock calls `remember` while the step offers it and answers `Answered after four notes.` when it does not. Require four remember cards, five model steps, and the answer text, before and after a reload. The scenario deletes the `Loop note` memories it made. It saves `final-answer.png` and `reloaded.png`.
