import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Redactor } from "../chat-errors";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { deleteChat, finishChatReply, planChatWrite, updateMessageText, type IncomingMessage } from "../messages";
import { parseViewer } from "../policy";
import { artifactKey } from "./detect";
import { getArtifact, listArtifacts, listChatArtifacts, renameArtifact, syncMessageArtifacts } from "./store";

const USER = parseViewer({ id: "u-artifacts", role: "admin" }).id;
const OTHER = parseViewer({ id: "u-artifacts-other", role: "member" }).id;
const PAGES = parseViewer({ id: "u-artifacts-pages", role: "member" }).id;
const redact = new Redactor(null);
const sqlite = () => getDb().$client;

before(() => {
  for (const id of [USER, OTHER, PAGES]) {
    getDb().insert(schema.user).values({ id, name: id, email: `${id}@orbit.test`, role: id === USER ? "admin" : "member" }).run();
  }
});

after(() => {
  getDb().$client.close();
});

let chats = 0;
function newChat(userId: string = USER) {
  const id = `artifact-chat-${++chats}`;
  getDb().insert(schema.chats).values({ id, userId, title: `Chat ${chats}`, createdAt: new Date(1_000), updatedAt: new Date(1_000) }).run();
  return id;
}

const text = (value: string) => ({ type: "text", text: value });
const prompt = (id: string, value = "Make a page"): IncomingMessage => ({ id, role: "user", parts: [text(value)] });
const html = (title: string, body = "") => `\`\`\`html\n<title>${title}</title>${body}\n\`\`\``;

/** Saves a reply to the last prompt in `path` through the chat write path. */
function send(chatId: string, path: IncomingMessage[], replyId: string, value: string | unknown[], redactor = redact) {
  const plan = planChatWrite(chatId, [...path, { id: replyId, role: "assistant", parts: [] }], redactor);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(finishChatReply(plan, typeof value === "string" ? [text(value)] : value, redactor), true);
}

type Row = {
  id: string; lineageId: string; userTitle: string | null; textOrdinal: number; blockIndex: number;
  kind: string; language: string; code: string; derivedTitle: string; createdAt: number; updatedAt: number;
};

function rows(messageId: string): Row[] {
  return sqlite().prepare(`SELECT id, lineage_id AS lineageId, user_title AS userTitle, text_ordinal AS textOrdinal, block_index AS blockIndex,
    kind, language, code, derived_title AS derivedTitle, created_at AS createdAt, updated_at AS updatedAt
    FROM artifacts WHERE message_id = ? ORDER BY text_ordinal, block_index`).all(messageId) as Row[];
}

function only(messageId: string): Row {
  const found = rows(messageId);
  assert.equal(found.length, 1, `one artifact row for ${messageId}`);
  return found[0];
}

function changes() {
  return sqlite().prepare("SELECT total_changes()").pluck().get() as number;
}

function ftsHits(word: string) {
  return sqlite().prepare("SELECT count(*) FROM artifacts_fts WHERE artifacts_fts MATCH ?").pluck().get(`"${word}"`) as number;
}

function ftsIntegrity() {
  sqlite().prepare("INSERT INTO artifacts_fts(artifacts_fts, rank) VALUES ('integrity-check', 1)").run();
}

test("a saved reply stores each artifact block with the key the thread renders for it", () => {
  const chat = newChat();
  send(chat, [prompt("saved-p")], "saved-a", `Intro\n\n\`\`\`python\nprint(1)\n\`\`\`\n\n${html("Counter", "<p>Version 1</p>")}`);
  const row = only("saved-a");
  const detail = getArtifact(USER, row.id);
  assert.ok(detail);
  assert.deepEqual(
    { key: detail.key, kind: detail.kind, language: detail.language, code: detail.code, title: detail.title, userTitle: detail.userTitle, number: detail.number, chatTitle: detail.chatTitle },
    { key: artifactKey("saved-a", 0, 1), kind: "html", language: "html", code: "<title>Counter</title><p>Version 1</p>\n", title: "Counter", userTitle: null, number: 1, chatTitle: "Chat 1" },
  );
  assert.equal(detail.lineageId, row.id);
  assert.deepEqual(detail.versions.map((version) => [version.id, version.number]), [[row.id, 1]]);
});

