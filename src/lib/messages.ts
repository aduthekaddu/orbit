import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
import { replaceTextParts } from "./chat-parts";
import { db } from "./db";
import { chats, messages } from "./db/schema";

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

export function upsertMessage(
  chatId: string,
  message: { id: string; role: string; parts: unknown },
  replyTo?: string,
) {
  if (message.role !== "user" && message.role !== "assistant") return true;
  if (message.role === "assistant" && Array.isArray(message.parts) && message.parts.length === 0) return true;
  const content = textFromParts(message.parts);
  const parts = JSON.stringify(message.parts ?? []);
  const existing = db.select({ chatId: messages.chatId }).from(messages).where(eq(messages.id, message.id)).get();
  if (existing) {
    if (existing.chatId !== chatId) return false;
    db.update(messages).set({ role: message.role, content, parts }).where(eq(messages.id, message.id)).run();
    return true;
  }
  return db.transaction((tx) => {
    const prompt = replyTo
      ? tx
          .select({ position: messages.position })
          .from(messages)
          .where(and(eq(messages.id, replyTo), eq(messages.chatId, chatId)))
          .get()
      : undefined;
    const row = tx
      .select({ position: sql<number>`coalesce(max(${messages.position}), -1)` })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .get();
    const position = prompt ? prompt.position + 1 : (row?.position ?? -1) + 1;
    if (prompt) {
      tx.update(messages)
        .set({ position: sql`${messages.position} + 1` })
        .where(and(eq(messages.chatId, chatId), gte(messages.position, position)))
        .run();
    }
    tx.insert(messages)
      .values({
        id: message.id,
        chatId,
        role: message.role,
        content,
        parts,
        position,
        createdAt: new Date(),
      })
      .run();
    return true;
  });
}

export type IncomingMessage = { id: string; role: string; parts?: unknown };

export function persistIncoming(chatId: string, incoming: IncomingMessage[]) {
  const withParts = incoming.filter(
    (message): message is IncomingMessage & { parts: unknown } => Boolean(message.parts),
  );
  if (withParts.length === 0) return true;
  const saved = db
    .select({ id: messages.id, chatId: messages.chatId, role: messages.role, content: messages.content, parts: messages.parts })
    .from(messages)
    .where(inArray(messages.id, withParts.map((message) => message.id)))
    .all();
  const byId = new Map(saved.map((row) => [row.id, row]));
  for (const message of withParts) {
    const existing = byId.get(message.id);
    if (existing && existing.chatId === chatId) {
      // The server owns answers. A stale tab echoes the pre-regenerate text under the same id.
      if (existing.role === "assistant" && message.role === "assistant") continue;
      const content = textFromParts(message.parts);
      if (existing.role === message.role && existing.content === content && existing.parts === JSON.stringify(message.parts ?? [])) {
        continue;
      }
    }
    if (!upsertMessage(chatId, message)) return false;
  }
  return true;
}

/** The id this response stores under. A regenerate reuses the answer it replaces, so a failed one leaves that answer alone. */
function responseIdFor(chatId: string, incoming: IncomingMessage[], trigger?: string, messageId?: string) {
  if (trigger !== "regenerate-message") return crypto.randomUUID();
  const rows = db
    .select({ id: messages.id, role: messages.role })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.position))
    .all();
  const target = messageId ? rows.find((row) => row.id === messageId) : undefined;
  if (target?.role === "assistant") return target.id;
  const lastUser = incoming.findLast((message) => message.role === "user");
  const promptIndex = lastUser ? rows.findIndex((row) => row.id === lastUser.id) : -1;
  if (promptIndex === -1) return crypto.randomUUID();
  for (const row of rows.slice(promptIndex + 1)) {
    if (row.role === "user") break;
    if (row.role === "assistant") return row.id;
  }
  return crypto.randomUUID();
}

/** Persist the client list and pick the id the response stores under. Null means an id belongs to another chat. */
export function planChatWrite(
  chatId: string,
  incoming: IncomingMessage[],
  trigger?: string,
  messageId?: string,
  editMessageId?: string,
): { regenerate: boolean; responseId: string } | null {
  if (editMessageId) {
    const rows = db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.position)).all();
    const index = rows.findIndex((row) => row.id === editMessageId && row.role === "user");
    const target = rows[index];
    const edited = incoming.at(-1);
    if (trigger !== "submit-message" || !target || edited?.role !== "user" || !Array.isArray(edited.parts)) return null;
    const prefix = rows.slice(0, index);
    if (incoming.length !== prefix.length + 1 || prefix.some((row, i) => incoming[i]?.id !== row.id)) return null;
    const ids = incoming.map((message) => message.id);
    const existing = db.select().from(messages).where(inArray(messages.id, ids)).all();
    if (existing.some((row) => row.chatId !== chatId || (row.id === edited.id && row.id !== editMessageId))) return null;
    return db.transaction(() => {
      db.delete(messages).where(and(eq(messages.chatId, chatId), gte(messages.position, target.position))).run();
      if (!persistIncoming(chatId, incoming)) throw new Error("Edited history could not be saved");
      return { regenerate: false, responseId: crypto.randomUUID() };
    });
  }
  if (!persistIncoming(chatId, incoming)) return null;
  return {
    regenerate: trigger === "regenerate-message",
    responseId: responseIdFor(chatId, incoming, trigger, messageId),
  };
}

export function updateMessageText(chatId: string, messageId: string, text: string) {
  const row = db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)))
    .get();
  if (!row) return false;
  const parts = replaceTextParts(JSON.parse(row.parts) as UIMessage["parts"], text);
  db.update(messages)
    .set({ content: text, parts: JSON.stringify(parts) })
    .where(eq(messages.id, messageId))
    .run();
  return true;
}

export function listMessages(chatId: string): UIMessage[] {
  const rows = db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.position)).all();
  return rows.map((row) => ({
    id: row.id,
    role: row.role as "user" | "assistant",
    parts: JSON.parse(row.parts) as UIMessage["parts"],
  }));
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
