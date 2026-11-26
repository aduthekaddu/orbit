import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { Redactor } from "@/lib/chat-errors";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import * as chatStore from "@/lib/messages";
import { LIMITS } from "@/lib/route-schema";
import { getSettings, saveSettings } from "@/lib/settings";

const redact = new Redactor(null);

const USER_ID = "u-limits";
const PROVIDER_KEY = "made-up-provider-key-0001";
const SEEDED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN"];
const EIGHTY_THOUSAND_LETTERS = "a".repeat(80_000);
// Words, so the check on a long prompt that is allowed does not depend on recall's regex cost.
const LONG_PROMPT_WITHIN_LIMIT = "ab ".repeat(16_000);

// The routes read the session from request headers and schedule the title with after(), and both
// need a Next.js request scope. These stubs stand in for them so the test drives the real handlers.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-route-limits-"));
const stubs: Record<string, string> = {
  "@/lib/session": `exports.getSession = async () => ({ user: { id: ${JSON.stringify(USER_ID)} } });
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`,
  "next/server": `exports.after = (task) => { globalThis.__orbitLimitsAfter.push(Promise.resolve(typeof task === "function" ? task() : task)); };`,
};
const stubUrls = Object.fromEntries(Object.entries(stubs).map(([specifier, source], index) => {
  const file = path.join(sandbox, `stub-${index}.cjs`);
  fs.writeFileSync(file, source);
  return [specifier, pathToFileURL(file).href];
}));

const afterTasks: Promise<unknown>[] = [];
(globalThis as { __orbitLimitsAfter?: Promise<unknown>[] }).__orbitLimitsAfter = afterTasks;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubUrls[specifier];
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

let chatRoute: typeof import("./chat/route");
let settingsRoute: typeof import("./settings/route");
let modelsRoute: typeof import("./models/route");
let closeDb: () => void;
let dbPath = "";
let provider: http.Server;
let providerRequests = 0;
const originalCwd = process.cwd();
const runnerDataDir = process.env.ORBIT_DATA_DIR;
const originalEnv = Object.fromEntries(["ORBIT_OLLAMA_URL", ...SEEDED_ENV].map((name) => [name, process.env[name]]));

function sse(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: unknown, reason: string | null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  res.write(chunk({ role: "assistant", content: "Done." }, null));
  res.write(chunk({}, "stop"));
  res.end("data: [DONE]\n\n");
}

