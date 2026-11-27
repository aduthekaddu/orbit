import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { pathToFileURL } from "node:url";
import test, { after, before, type TestContext } from "node:test";
import { startMockMcp, type MockMcp } from "../../../../scripts/qa/mock-mcp.mjs";
import { Redactor } from "@/lib/chat-errors";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { Effort } from "@/lib/effort";
import * as messages from "@/lib/messages";
import { seedTestConnection } from "@/lib/connection-fixture";
import { deleteConnection, getConnection, getModelDefaults } from "@/lib/connections";
import { chatChoice, setChatChoice, type ModelChoice } from "@/lib/model-choice";
import { cachedCaps, listModels } from "@/lib/model-list";
import { discardReplyRun, findReplyRun, releaseReplyRun, replyResponse, reserveReplyRun, stopReplyRun } from "@/lib/reply-runs";
import { encryptSecret } from "@/lib/secrets";
import { getSettings, saveSettings } from "@/lib/settings";

const PROVIDER_KEY = "made-up-provider-key-0001";
const TAVILY_KEY = "made-up-tavily-key-0002";
const USER_ID = "u-route";
// Any of these seeds the settings row when it is absent, and a real GitHub token would open a real connection.
const SEEDED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN"];
const CONSOLE_METHODS = ["error", "warn", "log", "info", "debug"] as const;

// The route reads the session from request headers and schedules the title with after(), and both
// need a Next.js request scope. These stubs stand in for them so the test drives the real handler.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-chat-route-"));
const stubs: Record<string, string> = {
  "@/lib/session": `exports.getSession = async () => ({ user: { id: ${JSON.stringify(USER_ID)} } });
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`,
  "next/server": `exports.after = (task) => { globalThis.__orbitAfter.push(Promise.resolve(typeof task === "function" ? task() : task)); };`,
};
const stubUrls = Object.fromEntries(Object.entries(stubs).map(([specifier, source], index) => {
  const file = path.join(sandbox, `stub-${index}.cjs`);
  fs.writeFileSync(file, source);
  return [specifier, pathToFileURL(file).href];
}));

const afterTasks: Promise<unknown>[] = [];
const ANTHROPIC_ID = "conn-route-anthropic";
const anthropicBodies: AnthropicBody[] = [];
const providerKeys: string[] = [];
let providerBase = "";
let failedAnthropicStream: http.ServerResponse | undefined;
(globalThis as { __orbitAfter?: Promise<unknown>[] }).__orbitAfter = afterTasks;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubUrls[specifier];
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

type Route = typeof import("./route");

let route: Route;
let editReply: typeof import("../chats/[id]/messages/[messageId]/route").PATCH;
let closeDb: () => void;
let provider: http.Server;
let github: MockMcp;
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(
  ["ORBIT_DATA_DIR", "ORBIT_OLLAMA_URL", "ORBIT_GITHUB_MCP_FIXTURE", "ORBIT_ANTHROPIC_BASE_URL", ...SEEDED_ENV].map((name) => [name, process.env[name]]),
);

function sse(res: http.ServerResponse, deltas: unknown[], finish: string, model: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: unknown, reason: string | null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  for (const delta of deltas) res.write(chunk(delta, null));
  res.write(chunk({}, finish));
  res.end("data: [DONE]\n\n");
}

function answer(res: http.ServerResponse, body: { stream?: boolean; messages?: Array<{ role: string; content: unknown }> }) {
  const prompt = JSON.stringify(body.messages ?? []);
  const rejected = prompt.includes("[echo-keys]")
    ? `${TAVILY_KEY} and ${PROVIDER_KEY} and ${github.token}`
    : prompt.includes("[echo-provider-key]")
      ? PROVIDER_KEY
      : prompt.includes("[reject]")
        ? "the request"
        : "";
  if (rejected) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `upstream rejected ${rejected}`, type: "invalid_request_error" } }));
    return;
  }
  if (body.stream !== true) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "t", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "Route test" }, finish_reason: "stop" }] }));
    return;
  }
  const model = prompt.includes("[model-echoes-key]") ? `proxy-${PROVIDER_KEY}` : "mock";
  if (body.messages?.at(-1)?.role === "tool") {
    sse(res, [{ role: "assistant", content: "Done." }], "stop", model);
    return;
  }
  const call = prompt.includes("[github-call]")
    ? { name: "github_list_issues", arguments: JSON.stringify({ owner: "aduthekaddu", repo: "orbit" }) }
    : { name: "render_ui", arguments: JSON.stringify({ root: "r", elements: { [TAVILY_KEY]: { type: "NotAComponent", props: {}, children: [] } } }) };
  sse(res, [{ role: "assistant", content: "", tool_calls: [{ index: 0, id: "call-1", type: "function", function: call }] }], "tool_calls", model);
}

