import { and, asc, eq } from "drizzle-orm";
import type { Redactor } from "../chat-errors";
import { getDb, type OrbitDb } from "../db";
import { artifacts, chats, messages } from "../db/schema";
import type { UserId } from "../policy";
import { toMatchQuery } from "../search";
import { artifactKey, type ArtifactKind, type ArtifactLanguage } from "./detect";
import { extractArtifacts, type ExtractedArtifact } from "./extract";
import { lineageFor, type ExistingArtifact, type MessageNode } from "./lineage";
import { capTitle, shownTitle } from "./title";

export type ArtifactVersionSummary = {
  id: string;
  /** 1-based rank in the lineage by (createdAt ASC, seq ASC). */
  number: number;
  messageId: string;
  key: string;
  language: ArtifactLanguage;
  derivedTitle: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredChatArtifact = {
  id: string;
  key: string;
  title: string;
  derivedTitle: string;
  userTitle: string | null;
  lineageId: string;
  number: number;
  versions: ArtifactVersionSummary[];
};

export type ArtifactListItem = {
  /** The lineage's newest version. */
  id: string;
  lineageId: string;
  kind: ArtifactKind;
  language: ArtifactLanguage;
  title: string;
  derivedTitle: string;
  userTitle: string | null;
  chatId: string;
  chatTitle: string;
  messageId: string;
  key: string;
  versionCount: number;
  createdAt: string;
  /** The newest updatedAt across the lineage. */
  updatedAt: string;
};

export type ArtifactDetail = {
  id: string;
  chatId: string;
  chatTitle: string;
  messageId: string;
  textOrdinal: number;
  blockIndex: number;
  key: string;
  kind: ArtifactKind;
  language: ArtifactLanguage;
  code: string;
  title: string;
  derivedTitle: string;
  userTitle: string | null;
  lineageId: string;
  number: number;
  createdAt: string;
  updatedAt: string;
  versions: ArtifactVersionSummary[];
};

export type ArtifactPage = { items: ArtifactListItem[]; nextCursor: string | null };

export type ArtifactQuery = { q?: string; kind?: ArtifactKind; cursor?: string; limit?: number };

export type RenamedArtifact = { id: string; lineageId: string; userTitle: string | null; title: string };

type ArtifactRow = typeof artifacts.$inferSelect;

const PAGE_SIZE = 50;
// Shifted rows pass through block indexes this high, so two rows never hold one slot.
const TEMP_BLOCK_INDEX = 1_000_000;

const rowKey = (row: Pick<ArtifactRow, "messageId" | "textOrdinal" | "blockIndex">) => artifactKey(row.messageId, row.textOrdinal, row.blockIndex);

function messageTree(db: OrbitDb, chatId: string): MessageNode[] {
  return db.select({ id: messages.id, parentId: messages.parentId, role: messages.role, createdAt: messages.createdAt })
    .from(messages).where(eq(messages.chatId, chatId)).all()
    .map((row) => ({ ...row, role: row.role === "user" || row.role === "assistant" ? row.role : "system", createdAt: row.createdAt.getTime() }));
}

/** The chat's rows, each with its position among the artifacts of its own message. */
function chatArtifacts(db: OrbitDb, userId: UserId, chatId: string): ExistingArtifact[] {
  const rows = db.select().from(artifacts).where(and(eq(artifacts.userId, userId), eq(artifacts.chatId, chatId)))
    .orderBy(asc(artifacts.messageId), asc(artifacts.textOrdinal), asc(artifacts.blockIndex)).all();
  const positions = new Map<string, number>();
  return rows.map((row) => {
    const artifactPosition = positions.get(row.messageId) ?? 0;
    positions.set(row.messageId, artifactPosition + 1);
    return { ...row, artifactPosition, createdAt: row.createdAt.getTime() };
  });
}

/**
 * Makes a message's artifact rows match its parts. Callers pass the parts as saved, after redaction. Unchanged blocks
 * keep their row even when they moved, edited blocks keep the row in their slot, rows of removed blocks go, and new
 * blocks get rows that join a lineage through lineageFor. Running it again with the same parts writes nothing.
 */
export function syncMessageArtifacts(
  userId: UserId,
  chatId: string,
  messageId: string,
  parts: unknown,
  messageCreatedAt: Date,
  db: OrbitDb = getDb(),
  options: { backfill?: boolean } = {},
): { inserted: number } {
  const blocks = extractArtifacts(parts);
  return db.transaction(() => {
    const stored = db.select().from(artifacts).where(and(eq(artifacts.userId, userId), eq(artifacts.messageId, messageId))).all();
    if (blocks.length === 0 && stored.length === 0) return { inserted: 0 };
    const now = new Date();
    const unpaired = new Set(stored);
    const pairs = new Map<ExtractedArtifact, ArtifactRow>();
    const inSlot = (block: ExtractedArtifact, row: ArtifactRow) => row.textOrdinal === block.textOrdinal && row.blockIndex === block.blockIndex;
    const pair = (match: (block: ExtractedArtifact, row: ArtifactRow) => boolean) => {
      for (const block of blocks) {
        if (pairs.has(block)) continue;
        const row = [...unpaired].find((candidate) => candidate.kind === block.kind && match(block, candidate));
        if (!row) continue;
        pairs.set(block, row);
        unpaired.delete(row);
      }
    };
    // Same code first, in its own slot and then anywhere, so a block that survives an edit keeps its own row.
    pair((block, row) => row.code === block.code && inSlot(block, row));
    pair((block, row) => row.code === block.code);
    pair(inSlot);

    for (const row of unpaired) db.delete(artifacts).where(eq(artifacts.seq, row.seq)).run();
    const shifted = [...pairs].filter(([block, row]) => !inSlot(block, row));
    shifted.forEach(([, row], i) => db.update(artifacts).set({ blockIndex: TEMP_BLOCK_INDEX + i }).where(eq(artifacts.seq, row.seq)).run());
    for (const [block, row] of pairs) {
      const edited = row.language !== block.language || row.code !== block.code || row.derivedTitle !== block.derivedTitle;
      if (!edited && inSlot(block, row)) continue;
      db.update(artifacts).set({
        textOrdinal: block.textOrdinal,
        blockIndex: block.blockIndex,
        ...(edited ? { language: block.language, code: block.code, derivedTitle: block.derivedTitle, updatedAt: now } : {}),
      }).where(eq(artifacts.seq, row.seq)).run();
    }
    for (const row of unpaired) {
      if (row.id !== row.lineageId) continue;
      const next = db.select({ id: artifacts.id }).from(artifacts)
        .where(and(eq(artifacts.userId, userId), eq(artifacts.lineageId, row.lineageId)))
        .orderBy(asc(artifacts.createdAt), asc(artifacts.seq)).limit(1).get();
      if (next) db.update(artifacts).set({ lineageId: next.id }).where(and(eq(artifacts.userId, userId), eq(artifacts.lineageId, row.lineageId))).run();
    }

    const added = blocks.filter((block) => !pairs.has(block));
    if (added.length === 0) return { inserted: 0 };
    const tree = messageTree(db, chatId);
    const earlier = chatArtifacts(db, userId, chatId);
    // The lineages this message already holds, so two of its blocks never share one.
    const claimed = new Set(earlier.filter((row) => row.messageId === messageId).map((row) => row.lineageId));
    for (const block of added) {
      const match = lineageFor({ ...block, messageId }, tree, earlier, claimed);
      const id = crypto.randomUUID();
      const lineageId = match.kind === "join" ? match.lineageId : id;
      db.insert(artifacts).values({
        id, userId, chatId, messageId,
        textOrdinal: block.textOrdinal, blockIndex: block.blockIndex, kind: block.kind, language: block.language,
        code: block.code, derivedTitle: block.derivedTitle, userTitle: match.kind === "join" ? match.userTitle : null,
        lineageId, createdAt: messageCreatedAt, updatedAt: options.backfill ? messageCreatedAt : now,
      }).run();
      claimed.add(lineageId);
    }
    return { inserted: added.length };
  });
}

type VersionRow = Pick<ArtifactRow, "id" | "messageId" | "textOrdinal" | "blockIndex" | "language" | "derivedTitle" | "createdAt" | "updatedAt">;

function versionsOf(rows: readonly VersionRow[]): ArtifactVersionSummary[] {
  return rows.map((row, i) => ({
    id: row.id, number: i + 1, messageId: row.messageId, key: rowKey(row), language: row.language,
    derivedTitle: row.derivedTitle, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  }));
}

function lineageVersions(userId: UserId, lineageId: string): ArtifactVersionSummary[] {
  return versionsOf(getDb().select().from(artifacts).where(and(eq(artifacts.userId, userId), eq(artifacts.lineageId, lineageId)))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.seq)).all());
}

