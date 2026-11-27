import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { saveModelDefaults } from "./connections";
import { getDb } from "./db";
import { providerConnections } from "./db/schema";
import type { Effort } from "./effort";
import type { UserId } from "./policy";
import { encryptSecret } from "./secrets";

/**
 * For tests: gives the user one OpenAI-compatible connection with this key and makes it the default, without listing
 * models first. A second call changes the same connection, so chats pinned to it keep resolving.
 */
export function seedTestConnection(userId: UserId, input: { baseUrl?: string; apiKey: string; model: string; effort?: Effort }) {
  const db = getDb();
  const values = { baseUrl: input.baseUrl ?? "http://127.0.0.1:9/v1", apiKeyCiphertext: encryptSecret(input.apiKey) };
  const existing = db.select({ id: providerConnections.id }).from(providerConnections).where(eq(providerConnections.userId, userId)).get();
  const id = existing?.id ?? randomUUID();
  if (existing) db.update(providerConnections).set(values).where(eq(providerConnections.id, id)).run();
  else db.insert(providerConnections).values({ id, userId, kind: "openai-compatible", label: "Test", ...values, createdAt: new Date() }).run();
  saveModelDefaults(userId, { connectionId: id, model: input.model, effort: input.effort ?? "medium" });
  return id;
}
