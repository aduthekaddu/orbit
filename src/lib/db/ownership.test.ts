import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "./index";

const direct = ["account", "chats", "hidden_models", "memories", "memory_runs", "provider_connections", "session", "tool_status", "user_github", "user_preferences"];
const derived = [
  "memories_fts", "memories_fts_config", "memories_fts_data", "memories_fts_docsize", "memories_fts_idx",
  "memories_vec", "memories_vec_chunks", "memories_vec_info", "memories_vec_rowids", "memories_vec_vector_chunks00",
  "messages_fts", "messages_fts_config", "messages_fts_data", "messages_fts_docsize", "messages_fts_idx",
];
const instance = ["__drizzle_migrations", "instance_settings", "pending_connection", "sqlite_sequence", "verification"];

test("every SQLite table has an owner or a documented instance purpose, and user rows cascade", (t) => {
  const sqlite = getDb().$client;
  try {
    const tables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all();
    assert.deepEqual(tables.sort(), [...direct, ...derived, ...instance, "invites", "messages", "user"].sort());
    const cascade = (table: string, column: string, owner: string) => {
      const info = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
      assert.equal(info.find((row) => row.name === column)?.notnull, 1, `${table}.${column}`);
      const keys = sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as { from: string; table: string; to: string; on_delete: string }[];
      assert.ok(keys.some((key) => key.from === column && key.table === owner && key.to === "id" && key.on_delete === "CASCADE"), table);
    };
    for (const table of direct) cascade(table, "user_id", "user");
    cascade("invites", "created_by", "user");
    cascade("messages", "chat_id", "chats");

    for (const [id, role] of [["alpha", "admin"], ["beta", "member"]]) {
      sqlite.prepare("INSERT INTO user (id, name, email, role) VALUES (?, ?, ?, ?)").run(id, id, `${id}@orbit.test`, role);
      sqlite.prepare("INSERT INTO account (id, account_id, provider_id, user_id) VALUES (?, ?, 'credential', ?)").run(id, id, id);
      sqlite.prepare("INSERT INTO session (id, token, expires_at, user_id) VALUES (?, ?, 1, ?)").run(id, id, id);
      sqlite.prepare("INSERT INTO provider_connections (id, user_id, kind, label, base_url, api_key_ciphertext, created_at) VALUES (?, ?, 'openai-compatible', 'Provider', 'https://provider.example/v1', '', 1)").run(id, id);
      sqlite.prepare("INSERT INTO hidden_models (user_id, connection_id, model_id) VALUES (?, ?, 'model')").run(id, id);
      sqlite.prepare("INSERT INTO user_preferences (user_id, default_connection_id, updated_at) VALUES (?, ?, 1)").run(id, id);
      sqlite.prepare("INSERT INTO user_github (user_id, updated_at) VALUES (?, 1)").run(id);
      sqlite.prepare("INSERT INTO tool_status (user_id, tool_id, last_ok_at) VALUES (?, 'web_search', 1)").run(id);
      sqlite.prepare("INSERT INTO chats (id, user_id, created_at, updated_at) VALUES (?, ?, 1, 1)").run(id, id);
      sqlite.prepare("INSERT INTO messages (id, chat_id, role, content, parts, position, created_at) VALUES (?, ?, 'user', ?, '[]', 0, 1)").run(id, id, `${id}message`);
      const memory = sqlite.prepare("INSERT INTO memories (id, user_id, kind, text, text_norm, source_chat_id, source_message_id, created_at) VALUES (?, ?, 'fact', ?, ?, ?, ?, 1)")
        .run(id, id, `${id}memory`, `${id}memory`, id, id);
      sqlite.prepare("INSERT INTO memories_vec (rowid, user_id, embedding) VALUES (cast(? AS integer), ?, ?)")
        .run(memory.lastInsertRowid, id, Buffer.from(Float32Array.from({ length: 768 }, () => 1).buffer));
      sqlite.prepare("INSERT INTO memory_runs (user_id, date, state, started_at, chat_ids, done_chat_ids, retry_chat_ids, added, merged) VALUES (?, '2026-11-27', 'done', 1, '[]', '[]', '[]', 1, 0)").run(id);
    }
    const needle = (table: "memories_fts" | "messages_fts", word: string) =>
      sqlite.prepare(`SELECT count(*) FROM ${table} WHERE ${table} MATCH ?`).pluck().get(word);
    assert.equal(needle("memories_fts", "alphamemory"), 1);
    assert.equal(needle("messages_fts", "alphamessage"), 1);
    assert.equal(sqlite.prepare("SELECT count(*) FROM memories_vec WHERE user_id = 'alpha'").pluck().get(), 1);
    assert.throws(() => sqlite.exec("UPDATE user SET role = 'admin' WHERE id = 'beta'"), /UNIQUE/);

    sqlite.exec(`
      INSERT INTO invites (id, token_hash, created_by, created_at, expires_at, used_at, used_by)
      VALUES ('invite', 'synthetic-hash', 'alpha', 1, 100, 3, 'beta');
      DELETE FROM user WHERE id = 'beta';
    `);
    assert.deepEqual(sqlite.prepare("SELECT used_at, used_by FROM invites").get(), { used_at: 3, used_by: null });
    for (const table of [...direct, "memories_vec"]) {
      assert.deepEqual(sqlite.prepare(`SELECT user_id FROM ${table}`).pluck().all(), ["alpha"], table);
    }
    assert.deepEqual(sqlite.prepare("SELECT chat_id FROM messages").pluck().all(), ["alpha"]);
    assert.deepEqual(sqlite.prepare("SELECT id FROM user").pluck().all(), ["alpha"]);
    assert.equal(needle("memories_fts", "betamemory"), 0);
    assert.equal(needle("messages_fts", "betamessage"), 0);
    assert.equal(needle("memories_fts", "alphamemory"), 1);
    assert.equal(needle("messages_fts", "alphamessage"), 1);
    assert.equal(sqlite.prepare("SELECT count(*) FROM instance_settings").pluck().get(), 1);
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
    const counts = Object.fromEntries([...direct, "memories_vec"].map((table) => [
      table, sqlite.prepare(`SELECT count(*) FROM ${table} WHERE user_id = 'beta'`).pluck().get(),
    ]));
    t.diagnostic(`Removed member rows ${JSON.stringify({
      ...counts,
      user: sqlite.prepare("SELECT count(*) FROM user WHERE id = 'beta'").pluck().get(),
      messages: sqlite.prepare("SELECT count(*) FROM messages WHERE chat_id = 'beta'").pluck().get(),
      messages_fts: needle("messages_fts", "betamessage"),
      memories_fts: needle("memories_fts", "betamemory"),
    })}`);
  } finally {
    sqlite.close();
  }
});
