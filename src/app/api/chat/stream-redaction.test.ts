import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getDb, type OrbitDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import * as messages from "@/lib/messages";
import { saveSettings } from "@/lib/settings";

const PROVIDER_KEY = "made-up-provider-key-0001";
const TAVILY_KEY = "made-up-tavily-key-0002";
const GITHUB_TOKEN = "made-up-github-token-0003";
const USER_ID = "u-stream-redact";
const SEEDED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN"];

type ModelFactory = () => MockLanguageModelV4;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-stream-redact-"));
const afterTasks: Promise<unknown>[] = [];
let nextModel: ModelFactory = () => {
  throw new Error("no mock model configured");
};
(globalThis as Record<string, unknown>).__orbitStreamAfter = afterTasks;
(globalThis as Record<string, unknown>).__orbitStreamModel = () => nextModel();

const stubs: Record<string, string> = {
  "@/lib/session": `exports.getSession = async () => ({ user: { id: ${JSON.stringify(USER_ID)} } });
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`,
  "next/server": `exports.after = (task) => { globalThis.__orbitStreamAfter.push(Promise.resolve(typeof task === "function" ? task() : task)); };`,
  "@/lib/provider": `exports.orbitModel = () => globalThis.__orbitStreamModel();
exports.modelAllowsReasoning = () => true;
exports.reasoningOptions = () => ({});`,
};

const stubUrls = Object.fromEntries(
  Object.entries(stubs).map(([specifier, source], index) => {
    const file = path.join(sandbox, `stub-${index}.cjs`);
    fs.writeFileSync(file, source);
    return [specifier, pathToFileURL(file).href];
  }),
);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubUrls[specifier];
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

let route: typeof import("./route");
let replay: typeof import("../chats/[id]/stream/route").GET;
let stop: typeof import("../chats/[id]/stop/route").POST;
let db: OrbitDb | undefined;
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(["ORBIT_OLLAMA_URL", "ORBIT_SANDBOX", ...SEEDED_ENV].map((name) => [name, process.env[name]]));

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function finishChunk(unified: "stop" | "tool-calls" = "stop") {
  return { type: "finish" as const, finishReason: { unified, raw: undefined }, usage: USAGE };
}

function setCredentials(keys?: { apiKey?: string; tavilyApiKey?: string; githubToken?: string }) {
  saveSettings({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: keys?.apiKey ?? PROVIDER_KEY,
    tavilyApiKey: keys?.tavilyApiKey ?? TAVILY_KEY,
    githubToken: keys?.githubToken ?? GITHUB_TOKEN,
    githubMcpUrl: "https://api.githubcopilot.com/mcp/",
    model: "mock",
    reasoningEffort: "medium",
  });
}

before(async () => {
  for (const name of SEEDED_ENV) delete process.env[name];
  process.env.ORBIT_OLLAMA_URL = "http://127.0.0.1:9";
  process.env.ORBIT_SANDBOX = "off";
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  db = getDb();
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Stream", email: "stream@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  setCredentials();
  route = await import("./route");
  ({ GET: replay } = await import("../chats/[id]/stream/route"));
  ({ POST: stop } = await import("../chats/[id]/stop/route"));
});

after(async () => {
  await Promise.allSettled(afterTasks);
  db?.$client.close();
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hooks.deregister();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function parseSse(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

async function sendChat(chatId: string, text: string, model: MockLanguageModelV4) {
  const originalError = console.error;
  console.error = () => {};
  nextModel = () => model;
  try {
    const response = await route.POST(
      new Request("http://127.0.0.1/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: chatId,
          trigger: "submit-message",
          messages: [{ id: `${chatId}-u1`, role: "user", parts: [{ type: "text", text }] }],
        }),
      }),
    );
    assert.equal(response.status, 200);
    const raw = await response.text();
    await Promise.allSettled(afterTasks.splice(0));
    const saved = messages.listMessages(chatId);
    const titleRow = getDb().$client.prepare<[string], { title: string }>("select title from chats where id = ?").get(chatId);
    return { raw, chunks: parseSse(raw), saved, title: titleRow?.title ?? "", replyId: response.headers.get("x-resumable-stream-id") };
  } finally {
    console.error = originalError;
  }
}

