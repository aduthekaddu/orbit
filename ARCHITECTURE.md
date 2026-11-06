# Architecture

This page explains how Orbit is put together and why. Read it before you change a route, a table, or the chat stream. Setup is in the [README](README.md). Planned work is in the [roadmap](docs/roadmap.md).

## Bird's-eye view

Orbit is one Next.js process. It serves the pages, the API routes, and the chat stream on `127.0.0.1:3210`. It keeps everything in one SQLite file. The browser talks only to that process. Only the server talks to the model provider, so the API key never leaves the server.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/stack-dark.png">
  <img alt="Orbit stack. The browser runs assistant-ui and json-render. A Docker container runs Next.js, the AI SDK, better-auth, Drizzle, and SQLite. The AI SDK calls an OpenAI-compatible provider. A dashed box holds planned services: SearXNG, Tavily, a Docker sandbox, Ollama, GitHub MCP, and Cloudflare." src="docs/architecture/stack.png">
</picture>

The diagram predates slices 7 and 8. SearXNG, Tavily, and the code sandbox now connect through the tool registry. The remaining dashed nodes are planned, and each node names its slice.

## One chat turn, end to end

1. You type in the composer. assistant-ui sends `POST /api/chat` through `orbitChatTransport` in `src/lib/chat-transport.ts`. The transport puts the open chat id on the request, because assistant-ui would otherwise send its own local thread id.
2. `src/proxy.ts` checks the session cookie. Every page and API route needs a session except `/login`, `/signup`, `/api/auth/*`, and `/api/setup`.
3. `src/app/api/chat/route.ts` parses the body with zod, loads the settings row, and calls `planChatWrite` in `src/lib/messages.ts`. That function saves the incoming user messages and picks the id the reply will be stored under. It rejects a write planned against an older copy of the chat with `409`.
4. The route calls `streamText` from the AI SDK with the model from `orbitModel` in `src/lib/provider.ts` and the tools from `toolsFor(settings)` in `src/lib/tools/index.ts`. The registry always enables `render_ui`, enables `web_search` when a search backend is configured, and enables `run_code` only when the server sets `ORBIT_SANDBOX=on`. The loop stops after at most five model steps. With search enabled, the fifth step receives the completed conversation as JSON data and allows only `render_ui`. It keeps the route instructions so the model can answer with citations, render a card, or write an artifact without searching again.
5. The stream goes back to the browser as AI SDK UI message parts. Text, reasoning, and tool parts render as they arrive.
6. When the stream ends, `onEnd` asks `shouldSaveReply` in `src/lib/messages.ts`, then saves the assistant message with `upsertMessage`. It saves only a reply that has a visible part. A regenerate saves a new sibling and keeps the earlier reply.
7. On reload, `src/app/(app)/c/[id]/page.tsx` loads every message and its parent into the history adapter. The chat opens the path ending at `chats.head_id`.

## The rules of a turn

The chart below is generated from a TLA+ model of steps 3 to 6. TLC, the TLA+ model checker, checks each rule in every reachable state. Each rule is something you can see as a user.

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
  s1: Sending, waiting for text
  s2: Error shown
  s3: Sending, text on screen
  s4: Regenerating, waiting for text
  s5: Idle, reply saved
  s6: Regenerating, text on screen
  [*] --> s0
  s0 --> s1: you send a message
  s1 --> s0: the model finishes or you press stop
  s1 --> s2: the provider fails
  s1 --> s3: text starts to stream
  s2 --> s1: you send a message
  s2 --> s4: you press retry
  s3 --> s5: the model finishes or you press stop
  s3 --> s2: the provider fails
  s4 --> s2: the provider fails
  s4 --> s0: the model finishes or you press stop
  s4 --> s6: text starts to stream
  s5 --> s1: you send a message
  s5 --> s4: you press regenerate
  s4 --> s5: the model finishes or you press stop
  s6 --> s5: the model finishes or you press stop
  s6 --> s2: the provider fails
  class s0 blue
  class s1 orange
  class s2 pink
  class s3 orange
  class s4 orange
  class s5 blue
  class s6 orange
