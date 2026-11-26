# Architecture

This page explains how Orbit is put together and why. Read it before you change a route, a table, or the chat stream. Setup is in the [README](README.md). Planned work is in the [roadmap](docs/roadmap.md).

## Bird's-eye view

Orbit is one Next.js process. It serves the pages, the API routes, and the chat stream on `127.0.0.1:3210`. It keeps everything in one SQLite file. The browser talks only to that process. Only the server talks to the model provider, so the API key never leaves the server.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/stack-dark.png">
  <img alt="Orbit stack. The browser runs assistant-ui and json-render. A Docker container runs Next.js, the AI SDK, better-auth, Drizzle, and SQLite. The AI SDK calls an OpenAI-compatible provider. A dashed box groups the optional services: a Cloudflare tunnel into Next.js, then SearXNG, Tavily, a Docker sandbox, Ollama, and GitHub MCP, which the server calls for tools and embeddings." src="docs/architecture/stack.png">
</picture>

## One chat turn, end to end

1. You type in the composer. assistant-ui sends `POST /api/chat` through `orbitChatTransport` in `src/lib/chat-transport.ts`. The transport puts the open chat id on the request, because assistant-ui would otherwise send its own local thread id.
2. `src/proxy.ts` checks the session cookie and forwards any `Set-Cookie` header better-auth returns when a session refreshes or expires. `src/lib/session.ts` reads the session with refresh disabled so only the proxy moves a session forward. Every page and API route needs a session except `/login`, `/signup`, `/api/auth/*`, and `/api/setup`. An API request with a method other than `GET`, `HEAD`, or `OPTIONS`, other than `/api/auth/*`, gets 403 when it carries a `Sec-Fetch-Site` other than `same-origin`, or, without Fetch Metadata, an `Origin` that is not a trusted origin. The browser sets `Sec-Fetch-Site`, so a write it marks `same-origin` passes without consulting the trusted list. A write with neither header, such as curl, passes. `/api/auth/*` uses better-auth's origin check.
3. `src/app/api/chat/route.ts` reads the body up to `LIMITS.requestBytes` (32 MiB, else `413`), parses it with zod, and holds each message the chat does not store yet to the message limits (a user message over 50,000 characters gets `413`; stored messages keep working at any length), resolves the connection, model, and effort with `resolveChoice` in `src/lib/model-choice.ts` (the request's choice, then the chat's, then the user's defaults), loads the settings row, checks ownership, reserves the chat’s only active reply, and calls `planChatWrite` in `src/lib/messages.ts`. That function saves the incoming user messages and returns a `ReplyPlan`: the id the reply will be stored under, plus copies of the prompt row and of the saved reply the stream continues, if any. It refuses a request with no user message with `400`, and a write planned against an older copy of the chat with `409`. It moves `chats.head_id` to the prompt, or to the saved reply the stream continues.
4. The route pins that choice on the chat, then calls `streamText` from the AI SDK with the model from `languageModelFor` in `src/lib/provider.ts`, the effort options from `effortCallOptions` in `src/lib/effort.ts`, and the tools from `toolsForTurn` in `src/lib/tools/index.ts`. The registry always enables `render_ui`, `remember`, and `forget`, enables `web_search` when a search backend is configured, and enables `run_code` only when the server sets `ORBIT_SANDBOX=on`. `toolsForTurn` also tries to add the `github_*` tools when a GitHub token is saved. If loading fails, the failure is logged as one redacted line and the turn runs without GitHub tools. The route closes the GitHub client when the turn ends. Before the model call, the route asks `recall` in `src/lib/memory/recall.ts` for up to three memories relevant to the last user message. Recall returns none when there are no memories or nothing matches. Otherwise the route attaches them as quoted notes on that user message, as data and not as instructions, and adds `REMEMBER_INSTRUCTIONS` to the system text. The loop stops after at most five model steps. The fifth step allows only `render_ui` and receives the completed conversation as JSON data, so the model answers instead of calling another tool or writing tool-call markup. It keeps the route instructions so the model can answer with citations, render a card, or write an artifact without searching again.
5. The server reads one stream of AI SDK UI message parts, masks credentials, and keeps the chunks in the reply run. Each connected tab reads its own copy. A dropped connection or a closed tab removes its listener. The model and tools keep running. The browser uses `GET /api/chats/[id]/stream?replyId=…` to replay that reply and follow new chunks. `POST /api/chats/[id]/stop` tells the server to cancel the model and tools, including while `POST /api/chat` is still setting up before response headers arrive. If the server has not reserved a run yet, the browser aborts its pending send. After a successful Stop request, the browser keeps Stop disabled until it receives the reply ending or checks SQLite.
6. When the stream ends, `onEnd` passes the plan and the reply's parts to `finishChatReply` in `src/lib/messages.ts`. Text, reasoning, and tool parts count as visible content. A visible reply saves if the rows the plan copied still match. Reasoning keeps its duration in the live stream, replay, and saved reply. Interrupted replies keep their end marker. Each live stream and replay ends with one `finish`, `abort`, or `error` chunk. A regenerate saves a new sibling and keeps the earlier reply. The hook also starts `embedPending()` in `src/lib/memory/embed.ts`, which fills in the memory vectors Ollama has not returned yet, and closes the GitHub tools.
7. The server holds ended runs for up to 10 minutes and keeps at most 64 MiB of ended chunks. The oldest ended runs leave first. Each user can have up to four active replies across their chats. A server restart clears the run registry. If the initial connection drops before the browser receives a reply ID, the browser refreshes the page data and can join an active run for the same prompt. The browser waits longer between repeated failed reconnects, even if the server sends headers before the connection drops. The browser checks SQLite if replay is unavailable and keeps an interrupted reply on screen for retry if there is no saved row.
8. On reload, `src/app/(app)/c/[id]/page.tsx` loads every message and its parent into the history adapter. The chat opens the path ending at `chats.head_id`. The runtime loads them after hydration, so until they reach the thread it shows a placeholder in their shape, or the empty-chat layout when the chat has none.

## The rules of a turn

The chart below is generated from a TLA+ model of steps 3 to 6. TLC, the TLA+ model checker, checks each rule in every reachable state. `scripts/ci/tlc.sh` runs TLC on every model in `docs/architecture/`, locally and in CI. Each rule is something you can see as a user.

```mermaid
---
title: "One chat turn in Orbit"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: idle
    lg1: streaming
    lg2: failed
  }
  class lg0 blue
  class lg1 orange
  class lg2 pink
  s0: Idle, no reply saved
  s1: Sending, waiting for visible parts
  s2: Error shown
  s3: Reconnecting, reply running
  s4: Sending, visible parts received
  s5: Reconnecting after provider failure
  s6: Reconnecting, no reply saved
  s7: Idle, reply saved
  s8: Regenerating, waiting for visible parts
  s9: Reconnecting, reply saved
  s10: Regenerating, visible parts received
  [*] --> s0
  s0 --> s1: you send a message
  s1 --> s0: the model finishes or you press stop
  s1 --> s2: the provider fails
  s1 --> s3: the connection drops
  s1 --> s4: the model streams a visible part
  s2 --> s1: you send a message
  s2 --> s8: you press retry
  s3 --> s1: the browser reconnects
  s3 --> s5: the provider fails
  s3 --> s6: the model finishes
  s4 --> s2: the provider fails
  s4 --> s7: the model finishes or you press stop
  s4 --> s3: the connection drops
  s5 --> s2: the browser reconnects
  s6 --> s0: the browser reconnects
  s7 --> s1: you send a message
  s7 --> s8: you press regenerate
  s8 --> s2: the provider fails
  s8 --> s0: the model finishes or you press stop
  s8 --> s3: the connection drops
  s8 --> s10: the model streams a visible part
  s3 --> s4: the browser reconnects
  s3 --> s9: the model finishes
  s9 --> s7: the browser reconnects
  s8 --> s7: the model finishes or you press stop
  s3 --> s8: the browser reconnects
  s10 --> s2: the provider fails
  s10 --> s7: the model finishes or you press stop
  s10 --> s3: the connection drops
  s3 --> s10: the browser reconnects
  class s0 blue
  class s1 orange
  class s2 pink
  class s3 orange
  class s4 orange
  class s5 orange
  class s6 orange
  class s7 blue
  class s8 orange
  class s9 orange
  class s10 orange
```

These rules hold in every state the model reaches:

- **A reply with visible content can save.** Non-blank text, non-blank reasoning, and tool parts count.
- **Regenerate keeps the old reply.** Every visible new reply is a sibling. A stop or provider failure saves its visible content without changing the earlier reply.
- **A stopped send keeps its visible content.** If you stop a new message mid-stream, its visible parts are still there after reload.
- **Visible content is kept (ShownTextKept).** If you stop and no older reply exists, the visible content is saved. This covers a retry after a failed first message, which is a regenerate with nothing to replace.

`finishChatReply` saves every reply with visible content. [Slice 4](docs/slices/04.md) gives a regenerate a new id, so saving a partial reply preserves the earlier version. A stop before visible content leaves the head on the saved prompt.

The model tracks up to three reply attempts per prompt with separate ids. A regenerate must keep every earlier reply id. `ChatTurnRegression.tla` checks that a finished reply followed by a finished regenerate leaves two versions.

`ChatTurn.tla` leaves out edits, tool calls, and concurrent tabs. `ChatWrite.tla` models two tabs on one prompt and its reply, with these rules:

- **A saved reply keeps its newest text (ReplyKeepsNewestText).** A tab that loaded the reply before an edit cannot undo the edit when it sends, and a request that continues the reply cannot undo an edit made while it streamed.
- **A saved reply answers its prompt's current text (ReplyAnswersItsPrompt).** A regenerate that streamed while the prompt changed is not saved under the changed prompt.

Both models have mutant configs. Each switches off one guard to replay a past bug, and its `.trace` file holds the counterexample TLC must print, state by state. CI fails if TLC stops finding that counterexample. `ChatWrite.tla` assumes one server process, as Orbit runs, because it treats `planChatWrite` and the route's read of the saved reply it continues as one step. `.agents/skills/verify-chat-turn/SKILL.md` says how to run the models, read a result, update a model when the code changes, and which past bugs the models leave out. `src/lib/model-sync.test.ts` fails when a function a model names changes after the model was last checked.

To rebuild the chart, run the [statechart skill](https://github.com/cursor/plugins/blob/main/pstack/skills/statechart/SKILL.md) on [`docs/architecture/ChatTurn.tla`](docs/architecture/ChatTurn.tla):

```sh
statechart docs/architecture/ChatTurn.tla --config docs/architecture/ChatTurn.cfg --view docs/architecture/chat-turn.view.mjs --out /tmp/chat-turn
```

## Code map

| Path | What lives there |
| --- | --- |
| `src/app/(app)/` | Signed-in pages: the chat at `/c/[id]`, settings, the memory page, and the app shell layout. |
| `src/app/login/`, `src/app/signup/` | The two public pages. |
| `src/app/api/chat/route.ts` | The chat stream. The only route that calls the model. |
| `src/app/api/chats/` | List and create chats, read one chat, reconnect to a reply, or stop it. `PATCH .../messages/[messageId]` saves an edited reply. |
| `src/app/api/connections/` | List, add, edit, and delete provider connections. `GET .../[id]/models` lists a connection's models, and `PUT .../[id]/hidden-models` hides or shows one. Adding a connection, or changing its base URL or key, lists its models first and returns `502` when that fails. |
| `src/app/api/settings/` | Read and save the search and GitHub settings. |
| `src/app/api/settings/github/check/` | Checks a saved or submitted GitHub token against the MCP server, and returns the login or the error. |
| `src/app/api/memories/` | List and search memories. `PATCH .../[id]` edits one and `DELETE .../[id]` deletes one. |
| `src/app/api/search/` | Full-text search over stored messages. |
| `src/app/api/setup/` | Tells the login page whether signup is still open. |
| `src/app/api/preferences/` | Read and save the signed-in user's appearance. `PATCH` takes only the changed fields. `GET` and `PUT .../model` read and save the default connection, model, and effort. |
| `src/instrumentation.ts` | Runs once at server start. It imports the database, which migrates it, starts the dream scheduler, and starts the sandbox sweep when the sandbox is on. |
| `src/proxy.ts` | The session gate for every request. |
| `src/lib/db/` | The SQLite connection, the Drizzle schema, and the migration lock. |
| `src/lib/reply-runs.ts` | One server-owned run per chat with a redacted replay buffer and listeners. |
| `src/lib/messages.ts` | Chat and message reads and writes. All write planning lives here. |
| `src/lib/memory/` | Memory storage, hybrid recall, Ollama embeddings, the nightly dream, and the dream scheduler. |
| `src/lib/search.ts` | The FTS5 match queries behind message and memory search. |
| `src/lib/provider.ts` | `languageModelFor`, the model client for an OpenAI-compatible or Anthropic connection, and provider quirks. |
| `src/lib/connections.ts` | Provider connections, hidden models, and the default model. The only module that decrypts a provider key (`src/lib/secrets.ts`). |
| `src/lib/model-list.ts`, `src/lib/effort.ts`, `src/lib/model-choice.ts` | A connection's model list with each model's capabilities, every effort rule, and the order that picks a chat's model and effort. |
| `src/lib/settings.ts` | The settings row. `toPublicSettings` is the only shape that leaves the server. |
| `src/lib/appearance.ts` | The appearance choices, their defaults, the parser for stored rows, the `data-*` attributes they set on `<html>`, the theme color, and the Appearance card's save queue. Safe to import in the browser. |
| `src/lib/preferences.ts` | The `user_preferences` reads and writes, and `appearanceForRequest`, which the root layout uses to paint the saved appearance on first render. |
| `src/lib/tools/` | The tool registry, the GitHub MCP client, SearXNG and Tavily search adapters, browser-safe card metadata, and tool status rules. |
| `src/lib/sandbox/` | The fixed container policy, pinned language images, per-run Docker lifecycle, and the sweep of stale containers. |
| `src/components/tools/` | Saved tool run cards, search result links, and the generic JSON disclosure. |
| `src/lib/genui/` | The `render_ui` tool: the component catalog, the spec parser, and the system prompt. |
| `src/components/chat/` | Thread, messages, composer, code blocks, inline editors, and the thread map. |
| `src/components/memory/` | The memory page body: the list, its search, and each row's save and delete errors. |
| `src/components/settings/` | The Appearance card, the connection, default model, and model list sections, the search and GitHub form, and their shared row. |
| `src/components/auth/` | The shared login and signup form. |
| `src/lib/artifacts/` | Artifact language detection, prompt instructions and the sandboxed frame document. |
| `src/components/artifacts/` | Preview registration, URL selection, lazy compilation and the responsive panel. |
| `src/components/genui/` | The React side of `render_ui`: the component registry and the fallback card. |
| `src/components/shell/` | App shell, sidebar, command palette, and keyboard shortcuts. |
| `src/components/ui/` | shadcn/ui primitives, styled with the tokens in `src/app/globals.css`. |
| `drizzle/` | SQL migrations. `npm run db:generate` writes new ones from `src/lib/db/schema.ts`. |
| `scripts/` | Smoke tests against a running server, the browser QA script with its mock provider, the nightly dream runner (`npm run dream`), and the Cloudflare deploy wizard. |
| `.agents/skills/verify-orbit/` | The verification skill. It launches a sandboxed server and drives each feature. |
| `.agents/skills/verify-chat-turn/` | Model-checks the chat write path with TLC, and records which functions each model describes. |

## Data model

All state is in `data/orbit.db`. The directory is mode `0700`, and the database, `data/auth-secret`, and `data/secret-key` are mode `0600`. `data/secret-key` encrypts the provider keys, so a backup needs it with the database.

| Table | Rows | Notes |
| --- | --- | --- |
| `user`, `session`, `account`, `verification` | better-auth's tables | A SQLite trigger, `user_single_row`, rejects a second user. |
| `user_preferences` | One per user, keyed by `user_id`, deleted with the user | Theme, text size, reply font, chat width, accent, and the default connection, model, and effort. A user with no row gets the defaults, and the first save creates it. |
| `provider_connections` | One per saved provider, per user | `kind` (`openai-compatible` or `anthropic`), label, base URL, and the API key encrypted with AES-256-GCM. |
| `hidden_models` | One per model a user hid from the picker | Keyed by user, connection, and model id. Deleted with the connection. |
| `pending_connection` | At most one row, `id = 1` | A provider an install had saved before anyone signed up. The first account adopts it, then the row is deleted. |
| `settings` | One row, `id = 1` | SearXNG URL, Tavily key, GitHub token, and GitHub MCP URL. The Tavily key and the GitHub token stay on the server. |
| `chats` | One per conversation | `title` starts as `New chat` and takes the first message's text. `head_id` selects the last written branch. `connection_id`, `model`, and `reasoning_effort` are all set or all null, and pin the chat's model on its first send. |
| `messages` | One per user or assistant message | `parts` is the AI SDK parts array as JSON, and reload reads it. `content` is the plain text of the text parts, then the standard output and standard error of finished code runs, then the source of each code run. Search reads `content`. `parent_id` links each message to its parent. `position` is its depth. Siblings stay in creation order. An assistant reply records `connection_id`, the `model` that wrote it, `reasoning_effort`, and `effort_outcome`. |
| `memories` | One per saved fact or preference | `kind`, `text` capped at 2,000 characters, normalized text that dedupes, and the source chat and message. `seq` is a stable integer key for the vector table, and `last_used_at` records the last recall that returned it. |
| `memory_runs` | One per night | The dream run: `state`, the lease owner and deadline, the pending, done, and retry chat lists, and the added and merged counts. |
| `messages_fts`, `memories_fts`, `memories_vec` | Search index tables | FTS5 over `messages` and `memories`, kept in sync by triggers, and the `vec0` table of memory embeddings, written by `src/lib/memory/store.ts`. |

Tool output, generated UI specs, and reasoning all live inside `parts`. A new tool needs no new table unless it stores something outside a message.

`run_code` is available only with `ORBIT_SANDBOX=on`. The tool validates language and source, then `runCode` starts a fresh container using only `containerSpec` options. Source arrives on stdin. The runner bounds stdout and stderr and stops work after ten seconds or request cancellation. `runCode` returns two promises: `result`, which settles once with the first of exit, deadline, Stop or Docker error, and `cleanup`, which settles after the container is removed. Once the program has exited, Stop keeps its exit code and a confirmed memory kill, and the deadline only stops waiting for its last output, which then counts as truncated. `runCode` waits at most five seconds for Docker to confirm a memory kill, and a `wait` reply that carries a Docker error fails the run. One cleanup task owns the container, including one Docker finishes creating after Stop returned, and kills it first when the program had not exited. The container runs the interpreter under `timeout`, so it also stops at ten seconds when Orbit dies mid-run. With the sandbox on, `src/instrumentation.ts` starts `startSandboxSweep`, which removes sandbox containers older than a minute at start and every minute after, and logs each removal with its owner. The saved tool part contains the source and final output, with the raw text. The card reads that part after reload and removes terminal escape sequences from the output when it renders. When you press Stop, the AI SDK drops the tool result, so `createStoppedRuns` in `src/lib/tools/stopped-runs.ts` keeps the output the runner had collected, and the chat route saves it as a cancelled result. The open chat then fetches the saved reply and puts that result on the live card (`StoppedRunSync`), so the card matches a reload without replacing the thread. Compose reaches the Docker API through a private socket proxy. See [Security](SECURITY.md#code-sandbox) for that boundary's limits.

Each container carries an owner label beside the shared sandbox label. The owner names the process that made it: one server, one test file or one QA script, from `ORBIT_SANDBOX_OWNER`, or a UUID that `sandboxOwner()` writes to that variable on first use, so every copy of the module in the process and every child process reads one value. Tests, scenarios and leftover checks list containers only through `ownedSandboxFilter` or `ownedSandboxFilterArgs` in `src/lib/sandbox/owner.mjs`, so another Orbit process on the same Docker host cannot fail them. `src/lib/sandbox/sweep.ts` stays allowlisted for host-wide listing so it can remove stale containers left by crashed processes, and `scripts/qa/ci-e2e.sh` fails only on sweep removals for its own owner. `src/lib/sandbox/owner.test.ts` fails when a file names the shared label outside its allowlist, or lists containers without those helpers outside the host-wide allowlist. It reads text, so it cannot see a label built from parts.

## Rules that hold across the code

- **The key stays on the server.** Provider keys live in `provider_connections`, encrypted with AES-256-GCM under `ORBIT_SECRET_KEY` or `data/secret-key`, and only `src/lib/connections.ts` decrypts them, at call time. `GET /api/connections` returns `keySet: true` and `keyReadable` for each connection and never a key. `keyReadable` is false when this server's secret key cannot open the saved key. A label that holds the connection's key is refused with 400, since labels are stored in plain text, and an unreadable-key error never names the label. A model id that holds a credential is left out of the model list, because a masked id would send the wrong name back to the provider. Model labels are masked. `GET /api/settings` returns `tavilyKeySet`, `githubTokenSet`, and `sandbox` booleans. Both mask userinfo, credential-named query or fragment parameters, and stored credentials in saved URLs (a connection's `baseUrl`, `searxngUrl`, `githubMcpUrl`). Submitting an edited masked URL merges saved secret parts back on the same origin or fails with 400 naming the field when `[redacted]` cannot be resolved. `sandbox` says only whether the server set `ORBIT_SANDBOX=on`. The browser cannot change it. One `Redactor` (`src/lib/chat-errors.ts`), built from every stored credential and URL credential, keeps stored secrets out of log lines, chat stream chunks (`src/lib/chat-stream-redactor.ts`), saved messages and their search text (`src/lib/messages.ts`), chat titles (`src/lib/titles.ts`), tool outputs (`web_search`, `run_code` before its 64 KiB output cap, `remember`, `render_ui`, `forget`, and GitHub tools), dream memories (`src/lib/memory/dream.ts`), memory edits, and model lists. The Redactor for a request also knows every connection key of its user. Message writes require a `Redactor`, including submitted prompts and manual reply edits. An open tab can still send the prompt as typed if its masked copy matches the saved row. Earlier rows are left as stored. In saved messages, tool results, and streamed text it replaces each value of 12 or more characters with `[redacted]`, matching literal, percent-encoded, Base64/Basic-auth, JSON-escaped (including nested JSON), and terminal-escape-split forms with overlaps included, after the last step that decodes or joins text; shorter values stay, so a placeholder key such as `ollama` does not rewrite ordinary words. The stream transform holds back at most `longest key - 1` characters on normal text so replies still stream token by token while catching keys split across deltas or consecutive text parts. Log lines, stream error text, and tool errors (including provider-executed `tool-output-error` chunks) are never masked in place: when the raw error, the uncut text built from it, or the printed line holds a stored value of any length, the whole detail becomes a fixed text (`[redacted]`, or the log label alone), and a fixed text that itself holds a value is skipped. A new settings field must be listed in its `SETTINGS_FIELDS` table, and a field whose name ends in `Key`, `Token`, `Secret`, `Password`, `Pat` or another noun in `CREDENTIAL_NOUNS`, plural, numbered or both, must be labelled `credential`, or typecheck fails. The table also lists the decrypted fields of a provider connection (`ConnectionSecrets` in `src/lib/connections.ts`). Any other credential kept in another table or read from the environment when used is outside that table. Tests and smoke scripts redact `ORBIT_API_KEY`.
- **One user.** The auth hook and the database trigger both close signup after the first account.
- **Validate at the edge.** Routes parse request bodies, queries, and path parameters with zod schemas built from `r` in `src/lib/route-schema.ts`, which has no string or list without a size limit. `route-schema.test.ts` fails a route that imports `zod` directly. Tool input is parsed by the tool's schema and then by `parseRenderSpec`. Code behind those checks trusts its types.
- **A browser request names its failure.** Browser code calls `requestJson` in `src/lib/request-json.ts`, never `fetch`. It takes a zod schema, `onOk`, and a required `onFailed` that receives `network`, `http` with the status, `invalid` for a body that is not JSON or does not match the schema, or `handler` when `onOk` threw. `requestJson` never rejects: a handler that throws is logged with `console.error`. A request whose signal was aborted runs neither, and `useLatestRequest` aborts the previous one, so an older answer cannot overwrite a newer one. A load that a screen shows is `Loaded<T>` (`idle`, `pending`, `failed`, `done`), so only `done` can show an empty result. `src/lib/no-direct-fetch.test.ts` fails on a direct `fetch(`, `fetch?.(`, `["fetch"](`, `XMLHttpRequest`, `EventSource`, or `sendBeacon` call; it cannot see an alias of `fetch` or a call split across lines. The chat stream transport is not a JSON request and is out of scope.
- **The server owns history.** The client sends its copy of the thread, but `planChatWrite` decides what is stored and refuses a write against a changed chat.
- **Bind to localhost.** Docker Compose publishes `127.0.0.1:3210` only. The `public` Compose profile starts a `cloudflared` tunnel, so remote access goes through Cloudflare Access and no port opens on the machine.

## Feature boundaries

Shipped and planned slices use these boundaries. The plans in [`docs/slices/`](docs/slices/) give the details.

- **Tools.** `toolsForTurn` in `src/lib/tools/` builds one turn's tools from the registry and adds the `github_*` tools when a GitHub token is saved. [Slice 7](docs/slices/07.md) adds SearXNG search with Tavily as a fallback. Each backend has an eight-second timeout. Tavily cancellation uses a request-scoped signal adapter because the pinned SDK has no signal option. Concurrent requests keep separate signals. The browser shares only card metadata with the registry. Run cards derive running, succeeded, failed, or cancelled from message parts and survive reload. `toolRunEnd` and `toolCallRunEnd` in `src/lib/tools/run-status.ts` are the only code that decides this, and `STOP_MARKERS` there holds every stop text that saved chats store. `run-status-scan.test.ts` fails when another file compares `errorText` or `output.error`, or writes a stop text as a literal. Unknown tools show their output behind a disclosure.
- **Artifacts.** [Slice 5](docs/slices/05.md) renders HTML, SVG, and React code blocks in a side panel. The code runs in an `<iframe sandbox="allow-scripts">` with a strict Content Security Policy, so it cannot read the app's cookies or call its API. The app page paths in `next.config.ts` send `frame-src 'none'`, so the frame cannot load another URL into itself, and `frame-ancestors 'none'`, so no other page can frame Orbit. Route handlers can set their own CSP. See [Security](SECURITY.md#response-headers).
- **History.** Messages form a tree. Edits and regenerates add siblings, and the branch picker switches between them. A reload opens the last written branch. Switching alone does not update `head_id`. A search hit off that branch opens the branch through the hit that was written last, which ends at the newest message below the hit, and does not update `head_id` either.
- **Search.** [Slice 6](docs/slices/06.md) adds an FTS5 index (SQLite full-text search) over `messages`, kept in sync by triggers.
- **GitHub.** [Slice 9](docs/slices/09.md) adds the `github_*` tools from GitHub's MCP server, read-only, limited to the repository, issue, and pull request toolsets. `toolsForTurn` loads them only when the settings row holds a GitHub token, and caches the tool list for five minutes per token. The route closes the client when the turn ends. When the server is unreachable or the token is wrong, the turn still runs without GitHub tools and logs one redacted line. GitHub tool results are untrusted text: the route tells the model so, and run cards render them as links.
- **Memory.** [Slice 10](docs/slices/10.md) adds a `memories` table with its own FTS5 index and a `sqlite-vec` table for embeddings from Ollama. [Slice 11](docs/slices/11.md) fills it from the day's chats each night. A night's row in `memory_runs` changes only through `transition` in `src/lib/memory/run-state.ts`, which `advance` in `src/lib/memory/dream.ts` applies inside one write transaction. A run reaches `done` only with a successful final embed pass, and a failed run keeps every unfinished chat for the next night. Each chat's window is read in full, in pages of 100 messages oldest first with one model call per page, and a retried chat re-reads from the window start of the night it first failed.
  A memory's `source` records who wrote its current text. A text rewrite from the Memory page sets `user`, `remember` sets `tool`, and the nightly job sets `dream` when it inserts or rewrites a note. Rows saved before the column was added have `unknown`. Duplicate saves and edits that keep the same normalized text keep the original source. Normalization trims and collapses whitespace and compares text without regard to case. Recall credits only `user` notes to the user and labels the rest as assistant notes.

## Rebuild the stack diagram

The diagram source is [`docs/architecture/stack.src.html`](docs/architecture/stack.src.html). Edit it, then build and render it with the [stack-diagram skill](https://github.com/caru-ini/stack-diagram). Its `fetch_icons.py` script downloads the logos.
