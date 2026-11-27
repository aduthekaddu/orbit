import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { Redactor } from "./chat-errors";
import { getDb, type OrbitDb } from "./db";
import * as schema from "./db/schema";
import {
  beginTurn,
  chatExists,
  chatTitle,
  deleteChat,
  finishChatReply,
  listMessages,
  persistIncoming,
  planChatWrite,
  plainText,
  createChat,
  renameChat,
  storedAssistantParts,
  updateMessageText,
} from "./messages";
import { saveMemory } from "./memory/store";
import { searchMessages } from "./search";

const redact = new Redactor(null);

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
  const plan = mods.planChatWrite(chatId, [...path, pending(answer.id)], redact);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(mods.finishChatReply(plan, answer.parts, redact), true);
}

test("resending a full history writes nothing", () => {
  const history = [
    message("m1", "user", "one"),
    message("m2", "assistant", "two"),
    message("m3", "user", "three"),
  ];
  reply("c1", [history[0]], history[1]);
  assert.equal(mods.persistIncoming("c1", history, redact), "ok");
  const before = changes();
  assert.equal(mods.persistIncoming("c1", history, redact), "ok");
  assert.equal(changes() - before, 0);
});

test("a new message is written once", () => {
  const history = [message("m1", "user", "one"), message("m4", "user", "four")];
  assert.equal(mods.persistIncoming("c1", history, redact), "ok");
  assert.equal(mods.listMessages("c1").filter((message) => message.id === "m4").length, 1);
  assert.deepEqual(mods.db.$client.prepare("select head_id from chats where id = ?").get("c1"), { head_id: "m4" });
});

test("a message id from another chat is rejected", () => {
  mods.db
    .insert(mods.schema.messages)
    .values({ id: "m9", chatId: "c2", role: "user", content: "x", parts: "[]", position: 0, createdAt: new Date() })
    .run();
  assert.equal(mods.persistIncoming("c1", [message("m9", "user", "x")], redact), "cross-chat");
});

test("a reply keeps its prompt's place when two requests finish out of order", () => {
  const now = new Date();
  mods.db.insert(mods.schema.chats).values({ id: "c3", userId: "u1", title: "Three", createdAt: now, updatedAt: now }).run();
  const a = mods.planChatWrite("c3", [message("p-a", "user", "prompt a"), pending("r-a")], redact);
  const b = mods.planChatWrite("c3", [message("p-a", "user", "prompt a"), message("p-b", "user", "prompt b"), pending("r-b")], redact);
  if ("error" in a || "error" in b) assert.fail("write refused");

  assert.equal(mods.finishChatReply(b, message("r-b", "assistant", "reply b").parts, redact), true);
  assert.equal(mods.finishChatReply(a, message("r-a", "assistant", "reply a").parts, redact), true);

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
  assert.equal(mods.persistIncoming(chat, history, redact), "ok");
  assert.deepEqual(mods.planChatWrite(chat, [message("new", "assistant", "bad")], redact, "submit-message", "eu"), {
    error: "invalid-edit",
  });
  assert.equal(mods.listMessages(chat).length, 3);
  assert.ok(mods.planChatWrite(chat, [message("new", "user", "edited")], redact, "submit-message", "eu"));
  assert.deepEqual(mods.listMessages(chat).map((row) => row.id).sort(), ["eu", "ea", "eu2", "new"].sort());
});

test("reply text editing keeps tool parts and stale echoes cannot overwrite it", () => {
  const parts = [{ type: "text", text: "before" }, { type: "tool-render_ui", toolCallId: "t1", state: "output-available", input: {}, output: { ok: true } }];
  reply("c2", [message("edited-prompt", "user", "ask")], { id: "edited-answer", parts });
  assert.equal(mods.updateMessageText("c2", "edited-answer", "after", redact), true);
  mods.persistIncoming("c2", [message("edited-prompt", "user", "ask"), { id: "edited-answer", role: "assistant", parts }], redact);
  const saved = mods.listMessages("c2").find((row) => row.id === "edited-answer")!;
  assert.deepEqual(saved.parts, [{ type: "text", text: "after" }, parts[1]]);
});

test("a blank or whitespace-only reply edit does not change the stored row", () => {
  reply("c2", [message("blank-prompt", "user", "ask")], message("blank-answer", "assistant", "keep me"));
  assert.equal(mods.updateMessageText("c2", "blank-answer", "", redact), false);
  assert.equal(mods.updateMessageText("c2", "blank-answer", "   ", redact), false);
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

  assert.equal(mods.updateMessageText(chat, "pp1", "rewritten", redact), false);
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
  assert.equal(mods.updateMessageText("c2", "indexed-answer", "new code", redact, 2), true);
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
  const plan = mods.planChatWrite("c1", [message("joined-prompt", "user", "ask"), pending("joined-reply")], redact);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(mods.finishChatReply(plan, parts, redact), true);
  const row = mods.db.$client.prepare("select content from messages where id = ?").get("joined-reply") as { content: string };
  assert.equal(row.content, "[redacted]\n[redacted]\nprint(1)");
});