```

These rules hold in every state the model reaches:

- **Nothing is saved without text.** A reply row changes only when you saw text for that turn.
- **Regenerate keeps the old reply.** Every visible new reply is a sibling. A stop or provider failure saves its visible text without changing the earlier reply.
- **A stopped send keeps its text.** If you stop a new message mid-stream, the partial reply is saved and is still there after reload.
- **Text you saw is kept (ShownTextKept).** If you stop and no older reply exists, the text you saw is saved. This covers a retry after a failed first message, which is a regenerate with nothing to replace.

`shouldSaveReply` saves every reply with visible content. [Slice 4](docs/slices/04.md) gives a regenerate a new id, so saving a partial reply preserves the earlier version. A stop before visible content leaves the head on the saved prompt.

The model tracks up to three reply attempts per prompt with separate ids. A regenerate must keep every earlier reply id. `ChatTurnRegression.tla` checks that a finished reply followed by a finished regenerate leaves two versions. Run it with the same TLC command and `ChatTurnRegression.cfg`.

The model leaves out edits, tool calls, and concurrent tabs. The stale-write guard in step 3 covers concurrent tabs, and `src/lib/chat-write.test.ts` tests it.

To rebuild the chart, run the [statechart skill](https://github.com/cursor/plugins/blob/main/pstack/skills/statechart/SKILL.md) on [`docs/architecture/ChatTurn.tla`](docs/architecture/ChatTurn.tla):

```sh
statechart docs/architecture/ChatTurn.tla --config docs/architecture/ChatTurn.cfg --view docs/architecture/chat-turn.view.mjs --out /tmp/chat-turn
```

## Code map

| Path | What lives there |
| --- | --- |
| `src/app/(app)/` | Signed-in pages: the chat at `/c/[id]`, settings, and the app shell layout. |
| `src/app/login/`, `src/app/signup/` | The two public pages. |
| `src/app/api/chat/route.ts` | The chat stream. The only route that calls the model. |
| `src/app/api/chats/` | List and create chats, read one chat. `PATCH .../messages/[messageId]` saves an edited reply. |
| `src/app/api/settings/`, `src/app/api/models/` | Read and save the provider settings. List the provider's models. |
| `src/app/api/setup/` | Tells the login page whether signup is still open. |
| `src/proxy.ts` | The session gate for every request. |
| `src/lib/db/` | The SQLite connection, the Drizzle schema, and the migration lock. |
| `src/lib/messages.ts` | Chat and message reads and writes. All write planning lives here. |
| `src/lib/provider.ts` | The model client, reasoning options, the model list, and provider quirks. |
| `src/lib/settings.ts` | The settings row. `toPublicSettings` is the only shape that leaves the server. |
| `src/lib/tools/` | The tool registry, SearXNG and Tavily search adapters, browser-safe card metadata, and tool status rules. |
| `src/lib/sandbox/` | The fixed container policy, pinned language images, and per-run Docker lifecycle. |
| `src/components/tools/` | Saved tool run cards, search result links, and the generic JSON disclosure. |
| `src/lib/genui/` | The `render_ui` tool: the component catalog, the spec parser, and the system prompt. |
| `src/components/chat/` | Thread, messages, composer, code blocks, inline editors, and the thread map. |
| `src/lib/artifacts/` | Artifact language detection, prompt instructions and the sandboxed frame document. |
| `src/components/artifacts/` | Preview registration, URL selection, lazy compilation and the responsive panel. |
| `src/components/genui/` | The React side of `render_ui`: the component registry and the fallback card. |
| `src/components/shell/` | App shell, sidebar, command palette, and keyboard shortcuts. |
| `src/components/ui/` | shadcn/ui primitives, styled with the tokens in `src/app/globals.css`. |
| `drizzle/` | SQL migrations. `npm run db:generate` writes new ones from `src/lib/db/schema.ts`. |
| `scripts/` | Smoke tests against a running server, the provider check, and the browser QA script with its mock provider. |
| `.agents/skills/verify-orbit/` | The verification skill. It launches a sandboxed server and drives each feature. |

## Data model

All state is in `data/orbit.db`. The directory is mode `0700`, and the database and `data/auth-secret` are mode `0600`.

| Table | Rows | Notes |
| --- | --- | --- |
| `user`, `session`, `account`, `verification` | better-auth's tables | A SQLite trigger, `user_single_row`, rejects a second user. |
| `settings` | One row, `id = 1` | Base URL, provider key, model, reasoning effort, SearXNG URL, and Tavily key. Both keys stay on the server. |
| `chats` | One per conversation | `title` starts as `New chat` and takes the first message's text. `head_id` selects the last written branch. |
| `messages` | One per user or assistant message | `parts` is the AI SDK parts array as JSON, and reload reads it. `content` is the plain text of the text parts. `parent_id` links each message to its parent. `position` is its depth. Siblings stay in creation order. |

Tool output, generated UI specs, and reasoning all live inside `parts`. A new tool needs no new table unless it stores something outside a message.

`run_code` is available only with `ORBIT_SANDBOX=on`. The tool validates language and source, then `runCode` starts a fresh container using only `containerSpec` options. Source arrives on stdin. The runner bounds stdout and stderr, stops work after ten seconds or request cancellation, and removes the container. The saved tool part contains the source and final output. The card reads that part after reload. Compose reaches the Docker API through a private socket proxy. See [Security](SECURITY.md#code-sandbox) for that boundary's limits.

## Rules that hold across the code

- **The key stays on the server.** `GET /api/settings` returns `keySet`, `tavilyKeySet`, and `sandbox` booleans. `sandbox` says only whether the server set `ORBIT_SANDBOX=on`. The browser cannot change it. Logs pass through `sanitize` in the chat route. Tests and smoke scripts redact `ORBIT_API_KEY`.
- **One user.** The auth hook and the database trigger both close signup after the first account.
- **Validate at the edge.** Routes parse request bodies with zod. Tool input is parsed by the tool's schema and then by `parseRenderSpec`. Code behind those checks trusts its types.
- **The server owns history.** The client sends its copy of the thread, but `planChatWrite` decides what is stored and refuses a write against a changed chat.
- **Bind to localhost.** Docker Compose publishes `127.0.0.1:3210` only. Remote access is planned behind Cloudflare Access in [slice 12](docs/slices/12.md).

## Feature boundaries

Shipped and planned slices use these boundaries. The plans in [`docs/slices/`](docs/slices/) give the details.

- **Tools.** `toolsFor(settings)` in `src/lib/tools/` builds the enabled tools. [Slice 7](docs/slices/07.md) adds SearXNG search with Tavily as a fallback. Each backend has an eight-second timeout. Tavily cancellation uses a request-scoped signal adapter because the pinned SDK has no signal option. Concurrent requests keep separate signals. The browser shares only card metadata with the registry. Run cards derive running, succeeded, failed, or cancelled from message parts and survive reload. Unknown tools show their output behind a disclosure.
- **Artifacts.** [Slice 5](docs/slices/05.md) renders HTML, SVG, and React code blocks in a side panel. The code runs in an `<iframe sandbox="allow-scripts">` with a strict Content Security Policy, so it cannot read the app's cookies or call its API.
- **History.** Messages form a tree. Edits and regenerates add siblings, and the branch picker switches between them. A reload opens the last written branch. Switching alone does not update `head_id`.
- **Search.** [Slice 6](docs/slices/06.md) adds an FTS5 index (SQLite full-text search) over `messages`, kept in sync by triggers.
- **Memory.** [Slice 10](docs/slices/10.md) adds a `memories` table with its own FTS5 index and a `sqlite-vec` table for embeddings from Ollama. [Slice 11](docs/slices/11.md) fills it from the day's chats each night.

## Rebuild the stack diagram

The diagram source is [`docs/architecture/stack.src.html`](docs/architecture/stack.src.html). Edit it, then build and render it with the [stack-diagram skill](https://github.com/caru-ini/stack-diagram). Its `fetch_icons.py` script downloads the logos.