before(async () => {
  for (const name of SEEDED_ENV) delete process.env[name];
  process.env.ORBIT_OLLAMA_URL = "http://127.0.0.1:9";
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  provider = http.createServer((req, res) => {
    providerRequests += 1;
    let raw = "";
    req.on("data", (part) => (raw += part));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { stream?: boolean };
      if (body.stream === true) return sse(res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "t", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "Title" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;

  const db = getDb();
  dbPath = db.$client.name;
  closeDb = () => db.$client.close();
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Limits", email: "limits@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  saveSettings({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: PROVIDER_KEY,
    model: "mock",
    reasoningEffort: "medium",
  });
  chatRoute = await import("./chat/route");
  settingsRoute = await import("./settings/route");
  modelsRoute = await import("./models/route");
});

after(async () => {
  await Promise.allSettled(afterTasks);
  closeDb?.();
  await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()));
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hooks.deregister();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function postJson(url: string, method: string, body: unknown) {
  return new Request(`http://127.0.0.1${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function chatBody(chatId: string, text: string) {
  return { id: chatId, trigger: "submit-message", messages: [{ id: `${chatId}-u1`, role: "user", parts: [{ type: "text", text }] }] };
}

test("an 80,000 letter chat message is refused at the route and never reaches the provider", async () => {
  const before = providerRequests;
  const response = await chatRoute.POST(postJson("/api/chat", "POST", chatBody("c-long", EIGHTY_THOUSAND_LETTERS)));
  const body = (await response.text()).slice(0, 200);
  await Promise.allSettled(afterTasks);
  assert.equal(response.status, 413, `the route answered ${response.status}: ${body}`);
  assert.deepEqual(JSON.parse(body), { error: "Message is too long." });
  assert.equal(providerRequests, before, "the provider received a request for a refused message");
});

test("a new user message split across multiple text parts over the limit is refused", async () => {
  const before = providerRequests;
  const splitMessage = {
    id: "c-split-long",
    trigger: "submit-message",
    messages: [{
      id: "c-split-long-u1",
      role: "user",
      parts: [
        { type: "text", text: "a".repeat(40_000) },
        { type: "text", text: "a".repeat(40_000) },
      ],
    }],
  };
  const { status, text } = await post(splitMessage);
  assert.equal(status, 413, `the route answered ${status}: ${text.slice(0, 200)}`);
  assert.deepEqual(JSON.parse(text), { error: "Message is too long." });
  assert.equal(providerRequests, before, "the provider received a request for a split message over the limit");
  assert.equal(chatStore.storedMessageCount("c-split-long"), 0);

  const justOver = {
    id: "c-split-over",
    trigger: "submit-message",
    messages: [{
      id: "c-split-over-u1",
      role: "user",
      parts: [
        { type: "text", text: "a".repeat(25_000) },
        { type: "text", text: "b".repeat(25_001) },
      ],
    }],
  };
  const overResult = await post(justOver);
  assert.equal(overResult.status, 413, `the route answered ${overResult.status}: ${overResult.text.slice(0, 200)}`);
  assert.deepEqual(JSON.parse(overResult.text), { error: "Message is too long." });

  const splitAssistant = {
    id: "c-split-assistant",
    trigger: "submit-message",
    messages: [{
      id: "c-split-assistant-a1",
      role: "assistant",
      parts: [
        { type: "text", text: "a".repeat(120_000) },
        { type: "text", text: "b".repeat(120_000) },
      ],
    }],
  };
  const assistantResult = await post(splitAssistant);
  assert.equal(assistantResult.status, 413, `the route answered ${assistantResult.status}: ${assistantResult.text.slice(0, 200)}`);
  assert.deepEqual(JSON.parse(assistantResult.text), { error: "Message is too long." });
});

test("a new user message split across multiple text parts within the limit is accepted", async () => {
  const halfA = "ab ".repeat(8_000);
  const halfB = "cd ".repeat(8_666) + "cd";
  assert.equal(halfA.length + halfB.length, LIMITS.userMessageText);
  const { status, text } = await post({
    id: "c-split-ok",
    trigger: "submit-message",
    messages: [{
      id: "c-split-ok-u1",
      role: "user",
      parts: [
        { type: "text", text: halfA },
        { type: "text", text: halfB },
      ],
    }],
  });
  assert.equal(status, 200, `the route answered ${status}: ${text.slice(0, 200)}`);
});

test("a stored multi-part message over the limit does not block the next short turn", async () => {
  const parts = [
    { type: "text", text: "a".repeat(40_000) },
    { type: "text", text: "a".repeat(40_000) },
  ];
  assert.ok(chatStore.ensureChat("c-stored-split", USER_ID));
  const storedUser = { id: "sp-u1", role: "user" as const, parts };
  const plannedUser = chatStore.planChatWrite("c-stored-split", [storedUser], redact);
  assert.ok(!("error" in plannedUser), "error" in plannedUser ? plannedUser.error : "");
  const plannedReply = chatStore.planChatWrite("c-stored-split", [storedUser, { id: "sp-a1", role: "assistant", parts: [] }], redact);
  assert.ok(!("error" in plannedReply), "error" in plannedReply ? plannedReply.error : "");
  assert.equal(chatStore.finishChatReply(plannedReply, [{ type: "text", text: "ok" }], redact), true);
  const { status, text } = await post({
    id: "c-stored-split",
    trigger: "submit-message",
    messages: [
      { id: "sp-u1", role: "user", parts },
      { id: "sp-a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
      shortUser("sp-u2"),
    ],
  });
  assert.equal(status, 200, `the route answered ${status}: ${text.slice(0, 200)}`);
});

test("a chat message inside the limit is accepted", async () => {
  const response = await chatRoute.POST(postJson("/api/chat", "POST", chatBody("c-ok", LONG_PROMPT_WITHIN_LIMIT)));
  assert.equal(response.status, 200);
  await response.text();
  await Promise.allSettled(afterTasks);
});

type SeedMessage = { id: string; role: "user" | "assistant"; text: string };

// A chat as an older Orbit stored it: no limit applied when these were written.
function seedChat(chatId: string, history: SeedMessage[]) {
  assert.ok(chatStore.ensureChat(chatId, USER_ID));
  const incoming: { id: string; role: "user" | "assistant"; parts: unknown }[] = [];
  for (const message of history) {
    const parts = [{ type: "text", text: message.text }];
    if (message.role === "user") {
      incoming.push({ id: message.id, role: "user", parts });
      const planned = chatStore.planChatWrite(chatId, incoming, redact);
      assert.ok(!("error" in planned), "error" in planned ? planned.error : "");
    } else {
      const planned = chatStore.planChatWrite(chatId, [...incoming, { id: message.id, role: "assistant", parts: [] }], redact);
      assert.ok(!("error" in planned), "error" in planned ? planned.error : "");
      assert.equal(planned.id, message.id);
      assert.equal(chatStore.finishChatReply(planned, parts, redact), true);
      incoming.push({ id: message.id, role: "assistant", parts });
    }
  }
}

function pathBody(chatId: string, history: SeedMessage[], next: unknown, extra: object = {}) {
  const stored = history.map((message) => ({ id: message.id, role: message.role, parts: [{ type: "text", text: message.text }] }));
  return { id: chatId, trigger: "submit-message", messages: [...stored, next], ...extra };
}

async function post(body: unknown) {
  const response = await chatRoute.POST(postJson("/api/chat", "POST", body));
  const text = await response.text();
  await Promise.allSettled(afterTasks);
  return { status: response.status, text };
}

const shortUser = (id: string, text = "next question") => ({ id, role: "user", parts: [{ type: "text", text }] });

test("a stored 60,000 letter message does not block the next short turn", async () => {
  const history: SeedMessage[] = [
    { id: "h-u1", role: "user", text: "a".repeat(60_000) },
    { id: "h-a1", role: "assistant", text: "ok" },
  ];
  seedChat("c-stored-long", history);
  const { status, text } = await post(pathBody("c-stored-long", history, shortUser("h-u2")));
  assert.equal(status, 200, `the route answered ${status}: ${text.slice(0, 200)}`);
});

test("a stored chat of 2,000 messages does not block the next short turn", async () => {
  const history: SeedMessage[] = Array.from({ length: 2000 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message ${index}`,
  }));
  seedChat("c-stored-many", history);
  const { status, text } = await post(pathBody("c-stored-many", history, shortUser("m-new")));
  assert.equal(status, 200, `the route answered ${status}: ${text.slice(0, 200)}`);
});

