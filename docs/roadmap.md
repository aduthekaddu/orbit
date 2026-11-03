# Roadmap

Orbit is a self-hosted chat app for one person, shaped like ChatGPT or Claude, that runs on your own machine. This page lists what Orbit is for, what has shipped, and what comes next. Each planned slice links to a build plan in [`docs/slices/`](slices/README.md).

## Goals

- Stream a conversation against any OpenAI-compatible endpoint. To change provider, you change a base URL, a key, and a model id.
- Keep every account, chat, and setting in one SQLite file on your machine. Orbit does not depend on a hosted chat platform.
- Keep the provider API key on the server. The browser only learns whether a key is set.
- Serve one user. Signup closes after the first account.
- Add tools as adapters behind the same chat, not as a new backend.

## Non-goals

- Several users, teams, or sharing.
- A hosted service. You run Orbit yourself.
- A mobile app. The web app works on a phone.

## Slices

| # | Slice | What a user gets | Status |
| --- | --- | --- | --- |
| 1 | [Walking skeleton](slices/01.md) | Sign up, set a provider, stream a chat that survives reload. | Shipped |
| 2 | [Generative UI](slices/02.md) | The model can answer with cards, tables, and metrics. | Shipped |
| 3 | [Chat polish](slices/03.md) | Starter prompts, fixes from issue #11, and no lost text after retry and stop. | Shipped |
| 4 | [Branching](slices/04.md) | Edit and regenerate keep the old version. Arrows switch between versions. | Draft in #17 |
| 5 | [Artifact panel](slices/05.md) | HTML, SVG, and React code from the model runs in a side panel. | Planned |
| 6 | [Titles and history search](slices/06.md) | Short model-written titles. ⌘K finds any message. | Draft in #19 |
| 7 | [Web search](slices/07.md) | The model searches through SearXNG or Tavily and cites sources. | Planned |
| 8 | [Code sandbox](slices/08.md) | The model runs Python or JavaScript in a locked-down container. | Planned |
| 9 | [GitHub](slices/09.md) | The model reads your repositories, issues, and pull requests. | Planned |
| 10 | [Memory](slices/10.md) | Orbit remembers facts across chats. A page lists and edits them. | Planned |
| 11 | [Dreaming](slices/11.md) | A nightly job turns the day's chats into memories. | Planned |
| 12 | [Deploy](slices/12.md) | Reach Orbit from anywhere behind Cloudflare Access. | Planned |

Between slices 2 and 3, two pull requests shipped without a slice number: the design system (#3) and inline editing (#5).

## Issue #11

[Issue #11](https://github.com/aduthekaddu/orbit/issues/11) compares Orbit with ChatGPT and Claude. This table shows where each item lands.

| Item | Where |
| --- | --- |
| Stop button while streaming | Shipped in #2 |
| Edit a sent message | Shipped in #5, as replace. Slice 4 makes it a branch. |
| Branch from any point | Slice 4 |
| Suggested prompts on an empty chat | Shipped in #16 |
| Palette stays open, Esc, short-screen Save, duplicate "New chat" | #16 shows `Untitled` for an untitled chat. The palette and Save did not reproduce. |
| Placeholder text | Shipped in #16 |
| Artifacts | Slice 5 |
| Smart titles and full-text search | Slice 6 |
| A first-run hint for ⌘K | Not planned. The project avoids helper text. |
| Projects, styles, and personas | Not planned yet |

## Later

These items have no slice yet:

- Write tools for GitHub, behind an approval step in the chat.
- Live output from the code sandbox while it runs.
- Checking the Cloudflare Access token inside Orbit.
- Projects that group chats with shared context.
