import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { startMockMcp, type MockMcp } from "../../../../scripts/qa/mock-mcp.mjs";

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
(globalThis as { __orbitAfter?: Promise<unknown>[] }).__orbitAfter = afterTasks;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubUrls[specifier];
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

type Route = typeof import("./route");
type Messages = typeof import("@/lib/messages");

let route: Route;
let editReply: typeof import("../chats/[id]/messages/[messageId]/route").PATCH;
let messages: Messages;
let db: typeof import("@/lib/db").db;
let closeDb: () => void;
let provider: http.Server;
let github: MockMcp;
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(
  ["ORBIT_DATA_DIR", "ORBIT_OLLAMA_URL", "ORBIT_GITHUB_MCP_FIXTURE", ...SEEDED_ENV].map((name) => [name, process.env[name]]),
);

function sse(res: http.ServerResponse, deltas: unknown[], finish: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: unknown, reason: string | null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
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
  if (body.messages?.at(-1)?.role === "tool") {
    sse(res, [{ role: "assistant", content: "Done." }], "stop");
    return;
  }
  const call = prompt.includes("[github-call]")
    ? { name: "github_list_issues", arguments: JSON.stringify({ owner: "aduthekaddu", repo: "orbit" }) }
    : { name: "render_ui", arguments: JSON.stringify({ root: "r", elements: { [TAVILY_KEY]: { type: "NotAComponent", props: {}, children: [] } } }) };
  sse(res, [{ role: "assistant", content: "", tool_calls: [{ index: 0, id: "call-1", type: "function", function: call }] }], "tool_calls");
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
    let raw = "";
    req.on("data", (part) => (raw += part));
    req.on("end", () => answer(res, JSON.parse(raw || "{}")));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;

  ({ db } = await import("@/lib/db"));
  const schema = await import("@/lib/db/schema");
  const { saveSettings } = await import("@/lib/settings");
  closeDb = () => db.$client.close();
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Route", email: "route@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  saveSettings({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: PROVIDER_KEY,
    tavilyApiKey: TAVILY_KEY,
    githubToken: github.token,
    githubMcpUrl: `${github.url}?mode=error-token&echo=${encodeURIComponent(`${TAVILY_KEY} and ${PROVIDER_KEY}`)}`,
    model: "mock",
    reasoningEffort: "medium",
  });
  messages = await import("@/lib/messages");
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
  const row = db.$client.prepare<[string], { content: string; parts: string }>(
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
