import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { Redactor } from "./chat-errors";
import { getDb, type OrbitDb } from "./db";
import * as schema from "./db/schema";
import {
  finishChatReply,
  listMessages,
  persistIncoming,
  planChatWrite,
  storedAssistantParts,
  updateMessageText,
} from "./messages";

type Modules = {
  db: OrbitDb;
  schema: typeof schema;
  persistIncoming: typeof persistIncoming;
  listMessages: typeof listMessages;
  storedAssistantParts: typeof storedAssistantParts;
  planChatWrite: typeof planChatWrite;
  finishChatReply: typeof finishChatReply;
  updateMessageText: typeof updateMessageText;
};

let mods: Modules;
let sandbox: string;
const originalCwd = process.cwd();

after(() => {
  mods?.db.$client.close();
  process.chdir(originalCwd);
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

before(() => {
  const repo = process.cwd();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-messages-"));
  fs.cpSync(path.join(repo, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  mods = {
    db: getDb(),
    schema,
    persistIncoming,
    listMessages,
    storedAssistantParts,
    planChatWrite,
    finishChatReply,
    updateMessageText,
  };

  const now = new Date();
  mods.db.insert(mods.schema.user).values({ id: "u1", name: "Test", email: "test@orbit.local" }).run();
  mods.db.insert(mods.schema.chats).values({ id: "c1", userId: "u1", title: "One", createdAt: now, updatedAt: now }).run();
  mods.db.insert(mods.schema.chats).values({ id: "c2", userId: "u1", title: "Two", createdAt: now, updatedAt: now }).run();
});

function changes() {
  return (mods.db.$client.prepare("select total_changes() as n").get() as { n: number }).n;
}

function message(id: string, role: "user" | "assistant", text: string) {
  return { id, role, parts: [{ type: "text", text }] };
}

// A request that ends in an unsaved assistant message streams the reply under that message's id.
function pending(id: string) {
  return { id, role: "assistant", parts: [] };
}

function reply(chatId: string, path: { id: string; role: string; parts: unknown[] }[], answer: { id: string; parts: unknown[] }) {
  const plan = mods.planChatWrite(chatId, [...path, pending(answer.id)]);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(mods.finishChatReply(plan, answer.parts), true);
}

test("resending a full history writes nothing", () => {
  const history = [
    message("m1", "user", "one"),
    message("m2", "assistant", "two"),
    message("m3", "user", "three"),
  ];
  reply("c1", [history[0]], history[1]);
  assert.equal(mods.persistIncoming("c1", history), "ok");
  const before = changes();
  assert.equal(mods.persistIncoming("c1", history), "ok");
  assert.equal(changes() - before, 0);
});

test("a new message is written once", () => {
  const history = [message("m1", "user", "one"), message("m4", "user", "four")];
  assert.equal(mods.persistIncoming("c1", history), "ok");
  assert.equal(mods.listMessages("c1").filter((message) => message.id === "m4").length, 1);
  assert.deepEqual(mods.db.$client.prepare("select head_id from chats where id = ?").get("c1"), { head_id: "m4" });
});

test("a message id from another chat is rejected", () => {
  mods.db
    .insert(mods.schema.messages)
    .values({ id: "m9", chatId: "c2", role: "user", content: "x", parts: "[]", position: 0, createdAt: new Date() })
    .run();
  assert.equal(mods.persistIncoming("c1", [message("m9", "user", "x")]), "cross-chat");
});

test("a reply keeps its prompt's place when two requests finish out of order", () => {
  const now = new Date();
  mods.db.insert(mods.schema.chats).values({ id: "c3", userId: "u1", title: "Three", createdAt: now, updatedAt: now }).run();
  const a = mods.planChatWrite("c3", [message("p-a", "user", "prompt a"), pending("r-a")]);
  const b = mods.planChatWrite("c3", [message("p-a", "user", "prompt a"), message("p-b", "user", "prompt b"), pending("r-b")]);
  if ("error" in a || "error" in b) assert.fail("write refused");

  assert.equal(mods.finishChatReply(b, message("r-b", "assistant", "reply b").parts), true);
  assert.equal(mods.finishChatReply(a, message("r-a", "assistant", "reply a").parts), true);

  assert.deepEqual(
    mods.db.$client.prepare("select id, parent_id from messages where chat_id = ? order by id").all("c3"),
    [{ id: "p-a", parent_id: null }, { id: "p-b", parent_id: "p-a" }, { id: "r-a", parent_id: "p-a" }, { id: "r-b", parent_id: "p-b" }],
  );
});


test("explicit user editing keeps later turns and invalid targets leave history intact", () => {
  const chat = "edit-chat";
  mods.db.insert(mods.schema.chats).values({ id: chat, userId: "u1", title: "Edit", createdAt: new Date(), updatedAt: new Date() }).run();
  const history = [message("eu", "user", "old"), message("ea", "assistant", "answer"), message("eu2", "user", "later")];
  reply(chat, [history[0]], history[1]);
  assert.equal(mods.persistIncoming(chat, history), "ok");
  assert.deepEqual(mods.planChatWrite(chat, [message("new", "assistant", "bad")], "submit-message", "eu"), {
    error: "invalid-edit",
  });
  assert.equal(mods.listMessages(chat).length, 3);
  assert.ok(mods.planChatWrite(chat, [message("new", "user", "edited")], "submit-message", "eu"));
  assert.deepEqual(mods.listMessages(chat).map((row) => row.id).sort(), ["eu", "ea", "eu2", "new"].sort());
});

test("reply text editing keeps tool parts and stale echoes cannot overwrite it", () => {
  const parts = [{ type: "text", text: "before" }, { type: "tool-render_ui", toolCallId: "t1", state: "output-available", input: {}, output: { ok: true } }];
  reply("c2", [message("edited-prompt", "user", "ask")], { id: "edited-answer", parts });
  assert.equal(mods.updateMessageText("c2", "edited-answer", "after"), true);
  mods.persistIncoming("c2", [message("edited-prompt", "user", "ask"), { id: "edited-answer", role: "assistant", parts }]);
  const saved = mods.listMessages("c2").find((row) => row.id === "edited-answer")!;
  assert.deepEqual(saved.parts, [{ type: "text", text: "after" }, parts[1]]);
});

test("a blank or whitespace-only reply edit does not change the stored row", () => {
  reply("c2", [message("blank-prompt", "user", "ask")], message("blank-answer", "assistant", "keep me"));
  assert.equal(mods.updateMessageText("c2", "blank-answer", ""), false);
  assert.equal(mods.updateMessageText("c2", "blank-answer", "   "), false);
  const saved = mods.listMessages("c2").find((row) => row.id === "blank-answer")!;
  assert.deepEqual(saved.parts, [{ type: "text", text: "keep me" }]);
});

test("a user prompt cannot be rewritten in place", () => {
  const chat = "prompt-patch";
  mods.db
    .insert(mods.schema.chats)
    .values({ id: chat, userId: "u1", title: "Prompt", createdAt: new Date(), updatedAt: new Date() })
    .run();
  reply(chat, [message("pp1", "user", "ask")], message("pp2", "assistant", "answer"));

  assert.equal(mods.updateMessageText(chat, "pp1", "rewritten"), false);
  assert.deepEqual(mods.listMessages(chat), [
    { id: "pp1", role: "user", parts: [{ type: "text", text: "ask" }] },
    { id: "pp2", role: "assistant", parts: [{ type: "text", text: "answer" }] },
  ]);
});

test("editing one text part by index keeps the reply's parts in order", () => {
  const parts = [
    { type: "text", text: "before" },
    { type: "tool-render_ui", toolCallId: "t2", state: "output-available", input: {}, output: { ok: true } },
    { type: "text", text: "old code" },
    { type: "text", text: "after" },
  ];
  reply("c2", [message("indexed-prompt", "user", "ask")], { id: "indexed-answer", parts });
  assert.equal(mods.updateMessageText("c2", "indexed-answer", "new code", 2), true);
  const saved = mods.listMessages("c2").find((row) => row.id === "indexed-answer")!;
  assert.deepEqual(saved.parts, [parts[0], parts[1], { type: "text", text: "new code" }, parts[3]]);
  const stored = mods.db.$client.prepare("select content from messages where id = ?").get("indexed-answer") as { content: string };
  assert.equal(stored.content, parts[0].text + "new code" + parts[3].text);
});
test("a saved reply's search text carries no credential that joining parts or stripping terminal codes rebuilds", () => {
  const key = "made-up-provider-key";
  const redact = new Redactor({ apiKey: key, tavilyApiKey: "", githubToken: "" });
  const run = {
    type: "tool-run_code",
    toolCallId: "run-1",
    state: "output-available",
    input: { language: "python", code: "print(1)" },
    output: { stdout: `${key.slice(0, 7)}\u001b[31m${key.slice(7)}`, stderr: "", exitCode: 0, durationMs: 1, timedOut: false, truncated: false },
  };
  const parts = [{ type: "text", text: key.slice(0, 9) }, { type: "text", text: key.slice(9) }, run];
  const plan = mods.planChatWrite("c1", [message("joined-prompt", "user", "ask"), pending("joined-reply")]);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(mods.finishChatReply(plan, parts, redact), true);
  const row = mods.db.$client.prepare("select content from messages where id = ?").get("joined-reply") as { content: string };
  assert.equal(row.content, "[redacted]\n[redacted]\nprint(1)");
});

test("a saved reply's parts and search text carry no credential that a part holds whole", () => {
  const key = "made-up-provider-key";
  const redact = new Redactor({ apiKey: key, tavilyApiKey: "", githubToken: "" });
  const parts = [{ type: "text", text: `the key is ${key}` }];
  const plan = mods.planChatWrite("c1", [message("whole-prompt", "user", "ask"), pending("whole-reply")]);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(mods.finishChatReply(plan, parts, redact), true);
  const row = mods.db.$client.prepare("select content, parts from messages where id = ?").get("whole-reply") as { content: string; parts: string };
  assert.equal(row.content, "the key is [redacted]");
  assert.deepEqual(JSON.parse(row.parts), [{ type: "text", text: "the key is [redacted]" }]);
});

test("a continued reply's parts and search text also carry no stored credential", () => {
  const key = "made-up-provider-key";
  const redact = new Redactor({ apiKey: key, tavilyApiKey: "", githubToken: "" });
  const prompt = message("continued-redact-prompt", "user", "ask");
  const initial = message("continued-redact-reply", "assistant", "first");
  reply("c1", [prompt], initial);
  const plan = mods.planChatWrite("c1", [prompt, initial]);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  const continued = [{ type: "text", text: "first " }, { type: "text", text: key.slice(0, 9) }, { type: "text", text: key.slice(9) }, { type: "text", text: ` and ${key}` }];
  assert.equal(mods.finishChatReply(plan, continued, redact), true);
  const row = mods.db.$client.prepare("select content, parts from messages where id = ?").get("continued-redact-reply") as { content: string; parts: string };
  assert.equal(row.content, "first [redacted] and [redacted]");
  assert.deepEqual(JSON.parse(row.parts), [
    { type: "text", text: "first " },
    { type: "text", text: key.slice(0, 9) },
    { type: "text", text: key.slice(9) },
    { type: "text", text: " and [redacted]" },
  ]);
});

test("storedAssistantParts returns the stored parts for incoming assistant ids in that chat", () => {
  const user = message("ap-u", "user", "run this");
  const assistant = message("ap-a", "assistant", "result");
  reply("c2", [user], assistant);
  const all = mods.listMessages("c2");
  const expected = new Map(all.filter((row) => row.role === "assistant" && row.id === "ap-a").map((row) => [row.id, row.parts]));
  assert.deepEqual(mods.storedAssistantParts("c2", ["ap-a", "missing"]), expected);
  assert.deepEqual(mods.storedAssistantParts("c1", ["ap-a"]), new Map());
  assert.deepEqual(mods.storedAssistantParts("c2", []), new Map());
});