function generateTitle(text: string) {
  return async () => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  });
}

test("a credential split across text deltas is masked in the live stream without leaking either half", async () => {
  const b64 = Buffer.from(PROVIDER_KEY).toString("base64");
  const mid = Math.floor(b64.length / 2);
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Clean title"),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Key is made-up-" },
          { type: "text-delta", id: "t1", delta: "provider-key-" },
          { type: "text-delta", id: "t1", delta: "0001 and " },
          { type: "text-delta", id: "t1", delta: b64.slice(0, mid) },
          { type: "text-delta", id: "t1", delta: b64.slice(mid) + " here." },
          { type: "text-end", id: "t1" },
          finishChunk(),
        ],
      }),
    }),
  });
  const { raw, chunks } = await sendChat("c-split-text", "hello", model);
  const streamedText = chunks.filter((c) => c.type === "text-delta").map((c) => String(c.delta ?? "")).join("");
  assert.equal(streamedText, "Key is [redacted] and [redacted] here.");
  assert.equal(raw.includes("made-up-"), false, `stream leaked prefix: ${raw}`);
  assert.equal(raw.includes("provider-key-0001"), false, `stream leaked suffix: ${raw}`);
  assert.equal(raw.includes(b64.slice(0, mid)), false, `stream leaked base64 prefix: ${raw}`);
});

test("a credential split across two separate text parts is masked in both the live stream and saved message parts", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Clean title"),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Secret: made-up-" },
          { type: "text-end", id: "t1" },
          { type: "text-start", id: "t2" },
          { type: "text-delta", id: "t2", delta: "provider-key-0001!" },
          { type: "text-end", id: "t2" },
          finishChunk(),
        ],
      }),
    }),
  });
  const { raw, chunks, saved } = await sendChat("c-two-text-parts", "hello", model);
  const streamedText = chunks.filter((c) => c.type === "text-delta").map((c) => String(c.delta ?? "")).join("");
  assert.equal(streamedText, "Secret: [redacted]!");
  assert.equal(raw.includes("made-up-"), false, `stream leaked split part: ${raw}`);
  const assistant = saved.find((m) => m.role === "assistant");
  assert.ok(assistant);
  const savedJson = JSON.stringify(assistant.parts);
  assert.equal(savedJson.includes("made-up-"), false, `saved parts leaked split key: ${savedJson}`);
  assert.equal(savedJson.includes("provider-key-0001"), false, `saved parts leaked split key: ${savedJson}`);
});

test("a credential split across reasoning deltas is masked in the live stream", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Clean title"),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "checking made-up-tavily-" },
          { type: "reasoning-delta", id: "r1", delta: "key-0002 now" },
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Done." },
          { type: "text-end", id: "t1" },
          finishChunk(),
        ],
      }),
    }),
  });
  const { raw, chunks } = await sendChat("c-split-reasoning", "hello", model);
  const reasoning = chunks.filter((c) => c.type === "reasoning-delta").map((c) => String(c.delta ?? "")).join("");
  assert.equal(reasoning, "checking [redacted] now");
  assert.equal(raw.includes("made-up-tavily-"), false, `stream leaked reasoning prefix: ${raw}`);
});

test("a credential split across tool-input deltas and in rejected tool input is masked in the live stream", async () => {
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Clean title"),
    doStream: async () => {
      step += 1;
      if (step === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "call-1", toolName: "render_ui" },
              { type: "tool-input-delta", id: "call-1", delta: '{"root":"r","elements":{"made-up-tavily-' },
              { type: "tool-input-delta", id: "call-1", delta: 'key-0002":{"type":"NotAComponent","props":{},"children":[]}}}' },
              { type: "tool-input-end", id: "call-1" },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "render_ui",
                input: JSON.stringify({ root: "r", elements: { [TAVILY_KEY]: { type: "NotAComponent", props: {}, children: [] } } }),
              },
              finishChunk("tool-calls"),
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Done." },
            { type: "text-end", id: "t1" },
            finishChunk(),
          ],
        }),
      };
    },
  });
  const { raw } = await sendChat("c-split-tool-input", "draw it", model);
  assert.equal(raw.includes(TAVILY_KEY), false, `stream leaked Tavily key: ${raw}`);
  assert.equal(raw.includes("made-up-tavily-"), false, `stream leaked tool-input prefix: ${raw}`);
});