type AnthropicBlock = { type: string; text?: string };
type AnthropicBody = {
  model?: string;
  stream?: boolean;
  thinking?: { type: string };
  output_config?: { effort?: string };
  fallbacks?: string;
  messages?: Array<{ role: string; content: string | AnthropicBlock[] }>;
};

const omittedBeforeFallback = new Set(["thinking", "redacted_thinking", "tool_use"]);

// The Messages API rejects history that echoes thinking or tool use from before the last fallback block of a turn.
function echoesRefusedTurn(body: AnthropicBody) {
  return (body.messages ?? []).some(({ role, content }) => {
    if (role !== "assistant" || !Array.isArray(content)) return false;
    const boundary = content.findLastIndex((block) => block.type === "fallback");
    if (boundary < 0) return false;
    return content.slice(0, boundary).some((block) => omittedBeforeFallback.has(block.type));
  });
}

function anthropicEvents(res: http.ServerResponse, model: string, blocks: Array<Record<string, unknown>>, stopReason = "end_turn") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (payload: Record<string, unknown>) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
  event({ type: "message_start", message: { id: "msg-route", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "c2ln" } });
    } else if (block.type === "text") {
      event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      event({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      event({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      event({ type: "content_block_start", index, content_block: block });
    }
    event({ type: "content_block_stop", index });
  });
  if (stopReason === "interrupted") return;
  event({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 9 } });
  event({ type: "message_stop" });
  res.end();
}

function answerAnthropic(res: http.ServerResponse, body: AnthropicBody) {
  anthropicBodies.push(body);
  const model = body.model ?? "claude-opus-5-5";
  const unsupported = (model === "claude-haiku-4-5" && body.output_config?.effort !== undefined) ||
    (["claude-haiku-4-5", "claude-opus-4-5"].includes(model) && body.thinking?.type === "adaptive");
  if (echoesRefusedTurn(body) || unsupported) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: unsupported ? "Unsupported effort or thinking" : "Thinking before a fallback block must be omitted" } }));
    return;
  }
  if (body.stream !== true) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg-title", type: "message", role: "assistant", model, content: [{ type: "text", text: "Route test" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 } }));
    return;
  }
  const last = body.messages?.at(-1)?.content;
  const prompt = typeof last === "string" ? last : (last ?? []).map((block) => block.text ?? "").join("");
  if (prompt.includes("[thinking]")) {
    anthropicEvents(res, model, [{ type: "thinking", thinking: "Weighing the request." }, { type: "text", text: "Thoughtful reply." }]);
    return;
  }
  for (const [tag, target, stopReason] of [
    ["[invalid-fallback]", "", "end_turn"],
    ["[stopped-fallback]", "claude-opus-5", "interrupted"],
    ["[failed-fallback]", "claude-opus-5", "interrupted"],
  ]) {
    if (!prompt.includes(tag)) continue;
    if (tag === "[failed-fallback]") failedAnthropicStream = res;
    anthropicEvents(res, model, [
      { type: "fallback", from: { model }, to: { model: target } },
      { type: "text", text: stopReason === "interrupted" ? "Partial answer. ".repeat(32) : "Partial answer." },
    ], stopReason);
    return;
  }
  if (prompt.includes("[fallback-tool]")) {
    anthropicEvents(res, model, [
      { type: "thinking", thinking: "Weighing the request." },
      { type: "fallback", from: { model }, to: { model: "claude-opus-5" } },
      { type: "tool_use", id: "toolu-1", name: "render_ui", input: { root: "r", elements: {} } },
    ], "tool_use");
    return;
  }
  if (!prompt.includes("[fallback]")) {
    anthropicEvents(res, model, [{ type: "text", text: "Next." }]);
    return;
  }
  // A mid-stream fallback: message_start names the requested model, and the fallback block names the one that answers.
  anthropicEvents(res, model, [
    { type: "thinking", thinking: "Weighing the request." },
    { type: "text", text: "Partial " },
    { type: "fallback", from: { model }, to: { model: "claude-opus-5" } },
    { type: "text", text: "Answer from the fallback." },
  ]);
}

