import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dataDirectory } from "../paths";

const LOCK_NAME = ".migrate.lock.db";
const DEFAULT_TIMEOUT_MS = 60_000;

export type MigrationLockOptions = {
  dir?: string;
  timeoutMs?: number;
  /** Which lock file in `dir`. The artifact backfill takes its own, so it never blocks migrations. */
  lock?: "migrations" | "artifact-backfill";
};

/** The waiter gave up after `timeoutMs` while another process held the lock. */
export class LockTimeout extends Error {}

/**
 * Runs `run` while holding SQLite's exclusive transaction lock on a dedicated
 * database in `dir`. The OS owns the lock, so a killed owner releases it when
 * the process exits. The lock database holds no application data, and an old
 * `.migrate.lock` file from the previous implementation is ignored.
 */
export function withMigrationLock<T>(run: () => T, options: MigrationLockOptions = {}): T {
  const dir = options.dir ?? dataDirectory();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // One literal name per join, so the build's file tracing stays scoped to the lock files.
  const lockPath = options.lock === "artifact-backfill" ? path.join(dir, ".artifacts-backfill.lock.db") : path.join(dir, LOCK_NAME);
  const sqlite = openLockDatabase(lockPath);
  try {
    restrict(lockPath);
    sqlite.pragma(`busy_timeout = ${timeoutMs}`);
    try {
      sqlite.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if (isBusy(error)) throw timeoutError(timeoutMs, lockPath, error);
      throw lockFailure("Cannot acquire the database migration lock", lockPath, error);
    }
    try {
      return run();
    } finally {
      sqlite.exec("COMMIT");
    }
  } finally {
    sqlite.close();
  }
}

function openLockDatabase(lockPath: string): Database.Database {
  try {
    return new Database(lockPath);
  } catch (error) {
    throw lockFailure("Cannot open the database migration lock", lockPath, error);
  }
}

function restrict(lockPath: string): void {
  try {
    fs.chmodSync(lockPath, 0o600);
  } catch (error) {
    throw lockFailure("Cannot restrict the database migration lock", lockPath, error);
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") return true;
  return /database is locked/i.test(String((error as Error)?.message ?? error));
}

function timeoutError(timeoutMs: number, lockPath: string, cause: unknown): Error {
  return new LockTimeout(`Timed out after ${timeoutMs}ms waiting for the database migration lock at ${lockPath}`, {
    cause,
  });
}

function lockFailure(action: string, target: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code ?? String(error);
  return new Error(`${action} at ${target}: ${code}`, { cause: error });
}
