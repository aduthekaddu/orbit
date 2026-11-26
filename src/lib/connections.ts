import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { normalizeBaseUrl } from "./base-url";
import { Redactor, redactUrl, resolveMaskedUrl } from "./chat-errors";
import { getDb, urlHostLabel } from "./db";
import { chats, hiddenModels, pendingConnection, providerConnections, userPreferences } from "./db/schema";
import { isEffort, type Effort } from "./effort";
import { readEnv } from "./env";
import { listModels } from "./model-list";
import { decryptSecret, encryptSecret, SecretUnreadable } from "./secrets";

export type ConnectionKind = "openai-compatible" | "anthropic";

export type ProviderConnection =
  | { id: string; userId: string; kind: "openai-compatible"; label: string; baseUrl: string; createdAt: Date }
  | { id: string; userId: string; kind: "anthropic"; label: string; createdAt: Date };

export type PublicConnection =
  | { id: string; kind: "openai-compatible"; label: string; baseUrl: string; createdAt: Date; keySet: true }
  | { id: string; kind: "anthropic"; label: string; createdAt: Date; keySet: true };

/** The decrypted secrets of one connection. The Redactor masks them in everything Orbit stores, streams, or logs. */
export type ConnectionSecrets = { apiKey: string; baseUrl?: string };

export type NewConnection =
  | { kind: "openai-compatible"; label: string; baseUrl: string; apiKey: string }
  | { kind: "anthropic"; label: string; apiKey: string };

export type ConnectionPatch = { label?: string; baseUrl?: string; apiKey?: string };

export type ModelDefaults = { connectionId: string | null; model: string | null; effort: Effort | null };

const connectionRow = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), userId: z.string(), kind: z.literal("openai-compatible"), label: z.string(), baseUrl: z.string(), createdAt: z.date() }),
  z.object({ id: z.string(), userId: z.string(), kind: z.literal("anthropic"), label: z.string(), baseUrl: z.null(), createdAt: z.date() }).transform(({ baseUrl: _none, ...connection }) => connection),
]);

const columns = {
  id: providerConnections.id,
  userId: providerConnections.userId,
  kind: providerConnections.kind,
  label: providerConnections.label,
  baseUrl: providerConnections.baseUrl,
  createdAt: providerConnections.createdAt,
};

const owned = (userId: string, id: string) => and(eq(providerConnections.userId, userId), eq(providerConnections.id, id));

export function listConnections(userId: string): ProviderConnection[] {
  const rows = getDb().select(columns).from(providerConnections).where(eq(providerConnections.userId, userId)).orderBy(providerConnections.createdAt).all();
  return rows.map((row) => connectionRow.parse(row));
}

export function getConnection(userId: string, id: string): ProviderConnection | null {
  const row = getDb().select(columns).from(providerConnections).where(owned(userId, id)).get();
  return row ? connectionRow.parse(row) : null;
}

/** The plain key, read at call time. Throws SecretUnreadable when this server's secret key cannot open it. */
export function connectionApiKey(userId: string, id: string): string {
  const row = getDb().select({ ciphertext: providerConnections.apiKeyCiphertext }).from(providerConnections).where(owned(userId, id)).get();
  if (!row) throw new SecretUnreadable();
  return decryptSecret(row.ciphertext);
}

function secretsOf(connection: ProviderConnection, apiKey: string): ConnectionSecrets {
  return { apiKey, baseUrl: connection.kind === "openai-compatible" ? connection.baseUrl : undefined };
}

function decryptableSecrets(connections: ProviderConnection[]): ConnectionSecrets[] {
  return connections.flatMap((connection) => {
    try {
      return [secretsOf(connection, connectionApiKey(connection.userId, connection.id))];
    } catch (error) {
      if (error instanceof SecretUnreadable) return [];
      throw error;
    }
  });
}

/** Every key and base URL of this user's connections that this server can decrypt, read per request. */
export function redactionSecrets(userId: string): ConnectionSecrets[] {
  return decryptableSecrets(listConnections(userId));
}

/** The same for every connection of the install, for the settings row, which no single user owns. */
export function installRedactionSecrets(): ConnectionSecrets[] {
  return decryptableSecrets(getDb().select(columns).from(providerConnections).all().map((row) => connectionRow.parse(row)));
}

