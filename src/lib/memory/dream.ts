import { generateObject } from "ai";
import { z } from "zod";
import type { Redactor } from "../chat-errors";
import { connectionApiKey } from "../connections";
import { getDb } from "../db";
import { getChatForUser } from "../messages";
import { NOTHING_PINNED, resolveChoice } from "../model-choice";
import type { UserId, Viewer } from "../policy";
import { getMemoryEnabled } from "../preferences";
import { getInstance } from "../instance-settings";
import { providerFetch, refuseDownloads } from "../net-guard";
import { languageModelFor } from "../provider";
import { modelRedactors } from "../request-redactor";
import { embed, embedPending } from "./embed";
import { parseRun, storedRow, transition, unfinishedChatIds, type MemoryRun, type RunEvent } from "./run-state";
import { localMidnight, localStamp, systemTimeZone } from "./schedule";
import { cleanMemoryText, getMemory, saveMemory, updateMemory, writeVectors, MemoryRejected } from "./store";

export type Candidate = { kind: "fact" | "preference"; text: string; sourceMessageId: string };

const candidateList = z.object({
  candidates: z
    .array(
      z.object({
        kind: z.enum(["fact", "preference"]),
        text: z.string(),
        sourceMessageId: z.string(),
      }),
    )
    .max(10),
});

const MERGE_SIMILARITY = 0.9;

const RUN_COLUMNS = `date, state, started_at AS startedAt, finished_at AS finishedAt, owner,
  lease_until AS leaseUntil, chat_ids AS chatIds, done_chat_ids AS doneChatIds,
  retry_chat_ids AS retryChatIds, added, merged, error`;

const WRITE_RUN = `
INSERT INTO memory_runs (
  user_id, date, state, started_at, finished_at, owner, lease_until,
  chat_ids, done_chat_ids, retry_chat_ids, added, merged, error
) VALUES (
  @userId, @date, @state, @startedAt, @finishedAt, @owner, @leaseUntil,
  @chatIds, @doneChatIds, @retryChatIds, @added, @merged, @error
)
ON CONFLICT(user_id, date) DO UPDATE SET
  state = excluded.state, started_at = excluded.started_at, finished_at = excluded.finished_at,
  owner = excluded.owner, lease_until = excluded.lease_until, chat_ids = excluded.chat_ids,
  done_chat_ids = excluded.done_chat_ids, retry_chat_ids = excluded.retry_chat_ids,
  added = excluded.added, merged = excluded.merged, error = excluded.error
`;

function readRun(userId: UserId, date: string): MemoryRun | null {
  const row = getDb().$client.prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs WHERE user_id = ? AND date = ?`).get(userId, date);
  return row ? parseRun(row) : null;
}

// The only writer of memory_runs. The immediate transaction takes the write lock before the read,
// so two processes cannot both apply an event to the same row.
function advance(userId: UserId, date: string, event: RunEvent): MemoryRun | null {
  const client = getDb().$client;
  return client
    .transaction(() => {
      const next = transition(readRun(userId, date), event);
      if (next) client.prepare(WRITE_RUN).run({ userId, ...storedRow(next) });
      return next;
    })
    .immediate();
}

export function getRun(userId: UserId, date: string): MemoryRun | null {
  return readRun(userId, date);
}

export function latestRun(userId: UserId): MemoryRun | null {
  const row = getDb().$client.prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs WHERE user_id = ? ORDER BY date DESC LIMIT 1`).get(userId);
  return row ? parseRun(row) : null;
}

export function lastDoneRun(userId: UserId): MemoryRun | null {
  const row = getDb().$client.prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs WHERE user_id = ? AND state = 'done' ORDER BY date DESC LIMIT 1`).get(userId);
  return row ? parseRun(row) : null;
}

/** What the Memory page says about dreaming. Times are ISO strings, so the browser formats them in its own zone. */
export type DreamStatus =
  | { state: "never" }
  | { state: "running"; startedAt: string }
  | { state: "done"; finishedAt: string; chats: number; added: number; merged: number }
  | { state: "failed"; finishedAt: string; error: string };

const NO_PROVIDER = "No provider is saved";

function doneStatus(run: Extract<MemoryRun, { state: "done" }>): DreamStatus {
  return { state: "done", finishedAt: run.finishedAt.toISOString(), chats: run.chatIds.length, added: run.added, merged: run.merged };
}

/**
 * The status of the latest night. A night that failed for want of a provider stops being news once one is saved,
 * so it gives way to the last done night, or to never.
 */
export function dreamStatus(latest: MemoryRun | null, lastDone: MemoryRun | null, providerReady: boolean): DreamStatus {
  if (!latest) return { state: "never" };
  if (latest.state === "running") return { state: "running", startedAt: latest.startedAt.toISOString() };
  if (latest.state === "done") return doneStatus(latest);
  if (latest.error === NO_PROVIDER && providerReady) return lastDone?.state === "done" ? doneStatus(lastDone) : { state: "never" };
  return { state: "failed", finishedAt: latest.finishedAt.toISOString(), error: latest.error };
}

export function tryClaim(userId: UserId, input: { date: string; owner: string; now: Date; chatIds: string[] }): boolean {
  return advance(userId, input.date, { type: "claim", date: input.date, owner: input.owner, at: input.now, chatIds: input.chatIds }) !== null;
}

function previousRun(userId: UserId, date: string): MemoryRun | null {
  const row = getDb().$client.prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1`).get(userId, date);
  return row ? parseRun(row) : null;
}

