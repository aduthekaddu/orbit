import type { ChatSummary } from "@/components/chat/chat-row-menu";

// How long a deleted chat waits for Undo before its DELETE is sent.
export const UNDO_MS = 5_000;

// Undo is client-side: `pending` waits for Undo, `committing` has a DELETE in flight, and `failed` names the
// last chat whose DELETE failed, which is back in the list. A chat is in at most one of them.
export type ChatDeleteState = {
  pending: { chat: ChatSummary; wasOpen: boolean } | null;
  committing: ChatSummary[];
  failed: ChatSummary | null;
};

export type ChatDeleteEvent =
  | { type: "delete"; chat: ChatSummary; wasOpen: boolean }
  | { type: "undo" }
  | { type: "expire" }
  // DELETEs that left as the last page went away. The page that follows sends them again.
  | { type: "commit"; chats: ChatSummary[] }
  | { type: "committed"; id: string }
  | { type: "failed"; id: string }
  | { type: "dismiss" };

export const initialChatDelete: ChatDeleteState = { pending: null, committing: [], failed: null };

export function hiddenChatIds(state: ChatDeleteState): ReadonlySet<string> {
  const ids = new Set(state.committing.map((chat) => chat.id));
  if (state.pending) ids.add(state.pending.chat.id);
  return ids;
}

export function chatDeleteReducer(state: ChatDeleteState, event: ChatDeleteEvent): ChatDeleteState {
  switch (event.type) {
    case "delete": {
      // A double click, or a second menu on another screen, must not send a second DELETE.
      if (hiddenChatIds(state).has(event.chat.id)) return state;
      // One Undo at a time: an older pending delete commits now.
      return {
        pending: { chat: event.chat, wasOpen: event.wasOpen },
        committing: state.pending ? [...state.committing, state.pending.chat] : state.committing,
        failed: state.failed?.id === event.chat.id ? null : state.failed,
      };
    }
    case "undo":
      return state.pending ? { ...state, pending: null } : state;
    case "expire":
      return state.pending ? { ...state, pending: null, committing: [...state.committing, state.pending.chat] } : state;
    case "commit": {
      const hidden = hiddenChatIds(state);
      const added = event.chats.filter((chat) => !hidden.has(chat.id));
      return added.length === 0 ? state : { ...state, committing: [...state.committing, ...added] };
    }
    case "committed": {
      if (!state.committing.some((chat) => chat.id === event.id)) return state;
      return { ...state, committing: state.committing.filter((chat) => chat.id !== event.id) };
    }
    case "failed": {
      const chat = state.committing.find((item) => item.id === event.id);
      if (!chat) return state;
      return { ...state, committing: state.committing.filter((item) => item.id !== event.id), failed: chat };
    }
    case "dismiss":
      return state.failed ? { ...state, failed: null } : state;
  }
}
