# Orbit against ChatGPT and Claude.ai on a phone

This page compares Orbit with ChatGPT and Claude.ai as of 8 November 2026. It covers what a phone user notices: replies that break, sign-ins that drop, and controls that live in the wrong place. Each gap gives what the benchmarks do, with a source. Then it gives what Orbit does today, with a file reference, a severity, and a suggested fix.

[Issue #11](https://github.com/aduthekaddu/orbit/issues/11) was the first design review. Most of its items have shipped, as the table in the [roadmap](../roadmap.md#issue-11) shows. This page does not repeat them. It covers what issue #11 did not test: real use on a phone through Cloudflare Tunnel and Cloudflare Access.

## How the evidence was gathered

- **Orbit code.** File references point at `main` at `c23c00d`.
- **The running deployment.** These are the logs of the `orbit` and `cloudflared` containers, plus timestamps read from the `session`, `chats`, and `messages` tables. No message text, token, or key was read or copied.
- **A scratch copy.** I ran the same Docker image on a spare port, with an empty data folder and the mock provider. A local HTTPS front added the headers that `cloudflared` adds. Chromium drove it at iPhone 13 size through Playwright. No WebKit build was available, so iOS Safari and Chrome for iOS were not tested directly.
- **The benchmarks.** These come from OpenAI and Anthropic help pages, release notes, and Cloudflare and library docs. The [sources](#sources) list has every page that was read. OpenAI's pages refused direct requests, so they were read through a reader proxy that returned the full page text.

## Severity

| Level | Meaning on a phone |
| --- | --- |
| P0 | You lose work, lose money on tokens, or cannot keep using the app. |
| P1 | Daily friction. A benchmark user would notice in the first session. |
| P2 | Polish. Noticeable, but it does not stop a task. |

## Summary

| # | Gap | Severity | Suggested fix |
| --- | --- | --- | --- |
| B1 | A dropped connection kills the reply and wastes its tokens | P0 | Slice 13, replies that survive a dropped connection |
| B2 | Orbit's sign-in page comes back while the session is still valid | P0 | A diagnostic `fix/` PR first. The cause is not confirmed. |
| G1 | Model and effort are global settings, not chosen per chat | P1 | Slice 14, model and effort per chat |
| G2 | Memory works in the background but the chat never shows it | P1 | Slice 15, memory in the chat |
| G3 | On a phone, Settings, Memory, and tools are hard to find | P1 | Part of slice 15, plus a mobile pass |
| G4 | No token usage or context readout | P1 | Slice 16, usage per reply and per chat |
| G5 | Thinking shows no timer, so a long think looks like a stall | P2 | Part of slice 13 |
| G6 | Tools are switched on server-side, and the chat cannot see or change them | P2 | Slice 17, a tools sheet in the composer |
| G7 | One long settings page mixes credentials with preferences | P2 | Slice 17, split settings |
| G8 | Sessions do not roll forward, and Access adds a second daily sign-in | P2 | Settings change plus a small `fix/` PR |

## B1. A dropped connection kills the reply and wastes its tokens

**Severity.** P0. This is the bug you hit.

### What happened

The deployment logs line up to the second.

| Time (UTC) | Source | Event |
| --- | --- | --- |
| 17:13:51 | `messages` table | You send a prompt in a new chat. The model is `deepseek-v4.1-flash` with effort `high`. |
| 17:15:41.8 | `cloudflared` log | `stream 53 canceled by remote with error code 0`, `dest=https://<public host>/api/chat` |
| 17:15:41.8 | `orbit` log | `chat end without text finished unknown step-start,reasoning` |

The reply ran for about 110 seconds. All of it was thinking. When the connection closed, Orbit stopped the model and saved nothing. The prompt has no reply in the database.

### Root cause

1. The chat route passes the browser request's abort signal to the model call. See `abortSignal: request.signal` in `src/app/api/chat/route.ts:135`. When the phone's connection drops, Orbit cancels the provider request. The provider has already billed the tokens it produced.
2. Orbit keeps a cut-off reply only if it has visible content. `shouldSaveReply` returns `visible` (`src/lib/messages.ts:101`). `assistantHasVisiblePart` counts text and tool parts, not reasoning (`src/lib/genui/spec.ts:65`). A cut during thinking throws the whole reply away.
3. The client has no way back. `useChatRuntime` in `src/components/chat/chat-panel.tsx:57` has no resume option. The error shows the raw message and a Retry button (`src/components/chat/messages.tsx:90`). Retry runs the whole turn again from the start, so you pay for the thinking twice.

"Canceled by remote" means the Cloudflare edge closed the stream, and error code 0 is a normal close ([quic-go `errors.go`](https://raw.githubusercontent.com/quic-go/quic-go/master/errors.go), [cloudflared issue #1726](https://github.com/cloudflare/cloudflared/issues/1726)). The edge closing a stream because the browser went away is an inference. No Cloudflare page confirms it.

Cloudflare's timeout is probably not the cause. Cloudflare now documents the Proxy Read Timeout as 125 seconds, measured between two reads from the origin ([connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/), [cache rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)). The stream sent thinking text for 110 seconds, and an edge timeout shows as a 524 error, which nothing here logged.

The likely trigger is the phone itself (a guess). On iOS, an app that goes to the background is suspended and loses its network connections ([Apple developer forums](https://developer.apple.com/forums/thread/716118)). Chrome for iOS uses WebKit, so it behaves like Safari ([App Store guideline 2.5.6](https://developer.apple.com/app-store/review/guidelines/)). Your phone's IP address also changed between the 17:02 and 17:15 sign-ins, which fits a network switch. That is a correlation, not a cause.

### Reproduced on the scratch copy

I sent `[qa:slow]`, a mock reply of 50 words over 10 seconds, and dropped the connection after 8 words.

```text
17:35:56.505 words on screen before the cut 8
17:35:56.505 connection dropped mid-stream
17:36:00.591 words 4 s after the cut 8 | retry shown: true | stop shown: 0
17:36:00.591 error line: "network error"
17:36:10.602 words 14 s after the cut, no reload 8
17:36:12.692 words after reload, from the server copy 8
```

The server saved 8 words, not 50, so generation stopped at the cut. The phone showed `network error` and Retry, and it never reconnected. In your real case the cut came before any text, so the server saved nothing.

### What the benchmarks do

- **ChatGPT.** Since 7 August 2026, a finished answer appears in full when you come back to a chat, without replaying. Since 21 August 2026, iOS says when it is waiting for an internet connection ([ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)). ChatGPT is not perfect here. A forum request from 30 September 2026 says a long typed answer can stop when the iPhone app goes to the background ([OpenAI community](https://community.openai.com/t/automatically-hand-off-long-running-chat-turns-to-work-when-the-app-is-backgrounded/1402176)).
- **Claude.ai.** Anthropic says larger tasks keep running in the cloud after you leave the page ([Claude and Cowork are one Claude](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)). For a normal reply, only an outside guide quotes the screen text "Claude is still creating a response in the background" ([claude-for.com](https://claude-for.com/guides/claude-is-responding-in-the-background)). Treat that as reported, not confirmed.

### Suggested fix: slice 13, replies that survive a dropped connection

The goal is that a reply finishes and is saved even if the phone drops, and the phone picks it back up when it returns.

1. **Finish on the server.** Stop passing `request.signal` to `streamText`. Keep the reply running with `consumeStream()`, which the installed `ai` 7.0.159 has (`node_modules/ai/dist/index.d.ts:2962`), so `onEnd` saves the full reply. The AI SDK warns that passing the request's abort signal cancels the work on a disconnect ([AI SDK troubleshooting](https://ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams)). The tools get the same signal through `toolsForTurn` (`route.ts:99`), so the sandbox and GitHub calls stop on a disconnect too. Move them to the same server-side controller. The route reads `result.stream` once, so check in turn 1 how to keep a second consumer.
2. **Make Stop explicit.** Once a disconnect no longer stops the model, Stop needs its own route, for example `POST /api/chat/[id]/stop`. It aborts a per-chat `AbortController` held by the server ([AI SDK resume docs](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)).
3. **Reconnect.** Add a `GET` stream route and turn on resume in the client. assistant-ui already ships this. `@assistant-ui/ai-sdk` 0.0.16 has a `resumable` transport option and `createResumableSessionStorage` ([assistant-ui guide](https://www.assistant-ui.com/docs/guides/resumable-streams)). Orbit is one process with one user, so an in-memory store is enough and Redis is not needed. `@ai-sdk/react` 4.0.163 also reconnects when the page becomes visible again, which is the phone-unlock case.
4. **Never drop what you paid for.** Save a reply that holds only reasoning, and mark it as interrupted. Show "Interrupted" with a Continue action in place of the raw `network error`.
5. **Guard silent thinking.** Set `keepAliveMs` on `createUIMessageStreamResponse` (`node_modules/ai/dist/index.d.ts:2630`). This covers a model that thinks without streaming for more than Cloudflare's 125 seconds.

`maxDuration = 120` in `route.ts:20` does nothing under `next start` ([Next.js docs](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/maxDuration)). Delete it in the same slice, so nobody reads it as a limit.

The proof for this slice reruns the drop test above. The server copy must hold all 50 words, and the phone must show them without a reload.

## B2. Orbit's sign-in page comes back while the session is still valid

**Severity.** P0. You have to sign in again in the middle of a chat.

**Status.** The cause is not confirmed. The idea in the brief was a SameSite or Secure cookie mismatch behind Access. I tested it, and the evidence does not support it.

### What the deployment shows

Your phone signed in three times today, every time from Chrome for iOS with the same user agent.

| Session created (UTC) | Expires | Still in the database |
| --- | --- | --- |
| 17:02:24 | 7 days later | yes |
| 17:15:12 | 7 days later | yes |
| 17:15:52 | 7 days later | yes |

- **The server did not expire anything.** Every session is valid for 7 days.
- **Nobody pressed Sign out.** better-auth deletes the session row on sign-out, and all three rows are still there.
- **The first session lasted at least 8 minutes.** It created chats at 17:02 and 17:04 and sent a message at 17:10:43. The second session was replaced 40 seconds after it started.
- **Both re-sign-ins fall inside the 110 seconds of the reply in B1.** That is a correlation only.

So the browser stopped sending the cookie, or sent one the server did not accept. The server never logged you out itself.

### What I ruled out

| Hypothesis | Test | Result |
| --- | --- | --- |
| The cookie is set for the wrong scheme | Read `Set-Cookie` on sign-in on the scratch copy with the same environment shape. `BETTER_AUTH_URL` was `http://127.0.0.1:3210` and `ORBIT_PUBLIC_URL` was an https URL. | `__Secure-better-auth.session_token`, `Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`. That is correct for an https site. `resolveAuthBaseUrl` picks the public URL (`src/lib/auth-origins.ts:9`). |
| The server rejects requests that come through the tunnel | Sent the session cookie with `Host`, `X-Forwarded-Proto: https`, and `X-Forwarded-For` set the way `cloudflared` sets them | `/`, `/settings`, `/memory`, `/api/chats`, and `/api/auth/get-session` all pass. `/login` redirects to `/`. |
| A server error looks like a logout | Read `getSession` in better-auth 1.7.14 | A database error throws a 500. It does not return "no session" (`node_modules/better-auth/dist/api/routes/session.mjs`). |
| The signing secret changed | Checked how the live container gets its secret, without printing it | It comes from `data/auth-secret`. The file was last written at 16:41:48, before all three sign-ins. |
| A phone browser drops the cookie | Chromium at iPhone 13 size: sign in, idle 12 s, reload, 5 s offline, reload, new tab | Signed in at every step. The cookie stays `Secure`, `HttpOnly`, `Lax`, 7 days. |
| A back swipe shows a cached sign-in page | Chromium: sign in, wait 5 s, go back | Next asks the server for `/login`, the server redirects back to the chat, and the chat stays open. |

### What is left

These are guesses, because I could not test them here.

- **WebKit behavior on iOS.** Something in WebKit, such as a tab discarded and restored after an app switch, could lose or withhold the cookie. Chromium does not show it, and no WebKit build was available.
- **Cloudflare Access and the edge during a network switch.** Reproducing this needs your Access login.
- **Chrome Incognito on iOS.** Incognito cookies go away when iOS ends the Chrome process in the background.

### Suggested next step

First add the cheap log line that would have answered this at first look. Then reproduce once on the phone.

1. In `src/proxy.ts:24`, log one line for every redirect to `/login`. Include the path, whether a `__Secure-better-auth.session_token` cookie was present, whether `CF_Authorization` was present, whether the request was a Next.js RSC or prefetch request, and the browser family. Log no cookie values.
2. Reproduce on the phone. Sign in, send a long prompt, switch apps for 30 seconds, and come back.
3. If the cookie was present, the server rejected it, so look at session lookup. If the cookie was missing, the browser or the edge dropped it, so look at WebKit and Access.

This is a `fix/auth-logout-signal` PR, not a slice. It ships the log line and the test that checks it.

## G1. Model and effort are global settings, not chosen per chat

**Severity.** P1.

**ChatGPT.** On the web the model picker sits in the composer. On iOS and Android it sits at the top of the conversation (release notes, 10 June 2026). A Thinking slider sets effort (Instant, Medium, High, Extra High, Pro), and it lives inside the picker. The retry menu can run an answer again with a different model ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes), [GPT-6 in ChatGPT](https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt)).

**Claude.ai.** The model menu sits next to the send button and holds the effort and thinking controls. "You can change the model, effort level, or thinking setting at any point in a conversation." The change applies from the next reply ([change the model, effort, and thinking](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings)). When Claude switches models on its own, the reply is labeled with the model that wrote it ([why Claude switched models](https://support.claude.com/en/articles/16049681-why-claude-switched-models-in-your-conversation-with-opus-5-or-opus-5-5)).

**Orbit today.**

- The model and effort live on the single `settings` row (`src/lib/db/schema.ts:82`). The `chats` table has no model column (`schema.ts:95`).
- The chat route reads `settings.model` and `settings.reasoningEffort` for every chat (`src/app/api/chat/route.ts:123` to `136`).
- The model chip in the composer is a link to `/settings` (`src/components/chat/composer.tsx:29`). On a phone, changing effort means leaving the chat.
- Effort has three levels, `low`, `medium`, and `high` (`src/lib/settings.ts:8`).
- No reply records which model wrote it.

**Suggested fix: slice 14, model and effort per chat.** Add nullable `model` and `reasoning_effort` columns to `chats`. A null value falls back to the settings default, so old chats keep working. The composer chip opens a picker. It is a popover on desktop and a bottom sheet on a phone. It lists `/api/models`, with an effort row that shows only for models that support reasoning. Save the model id on each assistant message, and show it in the action bar when it differs from the chat's current model. Settings then holds only the default for new chats.

## G2. Memory works in the background but the chat never shows it

**Severity.** P1.

**ChatGPT.** A **Sources** button under an answer shows the saved memories, past chats, and custom instructions that the answer used. You can correct or delete a memory from there (release note, 5 May 2026). You manage memories in Settings, under Personalization and then Memory. A temporary chat never creates memories ([memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt), [temporary chat FAQ](https://help.openai.com/en/articles/8914046-temporary-chat-faq)).

**Claude.ai.** Searching past chats shows in the chat as a tool call, with citations that link to the old chats. You can turn memory off for one chat before its first message, and the chat then shows a crossed-out memory icon. Incognito chats never reach memory. You view and edit memory in Settings, under Your Claude and then Manage ([chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context), [incognito chats](https://support.claude.com/en/articles/12260368-use-incognito-chats)).

**Orbit today.**

- Every turn, `recall` finds up to three memories and adds them to the last user message out of sight (`src/app/api/chat/route.ts:112`, `src/lib/memory/recall.ts:28`). Nothing in the reply says that a memory was used, or which one.
- Saving a memory shows a card, because `remember` is a tool. Dreaming writes memories at night. Its status shows only on the Memory page (`src/components/memory/memory-list.tsx:138`).
- The Memory page is reachable only from the command palette (`src/components/shell/command-palette.tsx:116`). On a phone that means opening the drawer, tapping Search, and typing "Memory".
- No chat can opt out of memory.

**Suggested fix: slice 15, memory in the chat.** Stream the recalled memories as a data part on the reply. Render it as a small "2 memories" chip under the answer. Tapping it opens a sheet that lists them, with Edit and Forget. Add a per-chat "no memory" switch before the first message, as Claude does. Put Memory in the drawer (see G3).

## G3. On a phone, Settings, Memory, and tools are hard to find

**Severity.** P1.

**ChatGPT.** On iOS the model picker sits at the top of the conversation. Holding **+** opens recent photos, and the tools open in one sheet from the bottom ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)).

**Claude.ai.** The mobile composer has a dictation microphone and a **+** button for actions such as research ([dictation on Claude mobile](https://support.claude.com/en/articles/10065434-use-dictation-on-claude-mobile)).

**Orbit today.** The screenshots come from the scratch copy at iPhone 13 size.

- **The drawer.** The drawer footer's Settings link is the email row. Its only "Settings" label is for screen readers (`src/components/chat/sidebar.tsx:128` to `141`). Memory is missing. Sign out is an icon one tap away, with no confirmation (`sidebar.tsx:143`).
- **The header.** The phone header has only Open sidebar and New chat (`src/components/shell/app-shell.tsx:149`).
- **The composer.** The composer has a text box, the model chip, and Send or Stop. It has no attachments, tools, or dictation (`src/components/chat/composer.tsx`).

**Suggested fix.** Give the drawer footer two labeled rows, **Settings** and **Memory**. A visible label on a navigation row is a primary label, not helper text. Move Sign out into Settings. With slice 14, put the model picker in the phone header, as ChatGPT does. Attachments and dictation are larger features, so add them to the roadmap's Later list instead of this pass.

## G4. No token usage or context readout

**Severity.** P1 for Orbit, though not for the benchmarks.

**ChatGPT.** No source shows a token or context meter in the consumer app. ChatGPT shows when a usage allowance resets ([GPT-6 in ChatGPT](https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt)). Users quote "This conversation is too long; please start a new one." when a chat hits the limit ([OpenAI community](https://community.openai.com/t/cant-read-past-chat-anymore-this-conversation-is-too-long-please-start-a-new-one/1381626)). A paste over 10,000 characters becomes an attachment, so it does not fill the context window (release notes, 4 August 2026).

**Claude.ai.** No source shows a context meter in chat. Since 24 November 2025, Claude summarizes older messages when a chat nears its limit, if code execution is on. Settings, under Usage, shows the session and weekly limits and when they reset ([usage and length limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work), [release notes](https://support.claude.com/en/articles/12138966-release-notes)).

**Orbit today.** Orbit records no usage. Nothing in `src` reads `totalUsage` or sends message metadata. When a chat outgrows the model's context, you see the provider's raw error.

**Why it matters more for Orbit.** The benchmarks sell a subscription. Orbit uses your own API key, so every token is your money. The deepseek reply in B1 spent 110 seconds of high-effort thinking, and Orbit cannot tell you what that cost.

**Suggested fix: slice 16, usage per reply and per chat.** On finish, save input, output, and reasoning token counts on the assistant message. Show the count in the reply's action bar. Show a small ring in the composer for the last turn's input tokens against the model's context window, when `/api/models` reports one. Near the limit, offer a new chat that starts with a summary. Keep the ring free of text, per the copy rule in `docs/design.md`.

## G5. Thinking shows no timer, so a long think looks like a stall

**Severity.** P2.

**Claude.ai.** A "Thinking" label with a timer shows while Claude thinks. Afterwards an expandable Thinking section shows a summary ([change the model, effort, and thinking](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings)).

**ChatGPT.** GPT-5.4 Thinking shows a plan of its thinking up front ([introducing GPT-5.4](https://openai.com/index/introducing-gpt-5-4/)). GPT-6 can start answering while it still thinks ([GPT-6 for everyone](https://openai.com/index/gpt-6-for-everyone/)).

**Orbit today.** A collapsed chip reads "Thinking", then "Thought", with no time (`src/components/chat/reasoning.tsx:9`). For 110 seconds on a phone, the only sign of life is a pulsing bulb. That probably pushes people to switch apps, which then triggers B1 (a guess).

**Suggested fix.** Show the elapsed seconds while thinking runs, and "Thought for 1m 50s" afterwards. Store the duration in the reasoning part so a reload shows it too. This is small enough to ship inside slice 13.

## G6. Tools are switched on server-side, and the chat cannot see or change them

**Severity.** P2.

**ChatGPT and Claude.ai.** Both put tools behind a **+** or tools menu in the composer. Claude shows a chat search as a visible tool step, and keeps connectors on a separate Customize page ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes), [personalization features](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features)).

**Orbit today.** `toolsFor(settings)` turns on search, the code sandbox, GitHub, and memory from settings and environment variables (`src/lib/tools/index.ts:35`). The chat does not show which tools are on, and you cannot turn one off for a single chat.

**Suggested fix: part of slice 17.** Add a **+** sheet in the composer. It lists the enabled tools with a per-chat switch, stored next to the chat's model from slice 14.

## G7. One long settings page mixes credentials with preferences

**Severity.** P2.

**ChatGPT.** The settings sections include General, Personalization (which holds Memory), Apps, Data controls, Security, and Account ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)).

**Claude.ai.** Settings has Your Claude (instructions and memory), Capabilities, and Usage. Connectors live on a separate Customize page ([personalization features](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features), [create and edit files](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)).

**Orbit today.** One page holds four sections: Provider, Search, GitHub, and Code sandbox (`src/components/settings/settings-form.tsx:170`, `273`, `291`, `313`). The model and effort sit inside Provider, next to the API key (`settings-form.tsx:248`). Memory and the account have no section.

**Suggested fix: part of slice 17.** Split the page into these sections:

- **Connection.** The base URL and the key.
- **Defaults.** The model and effort for new chats.
- **Memory.** On or off, the dream hour, and a link to the list.
- **Tools.** Search, GitHub, and the sandbox.
- **Account.** Sign out.

On a phone, each section opens as its own screen.

## G8. Sessions do not roll forward, and Access adds a second daily sign-in

**Severity.** P2. Parts of this are inferred.

**ChatGPT and Claude.ai.** No vendor page that I read says how long a mobile web session lasts. I have no source for the benchmark here.

**Orbit today.**

- **Sessions do not roll forward.** better-auth extends a session once a day when it is used. `src/proxy.ts:17` calls `auth.api.getSession` directly, so any refreshed cookie is never sent to the browser. The browser cookie probably ends 7 days after sign-in, even if you use Orbit every day. This is inferred from the code and was not tested.
- **Access has its own session.** Cloudflare Access sessions last 24 hours by default. When one ends, a `fetch` from the open page can fail. Cloudflare recommends sending `X-Requested-With: XMLHttpRequest`, so Access answers with a 401 that the app can turn into a reload ([Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/), [Access and CORS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/)). Orbit does not send it, so an expired Access session shows up as `network error` in the chat.

**Suggested fix.**

- **Access session length.** In the Cloudflare dashboard, set the Access application's session to match how long you want to stay signed in. This is a settings change, not code.
- **A small `fix/` PR.** Send `X-Requested-With` on Orbit's fetches. Reload on a 401 from Access. Let session refresh reach the browser, through `/api/auth/get-session` or by forwarding the cookie in the proxy.

## Suggested order

The order now lives in [What Orbit v1 should fix and build next](v1-plan.md#the-plan-in-order). That page puts these gaps into one list with the component, multi-user, file, artifact, sharing, and plugin work requested on 14 November 2026. The slice numbers 13 to 17 on this page are placeholders until the roadmap assigns real ones.

## Sources

Vendor pages. The OpenAI pages were read through a reader proxy, because direct requests returned HTTP 403.

- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [GPT-6 and other models in ChatGPT](https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt)
- [Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)
- [Temporary chat FAQ](https://help.openai.com/en/articles/8914046-temporary-chat-faq)
- [Troubleshooting ChatGPT error messages](https://help.openai.com/en/articles/7996703-troubleshooting-chatgpt-error-messages)
- [GPT-6 for everyone](https://openai.com/index/gpt-6-for-everyone/)
- [Introducing GPT-5.4](https://openai.com/index/introducing-gpt-5-4/)
- [Memory and new controls for ChatGPT](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- [OpenAI community: "This conversation is too long"](https://community.openai.com/t/cant-read-past-chat-anymore-this-conversation-is-too-long-please-start-a-new-one/1381626)
- [OpenAI community: long turns stop when the app is backgrounded](https://community.openai.com/t/automatically-hand-off-long-running-chat-turns-to-work-when-the-app-is-backgrounded/1402176)
- [Change the model, effort, and thinking settings](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings)
- [Why Claude switched models in your conversation](https://support.claude.com/en/articles/16049681-why-claude-switched-models-in-your-conversation-with-opus-5-or-opus-5-5)
- [How usage and length limits work](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)
- [Troubleshoot Claude error messages](https://support.claude.com/en/articles/12466728-troubleshoot-claude-error-messages)
- [Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- [Use incognito chats](https://support.claude.com/en/articles/12260368-use-incognito-chats)
- [What are artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)
- [Claude release notes](https://support.claude.com/en/articles/12138966-release-notes)
- [Claude, Cowork, and chat are one Claude](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)
- [Understanding Claude's personalization features](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features)
- [Create and edit files with Claude](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)
- [Use dictation on Claude mobile](https://support.claude.com/en/articles/10065434-use-dictation-on-claude-mobile)
- [claude-for.com: Claude is responding in the background](https://claude-for.com/guides/claude-is-responding-in-the-background). This is an outside site, not Anthropic.

Infrastructure and libraries:

- [Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)
- [Cloudflare error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)
- [Cloudflare cache rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)
- [cloudflared issue #1726](https://github.com/cloudflare/cloudflared/issues/1726)
- [quic-go `errors.go`](https://raw.githubusercontent.com/quic-go/quic-go/master/errors.go)
- [Cloudflare Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [Cloudflare Access authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
- [Cloudflare Access and CORS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/)
- [AI SDK: resume streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)
- [AI SDK: message persistence](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence)
- [AI SDK: abort breaks resumable streams](https://ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams)
- [`resumable-stream` README](https://raw.githubusercontent.com/vercel/resumable-stream/main/README.md)
- [assistant-ui: resumable streams](https://www.assistant-ui.com/docs/guides/resumable-streams)
- [Apple developer forums: networking in a suspended app](https://developer.apple.com/forums/thread/716118)
- [App Store review guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Next.js `maxDuration`](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/maxDuration)

Installed packages that were read: `ai` 7.0.159, `@ai-sdk/react` 4.0.163, `@assistant-ui/ai-sdk` 0.0.16, `@assistant-ui/react-ai-sdk` 1.4.21, `better-auth` 1.7.14, and `next` 16.4.3.
