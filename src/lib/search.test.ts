import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { eq } from "drizzle-orm";
import { Redactor } from "./chat-errors";
import { getDb, type OrbitDb } from "./db";
import * as schema from "./db/schema";
import * as messages from "./messages";
import * as search from "./search";

const redact = new Redactor(null);

let db: OrbitDb;

before(() => {
  db = getDb();
  const now = new Date();
  db.insert(schema.user).values({ id: "u1", name: "One", email: "one@orbit.local" }).run();
  db.insert(schema.chats).values({ id: "c1", userId: "u1", title: "Notes", createdAt: now, updatedAt: now }).run();
});

after(() => {
  db?.$client.close();
});

function part(id: string, role: "user" | "assistant", text: string) {
  return { id, role, parts: [{ type: "text", text }] };
}

// The words a snippet flags as matches, and its text as the palette shows it.
function matched(snippet: search.SnippetPart[] | undefined) {
  return (snippet ?? []).filter((part) => part.match).map((part) => part.text);
}

function joined(snippet: search.SnippetPart[] | undefined) {
  return (snippet ?? []).map((part) => part.text).join("");
}

// The prompt a test reply with this id answers.
function prompt(answerId: string) {
  return part(`${answerId}-prompt`, "user", "ask");
}

// Saves an assistant reply after path, as POST /api/chat does for a request that ends in an unsaved
// assistant message: the reply takes that message's id.
function reply(chatId: string, path: { id: string; role: string; parts: unknown[] }[], answer: { id: string; parts: unknown[] }) {
  const plan = messages.planChatWrite(chatId, [...path, { id: answer.id, role: "assistant", parts: [] }], redact);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  return messages.finishChatReply(plan, answer.parts, redact);
}

test("toOrMatchQuery keeps only content words", () => {
  assert.equal(search.toOrMatchQuery("Where do I deploy things?"), '"deploy" OR "things"');
  assert.equal(search.toOrMatchQuery("deploy Deploy DEPLOY"), '"deploy"');
  assert.equal(search.toOrMatchQuery("Fly.io"), '"fly" OR "io"');
  assert.equal(search.toOrMatchQuery("John's rust notes"), '"john" OR "rust" OR "notes"');
  assert.equal(search.toOrMatchQuery('say "hi"'), '"say" OR "hi"');
});

test("toOrMatchQuery quotes 200,000 consecutive letters within two seconds", () => {
  const word = "a".repeat(200_000);
  const started = performance.now();
  const query = search.toOrMatchQuery(word);
  const elapsed = performance.now() - started;

  assert.equal(query, `"${word}"`);
  assert.ok(elapsed < 2_000, `Building the query took ${elapsed.toFixed(0)} ms`);
});

test("toOrMatchQuery preserves how contractions affect content words", () => {
  const cases = [
    ["I don’t know what to do", '"know"'],
    ["isn't it", null],
    ["123don't", '"123"'],
    ["Don't", null],
    ["can't won't aren't", null],
    ["xdon't", null],
    ["don'tx", '"don" OR "tx"'],
    ["𐐀n’t", null],
  ] as const;
  for (const [input, expected] of cases) {
    assert.equal(search.toOrMatchQuery(input), expected, input);
  }
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
  assert.equal(reply("c1", [prompt("m-zebra")], part("m-zebra", "assistant", "A zebracorn stood in the road.")), true);
  const hits = search.searchMessages("u1", "zebracorn");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.messageId, "m-zebra");
  assert.equal(hits[0]?.chatTitle, "Notes");
  assert.equal(hits[0]?.role, "assistant");
  assert.deepEqual(hits[0]?.snippet, [
    { text: "A ", match: false },
    { text: "zebracorn", match: true },
    { text: " stood in the road.", match: false },
  ]);
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
  assert.equal(messages.persistIncoming("c-del", [part("m-del", "user", "please deletemeplease now")], redact), "ok");
  assert.ok(search.searchMessages("u1", "deletemeplease").some((hit) => hit.messageId === "m-del"));
  db.delete(schema.chats).where(eq(schema.chats.id, "c-del")).run();
  assert.equal(search.searchMessages("u1", "deletemeplease").length, 0);
});

