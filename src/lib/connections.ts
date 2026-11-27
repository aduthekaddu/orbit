import { randomUUID } from "node:crypto";
import { and, eq, exists, isNull } from "drizzle-orm";
import { z } from "zod";
import { normalizeBaseUrl } from "./base-url";
import { redactUrl, resolveMaskedUrl, type Redactor } from "./chat-errors";
import { getDb, urlHostLabel } from "./db";
import { chats, hiddenModels, pendingConnection, providerConnections, user, userPreferences } from "./db/schema";
import { DEFAULT_EFFORT, isEffort, type Effort } from "./effort";
import { readEnv } from "./env";
import { clearModelCaps, listModels, rememberModelCaps } from "./model-list";
import { getInstance } from "./instance-settings";
import { policyFor, type Viewer } from "./policy";
import { decryptSecret, encryptSecret, SecretUnreadable } from "./secrets";

export type ConnectionKind = "openai-compatible" | "anthropic";

export type ProviderConnection =
  | { id: string; userId: string; kind: "openai-compatible"; label: string; baseUrl: string; createdAt: Date }
  | { id: string; userId: string; kind: "anthropic"; label: string; createdAt: Date };

// keyReadable is false when this server's secret key cannot open the saved key, so Settings can say which one to re-enter.
export type PublicConnection =
  | { id: string; kind: "openai-compatible"; label: string; baseUrl: string; createdAt: Date; keySet: true; keyReadable: boolean }
  | { id: string; kind: "anthropic"; label: string; createdAt: Date; keySet: true; keyReadable: boolean };

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

const credentialColumns = { ...columns, ciphertext: providerConnections.apiKeyCiphertext };

function getConnectionRecord(userId: string, id: string) {
  return getDb().select(credentialColumns).from(providerConnections).where(owned(userId, id)).get();
}

