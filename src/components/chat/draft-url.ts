// `/new` sends a fresh chat to `/c/<id>?new`, which marks it as a draft with no chats row yet.

/**
 * The same URL without `?new`, or null when it has none or is not `/c/<chatId>`. Every other parameter and the
 * hash stay. A draft's answer can arrive after another draft has opened, and must leave that draft's `?new`.
 */
export function withoutNewParam(href: string, chatId: string): string | null {
  const url = new URL(href);
  if (url.pathname !== `/c/${encodeURIComponent(chatId)}` || !url.searchParams.has("new")) return null;
  url.searchParams.delete("new");
  return url.toString();
}

// Once the first message commits, a reload must open the saved chat instead of a draft.
export function dropNewParam(chatId: string) {
  const next = withoutNewParam(window.location.href, chatId);
  if (next !== null) window.history.replaceState(null, "", next);
}
