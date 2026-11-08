import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { startMockOllama } from "./ollama-harness";

const require = createRequire(import.meta.url);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-memory-store-"));
process.env.ORBIT_DATA_DIR = dataDir;
delete process.env.ORBIT_OLLAMA_URL;

type StoreModule = typeof import("./store");
type EmbedModule = typeof import("./embed");

let store: StoreModule | undefined;
let embed: EmbedModule | undefined;
let importError = "";
let mock: { url: string; stop: () => Promise<void> } | undefined;

before(async () => {
  try {
    store = await import("./store");
    embed = await import("./embed");
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
  if (store && embed) {
    mock = await startMockOllama();
    process.env.ORBIT_OLLAMA_URL = mock.url;
  }
});

after(async () => {
  await mock?.stop();
});

function requireStore() {
  assert.equal(importError, "", `memory store is missing: ${importError}`);
  if (!store || !embed) throw new Error("memory store is missing");
  return { store, embed };
}

test("an existing database gains memory tables and keeps its user", () => {
  const folder = path.join(process.cwd(), "drizzle");
  const names = fs.readdirSync(folder).filter((name) => name.endsWith(".sql")).sort();
  const memory = names.find((name) => {
    const sql = fs.readFileSync(path.join(folder, name), "utf8");
    return sql.includes("memories_vec") && sql.includes("memories_fts");
  });
  assert.ok(memory, "memories migration is missing");
  const older = names.filter((name) => name < memory);
  const file = path.join(os.tmpdir(), `orbit-memory-migrate-${process.pid}.db`);
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.function("orbit_clean_output", (text: unknown) => (typeof text === "string" ? text : null));
  for (const name of older) {
    for (const statement of fs.readFileSync(path.join(folder, name), "utf8").split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql) db.exec(sql);
    }
  }
  db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)").run("user-old", "Old", "old@orbit.local");
  const sqliteVec = require("sqlite-vec") as { load: (database: Database.Database) => void };
  sqliteVec.load(db);
  for (const statement of fs.readFileSync(path.join(folder, memory), "utf8").split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) db.exec(sql);
  }
  const user = db.prepare("SELECT email FROM user WHERE id = ?").get("user-old") as { email: string };
  assert.equal(user.email, "old@orbit.local");
  assert.equal((db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n, 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memories_fts'").get() == null, false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memories_vec'").get() == null, false);
  db.close();
});

test("an older memories table keeps its vector when it gains a stable rowid", () => {
  const folder = path.join(process.cwd(), "drizzle");
  const names = fs.readdirSync(folder).filter((name) => name.endsWith(".sql")).sort();
  const stable = names.find((name) => fs.readFileSync(path.join(folder, name), "utf8").includes("memories_stable") || fs.readFileSync(path.join(folder, name), "utf8").includes("__new_memories"));
  assert.ok(stable, "stable rowid migration is missing");
  const older = names.filter((name) => name < stable);
  const file = path.join(os.tmpdir(), `orbit-memory-rowid-${process.pid}.db`);
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.function("orbit_clean_output", (text: unknown) => (typeof text === "string" ? text : null));
  const sqliteVec = require("sqlite-vec") as { load: (database: Database.Database) => void };
  sqliteVec.load(db);
  for (const name of older) {
    for (const statement of fs.readFileSync(path.join(folder, name), "utf8").split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql) db.exec(sql);
    }
  }
  db.prepare("INSERT INTO memories (id, kind, text, text_norm, created_at) VALUES (?, 'fact', ?, ?, 1)").run("mem-old", "Keep the oldrow token", "keep the oldrow token");
  const before = db.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get("mem-old") as { rowid: number };
  const vector = Buffer.from(new Float32Array(Array.from({ length: 768 }, () => 0.25)).buffer);
  db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (cast(? AS integer), ?)").run(before.rowid, vector);
  for (const statement of fs.readFileSync(path.join(folder, stable), "utf8").split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) db.exec(sql);
  }
  const pk = db.prepare("SELECT type AS type FROM pragma_table_info('memories') WHERE pk = 1").get() as { type: string };
  assert.equal(pk.type, "INTEGER");
  const after = db.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get("mem-old") as { rowid: number };
  assert.equal(after.rowid, before.rowid);
  db.exec("VACUUM");
  const vacuumed = db.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get("mem-old") as { rowid: number };
  assert.equal(vacuumed.rowid, before.rowid);
  const joined = db.prepare("SELECT memories.text AS text FROM memories_vec JOIN memories ON memories.rowid = memories_vec.rowid WHERE memories.id = ?").get("mem-old") as { text: string };
  assert.equal(joined.text, "Keep the oldrow token");
  const found = db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get('"oldrow"') as { n: number };
  assert.equal(found.n, 1);
  db.prepare("INSERT INTO memories (id, kind, text, text_norm, created_at) VALUES (?, 'fact', ?, ?, 2)").run("mem-new", "A newrow token after the move", "a newrow token after the move");
  const added = db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get('"newrow"') as { n: number };
  assert.equal(added.n, 1);
  db.close();
});

