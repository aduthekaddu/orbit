import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
import { replaceTextPart, replaceTextParts } from "./chat-parts";
import { db } from "./db";
import { assistantHasVisiblePart } from "./genui/spec";
import { chats, messages } from "./db/schema";
import { isPath, pathTo, toRepository, type StoredMessage } from "./chat-tree";
import { runCodeOutputSchema } from "./sandbox/spec";
import { stripTerminalControls } from "./sandbox/terminal";

export function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: string; text?: string };
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return "";
    })
    .join("");
}

// What search sees for a message: its text, then the standard output and standard
// error of each finished code run. The source of a run is left out.
export function searchTextFromParts(parts: unknown): string {
  const text = textFromParts(parts);
  if (!Array.isArray(parts)) return text;
  const output: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: string; state?: string; output?: unknown };
    if (record.type !== "tool-run_code" || record.state !== "output-available") continue;
    const result = runCodeOutputSchema.safeParse(record.output);
    if (!result.success) continue;
    for (const channel of [result.data.stdout, result.data.stderr]) {
      const clean = stripTerminalControls(channel);
      if (clean.trim()) output.push(clean);
    }
  }
  return output.length === 0 ? text : [text, ...output].filter((piece) => piece !== "").join("\n");
}

export function ensureChat(id: string, userId: string) {
  const existing = db.select().from(chats).where(eq(chats.id, id)).get();
  if (existing) {
    if (existing.userId !== userId) return null;
    return existing;
  }
  const now = new Date();
  db.insert(chats)
    .values({ id, userId, title: "New chat", createdAt: now, updatedAt: now })
    .run();
  return db.select().from(chats).where(eq(chats.id, id)).get() ?? null;
}

/** A one-line sidebar title from the first message: code, markdown markers, and line breaks dropped. */
export function chatTitle(text: string): string {
  const plain = text
    .replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, " $1 ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~|[*_`])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 80) return plain;
  const cut = plain.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 50 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function touchChat(id: string, title?: string) {
  const existing = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!existing) return;
  const clean = title ? chatTitle(title) : "";
  const nextTitle = clean && existing.title === "New chat" ? clean : existing.title;
  db.update(chats).set({ title: nextTitle, updatedAt: new Date() }).where(eq(chats.id, id)).run();
}

export function storedMessageCount(chatId: string): number {
  const row = db.$client.prepare("select count(*) as n from messages where chat_id = ?").get(chatId) as { n: number };
  return row.n;
}

export function replaceFallbackTitle(chatId: string, fallback: string, title: string) {
  if (!title || title === fallback) return;
  db.update(chats).set({ title }).where(and(eq(chats.id, chatId), eq(chats.title, fallback))).run();
}

type ReplyEnd = {
  regenerate: boolean;
  interrupted: boolean;
  hadReply: boolean;
  visible: boolean;
};

export function shouldSaveReply({ visible }: ReplyEnd): boolean {
  return visible;
}

export type ExpectedMessage = { id: string; content: string; parts: string };

export function replyGuard(chatId: string, _regenerate: boolean, _responseId: string, promptId?: string) {
  const prompt = promptId ? db.select().from(messages)
    .where(and(eq(messages.id, promptId), eq(messages.chatId, chatId))).get() : undefined;
  return { hadReply: false, expected: prompt && { id: prompt.id, content: prompt.content, parts: prompt.parts } };
}

export function upsertMessage(
  chatId: string,
  message: { id: string; role: string; parts: unknown },
  replyTo?: string | null,
  expected?: ExpectedMessage,
) {
  if (message.role !== "user" && message.role !== "assistant") return true;
  if (message.role === "assistant" && !assistantHasVisiblePart(message.parts)) return true;
  return db.transaction((tx) => {
    if (expected) {
      const current = tx.select().from(messages)
        .where(and(eq(messages.id, expected.id), eq(messages.chatId, chatId))).get();
      if (!current || current.content !== expected.content || current.parts !== expected.parts) return false;
    }
    const content = searchTextFromParts(message.parts);
    const parts = JSON.stringify(message.parts ?? []);
    const existing = tx.select().from(messages).where(eq(messages.id, message.id)).get();
    if (existing) {
      if (existing.chatId !== chatId) return false;
      tx.update(messages).set({ role: message.role, content, parts }).where(eq(messages.id, message.id)).run();
      return true;
    }
    const chat = tx.select().from(chats).where(eq(chats.id, chatId)).get();
    if (!chat) return false;
    const parentId = replyTo === undefined ? chat.headId : replyTo;
    const parent = parentId ? tx.select().from(messages)
      .where(and(eq(messages.id, parentId), eq(messages.chatId, chatId))).get() : undefined;
    if (parentId && !parent) return false;
    tx.insert(messages).values({
      id: message.id, chatId, parentId,
      role: message.role, content, parts,
      position: parent ? parent.position + 1 : 0,
      createdAt: new Date(),
    }).run();
    tx.update(chats).set({ headId: message.id }).where(eq(chats.id, chatId)).run();
    return true;
  });
}

