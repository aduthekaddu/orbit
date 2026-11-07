import Database from "better-sqlite3";
import { generateObject } from "ai";
import { z } from "zod";
import { db } from "../db";
import { orbitModel } from "../provider";
import { getSettings } from "../settings";
import { embed, embedPending } from "./embed";
import { DREAM_LEASE_MS, localMidnight, localStamp, systemTimeZone, type RunState } from "./schedule";
import { cleanMemoryText, getMemory, saveMemory, updateMemory, writeVectors, MemoryRejected } from "./store";

export type MemoryRun = {
  date: string;
  state: RunState;
  startedAt: Date;
  finishedAt: Date | null;
  owner: string | null;
  leaseUntil: Date | null;
  chatIds: string[];
  doneChatIds: string[];
  retryChatIds: string[];
  added: number;
  merged: number;
  error: string | null;
};

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

type RunRow = {
  date: string;
  state: string;
  startedAt: number;
  finishedAt: number | null;
  owner: string | null;
  leaseUntil: number | null;
  chatIds: string;
  doneChatIds: string;
  retryChatIds: string;
  added: number;
  merged: number;
  error: string | null;
};

const CLAIM_SQL = `
INSERT INTO memory_runs (
  date, state, started_at, finished_at, owner, lease_until,
  chat_ids, done_chat_ids, retry_chat_ids, added, merged, error
) VALUES (
  @date, 'running', @started, NULL, @owner, @lease,
  @chatIds, '[]', '[]', 0, 0, NULL
)
ON CONFLICT(date) DO UPDATE SET
  owner = @owner,
  lease_until = @lease
WHERE state = 'running' AND lease_until < @now
`;

function idList(value: string): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function parseRun(row: RunRow): MemoryRun | null {
  if (row.state !== "running" && row.state !== "done" && row.state !== "failed") return null;
  return {
    date: row.date,
    state: row.state,
    startedAt: new Date(row.startedAt),
    finishedAt: row.finishedAt == null ? null : new Date(row.finishedAt),
    owner: row.owner,
    leaseUntil: row.leaseUntil == null ? null : new Date(row.leaseUntil),
    chatIds: idList(row.chatIds),
    doneChatIds: idList(row.doneChatIds),
    retryChatIds: idList(row.retryChatIds),
    added: row.added,
    merged: row.merged,
    error: row.error,
  };
}

function readRun(date: string): MemoryRun | null {
  const row = db.$client.prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs WHERE date = ?`).get(date) as RunRow | undefined;
  return row ? parseRun(row) : null;
}

export function getRun(date: string): MemoryRun | null {
  return readRun(date);
}

export function latestRun(): MemoryRun | null {
  const row = db.$client.prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs ORDER BY date DESC LIMIT 1`).get() as RunRow | undefined;
  return row ? parseRun(row) : null;
}

export function formatDreamStatus(run: MemoryRun): string {
  const [year, month, day] = run.date.split("-").map(Number);
  const when = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
  if (run.state === "failed") return `${when}. ${run.error ?? "Dream failed"}`;
  if (run.state === "running") return `${when}. Dreaming`;
  return `${when}. ${run.chatIds.length} chats, ${run.added} added, ${run.merged} merged`;
}

export function tryClaim(
  database: Database.Database,
  input: { date: string; owner: string; now: Date; chatIds: string[] },
): boolean {
  const result = database.prepare(CLAIM_SQL).run({
    date: input.date,
    owner: input.owner,
    now: input.now.getTime(),
    started: input.now.getTime(),
    lease: input.now.getTime() + DREAM_LEASE_MS,
    chatIds: JSON.stringify(input.chatIds),
  });
  return result.changes === 1;
}

