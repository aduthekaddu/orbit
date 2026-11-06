import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-run-output-migration-"));
process.env.ORBIT_DATA_DIR = dataDir;

type DbModule = typeof import("./index");
type SchemaModule = typeof import("./schema");
type SearchModule = typeof import("../search");

let db: DbModule["db"];
let schema: SchemaModule;
let search: SearchModule;
const backfill = fs.readFileSync(path.join(process.cwd(), "drizzle/0004_run_output_search.sql"), "utf8");

function run(stdout: string, stderr = "") {
  return { type: "tool-run_code", toolCallId: "t", state: "output-available", input: { language: "python", code: "print(1)" }, output: { stdout, stderr, exitCode: 0, durationMs: 9, timedOut: false, truncated: false } };
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
  // Rows as they were saved before this change: the text is in `content`, the run output only in `parts`.
  save("old-both", 1, "assistant", "Ran it.", [run("legacytoken-red\n", "legacywarn-kettle\n"), { type: "text", text: "Ran it." }]);
  save("old-only-output", 2, "assistant", "", [run("outputonlylegacy\n")]);
  save("old-blank", 3, "assistant", "", [run("\n", "  \n")]);
  save("old-stopped", 4, "assistant", "", [{ type: "tool-run_code", toolCallId: "s", state: "output-error", input: { language: "python", code: "x" }, errorText: "Code run was stopped" }]);
  save("old-color", 7, "assistant", "", [run("\u001b[31mcolorlegacy\u001b[0m done\n", "\u001b]0;title\u0007warnlegacy\n")]);
  save("old-two-runs", 8, "assistant", "between", [run("first-out\n", "first-err\n"), { type: "text", text: "between" }, run("second-out\n", "second-err\n")]);
  save("old-text", 5, "assistant", "just words", [{ type: "text", text: "just words" }]);
  save("old-user", 6, "user", "run it please", [{ type: "text", text: "run it please" }]);
  db.$client.exec(backfill);
});

function content(id: string) {
  return (db.$client.prepare("SELECT content FROM messages WHERE id = ?").get(id) as { content: string }).content;
}

test("the migration adds standard output and standard error to saved messages", () => {
  assert.equal(content("old-both"), "Ran it.\nlegacytoken-red\n\nlegacywarn-kettle\n");
  assert.equal(content("old-only-output"), "outputonlylegacy\n");
});

test("the migration leaves messages without printed output as they were", () => {
  assert.equal(content("old-blank"), "");
  assert.equal(content("old-stopped"), "");
  assert.equal(content("old-text"), "just words");
  assert.equal(content("old-user"), "run it please");
});

test("saved output is found by search after the migration", () => {
  assert.deepEqual(search.searchMessages("u1", "legacytoken-red").map((hit) => hit.messageId), ["old-both"]);
  assert.deepEqual(search.searchMessages("u1", "legacywarn-kettle").map((hit) => hit.messageId), ["old-both"]);
  assert.deepEqual(search.searchMessages("u1", "outputonlylegacy").map((hit) => hit.messageId), ["old-only-output"]);
});

test("the migration removes terminal escape sequences from saved output", () => {
  assert.equal(content("old-color"), "colorlegacy done\n\nwarnlegacy\n");
  assert.deepEqual(search.searchMessages("u1", "colorlegacy").map((hit) => hit.messageId), ["old-color"]);
  assert.deepEqual(search.searchMessages("u1", "warnlegacy").map((hit) => hit.messageId), ["old-color"]);
  assert.doesNotMatch(search.searchMessages("u1", "colorlegacy")[0]?.snippet ?? "", /\u001b|\[31m/);
});

test("the migration keeps the output of several runs in the order of the chat", () => {
  assert.equal(content("old-two-runs"), "between\nfirst-out\n\nfirst-err\n\nsecond-out\n\nsecond-err\n");
});

test("this migration and the next one write the same search text that a new save writes", async () => {
  const { searchTextFromParts } = await import("../messages");
  // A new save also writes the source of each run, which 0005 adds. Run it last, after the checks above.
  db.$client.exec(fs.readFileSync(path.join(process.cwd(), "drizzle/0005_run_source_search.sql"), "utf8"));
  for (const id of ["old-both", "old-only-output", "old-color", "old-two-runs", "old-blank", "old-stopped", "old-text", "old-user"]) {
    const row = db.$client.prepare("SELECT parts FROM messages WHERE id = ?").get(id) as { parts: string };
    assert.equal(content(id), searchTextFromParts(JSON.parse(row.parts)), id);
  }
});