before(async () => {
  for (const name of SEEDED_ENV) delete process.env[name];
  process.env.ORBIT_DATA_DIR = path.join(sandbox, "data");
  process.env.ORBIT_OLLAMA_URL = "http://127.0.0.1:9";
  process.env.ORBIT_GITHUB_MCP_FIXTURE = "1";
  github = await startMockMcp();
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  provider = http.createServer((req, res) => {
    providerKeys.push(req.headers.authorization ?? "");
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: [
          { id: "claude-haiku-4-5", capabilities: { effort: { supported: false }, thinking: { types: { adaptive: { supported: false }, disabled: { supported: true } } } } },
          { id: "claude-opus-4-5", capabilities: { effort: { high: { supported: true } }, thinking: { types: { adaptive: { supported: false }, disabled: { supported: true } } } } },
          { id: "claude-opus-5-5-stale-caps", capabilities: { effort: { low: { supported: true } }, thinking: { types: { adaptive: { supported: true }, disabled: { supported: true } } } } },
        ],
      }));
      return;
    }
    let raw = "";
    req.on("data", (part) => (raw += part));
    req.on("end", () => (req.url?.endsWith("/messages") ? answerAnthropic : answer)(res, JSON.parse(raw || "{}")));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;

  const db = getDb();
  closeDb = () => db.$client.close();
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Route", email: "route@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  providerBase = `http://127.0.0.1:${port}/v1`;
  seedTestConnection(USER_ID, { baseUrl: providerBase, apiKey: PROVIDER_KEY, model: "mock" });
  process.env.ORBIT_ANTHROPIC_BASE_URL = providerBase;
  db.insert(schema.providerConnections)
    .values({ id: ANTHROPIC_ID, userId: USER_ID, kind: "anthropic", label: "Claude", apiKeyCiphertext: encryptSecret(PROVIDER_KEY), createdAt: now })
    .run();
  saveSettings({
    tavilyApiKey: TAVILY_KEY,
    githubToken: github.token,
    githubMcpUrl: `${github.url}?mode=error-token&echo=${encodeURIComponent(`${TAVILY_KEY} and ${PROVIDER_KEY}`)}`,
  });
  route = await import("./route");
  ({ PATCH: editReply } = await import("../chats/[id]/messages/[messageId]/route"));
});

after(async () => {
  await Promise.allSettled(afterTasks);
  closeDb?.();
  await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()));
  await github?.close();
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hooks.deregister();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

async function send(chatId: string, text: string) {
  const logged: string[] = [];
  const originals = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      logged.push(format(...args));
    };
  }
  try {
    const request = new Request("http://127.0.0.1/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: chatId, trigger: "submit-message", messages: [{ id: `${chatId}-u1`, role: "user", parts: [{ type: "text", text }] }] }),
    });
    const response = await route.POST(request);
    const streamed = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; errorText?: string });
    await Promise.allSettled(afterTasks);
    const saved = JSON.stringify(messages.listMessages(chatId));
    return { streamed, logged: logged.join("\n"), saved };
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
}

function errorTexts(chunks: Array<{ errorText?: string }>) {
  return chunks.flatMap((chunk) => (chunk.errorText ? [chunk.errorText] : [])).join("\n");
}

function assertNoCredential(where: string, text: string) {
  for (const [name, key] of [["Tavily key", TAVILY_KEY], ["provider key", PROVIDER_KEY], ["GitHub token", github.token]]) {
    const line = text.split("\n").find((entry) => entry.includes(key));
    assert.equal(line, undefined, `${where} carries the ${name}: ${line?.slice(0, 240)}`);
  }
}

// These checks read log lines, the errorText of stream chunks and the saved reply. They do not cover
// the other chunks the browser receives (text, reasoning and tool-input deltas, tool outputs) or a key
// that is split across chunks or encoded.
test("a provider error that echoes all three stored credentials leaves them out of every console line and stream error text (not other stream chunks)", async () => {
  const { streamed, logged } = await send("c-echo", "[echo-keys] hello");
  assert.match(logged, /chat title/);
  assert.match(logged, /chat stream error/);
  assertNoCredential("log", logged);
  assertNoCredential("stream error", errorTexts(streamed));
});

test("a provider error is logged once by streamText with its name and status, with only its label when it holds a stored credential, and never as the raw SDK dump", async () => {
  const plain = await send("c-provider-plain", "[reject] hello");
  assert.match(plain.logged, /chat provider error AI_APICallError 400 upstream rejected the request/);
  const { streamed, logged } = await send("c-provider", "[echo-provider-key] hello");
  assert.match(logged, /chat provider error \[redacted\]/);
  assert.equal(logged.match(/chat provider error/g)?.length, 1);
  assert.doesNotMatch(logged, /requestBodyValues|responseBody/);
  assertNoCredential("log", logged);
  assertNoCredential("stream error", errorTexts(streamed));
});

