# Roadmap

Orbit is a self-hosted chat app, shaped like ChatGPT or Claude, that runs on your own machine. This page lists what Orbit is for, what has shipped, and what comes next. Each planned slice links to a build plan in [`docs/slices/`](slices/README.md).

## Goals

- Stream a conversation against any OpenAI-compatible endpoint, or against the Anthropic API from slice 17. To change provider, you change a base URL, a key, and a model id.
- Keep every account, chat, and setting in one SQLite file on your machine. Orbit does not depend on a hosted chat platform.
- Keep the provider API key on the server. The browser only learns whether a key is set.
- Serve one person by default. From slice 18, an admin can host Orbit for a team or for other people instead ([ADR 0002](adr/0002-several-users.md)).
- Add tools as adapters behind the same chat, not as a new backend.

## Non-goals

- A hosted service. You run Orbit yourself.
- A mobile app. The web app works on a phone.

## Slices

| # | Slice | What a user gets | Status |
| --- | --- | --- | --- |
| 1 | [Walking skeleton](slices/01.md) | Sign up, set a provider, stream a chat that survives reload. | Shipped |
| 2 | [Generative UI](slices/02.md) | The model can answer with cards, tables, and metrics. | Shipped |
| 3 | [Chat polish](slices/03.md) | Starter prompts, fixes from issue #11, and no lost text after retry and stop. | Shipped |
| 4 | [Branching](slices/04.md) | Edit and regenerate keep the old version. Arrows switch between versions. | Shipped in #17 |
| 5 | [Artifact panel](slices/05.md) | HTML, SVG, and React code from the model runs in a side panel. | Shipped in #18 |
| 6 | [Titles and history search](slices/06.md) | Short model-written titles. ⌘K finds any message. | Shipped in #19 |
| 7 | [Web search](slices/07.md) | The model searches through SearXNG or Tavily and cites sources. | Shipped in #20 |
| 8 | [Code sandbox](slices/08.md) | The model runs Python or JavaScript in a locked-down container. | Shipped in #21 |
| 9 | [GitHub](slices/09.md) | The model reads your repositories, issues, and pull requests. | Shipped in #56 |
| 10 | [Memory](slices/10.md) | Orbit remembers facts across chats. A page lists and edits them. | Shipped in #55 |
| 11 | [Dreaming](slices/11.md) | A nightly job turns the day's chats into memories. | Shipped in #57 |
| 12 | [Deploy](slices/12.md) | Reach Orbit from anywhere behind Cloudflare Access. | Shipped in #58 |
| 13 | [Replies that survive a dropped connection](slices/13.md) | A reply keeps generating and saving when the phone drops the connection, and thinking shows a timer. | Shipped in #256 |
| 14 | [Reading foundation and appearance](slices/14.md) | Larger text, a narrower reading column, dark, dim, light, and system themes, and settings for text size, font, and width. | Shipped in #261 |
| 15 | [Widgets and tool cards](slices/15.md) | Generated UI and tool results read as part of the reply, with real color and formatted numbers. | Planned |
| 16 | [Messages, artifact cards, phone fixes, rename and delete](slices/16.md) | Long messages collapse, artifacts get a card and a themed preview, phone layouts stop clipping, and chats can be renamed and deleted. | Shipped in #273 |
| 17 | [Model and effort in the chat, plus Anthropic](slices/17.md) | Pick the model and effort for each chat from the composer. Add an Anthropic key. | Shipped in #264 |
| 18 | [Accounts and hosting modes](slices/18.md) | Host Orbit for yourself, a team, or other people, with invites and per-user data. | Planned |
| 19 | [Tools page and tools sheet](slices/19.md) | Test every tool from one page, and switch tools on or off for a chat. | Planned |
| 20 | [Files](slices/20.md) | Attach files to a chat, and find, download, or delete them later. | Planned |
| 21 | [Artifacts page](slices/21.md) | Find, rename, download, and compare versions of every artifact. | Planned |
| 22 | [Share links](slices/22.md) | Share a read-only snapshot of a chat, then update or revoke it. | Planned |
| 23 | [Remote MCP servers](slices/23.md) | Connect outside tool servers, and approve each tool before it runs. | Planned |

Between slices 2 and 3, two pull requests shipped without a slice number: the design system (#3) and inline editing (#5).

## Issue #11

[Issue #11](https://github.com/aduthekaddu/orbit/issues/11) compares Orbit with ChatGPT and Claude. This table shows where each item lands.

| Item | Where |
| --- | --- |
| Stop button while streaming | Shipped in #2 |
| Edit a sent message | Shipped in #17 with version history. |
| Branch from any point | Shipped in #17 |
| Suggested prompts on an empty chat | Shipped in #16 |
| Palette stays open, Esc, short-screen Save, duplicate "New chat" | #16 shows `Untitled` for an untitled chat. The palette and Save did not reproduce. |
| Placeholder text | Shipped in #16 |
| Artifacts | Shipped in #18 |
| Smart titles and full-text search | Shipped in #19 |
| A first-run hint for ⌘K | Not planned. The project avoids helper text. |
| Projects, styles, and personas | Not planned yet |

## Later

These items have no slice yet:

- Write tools for GitHub, behind an approval step in the chat.
- Live output from the code sandbox while it runs.
- Checking the Cloudflare Access token inside Orbit.
- Projects that group chats with shared context.
