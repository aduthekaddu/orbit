import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as sqliteVec from "sqlite-vec";
import { dataDirectory } from "../paths";
import { decryptSecret } from "../secrets";
import { registerMigrationFunctions } from "./index";

const migrations = path.resolve("drizzle");
const dbModule = pathToFileURL(path.resolve("src/lib/db/index.ts")).href;
const tavily = randomUUID();
const github = randomUUID();
const provider = randomUUID();
const vector = Buffer.from(Float32Array.from({ length: 768 }, (_, i) => Number(i === 0)).buffer);

const oldSecret = process.env.ORBIT_SECRET_KEY;
before(() => { process.env.ORBIT_SECRET_KEY = randomBytes(32).toString("hex"); });
after(() => {
  if (oldSecret === undefined) delete process.env.ORBIT_SECRET_KEY;
  else process.env.ORBIT_SECRET_KEY = oldSecret;
});

function journalAt(folder: string, lastIndex: number) {
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter(({ idx }) => idx <= lastIndex);
  fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const { tag } of journal.entries) fs.copyFileSync(path.join(migrations, tag + ".sql"), path.join(folder, tag + ".sql"));
}

function open(filename: string) {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqliteVec.load(sqlite);
  registerMigrationFunctions(sqlite);
  return sqlite;
}

function legacyDb(dir: string, index: number, signedUp: boolean) {
  const filename = path.join(dir, "orbit.db");
  const folder = path.join(dir, "drizzle");
  journalAt(folder, index);
  const sqlite = open(filename);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
    sqlite.exec(`CREATE TRIGGER user_single_row BEFORE INSERT ON user
     WHEN (SELECT count(*) FROM user) >= 1 BEGIN SELECT RAISE(ABORT, 'signup closed'); END;`);
    sqlite.prepare("INSERT INTO settings (id, searxng_url, tavily_api_key, github_token, github_mcp_url, updated_at) VALUES (1, ?, ?, ?, ?, ?)")
      .run("https://search.example", tavily, github, "https://github-mcp.example", 42);
    if (index === 12) {
      sqlite.prepare("UPDATE settings SET base_url = ?, api_key = ?, model = ?, reasoning_effort = 'low' WHERE id = 1")
        .run("https://provider.example/v1", provider, "legacy-model");
    }
    if (signedUp) {
      sqlite.exec(`
        INSERT INTO user (id, name, email) VALUES ('legacy', 'Legacy', 'legacy@orbit.test');
        INSERT INTO user_preferences (user_id, theme, updated_at) VALUES ('legacy', 'light', 1);
        INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES ('legacy-chat', 'legacy', 'Legacy chat', 1, 2);
        INSERT INTO messages (id, chat_id, role, content, parts, position, created_at) VALUES ('legacy-message', 'legacy-chat', 'user', 'legacy message', '[]', 0, 1);
      `);
      if (index === 17) {
        sqlite.prepare(`INSERT INTO provider_connections VALUES ('saved', 'legacy', 'openai-compatible', 'Saved', 'https://provider.example/v1', orbit_encrypt_secret(?), 1)`).run(provider);
        sqlite.exec("UPDATE user_preferences SET default_connection_id = 'saved', default_model = 'legacy-model', default_effort = 'low', provider_setup_complete = 1");
      }
    }
    sqlite.prepare("INSERT INTO memories (seq, id, kind, text, text_norm, source, source_chat_id, source_message_id, created_at) VALUES (7, 'legacy-note', 'fact', 'legacy memory', 'legacy memory', 'tool', ?, ?, 1)")
      .run(signedUp ? "legacy-chat" : null, signedUp ? "legacy-message" : null);
    sqlite.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (7, ?)").run(vector);
    sqlite.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (100, ?)").run(vector);
    sqlite.exec("INSERT INTO memory_runs (date, state, started_at, chat_ids, done_chat_ids, retry_chat_ids, added, merged) VALUES ('2026-11-10', 'done', 1, '[]', '[]', '[]', 1, 0)");
  } finally {
    sqlite.close();
  }
  journalAt(folder, 20);
  return filename;
}

