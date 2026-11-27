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
import { bindReplyPlan, findReplyRun, releaseReplyRun, reserveReplyRun } from "@/lib/reply-runs";
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
  seedTestConnection(member, { baseUrl: provider, apiKey: crypto.randomUUID(), model: memberModel });
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

function adminSnapshot() {
  const id = accounts.admin.viewer.id;
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

  const before = adminSnapshot();
  const adminRead = await routeRequest({ route: "admin/settings", method: "GET" }, accounts.admin.cookie);
  assert.equal(adminRead.status, 200);
  const adminBody = await adminRead.json();
  assert.equal(adminBody.tavilyKeySet, true);
  assert.equal("tavilyApiKey" in adminBody, false);
  assert.equal((await routeRequest({ route: "admin/settings", method: "PUT", input: { dreamHour: 8 } }, accounts.admin.cookie)).status, 200);
  assert.equal((await (await routeRequest({ route: "admin/settings", method: "GET" }, accounts.admin.cookie)).json()).dreamHour, 8);
  const afterAdmin = adminSnapshot();
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
    assert.deepEqual(adminSnapshot(), afterAdmin, label);
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
  assert.deepEqual(adminSnapshot(), afterAdmin);

  sqlite.prepare("DELETE FROM user WHERE id = ?").run(member);
  assert.equal((await routeRequest({ route: "settings", method: "GET" }, accounts.member.cookie)).status, 401);
  assert.deepEqual(adminSnapshot(), afterAdmin);
});
