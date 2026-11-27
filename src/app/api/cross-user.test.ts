import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { LOCAL_AUTH_URL } from "@/lib/auth-origins";
import { createTwoAccounts } from "@/lib/auth-test-helpers";
import { seedTestConnection } from "@/lib/connection-fixture";
import { getDb } from "@/lib/db";
import { saveMemory, writeVectors } from "@/lib/memory/store";
import { saveInstance } from "@/lib/instance-settings";
import { savePreferences } from "@/lib/preferences";
import { deleteChat } from "@/lib/messages";
import {
  bindReplyPlan, discardReplyRun, findReplyRun, MAX_RUNNING_PER_USER, releaseReplyRun, reserveReplyRun, startReplyRun,
} from "@/lib/reply-runs";
import type { UserId } from "@/lib/policy";
import { encryptSecret } from "@/lib/secrets";
import { saveGithub } from "@/lib/user-github";

const apiDir = path.resolve("src/app/api");
const methodNames = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const origin = new URL(LOCAL_AUTH_URL).origin;
const adminChat = "admin-chat";
const adminPrompt = "admin-prompt";
const adminReply = "admin-reply";
const memberChat = "member-chat";
const canary = "accountsisolationcanary";
const memberModel = "member-model";
const provider = "https://fixture.invalid/v1";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;
type Spec = { route: string; method: string; status: number; params?: Record<string, string>; query?: string; input?: object; body?: unknown };
type Accounts = Awaited<ReturnType<typeof createTwoAccounts>>;

