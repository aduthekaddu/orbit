// `/new` sends a fresh chat to `/c/<id>?new`, which marks it as a draft with no chats row yet.

/** The same URL without `?new`, or null when it has none. Every other parameter and the hash stay. */
export function withoutNewParam(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("new")) return null;
  url.searchParams.delete("new");
  return url.toString();
}

// Once the first message commits, a reload must open the saved chat instead of a draft.
export function dropNewParam() {
  const next = withoutNewParam(window.location.href);
  if (next !== null) window.history.replaceState(null, "", next);
}