export function toPublicConnection(connection: ProviderConnection, redact: Redactor): PublicConnection {
  if (connection.kind === "anthropic") return { id: connection.id, kind: connection.kind, label: redact.text(connection.label), createdAt: connection.createdAt, keySet: true };
  return { id: connection.id, kind: connection.kind, label: redact.text(connection.label), baseUrl: redactUrl(connection.baseUrl, redact), createdAt: connection.createdAt, keySet: true };
}

export function publicConnections(userId: string): PublicConnection[] {
  const redact = new Redactor(null, ...redactionSecrets(userId));
  return listConnections(userId).map((connection) => toPublicConnection(connection, redact));
}

export type ConnectionWrite =
  | { ok: true; connection: ProviderConnection }
  | { ok: false; reason: "not-found" | "unreachable" | "key-required" }
  | { ok: false; reason: "invalid"; error: string };

export async function addConnection(userId: string, input: NewConnection, redact: Redactor): Promise<ConnectionWrite> {
  const base = { id: randomUUID(), userId, label: input.label.trim(), createdAt: new Date() };
  const connection: ProviderConnection = input.kind === "anthropic" ? { ...base, kind: "anthropic" } : { ...base, kind: "openai-compatible", baseUrl: normalizeBaseUrl(input.baseUrl) };
  if (!(await listModels(connection, input.apiKey, redact))) return { ok: false, reason: "unreachable" };
  getDb()
    .insert(providerConnections)
    .values({ ...connection, baseUrl: connection.kind === "anthropic" ? null : connection.baseUrl, apiKeyCiphertext: encryptSecret(input.apiKey) })
    .run();
  return { ok: true, connection };
}

// A new base URL needs a new key, so the saved key never goes to another host. Resending the masked URL keeps both.
export async function updateConnection(userId: string, id: string, patch: ConnectionPatch, redact: Redactor): Promise<ConnectionWrite> {
  const current = getConnection(userId, id);
  if (!current) return { ok: false, reason: "not-found" };
  if (current.kind === "anthropic" && patch.baseUrl !== undefined) return { ok: false, reason: "invalid", error: "An Anthropic connection has no base URL." };
  const apiKey = patch.apiKey?.trim() || undefined;
  let next: ProviderConnection = { ...current, label: patch.label?.trim() || current.label };
  if (current.kind === "openai-compatible" && patch.baseUrl !== undefined) {
    const savedKey = connectionApiKeyOrEmpty(userId, id);
    const resolved = resolveMaskedUrl({
      submitted: patch.baseUrl,
      saved: current.baseUrl,
      redact: new Redactor(null, secretsOf(current, savedKey)),
      normalize: normalizeBaseUrl,
      fieldLabel: "Base URL",
    });
    if (!resolved.ok) return { ok: false, reason: "invalid", error: resolved.error };
    if (!resolved.url) return { ok: false, reason: "invalid", error: "Enter a base URL." };
    const moved = normalizeBaseUrl(resolved.url) !== normalizeBaseUrl(current.baseUrl);
    if (moved && !apiKey) return { ok: false, reason: "key-required" };
    next = { ...next, kind: "openai-compatible", baseUrl: moved ? normalizeBaseUrl(resolved.url) : current.baseUrl };
  }
  if (apiKey && !(await listModels(next, apiKey, redact))) return { ok: false, reason: "unreachable" };
  getDb()
    .update(providerConnections)
    .set({
      label: next.label,
      ...(next.kind === "openai-compatible" ? { baseUrl: next.baseUrl } : {}),
      ...(apiKey ? { apiKeyCiphertext: encryptSecret(apiKey) } : {}),
    })
    .where(owned(userId, id))
    .run();
  return { ok: true, connection: next };
}

function connectionApiKeyOrEmpty(userId: string, id: string) {
  try {
    return connectionApiKey(userId, id);
  } catch (error) {
    if (error instanceof SecretUnreadable) return "";
    throw error;
  }
}

