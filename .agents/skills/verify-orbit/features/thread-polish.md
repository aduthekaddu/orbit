# Thread polish, rename and delete

Slice 16 adds two browse scenarios. `chat-manage` checks draft chats, rename, delete with undo, and the sidebar footer. `thread-polish` checks the reading changes: the message fold, touch actions, streaming position, the Jump to latest strip, artifact cards, code Wrap, palette rows, the phone Prompts sheet, and the Memory page dream status.

## Preconditions

- `node .agents/skills/verify-orbit/verify.mjs launch --mock` and `doctor ok`.
- A build with slice 16. On older code each scenario stops at its first missing control.
- Docker is not needed.

## Run

```sh
export ORBIT_VERIFY_PORT=3230
node .agents/skills/verify-orbit/verify.mjs browse chat-manage
node .agents/skills/verify-orbit/verify.mjs browse thread-polish
```

Each scenario runs its checks three times: at 1440×900 with a mouse, then at 390×844 and 360×740 on a touch screen. Step names start with the width. On a phone the sidebar is the drawer, and the row menu is a bottom sheet.

## chat-manage

At each width:

- **New chat** three times goes to `/c/<id>?new` each time. `GET /api/chats` and the sidebar gain no rows, and the header title is empty.
- On a draft, picking `mock-reasoner` at Medium and sending `[qa:plain] hello` creates one row pinned to that choice, shows it in the sidebar, and drops `?new`.
- A reload during a draft's first `[qa:slow]` reply lands on `/c/<id>` and reattaches until `word50`. The reply text, without its model label, holds `word1` to `word50` once each, in order.
- An offline first send keeps `?new`, creates no row, and reloads as a draft, not a 404. The page does not load again, and the picked model holds through the refresh that follows when the connection returns.
- **Rename** from `Actions for <title>` fills the `Chat title` box, saves with Enter, answers `PATCH` 200 `{ id, title }`, and keeps the title, the sort order, and `updated_at` after reload. Escape and blank input send no request. A `PATCH` 500 rolls back and shows `Could not rename`.
- **Delete** on the open chat opens a draft, hides the chat in the sidebar and palette, and shows `Chat deleted` with **Undo**. Undo reopens the chat, puts it back in the palette, and sends no `DELETE`. The palette check matches the chat's id, so a rerun on the same sandbox, which holds chats with the same titles, still holds.
- **Delete** on an inactive chat shows the toast inside the drawer on a phone, and Undo restores the row.
- **Delete** during `[qa:slow]`, then Undo, reattaches and all 50 words finish.
- **Delete** during `[qa:slow]` with no Undo sends one `DELETE` after 5 seconds. Then `GET /api/chats/<id>` and `/stream` answer 404, the palette finds no hit for the prompt's word, and `messages_fts` passes `integrity-check`.
- **Delete** followed by a reload commits through `pagehide` before the 5 seconds end, and the reloaded sidebar drops the row.
- A chat that a request the page did not send has saved keeps its `/c/<id>?new` history entry. After **Delete** lands, Back opens that id as a draft, and its first message saves the chat again. A second **Delete** in the same page sends one more `DELETE`, and `GET /api/chats/<id>` answers 404.
- A `DELETE` 500 restores the row and shows `Could not delete`. A double click on **Delete** sends one request. `DELETE` on a missing id answers 404.
- The footer shows **Memory** and **Settings** links and the email as plain text. **Sign out** opens `Sign out?`, and **Cancel** keeps the session. Cancel returns focus to Sign out without opening its tooltip, so on a phone one Escape closes the drawer. At 360 the scenario confirms, lands on `/login`, and `GET /api/chats` answers 401, so it runs last.

Screenshots: `menu-desktop.png`, `menu-sheet-390.png`, `rename.png`, `undo-toast-360.png`, `signout-confirm.png`, `drawer-360.png`.

## thread-polish

At each width, in one chat made with `POST /api/chats`:

- A 40-line `[qa:plain]` message folds to 12 lines with **Show more**, a one-line fade ends at the fold, and the 40th line sits below it. The user text is one text node, so the scenario finds a line's box with a `Range`. **Copy** while folded copies the 40 lines exactly, the first one after its `[qa:plain]` tag. **Show more** shows every line, clipped nowhere, and turns into **Show less**.
- On a touch screen, Copy and Edit sit below the bubble at 44px or taller, and the reply's actions are 44px and neither overlap nor clip the reply label. With a mouse they sit beside the bubble.
- During `[qa:slow-long]` the prompt pins near the top and `scrollTop` stops rising. **Jump to latest** then reaches the end. The scenario clicks it once the last paragraph shows in full, because the markdown reveal still types it out after the stream ends.
- Scrolled up, the `[data-scroll-to-bottom]` button sits inside the opaque `[data-jump-strip]`, and `document.elementFromPoint` at its four corners, with the button hidden, hits the strip and never message text.
- `[qa:artifact-form]` shows a `[data-artifact-card]` with `Signup form`, `HTML`, and no raw code. While it streams, **Open** is disabled and the mark spins. **Open Signup form** opens a panel with that title. The frame body uses Orbit's `--background`, a sans font, and `--radius` on its button. Download suggests `signup-form.html`. The Code tab has `span.token` spans and its text equals the saved source. With the `light` theme the frame is light with dark text. The theme is put back afterwards.
- `[qa:wide-code]` scrolls sideways until **Wrap** turns `aria-pressed="true"` and the block fits.
- The palette rows fit the dialog. Hits for `firewall` and `deploy` mark the match in `<mark>` and show no raw `[ ]` or `#` once `[qa:...]` tags are set aside. A chat renamed to a long title truncates with an ellipsis.
- With five prompts, a phone header **Prompts** button opens the `Prompts` sheet. One row has `aria-current="location"`, and tapping the first prompt closes the sheet, scrolls to it, and focuses it.
- At every width exactly one of the rail and a **Prompts** button shows (the rail's own trigger is left out). At 1440 the rail shows. At 1024×768 with the sidebar open the thread is under 52rem and the header is hidden, so the button shows in the Jump to latest strip, opens the sheet, and a pick focuses the prompt. With the sidebar closed, 1024 shows the rail and 800 shows the header button. The scenario opens the sidebar again at 1440.

Then once: the scenario deletes the connections, clears today's dream run, runs `npm run dream` (it fails with `No provider is saved`), connects the mock again, and checks that `/memory` hides that error. A second dream with a local mock Ollama finishes, and `/memory` at each width shows `Last dream <date>, <time>. N chats, N added, N merged` in the browser time zone `Asia/Kolkata`. The scenario deletes the memories that dream added, because they hold `[qa:...]` tags that would steer later mock replies.

Screenshots: `folded-390.png`, `touch-actions-390.png`, `streaming-top.png`, `jump-strip-390.png`, `artifact-card.png`, `artifact-dark.png`, `artifact-light.png`, `code-tab.png`, `wrap-390.png`, `palette-390.png`, `prompts-sheet-390.png`, `prompts-1024.png`, `memory-status.png`, plus `streaming-top-390.png` and `streaming-top-360.png`.

## Gotchas

- `chat-manage` signs the verify account out at the end. The next `browse` signs in again.
- The undo window is 5 seconds. Steps wait for it with `eventually`, so a slow machine waits longer but never passes early.
- `thread-polish` changes the sandbox's connections and dream run. Run it on a sandbox that no other run shares.
