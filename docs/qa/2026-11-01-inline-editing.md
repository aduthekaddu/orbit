# Inline editing

Branch `feat/inline-editing`, from `feat/design-system`. Screenshots are `docs/qa/screenshots/inline-*.png`.

## What ships

- User messages have an Edit action. It opens the assistant-ui edit composer in place, prefilled with the message. Send replaces that turn and everything after it, then asks the model again. Cancel restores the message.
- Assistant replies have an Edit reply action. It turns the reply into a markdown textarea. Save writes the text into the message in place and does not call the model. Cancel leaves the message alone.
- Code blocks have an Edit code action in the code header. It turns the block into a textarea. Save replaces that block's code inside the reply and leaves the rest of the markdown alone. Cancel leaves it alone.
- A code block cannot be edited while the reply is still streaming.
- Save with no change closes the editor and sends no request.

The user edit uses replace semantics, not a branch. The client slices later messages and the server deletes rows the client did not resend, so a reload shows the same thread.

## Data and API

- `src/lib/chat-parts.ts` has `replaceTextParts`, `messageText`, and `replaceCode`. `replaceCode` uses the code block's markdown offsets and keeps a trailing newline so the closing fence stays on its own line.
- `PATCH /api/chats/:id/messages/:messageId` takes `{ text }`, requires a session and chat ownership, and returns 401, 400, or 404 on the usual failures.
- `updateMessageText` in `src/lib/messages.ts` rewrites the first text part, keeps other parts in place, and updates `content`.
- The client updates `useChat` messages through `useAISDKChat().setMessages`, so the edited text is what the next turn sends to the model.

## Files

- `src/components/chat/chat-id.tsx` passes the chat id to message components.
- `src/components/chat/use-save-message.ts` saves and updates the client messages.
- `src/components/chat/message-editor.tsx` is the reply editor.
- `src/components/chat/code-edit-context.tsx`, `markdown-text.tsx`, and `code-block.tsx` wire the code block editor.
- `src/components/chat/messages.tsx` has the edit actions and the user edit composer.
- `src/app/api/chats/[id]/messages/[messageId]/route.ts` is the save endpoint.

## Verified

Playwright on `127.0.0.1:3212` at 1440x900 and 390x844, with the local mock provider.

- Edit a user message in a two turn chat. The later turn disappeared, the reply regenerated for the new text, and reload kept only the edited turn.
- Cancel and Escape left the original message and reply untouched.
- Edit an assistant reply. The new text replaced the old text and survived reload.
- Edit a code block in a reply with two blocks. Only the second block changed, both fences stayed valid, and the table and lists were unchanged.
- Edit a code block on mobile at 390px. No horizontal page overflow.
- Save with no change made no PATCH request.
- Unauthenticated save 401, unknown message 404, invalid body 400, unknown chat 404.
- `npm run typecheck` and `npm run build` exit 0.

## Screenshots

- `inline-user-edit.png`: user edit composer prefilled.
- `inline-user-edit-after.png`: after Send, the later turn is gone.
- `inline-user-edit-mobile.png`: user edit on mobile after tapping the message.
- `inline-reply-edit.png`: reply editor with raw markdown.
- `inline-reply-edit-after.png`: saved reply text.
- `inline-code-edit.png`: code editor open in the code block.
- `inline-code-edit-after.png`: saved code.
- `inline-code-edit-mobile.png`: code editor at 390px.
- `inline-persisted.png`: reply and code edits after reload.