test("a reply's artifacts are saved from the redacted text, so no credential reaches the code, the title, or search", () => {
  const key = "zq9artifactsecret77";
  const masking = new Redactor({ apiKey: key, tavilyApiKey: "", githubToken: "" });
  const chat = newChat();
  send(chat, [prompt("secret-p")], "secret-a", html(`Key ${key}`, `<p>${key}</p>`), masking);
  const row = only("secret-a");
  assert.equal(row.code.includes(key), false);
  assert.equal(row.code, "<title>Key [redacted]</title><p>[redacted]</p>\n");
  assert.equal(row.derivedTitle, "Key [redacted]");
  assert.equal(ftsHits(key), 0);
  assert.deepEqual(listArtifacts(USER, { q: key }).items, []);
});

test("a credential split by tags in the code never comes back whole or in part in the title", () => {
  const key = `zq9${crypto.randomUUID().replaceAll("-", "").slice(0, 19)}`;
  const masking = new Redactor({ apiKey: key, tavilyApiKey: "", githubToken: "" });
  // The message text holds the key with tags inside it, so masking the message finds nothing to mask.
  const split = `${key.slice(0, 5)}<strong>${key.slice(5, 12)}</strong>${key.slice(12)}`;
  const page = (heading: string) => `\`\`\`html\n<h1>${heading}</h1>\n\`\`\``;
  const chat = newChat();
  send(chat, [prompt("split-p")], "split-a", page(`Key ${split}`), masking);
  const saved = only("split-a");
  assert.equal(saved.derivedTitle, "Key [redacted]");
  assert.equal(ftsHits(key), 0);
  assert.deepEqual(listArtifacts(USER, { q: key }).items, []);
  assert.equal(getArtifact(USER, saved.id)?.title, "Key [redacted]");

  // The key starts before the 80-code-point cut and ends after it, so only a cut made after masking drops all of it.
  assert.equal(updateMessageText(chat, "split-a", page(`${"x".repeat(60)} ${split}`), masking), true);
  const edited = only("split-a");
  assert.equal(edited.derivedTitle, `${"x".repeat(60)} [redacted]`);
  assert.equal(edited.derivedTitle.includes(key.slice(0, 5)), false);
});

test("a reply nested too deep to render saves, with rows for the parts that render", () => {
  const deep = `${"> ".repeat(3_500)}\`\`\`html\n<h1>Deep</h1>\n\`\`\``;
  const chat = newChat();
  send(chat, [prompt("deep-p")], "deep-a", [text(deep), text(html("After"))]);
  assert.equal(sqlite().prepare("SELECT count(*) FROM messages WHERE id = 'deep-a'").pluck().get(), 1);
  assert.deepEqual(rows("deep-a").map((row) => [row.textOrdinal, row.blockIndex, row.derivedTitle]), [[1, 0, "After"]]);
  assert.equal(updateMessageText(chat, "deep-a", deep, redact, 1), true);
  assert.deepEqual(rows("deep-a"), []);
});

test("a failed artifact write rolls back the reply and the edit that carried it", () => {
  const chat = newChat();
  sqlite().exec("CREATE TEMP TRIGGER artifacts_refuse BEFORE INSERT ON main.artifacts BEGIN SELECT RAISE(ABORT, 'artifact write refused'); END");
  try {
    const plan = planChatWrite(chat, [prompt("atomic-p"), { id: "atomic-a", role: "assistant", parts: [] }], redact);
    if ("error" in plan) assert.fail(plan.error);
    assert.throws(() => finishChatReply(plan, [text(html("Atomic"))], redact), /artifact write refused/);
    assert.equal(sqlite().prepare("SELECT count(*) FROM messages WHERE id = 'atomic-a'").pluck().get(), 0);

    sqlite().exec("DROP TRIGGER artifacts_refuse");
    send(chat, [prompt("atomic-p")], "atomic-b", "No artifact yet.");
    sqlite().exec("CREATE TEMP TRIGGER artifacts_refuse BEFORE INSERT ON main.artifacts BEGIN SELECT RAISE(ABORT, 'artifact write refused'); END");
    assert.throws(() => updateMessageText(chat, "atomic-b", html("Edited in"), redact), /artifact write refused/);
    assert.deepEqual(JSON.parse(sqlite().prepare("SELECT parts FROM messages WHERE id = 'atomic-b'").pluck().get() as string), [text("No artifact yet.")]);
  } finally {
    sqlite().exec("DROP TRIGGER IF EXISTS artifacts_refuse");
  }
  assert.deepEqual(rows("atomic-a"), []);
  assert.deepEqual(rows("atomic-b"), []);
});

