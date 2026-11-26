import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import Database from "better-sqlite3";

// The last migration before slice 17. Every install made before this slice has run 0000 to 0012.
const LAST_PRE_SLICE_IDX = 12;
const repo = process.cwd();
const dbUrl = pathToFileURL(path.join(repo, "src/lib/db/index.ts")).href;
const connectionsUrl = pathToFileURL(path.join(repo, "src/lib/connections.ts")).href;
const secretsUrl = pathToFileURL(path.join(repo, "src/lib/secrets.ts")).href;
const SEED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN", "ORBIT_SECRET_KEY", "BETTER_AUTH_SECRET", "NODE_TEST_CONTEXT"];
const installs: string[] = [];

after(() => {
  for (const dir of installs) fs.rmSync(dir, { recursive: true, force: true });
});

type Install = { dir: string; dataDir: string; dbFile: string };

function copyMigrations(dir: string, lastIdx: number | null) {
  const target = path.join(dir, "drizzle");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(repo, "drizzle"), target, { recursive: true });
  if (lastIdx === null) return;
  const journalFile = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
}

// Each open is its own process, like a server start, so the migrations folder and the environment are the ones under test.
function boot(install: Install, env: Record<string, string> = {}, script = "const { getDb } = await import(process.argv[1]); getDb();") {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ORBIT_DATA_DIR: install.dataDir };
  for (const name of SEED_ENV) delete childEnv[name];
  Object.assign(childEnv, env);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", `process.chdir(process.argv[4]); ${script}`, dbUrl, connectionsUrl, secretsUrl, install.dir],
    { cwd: repo, env: childEnv, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function preSliceInstall(name: string, env: Record<string, string> = {}): Install {
  const dir = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR!, `${name}-`));
  installs.push(dir);
  const install = { dir, dataDir: path.join(dir, "data"), dbFile: path.join(dir, "data", "orbit.db") };
  copyMigrations(dir, LAST_PRE_SLICE_IDX);
  boot(install, env);
  return install;
}

function upgrade(install: Install) {
  copyMigrations(install.dir, null);
  boot(install);
}

function withDb<T>(install: Install, use: (db: Database.Database) => T): T {
  const db = new Database(install.dbFile);
  try {
    return use(db);
  } finally {
    db.close();
  }
}

function decrypt(install: Install, stored: string) {
  return JSON.parse(boot(install, {}, `const { decryptSecret } = await import(process.argv[3]); console.log(JSON.stringify(decryptSecret(${JSON.stringify(stored)})));`).split("\n").at(-1)!);
}