test("a tool input error that names the Tavily key leaves it out of the stream error text, the saved reply and the log (not the streamed tool input)", async () => {
  const { streamed, logged, saved } = await send("c-tool", "draw it");
  assert.match(errorTexts(streamed), /Invalid input for tool render_ui/);
  assert.match(saved, /Done\./);
  assertNoCredential("stream error", errorTexts(streamed));
  assertNoCredential("saved reply", saved);
  assertNoCredential("log", logged);
});

test("a GitHub tool error that names every stored credential leaves them out of the stream error text, the saved reply and the log", async () => {
  const { streamed, logged, saved } = await send("c-github", "[github-call] list issues");
  assert.match(logged, /chat stream error \[redacted\]/);
  assert.match(errorTexts(streamed), /The model request failed/);
  assert.match(saved, /Done\./);
  assert.ok(github.callCount() > 0, "the GitHub tool was not called");
  assertNoCredential("stream error", errorTexts(streamed));
  assertNoCredential("saved reply", saved);
  assertNoCredential("log", logged);
});

function assertSavedText(id: string, expected: string) {
  const row = getDb().$client.prepare<[string], { content: string; parts: string }>(
    "select content, parts from messages where id = ?",
  ).get(id);
  assert.ok(row, "the route must save the message");
  const parts: Array<{ type: string; text?: string }> = JSON.parse(row.parts);
  assert.deepEqual({
    messageTextMasked: parts.filter(({ type }) => type === "text").map(({ text }) => text).join("") === expected,
    searchTextMasked: row.content === expected,
  }, { messageTextMasked: true, searchTextMasked: true });
}

test("a submitted prompt masks a stored credential in the saved message and search text", async () => {
  const chatId = "c-redacted-prompt";
  const text = `My example is ${PROVIDER_KEY} today.`;
  await send(chatId, text);
  assertSavedText(`${chatId}-u1`, "My example is [redacted] today.");

  const history = messages.listMessages(chatId);
  const original = history.map((message) => message.role === "user"
    ? { ...message, parts: [{ type: "text", text }] }
    : message);
  const response = await route.POST(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: chatId,
      trigger: "submit-message",
      messages: [...original, { id: `${chatId}-u2`, role: "user", parts: [{ type: "text", text: "A follow-up." }] }],
    }),
  }));
  await response.text();
  assert.equal(response.status, 200, "the tab can send a follow-up before it reloads the saved prompt");
  assertSavedText(`${chatId}-u2`, "A follow-up.");
});

test("a response model id that echoes the provider key is masked in the saved reply record", async () => {
  const chatId = "c-model-echo";
  const { streamed, saved } = await send(chatId, "[model-echoes-key] hello");
  assert.ok(streamed.some((chunk) => chunk.type === "message-metadata"), "the stream sent the reply record");
  const reply = messages.listMessages(chatId).find(({ role }) => role === "assistant");
  assert.deepEqual((reply?.metadata as { reply?: { model?: string } } | undefined)?.reply?.model, "proxy-[redacted]");
  assertNoCredential("the saved history", saved);
});

test("manual reply edits mask a stored credential in the saved message and search text", async (t) => {
  const chatId = "c-redacted-edit";
  await send(chatId, "Draw it.");
  const answer = messages.listMessages(chatId).find(({ role }) => role === "assistant");
  assert.ok(answer);
  const textIndex = answer.parts.findIndex(({ type }) => type === "text");
  assert.ok(textIndex >= 0);
  for (const partIndex of [undefined, textIndex]) {
    await t.test(partIndex === undefined ? "whole reply" : "one text part", async () => {
      const beforeKey = partIndex === undefined ? "Whole edit" : "Part edit";
      const request = new Request(`http://127.0.0.1/api/chats/${chatId}/messages/${answer.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${beforeKey}: ${TAVILY_KEY}.`, partIndex }),
      });
      const response = await editReply(request, { params: Promise.resolve({ id: chatId, messageId: answer.id }) });
      assert.equal(response.status, 200);
      assertSavedText(answer.id, `${beforeKey}: [redacted].`);
    });
  }
});