test("a provider-executed tool error that skips onError leaves no credential of any length in the stream or saved reply", async () => {
  setCredentials({ apiKey: "sk-short9", tavilyApiKey: TAVILY_KEY, githubToken: GITHUB_TOKEN });
  try {
    const model = new MockLanguageModelV4({
      doGenerate: generateTitle("Clean title"),
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "p-1", toolName: "provider_search", input: JSON.stringify({ q: TAVILY_KEY }), providerExecuted: true },
            { type: "tool-result", toolCallId: "p-1", toolName: "provider_search", result: `upstream echoed sk-short9 and ${TAVILY_KEY}`, isError: true, providerExecuted: true },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Done." },
            { type: "text-end", id: "t1" },
            finishChunk(),
          ],
        }),
      }),
    });
    const { raw, chunks, saved } = await sendChat("c-provider-tool-error", "search", model);
    const toolErrors = chunks.filter((c) => c.type === "tool-output-error");
    assert.ok(toolErrors.length > 0, `expected tool-output-error chunk, got: ${raw}`);
    for (const chunk of toolErrors) {
      assert.equal(chunk.errorText, "[redacted]");
    }
    assert.equal(raw.includes("sk-short9"), false, `stream leaked short key: ${raw}`);
    assert.equal(raw.includes(TAVILY_KEY), false, `stream leaked Tavily key: ${raw}`);
    const savedJson = JSON.stringify(saved);
    assert.equal(savedJson.includes("sk-short9"), false, `saved reply leaked short key: ${savedJson}`);
    assert.equal(savedJson.includes(TAVILY_KEY), false, `saved reply leaked Tavily key: ${savedJson}`);
  } finally {
    setCredentials();
  }
});

test("the stream hold-back is bounded to longest key minus one and emits normal replies before the stream finishes", async () => {
  const gate = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Clean title"),
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          // Longest key is 25 chars (holdback = 24). Emitting 30 chars must flush the first 6 immediately.
          controller.enqueue({ type: "text-delta", id: "t1", delta: "alpha beta gamma delta epsilon" });
          await gate.promise;
          controller.enqueue({ type: "text-delta", id: "t1", delta: " zeta" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue(finishChunk());
          controller.close();
        },
      }),
    }),
  });
  const originalError = console.error;
  console.error = () => {};
  nextModel = () => model;
  try {
    const response = await route.POST(
      new Request("http://127.0.0.1/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "c-streaming",
          trigger: "submit-message",
          messages: [{ id: "c-streaming-u1", role: "user", parts: [{ type: "text", text: "stream please" }] }],
        }),
      }),
    );
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let seenBeforeRelease = "";
    while (!seenBeforeRelease.includes("alpha ")) {
      const next = await reader.read();
      assert.equal(next.done, false, "stream ended before emitting incremental text");
      seenBeforeRelease += decoder.decode(next.value, { stream: true });
    }
    const textBeforeRelease = parseSse(seenBeforeRelease)
      .filter((c) => c.type === "text-delta")
      .map((c) => String(c.delta ?? ""))
      .join("");
    assert.equal(textBeforeRelease, "alpha ");
    gate.resolve();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }
    const allText = parseSse(seenBeforeRelease + rest)
      .filter((c) => c.type === "text-delta")
      .map((c) => String(c.delta ?? ""))
      .join("");
    assert.equal(allText, "alpha beta gamma delta epsilon zeta");
    await Promise.allSettled(afterTasks.splice(0));
  } finally {
    gate.resolve();
    console.error = originalError;
  }
});

