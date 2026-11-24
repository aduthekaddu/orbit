import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

function apply(db: Database.Database, name: string) {
  db.exec(fs.readFileSync(path.join(process.cwd(), "drizzle", name), "utf8"));
}

function chat(db: Database.Database, id: string) {
  db.prepare("INSERT INTO chats (id, user_id, created_at, updated_at) VALUES (?, 'u1', 1, 1)").run(id);
}

function message(db: Database.Database, id: string, chatId: string, position: number, text: string) {
  db.prepare("INSERT INTO messages (id, chat_id, role, content, parts, position, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)")
    .run(id, chatId, position % 2 === 0 ? "user" : "assistant", text, JSON.stringify([{ type: "text", text }]), position);
}

function databaseAt(migrations: string[]) {
  const db = new Database(":memory:");
  for (const name of migrations) apply(db, name);
  db.prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'Old', 'old@orbit.local')").run();
  return db;
}

test("the branch migration makes each chat's last message its head and leaves an empty chat without one", (t) => {
  const db = databaseAt(["0000_init.sql"]);
  t.after(() => db.close());
  chat(db, "empty");
  chat(db, "one");
  chat(db, "two");
  message(db, "two-1", "two", 0, "first question");
  message(db, "one-1", "one", 0, "only question");
  message(db, "two-2", "two", 1, "first answer");
  apply(db, "0001_branches.sql");
  assert.deepEqual(db.prepare("SELECT id, head_id FROM chats ORDER BY id").all(), [
    { id: "empty", head_id: null },
    { id: "one", head_id: "one-1" },
    { id: "two", head_id: "two-2" },
  ]);
  assert.deepEqual(db.prepare("SELECT id, parent_id FROM messages ORDER BY id").all(), [
    { id: "one-1", parent_id: null },
    { id: "two-1", parent_id: null },
    { id: "two-2", parent_id: "two-1" },
  ]);
});

test("the search migration indexes messages saved before it", (t) => {
  const db = databaseAt(["0000_init.sql", "0001_branches.sql"]);
  t.after(() => db.close());
  chat(db, "c1");
  message(db, "old", "c1", 0, "the zebracorn sleeps");
  message(db, "other", "c1", 1, "nothing to see");
  apply(db, "0002_messages_fts.sql");
  const hits = db
    .prepare("SELECT messages.id FROM messages_fts JOIN messages ON messages.rowid = messages_fts.rowid WHERE messages_fts MATCH ?")
    .all("zebracorn");
  assert.deepEqual(hits, [{ id: "old" }]);
});
