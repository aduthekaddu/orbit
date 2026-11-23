import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";
import { eq } from "drizzle-orm";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-search-"));
process.env.ORBIT_DATA_DIR = dataDir;

type SearchModule = typeof import("./search");
type MessageModule = typeof import("./messages");
type DbModule = typeof import("./db");
type SchemaModule = typeof import("./db/schema");

let search: SearchModule;
let messages: MessageModule;
let db: DbModule["db"];
let schema: SchemaModule;

before(async () => {
  const dbModule = await import("./db");
  schema = await import("./db/schema");
  messages = await import("./messages");
  search = await import("./search");
  db = dbModule.db;
  const now = new Date();
  db.insert(schema.user).values({ id: "u1", name: "One", email: "one@orbit.local" }).run();
  db.insert(schema.chats).values({ id: "c1", userId: "u1", title: "Notes", createdAt: now, updatedAt: now }).run();
});

function part(id: string, role: "user" | "assistant", text: string) {
  return { id, role, parts: [{ type: "text", text }] };
}

// Saves an assistant reply after path, as POST /api/chat does for a request that ends in an unsaved
// assistant message: the reply takes that message's id.
function reply(chatId: string, path: { id: string; role: string; parts: unknown[] }[], answer: { id: string; parts: unknown[] }) {
  const plan = messages.planChatWrite(chatId, [...path, { id: answer.id, role: "assistant", parts: [] }]);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  return messages.finishChatReply(plan, answer.parts);
}

test("toOrMatchQuery keeps only content words", () => {
  assert.equal(search.toOrMatchQuery("Where do I deploy things?"), '"deploy" OR "things"');
  assert.equal(search.toOrMatchQuery("deploy Deploy DEPLOY"), '"deploy"');
  assert.equal(search.toOrMatchQuery("Fly.io"), '"fly" OR "io"');
  assert.equal(search.toOrMatchQuery("John's rust notes"), '"john" OR "rust" OR "notes"');
  assert.equal(search.toOrMatchQuery('say "hi"'), '"say" OR "hi"');
});

test("toOrMatchQuery is null when the question has no content word", () => {
  assert.equal(search.toOrMatchQuery("What is 2+2?"), null);
  assert.equal(search.toOrMatchQuery("It isn't what I'm after"), null);
  assert.equal(search.toOrMatchQuery("  "), null);
});

test("toMatchQuery quotes every token and prefixes the last one", () => {
  assert.equal(search.toMatchQuery("zebra"), '"zebra"*');
  assert.equal(search.toMatchQuery("zebra corn"), '"zebra" "corn"*');
  assert.equal(search.toMatchQuery('say "hi"'), '"say" """hi"""*');
  assert.equal(search.toMatchQuery("  "), null);
});

test("a stored word matches and the snippet marks it", () => {
  assert.equal(reply("c1", [], part("m-zebra", "assistant", "A zebracorn stood in the road.")), true);
  const hits = search.searchMessages("u1", "zebracorn");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.messageId, "m-zebra");
  assert.equal(hits[0]?.chatTitle, "Notes");
  assert.equal(hits[0]?.role, "assistant");
  assert.match(hits[0]?.snippet ?? "", /\[zebracorn\]/);
});

test("a prefix of the last token matches", () => {
  const hits = search.searchMessages("u1", "zebra");
  assert.ok(hits.some((hit) => hit.messageId === "m-zebra"));
});

test("hostile search text returns no error", (t) => {
  const diagnostic = t.mock.method(console, "error", () => {});
  for (const query of ['"', "*", "-", "NEAR", "("]) {
    const hits = search.searchMessages("u1", query);
    assert.ok(Array.isArray(hits), query);
  }
  assert.equal(diagnostic.mock.callCount(), 0);
});

test("a broken search index records a diagnostic without message or query text", (t) => {
  const diagnostic = t.mock.method(console, "error", () => {});
  db.$client.exec("SAVEPOINT search_failure");
  try {
    db.$client.exec("DROP TABLE messages_fts");
    assert.deepEqual(search.searchMessages("u1", "privatequerytoken"), []);
    assert.equal(diagnostic.mock.callCount(), 1);
    assert.deepEqual(diagnostic.mock.calls[0]?.arguments[1], { code: "SQLITE_ERROR" });
    const output = JSON.stringify(diagnostic.mock.calls[0]?.arguments);
    assert.match(output, /SQLITE_ERROR/);
    assert.doesNotMatch(output, /privatequerytoken|zebracorn|stood in the road/);
  } finally {
    db.$client.exec("ROLLBACK TO search_failure; RELEASE search_failure");
  }
});

