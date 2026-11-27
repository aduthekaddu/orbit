import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import { memories } from "../db/schema";
import type { UserId } from "../policy";
import { toMatchQuery, toOrMatchQuery } from "../search";

export const MEMORY_KINDS = ["fact", "preference", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type Memory = {
  id: string;
  kind: MemoryKind;
  text: string;
  source: (typeof memories.$inferSelect)["source"];
  sourceChatId: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  embedded: boolean;
};

type MemoryWrite = Pick<Memory, "text" | "kind" | "source">;
const sourceSchema = z.enum(memories.source.enumValues);

export type MemoryView = Memory & {
  sourceTitle: string | null;
};

export class MemoryRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRejected";
  }
}

type MemoryRow = {
  id: string;
  kind: string;
  text: string;
  source: unknown;
  sourceChatId: string | null;
  sourceMessageId: string | null;
  sourceTitle: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  embedded: number;
};

const memorySelect = `
  SELECT memories.id AS id,
         memories.kind AS kind,
         memories.text AS text,
         memories.source AS source,
         chats.id AS sourceChatId,
         (SELECT messages.id FROM messages JOIN chats AS source_chat ON source_chat.id = messages.chat_id
          WHERE messages.id = memories.source_message_id AND source_chat.user_id = memories.user_id) AS sourceMessageId,
         chats.title AS sourceTitle,
         memories.created_at AS createdAt,
         memories.last_used_at AS lastUsedAt,
         memories_vec.rowid IS NOT NULL AS embedded
  FROM memories
  LEFT JOIN chats ON chats.id = memories.source_chat_id AND chats.user_id = memories.user_id
  LEFT JOIN memories_vec ON memories_vec.rowid = memories.rowid AND memories_vec.user_id = memories.user_id
`;

function asKind(value: string): MemoryKind {
  if (value === "fact" || value === "preference" || value === "summary") return value;
  throw new MemoryRejected("Memory kind is invalid");
}

function toMemory(row: MemoryRow): MemoryView {
  return {
    id: row.id,
    kind: asKind(row.kind),
    text: row.text,
    source: sourceSchema.parse(row.source),
    sourceChatId: row.sourceChatId,
    sourceMessageId: row.sourceMessageId,
    sourceTitle: row.sourceTitle,
    createdAt: new Date(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
    embedded: row.embedded === 1,
  };
}

export function cleanMemoryText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new MemoryRejected("Memory text is empty");
  if (trimmed.length > 500) throw new MemoryRejected("Memory text is longer than 500 characters");
  return trimmed;
}

export function memoryCount(userId: UserId): number {
  return (getDb().$client.prepare("SELECT count(*) AS n FROM memories WHERE user_id = ?").get(userId) as { n: number }).n;
}

export function memoryJson(memory: MemoryView) {
  return {
    id: memory.id,
    kind: memory.kind,
    text: memory.text,
    sourceChatId: memory.sourceChatId,
    sourceMessageId: memory.sourceMessageId,
    sourceTitle: memory.sourceTitle,
    createdAt: memory.createdAt.toISOString(),
    lastUsedAt: memory.lastUsedAt ? memory.lastUsedAt.toISOString() : null,
    embedded: memory.embedded,
  };
}

export function getMemory(userId: UserId, id: string): MemoryView | null {
  const row = getDb().$client.prepare(`${memorySelect} WHERE memories.user_id = ? AND memories.id = ?`).get(userId, id) as MemoryRow | undefined;
  return row ? toMemory(row) : null;
}

export function listMemories(userId: UserId, query = ""): MemoryView[] {
  const trimmed = query.trim();
  const db = getDb();
  if (!trimmed) {
    return (db.$client.prepare(`${memorySelect} WHERE memories.user_id = ? ORDER BY memories.created_at DESC`).all(userId) as MemoryRow[]).map(toMemory);
  }
  const match = toMatchQuery(trimmed);
  if (!match) return [];
  try {
    return (
      db.$client
        .prepare(
          `${memorySelect}
           JOIN memories_fts ON memories.rowid = memories_fts.rowid
           WHERE memories.user_id = ? AND memories_fts MATCH ?
           ORDER BY bm25(memories_fts)
           LIMIT 50`,
        )
        .all(userId, match) as MemoryRow[]
    ).map(toMemory);
  } catch {
    return [];
  }
}

export function listUnembedded(userId: UserId): { rowid: number; text: string }[] {
  return getDb().$client
    .prepare(
      `SELECT memories.rowid AS rowid, memories.text AS text
       FROM memories
       LEFT JOIN memories_vec ON memories_vec.rowid = memories.rowid AND memories_vec.user_id = memories.user_id
       WHERE memories.user_id = ? AND memories_vec.rowid IS NULL
       ORDER BY memories.created_at ASC`,
    )
    .all(userId) as { rowid: number; text: string }[];
}

