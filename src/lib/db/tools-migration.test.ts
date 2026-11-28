import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as sqliteVec from "sqlite-vec";
import { registerMigrationFunctions } from "./index";

type Journal = { entries: { tag: string }[] };

const repo = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-tools-migration-"));
let db: Database.Database;

// The tools migration is the first one that names the new table or column. Every entry before it is what an
// install had before Slice 19. Until that migration exists, the whole journal counts as before it.
function journalBeforeTools(journal: Journal): Journal["entries"] {
  const first = journal.entries.findIndex((entry) => /\btool_status\b|\bdisabled_tools\b/.test(fs.readFileSync(path.join(repo, "drizzle", `${entry.tag}.sql`), "utf8")));
  return first < 0 ? journal.entries : journal.entries.slice(0, first);
}

function migrations(name: string, upTo: "before-tools" | "all") {
  const target = path.join(work, name);
  fs.cpSync(path.join(repo, "drizzle"), target, { recursive: true });
  if (upTo === "before-tools") {
    const journalFile = path.join(target, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as Journal;
    fs.writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journalBeforeTools(journal) }, null, 2));
  }
  return target;
}

before(() => {
  db = new Database(path.join(work, "orbit.db"));
  // The same connection setup as getDb in ./index.ts, so foreign key actions run during the migration.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  registerMigrationFunctions(db);
  migrate(drizzle(db), { migrationsFolder: migrations("before-tools", "before-tools") });

  db.prepare("INSERT INTO user (id, name, email, role) VALUES ('admin', 'Admin', 'admin@orbit.test', 'admin')").run();
  db.prepare("INSERT INTO user (id, name, email, role) VALUES ('member', 'Member', 'member@orbit.test', 'member')").run();
  db.prepare("INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES ('old-chat', 'admin', 'Trip plans', 1, 2)").run();

  migrate(drizzle(db), { migrationsFolder: migrations("after", "all") });
});

after(() => {
  db?.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test("a chat saved before the upgrade keeps its row and gets every tool turned on", () => {
  assert.deepEqual(db.prepare("SELECT id, user_id AS userId, title, updated_at AS updatedAt, disabled_tools AS disabledTools FROM chats").all(), [
    { id: "old-chat", userId: "admin", title: "Trip plans", updatedAt: 2, disabledTools: "[]" },
  ]);
  const column = (db.pragma("table_info(chats)") as { name: string; notnull: number; dflt_value: string | null }[]).find((entry) => entry.name === "disabled_tools");
  assert.deepEqual({ notnull: column?.notnull, default: column?.dflt_value }, { notnull: 1, default: "'[]'" });
  db.prepare("INSERT INTO chats (id, user_id, created_at, updated_at) VALUES ('new-chat', 'member', 3, 3)").run();
  assert.equal(db.prepare("SELECT disabled_tools FROM chats WHERE id = 'new-chat'").pluck().get(), "[]");
});

test("tool_status keeps one row per account and tool, with nullable times and error", () => {
  const columns = (db.pragma("table_info(tool_status)") as { name: string; notnull: number; pk: number }[])
    .map(({ name, notnull, pk }) => ({ name, notnull, pk }));
  assert.deepEqual(columns, [
    { name: "user_id", notnull: 1, pk: 1 },
    { name: "tool_id", notnull: 1, pk: 2 },
    { name: "last_ok_at", notnull: 0, pk: 0 },
    { name: "last_failed_at", notnull: 0, pk: 0 },
    { name: "last_error", notnull: 0, pk: 0 },
  ]);
  db.prepare("INSERT INTO tool_status (user_id, tool_id, last_ok_at) VALUES ('admin', 'web_search', 10)").run();
  assert.throws(() => db.prepare("INSERT INTO tool_status (user_id, tool_id, last_failed_at) VALUES ('admin', 'web_search', 11)").run(), /UNIQUE|PRIMARY KEY/);
  assert.throws(() => db.prepare("INSERT INTO tool_status (user_id, tool_id) VALUES ('nobody', 'memory')").run(), /FOREIGN KEY/);
});

test("deleting an account deletes its tool status and leaves other accounts' rows", () => {
  db.prepare("INSERT INTO tool_status (user_id, tool_id, last_failed_at, last_error) VALUES ('member', 'github', 12, 'GitHub rejected the token.')").run();
  db.prepare("INSERT INTO tool_status (user_id, tool_id, last_ok_at) VALUES ('member', 'memory', 13)").run();
  db.prepare("DELETE FROM user WHERE id = 'member'").run();
  assert.deepEqual(db.prepare("SELECT user_id AS userId, tool_id AS toolId FROM tool_status ORDER BY tool_id").all(), [{ userId: "admin", toolId: "web_search" }]);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});
