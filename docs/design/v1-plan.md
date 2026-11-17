# What Orbit v1 should fix and build next

This page answers one question for the maintainer: what should the next round of v1 work be, and in what order? It covers the gaps you named on 14 November 2026. Those are the reading experience, the built-in components, a model and effort picker in the chat, appearance settings, sharing, file and artifact management, Anthropic keys, plugins you can verify, and accounts for more than one person. It also adds gaps that came up while using the app.

The [gap analysis](gap-analysis.md) already covers lost replies (B1), the returning sign-in page (B2), and gaps G1 to G8. This page does not repeat that evidence. It refers to those items by their IDs and puts them into one order with the new work.

## How the evidence was gathered

- **Using the app.** Orbit at `origin/main` `291149c` ran on a spare port with an empty data folder and the mock provider. Chromium drove it through Playwright at 1440x900, at 390x844 (iPhone size), and at 360x740 (small Android). The run took 113 screenshots and measured font sizes, line lengths, colors, tap targets, overflow, and contrast on every screen. Real iOS Safari, a real phone keyboard, the code sandbox, and GitHub cards were not tested.
- **Reading the code.** File references point at `291149c`.
- **The benchmarks.** These come from vendor help pages, the docs and GitHub issues of Open WebUI, LibreChat, LobeHub, TypingMind, and AnythingLLM, and GitHub security advisories. User sentiment comes from the OpenAI community forum, GitHub issues, Nielsen Norman Group, and news coverage. Reddit and OpenAI's help center refused automated requests, so OpenAI product facts come from news coverage. The [sources](#sources) list has every page that was read.

## The reading problem is size and line length, not contrast

You said the font is too small and reading is tiring. The measurements agree, and they point at two causes.

| What was measured | Result | Where it comes from |
| --- | --- | --- |
| Share of visible characters at 14px or smaller | 88 to 100% on every chat screen. No text is 15 or 16px. | Prose is `text-sm` with a 24px line (`src/components/chat/markdown-text.tsx:112`). The composer, user messages, and tables are 14px too. |
| Secondary text | Code 12px, inline code 11.9px, the model chip and code language 11px, tool-card headers and form labels 12px | `text-xs` and `text-2xs` (11px) are used 45 times. 92% of all size classes in `src/` are 14px or smaller. |
| Line length on desktop | About 100 characters. A comfortable line is 45 to 75. | 14px text in a 680px column (`max-w-widget`, `src/app/globals.css:129`) |
| Contrast of gray text | 5.57 to 5.92. All pass WCAG AA. | `--orbit-muted` on the dark surfaces |
| Inputs | All 14px. iOS Safari zooms the page when you tap a field under 16px. | `composer.tsx:26`, `ui/input.tsx:10`, the message editor, the palette, and memory fields. The zoom is inferred from the rule. It was not seen on an iPhone. |

