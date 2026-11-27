import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { Redactor } from "./chat-errors";
import { addConnection as saveConnection, deleteConnection, listConnections, seedConnection } from "./connections";
import { getDb } from "./db";
import { chats } from "./db/schema";
import { finishChatReply, getChatForUser, listMessages, planChatWrite } from "./messages";
import { resolveChoice, setChatChoice, type ModelChoice, type ReplyRecord } from "./model-choice";
import { parseViewer, type Role } from "./policy";
import { encryptSecret } from "./secrets";

const ONE = parseViewer({ id: "u-choice-one", role: "member" }).id;
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

function addUser(id: string, role: Role = "member") {
  sql("insert into user (id, name, email, role) values (?, ?, ?, ?)", id, id, `${id}@orbit.local`, role);
  return parseViewer({ id, role });
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

function chat(id: string, userId: string = ONE) {
  const now = new Date();
  getDb().insert(chats).values({ id, userId, title: "New chat", createdAt: now, updatedAt: now }).onConflictDoNothing().run();
  const row = getChatForUser(id, userId);
  assert.ok(row, `chat ${id}`);
  return row;
}

function resolved(userId: string, chatId: string, requested?: ModelChoice) {
  const result = resolveChoice(parseViewer({ id: userId, role: "member" }), chat(chatId, userId), requested);
  assert.ok(result.ok, `did not resolve: ${JSON.stringify(result)}`);
  return result;
}

before(() => {
  for (const name of CLEARED_ENV) delete process.env[name];
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);
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
  const result = resolveChoice(parseViewer({ id: ONE, role: "member" }), chat("chat-foreign"), { connectionId: "conn-other", model: "m", effort: "low" });
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
    assert.throws(() => resolveChoice(parseViewer({ id: ONE, role: "member" }), chat(chatId!)), `${chatId} resolved`);
  }
});

test("a user with no connection and no defaults resolves to no-connection", () => {
  assert.deepEqual(resolveChoice(parseViewer({ id: BARE, role: "member" }), chat("chat-bare", BARE)), { ok: false, reason: "no-connection" });
});

test("a connection with no model to use resolves to no-model", () => {
  assert.deepEqual(resolveChoice(parseViewer({ id: NO_MODEL, role: "member" }), chat("chat-no-model", NO_MODEL)), { ok: false, reason: "no-model" });
});

test("a connection whose key cannot be decrypted resolves to key-unreadable and keeps the choice for the chip", () => {
  const requested = { connectionId: "conn-unreadable", model: "m", effort: "low" } as const;
  const result = resolveChoice(parseViewer({ id: ONE, role: "member" }), chat("chat-unreadable"), requested);
  assert.deepEqual(result, { ok: false, reason: "key-unreadable", choice: requested });
});

// A send resolves its choice, then waits for the reply slot and streams, so a delete can land between any two steps.
test("a reply whose connection was deleted while it streamed is saved without the connection, and keeps its model and effort", () => {
  addConnection("conn-deleted-mid-reply", ONE, "openai-compatible");
  const chatId = "chat-deleted-mid-reply";
  chat(chatId);
  const redact = new Redactor(null);
  const plan = planChatWrite(chatId, [{ id: `${chatId}-u1`, role: "user", parts: [{ type: "text", text: "hello" }] }], redact);
  assert.ok(!("error" in plan), JSON.stringify(plan));
  assert.equal(deleteConnection(ONE, "conn-deleted-mid-reply"), true);

  const record: ReplyRecord = { connectionId: "conn-deleted-mid-reply", model: "streamed-model", effort: "high", effortOutcome: "applied" };
  assert.equal(finishChatReply(plan, [{ type: "text", text: "the reply" }], redact, record), true, "the reply was not saved");
  const reply = listMessages(chatId).find((message) => message.role === "assistant");
  assert.deepEqual(reply?.metadata, { reply: { ...record, connectionId: null } });
});

