import { and, eq, exists } from "drizzle-orm";
import { z } from "zod";
import { connectionApiKey, getConnection, getModelDefaults, listConnections, seedConnection, type ProviderConnection } from "./connections";
import { getDb } from "./db";
import { chats, providerConnections } from "./db/schema";
import { EFFORTS, type Effort, type EffortOutcome } from "./effort";
import { SecretUnreadable } from "./secrets";

export type ModelChoice = { connectionId: string; model: string; effort: Effort };
// connectionId goes null on a saved reply when its connection is deleted. The model and effort stay for the label.
export type ReplyRecord = { connectionId: string | null; model: string; effort: Effort | null; effortOutcome: EffortOutcome | null };

export type ResolvedChoice =
  | { ok: true; choice: ModelChoice; connection: ProviderConnection }
  | { ok: false; reason: "no-connection" | "no-model" | "key-unreadable" };

type ChatColumns = { connectionId: string | null; model: string | null; reasoningEffort: string | null };

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

// A user with no connection can still adopt the pending provider here, in case the signup hook failed after the user row.
function fromDefaults(userId: string): ResolvedChoice {
  if (listConnections(userId).length === 0) seedConnection(userId, "pending");
  const defaults = getModelDefaults(userId);
  const connection = defaults.connectionId ? getConnection(userId, defaults.connectionId) : (listConnections(userId)[0] ?? null);
  if (!connection) return { ok: false, reason: "no-connection" };
  if (!defaults.connectionId || !defaults.model) return { ok: false, reason: "no-model" };
  return { ok: true, connection, choice: { connectionId: connection.id, model: defaults.model, effort: defaults.effort ?? "medium" } };
}

function readable(userId: string, resolved: ResolvedChoice): ResolvedChoice {
  if (!resolved.ok) return resolved;
  try {
    connectionApiKey(userId, resolved.connection.id);
    return resolved;
  } catch (error) {
    if (error instanceof SecretUnreadable) return { ok: false, reason: "key-unreadable" };
    throw error;
  }
}

/** The request wins, then the chat's own choice, then the user's defaults. */
export function resolveChoice(userId: string, chat: ChatColumns, requested?: ModelChoice): ResolvedChoice {
  const pick = requested ?? chatChoice(chat);
  if (!pick) return readable(userId, fromDefaults(userId));
  const connection = getConnection(userId, pick.connectionId);
  if (connection) return readable(userId, { ok: true, choice: pick, connection });
  return requested ? { ok: false, reason: "no-connection" } : readable(userId, fromDefaults(userId));
}
