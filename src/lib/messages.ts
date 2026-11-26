import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
import type { Redactor } from "./chat-errors";
import { replaceTextPart, replaceTextParts } from "./chat-parts";
import { getDb } from "./db";
import { assistantHasVisiblePart } from "./genui/spec";
import { chats, messages, providerConnections } from "./db/schema";
import { isPath, pathTo, toRepository, type StoredMessage } from "./chat-tree";
import { EFFORT_OUTCOMES, isEffort, type EffortOutcome } from "./effort";
import type { ReplyRecord } from "./model-choice";
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
  const db = getDb();
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

export function redactChatTitle(text: string, redact: Redactor): string {
  return redact.text(chatTitle(redact.text(text)));
}

export function touchChat(id: string, title?: string, redact?: Redactor) {
  const db = getDb();
  const existing = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!existing) return;
  const clean = title ? (redact ? redactChatTitle(title, redact) : chatTitle(title)) : "";
  const nextTitle = clean && existing.title === "New chat" ? clean : existing.title;
  db.update(chats).set({ title: nextTitle, updatedAt: new Date() }).where(eq(chats.id, id)).run();
}

export function storedMessageCount(chatId: string): number {
  const row = getDb().$client.prepare("select count(*) as n from messages where chat_id = ?").get(chatId) as { n: number };
  return row.n;
}

export function storedMessageIds(chatId: string): Set<string> {
  const rows = getDb().select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId)).all();
  return new Set(rows.map((row) => row.id));
}

export function replaceFallbackTitle(chatId: string, fallback: string, title: string) {
  if (!title || title === fallback) return;
  getDb().update(chats).set({ title }).where(and(eq(chats.id, chatId), eq(chats.title, fallback))).run();
}

function redactPartsCrossBoundary(parts: unknown, redact: Redactor): unknown {
  if (!Array.isArray(parts)) return redact.value(parts);
  const copy = parts.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return redact.value(part);
    const raw = part as Record<string, unknown>;
    const masked = redact.value(raw) as Record<string, unknown>;
    if (typeof raw.errorText === "string") {
      masked.errorText = redact.diagnostic(raw.errorText);
    }
    return masked;
  });
  for (const kind of ["text", "reasoning"] as const) {
    const indexes: number[] = [];
    const texts: string[] = [];
    for (let i = 0; i < copy.length; i++) {
      const item = copy[i];
      if (item && typeof item === "object" && (item as { type?: unknown }).type === kind && typeof (item as { text?: unknown }).text === "string") {
        indexes.push(i);
        texts.push((item as { text: string }).text);
      }
    }
    if (indexes.length < 2) continue;
    const masked = redact.maskSegments(texts);
    for (let i = 0; i < indexes.length; i++) {
      (copy[indexes[i]] as { text: string }).text = masked[i];
    }
  }
  return copy;
}

// The search text joins parts and strips terminal codes, which can spell a credential, so it is masked after.
function messageBody(parts: unknown, redact: Redactor): SavedText {
  const saved = redactPartsCrossBoundary(parts, redact);
  return { content: redact.text(searchTextFromParts(saved)), parts: JSON.stringify(saved) };
}

// Callers hold the transaction.
function insertMessage(
  chatId: string,
  message: { id: string; role: "user" | "assistant"; parts: unknown },
  parentId: string | null,
  redact: Redactor,
  reply?: ReplyRecord,
) {
  const db = getDb();
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
    ...replyColumns(reply, redact),
  }).run();
  db.update(chats).set({ headId: message.id }).where(eq(chats.id, chatId)).run();
  return true;
}

export type IncomingMessage = { id: string; role: string; parts?: unknown };
export type WriteResult = "ok" | "cross-chat" | "stale";

export function persistIncoming(chatId: string, incoming: IncomingMessage[], redact: Redactor): WriteResult {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.select({
      id: messages.id,
      parentId: messages.parentId,
      role: messages.role,
    }).from(messages).where(eq(messages.chatId, chatId)).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ids = incoming.map((message) => message.id);
    const referenced = ids.length
      ? db.select({ id: messages.id, chatId: messages.chatId }).from(messages).where(inArray(messages.id, ids)).all()
      : [];
    if (referenced.some((row) => row.chatId !== chatId)) return "cross-chat";
    const path = incoming.filter((message) => byId.has(message.id) ||
      message.role !== "assistant" || assistantHasVisiblePart(message.parts));
    const tail = path.at(-1);
    const prefix = tail && !byId.has(tail.id) && tail.role === "user" ? path.slice(0, -1) : path;
    if (!isPath(rows, prefix)) return "stale";
    const userIds = path.flatMap((message) => {
      const saved = byId.get(message.id);
      return saved?.role === "user" ? [message.id] : [];
    });
    const bodies = userIds.length
      ? db.select({ id: messages.id, content: messages.content, parts: messages.parts })
        .from(messages)
        .where(and(eq(messages.chatId, chatId), inArray(messages.id, userIds)))
        .all()
      : [];
    const bodyById = new Map(bodies.map((row) => [row.id, row]));
    for (const message of path) {
      const saved = byId.get(message.id);
      if (!saved) {
        if (message !== tail || message.role !== "user" || !Array.isArray(message.parts)) return "stale";
      } else if (saved.role !== message.role ||
        (saved.role === "user" && message.parts && !matchesIncomingBody(bodyById.get(message.id), message.parts, redact))) {
        return "stale";
      }
    }
    if (tail && !byId.has(tail.id)) {
      if (!insertMessage(chatId, { id: tail.id, role: "user", parts: tail.parts }, prefix.at(-1)?.id ?? null, redact)) return "cross-chat";
    }
    return "ok";
  });
}