function columns(db: Database.Database, table: string) {
  return (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
}

function setNullForeignKey(db: Database.Database, table: string, from: string) {
  const keys = db.prepare(`pragma foreign_key_list(${table})`).all() as { table: string; from: string; on_delete: string }[];
  return keys.find((key) => key.from === from && key.table === "provider_connections")?.on_delete;
}

function holdsKey(install: Install, key: string) {
  return ["orbit.db", "orbit.db-wal"].filter((name) => {
    const file = path.join(install.dataDir, name);
    return fs.existsSync(file) && fs.readFileSync(file).includes(Buffer.from(key));
  });
}

test("a signed-up install moves its provider into one encrypted connection and keeps its defaults, appearance, chats, and messages", () => {
  const key = "sk-made-up-upgrade-key-0001";
  const baseUrl = "http://proxyuser:url-pass-01@127.0.0.1:9/v1";
  const install = preSliceInstall("signed-up");
  const counts = withDb(install, (db) => {
    db.prepare("insert into user (id, name, email, email_verified) values ('u-upgrade', 'Upgrade', 'upgrade@orbit.local', 0)").run();
    db.prepare("insert into settings (id, base_url, api_key, model, reasoning_effort, searxng_url, updated_at) values (1, ?, ?, 'mock-genui', 'low', 'http://127.0.0.1:8888', 0)").run(baseUrl, key);
    db.prepare("insert into user_preferences (user_id, theme, text_size, reply_font, chat_width, accent, updated_at) values ('u-upgrade', 'light', 'lg', 'serif', 'wide', 'rose', 0)").run();
    for (const chat of ["chat-1", "chat-2"]) {
      db.prepare("insert into chats (id, user_id, title, created_at, updated_at) values (?, 'u-upgrade', ?, 0, 0)").run(chat, chat);
      db.prepare("insert into messages (id, chat_id, parent_id, role, content, parts, position, created_at) values (?, ?, null, 'user', 'hello', '[]', 0, 0)").run(`${chat}-q`, chat);
      db.prepare("insert into messages (id, chat_id, parent_id, role, content, parts, position, created_at) values (?, ?, ?, 'assistant', 'hi there', '[]', 1, 0)").run(`${chat}-a`, chat, `${chat}-q`);
    }
    return db.prepare("select (select count(*) from chats) as chats, (select count(*) from messages) as messages").get();
  });
  assert.notDeepEqual(holdsKey(install, key), [], "the fixture stores the key in plain text before the upgrade");

  upgrade(install);
  // Read the files as the upgraded server left them, before another connection checkpoints the WAL.
  assert.deepEqual(holdsKey(install, key), [], "the plain key is still in the database files");

  const upgraded = withDb(install, (db) => ({
    connections: db.prepare("select * from provider_connections").all() as Record<string, unknown>[],
    preferences: db.prepare("select * from user_preferences where user_id = 'u-upgrade'").get() as Record<string, unknown>,
    settings: db.prepare("select * from settings where id = 1").get() as Record<string, unknown>,
    settingsColumns: columns(db, "settings"),
    chatColumns: columns(db, "chats"),
    counts: db.prepare("select (select count(*) from chats) as chats, (select count(*) from messages) as messages").get(),
    reply: db.prepare("select content from messages where id = 'chat-1-a'").get(),
    pending: (db.prepare("select count(*) as n from pending_connection").get() as { n: number }).n,
    messageKey: setNullForeignKey(db, "messages", "connection_id"),
    defaultKey: setNullForeignKey(db, "user_preferences", "default_connection_id"),
    integrity: db.prepare("pragma integrity_check").pluck().get(),
    foreignKeyErrors: db.prepare("pragma foreign_key_check").all(),
  }));

  assert.equal(upgraded.connections.length, 1);
  const [connection] = upgraded.connections;
  assert.equal(connection.user_id, "u-upgrade");
  assert.equal(connection.kind, "openai-compatible");
  assert.equal(connection.base_url, baseUrl);
  assert.equal(connection.label, "127.0.0.1:9", "the label is the host, without the userinfo");
  assert.equal(String(connection.api_key_ciphertext).includes(key), false);
  assert.equal(decrypt(install, String(connection.api_key_ciphertext)), key);

  assert.equal(upgraded.preferences.default_connection_id, connection.id);
  assert.equal(upgraded.preferences.default_model, "mock-genui");
  assert.equal(upgraded.preferences.default_effort, "low");
  assert.deepEqual(
    [upgraded.preferences.theme, upgraded.preferences.text_size, upgraded.preferences.reply_font, upgraded.preferences.chat_width, upgraded.preferences.accent],
    ["light", "lg", "serif", "wide", "rose"],
  );

  for (const gone of ["api_key", "base_url", "model", "reasoning_effort"]) assert.equal(upgraded.settingsColumns.includes(gone), false, `settings still has ${gone}`);
  assert.equal(upgraded.settings.searxng_url, "http://127.0.0.1:8888", "other settings stay");
  for (const added of ["connection_id", "model", "reasoning_effort"]) assert.ok(upgraded.chatColumns.includes(added), `chats has no ${added}`);
  assert.deepEqual(upgraded.counts, counts, "no chat or message was lost");
  assert.deepEqual(upgraded.reply, { content: "hi there" });
  assert.equal(upgraded.pending, 0);
  assert.equal(upgraded.messageKey, "SET NULL", "messages.connection_id");
  assert.equal(upgraded.defaultKey, "SET NULL", "user_preferences.default_connection_id");
  assert.equal(upgraded.integrity, "ok");
  assert.deepEqual(upgraded.foreignKeyErrors, []);
});

test("provider_connections needs a base URL for openai-compatible and forbids one for anthropic", () => {
  const install = preSliceInstall("constraints");
  upgrade(install);
  withDb(install, (db) => {
    db.prepare("insert into user (id, name, email, email_verified) values ('u-check', 'Check', 'check@orbit.local', 0)").run();
    const insert = db.prepare("insert into provider_connections (id, user_id, kind, label, base_url, api_key_ciphertext, created_at) values (?, 'u-check', ?, 'x', ?, 'v1.a.b.c', 0)");
    assert.throws(() => insert.run("c-openai-no-url", "openai-compatible", null));
    assert.throws(() => insert.run("c-anthropic-url", "anthropic", "https://api.anthropic.com/v1"));
    insert.run("c-openai", "openai-compatible", "http://127.0.0.1:9/v1");
    insert.run("c-anthropic", "anthropic", null);
  });
});

test("an install nobody signed up to keeps its provider in pending_connection until the first account takes it", () => {
  const key = "sk-made-up-pending-key-0001";
  const install = preSliceInstall("pending");
  // The row a pre-slice server seeded from ORBIT_BASE_URL, ORBIT_API_KEY, and ORBIT_MODEL. The current seedSettings no longer reads them.
  withDb(install, (db) => {
    db.prepare("insert into settings (id, base_url, api_key, model, reasoning_effort, updated_at) values (1, 'http://127.0.0.1:9/v1', ?, 'mock-genui', 'medium', 0)").run(key);
  });
  assert.notDeepEqual(holdsKey(install, key), [], "the pre-slice server seeded the key from the environment in plain text");

  upgrade(install);
  assert.deepEqual(holdsKey(install, key), [], "the plain key is still in the database files");

  const pending = withDb(install, (db) => ({
    rows: db.prepare("select * from pending_connection").all() as Record<string, unknown>[],
    connections: (db.prepare("select count(*) as n from provider_connections").get() as { n: number }).n,
    settingsColumns: columns(db, "settings"),
  }));
  assert.equal(pending.rows.length, 1);
  assert.equal(pending.connections, 0);
  const [row] = pending.rows;
  assert.equal(row.base_url, "http://127.0.0.1:9/v1");
  assert.equal(row.model, "mock-genui");
  assert.equal(row.effort, "medium");
  assert.equal(decrypt(install, String(row.api_key_ciphertext)), key);
  assert.equal(pending.settingsColumns.includes("api_key"), false);

  withDb(install, (db) => {
    db.prepare("insert into user (id, name, email, email_verified) values ('u-first', 'First', 'first@orbit.local', 0)").run();
  });
  // The stored copy wins over the environment, and a second run changes nothing.
  boot(
    install,
    { ORBIT_BASE_URL: "http://127.0.0.1:7/v1", ORBIT_API_KEY: "sk-made-up-env-key-0002", ORBIT_MODEL: "env-model" },
    "const { seedConnection } = await import(process.argv[2]); seedConnection('u-first'); seedConnection('u-first');",
  );

  const adopted = withDb(install, (db) => ({
    connections: db.prepare("select * from provider_connections").all() as Record<string, unknown>[],
    pending: (db.prepare("select count(*) as n from pending_connection").get() as { n: number }).n,
    preferences: db.prepare("select default_connection_id, default_model, default_effort from user_preferences where user_id = 'u-first'").get() as Record<string, unknown>,
  }));
  assert.equal(adopted.connections.length, 1);
  const [connection] = adopted.connections;
  assert.equal(connection.user_id, "u-first");
  assert.equal(connection.base_url, "http://127.0.0.1:9/v1");
  assert.equal(decrypt(install, String(connection.api_key_ciphertext)), key);
  assert.equal(adopted.pending, 0);
  assert.deepEqual(adopted.preferences, { default_connection_id: connection.id, default_model: "mock-genui", default_effort: "medium" });
});

test("a saved base URL that is not a URL still migrates, under the label Provider", () => {
  const key = "sk-made-up-malformed-key-0001";
  const install = preSliceInstall("malformed");
  withDb(install, (db) => {
    db.prepare("insert into user (id, name, email, email_verified) values ('u-malformed', 'Malformed', 'malformed@orbit.local', 0)").run();
    db.prepare("insert into settings (id, base_url, api_key, model, reasoning_effort, updated_at) values (1, 'not a url', ?, 'mock-genui', 'high', 0)").run(key);
  });

  upgrade(install);

  const connections = withDb(install, (db) => db.prepare("select * from provider_connections").all() as Record<string, unknown>[]);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].label, "Provider");
  assert.equal(connections[0].base_url, "not a url");
  assert.equal(decrypt(install, String(connections[0].api_key_ciphertext)), key);
});

test("an install with no provider upgrades with nothing to move", () => {
  const install = preSliceInstall("empty");
  upgrade(install);
  const rows = withDb(install, (db) => db.prepare("select (select count(*) from provider_connections) as connections, (select count(*) from pending_connection) as pending").get());
  assert.deepEqual(rows, { connections: 0, pending: 0 });
});