test("a choice that names a deleted connection is not pinned, and a chat pinned to one uses the defaults", () => {
  addConnection("conn-deleted-before-pin", ONE, "openai-compatible");
  chat("chat-pin-after-delete");
  assert.equal(deleteConnection(ONE, "conn-deleted-before-pin"), true);
  setChatChoice("chat-pin-after-delete", { connectionId: "conn-deleted-before-pin", model: "pinned-model", effort: "high" });
  assert.deepEqual(
    getDb().$client.prepare("select connection_id, model, reasoning_effort from chats where id = 'chat-pin-after-delete'").get(),
    { connection_id: null, model: null, reasoning_effort: null },
  );

  chat("chat-pinned-to-gone");
  sql("update chats set connection_id = 'conn-gone', model = 'gone-model', reasoning_effort = 'low' where id = 'chat-pinned-to-gone'");
  assert.deepEqual(resolved(ONE, "chat-pinned-to-gone").choice, { connectionId: "conn-openai", model: "default-model", effort: "medium" });
});

test("a user who deleted the connection made from the environment does not get it back on the next send", () => {
  const user = "u-choice-env";
  const viewer = addUser(user, "admin");
  addConnection("conn-from-env", user, "openai-compatible");
  Object.assign(process.env, { ORBIT_BASE_URL: "http://127.0.0.1:9/v1", ORBIT_API_KEY: "made-up-env-key-0001", ORBIT_MODEL: "env-model" });
  try {
    assert.equal(deleteConnection(viewer.id, "conn-from-env"), true);
    assert.deepEqual(resolveChoice(viewer, chat("chat-env-deleted", user)), { ok: false, reason: "no-connection" });
    assert.deepEqual(listConnections(viewer.id), []);
  } finally {
    for (const name of ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL"]) delete process.env[name];
    sql("DELETE FROM user WHERE id = ?", user);
  }
});

test("model choice retries environment setup after the first account's transient write failure", () => {
  const user = "u-choice-env-retry";
  const viewer = addUser(user, "admin");
  const env = { ORBIT_BASE_URL: "http://provider.invalid/v1", ORBIT_API_KEY: "fixture-env-value", ORBIT_MODEL: "env-model" };
  Object.assign(process.env, env);
  try {
    sql("CREATE TEMP TRIGGER fail_seed BEFORE INSERT ON provider_connections BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    try {
      assert.throws(() => seedConnection(viewer));
      assert.deepEqual(listConnections(viewer.id), []);
    } finally {
      sql("DROP TRIGGER fail_seed");
    }
    const choice = resolveChoice(viewer, chat("chat-env-retry", user));
    assert.ok(choice.ok);
    assert.equal(choice.choice.model, "env-model");
    assert.equal(deleteConnection(viewer.id, choice.connection.id), true);
    assert.deepEqual(resolveChoice(viewer, chat("chat-env-retry-deleted", user)), { ok: false, reason: "no-connection" });
  } finally {
    for (const name of Object.keys(env)) delete process.env[name];
    sql("DELETE FROM user WHERE id = ?", user);
  }
});

test("adding and deleting a manual connection closes any pending provider adoption", async (t) => {
  const user = "u-choice-pending-replaced";
  const viewer = addUser(user, "admin");
  sql("insert into pending_connection (id, base_url, api_key_ciphertext, model, effort, created_at) values (1, ?, ?, ?, ?, 0)",
    "http://prior-provider.invalid/v1", encryptSecret(KEY), "prior-model", "low");
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "manual-model" }] }));
  try {
    const saved = await saveConnection(viewer.id, {
      kind: "openai-compatible", label: "Manual", baseUrl: "http://provider.invalid/v1", apiKey: "fixture-manual-value",
    }, () => new Redactor(null));
    assert.ok(saved.ok);
    assert.equal(deleteConnection(viewer.id, saved.connection.id), true);
    assert.deepEqual(resolveChoice(viewer, chat("chat-pending-replaced", user)), { ok: false, reason: "no-connection" });
    assert.deepEqual(listConnections(viewer.id), []);
  } finally {
    sql("delete from pending_connection");
    sql("DELETE FROM user WHERE id = ?", user);
  }
});