test("generated and fallback chat titles mask stored credentials, including keys clipped at the 80-character title limit", async () => {
  const generatedModel = new MockLanguageModelV4({
    doGenerate: generateTitle(`Debug ${PROVIDER_KEY}`),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Ok." },
          { type: "text-end", id: "t1" },
          finishChunk(),
        ],
      }),
    }),
  });
  const first = await sendChat("c-title-gen", "help me debug", generatedModel);
  assert.equal(first.title, "Debug [redacted]");

  const clippedModel = new MockLanguageModelV4({
    doGenerate: generateTitle(`${"word ".repeat(14)}${PROVIDER_KEY}`),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Ok." },
          { type: "text-end", id: "t1" },
          finishChunk(),
        ],
      }),
    }),
  });
  const clipped = await sendChat("c-title-clipped", "help me clip", clippedModel);
  assert.equal(clipped.title.includes("made-up"), false, `clipped title leaked prefix: ${clipped.title}`);

  const fallbackModel = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("title unavailable");
    },
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Ok." },
          { type: "text-end", id: "t1" },
          finishChunk(),
        ],
      }),
    }),
  });
  const fallback = await sendChat("c-title-fallback", `Check ${TAVILY_KEY} please`, fallbackModel);
  assert.equal(fallback.title, "Check [redacted] please");
});

test("a provider-executed tool error with only a long credential is withheld whole in both stream and saved parts", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Clean title"),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "p-long-1", toolName: "provider_search", input: JSON.stringify({ q: "ok" }), providerExecuted: true },
          {
            type: "tool-result",
            toolCallId: "p-long-1",
            toolName: "provider_search",
            result: `upstream failed for ${PROVIDER_KEY} with status 401`,
            isError: true,
            providerExecuted: true,
          },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Done." },
          { type: "text-end", id: "t1" },
          finishChunk(),
        ],
      }),
    }),
  });
  const { chunks, saved } = await sendChat("c-provider-tool-error-long", "search", model);
  const toolErrors = chunks.filter((c) => c.type === "tool-output-error");
  assert.ok(toolErrors.length > 0);
  for (const chunk of toolErrors) assert.equal(chunk.errorText, "[redacted]");
  const assistant = saved.find((m) => m.role === "assistant");
  assert.ok(assistant);
  const savedError = (assistant.parts as Array<Record<string, unknown>>).find((part) => typeof part.errorText === "string");
  assert.ok(savedError);
  assert.equal(savedError.errorText, "[redacted]");
});

test("incomplete unicode escapes, percent escapes, and escaped base64 split across deltas do not leak", async () => {
  const slashKey = "made-up-provider-key???";
  setCredentials({ apiKey: slashKey, tavilyApiKey: TAVILY_KEY, githubToken: GITHUB_TOKEN });
  try {
    const fullUnicode = [...slashKey].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const b64Escaped = Buffer.from(slashKey).toString("base64").replaceAll("/", "\\/");
    assert.ok(b64Escaped.includes("\\/"), "test key must encode a slash in base64");
    const slashSplit = b64Escaped.indexOf("\\/") + 1;
    const model = new MockLanguageModelV4({
      doGenerate: generateTitle("Clean title"),
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: `A:${fullUnicode.slice(0, -1)}` },
            { type: "text-delta", id: "t1", delta: `${fullUnicode.slice(-1)} B:${slashKey.slice(0, -1)}\\u003` },
            { type: "text-delta", id: "t1", delta: `f C:${slashKey.slice(0, -1)}%3` },
            { type: "text-delta", id: "t1", delta: `F D:${b64Escaped.slice(0, slashSplit)}` },
            { type: "text-delta", id: "t1", delta: `${b64Escaped.slice(slashSplit)} end.` },
            { type: "text-end", id: "t1" },
            finishChunk(),
          ],
        }),
      }),
    });
    const { raw, chunks } = await sendChat("c-split-escapes", "hello", model);
    const streamedText = chunks.filter((c) => c.type === "text-delta").map((c) => String(c.delta ?? "")).join("");
    assert.equal(streamedText, "A:[redacted] B:[redacted] C:[redacted] D:[redacted] end.");
    assert.equal(raw.includes("made-up-"), false, `stream leaked prefix: ${raw}`);
    assert.equal(raw.includes("\\u006d"), false, `stream leaked unicode prefix: ${raw}`);
  } finally {
    setCredentials();
  }
});