test("deleting a chat drops its messages from search", () => {
  const now = new Date();
  db.insert(schema.chats).values({ id: "c-del", userId: "u1", title: "Gone", createdAt: now, updatedAt: now }).run();
  assert.equal(messages.persistIncoming("c-del", [part("m-del", "user", "please deletemeplease now")]), "ok");
  assert.ok(search.searchMessages("u1", "deletemeplease").some((hit) => hit.messageId === "m-del"));
  db.delete(schema.chats).where(eq(schema.chats.id, "c-del")).run();
  assert.equal(search.searchMessages("u1", "deletemeplease").length, 0);
});

test("an edited message is found by its new text only", () => {
  assert.equal(reply("c1", [], part("m-edit", "assistant", "oldlabeltoken stays")), true);
  assert.equal(messages.updateMessageText("c1", "m-edit", "newlabeltoken stays"), true);
  assert.ok(search.searchMessages("u1", "newlabeltoken").some((hit) => hit.messageId === "m-edit"));
  assert.equal(search.searchMessages("u1", "oldlabeltoken").length, 0);
});

test("another user's chat never matches", () => {
  db.$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  const now = new Date();
  db.insert(schema.user).values({ id: "u2", name: "Two", email: "two@orbit.local" }).run();
  db.insert(schema.chats).values({ id: "c2", userId: "u2", title: "Secret", createdAt: now, updatedAt: now }).run();
  assert.equal(messages.persistIncoming("c2", [part("m-secret", "user", "onlyotherperson word")]), "ok");
  assert.equal(search.searchMessages("u1", "onlyotherperson").length, 0);
  assert.ok(search.searchMessages("u2", "onlyotherperson").some((hit) => hit.messageId === "m-secret"));
});

test("a hit off the stored head opens that path and leaves the head", () => {
  const now = new Date();
  db.insert(schema.chats).values({ id: "c-branch", userId: "u1", title: "Branch", createdAt: now, updatedAt: now }).run();
  const root = part("u-root", "user", "which way");
  assert.equal(reply("c-branch", [root], part("a-active", "assistant", "alpha leaf")), true);
  assert.equal(reply("c-branch", [root], part("a-side", "assistant", "zebrapath leaf")), true);
  db.update(schema.chats).set({ headId: "a-active" }).where(eq(schema.chats.id, "c-branch")).run();
  const path = search.openHitPath("u1", "c-branch", "a-side");
  const head = db.select().from(schema.chats).where(eq(schema.chats.id, "c-branch")).get();
  assert.deepEqual(path, ["u-root", "a-side"]);
  assert.equal(head?.headId, "a-active");
});

function toolMessage(id: string, run: { stdout?: string; stderr?: string; code?: string }, reply = "Ran it.") {
  return {
    id,
    role: "assistant" as const,
    parts: [
      {
        type: "tool-run_code",
        toolCallId: `call-${id}`,
        state: "output-available",
        input: { language: "python", code: run.code ?? "print('x')" },
        output: { stdout: run.stdout ?? "", stderr: run.stderr ?? "", exitCode: 0, durationMs: 12, timedOut: false, truncated: false },
      },
      { type: "text", text: reply },
    ],
  };
}

test("text that only a code run printed is found, and the hit opens that message", () => {
  assert.equal(reply("c1", [], toolMessage("m-out", { stdout: "rainbow-" + "gizmo7\n" })), true);
  const hits = search.searchMessages("u1", "rainbow-gizmo7");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.messageId, "m-out");
  assert.equal(hits[0]?.chatTitle, "Notes");
  assert.match(hits[0]?.snippet ?? "", /\[rainbow-gizmo7\]/);
});

