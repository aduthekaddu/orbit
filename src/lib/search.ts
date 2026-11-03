import { focusedHead } from "./chat-tree";
import { db } from "./db";
import { getChatForUser } from "./messages";

export type SearchHit = {
  chatId: string;
  chatTitle: string;
  messageId: string;
  role: "user" | "assistant";
  snippet: string;
};

type SearchRow = {
  chatId: string;
  chatTitle: string;
  messageId: string;
  role: string;
  snippet: string;
};

export function toMatchQuery(input: string): string | null {
  const tokens = input.split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens
    .map((token, index) => {
      const quoted = `"${token.replaceAll('"', '""')}"`;
      return index === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" ");
}

export function searchMessages(userId: string, q: string): SearchHit[] {
  const match = toMatchQuery(q);
  if (!match) return [];
  try {
    const rows = db.$client
      .prepare(
        `SELECT chats.id AS chatId,
                chats.title AS chatTitle,
                messages.id AS messageId,
                messages.role AS role,
                snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
         FROM messages_fts
         JOIN messages ON messages.rowid = messages_fts.rowid
         JOIN chats ON chats.id = messages.chat_id
         WHERE messages_fts MATCH ?
           AND chats.user_id = ?
           AND messages.role IN ('user', 'assistant')
         ORDER BY bm25(messages_fts)
         LIMIT 20`,
      )
      .all(match, userId) as SearchRow[];
    return rows.flatMap((row) =>
      row.role === "user" || row.role === "assistant" ? [{ ...row, role: row.role }] : [],
    );
  } catch {
    return [];
  }
}

export function openHitPath(userId: string, chatId: string, messageId: string): string[] {
  const chat = getChatForUser(chatId, userId);
  if (!chat) return [];
  const rows = db.$client
    .prepare("SELECT id, parent_id AS parentId FROM messages WHERE chat_id = ?")
    .all(chatId) as { id: string; parentId: string | null }[];
  const head = focusedHead(rows, chat.headId, messageId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: string[] = [];
  const seen = new Set<string>();
  let id: string | null = head;
  while (id !== null) {
    if (seen.has(id)) return [];
    seen.add(id);
    const row = byId.get(id);
    if (!row) return [];
    path.push(id);
    id = row.parentId;
  }
  return path.reverse();
}