test("stream transform keeps chunk order around tool-output-denied and separates text ids", async () => {
  const { Redactor } = await import("@/lib/chat-errors");
  const { redactUIMessageStream } = await import("@/lib/chat-stream-redactor");
  const redactor = new Redactor({ apiKey: PROVIDER_KEY, tavilyApiKey: "", githubToken: "" });
  const input = simulateReadableStream({
    chunks: [
      { type: "text-start" as const, id: "t1" },
      { type: "text-delta" as const, id: "t1", delta: "hello" },
      { type: "text-end" as const, id: "t1" },
      { type: "tool-output-denied" as const, toolCallId: "call-1" },
      { type: "text-start" as const, id: "t2" },
      { type: "text-delta" as const, id: "t2", delta: "first" },
      { type: "text-delta" as const, id: "t3", delta: "second" },
      { type: "text-end" as const, id: "t3" },
    ],
  });
  const out: Array<Record<string, unknown>> = [];
  for await (const chunk of input.pipeThrough(redactUIMessageStream(redactor))) {
    out.push(chunk as Record<string, unknown>);
  }
  const endIndex = out.findIndex((c) => c.type === "text-end" && c.id === "t1");
  const deniedIndex = out.findIndex((c) => c.type === "tool-output-denied");
  assert.ok(endIndex >= 0 && deniedIndex > endIndex, `tool-output-denied overtook text-end: ${JSON.stringify(out)}`);
  const t3Delta = out.find((c) => c.type === "text-delta" && c.id === "t3");
  assert.equal(t3Delta?.delta, "second", `t3 delta was emitted under wrong id: ${JSON.stringify(out)}`);
});

test("misaligned Basic-auth base64 credentials are masked across text deltas, cross-part splits, and tool-input deltas", async () => {
  const { Redactor } = await import("@/lib/chat-errors");
  const redactor = new Redactor({ apiKey: PROVIDER_KEY, tavilyApiKey: TAVILY_KEY, githubToken: GITHUB_TOKEN });
  const basic = Buffer.from(`user:${PROVIDER_KEY}`).toString("base64");
  const fullText = `Authorization: Basic ${basic} ok`;
  const expectedText = redactor.text(fullText);
  const textChunks: Array<{ type: "text-delta"; id: string; delta: string }> = [];
  for (let i = 0; i < fullText.length; i += 4) {
    textChunks.push({ type: "text-delta", id: "t1", delta: fullText.slice(i, i + 4) });
  }
  const toolBasic = Buffer.from(`u:${TAVILY_KEY}`).toString("base64");
  const toolInput = JSON.stringify({ root: "r", elements: { [toolBasic]: { type: "NotAComponent", props: {}, children: [] } } });
  const toolDeltas: Array<{ type: "tool-input-delta"; id: string; delta: string }> = [];
  for (let i = 0; i < toolInput.length; i += 4) {
    toolDeltas.push({ type: "tool-input-delta", id: "call-b64", delta: toolInput.slice(i, i + 4) });
  }
  const splitAt = 10;
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Clean title"),
    doStream: async () => {
      step += 1;
      if (step === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "call-b64", toolName: "render_ui" },
              ...toolDeltas,
              { type: "tool-input-end", id: "call-b64" },
              { type: "tool-call", toolCallId: "call-b64", toolName: "render_ui", input: toolInput },
              finishChunk("tool-calls"),
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            ...textChunks,
            { type: "text-end", id: "t1" },
            { type: "text-start", id: "t2" },
            { type: "text-delta", id: "t2", delta: ` part:${basic.slice(0, splitAt)}` },
            { type: "text-end", id: "t2" },
            { type: "text-start", id: "t3" },
            { type: "text-delta", id: "t3", delta: `${basic.slice(splitAt)} end` },
            { type: "text-end", id: "t3" },
            finishChunk(),
          ],
        }),
      };
    },
  });
  const { raw, chunks } = await sendChat("c-basic-auth-stream", "hello", model);
  const t1Text = chunks.filter((c) => c.type === "text-delta" && c.id === "t1").map((c) => String(c.delta ?? "")).join("");
  assert.equal(t1Text, expectedText);
  const splitPartsText = chunks
    .filter((c) => c.type === "text-delta" && (c.id === "t2" || c.id === "t3"))
    .map((c) => String(c.delta ?? ""))
    .join("");
  assert.equal(splitPartsText, redactor.text(` part:${basic} end`));
  assert.equal(raw.includes(basic.slice(6)), false, `stream leaked Basic-auth suffix: ${raw}`);
  assert.equal(raw.includes(toolBasic.slice(3)), false, `tool-input-delta leaked Basic-auth suffix: ${raw}`);
});