test("vectors made without task prefixes are cleared and the memory stays", () => {
  const folder = path.join(process.cwd(), "drizzle");
  const names = fs.readdirSync(folder).filter((name) => name.endsWith(".sql")).sort();
  const reembed = names.find((name) => name.includes("memories_reembed"));
  assert.ok(reembed, "re-embed migration is missing");
  const file = path.join(os.tmpdir(), `orbit-memory-reembed-${process.pid}.db`);
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.function("orbit_clean_output", (text: unknown) => (typeof text === "string" ? text : null));
  const sqliteVec = require("sqlite-vec") as { load: (database: Database.Database) => void };
  sqliteVec.load(db);
  for (const name of names.filter((name) => name < reembed)) {
    for (const statement of fs.readFileSync(path.join(folder, name), "utf8").split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql) db.exec(sql);
    }
  }
  db.prepare("INSERT INTO memories (id, kind, text, text_norm, created_at) VALUES (?, 'fact', ?, ?, 1)").run("mem-plain", "Saved before the prefixes", "saved before the prefixes");
  const row = db.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get("mem-plain") as { rowid: number };
  const vector = Buffer.from(new Float32Array(Array.from({ length: 768 }, () => 0.25)).buffer);
  db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (cast(? AS integer), ?)").run(row.rowid, vector);
  for (const statement of fs.readFileSync(path.join(folder, reembed), "utf8").split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) db.exec(sql);
  }
  assert.equal((db.prepare("SELECT count(*) AS n FROM memories WHERE id = ?").get("mem-plain") as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM memories_vec").get() as { n: number }).n, 0);
  db.close();
});

test("a memory's vector stays on that memory after vacuum", async () => {
  const { store, embed } = requireStore();
  const saved = store.saveMemory({ text: "Vacuum keeps the vectorkey token", kind: "fact" });
  assert.equal((await embed.embedPending()).ok, true);
  const { db } = await import("../db");
  const pk = db.$client.prepare("SELECT type AS type FROM pragma_table_info('memories') WHERE pk = 1").get() as { type: string };
  assert.equal(pk.type, "INTEGER");
  const before = db.$client.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get(saved.id) as { rowid: number };
  db.$client.exec("VACUUM");
  const after = db.$client.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get(saved.id) as { rowid: number };
  assert.equal(after.rowid, before.rowid);
  const joined = db.$client.prepare("SELECT memories.text AS text FROM memories_vec JOIN memories ON memories.rowid = memories_vec.rowid WHERE memories.id = ?").get(saved.id) as { text: string };
  assert.equal(joined.text, "Vacuum keeps the vectorkey token");
});

test("save stores a memory and a repeated fact returns the same id", () => {
  const { store } = requireStore();
  const first = store.saveMemory({ text: "I deploy to Fly.io", kind: "fact" });
  const second = store.saveMemory({ text: "  i   deploy   to fly.io ", kind: "preference" });
  assert.equal(second.id, first.id);
  assert.equal(second.kind, "fact");
  assert.equal(second.text, "I deploy to Fly.io");
  assert.equal(store.listMemories().filter((memory) => memory.id === first.id).length, 1);
});