// Old replies keep their model and effort: messages.connection_id goes null by its foreign key, and the rest stays.
export function deleteConnection(userId: string, id: string): boolean {
  const db = getDb();
  return db.transaction((tx) => {
    const found = tx.select({ id: providerConnections.id }).from(providerConnections).where(owned(userId, id)).get();
    if (!found) return false;
    tx.update(chats).set({ connectionId: null, model: null, reasoningEffort: null }).where(and(eq(chats.userId, userId), eq(chats.connectionId, id))).run();
    tx.update(userPreferences)
      .set({ defaultConnectionId: null, defaultModel: null, updatedAt: new Date() })
      .where(and(eq(userPreferences.userId, userId), eq(userPreferences.defaultConnectionId, id)))
      .run();
    tx.delete(providerConnections).where(owned(userId, id)).run();
    return true;
  });
}

export function hiddenModelIds(userId: string, connectionId: string): string[] {
  return getDb()
    .select({ modelId: hiddenModels.modelId })
    .from(hiddenModels)
    .where(and(eq(hiddenModels.userId, userId), eq(hiddenModels.connectionId, connectionId)))
    .orderBy(hiddenModels.modelId)
    .all()
    .map((row) => row.modelId);
}

export function setModelHidden(userId: string, connectionId: string, modelId: string, hidden: boolean) {
  const db = getDb();
  if (hidden) {
    db.insert(hiddenModels).values({ userId, connectionId, modelId }).onConflictDoNothing().run();
    return;
  }
  db.delete(hiddenModels).where(and(eq(hiddenModels.userId, userId), eq(hiddenModels.connectionId, connectionId), eq(hiddenModels.modelId, modelId))).run();
}

export function getModelDefaults(userId: string): ModelDefaults {
  const row = getDb()
    .select({ connectionId: userPreferences.defaultConnectionId, model: userPreferences.defaultModel, effort: userPreferences.defaultEffort })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .get();
  return { connectionId: row?.connectionId ?? null, model: row?.model || null, effort: isEffort(row?.effort) ? row.effort : null };
}

type Writer = Pick<ReturnType<typeof getDb>, "insert">;

function writeModelDefaults(db: Writer, userId: string, defaults: { connectionId: string; model: string | null; effort: Effort }) {
  const values = { defaultConnectionId: defaults.connectionId, defaultModel: defaults.model, defaultEffort: defaults.effort, updatedAt: new Date() };
  db.insert(userPreferences).values({ userId, ...values }).onConflictDoUpdate({ target: userPreferences.userId, set: values }).run();
}

export function saveModelDefaults(userId: string, defaults: { connectionId: string; model: string; effort: Effort }): boolean {
  if (!getConnection(userId, defaults.connectionId)) return false;
  writeModelDefaults(getDb(), userId, defaults);
  return true;
}

/**
 * Gives a user with no connection the provider this install was set up with: the pending row a pre-slice install
 * left, or else ORBIT_BASE_URL and ORBIT_API_KEY. Converges, so the signup hook and a later page load can both run it.
 */
export function seedConnection(userId: string) {
  getDb().transaction(
    (tx) => {
      if (tx.select({ id: providerConnections.id }).from(providerConnections).where(eq(providerConnections.userId, userId)).get()) return;
      const pending = tx.select().from(pendingConnection).where(eq(pendingConnection.id, 1)).get();
      const envBaseUrl = readEnv("ORBIT_BASE_URL");
      const envApiKey = readEnv("ORBIT_API_KEY");
      const source = pending
        ? { baseUrl: pending.baseUrl, ciphertext: pending.apiKeyCiphertext, model: pending.model, effort: isEffort(pending.effort) ? pending.effort : "medium" }
        : envBaseUrl && envApiKey
          ? { baseUrl: envBaseUrl, ciphertext: encryptSecret(envApiKey), model: readEnv("ORBIT_MODEL") ?? null, effort: "medium" as const }
          : null;
      if (!source) return;
      const id = randomUUID();
      tx.insert(providerConnections)
        .values({ id, userId, kind: "openai-compatible", label: urlHostLabel(source.baseUrl), baseUrl: source.baseUrl, apiKeyCiphertext: source.ciphertext, createdAt: new Date() })
        .run();
      writeModelDefaults(tx, userId, { connectionId: id, model: source.model, effort: source.effort });
      if (pending) tx.delete(pendingConnection).where(eq(pendingConnection.id, 1)).run();
    },
    { behavior: "immediate" },
  );
}
