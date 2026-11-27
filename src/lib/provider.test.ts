import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "ai";
import type { ProviderConnection } from "./connections";
import { effortCallOptions } from "./effort";
import { languageModelFor, OPENCODE_GO_BASE_URL, orbitModel, outboundSessionHeader } from "./provider";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chatReply() {
  return json({
    id: "test",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

test("the OpenCode session header goes only to OpenCode", async () => {
  assert.equal(await outboundSessionHeader(OPENCODE_GO_BASE_URL, "chat-1"), "chat-1");
  assert.equal(await outboundSessionHeader("https://example.com/v1", "chat-1"), null);
});

function recordingModel(baseUrl: string, respond: (attempt: number) => Response) {
  const bodies: Record<string, unknown>[] = [];
  const drops: number[] = [];
  const model = orbitModel({
    baseUrl,
    apiKey: "test",
    model: "test-model",
    chatId: "chat-1",
    onDropped: () => drops.push(bodies.length),
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return respond(bodies.length);
    },
  });
  return { model, bodies, drops };
}

const effort = (level: "low" | "high") => effortCallOptions("openai-compatible", level, null).options;

test("the reasoning effort reaches the provider", async () => {
  const { model, bodies } = recordingModel("https://effort.example/v1", () => chatReply());
  await generateText({ model, prompt: "ping", maxRetries: 0, ...effort("low") });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal(bodies[0].fallbacks, undefined);
});

for (const status of [400, 422]) {
  test(`HTTP ${status} rejecting reasoning_effort triggers one retry without it`, async () => {
    const { model, bodies, drops } = recordingModel("https://no-reasoning.example/v1", (attempt) =>
      attempt === 1 ? json({ error: { message: "reasoning_effort is not supported" } }, status) : chatReply(),
    );
    const result = await generateText({ model, prompt: "ping", maxRetries: 0, ...effort("high") });
    assert.equal(result.text, "ok");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].reasoning_effort, "high");
    assert.equal("reasoning_effort" in bodies[1], false);
    assert.deepEqual(drops, [2], "the drop is reported once, after the retry succeeded");
  });
}

test("a retry without reasoning_effort that fails reports no drop, so the SDK's later retry with the effort reads as applied", async () => {
  const { model, bodies, drops } = recordingModel("https://flaky-reasoning.example/v1", (attempt) => {
    if (attempt === 1) return json({ error: { message: "reasoning_effort is not supported" } }, 400);
    if (attempt === 2) return new Response(JSON.stringify({ error: { message: "upstream busy" } }), { status: 503, headers: { "content-type": "application/json", "retry-after-ms": "0" } });
    return chatReply();
  });
  const result = await generateText({ model, prompt: "ping", maxRetries: 1, ...effort("high") });
  assert.equal(result.text, "ok");
  assert.deepEqual(bodies.map((body) => body.reasoning_effort ?? null), ["high", null, "high"]);
  assert.deepEqual(drops, []);
});

test("an error unrelated to reasoning is not sent again", async () => {
  const { model, bodies, drops } = recordingModel("https://too-long.example/v1", () =>
    json({ error: { message: "context length exceeded" } }, 400),
  );
  await assert.rejects(generateText({ model, prompt: "ping", maxRetries: 0, ...effort("high") }));
  assert.equal(bodies.length, 1);
  assert.deepEqual(drops, []);
});

test("reasoning words in the prompt do not cause a fallback retry", async () => {
  const { model, bodies, drops } = recordingModel("https://no-reasoning.example/v1", (attempt) =>
    attempt === 1 ? json({ error: { message: "bad reasoning prompt" } }, 400) : chatReply(),
  );
  await assert.rejects(generateText({ model, prompt: "Explain reasoning_effort", maxRetries: 0 }));
  assert.equal(bodies.length, 1);
  assert.deepEqual(drops, []);
});

for (const status of [429, 503]) {
  test(`HTTP ${status} preserves the requested effort for the SDK retry`, async () => {
    const { model, bodies, drops } = recordingModel("https://busy.example/v1", (attempt) =>
      attempt === 1 ? json({ error: { message: "reasoning backend overloaded" } }, status) : chatReply(),
    );
    await assert.rejects(generateText({ model, prompt: "ping", maxRetries: 0, ...effort("high") }));
    assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["high"]);
    assert.deepEqual(drops, []);
  });
}

test("an Anthropic connection sends effort, summarized adaptive thinking that drops a mismatched block, and prompt caching", async () => {
  const original = process.env.ORBIT_ANTHROPIC_BASE_URL;
  process.env.ORBIT_ANTHROPIC_BASE_URL = "http://127.0.0.1:9/v1";
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  try {
    const connection: ProviderConnection = { id: "conn-claude", userId: "u", kind: "anthropic", label: "Claude", createdAt: new Date() };
    const model = languageModelFor({
      connection,
      apiKey: "made-up-anthropic-key-0001",
      model: "claude-opus-5-5",
      chatId: "chat-1",
      fetch: async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const result = await generateText({ model, prompt: "ping", maxRetries: 0, ...effortCallOptions("anthropic", "high", ["low", "medium", "high"], true).options });
    assert.equal(result.text, "ok");
    assert.equal(seen.length, 1);
    const [request] = seen;
    assert.equal(request.url, "http://127.0.0.1:9/v1/messages");
    assert.equal(request.headers.get("x-api-key"), "made-up-anthropic-key-0001");
    assert.equal(request.headers.get("authorization"), null);
    assert.match(request.headers.get("anthropic-beta") ?? "", /thinking-binding-controls-2026-08-01/);
    assert.match(request.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
    assert.equal(request.body.fallbacks, "default");
    assert.deepEqual(request.body.output_config, { effort: "high" });
    assert.deepEqual(request.body.thinking, { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    assert.deepEqual(request.body.cache_control, { type: "ephemeral" });
  } finally {
    if (original === undefined) delete process.env.ORBIT_ANTHROPIC_BASE_URL;
    else process.env.ORBIT_ANTHROPIC_BASE_URL = original;
  }
});