test("a send that waits for a stopping reply does not call a connection deleted while it waited", async (t) => {
  const chatId = "c-deleted-while-queued";
  const OTHER_KEY = "made-up-provider-key-0003";
  getDb()
    .insert(schema.providerConnections)
    .values({ id: "conn-deleted-while-queued", userId: USER_ID, kind: "openai-compatible", label: "Other", baseUrl: providerBase, apiKeyCiphertext: encryptSecret(OTHER_KEY), createdAt: new Date() })
    .run();
  const slot = await holdStoppingReply(chatId, t);
  const sent = route.POST(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: chatId,
      trigger: "submit-message",
      modelChoice: { connectionId: "conn-deleted-while-queued", model: "mock", effort: "medium" },
      messages: [{ id: `${chatId}-u1`, role: "user", parts: [{ type: "text", text: "Queued." }] }],
    }),
  }));
  try {
    await Promise.race([slot.waiting, sent.then(() => assert.fail("the send did not wait for its slot"))]);
    assert.equal(deleteConnection(USER_ID, "conn-deleted-while-queued"), true);
  } finally {
    slot.release();
  }
  const response = await sent;
  await response.text();
  await Promise.allSettled(afterTasks);
  assert.equal(providerKeys.includes(`Bearer ${OTHER_KEY}`), false, "the deleted connection's key reached the provider");
  assert.equal(response.status, 404);
  assert.equal(messages.chatExists(chatId), false, "the refused send left a chat row");
});

async function holdStoppingReply(chatId: string, t: TestContext) {
  const stopping = await reserveReplyRun(chatId, USER_ID);
  assert.ok(stopping.ok);
  stopReplyRun(chatId, USER_ID);
  const waiting = Promise.withResolvers<void>();
  const done = stopping.run.done;
  const subscribe = done.then.bind(done);
  t.mock.method(done, "then", (...args: Parameters<typeof done.then>) => {
    waiting.resolve();
    return subscribe(...args);
  });
  return { waiting: waiting.promise, release: () => releaseReplyRun(stopping.run) };
}

function sendQueued(chatId: string, modelChoice: ModelChoice, text: string) {
  return route.POST(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: chatId,
      modelChoice,
      messages: [{ id: `${chatId}-u1`, role: "user", parts: [{ type: "text", text }] }],
    }),
  }));
}

test("a queued send pins its choice against the latest chat row", async (t) => {
  const chatId = "c-pinned-while-queued";
  const { connectionId } = getModelDefaults(USER_ID);
  assert.ok(connectionId);
  const requested = { connectionId, model: "mock", effort: "low" } as const;
  getDb().insert(schema.chats).values({ id: chatId, userId: USER_ID, title: "New chat", createdAt: new Date(), updatedAt: new Date() }).run();
  setChatChoice(chatId, requested);

  const slot = await holdStoppingReply(chatId, t);
  const sent = sendQueued(chatId, requested, "A queued message.");
  try {
    await Promise.race([slot.waiting, sent.then(() => assert.fail("the send did not wait for its slot"))]);
    setChatChoice(chatId, { connectionId: ANTHROPIC_ID, model: "claude-opus-5-5", effort: "high" });
  } finally {
    slot.release();
  }
  const response = await sent;
  assert.equal(response.status, 200);
  await response.text();
  await Promise.allSettled(afterTasks);
  const chat = messages.getChatForUser(chatId, USER_ID);
  assert.ok(chat);
  assert.deepEqual(chatChoice(chat), requested);
});

test("a queued send masks with the provider and settings values captured after it claims the slot", async (t) => {
  const chatId = "c-snapshot-while-queued";
  const connectionId = "conn-snapshot-while-queued";
  const prompt = "A normal fixture prompt.";
  const providerValue = "fixture-provider-value-after";
  const settingsValue = "fixture-settings-value-after";
  const db = getDb();
  const settingsBefore = getSettings();
  saveSettings({ githubToken: null });
  db.insert(schema.providerConnections).values({
    id: connectionId, userId: USER_ID, kind: "openai-compatible", label: "Snapshot",
    baseUrl: "https://provider.invalid/v1", apiKeyCiphertext: encryptSecret("fixture-provider-value-before"), createdAt: new Date(),
  }).run();

  const observed: boolean[] = [];
  const mask = Redactor.prototype.text;
  t.mock.method(Redactor.prototype, "text", function (this: Redactor, text: string) {
    if (text === prompt) observed.push([providerValue, settingsValue].every((value) => mask.call(this, value) === "[redacted]"));
    return mask.call(this, text);
  });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 400 }));

  try {
    const slot = await holdStoppingReply(chatId, t);
    const sent = sendQueued(chatId, { connectionId, model: "mock", effort: "low" }, prompt);
    try {
      await Promise.race([slot.waiting, sent.then(() => assert.fail("the send did not wait for its slot"))]);
      db.$client.prepare("update provider_connections set api_key_ciphertext = ? where id = ?").run(encryptSecret(providerValue), connectionId);
      saveSettings({ tavilyApiKey: settingsValue });
    } finally {
      slot.release();
    }
    const response = await sent;
    assert.equal(response.status, 200);
    await response.text();
    await Promise.allSettled(afterTasks);
    assert.ok(observed.length > 0 && observed.every(Boolean), "the send uses both values from the current snapshot");
  } finally {
    saveSettings({ githubToken: settingsBefore.githubToken, tavilyApiKey: settingsBefore.tavilyApiKey });
    deleteConnection(USER_ID, connectionId);
  }
});