test("memory text longer than 500 characters is refused", () => {
  const { store } = requireStore();
  assert.throws(() => store.saveMemory({ text: "a".repeat(501), kind: "fact" }), /500/);
  assert.throws(() => store.saveMemory({ text: "   ", kind: "fact" }), /empty/i);
});

test("full text search finds a saved memory", () => {
  const { store } = requireStore();
  const saved = store.saveMemory({ text: "The zebramemory lives in the north", kind: "fact" });
  const hits = store.listMemories("zebramemory");
  assert.deepEqual(hits.map((memory) => memory.id), [saved.id]);
  assert.equal(store.listMemories("notawordinhere").length, 0);
});

test("delete removes the memory from the table, the text index, and the vector index", async () => {
  const { store, embed } = requireStore();
  const saved = store.saveMemory({ text: "Please deletememorytoken today", kind: "summary" });
  const filled = await embed.embedPending();
  assert.equal(filled.ok, true);
  const embedded = store.getMemory(saved.id);
  assert.equal(embedded?.embedded, true);
  const { db } = await import("../db");
  const located = db.$client.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get(saved.id) as { rowid: number };
  assert.equal(store.deleteMemory(saved.id), true);
  assert.equal(store.getMemory(saved.id), null);
  assert.equal(store.listMemories("deletememorytoken").length, 0);
  const row = db.$client.prepare("SELECT count(*) AS n FROM memories_vec WHERE rowid = cast(? AS integer)").get(located.rowid) as { n: number };
  const indexed = db.$client.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get('"deletememorytoken"') as { n: number };
  assert.equal(indexed.n, 0);
  assert.equal(row.n, 0);
});

test("editing the text clears the vector until embeddings run again", async () => {
  const { store, embed } = requireStore();
  const saved = store.saveMemory({ text: "Original embedclear token", kind: "fact" });
  assert.equal((await embed.embedPending()).ok, true);
  const updated = store.updateMemory(saved.id, { text: "Rewritten embedclear token", kind: "preference" });
  assert.equal(updated?.kind, "preference");
  assert.equal(updated?.embedded, false);
  assert.equal(store.listMemories("Original").length, 0);
  assert.equal(store.listMemories("Rewritten").length, 1);
  assert.equal((await embed.embedPending()).ok, true);
  assert.equal(store.getMemory(saved.id)?.embedded, true);
});

test("a vector for the old text does not mark the rewritten text as embedded", async () => {
  const { store } = requireStore();
  const saved = store.saveMemory({ text: "Stale vector token original", kind: "fact" });
  const { db } = await import("../db");
  const located = db.$client.prepare("SELECT rowid AS rowid FROM memories WHERE id = ?").get(saved.id) as { rowid: number };
  const vector = Array.from({ length: 768 }, () => 0);
  vector[0] = 1;
  store.updateMemory(saved.id, { text: "Stale vector token rewritten", kind: "fact" });
  store.writeVectors([{ rowid: located.rowid, text: "Stale vector token original", vector }]);
  assert.equal(store.getMemory(saved.id)?.embedded, false);
  store.writeVectors([{ rowid: located.rowid, text: "Stale vector token rewritten", vector }]);
  assert.equal(store.getMemory(saved.id)?.embedded, true);
});

test("remember keeps the chat when the message id is missing", async () => {
  const { store } = requireStore();
  const { db } = await import("../db");
  const schema = await import("../db/schema");
  const { rememberFact } = await import("../tools/memory");
  const now = new Date();
  db.insert(schema.user).values({ id: "mem-user", name: "Mem", email: "mem-user@orbit.local", emailVerified: true }).run();
  db.insert(schema.chats).values({ id: "mem-chat", userId: "mem-user", title: "Host", createdAt: now, updatedAt: now }).run();
  const saved = rememberFact({ chatId: "mem-chat", messageId: "missing-message" }, { text: "Remember the chat link token", kind: "fact" });
  assert.equal("id" in saved, true);
  const memory = store.getMemory("id" in saved ? saved.id : "");
  assert.equal(memory?.sourceChatId, "mem-chat");
  assert.equal(memory?.sourceMessageId, null);
});
