import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { LOCAL_AUTH_URL } from "@/lib/auth-origins";
import { createTestAccount, createTwoAccounts } from "@/lib/auth-test-helpers";
import { seedTestConnection } from "@/lib/connection-fixture";
import { getDb } from "@/lib/db";
import { saveMemory, writeVectors } from "@/lib/memory/store";
import { saveInstance } from "@/lib/instance-settings";
import { savePreferences } from "@/lib/preferences";
import { deleteChat } from "@/lib/messages";
import {
  bindReplyPlan, discardReplyRun, findReplyRun, MAX_RUNNING_PER_USER, releaseReplyRun, reserveReplyRun, startReplyRun,
} from "@/lib/reply-runs";
import { policyFor, type HostingMode, type UserId } from "@/lib/policy";
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
const adminTavilyKey = crypto.randomUUID();
const adminGithubToken = crypto.randomUUID();
const adminSearxng = "https://search.example";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;
type Spec = { route: string; method: string; status: number; params?: Record<string, string>; query?: string; input?: object; body?: unknown; reaches?: boolean; turn?: boolean };
type Accounts = Awaited<ReturnType<typeof createTwoAccounts>>;
type Subject = Accounts["member"] & { chat: string; connection: string };

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
const subjects = new Map<HostingMode["kind"], Subject>();
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
  subjects.set("personal", { ...accounts.member, chat: memberChat, connection: memberConnection });
  for (const kind of ["team", "community"] as const) {
    const account = await createTestAccount({ role: "member", name: `Member ${kind}`, email: `member-${kind}@orbit.test` });
    const chat = `member-chat-${kind}`;
    sqlite.prepare("INSERT INTO chats(id, user_id, title, created_at, updated_at) VALUES (?, ?, 'New chat', 1, 1)").run(chat, account.viewer.id);
    subjects.set(kind, { ...account, chat, connection: seedTestConnection(account.viewer.id, { baseUrl: provider, apiKey: crypto.randomUUID(), model: memberModel }) });
  }
  assert.ok(saveInstance(admin, { searxngUrl: adminSearxng, tavilyApiKey: adminTavilyKey }).ok);
  assert.ok(saveGithub(admin, { githubToken: adminGithubToken }).ok);
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
  const direct = ["account", "session", "chats", "provider_connections", "hidden_models", "memories", "memory_runs", "tool_status", "user_github", "user_preferences"];
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

const hostingModes: HostingMode[] = [{ kind: "personal" }, { kind: "team" }, { kind: "community", signup: "invite" }];

function assertScopedTurn(sent: unknown, model: string) {
  assert.ok(sent, "the member turn reached the provider");
  const text = JSON.stringify(sent);
  assert.equal((sent as { model: string }).model, model);
  assert.equal(text.includes(`Remember the ${canary}`), false);
  assert.equal(text.includes('"name":"remember"'), true);
  assert.equal(text.includes('"name":"github_'), false);
}