test("an edit that replaces a stored message is held to the message limit", async () => {
  const history: SeedMessage[] = [
    { id: "e-u1", role: "user", text: "a".repeat(60_000) },
    { id: "e-a1", role: "assistant", text: "ok" },
    { id: "e-u2", role: "user", text: "second" },
    { id: "e-a2", role: "assistant", text: "ok" },
  ];
  seedChat("c-edit", history);
  const prefix = history.slice(0, 2);
  const long = await post(pathBody("c-edit", prefix, shortUser("e-u3", EIGHTY_THOUSAND_LETTERS), { editMessageId: "e-u2" }));
  assert.equal(long.status, 413, `the route answered ${long.status}: ${long.text.slice(0, 200)}`);
  const splitEdit = await post(pathBody("c-edit", prefix, {
    id: "e-u3-split",
    role: "user",
    parts: [
      { type: "text", text: "a".repeat(40_000) },
      { type: "text", text: "a".repeat(40_000) },
    ],
  }, { editMessageId: "e-u2" }));
  assert.equal(splitEdit.status, 413, `the route answered ${splitEdit.status}: ${splitEdit.text.slice(0, 200)}`);
  const short = await post(pathBody("c-edit", prefix, shortUser("e-u4"), { editMessageId: "e-u2" }));
  assert.equal(short.status, 200, `the route answered ${short.status}: ${short.text.slice(0, 200)}`);
});

test("a stored message cannot carry a new long message into the history", async () => {
  const history: SeedMessage[] = [{ id: "n-u1", role: "user", text: "first" }, { id: "n-a1", role: "assistant", text: "ok" }];
  seedChat("c-new-long", history);
  const { status } = await post(pathBody("c-new-long", history, shortUser("n-u2", EIGHTY_THOUSAND_LETTERS)));
  assert.equal(status, 413);
  assert.equal(chatStore.storedMessageCount("c-new-long"), 2);
});

test("a request body over the size cap is refused before it is parsed", async () => {
  const body = JSON.stringify({ ...chatBody("c-huge", "hi"), pad: "a".repeat(LIMITS.requestBytes) });
  const response = await chatRoute.POST(new Request("http://127.0.0.1/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "This chat is too large." });
  assert.equal(chatStore.storedMessageCount("c-huge"), 0);
});

test("an 80,000 letter API key is refused by settings and leaves the saved key alone", async () => {
  const response = await settingsRoute.PUT(postJson("/api/settings", "PUT", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: EIGHTY_THOUSAND_LETTERS,
    model: "mock",
    reasoningEffort: "medium",
  }));
  assert.equal(response.status, 400);
  assert.equal(getSettings()?.apiKey, PROVIDER_KEY);
});

test("an 80,000 letter API key is refused by the model list before any provider request", async () => {
  const before = providerRequests;
  const response = await modelsRoute.POST(postJson("/api/models", "POST", { apiKey: EIGHTY_THOUSAND_LETTERS }));
  assert.equal(response.status, 400);
  assert.equal(providerRequests, before);
});

test("the test database stays in the runner-managed ORBIT_DATA_DIR", () => {
  assert.ok(runnerDataDir, "expected scripts/test-data-dir.mjs to set ORBIT_DATA_DIR");
  assert.equal(process.env.ORBIT_DATA_DIR, runnerDataDir);
  assert.equal(dbPath, path.join(runnerDataDir, "orbit.db"));
  assert.equal(fs.existsSync(path.join(sandbox, "data")), false);
});