The contrast numbers rule out color as the cause. Small text set in long lines is what makes long answers tiring. Users of ChatGPT say the same thing about its October 2026 redesign. They call it "too small" and ask for a text size setting, which ChatGPT still does not have ([OpenAI forum](https://community.openai.com/t/please-restore-the-previous-chatgpt-layout-and-improve-accessibility/1408254), [OpenAI forum](https://community.openai.com/t/chatgpt-text-size-resets-when-switching-chats-after-recent-update-on-macos/1380680)). Nielsen Norman Group found that "a longer answer was not a better answer", and that streaming makes a wall of text worse ([NN/g](https://nngroup.com/articles/less-chat-more-answer)).

One fact helps. Every size is in `rem` and the root size is the browser default, so one root font-size setting scales the whole UI.

## Why the components look generic

The audit and the screenshots found the same pattern in every built-in component. Everything is a gray bordered box with small gray labels. Each item below names the screenshot or file that shows it.

- **Generated UI is framed as a tool run.** A widget sits inside a "Generated UI ... Succeeded" header (`run-card.tsx:41`, `messages.tsx:44`), then a bordered card (`registry.tsx:16`), then a bordered metric (`registry.tsx:23`). On a 360px phone that is three borders deep before any content.
- **Two text colors and five backgrounds.** Every widget background sits between `rgb(11,12,15)` and `rgb(29,30,36)`. The info and success callouts are gray, and warning uses the error red (`registry.tsx:9-10`). Widgets never use the `--info`, `--warning`, or `--chart-*` tokens.
- **Numbers print raw.** "1234" and "42000" show without separators or tabular figures (`registry.tsx:25`), which breaks a rule in `docs/design.md`.
- **Long content has no limit.** A 220-row table widget is 12,669px tall, which is 15 phone screens. It hides 4 of its 8 columns with no sign that it scrolls.
- **Errors dump JSON.** An invalid widget shows a zod path and 30 lines of JSON to the user (`render-ui.tsx:24`). `docs/design.md` says this disclosure should start collapsed.
- **Tool cards never settle.** Every search result, memory save, and code run stays a full bordered card with a 12px gray status word after it succeeds. Names are inconsistent: "Web search", "Generated UI", and the raw tool name `remember`. Search results show a gray letter square instead of a site icon.
- **Artifacts render as bare white pages.** The iframe document has no stylesheet (`src/lib/artifacts/document.ts:44`), so an HTML artifact shows in Times on white with default buttons, inside the dark app. In the thread an artifact is only an 11px "Preview" text button (`code-block.tsx:74-83`), and every download is named `artifact.<lang>` (`artifact-panel.tsx:114`).
- **Phone problems.** The page itself never scrolls sideways at any size, so "breaks on mobile" means clipping inside components. Command palette rows are 513px wide inside a 358px dialog, so titles are cut mid-letter. Code blocks scroll 924px inside a 356px box with no wrap option. The scroll-to-bottom button covers words in the middle of the text. In the drawer, Settings is an unlabeled row that shows your email, Memory is reachable only from the command palette, and sign-out acts at once (`sidebar.tsx:127`).
- **Missing basics.** You cannot rename or delete a chat, because the chat route only answers `GET`. Empty "Untitled" chats pile up in the sidebar. Search snippets show raw `[ ]` highlight markers and raw `#` markdown (`src/lib/search.ts:71`). Long pasted messages never collapse.

Several things are good and should stay. These are the token system in one file, `ScrollFade` and the code-block cap, the code-run card details (copy per output, escape-code stripping, a single honest result line), the 44px touch rule in `globals.css`, reduced-motion handling, `OrbitMark`, the thread map, the hairline figures, and the artifact sandbox with its strict CSP.

## Several people, in one of three hosting modes

`docs/roadmap.md` listed "Serve one user" as a goal and "Several users, teams, or sharing" as a non-goal, and `ARCHITECTURE.md` states the one-user rule. On 14 November 2026 you confirmed that several people should be able to use one install. You also asked for freedom over API keys, depending on who the install is for. [ADR 0002](../adr/0002-several-users.md) records the decision, and [slice 18](../slices/18.md) builds it.

Opening signup today would leak data between people. The code was checked for each item below.

- **Memories have no owner.** The `memories` table has no user column, and its unique index on `text_norm` is global (`src/lib/db/schema.ts`). Any user could list, edit, and delete everyone's memories through `api/memories/*` and the Memory page. The embedding job scans every memory, and recall searches one shared vector index, so one person's memories would reach another person's prompt (`embed.ts:59`, `recall.ts:66`, `chat/route.ts:112`).
- **Dreaming reads every chat.** `changedChatIds` in `src/lib/memory/dream.ts` selects every message in the time window, whoever wrote it.
- **One settings row holds every key.** Settings code reads and writes one row, `id = 1` (`src/lib/settings.ts:39`). Any signed-in user could overwrite the provider key through `PUT /api/settings`. Model listing and the GitHub check read the same row, and the GitHub token is shared, so every user's model could read the owner's private repositories (`tools/index.ts:49`).
- **No roles.** The `user` table has no role column. The one-account rule is a database trigger, `user_single_row` in `src/lib/db/index.ts`, plus a hook in `src/lib/auth.ts:43-52`.

Chats and search already filter by user, and message routes check that the chat belongs to the signed-in user. That makes the job smaller than it looks.

Competing apps shipped exactly these bugs. Open WebUI and LibreChat have advisories for missing ownership checks on chats, files, memories, and keys. They also have advisories for stored script injection in shared chats and for request forgery through a user-set provider URL. One Open WebUI advisory let a person sign in as another user through SQLite wildcard matching ([GHSA-wpmr-8h3q-fwj7](https://github.com/open-webui/open-webui/security/advisories/GHSA-wpmr-8h3q-fwj7)).

Each install picks one hosting mode:

- **`personal`.** One person, as today. Signup closes after the first account, and that account owns the provider connections. Every existing install migrates to this mode.
- **`team`.** The admin invites people with single-use links. Only the admin adds provider connections, and every member uses them. Members cannot enter their own API keys.
- **`community`.** Orbit is hosted for other people. Signup is by invite, or open if the admin turns it on. Each person adds their own provider connections and keys.

Slice 18 comes before files, artifacts, sharing, and tool servers, so each new table has an owner column and an owner check from its first row. Cloudflare Access stays optional, and you have not chosen yet. Every plan works behind Access and without it. Behind Access, an invited member's email goes into the Access policy before the invite is sent, so only share links in slice 22 need an Access bypass rule.

## The plan, in order

The order follows your instruction to fix the built-in components first. After that, foundations come before the features that build on them. Each slice has a full build plan in `docs/slices/`, written for the three-turn workflow in [`docs/slices/README.md`](../slices/README.md). Sizes are estimates. S is a day or less, M is a few days, and L is a week or more.

| Slice | Plan | Covers | Size | Depends on |
| --- | --- | --- | --- | --- |
| 13 | [Replies that survive a dropped connection](../slices/13.md) | B1, G5 | M | |
| 14 | [Reading foundation and appearance](../slices/14.md) | Font size, color, themes | M | |
| 15 | [Widgets and tool cards](../slices/15.md) | Generic-looking components | M | 14 |
| 16 | [Messages, artifact cards, phone fixes, rename and delete](../slices/16.md) | Phone problems, missing basics | L | 14 |
| 17 | [Model and effort in the chat, plus Anthropic](../slices/17.md) | G1, Anthropic keys | L | 14 |
| 18 | [Accounts and hosting modes](../slices/18.md) | Several users, G7 | L | 14, 17 |
| 19 | [Tools page and tools sheet](../slices/19.md) | Verifying plugins, G6 | M | 18 |
| 20 | [Files](../slices/20.md) | File management | L | 17, 18 |
| 21 | [Artifacts page](../slices/21.md) | Artifact management | M | 16, 18 |
| 22 | [Share links](../slices/22.md) | Sharing | M | 18, 20, 21 |
| 23 | [Remote MCP servers](../slices/23.md) | More plugins | L | 18b, 19 |

Slice 13 can ship at any time, in parallel with the component work, because B1 loses tokens you pay for. G2 (memory in the chat) fits after slice 18, because memories become per user there. G4 (usage) fits after slice 17, because it needs the model recorded on each reply. B2 and G8 stay small `fix/` PRs.

What each slice changes for a person using Orbit:

- **[Slice 13](../slices/13.md).** A reply keeps generating and is saved when the phone drops the connection, and a long think shows a timer. Only **Stop** ends a reply, so closing the tab no longer cancels it.
- **[Slice 14](../slices/14.md).** Prose moves to 16px in a reading column near 36rem. Turn 1 measures the exact width, because no prototype was built. Inputs move to 16px so iOS stops zooming. Themes are dark, dim, light, and system, with settings for text size, a sans or serif reply font, chat width, and an accent. Custom CSS stays out.
- **[Slice 15](../slices/15.md).** Generated UI renders in the reply with one surface, formatted numbers, status colors, and capped tables. Metric changes use the positive and negative colors. Search, memory, and GitHub cards collapse to one line after success. Code-run cards stay open, because their output is often the answer.
- **[Slice 16](../slices/16.md).** Long messages collapse, and a streaming reply stops pulling the page once its start reaches the top. Artifacts get a card and a themed preview, phone clipping is fixed, and chats can be renamed and deleted with a five-second undo.
- **[Slice 17](../slices/17.md).** The model and effort move into the composer, as a popover on desktop and a sheet on phones. Provider keys move into encrypted `provider_connections`. Anthropic works through its native API, not its OpenAI-compatible URL, which Anthropic calls "not considered a long-term or production-ready solution" ([Anthropic OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk)). Each reply records the model that wrote it and whether the provider ignored the effort.
- **[Slice 18](../slices/18.md).** Two PRs. 18a scopes every table, query, and background job to its user while signup stays closed. 18b adds the hosting modes, invite links, and admin pages. A test calls every route with another user's IDs, and members get a 403 from every admin route.
- **[Slice 19](../slices/19.md).** One page lists every tool with a **Test** button that makes a real call, the time of its last good call, and the exact schemas the model sees. A sheet in the composer turns tools on or off for one chat.
- **[Slice 20](../slices/20.md).** Attach files, see a chat's files, and find, download, or delete any file later. Images and PDFs go only to models that accept them. It also closes a path where a pasted file is stored in the database as a `data:` URL today. That path is inferred from the code, and turn 1 reproduces it.
- **[Slice 21](../slices/21.md).** An Artifacts page with search, rename, downloads named after the title, and a versions list that stays visible.
- **[Slice 22](../slices/22.md).** A read-only snapshot link with a preview of exactly what goes public, `noindex`, a strict CSP, update, revoke, and an optional expiry.
- **[Slice 23](../slices/23.md).** Connect outside tool servers over MCP. Every new tool starts on Ask, an approval card shows the arguments before a call runs, and a changed tool list asks again.

## Questions for you

Each plan picks a default for these so an implementer is never blocked. Answer any you disagree with before that slice starts.

| Slice | Question | Default in the plan |
| --- | --- | --- |
| 13 | Closing the tab no longer stops a reply. Only **Stop** does. Is that right? | Yes |
| 13 | Are 4 running replies per person and a 64 MB replay buffer right? | Yes, as starting values |
| 14 | Should a new install start on the dark theme or follow the system? | Dark |
| 14 | Which self-hosted serif for replies, Source Serif 4 or Literata? | Source Serif 4 |
| 14 | Are the accent presets sun, sky, rose, and sand right? | Yes |
| 15 | Should code-run cards also collapse after success? | No, they stay open |
| 15 | Is a chart widget wanted later? | Not planned |
| 16 | May a one-time migration delete today's empty "Untitled" chats? It cannot be undone. | Yes |
| 16 | Should memories made from a deleted chat stay? | Yes, with the chat link cleared |
| 16 | Is a five-second undo for delete right? | Yes |
| 17 | Should a chat lock its model on the first message, so later default changes do not move it? | Yes |
| 17 | Should Anthropic's refusal fallback be on? | Off |
| 18 | In `community`, each person enters their own provider key. Is that the exception you meant when you said members should not enter keys? | Yes |
| 18 | Keep Cloudflare Access in front of the public deployment? | Works both ways |
| 18 | Should `team` members have a spending budget on the admin's key? | No budget yet |
| 18 | Is one admin with no transfer of the role acceptable? | Yes |
| 18 | Is `community` signup without email verification acceptable? | Yes, with better-auth's rate limit |
| 18 | Is removing a person without a data export first acceptable? | Yes |
| 19 | In `community`, should the admin's search key and sandbox serve every member? Nothing caps their total use across the install, and anyone who can sign up can spend the admin's Tavily credits and run code in the sandbox. | Yes, with no install-wide cap |
| 19 | Should generated UI have a per-chat switch? | No, always on |
| 20 | Are 5 MB per image, 10 MB per PDF, and 1 MB per text file right? | Yes, with `ORBIT_FILES_MAX_MB` |
| 20 | When a model's image or PDF support is unknown, should Orbit refuse the file? | Yes |
| 20 | Pasted files saved before slice 20 stay inside their messages and do not appear in the Files list. Is that acceptable? | Yes |
| 22 | Should an admin be able to turn sharing off for the install? | No switch |
| 23 | Should an admin share an MCP server with every member in `team`? | Not planned |

## What the benchmarks still get wrong

The reviews point at things neither ChatGPT nor Claude.ai does well. A small self-hosted app can win on these. The plan above already includes each one.

- Reading settings that stay put: text size, width, and a serif option.
- The model and effort shown on every reply, plus a notice when the provider ignored the effort.
- A calm scroll while a reply streams, and a prompt outline on phones.
- A share preview that shows exactly what goes public, with an expiry.
- An undo for deleted chats, and artifact versions that stay reachable.
- Tool lists pinned at approval.
- An honest note on how much of a file the model read.

## What this page does not settle

- **Long-chat speed.** Users report that long ChatGPT chats lag because every message stays rendered ([OpenAI forum](https://community.openai.com/t/chatgpt-performance-degradation-makes-conversations-unusable/1339446)). Orbit was not measured with a long chat. Measure a 200-message chat before building anything for it.
- **iOS behavior.** The input zoom and the keyboard covering the composer are inferred, not seen. Test both on a real iPhone in slice 14.
- **A reply style setting.** OpenAI added a setting for how many headers and lists replies use ([OpenAI forum](https://community.openai.com/t/excessive-bullet-point-formatting-issue-in-chatgpt-responses/1097391)). It may be worth a personal setting in slice 18. That is a product call.
- **Build status.** `docs/roadmap.md` lists slices 13 to 23 as planned. Nothing on this page or in the plans is built yet.

## Sources

Orbit evidence:

- The tour screenshots and measurements are attached to the pull request, not committed.

User reports and research:

- [Please restore the previous ChatGPT layout and improve accessibility](https://community.openai.com/t/please-restore-the-previous-chatgpt-layout-and-improve-accessibility/1408254), OpenAI forum
- [ChatGPT text size resets when switching chats](https://community.openai.com/t/chatgpt-text-size-resets-when-switching-chats-after-recent-update-on-macos/1380680), OpenAI forum
- [The new super dark ChatGPT UI is a nightmare for astigmatism](https://community.openai.com/t/the-new-super-dark-chatgpt-ui-is-a-nightmare-for-astigmatism/1382499), OpenAI forum
- [Smarter auto-scrolling for long responses](https://community.openai.com/t/feature-request-smarter-auto-scrolling-for-long-chatgpt-responses/1389613), OpenAI forum
- [Prompt-first view for long chats](https://community.openai.com/t/feature-request-prompt-first-view-collapse-assistant-responses-for-long-chats/1380760), OpenAI forum
- [ChatGPT performance degradation in long conversations](https://community.openai.com/t/chatgpt-performance-degradation-makes-conversations-unusable/1339446), OpenAI forum
- [Excessive bullet point formatting](https://community.openai.com/t/excessive-bullet-point-formatting-issue-in-chatgpt-responses/1097391), OpenAI forum
- [Less chat, more answer](https://nngroup.com/articles/less-chat-more-answer), Nielsen Norman Group
- [More theme and color options for the Claude.ai chat interface](https://github.com/anthropics/claude-code/issues/55635), GitHub, May 2026
- [Artifact version history removed from the viewer menu](https://github.com/anthropics/claude-code/issues/96718), GitHub, September 2026
- [ChatGPT's model picker is back](https://techcrunch.com/2025/08/12/chatgpts-model-picker-is-back-and-its-complicated), TechCrunch, August 2025
- [OpenAI is removing ChatGPT conversations from Google](https://www.engadget.com/ai/openai-is-removing-chatgpt-conversations-from-google-194735704.html), Engadget

Product docs:

- [Change the model, effort, and thinking settings](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings), Claude help
- [Sharing chats](https://support.claude.com/en/articles/10593882), Claude help
- [OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk), Anthropic
- [Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), AI SDK
- [Developer mode](https://developers.openai.com/api/docs/guides/developer-mode.md), OpenAI
- [Shareable links](https://www.librechat.ai/docs/features/shareable_links) and [Upload as text](https://www.librechat.ai/docs/features/upload_as_text), LibreChat
- [Roles](https://docs.openwebui.com/features/authentication-access/rbac/roles.md) and [Interface defaults](https://docs.openwebui.com/features/administration/interface-defaults.md), Open WebUI
- [Reasoning effort is silently ignored](https://github.com/open-webui/open-webui/issues/33584), Open WebUI issue
- [Security best practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices), Model Context Protocol
- [GHSA-wpmr-8h3q-fwj7](https://github.com/open-webui/open-webui/security/advisories/GHSA-wpmr-8h3q-fwj7), Open WebUI advisory