function latestDone(userId: UserId, date: string): MemoryRun | null {
  const row = getDb().$client
    .prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs WHERE user_id = ? AND date < ? AND state = 'done' ORDER BY date DESC LIMIT 1`)
    .get(userId, date);
  return row ? parseRun(row) : null;
}

function windowStart(userId: UserId, date: string): number {
  const done = latestDone(userId, date);
  if (done) return done.startedAt.getTime();
  return localMidnight(date, systemTimeZone());
}

// Where a retried chat's unread rows begin: the window start of the night it first failed. Every
// run since that night holds the chat in retryChatIds and reached done, so the oldest such row
// carries the start, which the retried night's own window start no longer reaches back to.
function retryWindowStart(userId: UserId, date: string, chatId: string): number | null {
  let first: MemoryRun | null = null;
  for (let run = previousRun(userId, date); run?.retryChatIds.includes(chatId); run = previousRun(userId, run.date)) {
    first = run;
  }
  return first ? windowStart(userId, first.date) : null;
}

function changedChatIds(userId: UserId, date: string, end: number): string[] {
  const start = windowStart(userId, date);
  const rows = getDb().$client
    .prepare(
      `SELECT DISTINCT messages.chat_id AS id
       FROM messages JOIN chats ON chats.id = messages.chat_id AND chats.user_id = ?
       WHERE messages.created_at > ? AND messages.created_at <= ?`,
    )
    .all(userId, start, end) as { id: string }[];
  const retry = previousRun(userId, date)?.retryChatIds.filter((chatId) => getChatForUser(chatId, userId) !== null) ?? [];
  return [...new Set([...rows.map((row) => row.id), ...retry])].sort();
}

function renew(userId: UserId, date: string, owner: string): boolean {
  return advance(userId, date, { type: "renew", owner, at: new Date() }) !== null;
}

function safeError(error: unknown): string {
  if (error instanceof Error && (error.message === NO_PROVIDER || error.message.startsWith("Ollama "))) return error.message;
  return "Dream failed";
}

function failOwned(userId: UserId, date: string, owner: string, message: string) {
  advance(userId, date, { type: "fail", owner, at: new Date(), error: message });
}

type ChatMessage = { id: string; role: string; parts: string; createdAt: number };

const PAGE = 100;

// The window in full, oldest first. Pages on (createdAt, id), because a cursor on createdAt alone
// skips rows that share the last row's timestamp. A null id keeps the first page inside the
// window's exclusive start.
function loadWindow(userId: UserId, chatId: string, start: number, end: number): ChatMessage[] {
  const page = getDb().$client.prepare(
    `SELECT messages.id, messages.role, messages.parts, messages.created_at AS createdAt
     FROM messages JOIN chats ON chats.id = messages.chat_id AND chats.user_id = ?
     WHERE messages.chat_id = ? AND messages.created_at > ? AND messages.created_at <= ?
       AND messages.role IN ('user', 'assistant')
       AND (messages.created_at > ? OR (messages.created_at = ? AND messages.id > ?))
     ORDER BY messages.created_at, messages.id LIMIT ?`,
  );
  const all: ChatMessage[] = [];
  let cursorAt = start;
  let cursorId: string | null = null;
  for (;;) {
    const rows = page.all(userId, chatId, start, end, cursorAt, cursorAt, cursorId, PAGE) as ChatMessage[];
    all.push(...rows);
    if (rows.length < PAGE) return all;
    const last = rows[rows.length - 1];
    cursorAt = last.createdAt;
    cursorId = last.id;
  }
}

function messageText(parts: string): string {
  try {
    const parsed = JSON.parse(parts) as { type?: string; text?: string }[];
    if (!Array.isArray(parsed)) return "";
    return parsed
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

function promptFor(messages: ChatMessage[]): string {
  const lines = [...messages]
    .sort((left, right) => left.createdAt - right.createdAt)
    .flatMap((message) => {
      const text = messageText(message.parts).replace(/\s+/g, " ").trim();
      return text ? [`msg ${message.id} ${message.role}: ${text}`] : [];
    });
  const qa = process.env.ORBIT_QA_TAGS === "1";
  const tag = qa ? `${lines.some((line) => line.includes("[qa:dream-fail]")) ? "[qa:dream-fail]" : "[qa:dream]"}\n` : "";
  return `${tag}Extract lasting facts and preferences the user stated. Ignore questions, tasks, and guesses. Return json {"candidates":[{"kind":"fact","text":"...","sourceMessageId":"the message id"}]}. kind is fact or preference. At most 10 items.\n${lines.join("\n")}`;
}

function nearest(userId: UserId, vector: number[]): { id: string; similarity: number } | null {
  const blob = Buffer.from(new Float32Array(vector).buffer);
  const row = getDb().$client
    .prepare(
      `SELECT memories.id AS id, vec_distance_cosine(memories_vec.embedding, ?) AS distance
       FROM memories_vec
       JOIN memories ON memories.rowid = memories_vec.rowid
       WHERE memories.user_id = ?
       ORDER BY distance
       LIMIT 1`,
    )
    .get(blob, userId) as { id: string; distance: number } | undefined;
  if (!row || !Number.isFinite(row.distance)) return null;
  return { id: row.id, similarity: 1 - row.distance };
}

function rememberVector(userId: UserId, id: string, text: string, vector: number[]) {
  const located = getDb().$client.prepare("SELECT rowid AS rowid FROM memories WHERE user_id = ? AND id = ?").get(userId, id) as { rowid: number } | undefined;
  if (!located) return;
  writeVectors([{ rowid: located.rowid, text, vector }]);
}

type Prepared = Candidate & { vector: number[]; createdAt: number };

function sourceChat(userId: UserId, messageId: string): string | null {
  const row = getDb().$client.prepare(
    `SELECT messages.chat_id AS chatId
     FROM messages JOIN chats ON chats.id = messages.chat_id AND chats.user_id = ?
     WHERE messages.id = ?`,
  ).get(userId, messageId) as { chatId: string } | undefined;
  return row?.chatId ?? null;
}

function applyCandidatesWithSource(userId: UserId, chatId: string, prepared: Prepared[]): { added: number; merged: number } {
  let added = 0;
  let merged = 0;
  const client = getDb().$client;
  for (const candidate of prepared) {
    // The chat or the message was deleted while the model read it, so the fact has no chat to come from.
    if (sourceChat(userId, candidate.sourceMessageId) !== chatId) continue;
    let text: string;
    try {
      text = cleanMemoryText(candidate.text);
    } catch (error) {
      if (error instanceof MemoryRejected) continue;
      throw error;
    }
    const hit = nearest(userId, candidate.vector);
    if (hit && hit.similarity >= MERGE_SIMILARITY) {
      const memory = getMemory(userId, hit.id);
      merged += 1;
      if (memory && candidate.createdAt > memory.createdAt.getTime() && text.length > memory.text.length) {
        try {
          const updated = updateMemory(userId, memory.id, { text, kind: candidate.kind, source: "dream" });
          if (updated) rememberVector(userId, updated.id, updated.text, candidate.vector);
        } catch (error) {
          if (!(error instanceof MemoryRejected)) throw error;
        }
      }
      continue;
    }
    const prior = client.prepare("SELECT id FROM memories WHERE user_id = ? AND text_norm = ?").get(userId, text.toLowerCase()) as { id: string } | undefined;
    const saved = saveMemory(userId, { text, kind: candidate.kind, source: "dream", sourceChatId: chatId, sourceMessageId: candidate.sourceMessageId });
    if (prior) {
      merged += 1;
      continue;
    }
    added += 1;
    rememberVector(userId, saved.id, saved.text, candidate.vector);
  }
  return { added, merged };
}

function finishChat(
  userId: UserId,
  date: string,
  owner: string,
  chatId: string,
  outcome: "done" | "retry",
  apply: () => { added: number; merged: number },
): "done" | "retry" | "lost" {
  return getDb().$client
    .transaction((): "done" | "retry" | "lost" => {
      if (!renew(userId, date, owner)) return "lost";
      const counts = outcome === "done" ? apply() : { added: 0, merged: 0 };
      if (!advance(userId, date, { type: "chat", owner, chatId, outcome, ...counts })) return "lost";
      return outcome;
    })
    .immediate();
}

export async function dreamChat(viewer: Viewer, chatId: string, input: { date: string; owner: string }): Promise<"done" | "retry" | "lost"> {
  const userId = viewer.id;
  const run = readRun(userId, input.date);
  if (!run || run.owner !== input.owner) return "lost";
  if (run.doneChatIds.includes(chatId)) return "done";
  if (run.retryChatIds.includes(chatId)) return "retry";
  if (!renew(userId, input.date, input.owner)) return "lost";
  // A chat deleted since the night began has nothing left to read.
  if (!getChatForUser(chatId, userId)) return finishChat(userId, input.date, input.owner, chatId, "done", () => ({ added: 0, merged: 0 }));
  const start = retryWindowStart(userId, input.date, chatId) ?? windowStart(userId, input.date);
  const messages = loadWindow(userId, chatId, start, run.startedAt.getTime());
  const known = new Set(messages.filter((message) => message.role === "user").map((message) => message.id));
  const createdAt = new Map(messages.map((message) => [message.id, message.createdAt]));
  let candidates: Candidate[] = [];
  let redact: Redactor;
  try {
    const resolved = resolveChoice(viewer, NOTHING_PINNED);
    if (!resolved.ok) throw new Error(NO_PROVIDER);
    const { connection } = resolved;
    const apiKey = connectionApiKey(connection.userId, connection.id);
    const instance = getInstance();
    const fetch = providerFetch(instance.hostingMode);
    redact = modelRedactors(viewer, { apiKey, baseUrl: connection.kind === "openai-compatible" ? connection.baseUrl : undefined }, {
      ownProvider: connection.userId === userId, instance,
    }).output;
    for (let offset = 0; offset < messages.length; offset += PAGE) {
      if (!renew(userId, input.date, input.owner)) return "lost";
      const generated = await generateObject({
        model: languageModelFor({ connection, apiKey, model: resolved.choice.model, chatId, fetch }),
        schema: candidateList,
        prompt: promptFor(messages.slice(offset, offset + PAGE)),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(60_000),
        experimental_download: refuseDownloads,
      });
      candidates.push(...generated.object.candidates);
    }
  } catch (error) {
    if (error instanceof Error && error.message === NO_PROVIDER) throw error;
    return finishChat(userId, input.date, input.owner, chatId, "retry", () => ({ added: 0, merged: 0 }));
  }
  // Mask before embedding so credentials never reach Ollama and the stored text matches the embedded text.
  const accepted = candidates
    .filter((candidate) => known.has(candidate.sourceMessageId))
    .flatMap((candidate) => {
      try {
        const text = redact.text(cleanMemoryText(redact.text(candidate.text)));
        return [{ ...candidate, text }];
      } catch (error) {
        if (error instanceof MemoryRejected) return [];
        throw error;
      }
    });
  if (!renew(userId, input.date, input.owner)) return "lost";
  const embedded = await embed(accepted.map((candidate) => candidate.text), "document");
  if (!embedded.ok) return finishChat(userId, input.date, input.owner, chatId, "retry", () => ({ added: 0, merged: 0 }));
  const prepared: Prepared[] = accepted.flatMap((candidate, index) => {
    const vector = embedded.vectors[index];
    const at = createdAt.get(candidate.sourceMessageId);
    if (!vector || at == null) return [];
    return [{ ...candidate, vector, createdAt: at }];
  });
  return finishChat(userId, input.date, input.owner, chatId, "done", () => applyCandidatesWithSource(userId, chatId, prepared));
}

export async function runDream(input: { viewer: Viewer; now?: Date; date?: string; manual?: boolean }): Promise<MemoryRun | null> {
  const { viewer } = input;
  const userId = viewer.id;
  if (!getMemoryEnabled(userId)) return null;
  const now = input.now ?? new Date();
  const date = input.date ?? localStamp(now, systemTimeZone()).date;
  const owner = crypto.randomUUID();
  if (input.manual) advance(userId, date, { type: "reopen", owner, at: now });
  const existing = readRun(userId, date);
  let owned = existing?.state === "running" && existing.owner === owner;
  if (!owned) {
    const chatIds = existing?.state === "running" ? existing.chatIds : changedChatIds(userId, date, now.getTime());
    owned = tryClaim(userId, { date, owner, now, chatIds });
  }
  if (!owned) return readRun(userId, date);
  try {
    if (!resolveChoice(viewer, NOTHING_PINNED).ok) {
      failOwned(userId, date, owner, NO_PROVIDER);
      return readRun(userId, date);
    }
    const claimed = readRun(userId, date);
    if (!claimed) return null;
    const pending = unfinishedChatIds(claimed);
    if (pending.length > 0) {
      const status = await embed(["orbit"], "query");
      if (!status.ok) {
        failOwned(userId, date, owner, status.error);
        return readRun(userId, date);
      }
    }
    for (const chatId of pending) {
      const outcome = await dreamChat(viewer, chatId, { date, owner });
      if (outcome === "lost") return readRun(userId, date);
    }
    if (!renew(userId, date, owner)) return readRun(userId, date);
    const embedded = await embedPending(userId);
    if (!embedded.ok) {
      failOwned(userId, date, owner, embedded.error);
      return readRun(userId, date);
    }
    return advance(userId, date, { type: "done", owner, at: new Date(), embedded }) ?? readRun(userId, date);
  } catch (error) {
    failOwned(userId, date, owner, safeError(error));
    return readRun(userId, date);
  }
}
