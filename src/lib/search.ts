export type SearchHit = {
  chatId: string;
  chatTitle: string;
  messageId: string;
  role: "user" | "assistant";
  snippet: string;
};

/** Stub. Search tests should fail until MATCH is quoted and scoped to the user. */
export function toMatchQuery(_input: string): string | null {
  return null;
}

export function searchMessages(_userId: string, _q: string): SearchHit[] {
  return [];
}

export function openHitPath(_userId: string, _chatId: string, _messageId: string): string[] {
  return [];
}
