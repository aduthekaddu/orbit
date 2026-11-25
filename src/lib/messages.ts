import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
import type { Redactor } from "./chat-errors";
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
// error of each finished code run, then the source of each code run.
export function searchTextFromParts(parts: unknown): string {
  const text = textFromParts(parts);
  if (!Array.isArray(parts)) return text;
  const output: string[] = [];
  const source: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: string; state?: string; input?: unknown; output?: unknown };
    if (record.type !== "tool-run_code") continue;
    const code = (record.input as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "string" && code.trim()) source.push(code);
    if (record.state !== "output-available") continue;
    const result = runCodeOutputSchema.safeParse(record.output);
    if (!result.success) continue;
    for (const channel of [result.data.stdout, result.data.stderr]) {
      const clean = stripTerminalControls(channel);
      if (clean.trim()) output.push(clean);
    }
  }
  const pieces = [...output, ...source];
  return pieces.length === 0 ? text : [text, ...pieces].filter((piece) => piece !== "").join("\n");
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

export function storedMessageIds(chatId: string): Set<string> {
  const rows = db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId)).all();
  return new Set(rows.map((row) => row.id));
}

export function replaceFallbackTitle(chatId: string, fallback: string, title: string) {
  if (!title || title === fallback) return;
  db.update(chats).set({ title }).where(and(eq(chats.id, chatId), eq(chats.title, fallback))).run();
}

// The search text joins parts and strips terminal codes, which can spell a credential, so it is masked after.
function messageBody(parts: unknown, redact?: Redactor) {
  const saved = redact ? redact.value(parts) : parts;
  const content = redact ? redact.text(searchTextFromParts(saved)) : searchTextFromParts(saved);
  return { content, parts: JSON.stringify(saved) };
}

// Callers hold the transaction.
function insertMessage(
  chatId: string,
  message: { id: string; role: "user" | "assistant"; parts: unknown },
  parentId: string | null,
  redact?: Redactor,
) {
  if (db.select().from(messages).where(eq(messages.id, message.id)).get()) return false;
  if (!db.select().from(chats).where(eq(chats.id, chatId)).get()) return false;
  const parent = parentId ? db.select().from(messages)
    .where(and(eq(messages.id, parentId), eq(messages.chatId, chatId))).get() : undefined;
  if (parentId && !parent) return false;
  const body = messageBody(message.parts, redact);
  db.insert(messages).values({
    id: message.id, chatId, parentId,
    role: message.role, content: body.content, parts: body.parts,
    position: parent ? parent.position + 1 : 0,
    createdAt: new Date(),
  }).run();
  db.update(chats).set({ headId: message.id }).where(eq(chats.id, chatId)).run();
  return true;
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
      if (!insertMessage(chatId, { id: tail.id, role: "user", parts: tail.parts }, prefix.at(-1)?.id ?? null)) return "cross-chat";
    }
    return "ok";
  });
}

type SavedText = { content: string; parts: string };

function savedText(chatId: string, id: string): SavedText | undefined {
  return db.select({ content: messages.content, parts: messages.parts }).from(messages)
    .where(and(eq(messages.id, id), eq(messages.chatId, chatId))).get();
}

declare const madeByPlanChatWrite: unique symbol;

/** How a chat request saves its reply. Only planChatWrite makes one, and finishChatReply saves a reply only through one. */
export type ReplyPlan = {
  readonly [madeByPlanChatWrite]: true;
  chatId: string;
  /** The id the AI SDK streams the reply under. */
  id: string;
  /** The prompt the reply answers, with its text when planned. A new reply is saved under it. */
  prompt: { id: string; saved: SavedText };
  /** The saved text of reply `id` when the stream continues that reply, or null for a new reply. */
  continues: SavedText | null;
};

export type ChatWritePlan = ReplyPlan | { error: "invalid-edit" | "no-prompt" | "cross-chat" | "stale" };

export function planChatWrite(
  chatId: string,
  incoming: IncomingMessage[],
  trigger?: string,
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
    const user = incoming.findLast((message) => message.role === "user");
    if (!user) return { error: "no-prompt" };
    const result = persistIncoming(chatId, incoming);
    if (result !== "ok") return { error: result };
    const saved = savedText(chatId, user.id);
    if (!saved) return { error: "stale" };
    // When the last message is an assistant's, the AI SDK streams the reply under its id and appends
    // to its parts (node_modules/ai/src/ui-message-stream/get-response-ui-message-id.ts).
    const last = incoming.at(-1);
    const id = last?.role === "assistant" ? last.id : crypto.randomUUID();
    const continues = savedText(chatId, id) ?? null;
    db.update(chats).set({ headId: continues ? id : user.id }).where(eq(chats.id, chatId)).run();
    return { chatId, id, prompt: { id: user.id, saved }, continues } as ReplyPlan;
  });
}

function unchanged(row: SavedText | undefined, copy: SavedText) {
  return row !== undefined && row.content === copy.content && row.parts === copy.parts;
}

/** Saves a reply with a visible part, unless a row its plan copied has changed. Returns whether it saved. */
export function finishChatReply(plan: ReplyPlan, parts: unknown, redact?: Redactor): boolean {
  if (!assistantHasVisiblePart(parts)) return false;
  return db.transaction(() => {
    if (!unchanged(savedText(plan.chatId, plan.prompt.id), plan.prompt.saved)) return false;
    if (!plan.continues) return insertMessage(plan.chatId, { id: plan.id, role: "assistant", parts }, plan.prompt.id, redact);
    if (!unchanged(savedText(plan.chatId, plan.id), plan.continues)) return false;
    db.update(messages).set(messageBody(parts, redact))
      .where(eq(messages.id, plan.id)).run();
    return true;
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