test("a continued reply saves the artifact its new text adds", () => {
  const chat = newChat();
  const first = prompt("continued-p");
  send(chat, [first], "continued-a", "First part.");
  const plan = planChatWrite(chat, [first, { id: "continued-a", role: "assistant", parts: [text("First part.")] }], redact);
  if ("error" in plan) assert.fail(plan.error);
  assert.notEqual(plan.continues, null);
  assert.equal(finishChatReply(plan, [text("First part."), text(html("Continued"))], redact), true);
  const row = only("continued-a");
  assert.deepEqual([row.textOrdinal, row.blockIndex, row.derivedTitle], [1, 0, "Continued"]);
});

test("syncing a message again with the same parts writes nothing", () => {
  const chat = newChat();
  send(chat, [prompt("again-p")], "again-a", `${html("Again")}\n\n\`\`\`svg\n<svg><title>Logo</title></svg>\n\`\`\``);
  const before = rows("again-a");
  const message = sqlite().prepare("SELECT parts, created_at AS createdAt FROM messages WHERE id = 'again-a'").get() as { parts: string; createdAt: number };
  const start = changes();
  syncMessageArtifacts(USER, chat, "again-a", JSON.parse(message.parts), new Date(message.createdAt), redact, getDb());
  syncMessageArtifacts(USER, chat, "again-a", JSON.parse(message.parts), new Date(message.createdAt), redact, getDb());
  assert.equal(changes() - start, 0);
  assert.deepEqual(rows("again-a"), before);
});

test("an in-place code edit updates the row and keeps its id, lineage, and version number", () => {
  const chat = newChat();
  send(chat, [prompt("edit-p")], "edit-a", html("Counter", "<p>one</p>"));
  const original = only("edit-a");
  sqlite().prepare("UPDATE artifacts SET updated_at = 1 WHERE id = ?").run(original.id);
  assert.equal(updateMessageText(chat, "edit-a", html("Counter", "<p>two</p>"), redact), true);
  const edited = only("edit-a");
  assert.equal(edited.id, original.id);
  assert.equal(edited.lineageId, original.lineageId);
  assert.equal(edited.createdAt, original.createdAt);
  assert.equal(edited.code, "<title>Counter</title><p>two</p>\n");
  assert.ok(edited.updatedAt > 1);
  assert.equal(getArtifact(USER, edited.id)?.number, 1);
});

test("a block added above an artifact moves it and keeps its id and rename", () => {
  const chat = newChat();
  send(chat, [prompt("shift-p")], "shift-a", html("Counter"));
  const original = only("shift-a");
  assert.ok(renameArtifact(USER, original.id, "Tally", redact));
  assert.equal(updateMessageText(chat, "shift-a", `\`\`\`python\nprint(1)\n\`\`\`\n\n${html("Counter")}`, redact), true);
  const moved = only("shift-a");
  assert.deepEqual([moved.id, moved.blockIndex, moved.userTitle], [original.id, 1, "Tally"]);
  assert.deepEqual(Object.keys(listChatArtifacts(USER, chat)), [artifactKey("shift-a", 0, 1)]);
});

