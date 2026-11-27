import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import type { UIMessageChunk } from "ai";
import { Redactor } from "@/lib/chat-errors";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { finishChatReply, planChatWrite } from "@/lib/messages";
import { saveMemory } from "@/lib/memory/store";
import { bindReplyPlan, findReplyRun, releaseReplyRun, reserveReplyRun, startReplyRun } from "@/lib/reply-runs";
import { searchMessages } from "@/lib/search";
import { saveSettings } from "@/lib/settings";

const ME = "u-chat-owner";
const OTHER = "u-chat-other";
const STORED_KEY = "made-up-tavily-key-0042";

// The route reads the session from request headers, which need a Next.js request scope. This stub
// returns whichever user a test signs in as, or no session.
const stubDir = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR ?? "", "stubs-"));
const sessionStub = path.join(stubDir, "session.cjs");
fs.writeFileSync(sessionStub, `exports.getSession = async () => (globalThis.__orbitSignedIn ? { user: { id: globalThis.__orbitSignedIn } } : null);
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/session") return { url: pathToFileURL(sessionStub).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const signedIn = globalThis as { __orbitSignedIn?: string | null };

type Route = typeof import("./route");
let route: Route;
const redact = new Redactor(null);

before(async () => {
  const db = getDb();
  db.$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  for (const id of [ME, OTHER]) db.insert(schema.user).values({ id, name: id, email: `${id}@orbit.local` }).run();
  saveSettings({ tavilyApiKey: STORED_KEY });
  route = await import("./route");
});

after(() => {
  hooks.deregister();
  getDb().$client.close();
});

function signIn(userId: string | null) {
  signedIn.__orbitSignedIn = userId;
}

function chat(id: string, userId = ME, title = "New chat", updatedAt = new Date(1_000)) {
  getDb().insert(schema.chats).values({ id, userId, title, createdAt: updatedAt, updatedAt }).run();
  return id;
}

function turn(chatId: string, prompt: string, answer: string) {
  const plan = planChatWrite(chatId, [{ id: `${chatId}-u`, role: "user", parts: [{ type: "text", text: prompt }] }, { id: `${chatId}-a`, role: "assistant", parts: [] }], redact);
  if ("error" in plan) assert.fail(`write refused: ${plan.error}`);
  assert.equal(finishChatReply(plan, [{ type: "text", text: answer }], redact), true);
}

function row(id: string) {
  return getDb().$client.prepare("select title, updated_at as updatedAt from chats where id = ?").get(id) as { title: string; updatedAt: number } | undefined;
}

function messageCount(chatId: string) {
  return (getDb().$client.prepare("select count(*) as n from messages where chat_id = ?").get(chatId) as { n: number }).n;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function patch(id: string, body: string, headers: Record<string, string> = {}) {
  return route.PATCH(new Request(`http://127.0.0.1/api/chats/${id}`, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body }), params(id));
}

function remove(id: string) {
  return route.DELETE(new Request(`http://127.0.0.1/api/chats/${id}`, { method: "DELETE" }), params(id));
}

async function answer(response: Response) {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

// A server-owned reply run that streams until it is aborted. `closed` records whether the chat row
// was still there when the run's stream ended, so a test can tell the delete waited for the run.
async function runningReply(chatId: string, userId: string) {
  const reserved = await reserveReplyRun(chatId, userId);
  assert.ok(reserved.ok);
  const { run } = reserved;
  bindReplyPlan(run, `${chatId}-reply`, `${chatId}-prompt`);
  const seen: { chatAtClose?: boolean } = {};
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "start" });
      run.controller.signal.addEventListener("abort", () => {
        void Promise.resolve().then(() => {
          seen.chatAtClose = row(chatId) !== undefined;
          controller.close();
        });
      }, { once: true });
    },
  });
  startReplyRun(run, stream, () => null);
  return { run, seen };
}

test("GET answers the owner's chat and 404 for another user's, a missing, or an invalid id", async () => {
  chat("get-mine", ME, "Mine");
  chat("get-theirs", OTHER, "Theirs");
  signIn(ME);
  const mine = await answer(await route.GET(new Request("http://127.0.0.1/api/chats/get-mine"), params("get-mine")));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.title, "Mine");
  for (const id of ["get-theirs", "get-missing", "x".repeat(101)]) {
    assert.deepEqual(await answer(await route.GET(new Request(`http://127.0.0.1/api/chats/${id}`), params(id))), { status: 404, body: { error: "Not found" }, text: '{"error":"Not found"}' }, id);
  }
  signIn(null);
  assert.equal((await route.GET(new Request("http://127.0.0.1/api/chats/get-mine"), params("get-mine"))).status, 401);
});

test("PATCH renames the chat with a trimmed, masked title and leaves updated_at alone", async () => {
  chat("rename", ME, "Old title", new Date(42_000));
  signIn(ME);
  assert.deepEqual(await answer(await patch("rename", JSON.stringify({ title: "  Trip plans  " }))), { status: 200, body: { id: "rename", title: "Trip plans" }, text: '{"id":"rename","title":"Trip plans"}' });
  assert.deepEqual(row("rename"), { title: "Trip plans", updatedAt: 42_000 });
  assert.equal((await answer(await patch("rename", JSON.stringify({ title: `key ${STORED_KEY}` })))).body.title, "key [redacted]");
  assert.equal(row("rename")?.title, "key [redacted]");
  const longest = "t".repeat(120);
  assert.equal((await answer(await patch("rename", JSON.stringify({ title: longest })))).body.title, longest);
  assert.equal((await answer(await route.GET(new Request("http://127.0.0.1/api/chats/rename"), params("rename")))).body.title, longest);
});

