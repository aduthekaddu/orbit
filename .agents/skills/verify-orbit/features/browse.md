# Browse

Browse drives Chrome through Playwright. Use it to prove a click, a layout, or a screenshot. An HTTP drive cannot prove those.

## How it runs

- **Command.** `node .agents/skills/verify-orbit/verify.mjs browse <scenario>`. The scenario file is `scenarios/<scenario>.mjs`.
- **Browser.** `/usr/bin/google-chrome` when that file exists, and Playwright's own Chromium otherwise. Without Chrome, run `npx playwright install chromium` once first.
- **Account.** The command signs up `verify@orbit.local` on an empty sandbox, or signs in that account. Then it puts the session cookie in the browser.
- **Output.** Each check prints `PASS <name>` or `FAIL <name>: <detail>`. Screenshots go to `.verify/evidence/<scenario>/<name>.png`, and the step lines go to `summary.txt` in the same folder. Each run deletes that scenario's old evidence first.
- **Exit code.** 1 when any step fails or the scenario throws. A throw prints `FAIL scenario finished` and saves `error.png`.

A scenario exports one default function that receives `{ page, origin, mockUrl, useProvider, seedMember, signInMember, step, shot }`. `mockUrl` is the base URL of the mock provider that `launch --mock` started. Reading it with no mock running fails the scenario with the command to run. `useProvider()` connects the mock and makes `mock-genui` at `low` the default model, reusing the connection `launch --mock` added. Pass `{ model, effort }` to change the default, or `{ baseUrl, apiKey, model }` to connect a real provider. It throws when a request fails or a response holds the key. `seedMember()` creates a synthetic member in the sandbox. `signInMember()` returns a separate browser context signed in as that member. `step(name, ok, detail)` records a check. `shot(name, target)` saves a screenshot of `target`, which is `page` by default. Find elements by the label a user sees, such as `Ask anything`, `Retry`, or `Save`, not by CSS classes.

## Preconditions

- Run `node .agents/skills/verify-orbit/verify.mjs launch --mock`. It starts the sandbox server, starts `scripts/qa/mock-provider.mjs` on a free port that the OS picks (saved in `.verify/mock.json`), and adds a connection to it: base URL `http://127.0.0.1:<mock port>/v1`, key `test-key-not-real`, and default model `mock-genui` at `low`.
- `doctor` prints `doctor ok`. `browse` runs the same check first and stops if it fails.
- `launch --mock` creates `verify@orbit.local`, so `drive signup` and `drive chat` cannot run on that sandbox. Use a fresh launch for them.
- `cleanup` stops the mock provider and the server.

## Scenarios

### durable-reply

Drops a live connection during text and thinking. Checks reconnect, explicit Stop, switching chats, a second tab, and an older branch. See [Check durable replies](durable-replies.md).

### retry-stop

Sends `[qa:fail-first] hello <time>`. The mock returns HTTP 500 three times, so the first send shows **Retry**. Clicks **Retry**, waits for `word3`, clicks **Stop**, and reloads.

Pass lines:

```
PASS first send shows Retry
PASS Stop ends the stream early
PASS reply text visible at stop
PASS reply text survives reload
PASS one reply after reload
```

The reload check is a substring match. The server can save a few words that streamed after the last frame the browser drew, so an exact match would fail for a harmless reason.

Screenshots: `before-stop.png`, `after-reload.png`.

### palette

Presses Ctrl+K in a chat, types `Settings`, and presses Enter. Then it opens the palette again and presses Escape. Then it sends `[qa:plain] quokkanest` and searches messages with `/api/search` aborted, answering HTTP 500, and held for 3 seconds.

Pass lines:

```
PASS Ctrl+K opens the palette
PASS Enter on Settings opens /settings
PASS palette closes after select
PASS Esc closes the palette
PASS focus returns to the composer
PASS the chat has a message to search
PASS a failed search does not say No results
PASS a search after a failed one shows the hit and no error
PASS a server error says Could not search
PASS a pending search does not say No results
PASS a canceled search does not say Could not search
PASS a finished search with no match says No results
```

Screenshots: `after-select.png`, `after-escape.png`, `search-failed.png`, `search-recovered.png`, `search-pending.png`.

### settings-short

Sets the viewport to 390×568, opens `/settings`, scrolls **Save** into view, and clicks it.

Pass lines:

```
PASS Save scrolls into the 390x568 viewport
PASS nothing covers Save
PASS clicking Save shows Saved
```

Screenshot: `save-visible.png`.

### request-failures

Fails each browser request with `page.route`: a connection's model list in Settings, `GET /api/connections/<id>/models` (not JSON, a JSON 400, an HTML 400, network, then real), a second Settings Save while one is held, settings Save and the GitHub check on the network, a GitHub check 400, and a reply edit on the network.

Pass lines:

```
PASS a model list that is not JSON shows Failed, not 0 models
PASS a model list 400 from a bad request shows Failed, not Not checked
PASS a model list 400 from a proxy shows Failed, not Not checked
PASS a model list that fails on the network shows Failed
PASS a model list that loads shows its count
PASS a second Settings Save while one is pending does not start another request
PASS a settings save that fails on the network shows Could not save
PASS a GitHub check that fails on the network says GitHub is unavailable.
PASS a GitHub check that gets a 400 shows the server's error
PASS the chat has a reply to edit
PASS Save is disabled while the reply is blank
PASS a reply edit that fails on the network shows Could not save and keeps the editor
PASS no failed request raised a page error
```

