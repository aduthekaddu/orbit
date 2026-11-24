import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";

type Modules = {
  db: typeof import("./db").db;
  schema: typeof import("./db/schema");
  planChatWrite: typeof import("./messages").planChatWrite;
  listMessages: typeof import("./messages").listMessages;
  upsertMessage: typeof import("./messages").upsertMessage;
  persistIncoming: typeof import("./messages").persistIncoming;
  updateMessageText: typeof import("./messages").updateMessageText;
  replyGuard: typeof import("./messages").replyGuard;
};

let mods: Modules;
let sandbox: string;
const originalCwd = process.cwd();

after(() => {
  mods?.db.$client.close();
  process.chdir(originalCwd);
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

before(async () => {
  const repo = process.cwd();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-chat-write-"));
  process.env.ORBIT_DATA_DIR = path.join(sandbox, "data");
  fs.mkdirSync(process.env.ORBIT_DATA_DIR);
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
    replyGuard: messageModule.replyGuard,
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
    "c-reasons",
    "c-stale-reasons",
    "c-invisible",
    "c-invisible-retry",
    "c-retry-edit",
    "c-head",
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
  if (!plan || "error" in plan) assert.fail(`write refused: ${plan?.error ?? "null"}`);
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

  assert.notEqual(write("c-regen", [message("g1", "user", "explain the bug")], "regenerate-message"), "g2");
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

test("a successful regenerate keeps the old answer as a sibling", () => {
  write("c-regen-ok", [message("r1", "user", "one question")]);
  answer("c-regen-ok", "r2", "first answer", "r1");

  const responseId = write("c-regen-ok", [message("r1", "user", "one question")], "regenerate-message", "r2");
  assert.notEqual(responseId, "r2");
  answer("c-regen-ok", responseId, "second answer", "r1");

  assert.deepEqual(mods.listMessages("c-regen-ok"), [
    { id: "r1", role: "user", parts: [{ type: "text", text: "one question" }] },
    { id: "r2", role: "assistant", parts: [{ type: "text", text: "first answer" }] },
    { id: responseId, role: "assistant", parts: [{ type: "text", text: "second answer" }] },
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
  assert.notEqual(responseId, "t2");
  answer("c-target", responseId, "new answer one", "t1");

  assert.deepEqual(ids("c-target").sort(), ["t1", "t2", "t3", "t4", responseId].sort());
  assert.deepEqual(mods.listMessages("c-target")[1], {
    id: "t2",
    role: "assistant",
    parts: [{ type: "text", text: "answer one" }],
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

  assert.deepEqual(mods.planChatWrite("c-conflict", [message("o1", "user", "x")], "submit-message"), {
    error: "cross-chat",
  });
});

test("edit validation names the reason it refused", () => {
  write("c-reasons", [message("q1", "user", "one")]);
  answer("c-reasons", "q2", "two", "q1");
  write("c-reasons", [
    message("q1", "user", "one"),
    message("q2", "assistant", "two"),
    message("q3", "user", "three"),
  ]);
  mods.db
    .insert(mods.schema.messages)
    .values({ id: "o2", chatId: "c-other", role: "user", content: "x", parts: "[]", position: 1, createdAt: new Date() })
    .run();

  assert.deepEqual(
    mods.planChatWrite("c-reasons", [message("q2", "assistant", "bad")], "submit-message", undefined, "q2"),
    { error: "invalid-edit" },
  );
  assert.deepEqual(
    mods.planChatWrite("c-reasons", [message("q3", "user", "x")], "submit-message", undefined, "missing"),
    { error: "invalid-edit" },
  );
  assert.deepEqual(
    mods.planChatWrite("c-reasons", [message("q3", "user", "x")], "submit-message", undefined, "q3"),
    { error: "invalid-edit" },
  );
  assert.deepEqual(
    mods.planChatWrite(
      "c-reasons",
      [message("q1", "user", "one"), message("q2", "assistant", "two"), message("o2", "user", "x")],
      "submit-message",
      undefined,
      "q3",
    ),
    { error: "cross-chat" },
  );
});

test("an edit keeps the old prompt, reply and later turns", () => {
  write("c-deleted", [message("d1", "user", "first")]);
  answer("c-deleted", "d2", "first answer", "d1");
  write("c-deleted", [message("d1", "user", "first"), message("d2", "assistant", "first answer"), message("d3", "user", "later")]);
  const edit = mods.planChatWrite("c-deleted", [message("d-new", "user", "edited")], "submit-message", undefined, "d1");
  assert.ok(!("error" in edit));
  assert.deepEqual(ids("c-deleted").sort(), ["d1", "d2", "d3", "d-new"].sort());
  assert.equal(mods.upsertMessage("c-deleted", message("d4", "assistant", "late answer"), "d3"), true);
});

test("a path with a missing parent is stale and writes nothing", () => {
  write("c-expected", [message("y1", "user", "ask")]);
  answer("c-expected", "y2", "answer", "y1");
  write("c-expected", [message("y1", "user", "ask"), message("y2", "assistant", "answer"), message("y3", "user", "next")]);
  assert.deepEqual(mods.planChatWrite("c-expected", [message("y1", "user", "ask"), message("y3", "user", "next"), message("y4", "user", "stale")]), { error: "stale" });
  assert.deepEqual(ids("c-expected"), ["y1", "y2", "y3"]);
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

test("an unsaved assistant reply does not block the next prompt", () => {
  write("c-invisible", [message("f1", "user", "first")]);
  answer("c-invisible", "f2", "first answer", "f1");

  const plan = mods.planChatWrite("c-invisible", [
    message("f1", "user", "first"),
    message("f2", "assistant", "first answer"),
    { id: "f3", role: "assistant", parts: [{ type: "reasoning", text: "thinking" }] },
    message("f4", "user", "next question"),
  ]);
  assert.ok(plan && !("error" in plan), JSON.stringify(plan));
  assert.deepEqual(ids("c-invisible"), ["f1", "f2", "f4"]);
});

test("a retry of an unsaved assistant reply is accepted", () => {
  write("c-invisible-retry", [message("ir1", "user", "first")]);
  answer("c-invisible-retry", "ir2", "first answer", "ir1");

  const plan = mods.planChatWrite(
    "c-invisible-retry",
    [
      message("ir1", "user", "first"),
      message("ir2", "assistant", "first answer"),
      { id: "ir-failed", role: "assistant", parts: [{ type: "reasoning", text: "thinking" }] },
    ],
    "regenerate-message",
  );
  assert.ok(plan && !("error" in plan), JSON.stringify(plan));
  assert.deepEqual(ids("c-invisible-retry"), ["ir1", "ir2"]);
});

test("provider failure and stop before visible text leave the saved prompt as head", () => {
  for (const [chatId, promptId] of [["c-restore", "pf1"], ["c-retry-edit", "stop1"]]) {
    write(chatId, [message(promptId, "user", "before")]);
    assert.equal(mods.upsertMessage(chatId, { id: `${promptId}-empty`, role: "assistant", parts: [] }, promptId), true);
    const row = mods.db.$client.prepare("select head_id from chats where id = ?").get(chatId);
    assert.deepEqual(row, { head_id: promptId });
    assert.deepEqual(ids(chatId), [promptId]);
  }
});

test("a saved reply becomes the head after its prompt", () => {
  write("c-head", [message("h1", "user", "question")]);
  const head = () => mods.db.$client.prepare("select head_id from chats where id = ?").get("c-head");
  assert.deepEqual(head(), { head_id: "h1" });
  answer("c-head", "h2", "answer", "h1");
  assert.deepEqual(head(), { head_id: "h2" });
});
