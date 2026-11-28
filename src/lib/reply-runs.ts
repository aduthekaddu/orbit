import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import type { RemoveMemberResult } from "./admin-users";
import { SERVER_TIME_HEADER } from "./thought-time";

export const RESUMABLE_STREAM_ID_HEADER = "x-resumable-stream-id";
export const MAX_RUNNING_PER_USER = 4;
export const REPLAY_GRACE_MS = 10 * 60_000;
export const REPLAY_BUDGET_BYTES = 64 * 1024 * 1024;
export const STOP_WAIT_MS = 5_000;

export type ReplyEndReason = "stopped" | "failed";
export type ReplyEndPart = { type: "data-reply-end"; data: { reason: ReplyEndReason } };

type Listener = ReadableStreamDefaultController<UIMessageChunk>;
type FailureChunk = Extract<UIMessageChunk, { type: "abort" | "error" }>;
type StopReason = "stopped" | "discarded";
type RunState =
  | { kind: "starting" | "running"; listeners: Set<Listener> }
  | { kind: "stopping"; listeners: Set<Listener>; reason: StopReason }
  | { kind: "ended"; graceTimer: ReturnType<typeof setTimeout> };

type ReplyIdentity = { replyId: string; promptId: string };

type ReplyRun = {
  chatId: string;
  userId: string;
  identity: ReplyIdentity | null;
  controller: AbortController;
  chunks: UIMessageChunk[];
  bytes: number;
  state: RunState;
  done: Promise<void>;
  resolveDone: () => void;
};

type ReserveResult =
  | { ok: true; run: ReplyRun }
  | { ok: false; reason: "busy" | "user-limit" };

const globalRuns = globalThis as typeof globalThis & {
  __orbitReplyRuns?: {
    runs: Map<string, ReplyRun>;
    ended: Set<ReplyRun>;
    endedBytes: number;
    deleting: Map<string, Promise<boolean>>;
    deletingUsers: Map<string, Promise<RemoveMemberResult>>;
  };
};
const registry = globalRuns.__orbitReplyRuns ??= {
  runs: new Map(),
  ended: new Set(),
  endedBytes: 0,
  deleting: new Map(),
  deletingUsers: new Map(),
};
const { runs, ended, deleting, deletingUsers } = registry;

function evictEnded(run: ReplyRun) {
  if (run.state.kind !== "ended" || !ended.delete(run)) return;
  clearTimeout(run.state.graceTimer);
  registry.endedBytes -= run.bytes;
  if (runs.get(run.chatId) === run) runs.delete(run.chatId);
}

