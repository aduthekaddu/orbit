import { and, eq, exists } from "drizzle-orm";
import { z } from "zod";
import { connectionApiKey, getModelDefaults, pickableConnection, trySeedConnection, type ProviderConnection } from "./connections";
import { getDb } from "./db";
import { chats, providerConnections } from "./db/schema";
import { DEFAULT_EFFORT, EFFORTS, type Effort, type EffortOutcome } from "./effort";
import type { Viewer } from "./policy";
import { SecretUnreadable } from "./secrets";

export type ModelChoice = { connectionId: string; model: string; effort: Effort };
// connectionId goes null on a saved reply when its connection is deleted. The model and effort stay for the label.
export type ReplyRecord = { connectionId: string | null; model: string; effort: Effort | null; effortOutcome: EffortOutcome | null };

export type ResolvedChoice =
  | { ok: true; choice: ModelChoice; connection: ProviderConnection }
  | { ok: false; reason: "no-connection" | "no-model" }
  // The choice is known, so the chat can still name it and the route can say which key to re-enter.
  | { ok: false; reason: "key-unreadable"; choice: ModelChoice };

type ChatColumns = { connectionId: string | null; model: string | null; reasoningEffort: string | null };
export const NOTHING_PINNED = { connectionId: null, model: null, reasoningEffort: null };

// setChatChoice writes the three together. A row with one or two set, or an effort outside the enum, was written
// some other way, so it fails here instead of sending a guess.
const chatTriple = z.union([
  z.object({ connectionId: z.null(), model: z.null(), reasoningEffort: z.null() }).transform(() => null),
  z
    .object({ connectionId: z.string().min(1), model: z.string().min(1), reasoningEffort: z.enum(EFFORTS) })
    .transform(({ connectionId, model, reasoningEffort }): ModelChoice => ({ connectionId, model, effort: reasoningEffort })),
]);

export function chatChoice(chat: ChatColumns): ModelChoice | null {
  return chatTriple.parse({ connectionId: chat.connectionId, model: chat.model, reasoningEffort: chat.reasoningEffort });
}

export function sameChoice(a: ModelChoice | null, b: ModelChoice) {
  return a !== null && a.connectionId === b.connectionId && a.model === b.model && a.effort === b.effort;
}

// A send waits for its reply slot after it resolves, so the connection may be gone by now. The check and the write are
// one statement, so a chat is never pinned to a connection that no longer exists or that another user owns.
export function setChatChoice(chatId: string, choice: ModelChoice) {
  const db = getDb();
  const owned = db
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(and(eq(providerConnections.id, choice.connectionId), eq(providerConnections.userId, chats.userId)));
  db.update(chats).set({ connectionId: choice.connectionId, model: choice.model, reasoningEffort: choice.effort }).where(and(eq(chats.id, chatId), exists(owned))).run();
}

function fromDefaults(viewer: Viewer): ResolvedChoice {
  let connection = pickableConnection(viewer, null);
  if (!connection && viewer.role === "admin") {
    trySeedConnection(viewer);
    connection = pickableConnection(viewer, null);
  }
  if (!connection) return { ok: false, reason: "no-connection" };
  const defaults = getModelDefaults(viewer.id);
  if (!defaults.connectionId || !defaults.model) return { ok: false, reason: "no-model" };
  return { ok: true, connection, choice: { connectionId: connection.id, model: defaults.model, effort: defaults.effort ?? DEFAULT_EFFORT } };
}

function readable(userId: string, resolved: ResolvedChoice): ResolvedChoice {
  if (!resolved.ok) return resolved;
  try {
    connectionApiKey(userId, resolved.connection.id);
    return resolved;
  } catch (error) {
    if (error instanceof SecretUnreadable) return { ok: false, reason: "key-unreadable", choice: resolved.choice };
    throw error;
  }
}

/** The request wins, then the chat's own choice, then the user's defaults. */
export function resolveChoice(viewer: Viewer, chat: ChatColumns, requested?: ModelChoice): ResolvedChoice {
  const pick = requested ?? chatChoice(chat);
  if (!pick) return readable(viewer.id, fromDefaults(viewer));
  const connection = pickableConnection(viewer, { from: requested ? "request" : "stored", id: pick.connectionId });
  if (connection?.id === pick.connectionId) return readable(viewer.id, { ok: true, choice: pick, connection });
  return requested ? { ok: false, reason: "no-connection" } : readable(viewer.id, fromDefaults(viewer));
}