test("removing the first of two blocks keeps the second block's row in its new slot", () => {
  const chat = newChat();
  send(chat, [prompt("mixed-p")], "mixed-a", `${html("Page")}\n\n\`\`\`svg\n<svg><title>Logo</title></svg>\n\`\`\``);
  const [page, logo] = rows("mixed-a");
  assert.ok(renameArtifact(USER, logo.id, "Brand mark", redact));
  assert.equal(updateMessageText(chat, "mixed-a", "```svg\n<svg><title>Logo</title></svg>\n```", redact), true);
  const left = only("mixed-a");
  assert.deepEqual([left.id, left.kind, left.blockIndex, left.userTitle], [logo.id, "svg", 0, "Brand mark"]);
  assert.equal(getArtifact(USER, page.id), null);

  const pairs = newChat();
  send(pairs, [prompt("pair-p")], "pair-a", `${html("Alpha", "<p>first</p>")}\n\n${html("Beta", "<p>second</p>")}`);
  const [alpha, beta] = rows("pair-a");
  assert.ok(renameArtifact(USER, beta.id, "Bee", redact));
  assert.equal(updateMessageText(pairs, "pair-a", html("Beta", "<p>second</p>"), redact), true);
  const survivor = only("pair-a");
  assert.deepEqual([survivor.id, survivor.blockIndex, survivor.userTitle, survivor.derivedTitle], [beta.id, 0, "Bee", "Beta"]);
  assert.equal(getArtifact(USER, alpha.id), null);
});

test("a regeneration joins the lineage, and deleting the first version's block promotes the next one with the rename", () => {
  const chat = newChat();
  const ask = prompt("root-p");
  send(chat, [ask], "root-a1", html("Counter", "<p>Version 1</p>"));
  send(chat, [ask], "root-a2", html("Counter", "<p>Version 2</p>"));
  const v1 = only("root-a1");
  const v2 = only("root-a2");
  assert.equal(v2.lineageId, v1.id);
  assert.deepEqual(getArtifact(USER, v2.id)?.versions.map((version) => [version.id, version.number]), [[v1.id, 1], [v2.id, 2]]);
  assert.ok(renameArtifact(USER, v2.id, "Abacus", redact));

  assert.equal(updateMessageText(chat, "root-a1", "No artifact any more.", redact), true);
  assert.deepEqual(rows("root-a1"), []);
  const promoted = only("root-a2");
  assert.deepEqual([promoted.id, promoted.lineageId, promoted.userTitle], [v2.id, v2.id, "Abacus"]);
  const detail = getArtifact(USER, v2.id);
  assert.deepEqual([detail?.number, detail?.versions.length, detail?.title], [1, 1, "Abacus"]);
});

test("editing a block from html to svg gives it a new row and leaves the html lineage to its other version", () => {
  const chat = newChat();
  const ask = prompt("kind-p");
  send(chat, [ask], "kind-a1", html("Pic"));
  send(chat, [ask], "kind-a2", html("Pic"));
  const before = only("kind-a1");
  const sibling = only("kind-a2");
  assert.equal(sibling.lineageId, before.id);
  assert.equal(updateMessageText(chat, "kind-a1", "```svg\n<svg><title>Pic</title></svg>\n```", redact), true);
  const after = only("kind-a1");
  assert.notEqual(after.id, before.id);
  assert.deepEqual([after.kind, after.lineageId, after.userTitle], ["svg", after.id, null]);
  assert.equal(only("kind-a2").lineageId, sibling.id);
});