test("standard error is found too", () => {
  assert.equal(reply("c1", [], toolMessage("m-err", { stderr: "Traceback: wobbly" + "kettle9 failed\n" })), true);
  const hits = search.searchMessages("u1", "wobblykettle9");
  assert.deepEqual(hits.map((hit) => hit.messageId), ["m-err"]);
});

test("a reply that repeats the output gives one hit for the message", () => {
  assert.equal(reply("c1", [], toolMessage("m-dup", { stdout: "echoedtoken42\n" }, "The program printed echoedtoken42.")), true);
  const hits = search.searchMessages("u1", "echoedtoken42");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.messageId, "m-dup");
});

test("the source of a code run is found, and the hit opens that message", () => {
  assert.equal(reply("c1", [], toolMessage("m-src", { code: "secret_name = 'sourceonlytoken5'", stdout: "ok\n" })), true);
  const hits = search.searchMessages("u1", "sourceonlytoken5");
  assert.deepEqual(hits.map((hit) => hit.messageId), ["m-src"]);
  assert.equal(hits[0]?.role, "assistant");
  assert.match(hits[0]?.snippet ?? "", /\[sourceonlytoken5\]/);
});

test("the source of a run that was stopped is found", () => {
  const stopped = {
    id: "m-stopped",
    role: "assistant" as const,
    parts: [
      { type: "tool-run_code", toolCallId: "call-stopped", state: "output-error", input: { language: "python", code: "while True: stoppedsourcetoken6()" }, errorText: "Code run was stopped" },
    ],
  };
  assert.equal(reply("c1", [], stopped), true);
  assert.deepEqual(search.searchMessages("u1", "stoppedsourcetoken6").map((hit) => hit.messageId), ["m-stopped"]);
});

test("a message with two runs finds the source of each run in one hit", () => {
  const first = toolMessage("m-two", { code: "alpharuntoken7()", stdout: "one\n" });
  const second = toolMessage("m-two", { code: "omegaruntoken8()", stdout: "two\n" });
  const both = { ...first, parts: [first.parts[0], second.parts[0], first.parts[1]] };
  assert.equal(reply("c1", [], both), true);
  assert.deepEqual(search.searchMessages("u1", "alpharuntoken7").map((hit) => hit.messageId), ["m-two"]);
  assert.deepEqual(search.searchMessages("u1", "omegaruntoken8").map((hit) => hit.messageId), ["m-two"]);
});

test("search text is the reply, then the output of each run, then the source of each run", () => {
  const run = (code: string, stdout: string) => ({ type: "tool-run_code", toolCallId: code, state: "output-available", input: { language: "python", code }, output: { stdout, stderr: "", exitCode: 0, durationMs: 1, timedOut: false, truncated: false } });
  const parts = [run("src_one()", "first-out\n"), { type: "text", text: "between" }, run("src_two()", "second-out\n")];
  assert.equal(messages.searchTextFromParts(parts), "between\nfirst-out\n\nsecond-out\n\nsrc_one()\nsrc_two()");
});

test("a run with blank source adds nothing, and the code of another tool is not read", () => {
  const blank = { type: "tool-run_code", toolCallId: "b", state: "output-available", input: { language: "python", code: "  \n" }, output: { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false, truncated: false } };
  const other = { type: "tool-web_search", toolCallId: "w", state: "output-available", input: { code: "othertooltoken9" }, output: {} };
  assert.equal(messages.searchTextFromParts([blank, other, { type: "text", text: "just words" }]), "just words");
});

test("colored output is found by its words and the snippet has no escape bytes", () => {
  assert.equal(reply("c1", [], toolMessage("m-ansi", { stdout: "\u001b[31mcrimsonword8\u001b[0m\n" })), true);
  const hits = search.searchMessages("u1", "crimsonword8");
  assert.equal(hits.length, 1);
  assert.doesNotMatch(hits[0]?.snippet ?? "", /\u001b|\[31m/);
});

test("a reopened chat still finds output-only text after the message is saved again", () => {
  const again = toolMessage("m-out", { stdout: "rainbow-" + "gizmo7\n" });
  const plan = messages.planChatWrite("c1", [again]);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(messages.finishChatReply(plan, again.parts), true);
  assert.deepEqual(search.searchMessages("u1", "rainbow-gizmo7").map((hit) => hit.messageId), ["m-out"]);
});
