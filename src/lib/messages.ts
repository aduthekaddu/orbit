import { asc, eq, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
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

export function touchChat(id: string, title?: string) {
  const existing = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!existing) return;
  const nextTitle = title && existing.title === "New chat" ? title.slice(0, 80) : existing.title;
  db.update(chats).set({ title: nextTitle, updatedAt: new Date() }).where(eq(chats.id, id)).run();
}

export function upsertMessage(chatId: string, message: { id: string; role: string; parts: unknown }) {
  if (message.role !== "user" && message.role !== "assistant") return true;
  const content = textFromParts(message.parts);
  const parts = JSON.stringify(message.parts ?? []);
  const existing = db.select({ chatId: messages.chatId }).from(messages).where(eq(messages.id, message.id)).get();
  if (existing) {
    if (existing.chatId !== chatId) return false;
    db.update(messages).set({ role: message.role, content, parts }).where(eq(messages.id, message.id)).run();
    return true;
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
