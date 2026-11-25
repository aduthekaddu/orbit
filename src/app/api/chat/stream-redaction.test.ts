import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

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
let messages: typeof import("@/lib/messages");
let saveSettings: typeof import("@/lib/settings").saveSettings;
let db: typeof import("@/lib/db").db;
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

  ({ db } = await import("@/lib/db"));
  const schema = await import("@/lib/db/schema");
  ({ saveSettings } = await import("@/lib/settings"));
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Stream", email: "stream@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  setCredentials();
  messages = await import("@/lib/messages");
  route = await import("./route");
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
    const titleRow = db.$client.prepare<[string], { title: string }>("select title from chats where id = ?").get(chatId);
    return { raw, chunks: parseSse(raw), saved, title: titleRow?.title ?? "" };
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