function previousRun(date: string): MemoryRun | null {
  const row = db.$client.prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs WHERE date < ? ORDER BY date DESC LIMIT 1`).get(date) as
    | RunRow
    | undefined;
  return row ? parseRun(row) : null;
}

function latestDone(date: string): MemoryRun | null {
  const row = db.$client
    .prepare(`SELECT ${RUN_COLUMNS} FROM memory_runs WHERE date < ? AND state = 'done' ORDER BY date DESC LIMIT 1`)
    .get(date) as RunRow | undefined;
  return row ? parseRun(row) : null;
}

function windowStart(date: string): number {
  const done = latestDone(date);
  if (done) return done.startedAt.getTime();
  return localMidnight(date, systemTimeZone());
}

function changedChatIds(date: string, end: number): string[] {
  const start = windowStart(date);
  const rows = db.$client
    .prepare("SELECT DISTINCT chat_id AS id FROM messages WHERE created_at > ? AND created_at <= ?")
    .all(start, end) as { id: string }[];
  const retry = previousRun(date)?.retryChatIds ?? [];
  return [...new Set([...rows.map((row) => row.id), ...retry])].sort();
}

function renew(date: string, owner: string): boolean {
  const run = readRun(date);
  const floor = run?.startedAt.getTime() ?? Date.now();
  const result = db.$client
    .prepare("UPDATE memory_runs SET lease_until = ? WHERE date = ? AND owner = ?")
    .run(Math.max(Date.now(), floor) + DREAM_LEASE_MS, date, owner);
  return result.changes === 1;
}

function reopenFailed(date: string, owner: string, now: Date): boolean {
  const result = db.$client
    .prepare(
      `UPDATE memory_runs
       SET state = 'running', owner = ?, lease_until = ?, error = NULL, finished_at = NULL, retry_chat_ids = '[]'
       WHERE date = ? AND state = 'failed'`,
    )
    .run(owner, now.getTime() + DREAM_LEASE_MS, date);
  return result.changes === 1;
}

function safeError(error: unknown): string {
  if (error instanceof Error && (error.message === "No provider is saved" || error.message.startsWith("Ollama "))) return error.message;
  return "Dream failed";
}

function failOwned(date: string, owner: string, message: string) {
  db.$client
    .prepare(
      `UPDATE memory_runs SET state = 'failed', finished_at = ?, error = ? WHERE date = ? AND owner = ? AND state = 'running'`,
    )
    .run(Date.now(), message, date, owner);
}

type ChatMessage = { id: string; role: string; parts: string; createdAt: number };

function loadMessages(chatId: string, start: number, end: number, inherited: boolean): ChatMessage[] {
  if (inherited) {
    return db.$client
      .prepare(
        `SELECT id, role, parts, created_at AS createdAt FROM messages
         WHERE chat_id = ? AND created_at <= ? AND role IN ('user', 'assistant')
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all(chatId, end) as ChatMessage[];
  }
  return db.$client
    .prepare(
      `SELECT id, role, parts, created_at AS createdAt FROM messages
       WHERE chat_id = ? AND created_at > ? AND created_at <= ? AND role IN ('user', 'assistant')
       ORDER BY created_at LIMIT 100`,
    )
    .all(chatId, start, end) as ChatMessage[];
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
      const text = messageText(message.parts);
      return text ? [`msg ${message.id} ${message.role}: ${text}`] : [];
    });
  const qa = process.env.ORBIT_QA_TAGS === "1";
  const tag = qa ? `${lines.some((line) => line.includes("[qa:dream-fail]")) ? "[qa:dream-fail]" : "[qa:dream]"}\n` : "";
  return `${tag}Extract lasting facts and preferences the user stated. Ignore questions, tasks, and guesses. Return json {"candidates":[{"kind":"fact","text":"...","sourceMessageId":"the message id"}]}. kind is fact or preference. At most 10 items.\n${lines.join("\n")}`;
}

function nearest(vector: number[]): { id: string; similarity: number } | null {
  const blob = Buffer.from(new Float32Array(vector).buffer);
  const row = db.$client
    .prepare(
      `SELECT memories.id AS id, vec_distance_cosine(memories_vec.embedding, ?) AS distance
       FROM memories_vec
       JOIN memories ON memories.rowid = memories_vec.rowid
       ORDER BY distance
       LIMIT 1`,
    )
    .get(blob) as { id: string; distance: number } | undefined;
  if (!row || !Number.isFinite(row.distance)) return null;
  return { id: row.id, similarity: 1 - row.distance };
}