export type IncomingMessage = { id: string; role: string; parts?: unknown };
export type WriteResult = "ok" | "cross-chat" | "stale";

export function persistIncoming(chatId: string, incoming: IncomingMessage[]): WriteResult {
  return db.transaction(() => {
    const rows = db.select().from(messages).where(eq(messages.chatId, chatId)).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ids = incoming.map((message) => message.id);
    const referenced = ids.length ? db.select().from(messages).where(inArray(messages.id, ids)).all() : [];
    if (referenced.some((row) => row.chatId !== chatId)) return "cross-chat";
    const path = incoming.filter((message) => byId.has(message.id) ||
      message.role !== "assistant" || assistantHasVisiblePart(message.parts));
    const tail = path.at(-1);
    const prefix = tail && !byId.has(tail.id) && tail.role === "user" ? path.slice(0, -1) : path;
    if (!isPath(rows, prefix)) return "stale";
    for (const message of path) {
      const saved = byId.get(message.id);
      if (!saved) {
        if (message !== tail || message.role !== "user" || !Array.isArray(message.parts)) return "stale";
      } else if (saved.role !== message.role || (saved.role === "user" && message.parts &&
        (saved.content !== searchTextFromParts(message.parts) || saved.parts !== JSON.stringify(message.parts)))) {
        return "stale";
      }
    }
    if (tail && !byId.has(tail.id)) {
      if (!upsertMessage(chatId, { ...tail, parts: tail.parts }, prefix.at(-1)?.id ?? null)) return "cross-chat";
    }
    return "ok";
  });
}

export type ChatWritePlan =
  | { regenerate: boolean; responseId: string }
  | { error: "invalid-edit" | "cross-chat" | "stale" };

export function planChatWrite(
  chatId: string,
  incoming: IncomingMessage[],
  trigger?: string,
  _messageId?: string,
  editMessageId?: string,
): ChatWritePlan {
  return db.transaction(() => {
    if (editMessageId) {
      const tree = storedMessages(chatId);
      const target = tree.find((message) => message.id === editMessageId && message.role === "user");
      const edited = incoming.at(-1);
      if (trigger !== "submit-message" || !target || edited?.role !== "user" ||
        edited.id === editMessageId || !Array.isArray(edited.parts)) return { error: "invalid-edit" };
      const prefix = pathTo(tree, target.parentId);
      if (incoming.length !== prefix.length + 1 || prefix.some((message, i) => incoming[i]?.id !== message.id)) {
        return { error: "invalid-edit" };
      }
    }
    const result = persistIncoming(chatId, incoming);
    if (result !== "ok") return { error: result };
    const prompt = incoming.findLast((message) => message.role === "user");
    if (prompt) db.update(chats).set({ headId: prompt.id }).where(eq(chats.id, chatId)).run();
    return { regenerate: trigger === "regenerate-message", responseId: crypto.randomUUID() };
  });
}

export function updateMessageText(chatId: string, messageId: string, text: string, partIndex?: number) {
  const row = db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)))
    .get();
  if (!row || row.role !== "assistant") return false;
  const current = JSON.parse(row.parts) as UIMessage["parts"];
  const parts = partIndex == null ? replaceTextParts(current, text) : replaceTextPart(current, partIndex, text);
  if (!parts) return false;
  db.update(messages)
    .set({ content: searchTextFromParts(parts), parts: JSON.stringify(parts) })
    .where(eq(messages.id, messageId))
    .run();
  return true;
}

function storedMessages(chatId: string): StoredMessage[] {
  const rows = db.select().from(messages).where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt), sql`rowid`).all();
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    role: row.role as "user" | "assistant",
    parts: JSON.parse(row.parts) as UIMessage["parts"],
  }));
}

export function listMessages(chatId: string): UIMessage[] {
  return storedMessages(chatId).map(({ parentId: _parentId, ...message }) => message);
}

export function messageRepository(chatId: string) {
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  return toRepository(storedMessages(chatId), chat?.headId ?? null);
}

export function listChats(userId: string) {
  return db
    .select({ id: chats.id, title: chats.title, updatedAt: chats.updatedAt })
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(sql`${chats.updatedAt} desc`)
    .all()
    .map((chat) => ({
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt.toISOString(),
    }));
}

export function getChatForUser(id: string, userId: string) {
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat || chat.userId !== userId) return null;
  return chat;
}

export function createChat(userId: string) {
  const id = crypto.randomUUID();
  const now = new Date();
  db.insert(chats).values({ id, userId, title: "New chat", createdAt: now, updatedAt: now }).run();
  return { id };
}