test("an edited message is found by its new text only", () => {
  assert.equal(reply("c1", [prompt("m-edit")], part("m-edit", "assistant", "oldlabeltoken stays")), true);
  assert.equal(messages.updateMessageText("c1", "m-edit", "newlabeltoken stays", redact), true);
  assert.ok(search.searchMessages("u1", "newlabeltoken").some((hit) => hit.messageId === "m-edit"));
  assert.equal(search.searchMessages("u1", "oldlabeltoken").length, 0);
});

test("another user's chat never matches", () => {
  db.$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  const now = new Date();
  db.insert(schema.user).values({ id: "u2", name: "Two", email: "two@orbit.local" }).run();
  db.insert(schema.chats).values({ id: "c2", userId: "u2", title: "Secret", createdAt: now, updatedAt: now }).run();
  assert.equal(messages.persistIncoming("c2", [part("m-secret", "user", "onlyotherperson word")], redact), "ok");
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

test("a hit in the middle of a branch off the stored head opens the whole branch", () => {
  const now = new Date();
  db.insert(schema.chats).values({ id: "c-mid", userId: "u1", title: "Middle", createdAt: now, updatedAt: now }).run();
  const u1 = part("m-u1", "user", "first question");
  const a1 = part("m-a1", "assistant", "first answer");
  const u2 = part("m-u2", "user", "second question");
  const a2 = part("m-a2", "assistant", "second answer");
  const u2b = part("m-u2b", "user", "middlehit question");
  const a2b = part("m-a2b", "assistant", "middlehit answer");
  const u3b = part("m-u3b", "user", "later question");
  const a3b = part("m-a3b", "assistant", "later answer");
  assert.equal(reply("c-mid", [u1], a1), true);
  assert.equal(reply("c-mid", [u1, a1, u2], a2), true);
  assert.equal(reply("c-mid", [u1, a1, u2b], a2b), true);
  assert.equal(reply("c-mid", [u1, a1, u2b, a2b, u3b], a3b), true);
  db.update(schema.chats).set({ headId: "m-a2" }).where(eq(schema.chats.id, "c-mid")).run();
  const path = search.openHitPath("u1", "c-mid", "m-u2b");
  const head = db.select().from(schema.chats).where(eq(schema.chats.id, "c-mid")).get();
  assert.deepEqual(path, ["m-u1", "m-a1", "m-u2b", "m-a2b", "m-u3b", "m-a3b"]);
  assert.equal(head?.headId, "m-a2");
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
  assert.equal(reply("c1", [prompt("m-out")], toolMessage("m-out", { stdout: "rainbow-" + "gizmo7\n" })), true);
  const hits = search.searchMessages("u1", "rainbow-gizmo7");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.messageId, "m-out");
  assert.equal(hits[0]?.chatTitle, "Notes");
  assert.deepEqual(matched(hits[0]?.snippet), ["rainbow-gizmo7"]);
});

test("standard error is found too", () => {
  assert.equal(reply("c1", [prompt("m-err")], toolMessage("m-err", { stderr: "Traceback: wobbly" + "kettle9 failed\n" })), true);
  const hits = search.searchMessages("u1", "wobblykettle9");
  assert.deepEqual(hits.map((hit) => hit.messageId), ["m-err"]);
});

test("a reply that repeats the output gives one hit for the message", () => {
  assert.equal(reply("c1", [prompt("m-dup")], toolMessage("m-dup", { stdout: "echoedtoken42\n" }, "The program printed echoedtoken42.")), true);
  const hits = search.searchMessages("u1", "echoedtoken42");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.messageId, "m-dup");
});

test("the source of a code run is found, and the hit opens that message", () => {
  assert.equal(reply("c1", [prompt("m-src")], toolMessage("m-src", { code: "secret_name = 'sourceonlytoken5'", stdout: "ok\n" })), true);
  const hits = search.searchMessages("u1", "sourceonlytoken5");
  assert.deepEqual(hits.map((hit) => hit.messageId), ["m-src"]);
  assert.equal(hits[0]?.role, "assistant");
  assert.deepEqual(matched(hits[0]?.snippet), ["sourceonlytoken5"]);
});

