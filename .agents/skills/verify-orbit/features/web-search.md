# Web search

This recipe checks search settings, the tool call, the model's answer, and saved cards in Chrome. It uses the local model fixture and a local SearXNG fixture. It does not call Tavily or public search engines.

## Run

From the repo root, run these commands after `npm run build`.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse search-tool
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario owns its mock search server and closes it even if a check fails. It saves a fake Tavily key to check that the API never returns it and that a blank field keeps it. The scenario then clicks Remove and Save to clear the fake key before sending search requests.

## Proof

Require each printed check to pass.

- The settings form saves a SearXNG URL and reports only whether the Tavily key is set.
- `[qa:search] orbit` starts one search card, changes it from Running to Succeeded, and shows three result links.
- The next model request receives the search output and answers with a link to its first result.
- The result links use `target="_blank"` and `rel="noopener noreferrer nofollow"`.
- The saved card and its three links survive reload.
- The card fits at 390 by 844 without page overflow.
- Stop changes an unfinished card to Cancelled. Reload preserves Cancelled.
- A search failure shows Failed, and the model still answers.
- Repeated searches use four tool steps and leave the fifth step for an answer with a source link.

Screenshots and the real output remain in `.verify/evidence/search-tool/` after cleanup. They include `running.png`, `done.png`, `reloaded.png`, `mobile.png`, `cancelled.png`, `cancelled-reloaded.png`, `failed.png`, `settings.png`, and `final-answer.png`. A run against the earlier app captures `before.png` and fails at the missing SearXNG field.

Real provider proof also needs the Compose SearXNG service. Configure its URL in Settings, ask a current-news question, and save the card and cited answer. Stop only the service this run started and repeat the question to check failure. Record the time to the final answer for five real questions separately from this fixed-response recipe.