export async function reserveReplyRun(
  chatId: string,
  userId: string,
  { stopWaitMs = STOP_WAIT_MS }: { stopWaitMs?: number } = {},
): Promise<ReserveResult> {
  if (deleting.has(chatId) || deletingUsers.has(userId)) return { ok: false, reason: "busy" };
  const current = runs.get(chatId);
  if (current?.state.kind === "stopping") {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([current.done, new Promise<void>((resolve) => { timeout = setTimeout(resolve, stopWaitMs); })]);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Re-read after waiting so only one retry can claim the chat.
  if (deleting.has(chatId) || deletingUsers.has(userId)) return { ok: false, reason: "busy" };
  const previous = runs.get(chatId);
  if (previous && previous.state.kind !== "ended") return { ok: false, reason: "busy" };
  let active = 0;
  for (const run of runs.values()) {
    if (run.userId === userId && run.state.kind !== "ended") active++;
  }
  if (active >= MAX_RUNNING_PER_USER) return { ok: false, reason: "user-limit" };
  if (previous) evictEnded(previous);

  const { promise, resolve } = Promise.withResolvers<void>();
  const run: ReplyRun = {
    chatId, userId, identity: null, controller: new AbortController(),
    chunks: [], bytes: 0, state: { kind: "starting", listeners: new Set() },
    done: promise, resolveDone: resolve,
  };
  runs.set(chatId, run);
  return { ok: true, run };
}

export function bindReplyPlan(run: ReplyRun, replyId: string, promptId: string) {
  run.identity = { replyId, promptId };
}

function closeListeners(listeners: Set<Listener>) {
  for (const listener of listeners) {
    try {
      listener.close();
    } catch {
      // Cancellation may already have closed the controller.
    }
  }
  listeners.clear();
}

export function releaseReplyRun(run: ReplyRun) {
  if (run.state.kind !== "ended") closeListeners(run.state.listeners);
  if (runs.get(run.chatId) === run) runs.delete(run.chatId);
  run.resolveDone();
}

export function watchReply(run: ReplyRun): ReadableStream<UIMessageChunk> {
  let listener: Listener;
  return new ReadableStream({
    start(controller) {
      listener = controller;
      for (const chunk of run.chunks) controller.enqueue(chunk);
      if (run.state.kind === "ended") controller.close();
      else run.state.listeners.add(controller);
    },
    cancel() {
      if (run.state.kind !== "ended") run.state.listeners.delete(listener);
    },
  });
}

export function startReplyRun(
  run: ReplyRun,
  stream: ReadableStream<UIMessageChunk>,
  getEndReason: () => ReplyEndReason | null,
) {
  if (run.state.kind === "ended") throw new Error("A finished reply cannot start again");
  if (run.state.kind === "starting") run.state = { ...run.state, kind: "running" };
  const listeners = run.state.listeners;
  const publish = (chunk: UIMessageChunk) => {
    run.bytes += Buffer.byteLength(JSON.stringify(chunk));
    run.chunks.push(chunk);
    for (const listener of listeners) {
      try {
        listener.enqueue(chunk);
      } catch {
        listeners.delete(listener);
      }
    }
  };

  void (async () => {
    let finish: Extract<UIMessageChunk, { type: "finish" }> | undefined;
    let failure: FailureChunk | undefined;
    const interrupted = (): FailureChunk => run.controller.signal.aborted
      ? { type: "abort" }
      : { type: "error", errorText: "The reply was interrupted." };
    try {
      for await (const chunk of stream) {
        if (chunk.type === "abort" || chunk.type === "error") failure ??= chunk;
        else if (chunk.type === "finish") finish ??= chunk;
        else publish(chunk);
      }
    } catch {
      failure ??= interrupted();
    } finally {
      const reason = getEndReason();
      if (reason) {
        const part: ReplyEndPart = { type: "data-reply-end", data: { reason } };
        publish(part);
      }
      publish(failure ?? finish ?? interrupted());
      closeListeners(listeners);
      const graceTimer = setTimeout(() => evictEnded(run), REPLAY_GRACE_MS);
      graceTimer.unref();
      run.state = { kind: "ended", graceTimer };
      ended.add(run);
      registry.endedBytes += run.bytes;
      while (registry.endedBytes > REPLAY_BUDGET_BYTES) {
        const oldest = ended.values().next().value;
        if (!oldest) break;
        evictEnded(oldest);
      }
      run.resolveDone();
    }
  })();
}

export function replyResponse(run: ReplyRun, replyId: string, now = Date.now) {
  return createUIMessageStreamResponse({
    stream: watchReply(run),
    keepAliveMs: 15_000,
    headers: {
      [RESUMABLE_STREAM_ID_HEADER]: replyId,
      [SERVER_TIME_HEADER]: String(now()),
    },
  });
}

export function findReplyRun(chatId: string, userId: string, replyId?: string) {
  const run = runs.get(chatId);
  if (!run || run.userId !== userId || !run.identity) return null;
  if (replyId === undefined ? run.state.kind === "ended" : run.identity.replyId !== replyId) return null;
  return { run, replyId: run.identity.replyId };
}

export function findActiveReplyRun(chatId: string, userId: string): ReplyIdentity | null {
  return findReplyRun(chatId, userId)?.run.identity ?? null;
}

function abortRun(run: ReplyRun, reason: StopReason) {
  if (run.state.kind === "ended") return;
  if (run.state.kind === "stopping" && reason === "stopped") return;
  run.state = { ...run.state, kind: "stopping", reason };
  run.controller.abort(reason);
}

export function replyWasDiscarded(run: ReplyRun) {
  return run.state.kind === "stopping" && run.state.reason === "discarded";
}

export function stopReplyRun(chatId: string, userId: string) {
  const run = runs.get(chatId);
  if (!run || run.userId !== userId || run.state.kind === "ended") return false;
  abortRun(run, "stopped");
  return true;
}

async function discardRun(run: ReplyRun) {
  abortRun(run, "discarded");
  await run.done;
  evictEnded(run);
}

export async function discardReplyRun(chatId: string) {
  const run = runs.get(chatId);
  if (run) await discardRun(run);
}

/** Hold the reply slot from the start of discard through the synchronous removal of the chat. */
export function deleteAfterReply(chatId: string, remove: () => boolean): Promise<boolean> {
  const existing = deleting.get(chatId);
  if (existing) return existing;

  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  deleting.set(chatId, promise);
  void discardReplyRun(chatId).then(remove).then(
    (removed) => {
      deleting.delete(chatId);
      resolve(removed);
    },
    (error: unknown) => {
      deleting.delete(chatId);
      reject(error);
    },
  );
  return promise;
}

export function deleteUserAfterReplies(userId: string, remove: () => RemoveMemberResult): Promise<RemoveMemberResult> {
  const existing = deletingUsers.get(userId);
  if (existing) return existing;

  const { promise, resolve, reject } = Promise.withResolvers<RemoveMemberResult>();
  deletingUsers.set(userId, promise);
  const owned = [...runs.values()].filter((run) => run.userId === userId);
  void Promise.all(owned.map(discardRun)).then(() => {
    for (const run of owned) {
      run.chunks.length = 0;
      run.bytes = 0;
    }
    return remove();
  }).then(
    (removed) => {
      deletingUsers.delete(userId);
      resolve(removed);
    },
    (error: unknown) => {
      deletingUsers.delete(userId);
      reject(error);
    },
  );
  return promise;
}

export async function resetReplyRunsForTest() {
  await Promise.all([...runs.keys()].map(discardReplyRun));
}
