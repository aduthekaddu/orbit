import { getDb } from "../db";
import { getInstance } from "../instance-settings";
import { parseViewer, type Viewer } from "../policy";
import type { MemoryRun } from "./run-state";

export type Tonight = {
  state: MemoryRun["state"];
  startedAt: Date;
  leaseUntil: Date | null;
};

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function localStamp(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    minutes: hour * 60 + Number(pick("minute")),
  };
}

export function localMidnight(date: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  let utc = Date.UTC(year, month - 1, day);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stamp = localStamp(new Date(utc), timeZone);
    const [seenYear, seenMonth, seenDay] = stamp.date.split("-").map(Number);
    const seen = Date.UTC(seenYear, seenMonth - 1, seenDay, Math.floor(stamp.minutes / 60), stamp.minutes % 60);
    const target = Date.UTC(year, month - 1, day);
    if (seen === target) return utc;
    utc += target - seen;
  }
  return utc;
}

export function shouldStartDream(input: { now: Date; hour: number; timeZone: string; tonight: Tonight | null }): boolean {
  const stamp = localStamp(input.now, input.timeZone);
  if (stamp.minutes < input.hour * 60) return false;
  const tonight = input.tonight;
  if (!tonight) return true;
  if (tonight.state !== "running") return false;
  if (tonight.leaseUntil && tonight.leaseUntil.getTime() >= input.now.getTime()) return false;
  return true;
}

export function memoryEnabledViewers(): Viewer[] {
  return getDb().$client.prepare(
    `SELECT user.id, user.role FROM user
     LEFT JOIN user_preferences ON user_preferences.user_id = user.id
     WHERE coalesce(user_preferences.memory, 'on') = 'on'
     ORDER BY user.created_at, user.id`,
  ).all().map(parseViewer);
}

export function dueDreamViewers(now: Date): Viewer[] {
  const timeZone = systemTimeZone();
  const hour = getInstance().dreamHour;
  const { date, minutes } = localStamp(now, timeZone);
  if (minutes < hour * 60) return [];
  const run = getDb().$client.prepare(
    "SELECT state, started_at AS startedAt, lease_until AS leaseUntil FROM memory_runs WHERE user_id = ? AND date = ?",
  );
  return memoryEnabledViewers().filter((viewer) => {
    const row = run.get(viewer.id, date) as { state: Tonight["state"]; startedAt: number; leaseUntil: number | null } | undefined;
    const tonight = row ? {
      state: row.state,
      startedAt: new Date(row.startedAt),
      leaseUntil: row.leaseUntil === null ? null : new Date(row.leaseUntil),
    } : null;
    return shouldStartDream({ now, hour, timeZone, tonight });
  });
}

export function dreamSchedulerEnabled(): boolean {
  if (process.env.NEXT_PHASE === "phase-production-build") return false;
  if (process.env.npm_lifecycle_event === "build") return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  return process.env.NEXT_RUNTIME === "nodejs";
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startDreamScheduler(): void {
  if (!dreamSchedulerEnabled() || timer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const viewers = dueDreamViewers(now);
      if (viewers.length === 0) return;
      const { runDream } = await import("./dream");
      const date = localStamp(now, systemTimeZone()).date;
      for (const viewer of viewers) {
        try {
          const run = await runDream({ viewer, date });
          if (run) console.log(JSON.stringify({ dream: run.date, userId: viewer.id, state: run.state, chats: run.chatIds.length, added: run.added, merged: run.merged }));
        } catch (error) {
          console.error(JSON.stringify({ dream: "failed", userId: viewer.id, error: error instanceof Error ? error.name : "Error" }));
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ dream: "failed", error: error instanceof Error ? error.name : "Error" }));
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, 60_000);
  timer.unref();
  process.once("SIGTERM", () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  });
}
