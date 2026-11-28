import { eq } from "drizzle-orm";
import { getDb, type OrbitDb } from "../db";
import { LockTimeout, withMigrationLock } from "../db/migration-lock";
import { instanceSettings } from "../db/schema";
import { dataDirectory } from "../paths";
import type { UserId } from "../policy";
import { syncMessageArtifacts } from "./store";

export type BackfillResult = {
  skipped: boolean;
  scannedMessages: number;
  insertedRows: number;
  skippedCorrupt: number;
  durationMs: number;
};

const BATCH_SIZE = 200;
// The pass holds its own lock file, not the migration lock, so a process opening the database never waits for it.
export const BACKFILL_LOCK = ".artifacts-backfill.lock.db";
// A pass over tens of thousands of messages holds its lock for seconds. Another process booting meanwhile waits this
// long, then leaves the pass to the holder instead of failing its own start.
const LOCK_WAIT_MS = 5_000;

const skipped = (): BackfillResult => ({ skipped: true, scannedMessages: 0, insertedRows: 0, skippedCorrupt: 0, durationMs: 0 });

function stamped(db: OrbitDb) {
  const row = db.select({ at: instanceSettings.artifactsBackfilledAt }).from(instanceSettings).where(eq(instanceSettings.id, 1)).get();
  return row?.at != null;
}

type Candidate = { id: string; chatId: string; userId: string; createdAt: number };

function backfill(db: OrbitDb, batchSize: number): BackfillResult {
  const started = performance.now();
  // Every artifact block needs a backtick or tilde fence: an indented block has no language. Chats go one at a time,
  // oldest message first, so lineageFor sees each earlier version before its regenerations, edits, and follow-ups.
  const candidates = db.$client.prepare(`
    SELECT messages.id, messages.chat_id AS chatId, chats.user_id AS userId, messages.created_at AS createdAt
    FROM messages
    JOIN chats ON chats.id = messages.chat_id
    WHERE messages.role = 'assistant'
      AND (instr(messages.content, '\`\`\`') > 0 OR instr(messages.content, '~~~') > 0)
    ORDER BY chats.id ASC, messages.created_at ASC, messages.rowid ASC`).all() as Candidate[];
  const partsOf = db.$client.prepare("SELECT parts FROM messages WHERE id = ?").pluck();
  let insertedRows = 0;
  let skippedCorrupt = 0;
  for (let start = 0; start < candidates.length; start += batchSize) {
    db.transaction(() => {
      for (const message of candidates.slice(start, start + batchSize)) {
        let parts: unknown;
        try {
          parts = JSON.parse(partsOf.get(message.id) as string);
        } catch {
          skippedCorrupt++;
          continue;
        }
        const synced = syncMessageArtifacts(message.userId as UserId, message.chatId, message.id, parts, new Date(message.createdAt), db, { backfill: true });
        insertedRows += synced.inserted;
      }
    });
  }
  // Stamped only after the last batch commits, so a pass cut short runs again on the next boot.
  db.update(instanceSettings).set({ artifactsBackfilledAt: new Date() }).where(eq(instanceSettings.id, 1)).run();
  if (skippedCorrupt > 0) console.warn("[artifacts] backfill skipped messages whose parts are not JSON", { count: skippedCorrupt });
  return { skipped: false, scannedMessages: candidates.length, insertedRows, skippedCorrupt, durationMs: Math.round(performance.now() - started) };
}

/**
 * Indexes the artifacts of replies saved before the artifacts table existed. Runs once per install: after the stamp
 * in instance_settings is set, a boot reads no messages and takes no lock. A rerun after a crash converges, because
 * syncMessageArtifacts writes nothing for a message whose rows already match. A boot that cannot get the lock in time
 * skips the pass, and a later boot runs it if the holder did not.
 */
export function backfillArtifacts(options: { batchSize?: number; lockDir?: string; lockTimeoutMs?: number } = {}): BackfillResult {
  const db = getDb();
  if (stamped(db)) return skipped();
  try {
    return withMigrationLock(
      () => (stamped(db) ? skipped() : backfill(db, options.batchSize ?? BATCH_SIZE)),
      { dir: options.lockDir ?? dataDirectory(), name: BACKFILL_LOCK, timeoutMs: options.lockTimeoutMs ?? LOCK_WAIT_MS },
    );
  } catch (error) {
    if (!(error instanceof LockTimeout)) throw error;
    console.info("[artifacts] backfill left to the process that holds its lock");
    return skipped();
  }
}
