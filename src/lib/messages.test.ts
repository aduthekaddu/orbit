import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

type Modules = {
  db: typeof import("./db").db;
  schema: typeof import("./db/schema");
  persistIncoming: typeof import("./messages").persistIncoming;
  listMessages: typeof import("./messages").listMessages;
  planChatWrite: typeof import("./messages").planChatWrite;
  updateMessageText: typeof import("./messages").updateMessageText;
  upsertMessage: typeof import("./messages").upsertMessage;
  shouldSaveReply: typeof import("./messages").shouldSaveReply;
};

let mods: Modules;

before(async () => {
  const repo = process.cwd();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-messages-"));
  fs.mkdirSync(path.join(sandbox, "data"));
  fs.cpSync(path.join(repo, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  const dbModule = await import("./db");
  const schema = await import("./db/schema");
  const messageModule = await import("./messages");
  mods = {
    db: dbModule.db,
    schema,
    persistIncoming: messageModule.persistIncoming,
    listMessages: messageModule.listMessages,
    upsertMessage: messageModule.upsertMessage,
    planChatWrite: messageModule.planChatWrite,
    updateMessageText: messageModule.updateMessageText,
    shouldSaveReply: messageModule.shouldSaveReply,
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

test("resending a full history writes nothing", () => {
  const history = [
    message("m1", "user", "one"),
    message("m2", "assistant", "two"),
    message("m3", "user", "three"),
  ];
  mods.upsertMessage("c1", history[0]);
  mods.upsertMessage("c1", history[1], "m1");
  mods.upsertMessage("c1", history[2]);
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
  assert.equal(mods.persistIncoming("c3", [message("p-a", "user", "prompt a")]), "ok");
  assert.equal(
    mods.persistIncoming("c3", [message("p-a", "user", "prompt a"), message("p-b", "user", "prompt b")]),
    "ok",
  );

  assert.equal(mods.upsertMessage("c3", message("r-b", "assistant", "reply b"), "p-b"), true);
  assert.equal(mods.upsertMessage("c3", message("r-a", "assistant", "reply a"), "p-a"), true);

  assert.deepEqual(
    mods.db.$client.prepare("select id, parent_id from messages where chat_id = ? order by id").all("c3"),
    [{ id: "p-a", parent_id: null }, { id: "p-b", parent_id: "p-a" }, { id: "r-a", parent_id: "p-a" }, { id: "r-b", parent_id: "p-b" }],
  );
});


test("explicit user editing keeps later turns and invalid targets leave history intact", () => {
  const chat = "edit-chat";
  mods.db.insert(mods.schema.chats).values({ id: chat, userId: "u1", title: "Edit", createdAt: new Date(), updatedAt: new Date() }).run();
  const history = [message("eu", "user", "old"), message("ea", "assistant", "answer"), message("eu2", "user", "later")];
  mods.upsertMessage(chat, history[0]);
  mods.upsertMessage(chat, history[1], "eu");
  mods.upsertMessage(chat, history[2]);
  assert.deepEqual(mods.planChatWrite(chat, [message("new", "assistant", "bad")], "submit-message", undefined, "eu"), {
    error: "invalid-edit",
  });
  assert.equal(mods.listMessages(chat).length, 3);
  assert.ok(mods.planChatWrite(chat, [message("new", "user", "edited")], "submit-message", undefined, "eu"));
  assert.deepEqual(mods.listMessages(chat).map((row) => row.id).sort(), ["eu", "ea", "eu2", "new"].sort());
});

test("reply text editing keeps tool parts and stale echoes cannot overwrite it", () => {
  const parts = [{ type: "text", text: "before" }, { type: "tool-render_ui", toolCallId: "t1", state: "output-available", input: {}, output: { ok: true } }];
  mods.upsertMessage("c2", { id: "edited-answer", role: "assistant", parts });
  assert.equal(mods.updateMessageText("c2", "edited-answer", "after"), true);
  mods.persistIncoming("c2", [{ id: "edited-answer", role: "assistant", parts }]);
  const saved = mods.listMessages("c2").find((row) => row.id === "edited-answer")!;
  assert.deepEqual(saved.parts, [{ type: "text", text: "after" }, parts[1]]);
});

test("a user prompt cannot be rewritten in place", () => {
  const chat = "prompt-patch";
  mods.db
    .insert(mods.schema.chats)
    .values({ id: chat, userId: "u1", title: "Prompt", createdAt: new Date(), updatedAt: new Date() })
    .run();
  mods.upsertMessage(chat, message("pp1", "user", "ask"));
  mods.upsertMessage(chat, message("pp2", "assistant", "answer"), "pp1");

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
  mods.upsertMessage("c2", { id: "indexed-answer", role: "assistant", parts });
  assert.equal(mods.updateMessageText("c2", "indexed-answer", "new code", 2), true);
  const saved = mods.listMessages("c2").find((row) => row.id === "indexed-answer")!;
  assert.deepEqual(saved.parts, [parts[0], parts[1], { type: "text", text: "new code" }, parts[3]]);
  const stored = mods.db.$client.prepare("select content from messages where id = ?").get("indexed-answer") as { content: string };
  assert.equal(stored.content, parts[0].text + "new code" + parts[3].text);
});

test("a stopped retry with no older reply saves what streamed", () => {
  assert.equal(mods.shouldSaveReply({ regenerate: true, interrupted: true, hadReply: false, visible: true }), true);
});

test("a stopped regenerate saves visible text as a new sibling", () => {
  assert.equal(mods.shouldSaveReply({ regenerate: true, interrupted: true, hadReply: true, visible: true }), true);
});

test("a finished regenerate saves its new reply", () => {
  assert.equal(mods.shouldSaveReply({ regenerate: true, interrupted: false, hadReply: true, visible: true }), true);
});

test("a reply with nothing visible is not saved", () => {
  assert.equal(mods.shouldSaveReply({ regenerate: false, interrupted: false, hadReply: false, visible: false }), false);
});
