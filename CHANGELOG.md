# Changelog

All notable changes to Orbit are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Settings treats a 200 model list whose JSON is not a model list as a failed connection, not as a green "0 models". A real empty list is still an empty list. (#200)

- Each code sandbox container carries the label of the Orbit process that started it, and the sweep log line for a removed container names that owner, so two Orbit servers or test runs on one Docker host no longer count each other's containers as their own leftovers. (#184)
- A code run the memory limit kills no longer loses its Out of memory mark. Docker can record the kill after the run's exit event, and one read of the flag missed it, so the card sometimes said Exit 137 instead. (#66)
- An artifact preview can no longer load another web page into its frame, so its code cannot send data out in that page's URL. (#132)
- A chat turn without web search keeps its fifth and last model step for an answer. That step offers only `render_ui` and gets the earlier tool calls as JSON data, so a turn that calls tools on every step no longer ends with tool cards and no reply. (#126)
- Tab reaches Copy, Edit and Regenerate on earlier messages too, not only on the last reply. With a mouse they still show on hover, and they also show when they take focus. (#125)
- A memory save or delete that fails on the network shows "Could not save" or "Could not delete" inside that memory's row, so the line stays in view when the list is scrolled. A failed delete closes its dialog so the line is visible. (#124)
- A Docker build no longer copies a `data/` database, `auth-secret`, `.env` file, `node_modules`, `.next` or `.verify/` folder from a subfolder, or any agent worktree under `.claude/` or `.worktrees/`, into the image. (#118)
- `Alt+Up` and `Alt+Down` pressed in the composer or another text field no longer move focus to a prompt. (#120)
- A code sandbox container stops at ten seconds and is removed even when the Orbit process dies during the run. The server log names each leftover container it removes. (#122)
- A chat message with a long run of letters no longer blocks Orbit for seconds while it looks up memories. (#115)
- A memory search no longer waits for an Ollama check. It answers from SQLite alone. The embeddings line on the Memory page updates when the page loads and after a save or delete. (#141)
- When the sign-out request fails, Sign out stays on the page and shows "Could not sign out". It no longer leaves the chat while the session may still be valid, or fails with no message. (#139)
- A new chat's title request sends only the first 2,000 characters of the first message, not the whole message. A long paste is no longer sent to the model a second time. (#135)
- A turn that calls no GitHub tool no longer connects to GitHub, so that reply no longer waits up to 10 seconds for a connection when GitHub is slow or down. A turn that already opened a client still waits for the close. The close request itself still has no deadline. (#136)
- When Ollama is down, the nightly dream no longer sends chats to the model. The night fails with the Ollama error on `/memory`, and the next night retries those chats. (#121)
- Markdown images in chat replies and reasoning appear as links that open on click. (#114)
- Orbit's API answers 403 to a write from another origin, so a page on another port of the same host cannot post a chat or call `/api/models` with your session. (#116)
- An HTML, SVG or React block in a reply's Thought no longer takes over the reply's Preview, and closing Thought keeps the reply's Preview working. Blocks in Thought have no Preview button. (#137)
- The command palette says Could not search when a message search fails. It no longer says No results while the search is still running. (#138)
- `npm run lint` checks the React hook rules `rules-of-hooks` and `exhaustive-deps` in `src/` with oxlint. CI shows the findings but does not fail on them yet. (#145)
- Unit tests check the dream claim, the chat head, and the branch and search migrations in the shipped code, not in the slice plans. Editing a plan no longer fails `npm test`. (#144)
- A search hit on an older branch opens that branch through to its newest message, so the hit's reply and later turns stay on screen. Reloading with an artifact preview open keeps those turns visible. A prompt sent from there follows the end of the branch. (#128)
- A saved Tavily key no longer appears in a chat error, a server log line, or a saved reply. The chat route's model errors are logged without the raw provider response, so a provider that repeats the API key does not put it in the log; the log line keeps the error name and HTTP status unless the error holds a stored key, and then keeps only its label. (#143)
- New chat shows "Could not create chat" when the request fails, instead of doing nothing or opening `/c/undefined`.
- Settings shows Failed when the model list answer cannot be read, instead of a green "0 models", and when the model list request is rejected, instead of "No key" or "Not checked".
- A stopped code run whose saved result cannot be loaded shows "Could not load output" instead of an empty card.
- A chat request that ends in a saved reply no longer undoes an edit made to that reply in another tab while the request streamed. The edit is kept, and the continued text is not saved. (#188)
- A code run shows its result as soon as the program ends, without waiting for Docker to remove the container. Pressing Stop while that removal runs no longer turns a finished run into a stopped one, and a program that exited just before the 10 second limit is no longer reported as timed out or loses its out-of-memory mark. Output that the 10 second limit cut off after the program ended is marked truncated.
- Sign in and Create account stay disabled after success until the next page opens, so a second click cannot send the form again. If navigation fails or stalls, the button re-enables so you can try again.
- An interrupted generated view shows Stopped instead of an empty cancelled tool card.
- Set `ORBIT_VERIFY_PORT` to run verify-orbit on another port when the deployment owns `3210`. The default stays `3210`.
- The verify-orbit mock provider and the mock Ollama in `scripts/qa/ci-e2e.sh` take a free port from the OS, so two runs on one host no longer collide. Give each run its own `ORBIT_VERIFY_PORT`, outside the OS's automatic port range. verify-orbit refuses one inside it.
- Cleanup of a leftover previous-format mock record that now names an unrelated process drops the record and still stops the sandbox server. It does not kill that process.
- Override Drizzle tooling's `@esbuild-kit/core-utils` dependency to use patched `esbuild` 0.25.12, removing GHSA-67mh-4wv8-2f99. (#71)
- Update Next.js from 16.4.3 to 16.4.6 to fix GHSA-mfr8-8qww-v76h, an information disclosure vulnerability.
- The server log has an `auth miss` line for each request that reaches Orbit without a valid session. It says whether the browser sent a session cookie and the Access cookie, by name only.
- Signed-out request logs use explicit character checks to keep requests from adding log fields.
- Settings can remove a saved GitHub token. The stored token is cleared and GitHub tools stop.
- Check says "GitHub rejected the token (bad request)." when GitHub answers HTTP 400.
- Keep earlier prompts and replies when editing or regenerating. Switch versions with the message arrows. Reload opens the last written branch.
- `npm test` now checks that the model list never reuses the saved key for a different base URL. It also checks the model cache, the OpenCode Go fallback, and the reasoning retry. These tests replace `scripts/provider-check.ts`, which nothing ran. (#129)
- A forged `X-Forwarded-For` header no longer gets around the sign-in rate limit. Every client now shares one limit per auth path, such as 3 sign-in attempts per 10 seconds. (#117)

### Changed

- A new chat message over 50,000 characters is refused with "Message is too long." Messages a chat already holds keep working at any length, and a request body over 32 MiB is refused. The composer shows a refusal as plain text. Settings, model list, and GitHub check fields have size limits too, and a refused request gets a 4xx.
- A question like "Where do I host things?" now finds the memory "I deploy everything to Fly.io". Orbit puts the labels `nomic-embed-text` expects in front of each question and each saved memory, and a vector must be within L2 distance 0.97 of the question. Memory vectors made before this are cleared once and made again the next time the Memory page opens or a chat ends.
- A saved memory sent with a later chat is quoted notes on the user message. It is not a system instruction. The remember card shows the saved text. A vector that is far from the question is left out. Forget runs only when it is given an id.
- A full question can find a memory from one shared word when Ollama is down. Common words such as "is", "the", and "and" do not count, so an unrelated question no longer brings back unrelated memories.
- A hung Ollama no longer holds a chat turn or a memory search for 5 seconds. The last Ollama result is reused for 15 seconds, and a chat asks for a vector for at most 1 second. Search still reads SQLite.
- Each memory has a stable row number, so its vector stays attached after vacuum.
- Editing a memory shows the server's reason when the save is refused.
- A remember or forget call that fails shows Failed on its card. The card no longer shows the text as saved.
- A long text with no spaces wraps inside the remember card and the Memory page row.

- The Docker server runs as the `node` user. On start, Compose gives `./data` to that user and drops root before the server listens. A directory set with `ORBIT_DATA_DIR` gets the same repair.
- A `docker run` start needs `--user 0:0` once to give an older root-owned data directory to that user. Without it, the container stops and prints the steps instead of answering every request with a 500.
- The image no longer includes a database or sign-in secret made during the build. Each new data directory makes its own.

### Added

- Read GitHub repositories, issues, and pull requests when a token is set. Settings stores the token on the server, and Check shows the GitHub login or the error. Issue, pull request, and file cards link to GitHub. The tools are read-only.

- Reach Orbit from a phone or another computer through a Cloudflare tunnel, with Cloudflare Access asking who you are before Orbit's own sign-in. `scripts/deploy-wizard.sh` walks through the Cloudflare dashboard steps, and `docker compose --profile public up -d` starts the tunnel. A plain `docker compose up` starts no tunnel, and `127.0.0.1:3210` still signs in.

- Once a night, Orbit reads the day's chats and saves lasting facts and preferences on the Memory page. A second run the same night does not add them again. Near-duplicates update the older memory. The page shows when the last run finished, or the error.

- Once a day, Orbit reviews the day's chats and drafts new memories from them. ORBIT_DREAM_HOUR sets the hour, and the run is logged so it can be checked.

- Orbit remembers a fact or a preference from one chat and can use it in a later chat. The Memory page lists, searches, edits, and deletes those memories. Vectors come from Ollama. When Ollama is down, text search still works and the page shows the error.

- Conversation search finds the source of code runs, so code the model ran can be found by a name or a word in it. This includes a run you stopped. A migration adds the source of earlier runs to search.

- Conversation search finds the standard output and standard error of code runs, so a result that only the program printed can be found by its text. A result opens the right chat and message. A migration adds the output of earlier runs to search.

- Code run cards name their language, Python or JavaScript, in the header. The tag stays while the run goes, after a failure or Stop, and after you reopen the chat. The output boxes sit on a darker surface than the source.

- Settings shows whether the server turned on the code sandbox. The status is read-only, and the browser cannot change it.

- Copy the source, standard output, or standard error of a code run from its card. The buttons work with the keyboard and on a phone, and show whether the copy worked.

- Run Python and JavaScript through `run_code` when the server sets `ORBIT_SANDBOX=on`. Each run uses a fresh container with no network, a read-only root filesystem, a non-root user, and resource limits. Saved cards show code, stdout, stderr, exit code, and duration.

- Search the web through SearXNG or Tavily and answer with source links. Tool cards show running, succeeded, failed, or cancelled and survive reload. Search settings keep the Tavily key on the server. Compose includes SearXNG with JSON search enabled.

- A new chat gets a short title from the model. The command palette finds a message by its text. (#19)
- Preview HTML, SVG, JSX and TSX code blocks in a sandboxed panel. Switch between Preview and Code, reload, copy or download the source, and send runtime errors to the composer with Fix. The open preview survives a page reload and fills the screen on a phone.
- Four starter prompts on an empty chat. A click fills the composer and does not send. (#16)
- `verify.mjs browse <scenario>` drives Chrome through Playwright and saves screenshots. `launch --mock` starts the mock provider. (#16)
- `ARCHITECTURE.md` with a stack diagram and a checked state chart of one chat turn.
- Build plans for slices 3 to 12 in `docs/slices/`.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, the MIT `LICENSE`, and GitHub issue and pull request templates.

### Changed

- The composer placeholder is `Ask anything`. (#16)
- The sidebar, the mobile header, and the command palette show `Untitled` for a chat that has no title yet. (#16)
- Rewrote `README.md` and `AGENTS.md`.
- Renamed `docs/SPEC.md` to `docs/roadmap.md` and `docs/DESIGN.md` to `docs/design.md`.
- `scripts/qa/genui-qa.cjs` saves screenshots under `.verify/evidence/genui-qa/` instead of `docs/qa/screenshots/`.

### Fixed

- GitHub Check asks for `get_me` on its own, so a valid token still shows the login when the chat tools are limited to repositories, issues, and pull requests.
- The saved GitHub token is sent only to `api.githubcopilot.com`, `github.com`, and `api.github.com` over HTTPS. Any other MCP URL, including plain HTTP, is refused before the request. Tests can set `ORBIT_GITHUB_MCP_FIXTURE=1` to allow the local fixture.
- A GitHub server that repeats the token does not get that token back out through Check, a tool result, or a chat stream error. The text says `[redacted]` instead.
- A GitHub connection that does not answer stops after 10 seconds, closes, and the chat continues without those tools. Stopping the chat still cancels the connection immediately.
- GitHub cards link an issue or a pull request on github.com, and a file result links to that file. A URL inside the issue text, a label, or the file body stays text.
- A GitHub tool result that reports an error, such as a rate limit or a permission failure, shows Failed on the card. A rejected token check stays Failed.

- After you press Stop on a running code card, the open chat shows the same card a reload shows: Cancelled, the Stopped line with its duration, and the output the program had printed. Before, the card stayed bare until you reloaded the page. Your draft in the composer and the version you are viewing stay as they are. This also holds when you press Regenerate or send a message right after Stop.

- Code run cards remove terminal escape sequences from standard output and standard error, so a program that prints color codes shows only its text. The copy buttons copy the same cleaned text. Saved cards use the same cleaning when you reopen the chat.

- A code run result states one outcome, such as `Timed out`, `Out of memory (exit 137)`, or `Stopped`, and a separate duration that uses seconds after the first second. The runner records when Docker kills a program for memory, so a program that exits 137 on its own shows `Exit 137`. `Exit killed` and the repeated `Timed out` are gone.

- A code run card hides the standard output or standard error box when it has no text or only blank lines. A run with no output still shows its source, exit status, and duration.

- Stopping a running code card keeps the output the program had printed. The saved card shows Cancelled with that output after you reopen the chat.

- Rejected tool input saves and shows a short reason instead of repeating the rejected input. A 20,001 character program no longer copies itself into every saved error and server log line.

- Verification fixtures ignore shell data-directory settings and use the isolated test database.

- Build the sandbox route when Dockerode's optional SSH native addon is installed.

- Flush incomplete UTF-8 output and mark it truncated when it reaches the byte cap.

- Run Python unbuffered so early prints remain available after timeouts or memory kills.

- Code run content areas have named keyboard stops and a visible focus ring for scrolling with the keyboard.

- Completed code runs keep their result when container cleanup takes longer than the execution deadline.

- Verification launch rejects sandbox mode mismatches without replacing the running server.

- Code run source, output, and error text scroll within bounded panels.

- Code run cards show framework failure messages instead of an invalid-result fallback.

- Default Compose deployments no longer start a Docker socket proxy. Enable the sandbox and its Docker access with the explicit sandbox override.

- Sandbox failures report configuration and proxy errors clearly, and log safe error categories and status codes.

- Code runs apply the ten-second deadline during Docker setup and respond to Stop while setup is pending. Late containers are removed.

- A stopped code run shows Cancelled before and after reload.

- Search failures log a safe error type and the SearXNG HTTP status without keys, queries or response data.

- Research requests can still render cards and artifacts after four searches.

- Remove a saved Tavily key from Settings. Blank key fields still keep saved keys.

- A stopped web search shows Cancelled when its completed result arrives and after reload.

- Search results scroll to and highlight user messages. Replies follow the stream after opening a search result. Search database failures log an error code without message text. (#19)

- Keep artifact previews open when canceling a code edit, editing an earlier block or reloading an older branch. Preserve TSX download extensions, support keyboard tabs, show fades on long errors and reveal the composer after Fix on a phone.

- A retry that you stop after a failed first message keeps the text you saw after reload. (#16)
- A retry's reply is no longer saved under a prompt that another tab edited while it streamed. (#16)

### Removed

- QA reports, QA screenshots, slice result files, and `docs/plans/live-data-ui.md`. Proof now lives in pull request comments. The live-data plan is folded into slices 7 to 10.

## [0.1.0] - 2026-11-01

The first version. `package.json` has carried `0.1.0` since slice 1. No git tag exists yet.

### Added

- Email and password sign-in with better-auth. Signup closes after the first account. (#2)
- Provider settings for any OpenAI-compatible endpoint: base URL, API key, model, and reasoning effort. The model list loads from the provider. The key never leaves the server. (#2)
- Streaming chat with assistant-ui and the AI SDK, stored in SQLite and restored on reload. (#2)
- A Docker image and Compose file that publish `127.0.0.1:3210` only. (#2)
- The verify-orbit skill, which launches a sandboxed server and drives signup, sign-in, settings, and chat. (#2)
- The design system: tokens, the orbit mark, empty-state figures, the command palette (⌘K), keyboard shortcuts, the collapsible sidebar, and the thread map. (#3)
- Generative UI. The model can call `render_ui` with a json-render spec for cards, metrics, tables, lists, callouts, text, and buttons. The spec is stored with the message and renders again on reload. (#4)
- Inline editing. Edit and resend a user message. Edit an assistant reply or one code block in place without calling the model. (#5)

### Fixed

- A message id reused under another chat could change the first chat. The server now answers `409`. (#2)
- Changing the base URL kept the old provider's key. The server now asks for a new key. (#2)
- Each send rewrote every stored message. Only new or changed messages are written now. (#2)
- The phone drawer left the app unclickable after rotating to landscape. (#3, fixes #6)
- The chat still showed no provider after saving settings and pressing Back. (#3, fixes #7)
- The model select started on Custom with an empty field. (#3, fixes #8)
- The 404 page used Next's default style and was unreadable on the dark UI. (#3, fixes #9)
- Phone touch targets were 22 to 36 px. (#3, fixes #10)
- A follow-up after a failed `render_ui` call stored the assistant message twice. (#4)
- A stopped `render_ui` reply was not stored. (#4)
- Parallel build workers raced the SQLite migration. Migrations now take an exclusive lock. (#4)
- The migration lock spun forever when `.migrate.lock` could not be removed. (#4, fixes #12)
- Overlapping saves and stale tabs could overwrite edited messages. (#5)

### Security

- The data directory is created with mode `0700`, and `data/auth-secret` is kept at `0600`. (#4, fixes #13)
- better-auth trusts only the configured origins, set with `ORBIT_TRUSTED_ORIGINS`. (#4)

[Unreleased]: https://github.com/aduthekaddu/orbit/compare/b35a7d2...HEAD
[0.1.0]: https://github.com/aduthekaddu/orbit/commits/b35a7d2
