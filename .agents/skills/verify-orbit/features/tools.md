# Tools

This recipe checks the `/tools` page, the **Test** buttons, and the per-chat tool switches behind **+** in the composer, in Chrome. It uses the mock provider, a local SearXNG fixture, and a local GitHub MCP fixture. It calls no outside service.

## Run

From the repo root, after `npm run build`. If port `3210` runs a live instance, export `ORBIT_VERIFY_PORT=3230` first and keep it through `cleanup`.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse tools
node .agents/skills/verify-orbit/verify.mjs cleanup
```

Use a sandbox with no saved Tavily key and no saved GitHub token. The scenario stops if either is set, because it cannot put a key it never read back. It starts and closes its own `startMockSearxng` and `startMockMcp` fixtures inside `try` and `finally`. At the end it restores the search URL, the GitHub token, Memory, and Personal mode. It also deletes its chats, its `I prefer green tea` memory, and the seeded member.

## Proof

Read `.verify/evidence/tools/summary.txt`. Every line must be `PASS`.

- `GET /tools` returns 200 with 5 rows. On a build without the page this is the first line, and it fails with status 404.
- On a fresh sandbox at 1280 by 800, **Web search** shows `Off` with **Set up** to `/admin#search`. **Code sandbox** shows `Off` with no **Set up** while `ORBIT_SANDBOX` is unset. **GitHub** shows `Off` with **Set up** to `/settings#github`. **Memory** shows **Test**. **Generated UI** shows `On` with no **Test**. **Set up** lands on the Search card and the GitHub card. The sidebar and the command palette both reach **Tools**.
- After the mock SearXNG URL is saved on `/admin`, **Test** on **Web search** shows `Working`, `3 results · <duration>`, and `now`. A second press right away gets 429 and shows `Wait a moment before testing again.`, and the row stays `Working`.
- After the mock GitHub token and MCP URL are saved on `/settings`, **Test** on **GitHub** shows `Working` and `octocat` and closes its MCP session. **Test** on **Memory** shows `Working` and the count from `GET /api/memories`, with ` · Text search only` when Ollama is down.
- Saving `http://127.0.0.1:9` resets **Web search** to `Not tested`. After the rate-limit window from `Retry-After`, **Test** shows `Failing` and `Search is unavailable`. No `/api/tools*` body holds the Tavily key, the GitHub token, the provider key, or either SearXNG URL.
- Expanding **Web search** shows `web_search`, its description, its JSON Schema, and the search instruction under **System instruction**. The schema on the page deep-equals `function.parameters` for `web_search` in the `[qa:tools] hi` request in `.verify/mock-requests.jsonl`. Expanding **GitHub** lists `github_*` tools, and the MCP fixture has no open session after.
- In a draft from `/new`, the **+** popover lists Web search, GitHub, and Memory, all on, and never Generated UI. Turning **Web search** off sends no `PATCH /api/chats/*` and changes **+** to `Tools (1 off)` with the sun dot. The first `[qa:tools] hi` reply and its request leave out `web_search`. After reload the switch is still off. A second new chat starts with it on.
- In a saved chat, `[qa:tools] What tea do I prefer?` carries `Saved notes follow`, the remember instruction, and `remember` and `forget` while Memory is on. Turning **Memory** off returns PATCH 200 and leaves the chat order, the sidebar order, and that chat's `updatedAt` alone. The same question then carries none of the four.
- With `PATCH /api/chats/<id>` answered by 500, a switch goes back and the popover shows `Could not save tools.` The stored list stays `["memory"]`.
- After a search URL save, `[qa:search] orbit` in a chat turns **Web search** from `Not tested` to `Working` with no **Test** press.
- Keyboard: Tab reaches the **Web search** row button, Enter expands it, Space collapses it, Tab reaches **Test**, and Enter runs it while focus stays on **Test**. In a chat, Tab goes from the composer to **+** and then the model chip. Enter opens the popover, Space toggles a switch and leaves it open, and Escape closes it and puts focus back on **+**.
- At 390 by 844 and 360 by 740 with touch, every row button and **Test** or **Set up** is at least 44px tall, and each pair sits on two lines. `/tools` has no sideways overflow. At 390 the open schema scrolls inside its well. In a chat, **+** opens the bottom sheet with 44px rows and the **Tools** link. **+**, the model chip, and **Send** share one row inside the screen.
- In Team mode a seeded member sees five rows. **Web search** shows `Not tested` with **Test** and no **Set up**. **Code sandbox** has no **Set up**. **GitHub** shows **Set up**. **Memory** shows `Not tested` with **Test**, and its **Configure** link goes to `/settings#memory`. The member's **Test** on **Web search** shows `3 results`, and `PATCH` on the admin's chat returns 404. In Community the member still sees their own status, and no body holds an admin secret.
- Signed out, `GET /api/tools`, `GET /api/tools/web_search`, and `POST /api/tools/web_search/test` each return 401.

Memory keeps its health from earlier scenarios' `remember` calls, because no setting change clears it. So on a reused sandbox the first Memory line accepts `Not tested` or `Working`.

`provider-requests.jsonl` in the evidence folder holds the tool names and memory flags for each checked request, and the rendered and sent `web_search` schemas.

Screenshots in `.verify/evidence/tools/`: `page.png`, `expanded.png`, `failing.png`, `popover.png`, `save-failed.png`, `page-390.png`, `expanded-390.png`, `sheet-390.png`, `page-360.png`, and `sheet-360.png`.

## Code sandbox with Docker

On a host with Docker, launch with the sandbox on and run the same scenario. **Code sandbox** then starts as `Not tested` with **Test**, and the popover lists it.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse tools
node scripts/qa/sandbox-leftovers.mjs
node .agents/skills/verify-orbit/verify.mjs cleanup
```

**Test** on **Code sandbox** must show `Working` and `Exit 0` (`sandbox-ok.png`). The leftovers script must report zero owned containers.

## Real provider

With `ORBIT_API_KEY` in the environment, never printed, turn **Web search** off in one chat and ask about today's news. The reply must have no web search line. Save the screenshot as `real-no-search.png`. CI does not run this check.