const home = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR!, "routes-"));
const stub = path.join(home, "next-server.cjs");
fs.writeFileSync(stub, 'exports.after = (fn) => globalThis.orbitRouteTasks.push(Promise.resolve(fn()));');
const afterTasks: Promise<unknown>[] = [];
const globals = globalThis as typeof globalThis & { orbitRouteTasks?: Promise<unknown>[] };
globals.orbitRouteTasks = afterTasks;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return { url: pathToFileURL(stub).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const routeFiles = fs.readdirSync(apiDir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith("/route.ts"));
const routes = new Map<string, Handler>();
const sqlite = getDb().$client;
let accounts: Accounts;
let adminConnection: string;
let memberConnection: string;
let adminNote: string;
let pendingRun: Awaited<ReturnType<typeof reserveReplyRun>> | undefined;

before(async () => {
  for (const file of routeFiles) {
    const exports = await import(path.join(apiDir, file)) as Record<string, unknown>;
    for (const method of methodNames) {
      const handler = exports[method];
      if (typeof handler === "function") routes.set(`${file.slice(0, -"/route.ts".length)} ${method}`, handler as Handler);
    }
  }

  accounts = await createTwoAccounts();
  const admin = accounts.admin.viewer.id;
  const member = accounts.member.viewer.id;
  adminConnection = seedTestConnection(admin, { baseUrl: provider, apiKey: crypto.randomUUID(), model: "admin-model" });
  memberConnection = seedTestConnection(member, { baseUrl: provider, apiKey: crypto.randomUUID(), model: memberModel });
  assert.ok(saveInstance(admin, { searxngUrl: "https://search.example", tavilyApiKey: crypto.randomUUID() }).ok);
  assert.ok(saveGithub(admin, { githubToken: crypto.randomUUID() }).ok);
  savePreferences(admin, { theme: "light", memory: "off" });
  sqlite.prepare("INSERT INTO pending_connection VALUES (1, ?, ?, 'pending-model', 'low', 0)").run(provider, encryptSecret(crypto.randomUUID()));
  sqlite.prepare("INSERT INTO chats(id, user_id, title, created_at, updated_at, head_id) VALUES (?, ?, ?, 1, 1, ?)").run(adminChat, admin, "Admin private title", adminReply);
  sqlite.prepare("INSERT INTO chats(id, user_id, title, created_at, updated_at) VALUES (?, ?, 'New chat', 1, 1)").run(memberChat, member);
  const message = sqlite.prepare("INSERT INTO messages(id, chat_id, parent_id, role, content, parts, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)");
  message.run(adminPrompt, adminChat, null, "user", canary, JSON.stringify([{ type: "text", text: canary }]), 0);
  message.run(adminReply, adminChat, adminPrompt, "assistant", "Admin reply", '[{"type":"text","text":"Admin reply"}]', 1);
  adminNote = saveMemory(admin, { text: `Remember the ${canary}`, kind: "fact", source: "user", sourceChatId: adminChat }).id;
  const noteRow = sqlite.prepare("SELECT seq AS rowid, text FROM memories WHERE id = ?").get(adminNote) as { rowid: number; text: string };
  writeVectors([{ ...noteRow, vector: Array.from({ length: 768 }, (_, i) => Number(i === 0)) }]);
  pendingRun = await reserveReplyRun(adminChat, admin);
  assert.ok(pendingRun.ok);
  bindReplyPlan(pendingRun.run, adminReply, adminPrompt);
});

after(async () => {
  if (pendingRun?.ok) releaseReplyRun(pendingRun.run);
  await Promise.allSettled(afterTasks);
  hooks.deregister();
  delete globals.orbitRouteTasks;
  sqlite.close();
});

function routeRequest(spec: Omit<Spec, "status">, cookie?: string) {
  const handler = routes.get(`${spec.route} ${spec.method}`);
  assert.ok(handler, `Missing ${spec.method} ${spec.route}`);
  const params = spec.params ?? {};
  const pathname = spec.route.replace(/\[(\w+)\]/g, (_, key: string) => encodeURIComponent(params[key] ?? "missing"));
  const headers = new Headers({ origin });
  if (cookie) headers.set("cookie", cookie);
  if (spec.input) headers.set("content-type", "application/json");
  return handler(new Request(new URL(`/api/${pathname}${spec.query ?? ""}`, origin), {
    method: spec.method,
    headers,
    body: spec.input ? JSON.stringify(spec.input) : undefined,
  }), { params: Promise.resolve(params) });
}

function snapshot(id: UserId) {
  const direct = ["account", "session", "chats", "provider_connections", "hidden_models", "memories", "memory_runs", "user_github", "user_preferences"];
  return {
    owned: direct.map((table) => sqlite.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`).all(id)),
    user: sqlite.prepare("SELECT * FROM user WHERE id = ?").get(id),
    messages: sqlite.prepare("SELECT messages.* FROM messages JOIN chats ON chats.id = messages.chat_id WHERE chats.user_id = ? ORDER BY messages.rowid").all(id),
    vectors: sqlite.prepare("SELECT rowid, embedding FROM memories_vec WHERE user_id = ? ORDER BY rowid").all(id),
    fts: sqlite.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").all(canary),
    instance: sqlite.prepare("SELECT * FROM instance_settings").all(),
    pending: sqlite.prepare("SELECT * FROM pending_connection").all(),
  };
}

const chatBody = (id: string, message = "member-prompt", text = "Member prompt") => ({ id, messages: [{ id: message, role: "user", parts: [{ type: "text", text }] }] });
const privateSettings = { githubTokenSet: false, githubTokenReadable: true, githubMcpUrl: "https://api.githubcopilot.com/mcp/" };

test("admin access preserves a member's private data, live stream, and completed replay", async () => {
  const { admin, member } = accounts;
  const id = "member-ownership-chat";
  const replyId = "member-ownership-reply";
  const messages = [{ type: "text", text: "Benign fixture note" }];
  sqlite.prepare("INSERT INTO chats(id, user_id, title, created_at, updated_at, head_id) VALUES (?, ?, 'Fixture', 1, 1, ?)").run(id, member.viewer.id, replyId);
  sqlite.prepare("INSERT INTO messages(id, chat_id, role, content, parts, position, created_at) VALUES (?, ?, 'assistant', 'Benign fixture note', ?, 0, 1)").run(replyId, id, JSON.stringify(messages));
  const memory = saveMemory(member.viewer.id, { text: "I like jasmine tea", kind: "preference", source: "user", sourceChatId: id });
  const reserved = await reserveReplyRun(id, member.viewer.id);
  assert.ok(reserved.ok);
  bindReplyPlan(reserved.run, replyId, "member-ownership-prompt");

  let finish!: () => void;
  startReplyRun(reserved.run, new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "fixture-text" });
      controller.enqueue({ type: "text-delta", id: "fixture-text", delta: "Fixture reply" });
      finish = () => controller.close();
    },
  }), () => null);

  const stream = { route: "chats/[id]/stream", method: "GET", params: { id }, query: `?replyId=${replyId}` };
  try {
    const memberBefore = snapshot(member.viewer.id);
    const operations: Omit<Spec, "status">[] = [
      { route: "chats/[id]", method: "GET", params: { id } },
      { route: "chats/[id]", method: "PATCH", params: { id }, input: { title: "Fixture title" } },
      { route: "chats/[id]", method: "DELETE", params: { id } },
      { route: "chats/[id]/messages/[messageId]", method: "PATCH", params: { id, messageId: replyId }, input: { text: "Fixture reply" } },
      { route: "chats/[id]/stop", method: "POST", params: { id } },
      { route: "chat", method: "POST", input: chatBody(id, "ownership-prompt", "Fixture prompt") },
      { route: "memories/[id]", method: "PATCH", params: { id: memory.id }, input: { text: "Fixture memory" } },
      { route: "memories/[id]", method: "DELETE", params: { id: memory.id } },
      { route: "connections/[id]", method: "PATCH", params: { id: memberConnection }, input: { label: "Fixture connection" } },
      { route: "connections/[id]", method: "DELETE", params: { id: memberConnection } },
      { route: "connections/[id]/models", method: "GET", params: { id: memberConnection } },
      { route: "connections/[id]/hidden-models", method: "PUT", params: { id: memberConnection }, input: { modelId: memberModel, hidden: true } },
      { route: "preferences/model", method: "PUT", input: { connectionId: memberConnection, model: memberModel, effort: "medium" } },
      stream,
    ];
    for (const operation of operations) {
      assert.equal((await routeRequest(operation, admin.cookie)).status, 404, `${operation.method} ${operation.route}`);
    }
    assert.equal(reserved.run.controller.signal.aborted, false);
    const live = await routeRequest(stream, member.cookie);
    assert.equal(live.status, 200);
    await live.body?.cancel();
    finish();
    await reserved.run.done;

    assert.equal((await routeRequest(stream, admin.cookie)).status, 404);
    const replay = await routeRequest(stream, member.cookie);
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /Fixture reply/);
    const adminNotes = await routeRequest({ route: "memories", method: "GET", query: "?q=jasmine" }, admin.cookie);
    assert.deepEqual(await adminNotes.json(), { memories: [] });
    const adminSearch = await routeRequest({ route: "search", method: "GET", query: "?q=Benign" }, admin.cookie);
    assert.deepEqual(await adminSearch.json(), { hits: [] });
    assert.deepEqual(snapshot(member.viewer.id), memberBefore);
  } finally {
    if (!findReplyRun(id, member.viewer.id, replyId)) releaseReplyRun(reserved.run);
    else {
      if (findReplyRun(id, member.viewer.id)) finish();
      await discardReplyRun(id);
    }
    sqlite.prepare("DELETE FROM memories WHERE id = ?").run(memory.id);
    deleteChat(id, member.viewer.id);
  }
});

test("a full reply quota in either account leaves the other account a slot", async (t) => {
  assert.ok(pendingRun?.ok);
  const baselineRun = pendingRun.run;
  for (const [full, other] of [[accounts.admin, accounts.member], [accounts.member, accounts.admin]]) {
    await t.test(full.viewer.role, async () => {
      const runs = [];
      try {
        const count = MAX_RUNNING_PER_USER - Number(full.viewer.id === baselineRun.userId);
        for (let i = 0; i < count; i++) {
          const reserved = await reserveReplyRun(`quota-${full.viewer.role}-${i}`, full.viewer.id);
          assert.ok(reserved.ok);
          runs.push(reserved.run);
        }
        assert.deepEqual(await reserveReplyRun(`quota-extra-${full.viewer.role}`, full.viewer.id), { ok: false, reason: "user-limit" });
        const spare = await reserveReplyRun(`quota-other-${full.viewer.role}`, other.viewer.id);
        assert.ok(spare.ok);
        runs.push(spare.run);
      } finally {
        for (const run of runs) releaseReplyRun(run);
      }
    });
  }
});

test("every API handler has a session and cross-account behavior check", async (t) => {
  const specs: Spec[] = [
    { route: "admin/settings", method: "GET", status: 403 },
    { route: "admin/settings", method: "PUT", status: 403, input: { dreamHour: 22 } },
    { route: "settings", method: "GET", status: 200, body: privateSettings },
    { route: "settings", method: "PUT", status: 400, input: { searxngUrl: "https://other.example", tavilyApiKey: "fixture", sandbox: "off", dreamHour: 22 } },
    { route: "settings", method: "PUT", status: 200, input: { githubToken: crypto.randomUUID() } },
    { route: "settings/github/check", method: "POST", status: 200, input: {}, body: { ok: false, error: "Add a GitHub token." } },
    { route: "preferences", method: "GET", status: 200, body: { theme: "dark", textSize: "md", replyFont: "sans", chatWidth: "normal", accent: "sun", memory: "on" } },
    { route: "preferences", method: "PATCH", status: 200, input: { theme: "dim", memory: "off" } },
    { route: "preferences/model", method: "GET", status: 200, body: { connectionId: sqlite.prepare("SELECT default_connection_id FROM user_preferences WHERE user_id = ?").pluck().get(accounts.member.viewer.id), model: memberModel, effort: "medium" } },
    { route: "preferences/model", method: "PUT", status: 404, input: { connectionId: adminConnection, model: memberModel, effort: "medium" } },
    { route: "chats", method: "GET", status: 200 },
    { route: "chats", method: "POST", status: 201 },
    { route: "chats/[id]", method: "GET", status: 404, params: { id: adminChat } },
    { route: "chats/[id]", method: "PATCH", status: 404, params: { id: adminChat }, input: { title: "New title" } },
    { route: "chats/[id]", method: "DELETE", status: 404, params: { id: adminChat } },
    ...[adminChat, memberChat].map((id) => ({ route: "chats/[id]/messages/[messageId]", method: "PATCH", status: 404, params: { id, messageId: adminReply }, input: { text: "New reply" } })),
    ...["", `?replyId=${adminReply}`].map((query) => ({ route: "chats/[id]/stream", method: "GET", status: 404, params: { id: adminChat }, query })),
    { route: "chats/[id]/stop", method: "POST", status: 404, params: { id: adminChat } },
    { route: "chat", method: "POST", status: 404, input: chatBody(adminChat) },
    { route: "chat", method: "POST", status: 404, input: { ...chatBody(memberChat), modelChoice: { connectionId: adminConnection, model: "admin-model", effort: "medium" } } },
    { route: "chat", method: "POST", status: 409, input: chatBody(memberChat, adminPrompt) },
    { route: "search", method: "GET", status: 200, query: `?q=${canary}`, body: { hits: [] } },
    ...["", `?q=${canary}`].map((query) => ({ route: "memories", method: "GET", status: 200, query, body: { memories: [] } })),
    { route: "memories/[id]", method: "PATCH", status: 404, params: { id: adminNote }, input: { text: "changed", kind: "fact" } },
    { route: "memories/[id]", method: "DELETE", status: 404, params: { id: adminNote } },
    { route: "connections", method: "GET", status: 200 },
    { route: "connections", method: "POST", status: 201, input: { kind: "openai-compatible", label: "Member", apiKey: crypto.randomUUID(), baseUrl: provider } },
    { route: "connections/[id]", method: "PATCH", status: 404, params: { id: adminConnection }, input: { label: "Changed" } },
    { route: "connections/[id]", method: "DELETE", status: 404, params: { id: adminConnection } },
    { route: "connections/[id]/models", method: "GET", status: 404, params: { id: adminConnection } },
    { route: "connections/[id]/hidden-models", method: "PUT", status: 404, params: { id: adminConnection }, input: { modelId: "admin-model", hidden: true } },
  ];
  const covered = new Set(["setup GET", "auth/[...all] GET", "auth/[...all] POST", ...specs.map(({ route, method }) => `${route} ${method}`)]);
  assert.deepEqual([...routes.keys()].sort(), [...covered].sort());
  assert.deepEqual(await (await routeRequest({ route: "setup", method: "GET" })).json(), { signupOpen: false });

  let providerCalls = 0;
  const turns: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    providerCalls++;
    const request = new Request(url, init);
    assert.equal(request.headers.has("cookie"), false);
    if (new URL(request.url).pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: memberModel }] });
    }
    const body = await request.json();
    if (!body.stream) {
      return Response.json({ id: "title", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Member test" } }] });
    }
    turns.push(body);
    const frames = [{ delta: { role: "assistant", content: "Member reply" }, finish_reason: null }, { delta: {}, finish_reason: "stop" }];
    const chunks = frames.map((choice) => `data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, ...choice }] })}\n\n`);
    return new Response(chunks.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });

  const before = snapshot(accounts.admin.viewer.id);
  const adminRead = await routeRequest({ route: "admin/settings", method: "GET" }, accounts.admin.cookie);
  assert.equal(adminRead.status, 200);
  const adminBody = await adminRead.json();
  assert.equal(adminBody.tavilyKeySet, true);
  assert.equal("tavilyApiKey" in adminBody, false);
  assert.equal((await routeRequest({ route: "admin/settings", method: "PUT", input: { dreamHour: 8 } }, accounts.admin.cookie)).status, 200);
  assert.equal((await (await routeRequest({ route: "admin/settings", method: "GET" }, accounts.admin.cookie)).json()).dreamHour, 8);
  const afterAdmin = snapshot(accounts.admin.viewer.id);
  assert.notDeepEqual(afterAdmin.instance, before.instance);

  for (const spec of specs) {
    if (spec.route === "settings" && spec.method === "PUT" && spec.status === 200) continue;
    const label = `${spec.method} /${spec.route}${spec.query ?? ""}`;
    assert.equal((await routeRequest(spec)).status, 401, label);
    const callsBefore = providerCalls;
    const response = await routeRequest(spec, accounts.member.cookie);
    assert.equal(response.status, spec.status, label);
    const body = await response.json();
    if (spec.body !== undefined) assert.deepEqual(body, spec.body, label);
    if (spec.route === "chats" && spec.method === "GET") assert.deepEqual(body.chats.map((chat: { id: string }) => chat.id), [memberChat]);
    if (spec.route === "chats" && spec.method === "POST") assert.equal(sqlite.prepare("SELECT user_id FROM chats WHERE id = ?").pluck().get(body.id), accounts.member.viewer.id);
    if (spec.route === "connections" && spec.method === "GET") assert.equal(body.some((entry: { id: string }) => entry.id === adminConnection), false);
    if (spec.route === "connections" && spec.method === "POST") assert.equal(sqlite.prepare("SELECT user_id FROM provider_connections WHERE id = ?").pluck().get(body.id), accounts.member.viewer.id);
    else assert.equal(providerCalls, callsBefore, label);
    assert.deepEqual(snapshot(accounts.admin.viewer.id), afterAdmin, label);
    assert.ok(pendingRun?.ok);
    assert.equal(pendingRun.run.controller.signal.aborted, false, label);
    assert.equal(findReplyRun(adminChat, accounts.admin.viewer.id)?.run, pendingRun.run, label);
  }

  const member = accounts.member.viewer.id;
  savePreferences(member, { memory: "on" });
  const response = await routeRequest({ route: "chat", method: "POST", input: chatBody(memberChat, "scoped-prompt", `Where is ${canary}?`) }, accounts.member.cookie);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Member reply/);
  await Promise.allSettled(afterTasks);
  assert.equal(turns.length, 1, "the member turn reached the provider");
  const sent = JSON.stringify(turns[0]);
  assert.equal(sent.includes(`Remember the ${canary}`), false);
  assert.equal(sent.includes('"name":"remember"'), true);
  assert.equal(sent.includes('"name":"github_'), false);

  const save = specs.find((spec) => spec.route === "settings" && spec.method === "PUT" && spec.status === 200);
  assert.ok(save);
  assert.equal((await routeRequest(save)).status, 401);
  const saved = await routeRequest(save, accounts.member.cookie);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).githubTokenSet, true);
  assert.deepEqual(snapshot(accounts.admin.viewer.id), afterAdmin);

  sqlite.prepare("DELETE FROM user WHERE id = ?").run(member);
  assert.equal((await routeRequest({ route: "settings", method: "GET" }, accounts.member.cookie)).status, 401);
  assert.deepEqual(snapshot(accounts.admin.viewer.id), afterAdmin);
});