function rememberVector(id: string, text: string, vector: number[]) {
  const located = db.$client.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get(id) as { rowid: number } | undefined;
  if (!located) return;
  writeVectors([{ rowid: located.rowid, text, vector }]);
}

type Prepared = Candidate & { vector: number[]; createdAt: number };

function sourceChat(messageId: string): string | null {
  const row = db.$client.prepare("SELECT chat_id AS chatId FROM messages WHERE id = ?").get(messageId) as { chatId: string } | undefined;
  return row?.chatId ?? null;
}

function applyCandidatesWithSource(chatId: string, prepared: Prepared[]): { added: number; merged: number } {
  let added = 0;
  let merged = 0;
  for (const candidate of prepared) {
    let text: string;
    try {
      text = cleanMemoryText(candidate.text);
    } catch (error) {
      if (error instanceof MemoryRejected) continue;
      throw error;
    }
    const hit = nearest(candidate.vector);
    if (hit && hit.similarity >= MERGE_SIMILARITY) {
      const memory = getMemory(hit.id);
      merged += 1;
      if (memory && candidate.createdAt > memory.createdAt.getTime() && text.length > memory.text.length) {
        try {
          const updated = updateMemory(memory.id, { text, kind: candidate.kind });
          if (updated) rememberVector(updated.id, updated.text, candidate.vector);
        } catch (error) {
          if (!(error instanceof MemoryRejected)) throw error;
        }
      }
      continue;
    }
    const prior = db.$client.prepare("SELECT id FROM memories WHERE text_norm = ?").get(text.toLowerCase()) as { id: string } | undefined;
    const saved = saveMemory({
      text,
      kind: candidate.kind,
      sourceChatId: sourceChat(candidate.sourceMessageId) === chatId ? chatId : null,
      sourceMessageId: sourceChat(candidate.sourceMessageId) === chatId ? candidate.sourceMessageId : null,
    });
    if (prior) {
      merged += 1;
      continue;
    }
    added += 1;
    rememberVector(saved.id, saved.text, candidate.vector);
  }
  return { added, merged };
}

function finishChat(
  date: string,
  owner: string,
  chatId: string,
  outcome: "done" | "retry",
  apply: () => { added: number; merged: number },
): "done" | "retry" | "lost" {
  let result: "done" | "retry" | "lost" = "lost";
  const work = db.$client.transaction(() => {
    if (!renew(date, owner)) {
      result = "lost";
      return;
    }
    const counts = outcome === "done" ? apply() : { added: 0, merged: 0 };
    const current = readRun(date);
    if (!current || current.owner !== owner) {
      result = "lost";
      return;
    }
    const doneChatIds = outcome === "done" ? [...new Set([...current.doneChatIds, chatId])] : current.doneChatIds;
    const retryChatIds = outcome === "retry" ? [...new Set([...current.retryChatIds, chatId])] : current.retryChatIds;
    db.$client
      .prepare(
        `UPDATE memory_runs
         SET done_chat_ids = ?, retry_chat_ids = ?, added = added + ?, merged = merged + ?
         WHERE date = ? AND owner = ?`,
      )
      .run(JSON.stringify(doneChatIds), JSON.stringify(retryChatIds), counts.added, counts.merged, date, owner);
    result = outcome;
    console.log(JSON.stringify({ dream: date, chatId, outcome, added: counts.added, merged: counts.merged }));
  });
  work();
  return result;
}

