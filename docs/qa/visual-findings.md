# Visual findings, 2026-11-01

For a later design pass. Functional bugs and their fixes are in `docs/qa/2026-11-01-ui-qa.md`. No visual change was made on this branch. Screenshot paths are under `docs/qa/screenshots/`.

## V1. Code blocks clip long lines without a scroll cue

`desktop-chat-long.png`, `mobile-chat-long-code.png`

A long line stops at the border with no fade, no scrollbar, and no wrap toggle. On mobile most of the line is off screen. The block scrolls, but nothing says so.

## V2. Command palette clips the last visible row

`desktop-command-palette.png`, `mobile-command-palette.png`

The list ends mid-row at its max height. The clipped row reads as a layout break rather than a scroll. A gradient or a visible scrollbar would make the cut intentional.

## V3. Disabled composer still looks active

`desktop-empty-no-provider.png`

Before a provider is configured the send circle still has the primary fill and the field looks editable. Only the cursor changes. The empty state offers "Open settings", but the composer competes with it for attention.

## V4. Action icons are very low contrast

`desktop-chat-reply.png`, `desktop-chat-long.png`, `desktop-chat-error.png`

Copy and regenerate sit at muted color on the page background and are hard to find, especially after a reply with a lot of text. On an error message the regenerate control is the useful action and reads as disabled.

## V5. Reasoning disclosure is quiet to the point of missing

`desktop-chat-reply.png`, `desktop-chat-streaming.png`

"Thought" with a small caret is the only indication that reasoning exists. It sits at the same weight as body metadata and is easy to skip.

## V6. Mobile chat has no title or model context

`mobile-chat-reply.png`, `mobile-chat-long-code.png`

The 44px header holds only the sidebar button and the orbit mark. On a long thread there is no visible chat title and no model. The only model chip is inside the composer.

## V7. Mobile code block cuts columns and prose mid-token

`mobile-chat-long-code.png`

The table stays inside the card, but "Column two" and "Column three" wrap to two lines while the body cells stay one line. In the code block the cut happens in the middle of an identifier, which reads as clipping rather than scrolling.

## V8. Chat titles keep markdown and line breaks

`desktop-sidebar-history.png`

A title is the first 80 characters of the first user message. Newlines collapse in the sidebar, but markdown markers, code fences, and leading list markers would show raw. Long titles truncate with an ellipsis, which works.

## V9. Empty state figure scale

`desktop-empty-chat.png`, `desktop-empty-no-provider.png`

The dish and plug figures are 240px wide in a 1440x900 canvas. They read as small and float in the middle. This may be intentional, but the relationship between the figure, the caption, and the composer is loose.

## V10. Error banner weight

`desktop-chat-error.png`

The error banner spans the full column and uses the destructive tint at full width for a two-word message. The orbit mark and the action row below stay, so the failure looks like a normal assistant turn with a red skin. A tighter inline treatment may fit the night-sky direction better.

## V11. Settings status dot without a label for the empty state

`desktop-settings-empty.png`, `desktop-settings-missing-key.png`

"Not checked" and "0 models" are clear enough, but the dot colors carry the state. When there is no key the row could say so directly, since that is the action the screen wants.

## V12. Edit actions are hidden until hover

`inline-user-edit.png`, `inline-reply-edit-after.png`

Copy, Edit, and Edit reply live in action bars that appear on hover. On a touch screen the user has to tap a message once to reveal the bar, then tap Edit. Nothing on the message says it is editable. A small always-visible affordance, or a message menu, would make this discoverable.

## V13. Code header now holds two icons

`inline-code-edit.png`

The header has a pencil and a copy button. They are 24px targets in a 32px strip and read as equal weight even though copy is used more. The pencil also looks like an annotation action rather than an editor toggle.

## V14. The reply editor is a raw markdown textarea

`inline-reply-edit.png`

Editing a reply drops the rendered markdown for a 12px mono textarea with no syntax highlighting and no line numbers. The jump in typography is large for a small copy edit. The code editor uses the same treatment inside the code card.

## V15. The edit composer loses the message copy

`inline-user-edit.png`

While editing, the user bubble becomes a full width raised card with Cancel and Send at the lower right. It reads as a new composer rather than an edit of the bubble above it, and the copy action is gone during the edit. A quieter in-bubble treatment may fit the thread better.