async function crossUserMatrix(t: TestContext, mode: HostingMode, round: number) {
  const { admin } = accounts;
  const subject = subjects.get(mode.kind);
  assert.ok(subject);
  const member = subject.viewer.id;
  const policy = policyFor(mode);
  const shared = policy.connectionOwner(subject.viewer, admin.viewer.id) === admin.viewer.id;
  const manages = policy.mayCreateConnection(subject.viewer);
  const sharedStatus = shared ? 200 : 404;
  const previousFixture = process.env.ORBIT_PROVIDER_FIXTURE;
  t.after(() => {
    if (previousFixture === undefined) delete process.env.ORBIT_PROVIDER_FIXTURE;
    else process.env.ORBIT_PROVIDER_FIXTURE = previousFixture;
  });
  process.env.ORBIT_PROVIDER_FIXTURE = "1";
  assert.equal((await routeRequest({ route: "admin/settings", method: "PUT", input: { hostingMode: mode.kind } }, admin.cookie)).status, 200);

  const specs: Spec[] = [
    { route: "admin/invites", method: "GET", status: 403 },
    { route: "admin/invites", method: "POST", status: 403 },
    { route: "admin/invites/[id]", method: "DELETE", status: 403, params: { id: "invite" } },
    { route: "admin/users", method: "GET", status: 403 },
    { route: "admin/users/[id]", method: "DELETE", status: 403, params: { id: "member" } },
    { route: "admin/settings", method: "GET", status: 403 },
    { route: "admin/settings", method: "PUT", status: 403, input: { dreamHour: 22 } },
    { route: "settings", method: "GET", status: 200, body: privateSettings },
    { route: "settings", method: "PUT", status: 400, input: { searxngUrl: "https://other.example", tavilyApiKey: "fixture", sandbox: "off", dreamHour: 22 } },
    { route: "settings", method: "PUT", status: 200, input: { githubToken: crypto.randomUUID() } },
    { route: "settings/github/check", method: "POST", status: 200, input: {}, body: { ok: false, error: "Add a GitHub token." } },
    { route: "preferences", method: "GET", status: 200, body: { theme: "dark", textSize: "md", replyFont: "sans", chatWidth: "normal", accent: "sun", memory: "on" } },
    { route: "preferences", method: "PATCH", status: 200, input: { theme: "dim", memory: "off" } },
    { route: "preferences/model", method: "GET", status: 200, body: { connectionId: sqlite.prepare("SELECT default_connection_id FROM user_preferences WHERE user_id = ?").pluck().get(member), model: memberModel, effort: "medium" } },
    { route: "preferences/model", method: "PUT", status: sharedStatus, reaches: shared, input: { connectionId: adminConnection, model: memberModel, effort: "medium" } },
    { route: "chats", method: "GET", status: 200 },
    { route: "chats", method: "POST", status: 201 },
    { route: "chats/[id]", method: "GET", status: 404, params: { id: adminChat } },
    { route: "chats/[id]", method: "PATCH", status: 404, params: { id: adminChat }, input: { title: "New title" } },
    { route: "chats/[id]", method: "PATCH", status: 404, params: { id: adminChat }, input: { toolsOff: ["web_search"], toolsOn: ["memory"] } },
    { route: "chats/[id]", method: "DELETE", status: 404, params: { id: adminChat } },
    ...[adminChat, subject.chat].map((id) => ({ route: "chats/[id]/messages/[messageId]", method: "PATCH", status: 404, params: { id, messageId: adminReply }, input: { text: "New reply" } })),
    ...["", `?replyId=${adminReply}`].map((query) => ({ route: "chats/[id]/stream", method: "GET", status: 404, params: { id: adminChat }, query })),
    { route: "chats/[id]/stop", method: "POST", status: 404, params: { id: adminChat } },
    { route: "chat", method: "POST", status: 404, input: chatBody(adminChat) },
    { route: "chat", method: "POST", status: 409, input: chatBody(subject.chat, adminPrompt) },
    { route: "search", method: "GET", status: 200, query: `?q=${canary}`, body: { hits: [] } },
    ...["", `?q=${canary}`].map((query) => ({ route: "memories", method: "GET", status: 200, query, body: { memories: [] } })),
    { route: "memories/[id]", method: "PATCH", status: 404, params: { id: adminNote }, input: { text: "changed", kind: "fact" } },
    { route: "memories/[id]", method: "DELETE", status: 404, params: { id: adminNote } },
    { route: "connections", method: "GET", status: 200 },
    { route: "connections", method: "POST", status: manages ? 201 : 403, reaches: manages, input: { kind: "openai-compatible", label: "Member", apiKey: crypto.randomUUID(), baseUrl: "http://127.0.0.1/v1" } },
    { route: "connections/[id]", method: "PATCH", status: manages ? 404 : 403, params: { id: adminConnection }, input: { label: "Changed" } },
    { route: "connections/[id]", method: "DELETE", status: manages ? 404 : 403, params: { id: adminConnection } },
    { route: "connections/[id]/models", method: "GET", status: sharedStatus, reaches: shared, params: { id: adminConnection } },
    { route: "connections/[id]/hidden-models", method: "PUT", status: sharedStatus, params: { id: adminConnection }, input: { modelId: "admin-model", hidden: true } },
    { route: "tools", method: "GET", status: 200 },
    { route: "tools/[id]", method: "GET", status: 200, params: { id: "web_search" } },
    { route: "tools/[id]", method: "GET", status: 200, params: { id: "github" }, body: { id: "github", setup: { state: "missing", configure: "self" }, instruction: null, tools: [] } },
    { route: "tools/[id]/test", method: "POST", status: 409, params: { id: "github" }, body: { error: "Add a GitHub token." } },
    { route: "tools/[id]/test", method: "POST", status: 400, params: { id: "render_ui" } },
    {
      route: "chat", method: "POST", status: sharedStatus, reaches: shared, turn: shared,
      input: { ...chatBody(subject.chat, "shared-prompt", `Where is ${canary}?`), modelChoice: { connectionId: adminConnection, model: "admin-model", effort: "medium" } },
    },
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

  // The admin's own tool status, which no member route may read or change.
  sqlite.prepare("INSERT OR REPLACE INTO tool_status (user_id, tool_id, last_ok_at) VALUES (?, 'web_search', ?)").run(admin.viewer.id, 1_000 + round);
  const before = snapshot(admin.viewer.id);
  const adminRead = await routeRequest({ route: "admin/settings", method: "GET" }, admin.cookie);
  assert.equal(adminRead.status, 200);
  const adminBody = await adminRead.json();
  assert.equal(adminBody.tavilyKeySet, true);
  assert.equal("tavilyApiKey" in adminBody, false);
  const dreamHour = 8 + round;
  assert.equal((await routeRequest({ route: "admin/settings", method: "PUT", input: { dreamHour } }, admin.cookie)).status, 200);
  assert.equal((await (await routeRequest({ route: "admin/settings", method: "GET" }, admin.cookie)).json()).dreamHour, dreamHour);
  const afterAdmin = snapshot(admin.viewer.id);
  assert.notDeepEqual(afterAdmin.instance, before.instance);

  for (const spec of specs) {
    if (spec.route === "settings" && spec.method === "PUT" && spec.status === 200) continue;
    const label = `${mode.kind}: ${spec.method} /${spec.route}${spec.query ?? ""}`;
    assert.equal((await routeRequest(spec)).status, 401, label);
    const callsBefore = providerCalls;
    if (spec.turn) savePreferences(member, { memory: "on" });
    const response = await routeRequest(spec, subject.cookie);
    assert.equal(response.status, spec.status, label);
    if (spec.turn) {
      assert.match(await response.text(), /Member reply/, label);
      await Promise.allSettled(afterTasks);
      assertScopedTurn(turns.at(-1), "admin-model");
    } else {
      const body = await response.json();
      if (spec.body !== undefined) assert.deepEqual(body, spec.body, label);
      if (spec.route === "chats" && spec.method === "GET") assert.deepEqual(body.chats.map((chat: { id: string }) => chat.id), [subject.chat], label);
      if (spec.route === "chats" && spec.method === "POST") assert.equal(sqlite.prepare("SELECT user_id FROM chats WHERE id = ?").pluck().get(body.id), member, label);
      if (spec.route === "connections" && spec.method === "GET") {
        assert.deepEqual(body.map((entry: { id: string }) => entry.id), [shared ? adminConnection : subject.connection], label);
        if (shared) assert.deepEqual(Object.keys(body[0]).sort(), ["id", "kind", "label"], label);
      }
      if (spec.route === "connections" && spec.method === "POST" && spec.status === 201) assert.equal(sqlite.prepare("SELECT user_id FROM provider_connections WHERE id = ?").pluck().get(body.id), member, label);
      if (spec.route === "tools" && spec.method === "GET") {
        assert.deepEqual(body.tools.map((tool: { id: string }) => tool.id), ["web_search", "run_code", "github", "memory", "render_ui"], label);
        const search = body.tools[0];
        assert.deepEqual({ status: search.status, health: search.health, configureHref: search.configureHref }, { status: "untested", health: { state: "untested" }, configureHref: null }, label);
      }
      if (spec.route === "tools/[id]" && spec.params?.id === "web_search") assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ["web_search"], label);
      if (spec.route.startsWith("tools")) {
        for (const secret of [adminTavilyKey, adminGithubToken, adminSearxng]) assert.equal(JSON.stringify(body).includes(secret), false, `${label} holds an admin secret`);
      }
    }
    if (!spec.reaches) assert.equal(providerCalls, callsBefore, label);
    assert.deepEqual(snapshot(admin.viewer.id), afterAdmin, label);
    assert.ok(pendingRun?.ok);
    assert.equal(pendingRun.run.controller.signal.aborted, false, label);
    assert.equal(findReplyRun(adminChat, admin.viewer.id)?.run, pendingRun.run, label);
  }

  savePreferences(member, { memory: "on" });
  const taken = turns.length;
  const response = await routeRequest({ route: "chat", method: "POST", input: chatBody(subject.chat, "scoped-prompt", `Where is ${canary}?`) }, subject.cookie);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Member reply/);
  await Promise.allSettled(afterTasks);
  assert.equal(turns.length, taken + 1, "the member turn reached the provider");
  assertScopedTurn(turns.at(-1), shared ? "admin-model" : memberModel);

  const githubRows = () => Number(sqlite.prepare("SELECT count(*) FROM tool_status WHERE user_id = ? AND tool_id = 'github'").pluck().get(member));
  assert.equal(githubRows(), 1, "the member's check of the saved GitHub settings left a status row");
  const save = specs.find((spec) => spec.route === "settings" && spec.method === "PUT" && spec.status === 200);
  assert.ok(save);
  assert.equal((await routeRequest(save)).status, 401);
  const saved = await routeRequest(save, subject.cookie);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).githubTokenSet, true);
  assert.deepEqual(snapshot(admin.viewer.id), afterAdmin);
  assert.equal(githubRows(), 0, "a new GitHub token clears the status the old settings made");

  const removed = await routeRequest({ route: "admin/users/[id]", method: "DELETE", params: { id: member } }, admin.cookie);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  const remaining = snapshot(member);
  for (const rows of [...remaining.owned, remaining.messages, remaining.vectors]) assert.deepEqual(rows, []);
  assert.equal(remaining.user, undefined);
  assert.equal((await routeRequest({ route: "settings", method: "GET" }, subject.cookie)).status, 401);
  assert.deepEqual(snapshot(admin.viewer.id), afterAdmin);
}