test("a saved reply's parts and search text carry no credential that a part holds whole", () => {
  const key = "made-up-provider-key";
  const redact = new Redactor({ apiKey: key, tavilyApiKey: "", githubToken: "" });
  const parts = [{ type: "text", text: `the key is ${key}` }];
  const plan = mods.planChatWrite("c1", [message("whole-prompt", "user", "ask"), pending("whole-reply")], redact);
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
  const plan = mods.planChatWrite("c1", [prompt, initial], redact);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  const continued = [{ type: "text", text: "first " }, { type: "text", text: key.slice(0, 9) }, { type: "text", text: key.slice(9) }, { type: "text", text: ` and ${key}` }];
  assert.equal(mods.finishChatReply(plan, continued, redact), true);
  const row = mods.db.$client.prepare("select content, parts from messages where id = ?").get("continued-redact-reply") as { content: string; parts: string };
  assert.equal(row.content, "first [redacted] and [redacted]");
  assert.deepEqual(JSON.parse(row.parts), [
    { type: "text", text: "first " },
    { type: "text", text: "[redacted]" },
    { type: "text", text: "" },
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

const OTHER = "u-other";
let otherUserReady = false;

// A second account, as slice 18 allows. The single-user trigger refuses it, so tests drop the trigger first.
function otherUser() {
  if (otherUserReady) return OTHER;
  mods.db.$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  mods.db.insert(mods.schema.user).values({ id: OTHER, name: "Other", email: "other@orbit.local" }).run();
  otherUserReady = true;
  return OTHER;
}

function chatRow(id: string) {
  return mods.db.$client.prepare("select id, user_id, title, updated_at from chats where id = ?").get(id) as
    | { id: string; user_id: string; title: string; updated_at: number }
    | undefined;
}

function messageCount(chatId: string) {
  return (mods.db.$client.prepare("select count(*) as n from messages where chat_id = ?").get(chatId) as { n: number }).n;
}

function insertChat(id: string, userId: string, title = "New chat", updatedAt = new Date(1_000)) {
  mods.db.insert(mods.schema.chats).values({ id, userId, title, createdAt: updatedAt, updatedAt }).run();
}

function ftsIntact() {
  mods.db.$client.prepare("insert into messages_fts(messages_fts) values('integrity-check')").run();
  return true;
}

test("plainText drops markdown markers and keeps every word", () => {
  const markdown = [
    "# Deploy notes",
    "",
    "- **Fly.io** runs `fly deploy` from the _main_ branch",
    "> see the [guide](https://example.com/guide) and ![logo](logo.png)",
    "1. first step",
    "```sh",
    "fly deploy --remote-only",
    "```",
    "~~old~~ words that keep going well past the eighty characters a sidebar title would keep",
  ].join("\n");
  assert.equal(
    plainText(markdown),
    "Deploy notes Fly.io runs fly deploy from the main branch see the guide and logo first step fly deploy --remote-only old words that keep going well past the eighty characters a sidebar title would keep",
  );
  assert.equal(chatTitle(markdown).endsWith("…"), true, "a title is still cut to one line");
});

test("plainText and chatTitle finish quickly on 50,000 repeats of one character", () => {
  for (const unit of ["a", "[", "(", "#", "*", "_", "`", "1", "!", "[x](", "\n"]) {
    const text = unit.repeat(Math.ceil(50_000 / unit.length));
    const started = performance.now();
    plainText(text);
    chatTitle(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `${JSON.stringify(unit)} took ${elapsed.toFixed(0)} ms`);
  }
});

test("chatExists sees a chat of any owner and no missing one", () => {
  insertChat("exists-other", otherUser());
  assert.equal(chatExists("exists-other"), true);
  assert.equal(chatExists("c1"), true);
  assert.equal(chatExists("never-made"), false);
});

test("renameChat trims and masks the title, keeps updated_at, and ignores another user's chat", () => {
  const key = "made-up-provider-key";
  const masking = new Redactor({ apiKey: key, tavilyApiKey: "", githubToken: "" });
  insertChat("rename-me", "u1", "Old title", new Date(5_000));
  assert.deepEqual(renameChat("rename-me", "u1", "  Trip plans  ", masking), { id: "rename-me", title: "Trip plans" });
  assert.deepEqual(chatRow("rename-me"), { id: "rename-me", user_id: "u1", title: "Trip plans", updated_at: 5_000 });
  assert.deepEqual(renameChat("rename-me", "u1", `key ${key}`, masking), { id: "rename-me", title: "key [redacted]" });
  assert.equal(chatRow("rename-me")?.title, "key [redacted]");
  assert.deepEqual(renameChat("rename-me", "u1", "New chat", masking), { id: "rename-me", title: "New chat" });

  insertChat("rename-other", otherUser(), "Theirs");
  assert.equal(renameChat("rename-other", "u1", "Mine now", masking), null);
  assert.equal(chatRow("rename-other")?.title, "Theirs");
  assert.equal(renameChat("rename-missing", "u1", "Anything", masking), null);
  assert.equal(chatRow("rename-missing"), undefined);
});

test("deleteChat removes the chat and its messages, keeps the search index whole, and keeps linked memories without a source", () => {
  insertChat("delete-me", "u1", "Gone soon");
  reply("delete-me", [message("dm-u1", "user", "the plumquartz plan")], message("dm-a1", "assistant", "plumquartz answer"));
  const linked = saveMemory({ text: "The plan is plumquartz", kind: "fact", source: "dream", sourceChatId: "delete-me", sourceMessageId: "dm-u1" });
  assert.equal(searchMessages("u1", "plumquartz").length, 2);

  insertChat("delete-other", otherUser(), "Theirs");
  reply("delete-other", [message("do-u1", "user", "their plumquartz")], message("do-a1", "assistant", "their answer"));
  assert.equal(deleteChat("delete-other", "u1"), false);
  assert.equal(chatRow("delete-other")?.title, "Theirs");
  assert.equal(messageCount("delete-other"), 2);

  assert.equal(deleteChat("delete-me", "u1"), true);
  assert.equal(chatRow("delete-me"), undefined);
  assert.equal(messageCount("delete-me"), 0);
  assert.equal(ftsIntact(), true);
  assert.deepEqual(searchMessages("u1", "plumquartz"), []);
  const memory = mods.db.$client.prepare("select text, source_chat_id, source_message_id from memories where id = ?").get(linked.id);
  assert.deepEqual(memory, { text: "The plan is plumquartz", source_chat_id: null, source_message_id: null });
  assert.equal(deleteChat("delete-me", "u1"), false);
});

test("beginTurn creates a missing chat together with its first prompt", () => {
  const turn = beginTurn("first-turn", "u1", [message("ft-u1", "user", "hello there")], redact, "submit-message");
  if (!turn.ok) assert.fail(`turn refused: ${turn.error}`);
  assert.equal(turn.messagesBeforeTurn, 0);
  assert.equal(turn.chat.id, "first-turn");
  assert.equal(turn.chat.userId, "u1");
  assert.equal(turn.chat.title, "New chat");
  assert.equal(turn.chat.headId, "ft-u1");
  assert.equal(turn.write.prompt.id, "ft-u1");
  assert.deepEqual(listMessages("first-turn").map(({ id }) => id), ["ft-u1"]);

  assert.equal(finishChatReply(turn.write, message("ft-a1", "assistant", "hi").parts, redact), true);
  const next = beginTurn("first-turn", "u1", [...listMessages("first-turn"), message("ft-u2", "user", "again")], redact, "submit-message");
  if (!next.ok) assert.fail(`turn refused: ${next.error}`);
  assert.equal(next.messagesBeforeTurn, 2);
  assert.equal(next.chat.headId, "ft-u2");
});

test("a refused first turn leaves no chat row behind", () => {
  reply("c2", [message("cross-u1", "user", "stored elsewhere")], message("cross-a1", "assistant", "here"));
  const refused = [
    ["stale", [message("st-a1", "assistant", "an answer nobody saved"), message("st-u1", "user", "and then?")], "submit-message", undefined],
    ["invalid-edit", [message("ie-u1", "user", "edited")], "submit-message", "ie-missing"],
    ["cross-chat", [message("cross-u1", "user", "stored elsewhere")], "submit-message", undefined],
    ["no-prompt", [message("np-a1", "assistant", "only an answer")], "submit-message", undefined],
    ["not-found", [message("rg-u1", "user", "retry me")], "regenerate-message", undefined],
  ] as const;
  for (const [error, incoming, trigger, editMessageId] of refused) {
    const chatId = `refused-${error}`;
    assert.deepEqual(beginTurn(chatId, "u1", [...incoming], redact, trigger, editMessageId), { ok: false, error }, error);
    assert.equal(chatExists(chatId), false, `${error} left a chat row`);
    assert.equal(messageCount(chatId), 0, `${error} left a message row`);
  }
});

test("beginTurn answers not-found for another user's chat and writes nothing to it", () => {
  insertChat("turn-other", otherUser(), "Theirs", new Date(7_000));
  reply("turn-other", [message("to-u1", "user", "their question")], message("to-a1", "assistant", "their answer"));
  const before = listMessages("turn-other");
  assert.deepEqual(
    beginTurn("turn-other", "u1", [...before, message("to-u2", "user", "my question")], redact, "submit-message"),
    { ok: false, error: "not-found" },
  );
  assert.deepEqual(listMessages("turn-other"), before);
  assert.equal(chatRow("turn-other")?.user_id, OTHER);
});

test("rename applies its display redactor to the normalized title", (t) => {
  const chat = createChat("u1");
  const display = new Redactor(null);
  const text = t.mock.method(display, "text", (value: string) => value === "Trip plans" ? "Display title" : value);
  const renamed = renameChat(chat.id, "u1", " Trip  plans ", display);
  assert.deepEqual(text.mock.calls.map((call) => call.arguments[0]), [" Trip  plans ", "Trip plans"]);
  assert.equal(renamed?.title, "Display title");
});