test("a rename names every version, keeps updated_at, joins new versions, and a blank title clears it", () => {
  const chat = newChat();
  const ask = prompt("rename-p");
  send(chat, [ask], "rename-a1", html("Counter", "<p>one</p>"));
  send(chat, [ask], "rename-a2", html("Counter", "<p>two</p>"));
  const v1 = only("rename-a1");
  const v2 = only("rename-a2");
  const renamed = renameArtifact(USER, v2.id, "  Tally \n  board  ", redact);
  assert.deepEqual(renamed, { id: v2.id, lineageId: v1.id, userTitle: "Tally board", title: "Tally board" });
  assert.deepEqual([only("rename-a1").userTitle, only("rename-a2").userTitle], ["Tally board", "Tally board"]);
  assert.deepEqual([only("rename-a1").updatedAt, only("rename-a2").updatedAt], [v1.updatedAt, v2.updatedAt]);
  assert.equal(getArtifact(USER, v1.id)?.title, "Tally board");

  send(chat, [ask], "rename-a3", html("Counter", "<p>three</p>"));
  assert.deepEqual([only("rename-a3").lineageId, only("rename-a3").userTitle], [v1.id, "Tally board"]);

  assert.deepEqual(renameArtifact(USER, v1.id, "   ", redact), { id: v1.id, lineageId: v1.id, userTitle: null, title: "Counter" });
  assert.deepEqual(["rename-a1", "rename-a2", "rename-a3"].map((id) => only(id).userTitle), [null, null, null]);
});

test("search matches a custom title together with code that only a later version has", () => {
  const chat = newChat();
  const ask = prompt("search-p");
  send(chat, [ask], "search-a1", html("Counter", "<p>Version 1</p>"));
  send(chat, [ask], "search-a2", html("Counter", "<p>Version 2</p>"));
  const other = newChat();
  send(other, [prompt("search-other-p")], "search-other-a", html("Other", "<p>Version 2</p>"));
  const lineage = only("search-a1").id;
  const otherLineage = only("search-other-a").id;
  assert.ok(renameArtifact(USER, lineage, "Tally", redact));

  const hits = listArtifacts(USER, { q: "Tally Version 2" });
  assert.deepEqual(hits.items.map((item) => [item.lineageId, item.id, item.title, item.versionCount]), [[lineage, only("search-a2").id, "Tally", 2]]);
  assert.equal(hits.nextCursor, null);
  assert.deepEqual(listArtifacts(USER, { q: "Tally Version 3" }).items, []);
  const versionTwo = listArtifacts(USER, { q: "Version 2" }).items.map((item) => item.lineageId);
  assert.ok(versionTwo.includes(lineage) && versionTwo.includes(otherLineage), "code alone matches without the custom title");
});

test("search results keep the list order, whatever another account stores", () => {
  send(newChat(), [prompt("order-p1")], "order-a1", html("Gadget", `<p>${"widgetword ".repeat(20)}</p>`));
  send(newChat(), [prompt("order-p2")], "order-a2", html("Gizmo", "<p>widgetword</p>"));
  const older = only("order-a1").lineageId;
  const newer = only("order-a2").lineageId;
  const order = () => listArtifacts(USER, { q: "widgetword" }).items.map((item) => item.lineageId);
  assert.deepEqual(order(), [newer, older]);
  const foreign = newChat(OTHER);
  for (let i = 0; i < 5; i++) send(foreign, [prompt(`order-foreign-p${i}`, `Ask ${i}`)], `order-foreign-a${i}`, html(`Foreign ${i}`, "<p>widgetword widgetword</p>"));
  assert.deepEqual(order(), [newer, older]);
});

