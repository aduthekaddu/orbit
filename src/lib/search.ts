import Database from "better-sqlite3";
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

function quotedToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

export function toMatchQuery(input: string): string | null {
  const tokens = input.split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens
    .map((token, index) => {
      const quoted = quotedToken(token);
      return index === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" ");
}

const STOP_WORDS = new Set(
  (
    "about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during " +
    "each few for from further had has have having he her here hers herself him himself his how if in into is it its itself just me more most my myself no nor not " +
    "of off on once only or other our ours ourselves out over own re same shall she should so some such than that the their theirs them themselves then there " +
    "these they this those through to too under until up ve very was we were what when where which while who whom why will with would you your yours yourself " +
    "yourselves ll"
  ).split(" "),
);

function contentWords(input: string): string[] {
  const words = input
    .toLowerCase()
    .replace(/(?<!\p{L})\p{L}+n['’]t(?!\p{L})/gu, " ")
    .match(/[\p{L}\p{N}]+/gu);
  return [...new Set((words ?? []).filter((word) => word.length > 1 && !STOP_WORDS.has(word)))];
}

export function toOrMatchQuery(input: string): string | null {
  const words = contentWords(input);
  if (words.length === 0) return null;
  return words.map((word) => quotedToken(word)).join(" OR ");
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
  } catch (error) {
    console.error("[search] query failed", {
      code: error instanceof Database.SqliteError ? error.code : "UNKNOWN",
    });
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