test("start and message-metadata chunks do not overtake held text in the stream transform", async () => {
  const { Redactor } = await import("@/lib/chat-errors");
  const { redactUIMessageStream } = await import("@/lib/chat-stream-redactor");
  const redactor = new Redactor({ apiKey: PROVIDER_KEY, tavilyApiKey: "", githubToken: "" });
  const input = simulateReadableStream({
    chunks: [
      { type: "start" as const, messageId: "m1" },
      { type: "text-start" as const, id: "t1" },
      { type: "text-delta" as const, id: "t1", delta: "hello" },
      { type: "text-end" as const, id: "t1" },
      { type: "message-metadata" as const, messageMetadata: { note: `ref ${PROVIDER_KEY}` } },
      { type: "text-start" as const, id: "t2" },
      { type: "text-delta" as const, id: "t2", delta: "world" },
      { type: "text-end" as const, id: "t2" },
      { type: "start" as const, messageId: "m2" },
      { type: "finish" as const, finishReason: "stop" as const },
    ],
  });
  const out: Array<Record<string, unknown>> = [];
  for await (const chunk of input.pipeThrough(redactUIMessageStream(redactor))) {
    out.push(chunk as Record<string, unknown>);
  }
  assert.deepEqual(
    out.map((c) => c.type),
    ["start", "text-start", "text-delta", "text-end", "message-metadata", "text-start", "text-delta", "text-end", "start", "finish"],
  );
  const meta = out.find((c) => c.type === "message-metadata");
  assert.deepEqual(meta?.messageMetadata, { note: "ref [redacted]" });
});

test("reasoning-delta and text-delta providerMetadata survive POST /api/chat SSE with secrets masked", async () => {
  const { readUIMessageStream } = await import("ai");
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Clean title"),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "reasoning-start" as const, id: "r1" },
          {
            type: "reasoning-delta" as const,
            id: "r1",
            delta: `checking ${PROVIDER_KEY} now`,
            providerMetadata: { anthropic: { signature: "sig-e2e-1", debug: `key=${TAVILY_KEY}` } } as Record<string, Record<string, string>>,
          },
          {
            type: "reasoning-delta" as const,
            id: "r1",
            delta: "",
            providerMetadata: { anthropic: { signature: "sig-e2e-final", debug: `key=${TAVILY_KEY}` } } as Record<string, Record<string, string>>,
          },
          { type: "reasoning-end" as const, id: "r1" },
          { type: "text-start" as const, id: "t1" },
          {
            type: "text-delta" as const,
            id: "t1",
            delta: "Answer ready.",
            providerMetadata: { openai: { itemId: "msg-e2e-1", note: `tok=${GITHUB_TOKEN}` } } as Record<string, Record<string, string>>,
          },
          { type: "text-end" as const, id: "t1" },
          finishChunk(),
        ],
      }),
    }),
  });
  const { raw, chunks } = await sendChat("c-delta-provider-metadata", "think", model);
  assert.equal(raw.includes(PROVIDER_KEY), false, `SSE leaked provider key: ${raw}`);
  assert.equal(raw.includes(TAVILY_KEY), false, `SSE leaked tavily key: ${raw}`);
  assert.equal(raw.includes(GITHUB_TOKEN), false, `SSE leaked github token: ${raw}`);

  let latest;
  for await (const msg of readUIMessageStream({ stream: simulateReadableStream({ chunks: chunks as never[] }) })) {
    latest = msg;
  }
  assert.ok(latest);
  const reasoning = latest.parts.find((p) => p.type === "reasoning");
  const text = latest.parts.find((p) => p.type === "text");
  assert.ok(reasoning && reasoning.type === "reasoning");
  assert.ok(text && text.type === "text");
  assert.equal(reasoning.text, "checking [redacted] now");
  assert.deepEqual(reasoning.providerMetadata?.anthropic, { signature: "sig-e2e-final", debug: "key=[redacted]" });
  assert.equal(typeof reasoning.providerMetadata?.orbitTiming.startedAt, "number");
  assert.equal(typeof reasoning.providerMetadata?.orbitTiming.thoughtMs, "number");
  assert.equal(text.text, "Answer ready.");
  assert.deepEqual(text.providerMetadata, { openai: { itemId: "msg-e2e-1", note: "tok=[redacted]" } });
});