type ListRow = {
  id: string; lineageId: string; kind: ArtifactKind; language: ArtifactLanguage; derivedTitle: string; userTitle: string | null;
  chatId: string; chatTitle: string; messageId: string; textOrdinal: number; blockIndex: number; versionCount: number;
  createdAt: number; updatedAt: number; seq: number;
};

/**
 * The user's lineages, one row each showing its newest version, ordered by the newest change in the lineage. A search
 * returns up to one page of lineages with a version that matches, in the same order, since FTS5 ranks with statistics
 * from every account's rows. Without a search, `nextCursor` reads the next page.
 */
export function listArtifacts(userId: UserId, { q = "", kind, cursor, limit = PAGE_SIZE }: ArtifactQuery = {}): ArtifactPage {
  const match = toMatchQuery(q);
  const [before, beforeSeq] = !match && cursor ? cursor.split(":").map(Number) : [null, null];
  const rows = getDb().$client.prepare(`
    WITH lineages AS (
      SELECT lineage_id, max(updated_at) AS last_updated, count(*) AS version_count
      FROM artifacts WHERE user_id = @userId GROUP BY lineage_id
    ), newest AS (
      SELECT *, row_number() OVER (PARTITION BY lineage_id ORDER BY created_at DESC, seq DESC) AS place
      FROM artifacts WHERE user_id = @userId
    )
    SELECT newest.id, newest.lineage_id AS lineageId, newest.kind, newest.language, newest.derived_title AS derivedTitle,
           newest.user_title AS userTitle, newest.chat_id AS chatId, chats.title AS chatTitle, newest.message_id AS messageId,
           newest.text_ordinal AS textOrdinal, newest.block_index AS blockIndex, lineages.version_count AS versionCount,
           newest.created_at AS createdAt, lineages.last_updated AS updatedAt, newest.seq
    FROM newest
    JOIN lineages ON lineages.lineage_id = newest.lineage_id
    JOIN chats ON chats.id = newest.chat_id
    WHERE newest.place = 1
      AND (@kind IS NULL OR newest.kind = @kind)
      AND (@before IS NULL OR lineages.last_updated < @before OR (lineages.last_updated = @before AND newest.seq < @beforeSeq))
      ${match ? `AND newest.lineage_id IN (
        SELECT artifacts.lineage_id FROM artifacts_fts JOIN artifacts ON artifacts.seq = artifacts_fts.rowid
        WHERE artifacts_fts MATCH @match AND artifacts.user_id = @userId
      )` : ""}
    ORDER BY lineages.last_updated DESC, newest.seq DESC
    LIMIT @take`).all({
    userId, kind: kind ?? null, before, beforeSeq, take: match ? limit : limit + 1, ...(match ? { match } : {}),
  }) as ListRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ seq: _seq, textOrdinal, blockIndex, createdAt, updatedAt, ...row }) => ({
      ...row,
      title: shownTitle(row),
      key: artifactKey(row.messageId, textOrdinal, blockIndex),
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
    })),
    nextCursor: rows.length > limit && last ? `${last.updatedAt}:${last.seq}` : null,
  };
}

