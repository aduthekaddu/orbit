import { getDb } from "../db";
import { readEnv } from "../env";
import type { MemoryRun } from "./run-state";

export type Tonight = {
  state: MemoryRun["state"];
  startedAt: Date;
  leaseUntil: Date | null;
};

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function dreamHour(): number {
  const raw = readEnv("ORBIT_DREAM_HOUR");
  if (!raw) return 3;
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return 3;
  return hour;
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
  if (tonight.leaseUntil && tonight.leaseUntil.getTime() > input.now.getTime()) return false;
  return true;
}

function readTonight(date: string): Tonight | null {
  const row = getDb().$client
    .prepare("SELECT state, started_at AS startedAt, lease_until AS leaseUntil FROM memory_runs WHERE date = ?")
    .get(date) as { state: string; startedAt: number; leaseUntil: number | null } | undefined;
  if (!row || (row.state !== "running" && row.state !== "done" && row.state !== "failed")) return null;
  return {
    state: row.state,
    startedAt: new Date(row.startedAt),
    leaseUntil: row.leaseUntil == null ? null : new Date(row.leaseUntil),
  };
}

export function maybeDream(now: Date): boolean {
  const timeZone = systemTimeZone();
  const date = localStamp(now, timeZone).date;
  return shouldStartDream({ now, hour: dreamHour(), timeZone, tonight: readTonight(date) });
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
  const tick = () => {
    const now = new Date();
    if (!maybeDream(now)) return;
    void import("./dream")
      .then(({ runDream }) => runDream({ now }))
      .catch((error: unknown) => {
        console.log(JSON.stringify({ dream: "failed", error: error instanceof Error ? error.name : "Error" }));
      });
  };
  timer = setInterval(tick, 60_000);
  timer.unref();
  process.once("SIGTERM", () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  });
}