type StreamChunk = { type: string; kind?: string; delta?: string; messageMetadata?: { reply?: { model?: string; effortOutcome?: string } } };

function openAnthropic(chatId: string, history: unknown[], text: string, model = "claude-opus-5-5", effort: Effort = "high") {
  return route.POST(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: chatId,
      trigger: "submit-message",
      modelChoice: { connectionId: ANTHROPIC_ID, model, effort },
      messages: [...history, { id: `${chatId}-u${history.length + 1}`, role: "user", parts: [{ type: "text", text }] }],
    }),
  }));
}

function streamChunks(body: string): StreamChunk[] {
  return body.split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as StreamChunk);
}

async function postAnthropic(chatId: string, history: unknown[], text: string, model?: string) {
  const response = await openAnthropic(chatId, history, text, model);
  const streamed = streamChunks(await response.text());
  await Promise.allSettled(afterTasks);
  return { status: response.status, streamed };
}

const savedReply = (chatId: string) => messages.listMessages(chatId).findLast(({ role }) => role === "assistant");
const savedReplyRecord = (chatId: string) => (savedReply(chatId)?.metadata as StreamChunk["messageMetadata"])?.reply;

test("a reply that falls back mid-stream names the model that answered, live and saved", async () => {
  const chatId = "c-fallback-label";
  const { streamed } = await postAnthropic(chatId, [], "[fallback] hello");
  const switched = streamed.findIndex((chunk) => chunk.type === "custom" && chunk.kind === "anthropic.fallback");
  assert.ok(switched >= 0, `the stream carries the fallback part: ${JSON.stringify(streamed.map(({ type }) => type))}`);
  const later = streamed.slice(switched).flatMap((chunk) => (chunk.messageMetadata?.reply ? [chunk.messageMetadata.reply.model] : []));
  assert.ok(later.length > 0, "a reply record follows the fallback");
  assert.deepEqual(new Set(later), new Set(["claude-opus-5"]));
  assert.equal((savedReply(chatId)?.metadata as { reply?: { model?: string } } | undefined)?.reply?.model, "claude-opus-5");
});

test("a reply without a fallback keeps the model the response names", async () => {
  const chatId = "c-no-fallback-label";
  await postAnthropic(chatId, [], "hello");
  assert.equal((savedReply(chatId)?.metadata as { reply?: { model?: string } } | undefined)?.reply?.model, "claude-opus-5-5");
});

test("the turn after a fallback sends the fallback block where it was and no thinking from before it", async () => {
  const chatId = "c-fallback-next";
  await postAnthropic(chatId, [], "[fallback] hello");
  const history = messages.listMessages(chatId).map(({ id, role, parts }) => ({ id, role, parts }));
  const since = anthropicBodies.length;
  const next = await postAnthropic(chatId, history, "and then?");
  const sent = anthropicBodies.slice(since).find((body) => body.stream === true);
  const echoed = sent?.messages?.find(({ role }) => role === "assistant")?.content;
  assert.ok(Array.isArray(echoed), `the next request echoes the reply: ${JSON.stringify(sent?.messages)}`);
  assert.deepEqual(echoed.map((block) => (block.type === "text" ? `text:${block.text}` : block.type)), ["text:Partial ", "fallback", "text:Answer from the fallback."]);
  assert.equal(next.status, 200);
  assert.equal(savedReply(chatId)?.parts.some((part) => part.type === "text" && part.text === "Next."), true, "the next reply is saved");
});

test("a tool step after a fallback continues the same reply without the thinking from before it", async () => {
  const chatId = "c-fallback-tool";
  const since = anthropicBodies.length;
  const { streamed } = await postAnthropic(chatId, [], "[fallback-tool] draw it");
  const steps = anthropicBodies.slice(since).filter((body) => body.stream === true);
  assert.equal(steps.length, 2, "the reply makes a second step after the tool call");
  assert.equal(echoesRefusedTurn(steps[1]), false, JSON.stringify(steps[1].messages));
  assert.equal(streamed.some((chunk) => chunk.type === "error"), false, JSON.stringify(streamed.filter((chunk) => chunk.type === "error")));
  assert.equal((savedReply(chatId)?.metadata as { reply?: { model?: string } } | undefined)?.reply?.model, "claude-opus-5");
});