test("every API handler has a session and cross-account behavior check in every hosting mode", async (t) => {
  try {
    for (const [round, mode] of hostingModes.entries()) await t.test(mode.kind, (subtest) => crossUserMatrix(subtest, mode, round));
  } finally {
    for (const { viewer } of subjects.values()) sqlite.prepare("DELETE FROM user WHERE id = ?").run(viewer.id);
    sqlite.prepare("UPDATE instance_settings SET hosting_mode = 'personal'").run();
  }
});


test("hosting routes enforce connection ownership and signup across modes", async (t) => {
  const admin = accounts.admin;
  const member = await createTestAccount({ role: "member", name: "Member B2", email: "member-b2@orbit.test" });
  const other = await createTestAccount({ role: "member", name: "Member C", email: "member-c@orbit.test" });
  const ownedConnection = seedTestConnection(member.viewer.id, { baseUrl: provider, apiKey: crypto.randomUUID(), model: memberModel });
  const chatId = "host-mode-isolation";
  const note = saveMemory(member.viewer.id, { text: "Private mode fixture", kind: "fact", source: "user" });
  sqlite.prepare("INSERT INTO chats (id, user_id, created_at, updated_at) VALUES (?, ?, 1, 1)").run(chatId, member.viewer.id);
  sqlite.prepare("INSERT INTO messages (id, chat_id, role, content, parts, position, created_at) VALUES (?, ?, 'assistant', 'Private mode fixture', '[]', 0, 1)").run("private-reply", chatId);
  const setMode = (input: object) => routeRequest({ route: "admin/settings", method: "PUT", input }, admin.cookie);
  const setup = async () => (await routeRequest({ route: "setup", method: "GET" })).json();
  const list = (cookie: string) => routeRequest({ route: "connections", method: "GET" }, cookie);
  const connection = (id: string, method: string, input?: object) => ({ route: "connections/[id]", method, params: { id }, input });
  const add = (baseUrl: string) => ({
    route: "connections", method: "POST", input: { kind: "openai-compatible", label: "Fixture", apiKey: crypto.randomUUID(), baseUrl },
  });
  const models = (id: string) => ({ route: "connections/[id]/models", method: "GET", params: { id } });
  const hidden = (id: string) => ({
    route: "connections/[id]/hidden-models", method: "PUT", params: { id }, input: { modelId: memberModel, hidden: true },
  });
  const choose = (connectionId: string) => ({
    route: "preferences/model", method: "PUT", input: { connectionId, model: memberModel, effort: "medium" },
  });
  const turn = (connectionId: string) => ({
    route: "chat", method: "POST", input: { ...chatBody(chatId), modelChoice: { connectionId, model: memberModel, effort: "medium" } },
  });
  const unauthorizedAdmin: Omit<Spec, "status">[] = [
    { route: "chats/[id]", method: "GET", params: { id: chatId } },
    { route: "chats/[id]", method: "PATCH", params: { id: chatId }, input: { title: "No access" } },
    { route: "chats/[id]", method: "DELETE", params: { id: chatId } },
    { route: "chats/[id]/messages/[messageId]", method: "PATCH", params: { id: chatId, messageId: "private-reply" }, input: { text: "No access" } },
    { route: "chats/[id]/stream", method: "GET", params: { id: chatId } },
    { route: "chats/[id]/stop", method: "POST", params: { id: chatId } },
    turn(adminConnection),
    { route: "memories/[id]", method: "DELETE", params: { id: note.id } },
    { route: "memories/[id]", method: "PATCH", params: { id: note.id }, input: { text: "No access" } },
  ];
  const assertAdminIsolation = async () => {
    const before = snapshot(member.viewer.id);
    for (const spec of unauthorizedAdmin) {
      assert.equal((await routeRequest(spec, admin.cookie)).status, 404, `${spec.method} ${spec.route}`);
    }
    assert.deepEqual(await (await routeRequest({ route: "search", method: "GET", query: "?q=Private" }, admin.cookie)).json(), { hits: [] });
    assert.deepEqual(await (await routeRequest({ route: "memories", method: "GET", query: "?q=Private" }, admin.cookie)).json(), { memories: [] });
    assert.deepEqual(snapshot(member.viewer.id), before);
  };

  try {
    const createInvite = { route: "admin/invites", method: "POST" };
    const listUsers = { route: "admin/users", method: "GET" };
    const remove = { route: "admin/users/[id]", method: "DELETE", params: { id: admin.viewer.id } };
    assert.equal((await routeRequest(createInvite, admin.cookie)).status, 409);
    assert.equal((await routeRequest(remove, admin.cookie)).status, 409);
    const usersResponse = await routeRequest(listUsers, admin.cookie);
    assert.equal(usersResponse.status, 200);
    const { users } = await usersResponse.json();
    assert.equal(users.length, 3);
    for (const account of users) assert.deepEqual(Object.keys(account).sort(), ["createdAt", "email", "id", "name", "role"]);

    assert.equal((await setMode({ hostingMode: "team" })).status, 200);
    assert.equal((await setMode({ hostingMode: "personal" })).status, 409);
    assert.equal((await setMode({ signupMode: "open" })).status, 400);
    assert.deepEqual(await setup(), { signupOpen: false });
    assert.equal((await routeRequest(createInvite, admin.cookie)).status, 201);
    const shared = await (await list(member.cookie)).json();
    assert.equal(shared.length, 1);
    assert.deepEqual(Object.keys(shared[0]).sort(), ["id", "kind", "label"]);
    assert.equal(shared[0].id, adminConnection);
    for (const spec of [add(provider), connection(adminConnection, "PATCH", { label: "No access" }), connection(adminConnection, "DELETE")]) {
      assert.equal((await routeRequest(spec, member.cookie)).status, 403);
    }
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      assert.ok(new Request(input).url.startsWith(provider));
      return Response.json({ data: [{ id: memberModel }] });
    });
    assert.equal((await routeRequest(models(adminConnection), member.cookie)).status, 200);
    assert.equal((await routeRequest(models(ownedConnection), member.cookie)).status, 404);
    assert.equal((await routeRequest(choose(ownedConnection), member.cookie)).status, 404);
    const untouched = snapshot(other.viewer.id);
    const adminBefore = snapshot(admin.viewer.id);
    assert.equal((await routeRequest(hidden(adminConnection), member.cookie)).status, 200);
    assert.equal((await routeRequest(choose(adminConnection), member.cookie)).status, 200);
    assert.deepEqual(snapshot(other.viewer.id), untouched);
    assert.deepEqual(snapshot(admin.viewer.id), adminBefore);
    await assertAdminIsolation();

    assert.equal((await setMode({ hostingMode: "community" })).status, 200);
    assert.deepEqual(await setup(), { signupOpen: false });
    assert.equal((await setMode({ signupMode: "open" })).status, 200);
    assert.deepEqual(await setup(), { signupOpen: true });
    const own = await (await list(member.cookie)).json();
    assert.deepEqual(own.map((entry: { id: string }) => entry.id), [ownedConnection]);
    assert.equal(own[0].keySet, true);
    assert.equal((await routeRequest(add("http://127.0.0.1/v1"), member.cookie)).status, 400);
    for (const spec of [connection(adminConnection, "PATCH", { label: "No access" }), connection(adminConnection, "DELETE"), models(adminConnection), hidden(adminConnection), choose(adminConnection), turn(adminConnection)]) {
      assert.equal((await routeRequest(spec, member.cookie)).status, 404);
    }
    for (const spec of [connection(ownedConnection, "DELETE"), models(ownedConnection), hidden(ownedConnection), choose(ownedConnection)]) {
      assert.equal((await routeRequest(spec, admin.cookie)).status, 404);
    }
    await assertAdminIsolation();
  } finally {
    sqlite.prepare("DELETE FROM user WHERE id IN (?, ?)").run(member.viewer.id, other.viewer.id);
  }
  assert.equal((await setMode({ hostingMode: "personal" })).status, 200);
  assert.deepEqual(await setup(), { signupOpen: false });
});
