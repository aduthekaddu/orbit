import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { toUIMessageStream, type UIMessage } from "ai";

type Modules = {
  db: typeof import("./db").db;
  schema: typeof import("./db/schema");
  planChatWrite: typeof import("./messages").planChatWrite;
  finishChatReply: typeof import("./messages").finishChatReply;
  listMessages: typeof import("./messages").listMessages;
  messageRepository: typeof import("./messages").messageRepository;
  updateMessageText: typeof import("./messages").updateMessageText;
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
    finishChatReply: messageModule.finishChatReply,
    listMessages: messageModule.listMessages,
    messageRepository: messageModule.messageRepository,
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
    "c-reasons",
    "c-stale-reasons",
    "c-invisible",
    "c-invisible-retry",
    "c-retry-edit",
    "c-prompt-changed",
    "c-continued",
    "c-continued-ok",
    "c-sdk-id",
  ]) {
    mods.db.insert(mods.schema.chats).values({ id, userId: "u1", title: id, createdAt: now, updatedAt: now }).run();
  }
});

type Incoming = { id: string; role: "user" | "assistant" | "system"; parts?: unknown };
type Trigger = "submit-message" | "regenerate-message";

function message(id: string, role: "user" | "assistant", text: string): Incoming & { parts: unknown } {
  return { id, role, parts: [{ type: "text", text }] };
}

function write(chatId: string, incoming: Incoming[], trigger: Trigger = "submit-message") {
  const plan = mods.planChatWrite(chatId, incoming, trigger);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  return plan;
}

function finish(plan: ReturnType<typeof write>, text: string) {
  assert.equal(mods.finishChatReply(plan, [{ type: "text", text }]), true);
}

// Saves a reply under the stored message replyTo, as POST /api/chat does for a request that sends
// the path to replyTo and ends in an unsaved assistant message: the reply takes that message's id.
function answer(chatId: string, id: string, text: string, replyTo: string) {
  const byId = new Map(mods.messageRepository(chatId).messages.map((entry) => [entry.message.id, entry]));
  const path: Incoming[] = [];
  for (let at = byId.get(replyTo); at; at = at.parentId ? byId.get(at.parentId) : undefined) path.unshift(at.message);
  finish(write(chatId, [...path, { id, role: "assistant", parts: [] }]), text);
}

// The id toUIMessageStream gives the reply when POST /api/chat passes it these messages and plan.
async function streamedId(incoming: Incoming[], plan: ReturnType<typeof write>) {
  const stream = new ReadableStream({ start: (controller) => { controller.enqueue({ type: "start" }); controller.close(); } });
  const originalMessages = incoming.map((entry) => ({ ...entry, parts: entry.parts ?? [] })) as UIMessage[];
  for await (const chunk of toUIMessageStream({ stream, originalMessages, generateMessageId: () => plan.id })) {
    if (chunk.type === "start") return chunk.messageId;
  }
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

  assert.notEqual(write("c-regen", [message("g1", "user", "explain the bug")], "regenerate-message").id, "g2");
  assert.deepEqual(ids("c-regen"), ["g1", "g2"]);
});

test("a stale tab cannot overwrite an answer changed after it loaded", () => {
  write("c-echo", [message("e1", "user", "explain the bug")]);
  answer("c-echo", "e2", "old answer", "e1");

  assert.equal(mods.updateMessageText("c-echo", "e2", "edited answer"), true);
  write("c-echo", [
    message("e1", "user", "explain the bug"),
    message("e2", "assistant", "old answer"),
    message("e3", "user", "next question"),
  ]);

  assert.deepEqual(ids("c-echo"), ["e1", "e2", "e3"]);
  assert.deepEqual(
    mods.listMessages("c-echo").find((entry) => entry.id === "e2")?.parts,
    [{ type: "text", text: "edited answer" }],
  );
});

