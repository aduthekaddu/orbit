import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { focusedHead } from "./chat-tree";
import { getDb } from "./db";
import { getChatForUser, messageRepository } from "./messages";

/** A run of snippet text, flagged when it is a word the search matched. */
export type SnippetPart = { text: string; match: boolean };

export type SearchHit = {
  chatId: string;
  chatTitle: string;
  messageId: string;
  role: "user" | "assistant";
  snippet: SnippetPart[];
};

type SearchRow = {
  chatId: string;
  chatTitle: string;
  messageId: string;
  role: string;
  snippet: string;
  marked: number;
};

type Markers = { start: string; end: string };
type MarkedText = { text: string; matches: Uint8Array };

const ELLIPSIS = "…";

function unmark(snippet: string, markers: Markers | undefined): MarkedText {
  const matches = new Uint8Array(snippet.length);
  if (!markers) return { text: snippet, matches };

  const pieces: string[] = [];
  let offset = 0;
  let length = 0;
  for (;;) {
    const open = snippet.indexOf(markers.start, offset);
    if (open < 0) break;
    const start = open + markers.start.length;
    const end = snippet.indexOf(markers.end, start);
    if (end < 0) break;
    pieces.push(snippet.slice(offset, open), snippet.slice(start, end));
    length += open - offset;
    matches.fill(1, length, length + end - start);
    length += end - start;
    offset = end + markers.end.length;
  }
  pieces.push(snippet.slice(offset));
  return { text: pieces.join(""), matches };
}

// Apply a Markdown removal to unmarked text and carry over the match flags for the characters that remain.
// Group 1, when present, is the displayed text. Padding separates a fenced block from its surrounding text.
function project(input: MarkedText, pattern: RegExp, padding = "", foldWhitespace = false): MarkedText {
  const pieces: string[] = [];
  const matches = new Uint8Array(input.text.length);
  let offset = 0;
  let length = 0;
  function keep(start: number, end: number) {
    if (start === end) return;
    pieces.push(input.text.slice(start, end));
    matches.set(input.matches.subarray(start, end), length);
    length += end - start;
  }
  for (const match of input.text.matchAll(pattern)) {
    keep(offset, match.index);
    const range = match.indices?.[1];
    if (padding) {
      pieces.push(padding);
      if (foldWhitespace) matches[length] = input.matches[match.index];
      length++;
    }
    if (range) keep(...range);
    if (padding && range) {
      pieces.push(padding);
      length++;
    }
    offset = match.index + match[0].length;
  }
  if (offset === 0) return input;
  keep(offset, input.text.length);
  return { text: pieces.join(""), matches };
}

const EMPHASIS = [
  /(?<![\p{L}\p{N}*])\*\*(?=\S)([^*\n]+)(?<=\S)\*\*(?![\p{L}\p{N}*])/dgu,
  /(?<![\p{L}\p{N}_])__(?=\S)([^_\n]+)(?<=\S)__(?![\p{L}\p{N}_])/dgu,
  /~~(?=\S)([^~\n]+)(?<=\S)~~/dg,
  /(?<![\p{L}\p{N}*])\*(?=\S)([^*\n]+)(?<=\S)\*(?![\p{L}\p{N}*])/dgu,
  /(?<![\p{L}\p{N}_])_(?=\S)([^_\n]+)(?<=\S)_(?![\p{L}\p{N}_])/dgu,
  /`([^`\n]+)`/dg,
];

export function snippetParts(snippet: string, markers?: Markers): SnippetPart[] {
  const cut = snippet.startsWith(ELLIPSIS);
  let view = unmark(cut ? snippet.slice(ELLIPSIS.length) : snippet, markers);
  view = project(view, /```[^\n]*\n?([\s\S]*?)(?:```|$)/dg, " ");
  view = project(view, /!?\[([^\[\]]*)\]\([^()\s]*\)/dg);
  view = project(view, /^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm);
  for (const pattern of EMPHASIS) view = project(view, pattern);
  view = project(view, /\s+/g, " ", true);
  const parts: SnippetPart[] = [];
  const from = view.text.length - view.text.trimStart().length;
  const to = view.text.trimEnd().length;
  let start = from;
  for (let end = from + 1; end <= to; end++) {
    if (end !== to && view.matches[end] === view.matches[start]) continue;
    const text = view.text.slice(start, end);
    const match = view.matches[start] === 1;
    parts.push({ text, match });
    start = end;
  }
  if (cut) {
    const first = parts[0];
    if (first && !first.match) first.text = ELLIPSIS + first.text;
    else parts.unshift({ text: ELLIPSIS, match: false });
  }
  return parts;
}

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
  // These delimiters are separate from literal private-use glyphs in messages. If an old row happens to
  // contain this request's prefix, let SQLite return the same snippet without highlight delimiters.
  const prefix = `\uE000${randomUUID()}:`;
  const markers = { start: `${prefix}s\uE001`, end: `${prefix}e\uE001` };
  try {
    const rows = getDb().$client
      .prepare(
        `SELECT chats.id AS chatId,
                chats.title AS chatTitle,
                messages.id AS messageId,
                messages.role AS role,
                instr(messages.content, @prefix) = 0 AS marked,
                CASE WHEN instr(messages.content, @prefix) = 0
                  THEN snippet(messages_fts, 0, @start, @end, '…', 12)
                  ELSE snippet(messages_fts, 0, '', '', '…', 12)
                END AS snippet
         FROM messages_fts
         JOIN messages ON messages.rowid = messages_fts.rowid
         JOIN chats ON chats.id = messages.chat_id
         WHERE messages_fts MATCH @match
           AND chats.user_id = @userId
           AND messages.role IN ('user', 'assistant')
         ORDER BY bm25(messages_fts)
         LIMIT 20`,
      )
      .all({ match, userId, prefix, ...markers }) as SearchRow[];
    return rows.map(({ marked, snippet, ...row }) => ({ ...row, snippet: snippetParts(snippet, marked ? markers : undefined) }));
  } catch (error) {
    console.error("[search] query failed", {
      code: error instanceof Database.SqliteError ? error.code : "UNKNOWN",
    });
    return [];
  }
}

export function openHitPath(userId: string, chatId: string, messageId: string): string[] {
  if (!getChatForUser(chatId, userId)) return [];
  const history = messageRepository(chatId);
  const rows = history.messages.map(({ parentId, message }) => ({ id: message.id, parentId }));
  const head = focusedHead(rows, history.headId, messageId);
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
