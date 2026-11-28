import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as sqliteVec from "sqlite-vec";
import { dataDirectory } from "../paths";
import { registerMigrationFunctions } from "./index";

const repo = path.resolve("drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(repo, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
// Found by tag suffix, never by number, so the test survives a rebase onto another slice's migration.
const schemaAt = journal.entries.findIndex((entry) => entry.tag.endsWith("_artifacts"));
const ftsAt = journal.entries.findIndex((entry) => entry.tag.endsWith("_artifacts_fts"));

let work: string;
let db: Database.Database;

function migrationsBefore(index: number) {
  const target = path.join(work, "drizzle-before");
  fs.cpSync(repo, target, { recursive: true });
  const file = path.join(target, "meta", "_journal.json");
  fs.writeFileSync(file, JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }));
  return target;
}

before(() => {
  work = fs.mkdtempSync(path.join(dataDirectory(), "artifacts-migration-"));
  db = new Database(path.join(work, "orbit.db"));
  // The same connection setup as getDb, so foreign key actions run while the migrations do.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  registerMigrationFunctions(db);
});

after(() => {
  db?.close();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

const html = "```html\n<title>Legacy page</title>\n```";

function snapshot() {
  return {
    chats: db.prepare("SELECT * FROM chats ORDER BY id").all(),
    messages: db.prepare("SELECT * FROM messages ORDER BY id").all(),
    search: db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'legacy'").pluck().all(),
    settings: db.prepare("SELECT id, hosting_mode, signup_mode, searxng_url, dream_hour, updated_at FROM instance_settings").all(),
    users: db.prepare("SELECT id, role FROM user").all(),
  };
}

function ftsCheck() {
  db.prepare("INSERT INTO artifacts_fts(artifacts_fts, rank) VALUES ('integrity-check', 1)").run();
}

const hits = (word: string) => db.prepare("SELECT count(*) FROM artifacts_fts WHERE artifacts_fts MATCH ?").pluck().get(`"${word}"`);

test("an install from before Slice 21 upgrades with its chats, messages, and settings intact", () => {
  assert.ok(schemaAt > 0, "drizzle/meta/_journal.json has a migration tagged _artifacts");
  assert.ok(ftsAt > schemaAt, "the _artifacts_fts migration comes after the _artifacts migration");

  migrate(drizzle(db), { migrationsFolder: migrationsBefore(schemaAt) });
  db.exec(`
    INSERT INTO user (id, name, email, role) VALUES ('legacy', 'Legacy', 'legacy@orbit.test', 'admin');
    INSERT INTO instance_settings (id, searxng_url, dream_hour, updated_at) VALUES (1, 'https://search.example', 4, 7);
    INSERT INTO chats (id, user_id, title, head_id, created_at, updated_at) VALUES ('legacy-chat', 'legacy', 'Legacy chat', 'legacy-reply', 1, 2);
    INSERT INTO messages (id, chat_id, parent_id, role, content, parts, position, created_at)
      VALUES ('legacy-prompt', 'legacy-chat', NULL, 'user', 'legacy prompt', '[{"type":"text","text":"legacy prompt"}]', 0, 1);
  `);
  db.prepare("INSERT INTO messages (id, chat_id, parent_id, role, content, parts, position, created_at) VALUES ('legacy-reply', 'legacy-chat', 'legacy-prompt', 'assistant', ?, ?, 1, 2)")
    .run(html, JSON.stringify([{ type: "text", text: html }]));
  const before = snapshot();
  assert.equal(before.messages.length, 2);

  migrate(drizzle(db), { migrationsFolder: repo });
  assert.deepEqual(snapshot(), before);
  assert.equal(db.prepare("SELECT artifacts_backfilled_at FROM instance_settings WHERE id = 1").pluck().get(), null);
  assert.equal(db.prepare("SELECT count(*) FROM artifacts").pluck().get(), 0);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  ftsCheck();
});

test("the artifacts table checks its slots and kinds, and its search index follows every write", () => {
  const insert = db.prepare(`INSERT INTO artifacts (id, user_id, chat_id, message_id, text_ordinal, block_index, kind, language, code, derived_title, user_title, lineage_id, created_at, updated_at)
    VALUES (@id, 'legacy', 'legacy-chat', 'legacy-reply', @textOrdinal, @blockIndex, @kind, @language, @code, @title, NULL, @id, 2, 2)`);
  const row = { id: "a1", textOrdinal: 0, blockIndex: 0, kind: "html", language: "html", code: "<title>Legacy page</title>\n", title: "Legacy page" };
  assert.throws(() => insert.run({ ...row, id: "bad-kind", blockIndex: 1, language: "jsx" }), /CHECK/);
  assert.throws(() => insert.run({ ...row, id: "bad-slot", blockIndex: -1 }), /CHECK/);
  insert.run(row);
  assert.throws(() => insert.run({ ...row, id: "same-slot" }), /UNIQUE/);
  insert.run({ ...row, id: "a2", blockIndex: 1, kind: "react", language: "tsx", code: "export default function Widget() { return null; }\n", title: "Widget" });

  assert.equal(hits("legacy"), 1);
  db.prepare("UPDATE artifacts SET user_title = 'Tally' WHERE id = 'a1'").run();
  assert.equal(hits("tally"), 1);
  ftsCheck();
  db.prepare("UPDATE artifacts SET user_title = NULL, code = 'zzchangedcode' WHERE id = 'a1'").run();
  assert.equal(hits("tally"), 0);
  assert.equal(hits("zzchangedcode"), 1);
  ftsCheck();
  db.exec("DELETE FROM artifacts WHERE id = 'a2'");
  assert.equal(hits("widget"), 0);
  db.exec("VACUUM");
  ftsCheck();
  assert.equal(hits("zzchangedcode"), 1);

  db.exec("DELETE FROM chats WHERE id = 'legacy-chat'");
  assert.equal(db.prepare("SELECT count(*) FROM artifacts").pluck().get(), 0);
  assert.equal(hits("zzchangedcode"), 0);
  assert.equal(hits("legacy"), 0);
  ftsCheck();
});
