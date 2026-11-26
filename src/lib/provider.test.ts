import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "ai";
import type { ProviderConnection } from "./connections";
import { effortCallOptions } from "./effort";
import { languageModelFor, OPENCODE_GO_BASE_URL, orbitModel, outboundSessionHeader, reasoningAllowed } from "./provider";

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

test("reasoning metadata that says no turns reasoning off", () => {
  assert.equal(reasoningAllowed({ capabilities: { reasoning: false } }), false);
  assert.equal(reasoningAllowed({ capabilities: { reasoning: { supported: false } } }), false);
  assert.equal(reasoningAllowed({ reasoning: false }), false);
});

test("missing or positive reasoning metadata keeps reasoning on", () => {
  assert.equal(reasoningAllowed({ id: "plain" }), true);
  assert.equal(reasoningAllowed({ capabilities: { reasoning: { supported: true, effort: ["max"] } } }), true);
  assert.equal(reasoningAllowed({ reasoning: true }), true);
  assert.equal(reasoningAllowed(null), true);
});

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
});

test("a provider that rejects reasoning_effort gets the request again without it, and the drop is reported", async () => {
  const { model, bodies, drops } = recordingModel("https://no-reasoning.example/v1", (attempt) =>
    attempt === 1 ? json({ error: { message: "reasoning_effort is not supported" } }, 400) : chatReply(),
  );
  const result = await generateText({ model, prompt: "ping", maxRetries: 0, ...effort("high") });
  assert.equal(result.text, "ok");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning_effort, "high");
  assert.equal("reasoning_effort" in bodies[1], false);
  assert.deepEqual(drops, [1]);
});

test("an error unrelated to reasoning is not sent again", async () => {
  const { model, bodies, drops } = recordingModel("https://too-long.example/v1", () =>
    json({ error: { message: "context length exceeded" } }, 400),
  );
  await assert.rejects(generateText({ model, prompt: "ping", maxRetries: 0, ...effort("high") }));
  assert.equal(bodies.length, 1);
  assert.deepEqual(drops, []);
});

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
    const result = await generateText({ model, prompt: "ping", maxRetries: 0, ...effortCallOptions("anthropic", "high", ["low", "medium", "high"]).options });
    assert.equal(result.text, "ok");
    assert.equal(seen.length, 1);
    const [request] = seen;
    assert.equal(request.url, "http://127.0.0.1:9/v1/messages");
    assert.equal(request.headers.get("x-api-key"), "made-up-anthropic-key-0001");
    assert.equal(request.headers.get("authorization"), null);
    assert.match(request.headers.get("anthropic-beta") ?? "", /thinking-binding-controls-2026-08-01/);
    assert.deepEqual(request.body.output_config, { effort: "high" });
    assert.deepEqual(request.body.thinking, { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    assert.deepEqual(request.body.cache_control, { type: "ephemeral" });
  } finally {
    if (original === undefined) delete process.env.ORBIT_ANTHROPIC_BASE_URL;
    else process.env.ORBIT_ANTHROPIC_BASE_URL = original;
  }
});
