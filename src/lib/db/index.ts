import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { readEnv } from "../env";
import { dataDirectory } from "../paths";
import * as schema from "./schema";

const dataDir = dataDirectory();
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "orbit.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

function restrictDbFile(name: "orbit.db" | "orbit.db-wal" | "orbit.db-shm") {
  try {
    fs.chmodSync(path.join(dataDir, name), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

restrictDbFile("orbit.db");
restrictDbFile("orbit.db-wal");
restrictDbFile("orbit.db-shm");

export const db = drizzle(sqlite, { schema });

const migrationsFolder = path.join(process.cwd(), "drizzle");

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withMigrationLock<T>(run: () => T): T {
  const lockPath = path.join(dataDir, ".migrate.lock");
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return run();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another process already removed a stale lock.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the database migration lock");
      sleep(50);
    }
  }
}

if (fs.existsSync(migrationsFolder)) {
  withMigrationLock(() => migrate(db, { migrationsFolder }));
}

sqlite.exec(`
  CREATE TRIGGER IF NOT EXISTS user_single_row
  BEFORE INSERT ON user
  WHEN (SELECT COUNT(*) FROM user) >= 1
  BEGIN
    SELECT RAISE(ABORT, 'signup closed');
  END;
`);

function seedSettings() {
  const existing = db.select({ id: schema.settings.id }).from(schema.settings).where(eq(schema.settings.id, 1)).get();
  if (existing) return;
  const baseUrl = readEnv("ORBIT_BASE_URL") ?? "";
  const apiKey = readEnv("ORBIT_API_KEY") ?? "";
  const model = readEnv("ORBIT_MODEL") ?? "";
  if (!baseUrl && !apiKey && !model) return;
  db.insert(schema.settings)
    .values({
      id: 1,
      baseUrl,
      apiKey,
      model,
      reasoningEffort: "medium",
      updatedAt: new Date(),
    })
    .run();
}

seedSettings();

export function signupOpen() {
  const row = sqlite.prepare("select count(*) as n from user").get() as { n: number };
  return row.n === 0;
}
