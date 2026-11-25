import { z } from "zod";
import type { EmbedPendingResult } from "./embed";

export const DREAM_LEASE_MS = 2 * 60 * 1000;

type RunProgress = {
  date: string;
  startedAt: Date;
  chatIds: string[];
  doneChatIds: string[];
  retryChatIds: string[];
  added: number;
  merged: number;
};

export type MemoryRun =
  | (RunProgress & { state: "running"; owner: string; leaseUntil: Date; finishedAt: null; error: null })
  | (RunProgress & { state: "done"; owner: string | null; leaseUntil: Date | null; finishedAt: Date; error: null })
  | (RunProgress & { state: "failed"; owner: string | null; leaseUntil: Date | null; finishedAt: Date; error: string });

export type RunningRun = Extract<MemoryRun, { state: "running" }>;

export type EmbeddedAll = Extract<EmbedPendingResult, { ok: true }>;

export type RunEvent =
  | { type: "claim"; date: string; owner: string; at: Date; chatIds: string[] }
  | { type: "reopen"; owner: string; at: Date }
  | { type: "renew"; owner: string; at: Date }
  | { type: "chat"; owner: string; chatId: string; outcome: "done" | "retry"; added: number; merged: number }
  | { type: "done"; owner: string; at: Date; embedded: EmbeddedAll }
  | { type: "fail"; owner: string; at: Date; error: string };

export function unfinishedChatIds(run: MemoryRun): string[] {
  return run.chatIds.filter((id) => !run.doneChatIds.includes(id) && !run.retryChatIds.includes(id));
}

function union(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function owned(run: MemoryRun | null, owner: string): run is RunningRun {
  return run?.state === "running" && run.owner === owner;
}

// The only place a run changes. Returns null when the event does not apply, and then nothing is written.
export function transition(run: MemoryRun | null, event: RunEvent): MemoryRun | null {
  switch (event.type) {
    case "claim":
      if (!run) {
        return {
          date: event.date,
          state: "running",
          startedAt: event.at,
          finishedAt: null,
          owner: event.owner,
          leaseUntil: new Date(event.at.getTime() + DREAM_LEASE_MS),
          chatIds: event.chatIds,
          doneChatIds: [],
          retryChatIds: [],
          added: 0,
          merged: 0,
          error: null,
        };
      }
      if (run.state !== "running" || run.leaseUntil.getTime() >= event.at.getTime()) return null;
      return { ...run, owner: event.owner, leaseUntil: new Date(event.at.getTime() + DREAM_LEASE_MS) };
    case "reopen":
      if (run?.state !== "failed") return null;
      return {
        ...run,
        state: "running",
        owner: event.owner,
        leaseUntil: new Date(event.at.getTime() + DREAM_LEASE_MS),
        finishedAt: null,
        error: null,
        retryChatIds: [],
      };
    case "renew":
      if (!owned(run, event.owner)) return null;
      return { ...run, leaseUntil: new Date(Math.max(event.at.getTime(), run.startedAt.getTime()) + DREAM_LEASE_MS) };
    case "chat":
      if (!owned(run, event.owner)) return null;
      return {
        ...run,
        doneChatIds: event.outcome === "done" ? union(run.doneChatIds, [event.chatId]) : run.doneChatIds,
        retryChatIds: event.outcome === "retry" ? union(run.retryChatIds, [event.chatId]) : run.retryChatIds,
        added: run.added + event.added,
        merged: run.merged + event.merged,
      };
    case "done":
      // event.embedded is the proof that the final embed pass succeeded, so a run cannot be marked done before it.
      if (!owned(run, event.owner) || unfinishedChatIds(run).length > 0) return null;
      return { ...run, state: "done", finishedAt: event.at, error: null };
    case "fail":
      if (!owned(run, event.owner)) return null;
      return {
        ...run,
        state: "failed",
        finishedAt: event.at,
        error: event.error,
        retryChatIds: union(run.retryChatIds, run.chatIds.filter((id) => !run.doneChatIds.includes(id))),
      };
  }
}

const idList = z
  .string()
  .transform((value): unknown => JSON.parse(value))
  .pipe(z.array(z.string()));

const stamp = z.number().transform((value) => new Date(value));

const progress = {
  date: z.string(),
  startedAt: stamp,
  chatIds: idList,
  doneChatIds: idList,
  retryChatIds: idList,
  added: z.number(),
  merged: z.number(),
};

const storedRun = z.discriminatedUnion("state", [
  z.object({ ...progress, state: z.literal("running"), owner: z.string(), leaseUntil: stamp, finishedAt: z.null(), error: z.null() }),
  z.object({ ...progress, state: z.literal("done"), owner: z.string().nullable(), leaseUntil: stamp.nullable(), finishedAt: stamp, error: z.null() }),
  z.object({ ...progress, state: z.literal("failed"), owner: z.string().nullable(), leaseUntil: stamp.nullable(), finishedAt: stamp, error: z.string() }),
]);

export function parseRun(row: unknown): MemoryRun {
  return storedRun.parse(row);
}

export function storedRow(run: MemoryRun) {
  return {
    date: run.date,
    state: run.state,
    startedAt: run.startedAt.getTime(),
    finishedAt: run.finishedAt?.getTime() ?? null,
    owner: run.owner,
    leaseUntil: run.leaseUntil?.getTime() ?? null,
    chatIds: JSON.stringify(run.chatIds),
    doneChatIds: JSON.stringify(run.doneChatIds),
    retryChatIds: JSON.stringify(run.retryChatIds),
    added: run.added,
    merged: run.merged,
    error: run.error,
  };
}
