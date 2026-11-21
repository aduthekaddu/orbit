import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { readEnv } from "../env";
import { dataDirectory } from "../paths";
import { stripTerminalControls } from "../sandbox/terminal";
import { withMigrationLock } from "./migration-lock";
import * as schema from "./schema";

const dataDir = dataDirectory();
// The directory holds the database and the auth secret, so group and other
// users must not be able to replace them. The mode on mkdir is masked by
// umask, hence the chmod for both a fresh and an existing directory.
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(dataDir, 0o700);

const dbPath = path.join(dataDir, "orbit.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
sqliteVec.load(sqlite);
// Migration 0004 calls this to clean saved code output the way new saves do.
sqlite.function("orbit_clean_output", { deterministic: true }, (text) => (typeof text === "string" ? stripTerminalControls(text) : null));

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

if (fs.existsSync(migrationsFolder)) {
  withMigrationLock(() => migrate(db, { migrationsFolder }), { dir: dataDir });
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
  const searxngUrl = readEnv("ORBIT_SEARXNG_URL") ?? "";
  const tavilyApiKey = readEnv("ORBIT_TAVILY_API_KEY") ?? "";
  const githubToken = readEnv("ORBIT_GITHUB_TOKEN") ?? "";
  if (!baseUrl && !apiKey && !model && !searxngUrl && !tavilyApiKey && !githubToken) return;
  db.insert(schema.settings)
    .values({
      id: 1,
      baseUrl,
      apiKey,
      searxngUrl,
      tavilyApiKey,
      githubToken,
      githubMcpUrl: "",
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
