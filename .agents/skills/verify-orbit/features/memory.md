# Memory

Run `node .agents/skills/verify-orbit/verify.mjs launch --mock` with `ORBIT_OLLAMA_URL` pointing at `scripts/qa/mock-ollama.mjs`. Then run `doctor`, `browse memory`, and `cleanup`.

The browser sends `[qa:remember] I deploy to Fly.io`. The mock provider calls `remember`. `/memory` lists that fact and shows **Embeddings on**. A new chat sends `[qa:plain] Where should hosting live?` so the mock answers `pong`. The next mock request carries `I deploy to Fly.io` as quoted notes on the user message, and the system message does not contain that text. Edit changes the text. With the mock set to fail, the page shows the Ollama error and recall still has full text search. Delete asks once. The next chat does not send the deleted text.

The scenario saves `page.png`, `edited.png`, `ollama-down.png`, and `mobile.png` under `.verify/evidence/memory/`. The phone shot is 390 by 844.

`scripts/qa/mock-provider.mjs` appends each request body to `.verify/mock-requests.jsonl`.