function boot(dir: string, script: string) {
  const env = { ...process.env, ORBIT_DATA_DIR: dir, ORBIT_DREAM_HOUR: "7" };
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(dbModule)});
    const { getDb, registerMigrationFunctions } = await import(${JSON.stringify(dbModule)});
    process.chdir(${JSON.stringify(dir)});
    ${script}
  `], { env, encoding: "utf8", timeout: 20_000 });
}

function assertScrubbed(dir: string) {
  const result = boot(dir, `
    const fs = require("node:fs");
    const assert = require("node:assert/strict");
    const db = getDb().$client;
    for (const name of ["orbit.db", "orbit.db-wal"]) {
      if (!fs.existsSync(name)) continue;
      const bytes = fs.readFileSync(name);
      assert.equal(bytes.includes(${JSON.stringify(tavily)}), false, "Tavily plaintext remains on disk");
      assert.equal(bytes.includes(${JSON.stringify(github)}), false, "GitHub plaintext remains on disk");
    }
    assert.equal(db.pragma("user_version", { simple: true }), 0);
    db.close();
  `);
  assert.equal(result.status, 0, result.stderr);
}

for (const index of [17, 12]) {
  test(`migration from 00${index} preserves the signed-up account and its data`, () => {
    const dir = fs.mkdtempSync(path.join(dataDirectory(), "accounts-"));
    const database = legacyDb(dir, index, true);
    assert.equal(fs.readFileSync(database).includes(tavily), true);
    assertScrubbed(dir);
    const sqlite = open(database);
    try {
      assert.deepEqual(sqlite.prepare("SELECT id, role FROM user").all(), [{ id: "legacy", role: "admin" }]);
      assert.deepEqual(sqlite.prepare("SELECT title FROM chats").pluck().all(), ["Legacy chat"]);
      assert.deepEqual(sqlite.prepare("SELECT content FROM messages").pluck().all(), ["legacy message"]);
      assert.deepEqual(sqlite.prepare("SELECT user_id, theme, memory, default_model FROM user_preferences").get(), {
        user_id: "legacy", theme: "light", memory: "on", default_model: "legacy-model",
      });
      const connection = sqlite.prepare("SELECT api_key_ciphertext FROM provider_connections WHERE user_id = 'legacy'").pluck().get();
      assert.equal(typeof connection === "string" && decryptSecret(connection) === provider, true);
      const search = sqlite.prepare("SELECT * FROM instance_settings").get() as { hosting_mode: string; sandbox: string; dream_hour: number; searxng_url: string; tavily_key_ciphertext: string };
      assert.equal(search.hosting_mode, "personal");
      assert.equal(sqlite.prepare("SELECT signup_mode FROM instance_settings").pluck().get(), "invite");
      assert.deepEqual(sqlite.prepare("SELECT * FROM invites").all(), []);
      assert.equal(search.sandbox, "on");
      assert.equal(search.dream_hour, 7);
      assert.equal(search.searxng_url, "https://search.example");
      assert.equal(decryptSecret(search.tavily_key_ciphertext, "instance_settings.tavily_api_key") === tavily, true);
      const token = sqlite.prepare("SELECT token_ciphertext, mcp_url FROM user_github WHERE user_id = 'legacy'").get() as { token_ciphertext: string; mcp_url: string };
      assert.equal(token.mcp_url, "https://github-mcp.example");
      assert.equal(decryptSecret(token.token_ciphertext, "user_github.token") === github, true);
      assert.throws(() => decryptSecret(token.token_ciphertext, "instance_settings.tavily_api_key"));
      assert.deepEqual(sqlite.prepare("SELECT seq, user_id, source, source_chat_id, source_message_id FROM memories").get(), {
        seq: 7, user_id: "legacy", source: "tool", source_chat_id: "legacy-chat", source_message_id: "legacy-message",
      });
      assert.deepEqual(sqlite.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'legacy'").pluck().all(), [7]);
      assert.deepEqual(sqlite.prepare("SELECT rowid, embedding FROM memories_vec WHERE user_id = 'legacy'").all(), [{ rowid: 7, embedding: vector }]);
      assert.deepEqual(sqlite.prepare("SELECT user_id, date, state, added FROM memory_runs").get(), { user_id: "legacy", date: "2026-11-10", state: "done", added: 1 });
      assert.equal(sqlite.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
    } finally {
      sqlite.close();
    }
  });
}

test("reopening after a crash scrubs plaintext and drops unowned rows on a pre-signup install", () => {
  const dir = fs.mkdtempSync(path.join(dataDirectory(), "accounts-crash-"));
  const database = legacyDb(dir, 12, false);
  const crashed = boot(dir, `
    const Database = require("better-sqlite3");
    const { drizzle } = require("drizzle-orm/better-sqlite3");
    const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
    const sqlite = new Database("orbit.db");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    require("sqlite-vec").load(sqlite);
    registerMigrationFunctions(sqlite);
    migrate(drizzle(sqlite), { migrationsFolder: "drizzle" });
    process.kill(process.pid, "SIGKILL");
  `);
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  assert.equal(fs.readFileSync(database).includes(github), true);
  assertScrubbed(dir);
  const sqlite = open(database);
  try {
    for (const table of ["user", "user_github", "memories", "memories_vec", "memory_runs"]) {
      assert.equal(sqlite.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), 0, table);
    }
    assert.equal(sqlite.prepare("SELECT count(*) FROM pending_connection").pluck().get(), 1);
    sqlite.exec("INSERT INTO user (id, name, email, role) VALUES ('first', 'First', 'first@orbit.test', 'admin'), ('test', 'Test', 'test@orbit.test', 'member')");
  } finally {
    sqlite.close();
  }
});

test("a post-18a install keeps its settings and gains invite-only signup", () => {
  const dir = fs.mkdtempSync(path.join(dataDirectory(), "accounts-0019-"));
  const filename = path.join(dir, "orbit.db");
  const folder = path.join(dir, "drizzle");
  journalAt(folder, 19);
  const existing = open(filename);
  try {
    migrate(drizzle(existing), { migrationsFolder: folder });
    existing.exec(`
      INSERT INTO user (id, name, email, role) VALUES ('legacy-admin', 'Legacy', 'admin@orbit.test', 'admin');
      INSERT INTO instance_settings(id, searxng_url, dream_hour, updated_at) VALUES (1, 'https://search.example', 4, 1);
    `);
  } finally {
    existing.close();
  }
  journalAt(folder, 20);
  const booted = boot(dir, "getDb().$client.close();");
  assert.equal(booted.status, 0, booted.stderr);
  const upgraded = open(filename);
  try {
    assert.deepEqual(upgraded.prepare("SELECT id, role FROM user").get(), { id: "legacy-admin", role: "admin" });
    assert.deepEqual(upgraded.prepare("SELECT hosting_mode, signup_mode, searxng_url, dream_hour FROM instance_settings WHERE id = 1").get(), {
      hosting_mode: "personal", signup_mode: "invite", searxng_url: "https://search.example", dream_hour: 4,
    });
    assert.deepEqual(upgraded.prepare("SELECT id FROM invites").all(), []);
    assert.equal(upgraded.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
  } finally {
    upgraded.close();
  }
});