test("PATCH refuses a blank, overlong, malformed, or widened body with 400 and a body over 4 KiB with 413", async () => {
  chat("rename-bad", ME, "Keep me");
  signIn(ME);
  for (const body of [JSON.stringify({ title: "   " }), JSON.stringify({ title: "t".repeat(121) }), JSON.stringify({ title: "ok", extra: 1 }), JSON.stringify({}), JSON.stringify({ title: 7 }), "{not json", "[]"]) {
    assert.deepEqual(await answer(await patch("rename-bad", body)), { status: 400, body: { error: "Invalid chat title" }, text: '{"error":"Invalid chat title"}' }, body);
  }
  const huge = JSON.stringify({ title: "t".repeat(5_000) });
  assert.deepEqual((await answer(await patch("rename-bad", huge))).body, { error: "Request body is too large." });
  assert.equal((await patch("rename-bad", huge, { "content-length": "1" })).status, 413, "a body that lies about its length is still capped");
  assert.equal(row("rename-bad")?.title, "Keep me");
});

test("PATCH answers 404 for another user's or a missing chat and 401 when signed out", async () => {
  chat("rename-theirs", OTHER, "Theirs");
  signIn(ME);
  for (const id of ["rename-theirs", "rename-missing", "x".repeat(101)]) {
    assert.deepEqual((await answer(await patch(id, JSON.stringify({ title: "Mine now" })))).body, { error: "Not found" }, id);
  }
  assert.equal(row("rename-theirs")?.title, "Theirs");
  assert.equal(row("rename-missing"), undefined);
  signIn(null);
  assert.equal((await patch("rename-theirs", JSON.stringify({ title: "Mine now" }))).status, 401);
  assert.equal(row("rename-theirs")?.title, "Theirs");
});

test("DELETE removes the chat and its messages with an empty 204, keeps the search index whole, and keeps linked memories", async () => {
  chat("delete-me", ME, "Gone");
  turn("delete-me", "the figbarrow plan", "figbarrow answer");
  const memory = saveMemory({ text: "The plan is figbarrow", kind: "fact", source: "dream", sourceChatId: "delete-me", sourceMessageId: "delete-me-u" });
  signIn(ME);
  assert.equal(searchMessages(ME, "figbarrow").length, 2);
  assert.deepEqual(await answer(await remove("delete-me")), { status: 204, body: null, text: "" });
  assert.equal(row("delete-me"), undefined);
  assert.equal(messageCount("delete-me"), 0);
  getDb().$client.prepare("insert into messages_fts(messages_fts) values('integrity-check')").run();
  assert.deepEqual(searchMessages(ME, "figbarrow"), []);
  assert.deepEqual(getDb().$client.prepare("select source_chat_id as chatId, source_message_id as messageId from memories where id = ?").get(memory.id), { chatId: null, messageId: null });
  assert.equal((await answer(await route.GET(new Request("http://127.0.0.1/api/chats/delete-me"), params("delete-me")))).status, 404);
  assert.deepEqual((await answer(await remove("delete-me"))).body, { error: "Not found" });
});

test("DELETE discards the chat's running reply and removes the rows only after the run has ended", async () => {
  chat("delete-running", ME, "Streaming");
  turn("delete-running", "a long question", "a first answer");
  const { run, seen } = await runningReply("delete-running", ME);
  signIn(ME);
  assert.equal((await remove("delete-running")).status, 204);
  assert.equal(run.controller.signal.reason, "discarded");
  assert.equal(seen.chatAtClose, true, "the rows were deleted before the run ended");
  assert.equal(findReplyRun("delete-running", ME, "delete-running-reply"), null, "the ended run is still buffered");
  assert.equal(row("delete-running"), undefined);
});

test("DELETE answers 404 for another user's chat and 401 when signed out without stopping their reply", async () => {
  chat("delete-theirs", OTHER, "Theirs");
  turn("delete-theirs", "their question", "their answer");
  const { run } = await runningReply("delete-theirs", OTHER);
  try {
    signIn(ME);
    assert.deepEqual((await answer(await remove("delete-theirs"))).body, { error: "Not found" });
    assert.deepEqual((await answer(await remove("delete-missing"))).body, { error: "Not found" });
    signIn(null);
    assert.equal((await remove("delete-theirs")).status, 401);
    assert.equal(run.controller.signal.aborted, false);
    assert.ok(findReplyRun("delete-theirs", OTHER, "delete-theirs-reply"));
    assert.equal(row("delete-theirs")?.title, "Theirs");
    assert.equal(messageCount("delete-theirs"), 2);
  } finally {
    run.controller.abort("stopped");
    await run.done;
    releaseReplyRun(run);
  }
});
