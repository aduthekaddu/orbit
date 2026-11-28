import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { artifactKey } from "@/lib/artifacts/detect";
import { Redactor } from "@/lib/chat-errors";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { saveInstance } from "@/lib/instance-settings";
import { finishChatReply, planChatWrite } from "@/lib/messages";
import { parseViewer } from "@/lib/policy";

const ME = "u-artifacts-owner";
const OTHER = "u-artifacts-other";
const PAGER = "u-artifacts-pager";
const STORED_KEY = "made-up-tavily-key-0042";

// The routes read the session from request headers, which need a Next.js request scope. This stub
// returns whichever user a test signs in as, or no session.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-artifacts-route-"));
const sessionStub = path.join(stubDir, "session.cjs");
fs.writeFileSync(sessionStub, `exports.sessionFrom = async () => (globalThis.__orbitSignedIn ? { user: globalThis.__orbitSignedIn } : null);
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/session") return { url: pathToFileURL(sessionStub).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const signedIn = globalThis as { __orbitSignedIn?: ReturnType<typeof parseViewer> | null };

let list: typeof import("./route");
let one: typeof import("./[id]/route");
let chatList: typeof import("../chats/[id]/artifacts/route");
const redact = new Redactor(null);
const made: Record<string, string> = {};

function viewer(id: string) {
  return parseViewer({ id, role: id === ME ? "admin" : "member" });
}

function signIn(userId: string | null) {
  signedIn.__orbitSignedIn = userId ? viewer(userId) : null;
}

function chat(id: string, userId: string, title: string) {
  getDb().insert(schema.chats).values({ id, userId, title, createdAt: new Date(1_000), updatedAt: new Date(1_000) }).run();
}

function reply(chatId: string, promptId: string, replyId: string, text: string) {
  const plan = planChatWrite(chatId, [{ id: promptId, role: "user", parts: [{ type: "text", text: "Make it" }] }, { id: replyId, role: "assistant", parts: [] }], redact);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(finishChatReply(plan, [{ type: "text", text }], redact), true);
  return getDb().$client.prepare("SELECT id FROM artifacts WHERE message_id = ?").pluck().get(replyId) as string;
}

before(async () => {
  list = await import("./route");
  one = await import("./[id]/route");
  chatList = await import("../chats/[id]/artifacts/route");
  const db = getDb();
  for (const id of [ME, OTHER, PAGER]) db.insert(schema.user).values({ ...viewer(id), name: id, email: `${id}@orbit.test` }).run();
  assert.ok(saveInstance(viewer(ME).id, { tavilyApiKey: STORED_KEY }).ok);
  chat("counter-chat", ME, "Counter chat");
  made.v1 = reply("counter-chat", "counter-p", "counter-a1", "```html\n<title>Counter</title><p>Version 1</p>\n```");
  made.v2 = reply("counter-chat", "counter-p", "counter-a2", "```html\n<title>Counter</title><p>Version 2</p>\n```");
  chat("logo-chat", ME, "Logo chat");
  made.logo = reply("logo-chat", "logo-p", "logo-a", "```svg\n<svg><title>Logo</title></svg>\n```");
  chat("other-chat", OTHER, "Other chat");
  made.other = reply("other-chat", "other-p", "other-a", "```html\n<title>Secret plan</title><p>zzotherword</p>\n```");
});

after(() => {
  hooks.deregister();
  getDb().$client.close();
  fs.rmSync(stubDir, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const listUrl = (query = "") => new Request(`http://127.0.0.1/api/artifacts${query}`);
const detail = (id: string) => one.GET(new Request(`http://127.0.0.1/api/artifacts/${encodeURIComponent(id)}`), params(id));
const forChat = (id: string) => chatList.GET(new Request(`http://127.0.0.1/api/chats/${encodeURIComponent(id)}/artifacts`), params(id));

function rename(id: string, body: string) {
  return one.PATCH(new Request(`http://127.0.0.1/api/artifacts/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body }), params(id));
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

test("every artifact route answers 401 to a signed-out request", async () => {
  signIn(null);
  assert.equal((await list.GET(listUrl())).status, 401);
  assert.equal((await detail(made.v1)).status, 401);
  assert.equal((await rename(made.v1, JSON.stringify({ title: "Tally" }))).status, 401);
  assert.equal((await forChat("counter-chat")).status, 401);
});

test("the list returns the owner's lineages, newest version first, and nothing of another account", async () => {
  signIn(ME);
  const { status, body } = await answer(await list.GET(listUrl()));
  assert.equal(status, 200);
  assert.equal(body.nextCursor, null);
  assert.deepEqual(body.items.map((item: { lineageId: string }) => item.lineageId), [made.logo, made.v1]);
  const counter = body.items[1];
  assert.deepEqual(
    { id: counter.id, kind: counter.kind, language: counter.language, title: counter.title, userTitle: counter.userTitle, chatId: counter.chatId, chatTitle: counter.chatTitle, messageId: counter.messageId, key: counter.key, versionCount: counter.versionCount },
    { id: made.v2, kind: "html", language: "html", title: "Counter", userTitle: null, chatId: "counter-chat", chatTitle: "Counter chat", messageId: "counter-a2", key: artifactKey("counter-a2", 0, 0), versionCount: 2 },
  );
  assert.ok(!Number.isNaN(Date.parse(counter.createdAt)) && !Number.isNaN(Date.parse(counter.updatedAt)));
});

test("the list filters by kind and searches the owner's artifacts only", async () => {
  signIn(ME);
  const ids = async (query: string) => (await answer(await list.GET(listUrl(query)))).body.items.map((item: { lineageId: string }) => item.lineageId);
  assert.deepEqual(await ids("?kind=svg"), [made.logo]);
  assert.deepEqual(await ids("?kind=html"), [made.v1]);
  assert.deepEqual(await ids("?kind=react"), []);
  assert.deepEqual(await ids("?q=Logo"), [made.logo]);
  assert.deepEqual(await ids("?q=Version%202"), [made.v1]);
  assert.deepEqual(await answer(await list.GET(listUrl("?q=zzotherword"))), { status: 200, body: { items: [], nextCursor: null } });
});

test("the list refuses a bad kind, cursor, or query with 400", async () => {
  signIn(ME);
  for (const query of ["?kind=python", "?cursor=abc", "?cursor=1", "?cursor=1:2:3", "?cursor=-1:2", `?cursor=${"1".repeat(100)}:${"2".repeat(28)}`, `?q=${"a".repeat(501)}`]) {
    assert.equal((await list.GET(listUrl(query))).status, 400, query);
  }
});

test("the list pages 50 lineages at a time with a cursor", async () => {
  for (let i = 0; i < 51; i++) {
    chat(`pager-chat-${i}`, PAGER, `Pager ${i}`);
    reply(`pager-chat-${i}`, `pager-p${i}`, `pager-a${i}`, `\`\`\`html\n<title>Page ${i}</title>\n\`\`\``);
  }
  signIn(PAGER);
  const first = await answer(await list.GET(listUrl()));
  assert.equal(first.body.items.length, 50);
  assert.match(first.body.nextCursor, /^\d+:\d+$/);
  const second = await answer(await list.GET(listUrl(`?cursor=${first.body.nextCursor}`)));
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.nextCursor, null);
  const all = [...first.body.items, ...second.body.items].map((item: { messageId: string }) => item.messageId);
  assert.equal(new Set(all).size, 51);
});

