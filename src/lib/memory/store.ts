import { eq } from "drizzle-orm";
import { db } from "../db";
import { memories } from "../db/schema";
import { toMatchQuery, toOrMatchQuery } from "../search";

export const MEMORY_KINDS = ["fact", "preference", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type Memory = {
  id: string;
  kind: MemoryKind;
  text: string;
  sourceChatId: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  embedded: boolean;
};

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
         memories.source_chat_id AS sourceChatId,
         memories.source_message_id AS sourceMessageId,
         chats.title AS sourceTitle,
         memories.created_at AS createdAt,
         memories.last_used_at AS lastUsedAt,
         memories_vec.rowid IS NOT NULL AS embedded
  FROM memories
  LEFT JOIN chats ON chats.id = memories.source_chat_id
  LEFT JOIN memories_vec ON memories_vec.rowid = memories.rowid
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

export function memoryCount(): number {
  return (db.$client.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n;
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

export function getMemory(id: string): MemoryView | null {
  const row = db.$client.prepare(`${memorySelect} WHERE memories.id = ?`).get(id) as MemoryRow | undefined;
  return row ? toMemory(row) : null;
}

export function listMemories(query = ""): MemoryView[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return (db.$client.prepare(`${memorySelect} ORDER BY memories.created_at DESC`).all() as MemoryRow[]).map(toMemory);
  }
  const match = toMatchQuery(trimmed);
  if (!match) return [];
  try {
    return (
      db.$client
        .prepare(
          `${memorySelect}
           JOIN memories_fts ON memories.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY bm25(memories_fts)
           LIMIT 50`,
        )
        .all(match) as MemoryRow[]
    ).map(toMemory);
  } catch {
    return [];
  }
}

export function listUnembedded(): { rowid: number; text: string }[] {
  return db.$client
    .prepare(
      `SELECT memories.rowid AS rowid, memories.text AS text
       FROM memories
       LEFT JOIN memories_vec ON memories_vec.rowid = memories.rowid
       WHERE memories_vec.rowid IS NULL
       ORDER BY memories.created_at ASC`,
    )
    .all() as { rowid: number; text: string }[];
}

export function writeVectors(rows: { rowid: number; text: string; vector: number[] }[]) {
  const current = db.$client.prepare("SELECT text AS text FROM memories WHERE rowid = cast(? AS integer)");
  const remove = db.$client.prepare("DELETE FROM memories_vec WHERE rowid = cast(? AS integer)");
  const insert = db.$client.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (cast(? AS integer), ?)");
  const run = db.$client.transaction((items: { rowid: number; text: string; vector: number[] }[]) => {
    for (const item of items) {
      const row = current.get(item.rowid) as { text: string } | undefined;
      if (!row || row.text !== item.text) continue;
      const blob = Buffer.from(new Float32Array(item.vector).buffer);
      remove.run(item.rowid);
      insert.run(item.rowid, blob);
    }
  });
  run(rows);
}

export function textMatchIds(query: string, limit = 20): string[] {
  const match = toOrMatchQuery(query.trim());
  if (!match) return [];
  try {
    const rows = db.$client
      .prepare(
        `SELECT memories.id AS id
         FROM memories_fts
         JOIN memories ON memories.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY bm25(memories_fts)
         LIMIT ?`,
      )
      .all(match, limit) as { id: string }[];
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}

export const MAX_VECTOR_DISTANCE = 1;

export function vectorMatchIds(vector: number[], limit = 20): string[] {
  const blob = Buffer.from(new Float32Array(vector).buffer);
  const rows = db.$client
    .prepare(
      `SELECT memories.id AS id, distance
       FROM memories_vec
       JOIN memories ON memories.rowid = memories_vec.rowid
       WHERE memories_vec.embedding MATCH ?
         AND k = ?
       ORDER BY distance`,
    )
    .all(blob, limit) as { id: string; distance: number }[];
  return rows.filter((row) => row.distance <= MAX_VECTOR_DISTANCE).map((row) => row.id);
}

export function markUsed(ids: string[], at = new Date()) {
  if (ids.length === 0) return;
  const update = db.$client.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?");
  const run = db.$client.transaction((memoryIds: string[]) => {
    for (const id of memoryIds) update.run(at.getTime(), id);
  });
  run(ids);
}

export function saveMemory(input: {
  text: string;
  kind: MemoryKind;
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
}): MemoryView {
  const text = cleanMemoryText(input.text);
  const kind = asKind(input.kind);
  const textNorm = text.toLowerCase();
  const existing = db.select({ id: memories.id }).from(memories).where(eq(memories.textNorm, textNorm)).get();
  if (existing) {
    const memory = getMemory(existing.id);
    if (!memory) throw new MemoryRejected("Memory text is empty");
    return memory;
  }
  const id = crypto.randomUUID();
  try {
    db.insert(memories)
      .values({
        id,
        kind,
        text,
        textNorm,
        sourceChatId: input.sourceChatId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        createdAt: new Date(),
        lastUsedAt: null,
      })
      .run();
  } catch (error) {
    const again = db.select({ id: memories.id }).from(memories).where(eq(memories.textNorm, textNorm)).get();
    if (!again) throw error;
    const memory = getMemory(again.id);
    if (!memory) throw error;
    return memory;
  }
  const memory = getMemory(id);
  if (!memory) throw new MemoryRejected("Memory text is empty");
  return memory;
}

export function updateMemory(id: string, input: { text: string; kind: MemoryKind }): MemoryView | null {
  const text = cleanMemoryText(input.text);
  const kind = asKind(input.kind);
  const textNorm = text.toLowerCase();
  const current = db.$client.prepare("SELECT rowid AS rowid, text AS text FROM memories WHERE id = ?").get(id) as
    | { rowid: number; text: string }
    | undefined;
  if (!current) return null;
  const other = db.$client.prepare("SELECT id FROM memories WHERE text_norm = ? AND id <> ?").get(textNorm, id) as { id: string } | undefined;
  if (other) throw new MemoryRejected("A memory with that text already exists");
  const clear = db.$client.prepare("DELETE FROM memories_vec WHERE rowid = cast(? AS integer)");
  const run = db.$client.transaction(() => {
    if (current.text !== text) clear.run(current.rowid);
    db.update(memories).set({ text, textNorm, kind }).where(eq(memories.id, id)).run();
  });
  run();
  return getMemory(id);
}

export function deleteMemory(id: string): boolean {
  const located = db.$client.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get(id) as { rowid: number } | undefined;
  if (!located) return false;
  const clear = db.$client.prepare("DELETE FROM memories_vec WHERE rowid = cast(? AS integer)");
  const run = db.$client.transaction(() => {
    clear.run(located.rowid);
    db.delete(memories).where(eq(memories.id, id)).run();
  });
  run();
  return true;
}
