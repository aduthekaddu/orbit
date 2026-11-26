import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { getDb } from "./db";
import { ensureChat } from "./messages";
import { resolveChoice, setChatChoice, type ModelChoice } from "./model-choice";
import { encryptSecret } from "./secrets";

const ONE = "u-choice-one";
const OTHER = "u-choice-other";
const BARE = "u-choice-bare";
const NO_MODEL = "u-choice-no-model";
const KEY = "made-up-choice-key-0001";
const CLEARED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SECRET_KEY"];

const sandbox = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR!, "cwd-"));
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(CLEARED_ENV.map((name) => [name, process.env[name]]));

function sql(query: string, ...args: unknown[]) {
  getDb().$client.prepare(query).run(...args);
}

function addUser(id: string) {
  sql("insert into user (id, name, email, email_verified) values (?, ?, ?, 0)", id, id, `${id}@orbit.local`);
}

function addConnection(id: string, userId: string, kind: "openai-compatible" | "anthropic", ciphertext = encryptSecret(KEY)) {
  sql(
    "insert into provider_connections (id, user_id, kind, label, base_url, api_key_ciphertext, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    id,
    userId,
    kind,
    id,
    kind === "anthropic" ? null : "http://127.0.0.1:9/v1",
    ciphertext,
    Date.now(),
  );
}

function setDefaults(userId: string, connectionId: string | null, model: string | null, effort: string | null) {
  sql(
    `insert into user_preferences (user_id, default_connection_id, default_model, default_effort, updated_at) values (?, ?, ?, ?, ?)
     on conflict(user_id) do update set default_connection_id = excluded.default_connection_id, default_model = excluded.default_model, default_effort = excluded.default_effort`,
    userId,
    connectionId,
    model,
    effort,
    Date.now(),
  );
}

function chat(id: string, userId = ONE) {
  const row = ensureChat(id, userId);
  assert.ok(row, `chat ${id}`);
  return row;
}

function resolved(userId: string, chatId: string, requested?: ModelChoice) {
  const result = resolveChoice(userId, chat(chatId, userId), requested);
  assert.ok(result.ok, `did not resolve: ${JSON.stringify(result)}`);
  return result;
}

before(() => {
  for (const name of CLEARED_ENV) delete process.env[name];
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);
  // Slice 18 adds accounts. Until then the database holds one user, so this file lifts that limit to test ownership.
  getDb().$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  for (const id of [ONE, OTHER, BARE, NO_MODEL]) addUser(id);
  addConnection("conn-openai", ONE, "openai-compatible");
  addConnection("conn-claude", ONE, "anthropic");
  addConnection("conn-unreadable", ONE, "openai-compatible", "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA");
  addConnection("conn-other", OTHER, "openai-compatible");
  addConnection("conn-no-model", NO_MODEL, "openai-compatible");
  setDefaults(ONE, "conn-openai", "default-model", "medium");
  setDefaults(NO_MODEL, "conn-no-model", null, "medium");
});

after(() => {
  getDb().$client.close();
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("a chat with no choice of its own uses the user's defaults", () => {
  const result = resolved(ONE, "chat-defaults");
  assert.deepEqual(result.choice, { connectionId: "conn-openai", model: "default-model", effort: "medium" });
  assert.equal(result.connection.id, "conn-openai");
  assert.equal(result.connection.kind, "openai-compatible");
  assert.equal(JSON.stringify(result.connection).includes(KEY), false, "the resolved connection carries the key");
});

test("the chat's own choice wins over the defaults, and changing the defaults does not move it", () => {
  const pinned: ModelChoice = { connectionId: "conn-claude", model: "claude-opus-5-5", effort: "high" };
  chat("chat-pinned");
  setChatChoice("chat-pinned", pinned);
  assert.deepEqual(resolved(ONE, "chat-pinned").choice, pinned);
  assert.equal(resolved(ONE, "chat-pinned").connection.kind, "anthropic");

  setDefaults(ONE, "conn-openai", "newer-default", "low");
  try {
    assert.deepEqual(resolved(ONE, "chat-pinned").choice, pinned);
    assert.deepEqual(resolved(ONE, "chat-unpinned").choice, { connectionId: "conn-openai", model: "newer-default", effort: "low" });
  } finally {
    setDefaults(ONE, "conn-openai", "default-model", "medium");
  }
});

test("the request wins over the chat and the defaults", () => {
  chat("chat-requested");
  setChatChoice("chat-requested", { connectionId: "conn-claude", model: "claude-opus-5-5", effort: "high" });
  const requested: ModelChoice = { connectionId: "conn-openai", model: "requested-model", effort: "xhigh" };
  const result = resolved(ONE, "chat-requested", requested);
  assert.deepEqual(result.choice, requested);
  assert.equal(result.connection.id, "conn-openai");
});

test("another user's connection never resolves", () => {
  const result = resolveChoice(ONE, chat("chat-foreign"), { connectionId: "conn-other", model: "m", effort: "low" });
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("a half-set or invalid chat triple is rejected", () => {
  for (const [chatId, connectionId, model, effort] of [
    ["chat-half-model", null, "only-a-model", null],
    ["chat-half-connection", "conn-openai", null, "high"],
    ["chat-bad-effort", "conn-openai", "default-model", "turbo"],
  ]) {
    chat(chatId!);
    sql("update chats set connection_id = ?, model = ?, reasoning_effort = ? where id = ?", connectionId, model, effort, chatId);
    assert.throws(() => resolveChoice(ONE, chat(chatId!)), `${chatId} resolved`);
  }
});

test("a user with no connection and no defaults resolves to no-connection", () => {
  assert.deepEqual(resolveChoice(BARE, chat("chat-bare", BARE)), { ok: false, reason: "no-connection" });
});

test("a connection with no model to use resolves to no-model", () => {
  assert.deepEqual(resolveChoice(NO_MODEL, chat("chat-no-model", NO_MODEL)), { ok: false, reason: "no-model" });
});

test("a connection whose key cannot be decrypted resolves to key-unreadable", () => {
  const result = resolveChoice(ONE, chat("chat-unreadable"), { connectionId: "conn-unreadable", model: "m", effort: "low" });
  assert.deepEqual(result, { ok: false, reason: "key-unreadable" });
});