export function writeVectors(rows: { rowid: number; text: string; vector: number[] }[]) {
  const client = getDb().$client;
  const current = client.prepare("SELECT text, user_id AS userId FROM memories WHERE rowid = cast(? AS integer)");
  const remove = client.prepare("DELETE FROM memories_vec WHERE rowid = cast(? AS integer)");
  const insert = client.prepare("INSERT INTO memories_vec(rowid, user_id, embedding) VALUES (cast(? AS integer), ?, ?)");
  const run = client.transaction((items: { rowid: number; text: string; vector: number[] }[]) => {
    for (const item of items) {
      const row = current.get(item.rowid) as { text: string; userId: string } | undefined;
      if (!row || row.text !== item.text) continue;
      const blob = Buffer.from(new Float32Array(item.vector).buffer);
      remove.run(item.rowid);
      insert.run(item.rowid, row.userId, blob);
    }
  });
  run.immediate(rows);
}

export function textMatchIds(userId: UserId, query: string, limit = 20): string[] {
  const match = toOrMatchQuery(query.trim());
  if (!match) return [];
  try {
    const rows = getDb().$client
      .prepare(
        `SELECT memories.id AS id
         FROM memories_fts
         JOIN memories ON memories.rowid = memories_fts.rowid
         WHERE memories.user_id = ? AND memories_fts MATCH ?
         ORDER BY bm25(memories_fts)
         LIMIT ?`,
      )
      .all(userId, match, limit) as { id: string }[];
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}

// L2 distance between nomic vectors made with the task prefixes in embed.ts. 0.97 is cosine similarity 0.53.
// recall.ollama.test.ts pins the labeled pairs on both sides of it, so change both together.
export const MAX_VECTOR_DISTANCE = 0.97;

export function vectorMatchIds(userId: UserId, vector: number[], limit = 20): string[] {
  const blob = Buffer.from(new Float32Array(vector).buffer);
  const rows = getDb().$client
    .prepare(
      `SELECT memories.id AS id, distance
       FROM memories_vec
       JOIN memories ON memories.rowid = memories_vec.rowid AND memories.user_id = ?
       WHERE memories_vec.embedding MATCH ?
         AND k = ?
         AND memories_vec.user_id = ?
       ORDER BY distance`,
    )
    .all(userId, blob, limit, userId) as { id: string; distance: number }[];
  return rows.filter((row) => row.distance <= MAX_VECTOR_DISTANCE).map((row) => row.id);
}

export function markUsed(userId: UserId, ids: string[], at = new Date()) {
  if (ids.length === 0) return;
  const client = getDb().$client;
  const update = client.prepare("UPDATE memories SET last_used_at = ? WHERE user_id = ? AND id = ?");
  const run = client.transaction((memoryIds: string[]) => {
    for (const id of memoryIds) update.run(at.getTime(), userId, id);
  });
  run(ids);
}

export function saveMemory(userId: UserId, input: MemoryWrite & {
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
}): MemoryView {
  const text = cleanMemoryText(input.text);
  const kind = asKind(input.kind);
  const textNorm = text.toLowerCase();
  const db = getDb();
  const sameText = and(eq(memories.userId, userId), eq(memories.textNorm, textNorm));
  const existing = db.select({ id: memories.id }).from(memories).where(sameText).get();
  if (existing) {
    const memory = getMemory(userId, existing.id);
    if (!memory) throw new MemoryRejected("Memory text is empty");
    return memory;
  }
  const id = crypto.randomUUID();
  try {
    db.insert(memories)
      .values({
        id,
        userId,
        kind,
        text,
        textNorm,
        source: input.source,
        sourceChatId: input.sourceChatId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        createdAt: new Date(),
        lastUsedAt: null,
      })
      .run();
  } catch (error) {
    const again = db.select({ id: memories.id }).from(memories).where(sameText).get();
    if (!again) throw error;
    const memory = getMemory(userId, again.id);
    if (!memory) throw error;
    return memory;
  }
  const memory = getMemory(userId, id);
  if (!memory) throw new MemoryRejected("Memory text is empty");
  return memory;
}

export function updateMemory(userId: UserId, id: string, input: MemoryWrite): MemoryView | null {
  const text = cleanMemoryText(input.text);
  const kind = asKind(input.kind);
  const textNorm = text.toLowerCase();
  const db = getDb();
  return db.$client.transaction(() => {
    const current = db.$client.prepare("SELECT rowid AS rowid, text FROM memories WHERE user_id = ? AND id = ?")
      .get(userId, id) as { rowid: number; text: string } | undefined;
    if (!current) return null;
    const other = db.$client.prepare("SELECT id FROM memories WHERE user_id = ? AND text_norm = ? AND id <> ?")
      .get(userId, textNorm, id);
    if (other) throw new MemoryRejected("A memory with that text already exists");
    if (current.text !== text) db.$client.prepare("DELETE FROM memories_vec WHERE rowid = cast(? AS integer)").run(current.rowid);
    db.update(memories)
      .set({
        text,
        textNorm,
        kind,
        source: sql`CASE WHEN ${memories.textNorm} = ${textNorm} THEN ${memories.source} ELSE ${input.source} END`,
      })
      .where(and(eq(memories.userId, userId), eq(memories.id, id)))
      .run();
    return getMemory(userId, id);
  }).immediate();
}

export function deleteMemory(userId: UserId, id: string): boolean {
  return getDb().delete(memories).where(and(eq(memories.userId, userId), eq(memories.id, id))).run().changes > 0;
}
