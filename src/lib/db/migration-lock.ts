import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDirectory } from "../paths";

const LOCK_NAME = ".migrate.lock";
const CLAIM_NAME = ".migrate.lock.claim";
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_MS = 50;
// The lock and claim paths are published by hard link, so a new owner never
// exposes an empty file. Only a leftover from the old create-then-write lock
// (or an external writer) can be empty or truncated; give that a short grace
// before treating it as dead.
const LEGACY_EMPTY_GRACE_MS = 1_000;
const TOKEN = /^(\d+):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MigrationLockOptions = {
  dir?: string;
  timeoutMs?: number;
};

type LockState =
  | { kind: "absent" }
  | { kind: "unwritten"; ageMs: number }
  | { kind: "held"; pid: number; token: string };

type LockPaths = {
  lock: string;
  claim: string;
};

/**
 * Runs `run` while holding an exclusive lock in `dir`.
 *
 * The lock file holds the owner's pid and a random token. The token is written
 * to a temp file that is hard-linked into place, so the path appears complete
 * and a paused owner is never seen as an empty, stale lock. A waiter takes
 * over only when the owner pid is gone, so a migration of any length keeps
 * its lock, and a takeover happens under a claim file so exactly one waiter
 * can delete a dead lock. Liveness is the owner pid, which assumes one host
 * (or pid namespace) per data directory. Release unlinks only a file that
 * still carries the caller's token, so an owner never deletes its
 * successor's lock.
 */
export function withMigrationLock<T>(run: () => T, options: MigrationLockOptions = {}): T {
  const dir = options.dir ?? dataDirectory();
  const paths = { lock: path.join(dir, LOCK_NAME), claim: path.join(dir, CLAIM_NAME) };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = acquire(paths, timeoutMs);
  try {
    return run();
  } finally {
    releaseOwned(paths.lock, token);
  }
}

function acquire(paths: LockPaths, timeoutMs: number): string {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    checkDeadline(deadline, timeoutMs, paths.lock);
    try {
      publish(paths.lock, token);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw lockFailure("Cannot create the database migration lock", paths.lock, error);
      }
    }
    const state = inspect(paths.lock);
    if (state.kind === "absent") continue;
    if (isStale(state)) {
      takeOver(paths, timeoutMs, deadline);
      continue;
    }
    pause(deadline, timeoutMs, paths.lock);
  }
}

function takeOver(paths: LockPaths, timeoutMs: number, deadline: number): void {
  const claimToken = claim(paths, timeoutMs, deadline);
  try {
    const state = inspect(paths.lock);
    if (state.kind !== "absent" && isStale(state)) {
      unlinkOrThrow("Cannot remove the stale database migration lock", paths.lock);
    }
  } finally {
    releaseOwned(paths.claim, claimToken);
  }
}

/**
 * Wins the right to remove a dead lock. Only one process can hold the claim,
 * and the holder re-reads the lock before deleting it, so a waiter cannot
 * unlink a live lock that appeared after its first look.
 */
function claim(paths: LockPaths, timeoutMs: number, deadline: number): string {
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    checkDeadline(deadline, timeoutMs, paths.lock);
    try {
      publish(paths.claim, token);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw lockFailure("Cannot create the database migration lock claim", paths.claim, error);
      }
    }
    const state = inspect(paths.claim);
    if (state.kind === "absent") continue;
    if (!isStale(state)) {
      pause(deadline, timeoutMs, paths.lock);
      continue;
    }
    unlinkOrThrow("Cannot remove the stale database migration lock claim", paths.claim);
  }
}

/**
 * Writes `token` to a temp file and hard-links it to `target`. The link fails
 * with EEXIST when the target exists, and succeeds atomically with the token
 * already readable, so a reader never sees an empty live lock.
 */
function publish(target: string, token: string): void {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    created = true;
    try {
      fs.writeSync(fd, token);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(temp, target);
  } finally {
    if (created) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // A crash here leaves one temp name; the target still has the token.
      }
    }
  }
}

function inspect(target: string): LockState {
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw lockFailure("Cannot read the database migration lock", target, error);
  }
  const token = raw.trim();
  const match = TOKEN.exec(token);
  if (match) return { kind: "held", pid: Number(match[1]), token };
  try {
    return { kind: "unwritten", ageMs: Date.now() - fs.statSync(target).mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw lockFailure("Cannot stat the database migration lock", target, error);
  }
}

function isStale(state: Exclude<LockState, { kind: "absent" }>): boolean {
  if (state.kind === "held") return !isProcessAlive(state.pid);
  return state.ageMs >= LEGACY_EMPTY_GRACE_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pause(deadline: number, timeoutMs: number, lockPath: string): void {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError(timeoutMs, lockPath);
  sleep(Math.min(POLL_MS, remaining));
}

function checkDeadline(deadline: number, timeoutMs: number, lockPath: string): void {
  if (Date.now() > deadline) throw timeoutError(timeoutMs, lockPath);
}

function timeoutError(timeoutMs: number, lockPath: string): Error {
  return new Error(`Timed out after ${timeoutMs}ms waiting for the database migration lock at ${lockPath}`);
}

function lockFailure(action: string, target: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code ?? String(error);
  return new Error(`${action} at ${target}: ${code}`, { cause: error });
}

function unlinkOrThrow(action: string, target: string): void {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw lockFailure(action, target, error);
  }
}

function releaseOwned(target: string, token: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    return;
  }
  if (raw.trim() !== token) return;
  try {
    fs.unlinkSync(target);
  } catch {
    // The next holder sees this pid gone and takes the lock over.
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
