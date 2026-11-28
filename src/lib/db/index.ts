import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { count, eq } from "drizzle-orm";
import { readEnv } from "../env";
import { parseEnvDreamHour } from "../memory/dream-hour";
import { dataDirectory } from "../paths";
import { stripTerminalControls } from "../sandbox/terminal";
import { encryptSecret, TAVILY_AAD } from "../secrets";
import { withMigrationLock } from "./migration-lock";
import * as schema from "./schema";

function restrictDbFile(dataDir: string, name: "orbit.db" | "orbit.db-wal" | "orbit.db-shm") {
  try {
    fs.chmodSync(path.join(dataDir, name), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function seedInstanceSettings(db: ReturnType<typeof drizzle<typeof schema>>) {
  const table = schema.instanceSettings;
  if (db.select({ id: table.id }).from(table).where(eq(table.id, 1)).get()) return;
  db.insert(table).values({
    id: 1,
    searxngUrl: readEnv("ORBIT_SEARXNG_URL") ?? "",
    tavilyKeyCiphertext: encryptSecret(readEnv("ORBIT_TAVILY_API_KEY") ?? "", TAVILY_AAD),
    dreamHour: parseEnvDreamHour(),
    updatedAt: new Date(),
  }).onConflictDoNothing().run();
}

/** The label of a provider moved out of settings. It never throws, so a saved URL that does not parse cannot block the upgrade. */
export function urlHostLabel(raw: unknown): string {
  try {
    return (typeof raw === "string" && new URL(raw).host) || "Provider";
  } catch {
    return "Provider";
  }
}

/** The SQL functions the migrations call. They must exist on the connection before migrate runs. */
export function registerMigrationFunctions(sqlite: Database.Database) {
  // Migration 0004 calls this to clean saved code output the way new saves do.
  sqlite.function("orbit_clean_output", { deterministic: true }, (text) => (typeof text === "string" ? stripTerminalControls(text) : null));
  // Migration 0014 calls these to move the provider key out of settings, encrypted.
  sqlite.function("orbit_encrypt_secret", (text) => (typeof text === "string" ? encryptSecret(text) : null));
  sqlite.function("orbit_url_host", { deterministic: true }, urlHostLabel);
  sqlite.function("orbit_encrypt_field", (text, aad) => typeof text === "string" && typeof aad === "string" ? encryptSecret(text, aad) : null);
  sqlite.function("orbit_env_dream_hour", parseEnvDreamHour);
}

const SCRUB_PENDING = 1;

// Migrations 0015 and 0018 set SCRUB_PENDING in the same transaction that removes plaintext credential columns.
// SQLite leaves the old bytes in free space and the WAL, so every open scrubs until a checkpoint copies the whole WAL
// back, which also covers a crash between the migration and the scrub, and a reader that kept the checkpoint busy.
function scrubDroppedSecrets(sqlite: Database.Database) {
  if (sqlite.pragma("user_version", { simple: true }) !== SCRUB_PENDING) return;
  sqlite.exec("VACUUM");
  const [checkpoint] = sqlite.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
  if (checkpoint.busy === 0 && checkpoint.log === checkpoint.checkpointed) sqlite.pragma("user_version = 0");
}

export function migrateAndScrub(db: ReturnType<typeof drizzle<typeof schema>>, sqlite: Database.Database, migrationsFolder: string) {
  migrate(db, { migrationsFolder });
  scrubDroppedSecrets(sqlite);
}

function openDb() {
  const dataDir = dataDirectory();
  // The directory holds the database and the auth secret, so group and other
  // users must not be able to replace them. The mode on mkdir is masked by
  // umask, hence the chmod for both a fresh and an existing directory.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  const dbPath = path.join(dataDir, "orbit.db");
  const sqlite = new Database(dbPath, { timeout: 5000 });
  try {
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqliteVec.load(sqlite);
    registerMigrationFunctions(sqlite);

    restrictDbFile(dataDir, "orbit.db");
    restrictDbFile(dataDir, "orbit.db-wal");
    restrictDbFile(dataDir, "orbit.db-shm");

    const db = drizzle(sqlite, { schema });
    const migrationsFolder = path.join(process.cwd(), "drizzle");

    if (fs.existsSync(migrationsFolder)) {
      withMigrationLock(() => migrateAndScrub(db, sqlite, migrationsFolder), { dir: dataDir });
    }

    seedInstanceSettings(db);
    return db;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type OrbitDb = ReturnType<typeof openDb>;

let cached: OrbitDb | undefined;

export function getDb(): OrbitDb {
  cached ??= openDb();
  return cached;
}

export function accountCount(db: Pick<OrbitDb, "select"> = getDb()) {
  return db.select({ count: count() }).from(schema.user).get()?.count ?? 0;
}