// docs/architecture/ChatWrite.edited-prompt.trace, step by step.
test("a retry's reply is refused after another tab edits its prompt in place", () => {
  // State 1: P is saved, and its first reply stopped before any visible part, so no reply row exists.
  assert.equal(mods.finishChatReply(write("c-prompt-changed", [message("pc1", "user", "before")]), []), false);
  assert.deepEqual(ids("c-prompt-changed"), ["pc1"]);

  // State 2, Plan: tab a presses Retry.
  const plan = write("c-prompt-changed", [message("pc1", "user", "before")], "regenerate-message");

  // State 3, EditPromptInPlace: tab b edits P under its own id. The code refuses that edit now,
  // so the test writes it the way planChatWrite did at fa399a2: delete P, then insert the new text under P's id.
  assert.deepEqual(
    mods.planChatWrite("c-prompt-changed", [message("pc1", "user", "after")], "submit-message", "pc1"),
    { error: "invalid-edit" },
  );
  assert.deepEqual(mods.planChatWrite("c-prompt-changed", [message("pc1", "user", "after")]), { error: "stale" });
  mods.db.$client.prepare("delete from messages where id = ?").run("pc1");
  mods.db.$client
    .prepare("insert into messages (id, chat_id, parent_id, role, content, parts, position, created_at) values (?, ?, null, 'user', ?, ?, 0, ?)")
    .run("pc1", "c-prompt-changed", "after", JSON.stringify([{ type: "text", text: "after" }]), Date.now());

  // State 4, Finish: tab a's reply ends. It must not be saved under the edited P.
  assert.equal(mods.finishChatReply(plan, [{ type: "text", text: "answer to before" }]), false);
  assert.deepEqual(ids("c-prompt-changed"), ["pc1"]);
});

// docs/architecture/ChatWrite.continued-reply.trace, step by step.
test("a request that continues a saved reply cannot undo an edit made in another tab", () => {
  // State 1: P and its reply R are saved, and both tabs show them.
  write("c-continued", [message("cr1", "user", "explain the bug")]);
  answer("c-continued", "cr2", "first answer", "cr1");

  // State 2, Plan: tab a sends a request that ends in its copy of R. The AI SDK streams the reply
  // under R's id and appends to R's saved parts.
  const plan = write("c-continued", [message("cr1", "user", "explain the bug"), message("cr2", "assistant", "first answer")]);
  assert.equal(plan.id, "cr2");

  // State 3, EditReply: tab b saves an edit of R.
  assert.equal(mods.updateMessageText("c-continued", "cr2", "edited in tab b"), true);

  // State 4, Finish: tab a's reply ends. It must not replace tab b's edit.
  mods.finishChatReply(plan, [{ type: "text", text: "first answer" }, { type: "text", text: " and more" }]);
  assert.deepEqual(mods.listMessages("c-continued").find((entry) => entry.id === "cr2")?.parts, [{ type: "text", text: "edited in tab b" }]);
});

test("a request that continues an unchanged saved reply saves the longer reply", () => {
  write("c-continued-ok", [message("co1", "user", "explain the bug")]);
  answer("c-continued-ok", "co2", "first answer", "co1");

  const plan = write("c-continued-ok", [message("co1", "user", "explain the bug"), message("co2", "assistant", "first answer")]);
  assert.equal(mods.finishChatReply(plan, [{ type: "text", text: "first answer" }, { type: "text", text: " and more" }]), true);

  assert.deepEqual(mods.listMessages("c-continued-ok"), [
    { id: "co1", role: "user", parts: [{ type: "text", text: "explain the bug" }] },
    { id: "co2", role: "assistant", parts: [{ type: "text", text: "first answer" }, { type: "text", text: " and more" }] },
  ]);
});

