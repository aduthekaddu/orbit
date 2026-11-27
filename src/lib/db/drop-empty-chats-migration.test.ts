import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as sqliteVec from "sqlite-vec";
import { registerMigrationFunctions } from "./index";

const TAG = "0017_drop_empty_chats";
const repo = process.cwd();
const work = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR ?? "", "drop-empty-chats-"));
let db: Database.Database;
let migrationSql: string;

// The migrations folder as an install had it before this migration, or as it is now.
function migrations(name: string, upTo: "before" | "all") {
  const target = path.join(work, name);
  fs.cpSync(path.join(repo, "drizzle"), target, { recursive: true });
  if (upTo === "before") {
    const journalFile = path.join(target, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex((entry) => entry.tag === TAG);
    if (at >= 0) journal.entries = journal.entries.slice(0, at);
    fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  }
  return target;
}

function chat(id: string, title = "New chat", choice: [string, string, string] | null = null) {
  db.prepare("INSERT INTO chats (id, user_id, title, created_at, updated_at, connection_id, model, reasoning_effort) VALUES (?, 'u1', ?, 1, 1, ?, ?, ?)")
    .run(id, title, choice?.[0] ?? null, choice?.[1] ?? null, choice?.[2] ?? null);
}

function message(id: string, chatId: string, parentId: string | null, position: number, text: string) {
  db.prepare("INSERT INTO messages (id, chat_id, parent_id, role, content, parts, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
    .run(id, chatId, parentId, position % 2 === 0 ? "user" : "assistant", text, JSON.stringify([{ type: "text", text }]), position);
}

function memory(id: string, text: string, chatId: string | null, messageId: string | null) {
  db.prepare("INSERT INTO memories (id, kind, text, text_norm, source, source_chat_id, source_message_id, created_at) VALUES (?, 'fact', ?, ?, 'dream', ?, ?, 1)")
    .run(id, text, text.toLowerCase(), chatId, messageId);
}

before(() => {
  migrationSql = fs.readFileSync(path.join(repo, "drizzle", `${TAG}.sql`), "utf8");
  db = new Database(path.join(work, "orbit.db"));
  // The same connection setup as getDb in ./index.ts, so foreign key actions run during the migration.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  registerMigrationFunctions(db);
  migrate(drizzle(db), { migrationsFolder: migrations("before", "before") });

  db.prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'Old', 'old@orbit.local')").run();
  chat("empty-default");
  chat("empty-titled", "Trip plans");
  chat("empty-pinned", "New chat", ["conn-1", "fixture-model", "high"]);
  chat("kept", "Kept chat");
  message("kept-1", "kept", null, 0, "the marrowgate question");
  message("kept-2", "kept", "kept-1", 1, "the marrowgate answer");
  db.prepare("UPDATE chats SET head_id = 'kept-2' WHERE id = 'kept'").run();
  memory("from-empty", "I prefer window seats", "empty-titled", null);
  memory("from-kept", "The answer is marrowgate", "kept", "kept-2");

  migrate(drizzle(db), { migrationsFolder: migrations("after", "all") });
});

after(() => {
  db?.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test("the migration deletes chats without messages, whatever their title or model pin", () => {
  assert.deepEqual(db.prepare("SELECT id, title, head_id AS headId FROM chats ORDER BY id").all(), [{ id: "kept", title: "Kept chat", headId: "kept-2" }]);
});

test("a chat with messages keeps every message and stays searchable", () => {
  assert.deepEqual(db.prepare("SELECT id, parent_id AS parentId FROM messages WHERE chat_id = 'kept' ORDER BY position").all(), [
    { id: "kept-1", parentId: null },
    { id: "kept-2", parentId: "kept-1" },
  ]);
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
  const hits = db.prepare("SELECT messages.id AS id FROM messages_fts JOIN messages ON messages.rowid = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY id").all("marrowgate");
  assert.deepEqual(hits, [{ id: "kept-1" }, { id: "kept-2" }]);
});

test("a memory from a deleted chat stays with no source chat, and one from a kept chat keeps its source", () => {
  const foreignKey = (db.pragma("foreign_key_list(memories)") as { table: string; from: string; on_delete: string }[])
    .find((key) => key.from === "source_chat_id");
  assert.deepEqual({ table: foreignKey?.table, onDelete: foreignKey?.on_delete }, { table: "chats", onDelete: "SET NULL" });
  assert.deepEqual(db.prepare("SELECT id, text, source_chat_id AS chatId, source_message_id AS messageId FROM memories ORDER BY id").all(), [
    { id: "from-empty", text: "I prefer window seats", chatId: null, messageId: null },
    { id: "from-kept", text: "The answer is marrowgate", chatId: "kept", messageId: "kept-2" },
  ]);
  db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')").run();
});

test("running the migration again deletes nothing", () => {
  const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = changes();
  db.exec(migrationSql);
  assert.equal(changes() - before, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM chats").get() as { n: number }).n, 1);
});