test("the list shows one row per lineage, filters by kind, and pages with a cursor", () => {
  const made: string[] = [];
  const blocks = [html("One"), "```svg\n<svg><title>Two</title></svg>\n```", html("Three"), "```svg\n<svg><title>Four</title></svg>\n```", "```jsx\nexport default function Five() { return null; }\n```"];
  for (const [i, block] of blocks.entries()) {
    const chat = newChat(PAGES);
    send(chat, [prompt(`page-p${i}`)], `page-a${i}`, block);
    made.push(only(`page-a${i}`).lineageId);
  }
  // Older times, so the edit at the end is the newest change whatever the clock does in this test.
  sqlite().prepare("UPDATE artifacts SET created_at = 1000 + seq, updated_at = 1000 + seq WHERE user_id = ?").run(PAGES);
  const newestFirst = [...made].reverse();
  assert.deepEqual(listArtifacts(PAGES, {}).items.map((item) => item.lineageId), newestFirst);
  assert.deepEqual(listArtifacts(PAGES, { kind: "svg" }).items.map((item) => [item.lineageId, item.kind]), [[made[3], "svg"], [made[1], "svg"]]);
  assert.deepEqual(listArtifacts(PAGES, { kind: "react" }).items.map((item) => [item.kind, item.language, item.title]), [["react", "jsx", "Five"]]);

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const result = listArtifacts(PAGES, { limit: 2, cursor });
    seen.push(...result.items.map((item) => item.lineageId));
    if (page < 2) assert.match(result.nextCursor ?? "", /^\d+:\d+$/);
    else assert.equal(result.nextCursor, null);
    cursor = result.nextCursor ?? undefined;
  }
  assert.deepEqual(seen, newestFirst);

  const htmlPage = listArtifacts(PAGES, { kind: "html", limit: 1 });
  assert.deepEqual(htmlPage.items.map((item) => item.lineageId), [made[2]]);
  assert.ok(htmlPage.nextCursor);
  assert.deepEqual(listArtifacts(PAGES, { kind: "html", limit: 1, cursor: htmlPage.nextCursor }), { items: listArtifacts(PAGES, { kind: "html" }).items.slice(1), nextCursor: null });

  const firstChat = sqlite().prepare("SELECT chat_id FROM artifacts WHERE message_id = 'page-a0'").pluck().get() as string;
  assert.equal(updateMessageText(firstChat, "page-a0", html("One", "<p>edited</p>"), redact), true);
  assert.equal(listArtifacts(PAGES, {}).items[0].lineageId, made[0]);
});

test("a chat's artifacts come back keyed by block with their version numbers", () => {
  const chat = newChat();
  const ask = prompt("keyed-p");
  send(chat, [ask], "keyed-a1", html("Counter", "<p>one</p>"));
  send(chat, [ask], "keyed-a2", html("Counter", "<p>two</p>"));
  const v1 = only("keyed-a1");
  const v2 = only("keyed-a2");
  const stored = listChatArtifacts(USER, chat);
  assert.deepEqual(Object.keys(stored).sort(), [artifactKey("keyed-a1", 0, 0), artifactKey("keyed-a2", 0, 0)].sort());
  const second = stored[artifactKey("keyed-a2", 0, 0)];
  assert.deepEqual(
    { id: second.id, key: second.key, title: second.title, lineageId: second.lineageId, number: second.number, versions: second.versions.map((version) => version.id) },
    { id: v2.id, key: artifactKey("keyed-a2", 0, 0), title: "Counter", lineageId: v1.id, number: 2, versions: [v1.id, v2.id] },
  );
  assert.equal(stored[artifactKey("keyed-a1", 0, 0)].number, 1);
});

test("deleting a chat removes its artifacts from the table and from search", () => {
  const chat = newChat();
  send(chat, [prompt("doomed-p")], "doomed-a", html("Doomed", "<p>zzdoomedword</p>"));
  assert.equal(ftsHits("zzdoomedword"), 1);
  assert.equal(deleteChat(chat, USER), true);
  assert.equal(sqlite().prepare("SELECT count(*) FROM artifacts WHERE chat_id = ?").pluck().get(chat), 0);
  assert.equal(ftsHits("zzdoomedword"), 0);
  ftsIntegrity();
});

test("another account cannot list, search, open, or rename an artifact", () => {
  const chat = newChat();
  send(chat, [prompt("private-p")], "private-a", html("Private", "<p>zzprivateword</p>"));
  const row = only("private-a");
  assert.equal(getArtifact(OTHER, row.id), null);
  assert.equal(listArtifacts(OTHER, {}).items.some((item) => item.lineageId === row.lineageId), false);
  assert.deepEqual(listArtifacts(OTHER, { q: "zzprivateword" }).items, []);
  assert.deepEqual(listChatArtifacts(OTHER, chat), {});
  assert.equal(renameArtifact(OTHER, row.id, "Taken", redact), null);
  assert.deepEqual(only("private-a"), row);
  assert.equal(getArtifact(USER, row.id)?.title, "Private");
  ftsIntegrity();
});