export function getConnection(userId: string, id: string): ProviderConnection | null {
  const row = getConnectionRecord(userId, id);
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

function keyOrEmpty(ciphertext: string) {
  try {
    return decryptSecret(ciphertext);
  } catch (error) {
    if (error instanceof SecretUnreadable) return "";
    throw error;
  }
}

/** Every readable key and every saved base URL of this user's connections, read per request. */
export function redactionSecrets(userId: string): ConnectionSecrets[] {
  const rows = getDb().select(credentialColumns).from(providerConnections).where(eq(providerConnections.userId, userId)).all();
  return rows.map((row) => secretsOf(connectionRow.parse(row), keyOrEmpty(row.ciphertext)));
}

export type RequestedConnection = { from: "request" | "stored"; id: string } | null;

export function pickableConnectionOwner(viewer: Viewer) {
  return policyFor(getInstance().hostingMode).connectionOwner(viewer);
}

export function pickableConnection(viewer: Viewer, requested: RequestedConnection): ProviderConnection | null {
  const ownerId = pickableConnectionOwner(viewer);
  if (requested) {
    const connection = getConnection(ownerId, requested.id);
    if (connection || requested.from === "request") return connection;
  }
  const defaults = getModelDefaults(viewer.id);
  const preferred = defaults.connectionId ? getConnection(ownerId, defaults.connectionId) : null;
  return preferred ?? listConnections(ownerId)[0] ?? null;
}

export function toPublicConnection(connection: ProviderConnection, redact: Redactor): PublicConnection {
  const saved = getConnectionRecord(connection.userId, connection.id);
  const shared = { id: connection.id, label: redact.text(connection.label), createdAt: connection.createdAt, keySet: true, keyReadable: !!saved && keyOrEmpty(saved.ciphertext) !== "" } as const;
  if (connection.kind === "anthropic") return { ...shared, kind: connection.kind };
  return { ...shared, kind: connection.kind, baseUrl: redactUrl(connection.baseUrl, redact) };
}

export type ConnectionWrite =
  | { ok: true; connection: ProviderConnection }
  | { ok: false; reason: "not-found" | "unreachable" | "key-required" | "conflict" }
  | { ok: false; reason: "invalid"; error: string };

const LABEL_HOLDS_CREDENTIAL = { ok: false, reason: "invalid", error: "Remove credentials from the label." } as const;
type RequestRedactor = (userId: string) => Redactor;

export async function addConnection(userId: string, input: NewConnection, redactFor: RequestRedactor): Promise<ConnectionWrite> {
  const base = { id: randomUUID(), userId, label: input.label.trim(), createdAt: new Date() };
  const connection: ProviderConnection = input.kind === "anthropic" ? { ...base, kind: "anthropic" } : { ...base, kind: "openai-compatible", baseUrl: normalizeBaseUrl(input.baseUrl) };
  const secrets = secretsOf(connection, input.apiKey);
  const redact = redactFor(userId);
  // Labels are stored in plain text. Check again after listing models, when settings or other connections may have changed.
  if (redact.withCredentials(secrets).text(connection.label) !== connection.label) return LABEL_HOLDS_CREDENTIAL;
  const models = await listModels(connection, input.apiKey, redact, { cache: false });
  if (!models) return { ok: false, reason: "unreachable" };
  if (redactFor(userId).withCredentials(secrets).text(connection.label) !== connection.label) return LABEL_HOLDS_CREDENTIAL;
  getDb().transaction((tx) => {
    tx.insert(providerConnections)
      .values({ ...connection, baseUrl: connection.kind === "anthropic" ? null : connection.baseUrl, apiKeyCiphertext: encryptSecret(input.apiKey) })
      .run();
    completeConnectionSetup(tx, userId);
  });
  rememberModelCaps(connection.id, models);
  return { ok: true, connection };
}

// A new base URL needs a new key, so the saved key never goes to another host. Resending the masked URL keeps both.
export async function updateConnection(userId: string, id: string, patch: ConnectionPatch, redactFor: RequestRedactor): Promise<ConnectionWrite> {
  const record = getConnectionRecord(userId, id);
  if (!record) return { ok: false, reason: "not-found" };
  const current = connectionRow.parse(record);
  const redact = redactFor(userId);
  if (current.kind === "anthropic" && patch.baseUrl !== undefined) return { ok: false, reason: "invalid", error: "An Anthropic connection has no base URL." };
  const apiKey = patch.apiKey?.trim() || undefined;
  let next: ProviderConnection = { ...current, label: patch.label?.trim() || current.label };
  if (current.kind === "openai-compatible" && patch.baseUrl !== undefined) {
    const resolved = resolveMaskedUrl({
      submitted: patch.baseUrl,
      saved: current.baseUrl,
      redact,
      normalize: normalizeBaseUrl,
      fieldLabel: "Base URL",
    });
    if (!resolved.ok) return { ok: false, reason: "invalid", error: resolved.error };
    if (!resolved.url) return { ok: false, reason: "invalid", error: "Enter a base URL." };
    const moved = normalizeBaseUrl(resolved.url) !== normalizeBaseUrl(current.baseUrl);
    if (moved && !apiKey) return { ok: false, reason: "key-required" };
    next = { ...next, kind: "openai-compatible", baseUrl: moved ? normalizeBaseUrl(resolved.url) : current.baseUrl };
  }
  const nextSecrets = secretsOf(next, apiKey ?? "");
  if (redact.withCredentials(nextSecrets).text(next.label) !== next.label) return LABEL_HOLDS_CREDENTIAL;
  const models = apiKey ? await listModels(next, apiKey, redact, { cache: false }) : null;
  if (apiKey) {
    if (!getConnection(userId, id)) return { ok: false, reason: "not-found" };
    if (!models) return { ok: false, reason: "unreachable" };
    if (redactFor(userId).withCredentials(nextSecrets).text(next.label) !== next.label) return LABEL_HOLDS_CREDENTIAL;
  }
  const { changes } = getDb()
    .update(providerConnections)
    .set({
      label: next.label,
      ...(next.kind === "openai-compatible" ? { baseUrl: next.baseUrl } : {}),
      ...(apiKey ? { apiKeyCiphertext: encryptSecret(apiKey) } : {}),
    })
    .where(and(
      owned(userId, id),
      eq(providerConnections.label, record.label),
      eq(providerConnections.apiKeyCiphertext, record.ciphertext),
      record.baseUrl === null ? isNull(providerConnections.baseUrl) : eq(providerConnections.baseUrl, record.baseUrl),
    ))
    .run();
  if (changes === 0) return { ok: false, reason: getConnection(userId, id) ? "conflict" : "not-found" };
  if (models) rememberModelCaps(id, models);
  return { ok: true, connection: next };
}

// Old replies keep their model and effort: messages.connection_id goes null by its foreign key, and the rest stays.
export function deleteConnection(userId: string, id: string): boolean {
  const db = getDb();
  const deleted = db.transaction((tx) => {
    const found = tx.select({ id: providerConnections.id }).from(providerConnections).where(owned(userId, id)).get();
    if (!found) return false;
    tx.update(chats).set({ connectionId: null, model: null, reasoningEffort: null }).where(and(eq(chats.userId, userId), eq(chats.connectionId, id))).run();
    tx.update(userPreferences)
      .set({ defaultConnectionId: null, defaultModel: null, updatedAt: new Date() })
      .where(and(eq(userPreferences.userId, userId), eq(userPreferences.defaultConnectionId, id)))
      .run();
    tx.delete(providerConnections).where(owned(userId, id)).run();
    completeConnectionSetup(tx, userId);
    return true;
  });
  if (deleted) clearModelCaps(id);
  return deleted;
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

/** False, with nothing written, when this user has no such connection. */
export function setModelHidden(userId: string, connectionId: string, modelId: string, hidden: boolean): boolean {
  return getDb().transaction((tx) => {
    if (!tx.select({ id: providerConnections.id }).from(providerConnections).where(owned(userId, connectionId)).get()) return false;
    if (hidden) tx.insert(hiddenModels).values({ userId, connectionId, modelId }).onConflictDoNothing().run();
    else tx.delete(hiddenModels).where(and(eq(hiddenModels.userId, userId), eq(hiddenModels.connectionId, connectionId), eq(hiddenModels.modelId, modelId))).run();
    return true;
  });
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

function completeConnectionSetup(db: Pick<ReturnType<typeof getDb>, "insert" | "delete" | "select">, userId: string) {
  db.insert(userPreferences)
    .values({ userId, providerSetupComplete: true, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { providerSetupComplete: true } })
    .run();
  const admin = db.select({ id: user.id }).from(user).where(and(eq(user.id, userId), eq(user.role, "admin")));
  db.delete(pendingConnection).where(and(eq(pendingConnection.id, 1), exists(admin))).run();
}

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
 * Adopt the pending provider or the environment once. A failed write leaves setup open for another attempt.
 * A manual connection also completes setup, so its later deletion cannot restore a previous provider.
 */
export function seedConnection(viewer: Viewer) {
  if (viewer.role !== "admin") return;
  const userId = viewer.id;
  getDb().transaction(
    (tx) => {
      const preferences = tx.select({ complete: userPreferences.providerSetupComplete }).from(userPreferences).where(eq(userPreferences.userId, userId)).get();
      if (preferences?.complete) return;
      if (tx.select({ id: providerConnections.id }).from(providerConnections).where(eq(providerConnections.userId, userId)).get()) {
        completeConnectionSetup(tx, userId);
        return;
      }
      const pending = tx.select().from(pendingConnection).where(eq(pendingConnection.id, 1)).get();
      const envBaseUrl = readEnv("ORBIT_BASE_URL");
      const envApiKey = readEnv("ORBIT_API_KEY");
      const source = pending
        ? { baseUrl: pending.baseUrl, ciphertext: pending.apiKeyCiphertext, model: pending.model, effort: isEffort(pending.effort) ? pending.effort : DEFAULT_EFFORT }
        : envBaseUrl && envApiKey
          ? { baseUrl: envBaseUrl, ciphertext: encryptSecret(envApiKey), model: readEnv("ORBIT_MODEL") ?? null, effort: DEFAULT_EFFORT }
          : null;
      if (source) {
        const id = randomUUID();
        tx.insert(providerConnections)
          .values({ id, userId, kind: "openai-compatible", label: urlHostLabel(source.baseUrl), baseUrl: source.baseUrl, apiKeyCiphertext: source.ciphertext, createdAt: new Date() })
          .run();
        writeModelDefaults(tx, userId, { connectionId: id, model: source.model, effort: source.effort });
      }
      completeConnectionSetup(tx, userId);
    },
    { behavior: "immediate" },
  );
}

export function trySeedConnection(viewer: Viewer) {
  if (viewer.role !== "admin") return;
  try {
    seedConnection(viewer);
  } catch {
    // Database errors can include provider URLs or statement parameters.
    console.error("connection seed failed");
  }
}