New chat opens a draft and sends no request, so it has no failure here. [Thread polish](thread-polish.md) checks drafts.

Screenshots: `models-unreadable.png`, `settings-save-held.png`, `settings-save-offline.png`, `github-check-400.png`, `reply-edit-offline.png`.

### empty-chat

Opens a new chat. Checks the sidebar and palette labels, the placeholder, and the four starters. Clicks **Make a table**. Then it opens the same chat on a 390×844 touch screen and checks the header label.

Pass lines:

```
PASS sidebar shows Untitled for the new chat
PASS sidebar has no chat named New chat
PASS palette lists the new chat as Untitled
PASS composer placeholder is Ask anything
PASS four starters show
PASS Make a table fills the composer
PASS composer has focus with the caret at the end
PASS starter does not send
PASS phone header shows Untitled
PASS starters are at least 44px tall on a phone
```

Screenshots: `starters.png`, `filled.png`, `phone-390x844.png`.

### sign-out

Opens the older of two new chats, because a signed-in visit to `/login` redirects to the newest chat. Presses **Sign out** and checks that it asks `Sign out?` and that **Cancel** keeps the session. Then it confirms three times: with the browser dropping the sign-out request, with the request answered by HTTP 500, and with no route. The failure line shows inside the dialog.

Pass lines:

```
PASS Sign out asks Sign out? and Cancel keeps the session
PASS network error keeps the chat open
PASS network error shows Could not sign out in the dialog
PASS network error raises no page error
PASS HTTP 500 keeps the chat open
PASS HTTP 500 shows Could not sign out in the dialog
PASS Sign out opens /login
PASS session ends after Sign out
```

Screenshots: `confirm.png`, `network-error.png`, `http-error.png`, `signed-out.png`.

### auth-submit

Clears cookies, opens `/login`, fails one sign-in to check that editing clears the error, then stalls navigation to `/` and checks that **Sign in** stays disabled right after success even if a field is edited while navigation is pending, and re-enables when navigation stalls past the reset timeout. Then clears the intercepts and signs in to open a chat.

Pass lines:

```
PASS editing a field clears a sign-in error
PASS Sign in stays disabled after success while navigation is pending
PASS editing a field while navigation is pending keeps Sign in disabled
PASS Sign in re-enables when navigation stalls
PASS real sign-in opens a chat
```

Screenshots: `stalled-disabled.png`, `stalled-recovered.png`, `signed-in.png`.

### thread-map

Sends three `[qa:plain]` prompts. Types two lines in the composer and presses `Alt+ArrowUp`. Then moves focus off the composer without scrolling and reads the current prompt from the map. Presses `Alt+ArrowUp` again and checks that focus moves to the prompt before it.

Pass lines:

```
PASS Alt+Up in the composer keeps focus in the composer
PASS Alt+Up on the page moves focus to the previous prompt
```

Screenshots: `composer.png`, `page.png`.

### thread-first-paint

Sends one `[qa:plain]` prompt, then opens that chat and a new empty chat with the `/_next/static/chunks/**` scripts held, so the page shows its server HTML. It records each DOM change, releases the scripts, and waits for hydration. It runs at 1280×800 and again on a 390×844 touch screen with the labels prefixed `phone`. Composer positions are read after finite animations end.

Pass lines, per label `empty chat` and `saved chat`:

```
PASS empty chat: no Jump to latest button before hydration
PASS empty chat: the composer does not move at hydration
PASS empty chat: the starters show before hydration
PASS empty chat: the empty layout stays at every point
PASS saved chat: no Jump to latest button before hydration
PASS saved chat: the composer does not move at hydration
PASS saved chat: no empty-chat layout at any point
PASS saved chat: no Jump to latest button over an empty thread
```

Screenshots: `<label>-held.png` and `<label>-hydrated.png`, with spaces as dashes.

### long-message

Posts 80,000 letters to `/api/chat`, then sends a 60,000 character message from the composer, then a short one.

Pass lines:

```
PASS 80,000 letters get 413 from the route
PASS composer shows the refusal as plain text
PASS a refused message is not saved
PASS a short message still gets a reply
```

Screenshot: `too-long.png`.

### chat-manage and thread-polish

Slice 16's scenarios. `chat-manage` checks draft chats, rename, delete with a five-second undo, and the sidebar footer with the Sign out confirmation. `thread-polish` checks the message fold, touch actions, top-anchored streaming, the Jump to latest strip, artifact cards, code Wrap, palette rows, the phone Prompts sheet, and the Memory page dream status. Both run at 1440×900, 390×844, and 360×740. See [Thread polish](thread-polish.md).

## Gotchas

- The mock counts `fail-first` failures for each prompt text. `retry-stop` adds the time to the prompt, so a second run fails three times again.
- The SDK waits 2 seconds, then 4 seconds, between retries. The **Retry** button shows about 6 seconds after the send.
- Ctrl+K is the palette shortcut on Linux. On a Mac it is ⌘K.

`browse search-tool` checks the web search settings and cards. See [Web search](./web-search.md).