test("a disconnected response still saves the full reply", { timeout: 5_000 }, async (t) => {
  const chatId = "durable-disconnect";
  const first = "First words " + "more words ".repeat(40);
  const client = new AbortController();
  const tail = Promise.withResolvers<void>();
  t.after(() => tail.resolve());
  nextModel = () => new MockLanguageModelV4({
    doGenerate: generateTitle("Durable reply"),
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({ type: "text-delta", id: "text", delta: first });
          await tail.promise;
          controller.enqueue({ type: "text-delta", id: "text", delta: "last words " + PROVIDER_KEY });
          controller.enqueue({ type: "text-end", id: "text" });
          controller.enqueue(finishChunk());
          controller.close();
        },
      }),
    }),
  });
  const response = await route.POST(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    signal: client.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: chatId,
      messages: [{ id: "durable-disconnect-prompt", role: "user", parts: [{ type: "text", text: "Send the full reply." }] }],
    }),
  }));
  assert.equal(response.status, 200);
  const replyId = response.headers.get("x-resumable-stream-id");
  assert.ok(replyId);
  const context = { params: Promise.resolve({ id: chatId }) };
  const url = `http://127.0.0.1/api/chats/${chatId}/stream`;
  assert.equal((await replay(new Request(`${url}?replyId=wrong`), context)).status, 204);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "the first text must reach the browser before it disconnects");
    if (chunk.value?.includes("First words")) break;
  }
  const rejected = await route.POST(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    body: JSON.stringify({
      id: chatId,
      messages: [{ id: "busy-prompt", role: "user", parts: [{ type: "text", text: "Send an overlapping reply." }] }],
    }),
  }));
  assert.equal(rejected.status, 409);
  assert.equal(messages.listMessages(chatId).some((row) => row.id === "busy-prompt"), false);
  client.abort();
  const cancelled = reader.cancel();
  tail.resolve();
  await cancelled;
  await Promise.allSettled(afterTasks.splice(0));
  const rows = messages.listMessages(chatId).filter((row) => row.role === "assistant");
  assert.equal(rows.map((row) => messages.textFromParts(row.parts)).join(""), first + "last words [redacted]");

  const replayed = await replay(new Request(`${url}?replyId=${replyId}`), context);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.headers.get("x-resumable-stream-id"), replyId);
  const raw = await replayed.text();
  assert.equal(raw.includes(PROVIDER_KEY), false);
  assert.equal(parseSse(raw).filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join(""),
    first + "last words [redacted]");
});