export async function dreamChat(chatId: string, input: { date: string; owner: string }): Promise<"done" | "retry" | "lost"> {
  const run = readRun(input.date);
  if (!run || run.owner !== input.owner) return "lost";
  if (run.doneChatIds.includes(chatId)) return "done";
  if (run.retryChatIds.includes(chatId)) return "retry";
  if (!renew(input.date, input.owner)) return "lost";
  const inherited = new Set(previousRun(input.date)?.retryChatIds ?? []);
  const messages = loadMessages(chatId, windowStart(input.date), run.startedAt.getTime(), inherited.has(chatId)).sort(
    (left, right) => left.createdAt - right.createdAt,
  );
  const known = new Set(messages.map((message) => message.id));
  const createdAt = new Map(messages.map((message) => [message.id, message.createdAt]));
  let candidates: Candidate[] = [];
  try {
    const settings = getSettings();
    if (!settings?.baseUrl || !settings.apiKey || !settings.model) throw new Error("No provider is saved");
    const generated = await generateObject({
      model: orbitModel({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        chatId,
      }),
      schema: candidateList,
      prompt: promptFor(messages),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
    });
    candidates = generated.object.candidates;
  } catch (error) {
    if (error instanceof Error && error.message === "No provider is saved") throw error;
    return finishChat(input.date, input.owner, chatId, "retry", () => ({ added: 0, merged: 0 }));
  }
  const accepted = candidates.filter((candidate) => known.has(candidate.sourceMessageId));
  const embedded = await embed(accepted.map((candidate) => candidate.text));
  if (!embedded.ok) return finishChat(input.date, input.owner, chatId, "retry", () => ({ added: 0, merged: 0 }));
  const prepared: Prepared[] = accepted.flatMap((candidate, index) => {
    const vector = embedded.vectors[index];
    const at = createdAt.get(candidate.sourceMessageId);
    if (!vector || at == null) return [];
    return [{ ...candidate, vector, createdAt: at }];
  });
  return finishChat(input.date, input.owner, chatId, "done", () => applyCandidatesWithSource(chatId, prepared));
}

function markDone(date: string, owner: string): boolean {
  const run = readRun(date);
  if (!run || run.owner !== owner) return false;
  const settled = run.chatIds.every((id) => run.doneChatIds.includes(id) || run.retryChatIds.includes(id));
  if (!settled) return false;
  const result = db.$client
    .prepare(`UPDATE memory_runs SET state = 'done', finished_at = ?, error = NULL WHERE date = ? AND owner = ? AND state = 'running'`)
    .run(Date.now(), date, owner);
  return result.changes === 1;
}

export async function runDream(input: { now?: Date; date?: string; manual?: boolean } = {}): Promise<MemoryRun | null> {
  const now = input.now ?? new Date();
  const date = input.date ?? localStamp(now, systemTimeZone()).date;
  const owner = crypto.randomUUID();
  if (input.manual) reopenFailed(date, owner, now);
  const existing = readRun(date);
  let owned = existing?.state === "running" && existing.owner === owner;
  if (!owned) {
    const chatIds = existing?.state === "running" ? existing.chatIds : changedChatIds(date, now.getTime());
    owned = tryClaim(db.$client, { date, owner, now, chatIds });
  }
  if (!owned) return readRun(date);
  try {
    const settings = getSettings();
    if (!settings?.baseUrl || !settings.apiKey || !settings.model) {
      failOwned(date, owner, "No provider is saved");
      return readRun(date);
    }
    const claimed = readRun(date);
    if (!claimed) return null;
    const pending = claimed.chatIds.filter((id) => !claimed.doneChatIds.includes(id) && !claimed.retryChatIds.includes(id));
    for (const chatId of pending) {
      const outcome = await dreamChat(chatId, { date, owner });
      if (outcome === "lost") return readRun(date);
    }
    const embedded = await embedPending();
    if (!embedded.ok) failOwned(date, owner, embedded.error);
    if (!markDone(date, owner)) return readRun(date);
    const final = readRun(date);
    if (final) {
      console.log(JSON.stringify({ dream: final.date, state: final.state, chats: final.chatIds.length, added: final.added, merged: final.merged }));
    }
    return final;
  } catch (error) {
    failOwned(date, owner, safeError(error));
    return readRun(date);
  }
}