test("the source of a run that was stopped is found", () => {
  const stopped = {
    id: "m-stopped",
    role: "assistant" as const,
    parts: [
      { type: "tool-run_code", toolCallId: "call-stopped", state: "output-error", input: { language: "python", code: "while True: stoppedsourcetoken6()" }, errorText: "Code run was stopped" },
    ],
  };
  assert.equal(reply("c1", [prompt(stopped.id)], stopped), true);
  assert.deepEqual(search.searchMessages("u1", "stoppedsourcetoken6").map((hit) => hit.messageId), ["m-stopped"]);
});

test("a message with two runs finds the source of each run in one hit", () => {
  const first = toolMessage("m-two", { code: "alpharuntoken7()", stdout: "one\n" });
  const second = toolMessage("m-two", { code: "omegaruntoken8()", stdout: "two\n" });
  const both = { ...first, parts: [first.parts[0], second.parts[0], first.parts[1]] };
  assert.equal(reply("c1", [prompt(both.id)], both), true);
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
  assert.equal(reply("c1", [prompt("m-ansi")], toolMessage("m-ansi", { stdout: "\u001b[31mcrimsonword8\u001b[0m\n" })), true);
  const hits = search.searchMessages("u1", "crimsonword8");
  assert.equal(hits.length, 1);
  assert.doesNotMatch(joined(hits[0]?.snippet), /\u001b|\[31m/);
});

test("a reopened chat still finds output-only text after the message is saved again", () => {
  const again = toolMessage("m-out", { stdout: "rainbow-" + "gizmo7\n" });
  const plan = messages.planChatWrite("c1", [prompt(again.id), again], redact);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(messages.finishChatReply(plan, again.parts, redact), true);
  assert.deepEqual(search.searchMessages("u1", "rainbow-gizmo7").map((hit) => hit.messageId), ["m-out"]);
});

test("a snippet drops markdown markers, also where a heading follows the leading ellipsis", () => {
  const filler = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const text = `${filler}\n\n## Kettlewing notes\n- **bold** item with \`code\` and a [link](https://example.com/kettlewing)`;
  assert.equal(reply("c1", [prompt("m-md")], part("m-md", "assistant", text)), true);
  const [hit] = search.searchMessages("u1", "kettlewing");
  assert.equal(hit?.messageId, "m-md");
  assert.deepEqual(matched(hit?.snippet), ["Kettlewing"]);
  assert.match(joined(hit?.snippet), /^…/);
  assert.doesNotMatch(joined(hit?.snippet), /#|\*|`|\]\(|[\uE000\uE001]/);
  assert.match(joined(hit?.snippet), /Kettlewing notes bold item with code and a link$/);

  // FTS5 starts a snippet at a token, so this is the shape plainText sees when a cut lands on a marker.
  assert.deepEqual(search.snippetParts("…## \uE000Deploy\uE001 steps\n- **run** it"), [
    { text: "…", match: false },
    { text: "Deploy", match: true },
    { text: " steps run it", match: false },
  ]);
});

test("literal brackets in a message stay plain text in its snippet", () => {
  assert.equal(reply("c1", [prompt("m-tag")], part("m-tag", "assistant", "Please [qa:remember] the quokkafern")), true);
  const [byWord] = search.searchMessages("u1", "quokkafern");
  assert.deepEqual(byWord?.snippet, [{ text: "Please [qa:remember] the ", match: false }, { text: "quokkafern", match: true }]);
  const [byTag] = search.searchMessages("u1", "remember");
  assert.deepEqual(byTag?.snippet, [
    { text: "Please [qa:", match: false },
    { text: "remember", match: true },
    { text: "] the quokkafern", match: false },
  ]);
});

test("a snippet of one 50,000-letter run is built within a second and carries no marker characters", () => {
  assert.equal(reply("c1", [prompt("m-run")], part("m-run", "assistant", `yakfrost ${"a".repeat(50_000)}`)), true);
  const started = performance.now();
  const [hit] = search.searchMessages("u1", "yakfrost");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, `search took ${elapsed.toFixed(0)} ms`);
  assert.deepEqual(matched(hit?.snippet), ["yakfrost"]);
  assert.doesNotMatch(joined(hit?.snippet), /[\uE000\uE001]/);
  const parts = "\uE000a\uE001 ".repeat(25_000);
  const scanned = performance.now();
  assert.equal(search.snippetParts(parts).filter((part) => part.match).length, 25_000);
  assert.ok(performance.now() - scanned < 1_000, "scanning 25,000 matches took over a second");
});