test("one artifact comes back with its code and versions, and another account's id is not found", async () => {
  signIn(ME);
  const { status, body } = await answer(await detail(made.v1));
  assert.equal(status, 200);
  assert.deepEqual(
    { id: body.artifact.id, code: body.artifact.code, number: body.artifact.number, lineageId: body.artifact.lineageId, textOrdinal: body.artifact.textOrdinal, blockIndex: body.artifact.blockIndex, chatTitle: body.artifact.chatTitle },
    { id: made.v1, code: "<title>Counter</title><p>Version 1</p>\n", number: 1, lineageId: made.v1, textOrdinal: 0, blockIndex: 0, chatTitle: "Counter chat" },
  );
  assert.deepEqual(body.artifact.versions.map((version: { id: string; number: number; key: string }) => [version.id, version.number, version.key]), [
    [made.v1, 1, artifactKey("counter-a1", 0, 0)],
    [made.v2, 2, artifactKey("counter-a2", 0, 0)],
  ]);
  for (const id of [made.other, "missing", "x".repeat(101)]) {
    assert.deepEqual(await answer(await detail(id)), { status: 404, body: { error: "Not found" } }, id);
  }
});

test("PATCH renames the whole lineage, masks credentials, and a blank title restores the derived one", async () => {
  signIn(ME);
  assert.deepEqual(await answer(await rename(made.v2, JSON.stringify({ title: "  Tally   board " }))), {
    status: 200, body: { id: made.v2, lineageId: made.v1, userTitle: "Tally board", title: "Tally board" },
  });
  assert.equal((await answer(await detail(made.v1))).body.artifact.title, "Tally board");
  assert.equal((await answer(await rename(made.v1, JSON.stringify({ title: `Key ${STORED_KEY}` })))).body.userTitle, "Key [redacted]");
  assert.deepEqual(await answer(await rename(made.v1, JSON.stringify({ title: "" }))), {
    status: 200, body: { id: made.v1, lineageId: made.v1, userTitle: null, title: "Counter" },
  });
});

test("PATCH refuses a large body, a long title, an extra key, bad JSON, and another account's artifact", async () => {
  signIn(ME);
  assert.equal((await rename(made.v1, JSON.stringify({ title: "a".repeat(5_000) }))).status, 413);
  assert.equal((await rename(made.v1, JSON.stringify({ title: "a".repeat(81) }))).status, 400);
  assert.equal((await rename(made.v1, JSON.stringify({ title: "Tally", extra: true }))).status, 400);
  assert.equal((await rename(made.v1, JSON.stringify({ name: "Tally" }))).status, 400);
  assert.equal((await rename(made.v1, "{not json")).status, 400);
  assert.deepEqual(await answer(await rename(made.other, JSON.stringify({ title: "Taken" }))), { status: 404, body: { error: "Not found" } });
  assert.equal((await rename("x".repeat(101), JSON.stringify({ title: "Taken" }))).status, 404);
  assert.equal(getDb().$client.prepare("SELECT user_title FROM artifacts WHERE id = ?").pluck().get(made.other), null);
});

test("a chat's artifacts come back keyed by block for the owner, and 404 for anyone else", async () => {
  signIn(ME);
  const { status, body } = await answer(await forChat("counter-chat"));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.artifacts).sort(), [artifactKey("counter-a1", 0, 0), artifactKey("counter-a2", 0, 0)].sort());
  assert.deepEqual([body.artifacts[artifactKey("counter-a2", 0, 0)].number, body.artifacts[artifactKey("counter-a2", 0, 0)].versions.length], [2, 2]);
  for (const id of ["other-chat", "missing-chat", "x".repeat(101)]) {
    assert.deepEqual(await answer(await forChat(id)), { status: 404, body: { error: "Not found" } }, id);
  }
});