test("a reply is saved under the id the AI SDK streams it under", async () => {
  const prompt = message("sid1", "user", "ask");
  const send = write("c-sdk-id", [prompt]);
  assert.equal(await streamedId([prompt], send), send.id);
  finish(send, "answer");

  const saved = message(send.id, "assistant", "answer");
  assert.equal(await streamedId([prompt, saved], write("c-sdk-id", [prompt, saved])), send.id);

  const unsaved: Incoming = { id: "sid-failed", role: "assistant", parts: [{ type: "reasoning", text: "thinking" }] };
  const retry = write("c-sdk-id", [prompt, unsaved], "regenerate-message");
  assert.equal(await streamedId([prompt, unsaved], retry), "sid-failed");
  assert.equal(retry.id, "sid-failed");
});

test("a successful regenerate keeps the old answer as a sibling", () => {
  write("c-regen-ok", [message("r1", "user", "one question")]);
  answer("c-regen-ok", "r2", "first answer", "r1");

  const plan = write("c-regen-ok", [message("r1", "user", "one question")], "regenerate-message");
  assert.notEqual(plan.id, "r2");
  finish(plan, "second answer");

  assert.deepEqual(mods.listMessages("c-regen-ok"), [
    { id: "r1", role: "user", parts: [{ type: "text", text: "one question" }] },
    { id: "r2", role: "assistant", parts: [{ type: "text", text: "first answer" }] },
    { id: plan.id, role: "assistant", parts: [{ type: "text", text: "second answer" }] },
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

  const plan = write("c-target", [message("t1", "user", "one")], "regenerate-message");
  assert.notEqual(plan.id, "t2");
  finish(plan, "new answer one");

  assert.deepEqual(ids("c-target").sort(), ["t1", "t2", "t3", "t4", plan.id].sort());
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
    mods.planChatWrite("c-reasons", [message("q2", "assistant", "bad")], "submit-message", "q2"),
    { error: "invalid-edit" },
  );
  assert.deepEqual(
    mods.planChatWrite("c-reasons", [message("q3", "user", "x")], "submit-message", "missing"),
    { error: "invalid-edit" },
  );
  assert.deepEqual(
    mods.planChatWrite("c-reasons", [message("q3", "user", "x")], "submit-message", "q3"),
    { error: "invalid-edit" },
  );
  assert.deepEqual(
    mods.planChatWrite(
      "c-reasons",
      [message("q1", "user", "one"), message("q2", "assistant", "two"), message("o2", "user", "x")],
      "submit-message",
      "q3",
    ),
    { error: "cross-chat" },
  );
});

test("an edit keeps the old prompt, reply and later turns", () => {
  write("c-deleted", [message("d1", "user", "first")]);
  answer("c-deleted", "d2", "first answer", "d1");
  const late = write("c-deleted", [message("d1", "user", "first"), message("d2", "assistant", "first answer"), message("d3", "user", "later")]);
  const edit = mods.planChatWrite("c-deleted", [message("d-new", "user", "edited")], "submit-message", "d1");
  assert.ok(!("error" in edit));
  assert.deepEqual(ids("c-deleted").sort(), ["d1", "d2", "d3", "d-new"].sort());
  finish(late, "late answer");
});

test("a path with a missing parent is stale and writes nothing", () => {
  write("c-expected", [message("y1", "user", "ask")]);
  answer("c-expected", "y2", "answer", "y1");
  write("c-expected", [message("y1", "user", "ask"), message("y2", "assistant", "answer"), message("y3", "user", "next")]);
  assert.deepEqual(mods.planChatWrite("c-expected", [message("y1", "user", "ask"), message("y3", "user", "next"), message("y4", "user", "stale")]), { error: "stale" });
  assert.deepEqual(ids("c-expected"), ["y1", "y2", "y3"]);
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
    assert.equal(mods.finishChatReply(write(chatId, [message(promptId, "user", "before")]), []), false);
    const row = mods.db.$client.prepare("select head_id from chats where id = ?").get(chatId);
    assert.deepEqual(row, { head_id: promptId });
    assert.deepEqual(ids(chatId), [promptId]);
  }
});
