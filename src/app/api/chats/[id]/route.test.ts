import { parseViewer } from "@/lib/policy";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
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
import { saveInstance } from "@/lib/instance-settings";
import { createToolsStore } from "@/components/chat/tools-sheet";

const ME = "u-chat-owner";
const OTHER = "u-chat-other";
const STORED_KEY = "made-up-tavily-key-0042";

// The route reads the session from request headers, which need a Next.js request scope. This stub
// returns whichever user a test signs in as, or no session.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-chats-route-"));
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

type Route = typeof import("./route");
let route: Route;
const redact = new Redactor(null);

before(async () => {
  const db = getDb();
  db.$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  for (const id of [ME, OTHER]) db.insert(schema.user).values({ ...viewer(id), name: id, email: `${id}@orbit.local` }).run();
  assert.ok(saveInstance(viewer(ME).id, { tavilyApiKey: STORED_KEY }).ok);
  route = await import("./route");
});

after(() => {
  hooks.deregister();
  getDb().$client.close();
  fs.rmSync(stubDir, { recursive: true, force: true });
});

function viewer(id: string) {
  return parseViewer({ id, role: id === ME ? "admin" : "member" });
}

function signIn(userId: string | null) {
  signedIn.__orbitSignedIn = userId ? viewer(userId) : null;
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
  assert.deepEqual(await answer(await patch("rename", JSON.stringify({ title: "  Trip plans  " }))), { status: 200, body: { id: "rename", title: "Trip plans", disabledTools: [] }, text: '{"id":"rename","title":"Trip plans","disabledTools":[]}' });
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
    assert.deepEqual(await answer(await patch("rename-bad", body)), { status: 400, body: { error: "Invalid chat update" }, text: '{"error":"Invalid chat update"}' }, body);
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
  const memory = saveMemory(parseViewer({ id: ME, role: "member" }).id, { text: "The plan is figbarrow", kind: "fact", source: "dream", sourceChatId: "delete-me", sourceMessageId: "delete-me-u" });
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

function disabledColumn(id: string) {
  return getDb().$client.prepare("select disabled_tools from chats where id = ?").pluck().get(id);
}

function get(id: string) {
  return route.GET(new Request(`http://127.0.0.1/api/chats/${id}`), params(id));
}

test("GET answers a chat's disabled tools, all on by default", async () => {
  chat("tools-default", ME, "Defaults");
  signIn(ME);
  assert.deepEqual((await answer(await get("tools-default"))).body.disabledTools, []);
});

test("PATCH turns tools off and on in the stored list, answers it in canonical order, and leaves updated_at alone", async () => {
  chat("tools-save", ME, "Keep title", new Date(77_000));
  signIn(ME);
  const saved = await answer(await patch("tools-save", JSON.stringify({ toolsOff: ["web_search", "memory", "web_search"] })));
  assert.deepEqual(saved.body, { id: "tools-save", title: "Keep title", disabledTools: ["memory", "web_search"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(row("tools-save"), { title: "Keep title", updatedAt: 77_000 });
  assert.equal(disabledColumn("tools-save"), '["memory","web_search"]');
  assert.deepEqual((await answer(await get("tools-save"))).body.disabledTools, ["memory", "web_search"]);

  const both = await answer(await patch("tools-save", JSON.stringify({ title: "Renamed", toolsOff: ["mcp:docs-server"], toolsOn: ["web_search"] })));
  assert.deepEqual(both.body, { id: "tools-save", title: "Renamed", disabledTools: ["mcp:docs-server", "memory"] });
  const again = await answer(await patch("tools-save", JSON.stringify({ toolsOff: ["memory"], toolsOn: ["github"] })));
  assert.deepEqual(again.body.disabledTools, ["mcp:docs-server", "memory"], "a switch already in place changes nothing");
  const titleOnly = await answer(await patch("tools-save", JSON.stringify({ title: "Kept tools" })));
  assert.deepEqual(titleOnly.body, { id: "tools-save", title: "Kept tools", disabledTools: ["mcp:docs-server", "memory"] });
  const cleared = await answer(await patch("tools-save", JSON.stringify({ toolsOn: ["mcp:docs-server", "memory"] })));
  assert.deepEqual(cleared.body, { id: "tools-save", title: "Kept tools", disabledTools: [] });
  assert.equal(disabledColumn("tools-save"), "[]");
  assert.equal(row("tools-save")?.updatedAt, 77_000, "toggling tools never reorders the sidebar");
});

test("PATCH keeps at most 64 tools off and refuses Generated UI, unknown ids, long ids, a tool both off and on, and the old full list with 400", async () => {
  chat("tools-bad", ME, "Strict");
  signIn(ME);
  const servers = (count: number) => Array.from({ length: count }, (_, index) => `mcp:server-${index}`);
  assert.equal((await patch("tools-bad", JSON.stringify({ toolsOff: ["web_search", "run_code", "github", "memory", ...servers(60)] }))).status, 200);
  const invalid = { status: 400, body: { error: "Invalid chat update" }, text: '{"error":"Invalid chat update"}' };
  assert.deepEqual(await answer(await patch("tools-bad", JSON.stringify({ toolsOff: ["mcp:one-more"] }))), invalid, "a 65th tool off");
  assert.equal(JSON.parse(String(disabledColumn("tools-bad"))).length, 64);
  assert.equal((await patch("tools-bad", JSON.stringify({ toolsOn: [...servers(60), "web_search", "run_code", "github"] }))).status, 200);
  assert.equal(disabledColumn("tools-bad"), '["memory"]');
  for (const ids of [
    ["render_ui"], ["web_search", "render_ui"], ["bogus"], ["remember"], ["mcp:"], [`mcp:${"a".repeat(81)}`], ["mcp:bad id"], ["x".repeat(101)], [7], "web_search", null, servers(65),
  ]) {
    for (const field of ["toolsOff", "toolsOn"]) {
      assert.deepEqual(await answer(await patch("tools-bad", JSON.stringify({ [field]: ids }))), invalid, `${field} ${JSON.stringify(ids).slice(0, 80)}`);
    }
  }
  for (const body of [{ toolsOff: ["github"], toolsOn: ["github"] }, { toolsOff: ["github"], extra: true }, { disabledTools: ["github"] }]) {
    assert.deepEqual(await answer(await patch("tools-bad", JSON.stringify(body))), invalid, JSON.stringify(body));
  }
  assert.equal(disabledColumn("tools-bad"), '["memory"]');
});

test("GET drops entries a stored list should not hold", async () => {
  chat("tools-raw", ME, "Raw");
  signIn(ME);
  getDb().$client.prepare("update chats set disabled_tools = ? where id = ?").run('["render_ui","web_search","bogus",7,"web_search"]', "tools-raw");
  assert.deepEqual((await answer(await get("tools-raw"))).body.disabledTools, ["web_search"]);
  getDb().$client.prepare("update chats set disabled_tools = ? where id = ?").run("{not json", "tools-raw");
  assert.deepEqual((await answer(await get("tools-raw"))).body.disabledTools, []);
});

test("PATCH of disabled tools answers 404 for another user's chat and 401 when signed out", async () => {
  chat("tools-theirs", OTHER, "Theirs");
  signIn(ME);
  assert.deepEqual((await answer(await patch("tools-theirs", JSON.stringify({ toolsOff: ["memory"] })))).body, { error: "Not found" });
  signIn(null);
  assert.equal((await patch("tools-theirs", JSON.stringify({ toolsOff: ["memory"] }))).status, 401);
  assert.equal(disabledColumn("tools-theirs"), "[]");
});

test("two tabs that each switch a different tool keep both changes", async (t) => {
  chat("tools-tabs", ME, "Tabs");
  signIn(ME);
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(new URL(String(input), "http://127.0.0.1"), init);
    return request.method === "PATCH" ? route.PATCH(request, params("tools-tabs")) : route.GET(request, params("tools-tabs"));
  };
  const tab = () => createToolsStore({ chatId: "tools-tabs", initialDisabledTools: [], draft: false });
  const [first, second] = [tab(), tab()];
  first.toggle("memory", false);
  await first.flush();
  second.toggle("web_search", false);
  await second.flush();
  assert.equal(disabledColumn("tools-tabs"), '["memory","web_search"]', "the second tab kept Memory off");
  assert.deepEqual([...second.getSnapshot().committed].sort(), ["memory", "web_search"], "the second tab shows the first tab's change");
  assert.equal(second.getSnapshot().failed, false);
});
