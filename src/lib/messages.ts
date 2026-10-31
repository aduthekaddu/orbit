import { and, asc, eq, notInArray, sql } from "drizzle-orm";
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

export function upsertMessage(chatId: string, message: { id: string; role: string; parts: unknown }) {
  if (message.role !== "user" && message.role !== "assistant") return;
  if (message.role === "assistant" && Array.isArray(message.parts) && message.parts.length === 0) return;
  const content = textFromParts(message.parts);
  const parts = JSON.stringify(message.parts ?? []);
  const existing = db.select({ id: messages.id }).from(messages).where(eq(messages.id, message.id)).get();
  if (existing) {
    db.update(messages).set({ role: message.role, content, parts }).where(eq(messages.id, message.id)).run();
    return;
  }
  const row = db
    .select({ position: sql<number>`coalesce(max(${messages.position}), -1)` })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .get();
  db.insert(messages)
    .values({
      id: message.id,
      chatId,
      role: message.role,
      content,
      parts,
      position: (row?.position ?? -1) + 1,
      createdAt: new Date(),
    })
    .run();
}

/** Drop stored messages the client did not resend, so a regenerated or edited turn replaces the old one. */
export function keepOnlyMessages(chatId: string, ids: string[]) {
  if (ids.length === 0) return;
  db.delete(messages)
    .where(and(eq(messages.chatId, chatId), notInArray(messages.id, ids)))
    .run();
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

export function listMessages(chatId: string): UIMessage[] {  const rows = db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.position)).all();
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
