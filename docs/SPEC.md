# Orbit

Self-hosted chat, shaped like ChatGPT or Claude, running on your machine.

## Goals

- Stream a conversation against any OpenAI-compatible endpoint. Changing provider is a base URL, a key, and a model id.
- No vendor lock-in. Accounts, chats, and settings live in a SQLite file in this repo. The app does not depend on a hosted chat platform.
- The provider API key stays on the server. The browser only learns whether a key is set.
- One user. Signup closes after the first account.
- Later tools are adapters behind the same chat, not a new backend.

## Stack

| Piece | Pin |
| --- | --- |
| Next.js (App Router, TypeScript) | 16.4.3 |
| React / React DOM | 19.3.1 |
| assistant-ui | `@assistant-ui/react` 0.15.32, `@assistant-ui/react-ai-sdk` 1.4.21 |
| AI SDK | `ai` 7.0.159, `@ai-sdk/react` 4.0.163, `@ai-sdk/openai-compatible` 3.0.82 |
| Validation | zod 4.6.7 |
| Database | drizzle-orm 0.45.4, drizzle-kit 0.31.11, better-sqlite3 13.0.3 |
| Auth | better-auth 1.7.14 (email and password) |
| UI | shadcn/ui, Tailwind CSS 4.3.3 |
| Runtime | Node 22 in Docker. The dev machine may be newer. |

`@ai-sdk/react` 4 is the peer required by the assistant-ui AI SDK v7 runtime. It was not in the original pin list.

## Slices

1. **Walking skeleton** (this repo). Auth, settings, streaming chat, SQLite history, Docker bound to `127.0.0.1:3210`. See `docs/slices/01.md`.
2. **Generative UI.** Render model-produced specs with `@json-render/core` and `@json-render/react` at 0.21.3. The unscoped npm name `json-render` is not published.
3. **Search tool.** SearXNG plus Tavily (`@tavily/core`).
4. **Sandbox tool.** `dockerode` container with no network, CPU and memory limits, a read-only root filesystem, and a non-root user.
5. **GitHub.** GitHub's MCP server through `@ai-sdk/mcp`.
6. **Memory.** FTS5, `sqlite-vec`, and Ollama `nomic-embed-text`. A nightly job consolidates memory ("dreaming").
7. **Deploy.** Expose the app through a Cloudflare tunnel at orbit.aduthekaddu.in, behind Cloudflare Access on the free tier. better-auth stays inside.
