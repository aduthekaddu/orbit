import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { before } from "node:test";

type DbModule = typeof import("./index");
type SchemaModule = typeof import("./schema");
type SearchModule = typeof import("../search");

let db: DbModule["db"];
let schema: SchemaModule;
let search: SearchModule;
const backfill = fs.readFileSync(path.join(process.cwd(), "drizzle/0005_run_source_search.sql"), "utf8");

function run(code: unknown, stdout = "", stderr = "") {
  return { type: "tool-run_code", toolCallId: "t", state: "output-available", input: { language: "python", code }, output: { stdout, stderr, exitCode: 0, durationMs: 9, timedOut: false, truncated: false } };
}

function save(id: string, position: number, role: string, content: string, parts: unknown[]) {
  db.$client
    .prepare("INSERT INTO messages (id, chat_id, parent_id, role, content, parts, position, created_at) VALUES (?, 'c1', NULL, ?, ?, ?, ?, 1)")
    .run(id, role, content, JSON.stringify(parts), position);
}

before(async () => {
  const dbModule = await import("./index");
  schema = await import("./schema");
  search = await import("../search");
  db = dbModule.db;
  const now = new Date();
  db.insert(schema.user).values({ id: "u1", name: "One", email: "one@orbit.local" }).run();
  db.insert(schema.chats).values({ id: "c1", userId: "u1", title: "Old chat", createdAt: now, updatedAt: now }).run();
  // Rows as they were saved before this change: `content` holds the text and the run output, and the source is only in `parts`.
  save("old-both", 1, "assistant", "Ran it.\nlegacyout\n\nlegacyerr\n", [run("legacysource_one()", "legacyout\n", "legacyerr\n"), { type: "text", text: "Ran it." }]);
  save("old-silent", 2, "assistant", "", [run("silentsourcetoken()")]);
  save("old-stopped", 3, "assistant", "", [{ type: "tool-run_code", toolCallId: "s", state: "output-error", input: { language: "python", code: "while True: stoppedlegacy()" }, errorText: "Code run was stopped" }]);
  save("old-two-runs", 4, "assistant", "between\nfirst-out\n\nsecond-out\n", [run("src_one()", "first-out\n"), { type: "text", text: "between" }, run("src_two()", "second-out\n")]);
  save("old-blank", 5, "assistant", "", [run("  \n")]);
  save("old-skip-blank", 6, "assistant", "", [run("\t\n"), run("secondcodetoken()")]);
  save("old-not-text", 7, "assistant", "", [run(42)]);
  save("old-other-tool", 8, "assistant", "words", [{ type: "tool-web_search", toolCallId: "w", state: "output-available", input: { code: "othertoollegacy" }, output: {} }, { type: "text", text: "words" }]);
  save("old-text", 9, "assistant", "just words", [{ type: "text", text: "just words" }]);
  save("old-user", 10, "user", "run it please", [{ type: "text", text: "run it please" }]);
  save("old-colored", 11, "assistant", "colorout\n", [run("colorsource()", "\u001b[31mcolorout\u001b[0m\n")]);
  db.$client.exec(backfill);
});

function content(id: string) {
  return (db.$client.prepare("SELECT content FROM messages WHERE id = ?").get(id) as { content: string }).content;
}

test("the migration adds the source of each run after the output", () => {
  assert.equal(content("old-both"), "Ran it.\nlegacyout\n\nlegacyerr\n\nlegacysource_one()");
  assert.equal(content("old-silent"), "silentsourcetoken()");
  assert.equal(content("old-stopped"), "while True: stoppedlegacy()");
  assert.equal(content("old-colored"), "colorout\n\ncolorsource()");
});

test("the migration keeps the source of several runs in the order of the chat", () => {
  assert.equal(content("old-two-runs"), "between\nfirst-out\n\nsecond-out\n\nsrc_one()\nsrc_two()");
});

test("the migration leaves messages without source as they were", () => {
  assert.equal(content("old-blank"), "");
  assert.equal(content("old-not-text"), "");
  assert.equal(content("old-other-tool"), "words");
  assert.equal(content("old-text"), "just words");
  assert.equal(content("old-user"), "run it please");
});

test("the migration skips a run with blank source and keeps the next one", () => {
  assert.equal(content("old-skip-blank"), "secondcodetoken()");
});

test("saved source is found by search after the migration", () => {
  assert.deepEqual(search.searchMessages("u1", "legacysource_one").map((hit) => hit.messageId), ["old-both"]);
  assert.deepEqual(search.searchMessages("u1", "silentsourcetoken").map((hit) => hit.messageId), ["old-silent"]);
  assert.deepEqual(search.searchMessages("u1", "stoppedlegacy").map((hit) => hit.messageId), ["old-stopped"]);
  assert.deepEqual(search.searchMessages("u1", "othertoollegacy"), []);
});

test("the migration writes the same search text that a new save writes", async () => {
  const { searchTextFromParts } = await import("../messages");
  for (const id of ["old-both", "old-silent", "old-stopped", "old-two-runs", "old-blank", "old-skip-blank", "old-not-text", "old-other-tool", "old-text", "old-user", "old-colored"]) {
    const row = db.$client.prepare("SELECT parts FROM messages WHERE id = ?").get(id) as { parts: string };
    assert.equal(content(id), searchTextFromParts(JSON.parse(row.parts)), id);
  }
});