type SavedText = { content: string; parts: string };

function matchesIncomingBody(saved: SavedText | undefined, parts: unknown, redact: Redactor) {
  if (!saved) return false;
  // An open tab can still hold the prompt as typed. Older rows already match verbatim.
  return (saved.parts === JSON.stringify(parts) && saved.content === searchTextFromParts(parts)) ||
    unchanged(saved, messageBody(parts, redact));
}

function savedText(chatId: string, id: string): SavedText | undefined {
  return getDb().select({ content: messages.content, parts: messages.parts }).from(messages)
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
  redact: Redactor,
  trigger?: string,
  editMessageId?: string,
): ChatWritePlan {
  const db = getDb();
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
    const result = persistIncoming(chatId, incoming, redact);
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

// The model id comes from the provider's response, which can repeat a credential. The connection can be deleted while
// the reply streams, and then the reply is saved without it, as the delete leaves older replies. Callers hold the transaction.
function replyColumns(reply: ReplyRecord | undefined, redact: Redactor) {
  if (!reply) return {};
  const connected = reply.connectionId !== null &&
    getDb().select({ id: providerConnections.id }).from(providerConnections).where(eq(providerConnections.id, reply.connectionId)).get() !== undefined;
  return { connectionId: connected ? reply.connectionId : null, model: redact.text(reply.model), reasoningEffort: reply.effort, effortOutcome: reply.effortOutcome };
}

/** Saves a reply with a visible part, unless a row its plan copied has changed. Returns whether it saved. */
export function finishChatReply(plan: ReplyPlan, parts: unknown, redact: Redactor, reply?: ReplyRecord): boolean {
  if (!assistantHasVisiblePart(parts)) return false;
  const db = getDb();
  return db.transaction(() => {
    if (!unchanged(savedText(plan.chatId, plan.prompt.id), plan.prompt.saved)) return false;
    if (!plan.continues) return insertMessage(plan.chatId, { id: plan.id, role: "assistant", parts }, plan.prompt.id, redact, reply);
    if (!unchanged(savedText(plan.chatId, plan.id), plan.continues)) return false;
    db.update(messages).set({ ...messageBody(parts, redact), ...replyColumns(reply, redact) })
      .where(eq(messages.id, plan.id)).run();
    return true;
  });
}

export function updateMessageText(chatId: string, messageId: string, text: string, redact: Redactor, partIndex?: number) {
  if (text.trim() === "") return false;
  const db = getDb();
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
    .set(messageBody(parts, redact))
    .where(eq(messages.id, messageId))
    .run();
  return true;
}

type ReplyRow = { connectionId: string | null; model: string | null; reasoningEffort: string | null; effortOutcome: string | null };

// Replies saved before slice 17 have no model and show no label. A deleted connection leaves connectionId null.
function storedReply(row: ReplyRow): ReplyRecord | null {
  if (!row.model) return null;
  const outcome = EFFORT_OUTCOMES.find((value): value is EffortOutcome => value === row.effortOutcome) ?? null;
  return { connectionId: row.connectionId, model: row.model, effort: isEffort(row.reasoningEffort) ? row.reasoningEffort : null, effortOutcome: outcome };
}

function storedMessages(chatId: string): StoredMessage[] {
  const rows = getDb().select({
    id: messages.id,
    parentId: messages.parentId,
    role: messages.role,
    parts: messages.parts,
    connectionId: messages.connectionId,
    model: messages.model,
    reasoningEffort: messages.reasoningEffort,
    effortOutcome: messages.effortOutcome,
  }).from(messages).where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt), sql`rowid`).all();
  return rows.map((row) => {
    const reply = storedReply(row);
    return {
      id: row.id,
      parentId: row.parentId,
      role: row.role as "user" | "assistant",
      parts: JSON.parse(row.parts) as UIMessage["parts"],
      ...(reply ? { metadata: { reply } } : {}),
    };
  });
}

// Parts of stored assistant messages in this chat whose ids were sent on this turn.
// The chat route replaces incoming assistant parts with these so a client copy cannot overwrite a saved reply.
export function storedAssistantParts(chatId: string, ids: string[]): Map<string, UIMessage["parts"]> {
  if (ids.length === 0) return new Map();
  const rows = getDb().select({ id: messages.id, parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.role, "assistant"), inArray(messages.id, ids)))
    .all();
  return new Map(rows.map((row) => [row.id, JSON.parse(row.parts) as UIMessage["parts"]]));
}

export function listMessages(chatId: string): UIMessage[] {
  return storedMessages(chatId).map(({ parentId: _parentId, ...message }) => message);
}

export function messageRepository(chatId: string) {
  const chat = getDb().select().from(chats).where(eq(chats.id, chatId)).get();
  return toRepository(storedMessages(chatId), chat?.headId ?? null);
}

export function listChats(userId: string) {
  return getDb()
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
  const chat = getDb().select().from(chats).where(eq(chats.id, id)).get();
  if (!chat || chat.userId !== userId) return null;
  return chat;
}

export function createChat(userId: string) {
  const id = crypto.randomUUID();
  const now = new Date();
  getDb().insert(chats).values({ id, userId, title: "New chat", createdAt: now, updatedAt: now }).run();
  return { id };
}
