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
| Share of visible characters at 14px or smaller | 88 to 100% on every chat screen. No text is 15 or 16px. | Prose is `text-sm` with a 24px line (`src/components/markdown-text.tsx:112`). The composer, user messages, and tables are 14px too. |
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

## Decide first whether Orbit serves one person or several

`docs/roadmap.md` lists "Serve one user" as a goal and "Several users, teams, or sharing" as a non-goal. `ARCHITECTURE.md` states the one-user rule too. Your request reverses that decision. Record the new decision in `docs/adr/`, and change the roadmap and architecture docs with the first multi-user slice.

Opening signup today would leak data between people. The code was checked for each item below.

- **Memories have no owner.** The `memories` table has no user column, and its unique index on `text_norm` is global (`src/lib/db/schema.ts`). Any user could list, edit, and delete everyone's memories through `api/memories/*` and the Memory page. The embedding job scans every memory, and recall searches one shared vector index, so one person's memories would reach another person's prompt (`embed.ts:59`, `recall.ts:66`, `chat/route.ts:112`).
- **Dreaming reads every chat.** `changedChatIds` in `src/lib/memory/dream.ts` selects every message in the time window, whoever wrote it.
- **One settings row holds every key.** Settings code reads and writes one row, `id = 1` (`src/lib/settings.ts:39`). Any signed-in user could overwrite the provider key through `PUT /api/settings`. Model listing and the GitHub check read the same row, and the GitHub token is shared, so every user's model could read the owner's private repositories (`tools/index.ts:49`).
- **No roles.** The `user` table has no role column. The one-account rule is a database trigger, `user_single_row` in `src/lib/db/index.ts`, plus a hook in `src/lib/auth.ts:43-52`.

Chats and search already filter by user, and message routes check that the chat belongs to the signed-in user. That makes the job smaller than it looks.