test("Haiku accepts both chat and title requests with a cold capability cache", async () => {
  const model = "claude-haiku-4-5";
  assert.equal(cachedCaps(ANTHROPIC_ID, model), null);
  const since = anthropicBodies.length;
  const { streamed } = await postAnthropic("c-cold-haiku", [], "Cold cache", model);
  assert.equal(streamed.some(({ type }) => type === "error"), false);
  assert.equal(savedReply("c-cold-haiku")?.parts.some((part) => part.type === "text" && part.text === "Next."), true);
  assert.equal(messages.getChatForUser("c-cold-haiku", USER_ID)?.title, "Route test");
  assert.deepEqual(anthropicBodies.slice(since).map(({ fallbacks }) => fallbacks), ["default", "default"]);
});

test("a cached legacy Claude can use listed effort without unsupported adaptive thinking", async () => {
  const connection = getConnection(USER_ID, ANTHROPIC_ID);
  assert.ok(connection);
  await listModels(connection, PROVIDER_KEY, new Redactor(null));
  const model = "claude-opus-4-5";
  assert.ok(cachedCaps(ANTHROPIC_ID, model));
  const since = anthropicBodies.length;
  const { streamed } = await postAnthropic("c-legacy-effort", [], "Listed effort", model);
  assert.equal(streamed.some(({ type }) => type === "error"), false);
  assert.equal(anthropicBodies.slice(since).find((body) => body.stream)?.output_config?.effort, "high");
});

test("an expired capability entry still permits chat and title generation", async () => {
  const model = "claude-haiku-4-5";
  assert.ok(cachedCaps(ANTHROPIC_ID, model));
  assert.equal(cachedCaps(ANTHROPIC_ID, model, Date.now() + 5 * 60_000), null);
  const { streamed } = await postAnthropic("c-expired-haiku", [], "Expired cache", model);
  assert.equal(streamed.some(({ type }) => type === "error"), false);
  assert.equal(messages.getChatForUser("c-expired-haiku", USER_ID)?.title, "Route test");
});

test("the next Anthropic turn accepts ordinary thinking history with no fallback", async () => {
  const chatId = "c-thinking-next";
  await postAnthropic(chatId, [], "[thinking] hello");
  const history = messages.listMessages(chatId);
  const { streamed } = await postAnthropic(chatId, history, "and then?");
  assert.equal(streamed.some(({ type }) => type === "error"), false);
  assert.ok(streamed.some(({ delta }) => delta === "Next."));
});

test("malformed fallback metadata leaves the reply stream and saved text intact", async () => {
  const chatId = "c-invalid-fallback";
  const { streamed } = await postAnthropic(chatId, [], "[invalid-fallback] hello");
  assert.equal(streamed.at(-1)?.type, "finish");
  assert.ok(streamed.some(({ delta }) => delta === "Partial answer."));
  assert.equal(savedReplyRecord(chatId)?.model, "claude-opus-5-5");
  const since = anthropicBodies.length;
  const next = await postAnthropic(chatId, messages.listMessages(chatId), "What else?");
  assert.ok(next.streamed.some(({ delta }) => delta === "Next."));
  const history = anthropicBodies.slice(since).find(({ stream }) => stream)?.messages ?? [];
  assert.ok(history.some(({ role }) => role === "assistant"));
  assert.equal(history.some(({ content }) => Array.isArray(content) && content.some((block) => block.type === "fallback")), false);
});

async function interruptAnthropic(chatId: string, response: Response, interrupt: () => void, signal: AbortSignal) {
  const run = findReplyRun(chatId, USER_ID);
  assert.ok(run);
  signal.addEventListener("abort", () => stopReplyRun(chatId, USER_ID), { once: true });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let interrupted = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
      if (interrupted || !body.includes("Partial answer.")) continue;
      interrupted = true;
      interrupt();
    }
    body += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  assert.ok(interrupted, "the upstream was interrupted after visible text");
  const replay = await replyResponse(run.run, run.replyId).text();
  return [streamChunks(body), streamChunks(replay)];
}

const lastReplyRecord = (chunks: StreamChunk[]) => chunks.findLast(({ messageMetadata }) => messageMetadata?.reply)?.messageMetadata?.reply;

