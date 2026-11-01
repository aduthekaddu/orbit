import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

type Modules = {
  db: typeof import("./db").db;
  schema: typeof import("./db/schema");
  planChatWrite: typeof import("./messages").planChatWrite;
  listMessages: typeof import("./messages").listMessages;
  upsertMessage: typeof import("./messages").upsertMessage;
  persistIncoming: typeof import("./messages").persistIncoming;
  updateMessageText: typeof import("./messages").updateMessageText;
};

let mods: Modules;

before(async () => {
  const repo = process.cwd();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-chat-write-"));
  fs.mkdirSync(path.join(sandbox, "data"));
  fs.cpSync(path.join(repo, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  const dbModule = await import("./db");
  const schema = await import("./db/schema");
  const messageModule = await import("./messages");
  mods = {
    db: dbModule.db,
    schema,
    planChatWrite: messageModule.planChatWrite,
    listMessages: messageModule.listMessages,
    upsertMessage: messageModule.upsertMessage,
    persistIncoming: messageModule.persistIncoming,
    updateMessageText: messageModule.updateMessageText,
  };

  const now = new Date();
  mods.db.insert(mods.schema.user).values({ id: "u1", name: "Test", email: "test@orbit.local" }).run();
  for (const id of [
    "c-stale",
    "c-regen",
    "c-regen-ok",
    "c-target",
    "c-prefix",
    "c-parts",
    "c-concurrent",
    "c-conflict",
    "c-other",
    "c-echo",
    "c-deleted",
    "c-expected",
    "c-restore",
    "c-answer-edit",
  ]) {
    mods.db.insert(mods.schema.chats).values({ id, userId: "u1", title: id, createdAt: now, updatedAt: now }).run();
  }
});

type Incoming = { id: string; role: "user" | "assistant" | "system"; parts?: unknown };
type Trigger = "submit-message" | "regenerate-message";

function message(id: string, role: "user" | "assistant", text: string): Incoming & { parts: unknown } {
  return { id, role, parts: [{ type: "text", text }] };
}

function write(chatId: string, incoming: Incoming[], trigger: Trigger = "submit-message", messageId?: string) {
  const plan = mods.planChatWrite(chatId, incoming, trigger, messageId);
  assert.ok(plan);
  return plan.responseId;
}

function answer(chatId: string, id: string, text: string, replyTo: string) {
  assert.equal(mods.upsertMessage(chatId, message(id, "assistant", text), replyTo), true);
}

function ids(chatId: string) {
  return mods.listMessages(chatId).map((entry) => entry.id);
}

test("a stale tab's prefix keeps newer stored turns", () => {
  write("c-stale", [message("s1", "user", "first question")]);
  answer("c-stale", "s2", "first answer", "s1");
  write("c-stale", [
    message("s1", "user", "first question"),
    message("s2", "assistant", "first answer"),
    message("s3", "user", "second question"),
  ]);
  answer("c-stale", "s4", "second answer", "s3");

  write("c-stale", [
    message("s1", "user", "first question"),
    message("s2", "assistant", "first answer"),
    message("s5", "user", "from the stale tab"),
  ]);

  assert.deepEqual(ids("c-stale"), ["s1", "s2", "s3", "s4", "s5"]);
});

test("a request list that is a prefix of stored history keeps the extra turns", () => {
  write("c-prefix", [message("p1", "user", "one")]);
  answer("c-prefix", "p2", "two", "p1");
  write("c-prefix", [message("p1", "user", "one"), message("p2", "assistant", "two")]);
  answer("c-prefix", "p3", "three", "p1");

  write("c-prefix", [message("p1", "user", "one")]);

  assert.deepEqual(ids("c-prefix").sort(), ["p1", "p2", "p3"]);
});

test("a regenerate that stores nothing keeps the previous answer", () => {
  write("c-regen", [message("g1", "user", "explain the bug")]);
  answer("c-regen", "g2", "the first answer", "g1");

  assert.equal(write("c-regen", [message("g1", "user", "explain the bug")], "regenerate-message"), "g2");
  assert.deepEqual(ids("c-regen"), ["g1", "g2"]);
});

test("a stale tab cannot overwrite a regenerated answer", () => {
  write("c-echo", [message("e1", "user", "explain the bug")]);
  answer("c-echo", "e2", "regenerated answer", "e1");

  // Tab B loaded before the regeneration and still holds the old text under the same id.
  write("c-echo", [
    message("e1", "user", "explain the bug"),
    message("e2", "assistant", "old answer"),
    message("e3", "user", "next question"),
  ]);

  assert.deepEqual(
    mods.listMessages("c-echo").find((entry) => entry.id === "e2")?.parts,
    [{ type: "text", text: "regenerated answer" }],
  );
});

test("a successful regenerate leaves one answer under the same id", () => {
  write("c-regen-ok", [message("r1", "user", "one question")]);
  answer("c-regen-ok", "r2", "first answer", "r1");

  const responseId = write("c-regen-ok", [message("r1", "user", "one question")], "regenerate-message", "r2");
  assert.equal(responseId, "r2");
  answer("c-regen-ok", responseId, "second answer", "r1");

  assert.deepEqual(mods.listMessages("c-regen-ok"), [
    { id: "r1", role: "user", parts: [{ type: "text", text: "one question" }] },
    { id: "r2", role: "assistant", parts: [{ type: "text", text: "second answer" }] },
  ]);
});

test("a regenerate targeted at an earlier answer keeps the later turns", () => {
  write("c-target", [message("t1", "user", "one")]);
  answer("c-target", "t2", "answer one", "t1");
  write("c-target", [
    message("t1", "user", "one"),
    message("t2", "assistant", "answer one"),
    message("t3", "user", "two"),
  ]);
  answer("c-target", "t4", "answer two", "t3");

  const responseId = write("c-target", [message("t1", "user", "one")], "regenerate-message", "t2");
  assert.equal(responseId, "t2");
  answer("c-target", responseId, "new answer one", "t1");

  assert.deepEqual(ids("c-target"), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(mods.listMessages("c-target")[1], {
    id: "t2",
    role: "assistant",
    parts: [{ type: "text", text: "new answer one" }],
  });
});

test("a resent message without parts keeps its stored row", () => {
  write("c-parts", [message("x1", "user", "kept with parts")]);
  answer("c-parts", "x2", "resent without parts", "x1");

  write("c-parts", [message("x1", "user", "kept with parts"), { id: "x2", role: "assistant" }]);

  assert.deepEqual(ids("c-parts"), ["x1", "x2"]);
});

test("two interleaved sends keep both rows", () => {
  write("c-concurrent", [message("k1", "user", "from tab A")]);
  write("c-concurrent", [message("k2", "user", "from tab B")]);

  assert.deepEqual(ids("c-concurrent"), ["k1", "k2"]);
});

test("a write whose id belongs to another chat is refused", () => {
  mods.db
    .insert(mods.schema.messages)
    .values({ id: "o1", chatId: "c-other", role: "user", content: "x", parts: "[]", position: 0, createdAt: new Date() })
    .run();

  assert.equal(mods.planChatWrite("c-conflict", [message("o1", "user", "x")], "submit-message"), null);
});

test("a reply to a prompt removed by an edit is refused", () => {
  write("c-deleted", [message("d1", "user", "first")]);
  answer("c-deleted", "d2", "first answer", "d1");
  write("c-deleted", [
    message("d1", "user", "first"),
    message("d2", "assistant", "first answer"),
    message("d3", "user", "second"),
  ]);
  answer("c-deleted", "d4", "second answer", "d3");

  assert.ok(mods.planChatWrite("c-deleted", [message("d1", "user", "edited first")], "submit-message", undefined, "d1"));
  assert.deepEqual(ids("c-deleted"), ["d1"]);

  assert.equal(mods.upsertMessage("c-deleted", message("d5", "assistant", "late answer"), "d3"), false);
  assert.deepEqual(ids("c-deleted"), ["d1"]);
});

test("a write checked against a row removed by an edit is refused", () => {
  write("c-expected", [message("y1", "user", "ask")]);
  answer("c-expected", "y2", "answer", "y1");
  assert.ok(mods.planChatWrite("c-expected", [message("y1", "user", "edited ask")], "submit-message", undefined, "y1"));

  assert.equal(
    mods.upsertMessage("c-expected", message("y3", "assistant", "late"), undefined, {
      id: "y1",
      content: "ask",
      parts: JSON.stringify([{ type: "text", text: "ask" }]),
    }),
    false,
  );
  assert.deepEqual(ids("c-expected"), ["y1"]);
});

test("a stale regenerate cannot overwrite a newer answer edit", () => {
  write("c-answer-edit", [message("z1", "user", "ask")]);
  answer("c-answer-edit", "z2", "first answer", "z1");
  const expected = {
    id: "z2",
    content: "first answer",
    parts: JSON.stringify([{ type: "text", text: "first answer" }]),
  };
  assert.equal(mods.upsertMessage("c-answer-edit", message("z2", "assistant", "first answer"), "z1", expected), true);
  assert.equal(mods.updateMessageText("c-answer-edit", "z2", "edited answer"), true);

  assert.equal(mods.upsertMessage("c-answer-edit", message("z2", "assistant", "regenerated"), "z1", expected), false);
  assert.deepEqual(mods.listMessages("c-answer-edit")[1].parts, [{ type: "text", text: "edited answer" }]);
});

test("a stale tab cannot restore turns removed by an edit", () => {
  write("c-restore", [message("w1", "user", "first")]);
  answer("c-restore", "w2", "first answer", "w1");
  write("c-restore", [
    message("w1", "user", "first"),
    message("w2", "assistant", "first answer"),
    message("w3", "user", "second"),
  ]);
  answer("c-restore", "w4", "second answer", "w3");

  assert.ok(mods.planChatWrite("c-restore", [message("w1", "user", "edited first")], "submit-message", undefined, "w1"));
  assert.deepEqual(ids("c-restore"), ["w1"]);

  assert.equal(
    mods.persistIncoming("c-restore", [
      message("w1", "user", "first"),
      message("w2", "assistant", "first answer"),
      message("w3", "user", "second"),
      message("w4", "assistant", "second answer"),
    ]),
    "stale",
  );
  assert.deepEqual(ids("c-restore"), ["w1"]);
  assert.deepEqual(mods.listMessages("c-restore")[0].parts, [{ type: "text", text: "edited first" }]);
});