Competing apps shipped exactly these bugs. Open WebUI and LibreChat have advisories for missing ownership checks on chats, files, memories, and keys. They also have advisories for stored script injection in shared chats and for request forgery through a user-set provider URL. One Open WebUI advisory let a person sign in as another user through SQLite wildcard matching ([GHSA-wpmr-8h3q-fwj7](https://github.com/open-webui/open-webui/security/advisories/GHSA-wpmr-8h3q-fwj7)).

**Recommendation.** Build the multi-user foundation before files, artifacts, and sharing. Each of those adds a new table. If the tables are born with an owner column and an owner check, nothing has to be retrofitted later. If you decide to stay with one user, skip that step and the later ones stay the same size.

The foundation needs these parts:

- A `user_id` column on `memories` and `memory_runs`, a per-user unique index, per-user dreaming, and a user filter in the embedding and recall helpers. `memory_runs.owner` already exists, but it is a job lease ID, not a user.
- Settings split in two. **Instance** settings are for the admin: provider connections, signup mode, and tools. **Personal** settings are for each user: default model, appearance, memory, and their own GitHub token.
- Two roles, `admin` and `member`. The migration makes the existing account the admin, so current installs keep working.
- A signup mode of `closed` (today's behavior and the default) or `invite`, where the admin creates single-use links. Open signup, approval queues, and single sign-on can come later.
- Deleting a user deletes all their data.
- A test that calls every route with another user's IDs and expects a 404, and a test that a member gets a 403 from every admin route, such as `PUT /api/settings`. Those tests, not review, keep the next table from leaking.

Two choices here are yours:

- **Who pays for model calls.** The simplest choice is admin-set connections that every user shares. Per-user keys and per-user model limits can come later.
- **How Cloudflare Access fits.** The public deployment sits behind Access, which already limits who can reach Orbit by email. With several users, each person needs a place in the Access policy, or the public site moves to Orbit's own sign-in.

## The plan, in order

The order follows your instruction to fix the built-in components first. After that, it puts foundations before the features that build on them. Sizes are estimates: S is a day or less, M is a few days, and L is a week or more.

| # | Step | Covers | Size | Depends on |
| --- | --- | --- | --- | --- |
| 0 | Any time, in parallel: fix lost replies, and add rename and delete for chats | B1, G5, missing basics | M, S | |
| 1 | Reading foundation and appearance settings | Font size, color, themes | M | A prototype to pick the direction |
| 2 | Components that belong in a conversation | Widgets, tool cards, artifacts in the thread, phone fixes | L, as two PRs | 1 |
| 3 | Model and effort in the chat, plus Anthropic | G1, Anthropic keys | M | |
| 4 | Multi-user foundation and the settings split | Accounts, G7 | L | Your decision above |
| 5 | A Tools page that tests every tool, and a tools sheet in the chat | Verifying plugins, G6 | M | 4 |
| 6 | Files in a chat and a Files page | File management | L | 3, 4 |
| 7 | An Artifacts page | Artifact management | M | 2, 4 |
| 8 | Share links | Sharing | M | 4, and the `artifacts` table from 7 |
| 9 | Remote MCP servers with per-tool permissions | More plugins | L | 5 |

Gap G2 (memory in the chat) fits after step 4, because memories become per user there. G4 (usage) fits after step 3, because it needs the model recorded on each reply. G8 (sessions) and B2 (the sign-in page) stay small `fix/` PRs.

### 0. Lost replies, and rename and delete

B1 loses tokens you pay for, so its fix should not wait behind the component work. The [gap analysis](gap-analysis.md#b1-a-dropped-connection-kills-the-reply-and-wastes-its-tokens) has the root cause and the plan. Rename and delete are a small `fix/` PR: add `PATCH` and `DELETE` to the chat route, put a menu on each sidebar row, and create a chat row only when its first message is sent, so empty "Untitled" chats stop piling up. Make delete undoable for a few seconds. If the B1 fix lands first, deleting a chat must also stop its running reply and clear its saved stream.

### 1. Reading foundation and appearance

Start with a throwaway HTML prototype. It should show two type and color directions, in dark and light, at phone and desktop width, using a real long answer, a widget, and a tool card. Pick a direction from the prototype, then build it. This is cheaper than arguing about it in code review.

The likely shape:

- **Type scale.** Set prose at 16px with a line height near 1.65. Narrow the reading column to about 38rem, so a line holds 65 to 75 characters. The width is an estimate for the prototype to confirm. Set inputs at 16px so iOS stops zooming. Put meta text at 13px or more. Use 11px only for keyboard hints. Make `h4` and `h5` distinct from body text.
- **Color roles.** Use the status tokens for their meaning: info, success, warning, and error. Use `--chart-*` for metric deltas and series. Give search results colored letter tiles computed from the domain, so the browser fetches nothing from a third party. Keep the sun as the one brand color.
- **Appearance settings.** Offer a theme of dark, light, or system, plus a soft-gray dark for people who find near-black hard to read ([OpenAI forum](https://community.openai.com/t/the-new-super-dark-chatgpt-ui-is-a-nightmare-for-astigmatism/1382499)). Add a text size in four steps that sets the root font size. Add a reply font of sans or serif, a chat width of normal or wide, and a few preset accent colors. Skip custom CSS in v1. The presets cover what reviewers ask for, and custom styles can break the layout in ways that look like Orbit bugs. Claude.ai users ask for more than three fonts and three themes ([anthropics/claude-code#55635](https://github.com/anthropics/claude-code/issues/55635)). Store the settings in a new table keyed by user ID, which is the personal-settings shape that step 4 uses, so nothing moves later. Read them in the server layout, so the first paint uses the right theme with no flash. `layout.tsx` is a server component and hard-codes `class="dark"` today.
- **Docs.** `docs/design.md` says "Dark only". Update it in the same PR.

### 2. Components that belong in a conversation

Split this into two PRs: widgets and tool cards first, then messages, artifacts, and phone fixes.

- **Widgets.** Render generated UI directly in the reply, with no tool-run frame and no "Succeeded". Use one surface at most, with spacing and dividers inside it instead of nested borders. Format numbers with `Intl.NumberFormat` and tabular figures. Color a metric's change green or red with an arrow. Give tables a raised header row, right-aligned number columns, `ScrollFade`, and a cap of about 12 rows with a "Show all 220 rows" control. Show a widget error as one line with collapsed details.
- **Tool cards.** After success, collapse a card to one line, such as "Searched the web, 8 sources", with the source tiles in a row. Tap the line to expand it. Use plain names for every tool.
- **Artifacts in the thread.** Show a card with the artifact's title, its type, and an **Open** button instead of the 11px link. Inject a base stylesheet into the iframe document that follows the current theme for font, colors, and form controls. Name downloads after the title. Highlight syntax in the **Code** tab.
- **Messages.** Collapse a user message after about 12 lines, with **Show more**. On touch screens, put Copy and Edit under the bubble instead of beside it. Stop auto-scrolling once the start of a streaming reply reaches the top of the screen, and keep a jump-to-latest button that does not cover text. Users ask ChatGPT for this ([OpenAI forum](https://community.openai.com/t/feature-request-smarter-auto-scrolling-for-long-chatgpt-responses/1389613)).
- **Phone fixes.** Truncate palette rows with an ellipsis. Render search highlights as `<mark>` and strip markdown from snippets. Add a wrap toggle to code blocks. Label Settings in the drawer, add Memory to it, and ask before signing out. Show the prompt list from the thread map as a sheet on phones, since the rail only appears at 52rem and wider. Users ask ChatGPT for a prompt outline in long chats ([OpenAI forum](https://community.openai.com/t/feature-request-prompt-first-view-collapse-assistant-responses-for-long-chats/1380760)).
- **Memory page.** Clear the stale "No provider is saved" error once a provider is saved, and show when dreaming last ran.

### 3. Model and effort in the chat, plus Anthropic

G1 in the [gap analysis](gap-analysis.md#g1-model-and-effort-are-global-settings-not-chosen-per-chat) has the picker design: nullable `model` and `reasoning_effort` columns on `chats`, a popover on desktop and a bottom sheet on a phone, and the model saved on each reply. This step adds three things.

- **A provider union.** The provider becomes `openai-compatible` (a base URL and a key) or `anthropic` (a key). Anthropic goes through `@ai-sdk/anthropic`, the native API. Do not use Anthropic's OpenAI-compatible URL. Anthropic calls that layer "not considered a long-term or production-ready solution". Through it, `reasoning_effort` is ignored, thinking text does not come back, prompt caching is off, and file parts return a 400 error ([Anthropic OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk)).
- **One effort list mapped per provider.** Today Orbit has `low`, `medium`, and `high` (`src/lib/settings.ts:8`), and `provider.ts:50-61` drops an unsupported level without saying so. Keep one list, map it in one adapter, gray out levels a model does not take, and mark a reply when the provider ignored the effort. Open WebUI shipped this silent-drop bug ([open-webui#33584](https://github.com/open-webui/open-webui/issues/33584)).
- **A model list you can trim.** Show and hide models, with badges for images, tools, and reasoning, plus the context size. ChatGPT removed its picker at the GPT-5 launch and brought it back after users objected ([TechCrunch](https://techcrunch.com/2025/08/12/chatgpts-model-picker-is-back-and-its-complicated)).

With Anthropic, put cache control on the system prompt. Orbit's fixed system prompt (`chat/route.ts:114-122`) is a good cache prefix, and G4 can then show cache savings on each reply.

### 4. Multi-user foundation and the settings split

See [Decide first whether Orbit serves one person or several](#decide-first-whether-orbit-serves-one-person-or-several). The settings split from G7 happens here, because instance and personal settings separate anyway.

### 5. A Tools page that tests every tool

"Verify plugins" means you can see that each tool works before the model needs it. Today only GitHub has a check (`get_me`), and the sandbox shows a status in Settings.

- List every tool on one page with its status, the time of its last good call, and the exact tools and input schemas the model sees.
- Give each tool a **Test** button that makes a real minimal call. Web search runs a fixed query. The sandbox runs `print(1)`. GitHub calls `get_me`. Memory reads one row.
- Add the per-chat tools sheet from G6.

### 6. Files in a chat and a Files page

Orbit has no uploads today. There is no route, no table, and no attachment adapter in `chat-panel.tsx`.

- Add an `attachments` table with an owner, a chat, a message, a name, a type, a size, and a hash. Store files under the data folder and set size limits.
- Show the files a chat uses in a panel on that chat. A Files page lists every file with search, download, and delete. Deleting a file leaves a "file deleted" marker in the messages that used it.
- Send images and PDFs only to models that accept them, using the badges from step 3. Put text files inline up to a limit. Show how much of a file the model read, such as "read 12 of 40 pages". LibreChat's docs admit that text past its limit is "dropped without warning" ([LibreChat upload as text](https://www.librechat.ai/docs/features/upload_as_text)).
- Leave out retrieval-augmented search at first.
- **Trap.** The proxy matcher in `src/proxy.ts` skips any path that ends in `.png`, `.jpg`, `.svg`, or another image extension. A route such as `/api/files/photo.png` would skip the sign-in check. Each file route must check the session and the owner itself, or file URLs must not end in an extension.

### 7. An Artifacts page

Artifacts live only in message text today, and the registry exists only in browser memory (`use-artifact.ts`). Add an `artifacts` table filled when a reply is saved, with an owner, a chat, a message, a title, a language, and a link to the earlier version. The page lists every artifact with search, rename, a download named after the title, and a way to jump to its chat. Show versions in a list that stays visible. Claude.ai users lost access to saved artifact versions when the menu item disappeared ([anthropics/claude-code#96718](https://github.com/anthropics/claude-code/issues/96718)).

### 8. Share links

- A share is a snapshot of the branch you are viewing, at an unguessable URL. Include artifacts in the same sandboxed iframe.
- Leave out attachments, reasoning, memory notes, and raw tool output. Show each tool call as its name and a one-line summary. Claude.ai also keeps attached files private and hides raw tool-call data in a share ([Claude share help](https://support.claude.com/en/articles/10593882)).
- Send `noindex` and a strict CSP on the share page. ChatGPT's "make this chat discoverable" option let search engines index private chats, and OpenAI removed it ([Engadget](https://www.engadget.com/ai/openai-is-removing-chatgpt-conversations-from-google-194735704.html)).
- Add **Update link** to republish to the same URL, a list of shared links with **Revoke**, and an optional expiry.
- Before publishing, show exactly what will become public. None of the apps compared documents a preview like this.
- The share route must be public. With Cloudflare Access in front of Orbit, it needs an Access bypass rule for the share path. That is a deploy change, so add it to the **Deploy behind Cloudflare** section of `README.md` when this step ships.

### 9. Remote MCP servers with per-tool permissions

One generic connector covers most of the plugins people ask for: calendar, email, documents, and browsers. Writing each one as a built-in does not scale.

- Support remote servers over Streamable HTTP with no auth, a bearer token, or OAuth. Leave out local `stdio` servers, because they run commands on the host. LibreChat has a remote-code advisory for that case, GHSA-cxhj-j78r-p88f.
- Make **Test connection** connect and list every tool with its schema.
- Set each tool to Off, Ask, or Always, and start every new tool on Ask. ChatGPT skips the prompt for a tool the server marks read-only ([OpenAI developer mode](https://developers.openai.com/api/docs/guides/developer-mode.md)). That mark comes from the server, so Orbit should show it as a label and not trust it as a permission. An Ask call shows a card with the tool name and its arguments before it runs.
- Pin the tool list when you approve a server. If the list changes later, ask again. A server cannot then swap a harmless tool for a dangerous one.
- Check server URLs against private network ranges, and never forward Orbit's session cookie. Open WebUI has an advisory for forwarding it, GHSA-p78m-89r6-pgf7. The [MCP security best practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices) cover both.

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
- **iOS behavior.** The input zoom and the keyboard covering the composer are inferred, not seen. Test both on a real iPhone in step 1.
- **A reply style setting.** OpenAI added a setting for how many headers and lists replies use ([OpenAI forum](https://community.openai.com/t/excessive-bullet-point-formatting-issue-in-chatgpt-responses/1097391)). It may be worth a personal setting in step 4. That is a product call.
- **The roadmap.** Adding these steps to `docs/roadmap.md` and writing their `docs/slices/NN.md` plans is the maintainer's call. This page does not change the roadmap.

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