for (const [kind, terminal] of [["stopped", "abort"], ["failed", "error"]]) {
  test(`a ${kind} reply updates the fallback model in live metadata, replay, and SQLite`, { timeout: 10_000 }, async (t) => {
    const chatId = `c-${kind}-fallback`;
    const response = await openAnthropic(chatId, [], `[${kind}-fallback] hello`);
    const interrupt = kind === "stopped" ? () => stopReplyRun(chatId, USER_ID) : () => failedAnthropicStream?.destroy();
    for (const chunks of await interruptAnthropic(chatId, response, interrupt, t.signal)) {
      assert.equal(chunks.at(-1)?.type, terminal);
      assert.equal(lastReplyRecord(chunks)?.model, "claude-opus-5");
    }
    assert.equal(savedReplyRecord(chatId)?.model, "claude-opus-5");
  });
}

test("an SDK warning marks effort adjusted before a stopped step can finish", { timeout: 10_000 }, async (t) => {
  const connection = getConnection(USER_ID, ANTHROPIC_ID);
  assert.ok(connection);
  await listModels(connection, PROVIDER_KEY, new Redactor(null));
  const chatId = "c-adjusted-warning";
  const model = "claude-opus-5-5-stale-caps";
  const response = await openAnthropic(chatId, [], "[stopped-fallback] hello", model, "none");
  for (const chunks of await interruptAnthropic(chatId, response, () => stopReplyRun(chatId, USER_ID), t.signal)) {
    assert.equal(chunks.at(-1)?.type, "abort");
    const fallback = chunks.findIndex(({ type }) => type === "custom");
    assert.ok(fallback >= 0);
    assert.equal(lastReplyRecord(chunks.slice(0, fallback))?.effortOutcome, "adjusted");
  }
  assert.equal(savedReplyRecord(chatId)?.effortOutcome, "adjusted");
});

function post(body: Record<string, unknown>) {
  return route.POST(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const userMessage = (id: string, text = "hello") => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistantMessage = (id: string, text: string) => ({ id, role: "assistant", parts: [{ type: "text", text }] });

test("a first send that the route refuses leaves no chat row", async () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ["stale", { trigger: "submit-message", messages: [assistantMessage("rf-a1", "an answer nobody saved"), userMessage("rf-u1")] }, 409],
    ["no-prompt", { trigger: "submit-message", messages: [assistantMessage("rf-a2", "only an answer")] }, 400],
    ["regenerate", { trigger: "regenerate-message", messages: [userMessage("rf-u3")] }, 404],
    ["bad-edit", { trigger: "submit-message", editMessageId: "rf-missing", messages: [userMessage("rf-u4")] }, 400],
    ["unknown-connection", { messages: [userMessage("rf-u5")], modelChoice: { connectionId: "conn-missing", model: "mock", effort: "low" } }, 404],
    ["too-long", { messages: [userMessage("rf-u6", "a".repeat(50_001))] }, 413],
  ];
  for (const [name, body, status] of cases) {
    const chatId = `c-refused-${name}`;
    const response = await post({ id: chatId, ...body });
    await response.text();
    assert.equal(response.status, status, name);
    assert.equal(messages.getChatForUser(chatId, USER_ID), null, `${name} left a chat row`);
  }
});

test("a reply discarded mid-stream saves nothing and keeps the prompt", { timeout: 10_000 }, async (t) => {
  const chatId = "c-discarded";
  const response = await openAnthropic(chatId, [], "[stopped-fallback] hello");
  let discarded: Promise<void> | undefined;
  const [live] = await interruptAnthropic(chatId, response, () => {
    discarded = discardReplyRun(chatId);
  }, t.signal);
  await discarded;
  await Promise.allSettled(afterTasks);
  assert.equal(live.at(-1)?.type, "abort");
  assert.equal(savedReply(chatId), undefined, "the discarded reply was saved");
  assert.deepEqual(messages.listMessages(chatId).map(({ role }) => role), ["user"]);
});

test("a send to another user's chat answers 404 and writes nothing", async () => {
  const db = getDb();
  const other = "u-route-other";
  db.$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  db.insert(schema.user).values({ id: other, name: "Other", email: "other@orbit.local", emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).run();
  db.insert(schema.chats).values({ id: "c-theirs", userId: other, title: "Theirs", createdAt: new Date(3_000), updatedAt: new Date(3_000) }).run();
  const response = await post({ id: "c-theirs", trigger: "submit-message", messages: [userMessage("theirs-u1")] });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
  assert.deepEqual(messages.listMessages("c-theirs"), []);
  assert.equal(findReplyRun("c-theirs", other), null);
  assert.deepEqual(db.$client.prepare("select user_id as userId, title, updated_at as updatedAt from chats where id = 'c-theirs'").get(), { userId: other, title: "Theirs", updatedAt: 3_000 });
});