/** One of the user's artifacts with its code and every version in its lineage, or null when it is not theirs. */
export function getArtifact(userId: UserId, id: string): ArtifactDetail | null {
  const found = getDb().select({ artifact: artifacts, chatTitle: chats.title }).from(artifacts)
    .innerJoin(chats, eq(chats.id, artifacts.chatId))
    .where(and(eq(artifacts.userId, userId), eq(artifacts.id, id))).get();
  if (!found) return null;
  const { seq: _seq, userId: _userId, ...row } = found.artifact;
  const versions = lineageVersions(userId, row.lineageId);
  return {
    ...row,
    chatTitle: found.chatTitle,
    key: rowKey(row),
    title: shownTitle(row),
    number: versions.findIndex((version) => version.id === row.id) + 1,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    versions,
  };
}

/** The user's artifacts in one chat, keyed by block key. Empty for a chat that is not theirs. */
export function listChatArtifacts(userId: UserId, chatId: string): Record<string, StoredChatArtifact> {
  const rows = getDb().select().from(artifacts).where(and(eq(artifacts.userId, userId), eq(artifacts.chatId, chatId)))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.seq)).all();
  // A lineage never leaves its chat: lineageFor only looks at the chat's own rows.
  const lineages = new Map<string, ArtifactRow[]>();
  for (const row of rows) {
    const versions = lineages.get(row.lineageId);
    if (versions) versions.push(row);
    else lineages.set(row.lineageId, [row]);
  }
  const stored: Record<string, StoredChatArtifact> = {};
  for (const lineage of lineages.values()) {
    const versions = versionsOf(lineage);
    lineage.forEach((row, i) => {
      stored[rowKey(row)] = {
        id: row.id, key: rowKey(row), title: shownTitle(row), derivedTitle: row.derivedTitle, userTitle: row.userTitle,
        lineageId: row.lineageId, number: i + 1, versions,
      };
    });
  }
  return stored;
}

/**
 * Names every version in the artifact's lineage. The title is masked, has its whitespace collapsed, is cut to 80 code
 * points, and is masked again, since collapsing or cutting can rebuild a credential. A blank title clears the rename.
 * Leaves updated_at alone, so the list order stays. Null when the artifact is not the user's.
 */
export function renameArtifact(userId: UserId, id: string, title: string, redact: Redactor): RenamedArtifact | null {
  const clean = redact.text(capTitle(redact.text(title).replace(/\s+/g, " ").trim()));
  const userTitle = clean === "" ? null : clean;
  const db = getDb();
  return db.transaction(() => {
    const row = db.select({ lineageId: artifacts.lineageId, derivedTitle: artifacts.derivedTitle }).from(artifacts)
      .where(and(eq(artifacts.userId, userId), eq(artifacts.id, id))).get();
    if (!row) return null;
    db.update(artifacts).set({ userTitle }).where(and(eq(artifacts.userId, userId), eq(artifacts.lineageId, row.lineageId))).run();
    return { id, lineageId: row.lineageId, userTitle, title: shownTitle({ userTitle, derivedTitle: row.derivedTitle }) };
  });
}
