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

test("toMatchQuery quotes every token and prefixes the last one", () => {
  assert.equal(search.toMatchQuery("zebra"), '"zebra"*');
  assert.equal(search.toMatchQuery("zebra corn"), '"zebra" "corn"*');
  assert.equal(search.toMatchQuery('say "hi"'), '"say" """hi"""*');
  assert.equal(search.toMatchQuery("  "), null);
});

test("a stored word matches and the snippet marks it", () => {
  assert.equal(messages.upsertMessage("c1", part("m-zebra", "assistant", "A zebracorn stood in the road."), null), true);
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
  messages.upsertMessage("c-del", part("m-del", "user", "please deletemeplease now"), null);
  assert.ok(search.searchMessages("u1", "deletemeplease").some((hit) => hit.messageId === "m-del"));
  db.delete(schema.chats).where(eq(schema.chats.id, "c-del")).run();
  assert.equal(search.searchMessages("u1", "deletemeplease").length, 0);
});

test("an edited message is found by its new text only", () => {
  messages.upsertMessage("c1", part("m-edit", "assistant", "oldlabeltoken stays"), "m-zebra");
  assert.equal(messages.updateMessageText("c1", "m-edit", "newlabeltoken stays"), true);
  assert.ok(search.searchMessages("u1", "newlabeltoken").some((hit) => hit.messageId === "m-edit"));
  assert.equal(search.searchMessages("u1", "oldlabeltoken").length, 0);
});

test("another user's chat never matches", () => {
  db.$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  const now = new Date();
  db.insert(schema.user).values({ id: "u2", name: "Two", email: "two@orbit.local" }).run();
  db.insert(schema.chats).values({ id: "c2", userId: "u2", title: "Secret", createdAt: now, updatedAt: now }).run();
  messages.upsertMessage("c2", part("m-secret", "user", "onlyotherperson word"), null);
  assert.equal(search.searchMessages("u1", "onlyotherperson").length, 0);
  assert.ok(search.searchMessages("u2", "onlyotherperson").some((hit) => hit.messageId === "m-secret"));
});

test("a hit off the stored head opens that path and leaves the head", () => {
  const now = new Date();
  db.insert(schema.chats).values({ id: "c-branch", userId: "u1", title: "Branch", createdAt: now, updatedAt: now }).run();
  messages.upsertMessage("c-branch", part("u-root", "user", "which way"), null);
  messages.upsertMessage("c-branch", part("a-active", "assistant", "alpha leaf"), "u-root");
  messages.upsertMessage("c-branch", part("a-side", "assistant", "zebrapath leaf"), "u-root");
  db.update(schema.chats).set({ headId: "a-active" }).where(eq(schema.chats.id, "c-branch")).run();
  const path = search.openHitPath("u1", "c-branch", "a-side");
  const head = db.select().from(schema.chats).where(eq(schema.chats.id, "c-branch")).get();
  assert.deepEqual(path, ["u-root", "a-side"]);
  assert.equal(head?.headId, "a-active");
});