test("stopping during reasoning saves its duration and streams the stopped marker before abort", { timeout: 5_000 }, async () => {
  const chatId = "durable-stop-thinking";
  const reasoning = "Consider the answer. ".repeat(30);
  nextModel = () => new MockLanguageModelV4({
    doGenerate: generateTitle("Stop during reasoning"),
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "reasoning-start", id: "r" });
          controller.enqueue({ type: "reasoning-delta", id: "r", delta: reasoning });
          abortSignal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      }),
    }),
  });
  const response = await route.POST(new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    body: JSON.stringify({
      id: chatId,
      messages: [{ id: "durable-stop-prompt", role: "user", parts: [{ type: "text", text: "Think about the answer." }] }],
    }),
  }));
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const context = { params: Promise.resolve({ id: chatId }) };
  const url = `http://127.0.0.1/api/chats/${chatId}/stop`;
  try {
    let raw = "";
    for (;;) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      raw += chunk.value;
      if (raw.includes("reasoning-delta")) break;
    }
    const stopped = await stop(new Request(url, { method: "POST" }), context);
    assert.deepEqual(await stopped.json(), { ok: true, stopped: true });
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += chunk.value;
    }
    const events = parseSse(raw);
    const endIndex = events.findIndex((chunk) => chunk.type === "data-reply-end");
    assert.ok(endIndex >= 0 && endIndex < events.findIndex((chunk) => chunk.type === "abort"));
    assert.deepEqual(events[endIndex].data, { reason: "stopped" });
    const parts = messages.listMessages(chatId).find((row) => row.role === "assistant")?.parts;
    const saved = parts?.find((part) => part.type === "reasoning");
    assert.equal(saved?.text, reasoning);
    assert.equal(typeof saved?.providerMetadata?.orbitTiming.thoughtMs, "number");
    assert.deepEqual(parts?.at(-1), { type: "data-reply-end", data: { reason: "stopped" } });
  } finally {
    await stop(new Request(url, { method: "POST" }), context);
    await reader.cancel();
    await Promise.allSettled(afterTasks.splice(0));
  }
});


test("a provider error during reasoning sends the same duration live, on replay, and after reload", async () => {
  const chatId = "durable-error-thinking";
  const reasoning = "Work out the answer.";
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Provider error during reasoning"),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r" },
          { type: "reasoning-delta", id: "r", delta: reasoning, providerMetadata: { mock: { signature: "test" } } },
          { type: "error", error: new Error("The provider stopped during reasoning.") },
        ],
      }),
    }),
  });
  const { chunks, saved, replyId } = await sendChat(chatId, "Think about the answer.", model);
  const parts = saved.find((row) => row.role === "assistant")?.parts;
  const stored = parts?.find((part) => part.type === "reasoning");
  assert.equal(stored?.text, reasoning);
  assert.ok(replyId);
  const url = `http://127.0.0.1/api/chats/${chatId}/stream?replyId=${replyId}`;
  const replayed = await replay(new Request(url), { params: Promise.resolve({ id: chatId }) });
  assert.equal(replayed.status, 200);
  assert.deepEqual(parseSse(await replayed.text()), chunks);
  const endIndex = chunks.findIndex((chunk) => chunk.type === "reasoning-end");
  assert.ok(endIndex >= 0, "live and replay streams must close reasoning before the error");
  assert.ok(endIndex < chunks.findIndex((chunk) => chunk.type === "error"));
  assert.equal(typeof stored?.providerMetadata?.orbitTiming.thoughtMs, "number");
  assert.deepEqual(chunks[endIndex].providerMetadata, stored?.providerMetadata);
  assert.deepEqual(parts?.at(-1), { type: "data-reply-end", data: { reason: "failed" } });
});


test("an OpenAI-compatible stream without a finish reason is saved and streamed as interrupted", async () => {
  const upstream = createOpenAICompatible({
    name: "mock",
    baseURL: "http://mock.invalid/v1",
    fetch: async () => new Response(
      'data: {"choices":[{"delta":{"content":"Partial answer."}}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  }).chatModel("mock");
  const model = new MockLanguageModelV4({
    doGenerate: generateTitle("Partial answer"),
    doStream: (options) => upstream.doStream(options),
  });
  const { chunks, saved } = await sendChat("durable-missing-finish", "Send the answer.", model);
  const parts = saved.find((row) => row.role === "assistant")?.parts;
  assert.deepEqual({
    text: parts && messages.textFromParts(parts),
    savedEnd: parts?.at(-1),
    wireEnding: chunks.filter((chunk) => chunk.type === "finish" || chunk.type === "error" || chunk.type === "data-reply-end").map((chunk) => chunk.type),
  }, {
    text: "Partial answer.",
    savedEnd: { type: "data-reply-end", data: { reason: "failed" } },
    wireEnding: ["data-reply-end", "error"],
  });
});
