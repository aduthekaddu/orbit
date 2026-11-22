import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { generateText } from "ai";
import {
  credentialsForModelList,
  listModels,
  MODEL_META_TTL_MS,
  modelAllowsReasoning,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODELS_URL,
  orbitModel,
  outboundSessionHeader,
  reasoningAllowed,
  reasoningOptions,
} from "./provider";

const savedBaseUrl = "https://saved.example/v1";
const savedApiKey = "saved-secret";

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

// The model metadata cache is module state, so each test lists models for its own host.
function mockFetch(t: TestContext, respond: (url: string, init?: RequestInit) => Response) {
  return t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => respond(String(input), init));
}

test("the saved key is not reused for a different base URL", () => {
  const credentials = credentialsForModelList({
    requestedBaseUrl: "https://evil.example/v1",
    requestedApiKey: "  ",
    savedBaseUrl,
    savedApiKey,
  });
  assert.equal(credentials, null);
});

test("the same base URL with a trailing slash reuses the saved key", () => {
  const credentials = credentialsForModelList({ requestedBaseUrl: `${savedBaseUrl}/`, savedBaseUrl, savedApiKey });
  assert.deepEqual(credentials, { baseUrl: `${savedBaseUrl}/`, apiKey: savedApiKey });
});

test("the typed key is kept for an edited base URL", () => {
  const credentials = credentialsForModelList({
    requestedBaseUrl: "https://evil.example/v1",
    requestedApiKey: "typed-key",
    savedBaseUrl,
    savedApiKey,
  });
  assert.deepEqual(credentials, { baseUrl: "https://evil.example/v1", apiKey: "typed-key" });
});

test("an omitted base URL uses the saved provider", () => {
  assert.deepEqual(credentialsForModelList({ savedBaseUrl, savedApiKey }), { baseUrl: savedBaseUrl, apiKey: savedApiKey });
});

async function listReasoningModels(t: TestContext, host: string) {
  const base = `https://${host}/v1`;
  const fetch = mockFetch(t, (url) =>
    url === `${base}/models`
      ? json([
          { id: "plain", capabilities: { reasoning: false } },
          { id: "thinker", capabilities: { reasoning: true } },
        ])
      : json({ error: "unexpected" }, 500),
  );
  const listed = await listModels(`${base}/`, savedApiKey);
  return { base, fetch, listed };
}

test("a cold chat allows reasoning without discovering models", (t) => {
  const fetch = mockFetch(t, () => json({ error: "unexpected" }, 500));
  assert.equal(modelAllowsReasoning("https://cold.example/v1", "plain"), true);
  assert.equal(fetch.mock.callCount(), 0);
});

test("the model list returns the provider models", async (t) => {
  const { listed } = await listReasoningModels(t, "list.example");
  assert.deepEqual(listed?.map((model) => model.id), ["plain", "thinker"]);
});

test("a listed model's reasoning flag is cached for chat", async (t) => {
  const { base } = await listReasoningModels(t, "cached.example");
  assert.equal(modelAllowsReasoning(base, "plain"), false);
  assert.equal(modelAllowsReasoning(base, "thinker"), true);
  assert.equal(modelAllowsReasoning(base, "missing"), true);
});

test("a warm chat does not discover models", async (t) => {
  const { base, fetch } = await listReasoningModels(t, "warm.example");
  const afterList = fetch.mock.callCount();
  modelAllowsReasoning(base, "plain");
  modelAllowsReasoning(base, "thinker");
  modelAllowsReasoning(base, "missing");
  assert.equal(fetch.mock.callCount(), afterList);
});

test("expired metadata allows reasoning and is not refreshed on the chat path", async (t) => {
  const { base, fetch } = await listReasoningModels(t, "expired.example");
  const afterList = fetch.mock.callCount();
  assert.equal(modelAllowsReasoning(base, "plain", Date.now() + MODEL_META_TTL_MS + 1000), true);
  assert.equal(fetch.mock.callCount(), afterList);
});

test("a throwing OpenCode primary falls back to the Go model list with the saved key", async (t) => {
  const fetch = mockFetch(t, (url) => {
    if (url === `${OPENCODE_GO_BASE_URL}/models`) throw new Error("primary down");
    if (url === OPENCODE_GO_MODELS_URL) return json([{ id: "from-fallback", capabilities: { reasoning: false } }]);
    return json({ error: "unexpected" }, 500);
  });
  const listed = await listModels(OPENCODE_GO_BASE_URL, savedApiKey);
  assert.deepEqual(listed?.map((model) => model.id), ["from-fallback"]);
  const requests = fetch.mock.calls.map((call) => ({
    url: String(call.arguments[0]),
    authorization: new Headers(call.arguments[1]?.headers).get("authorization"),
  }));
  assert.deepEqual(requests, [
    { url: `${OPENCODE_GO_BASE_URL}/models`, authorization: `Bearer ${savedApiKey}` },
    { url: OPENCODE_GO_MODELS_URL, authorization: `Bearer ${savedApiKey}` },
  ]);
  assert.equal(modelAllowsReasoning(OPENCODE_GO_BASE_URL, "from-fallback"), false);
});

test("a throwing model list for another provider returns null", async (t) => {
  const base = "https://other.example/v1";
  const fetch = mockFetch(t, () => {
    throw new Error("down");
  });
  assert.equal(await listModels(base, savedApiKey), null);
  assert.deepEqual(fetch.mock.calls.map((c) => String(c.arguments[0])), [`${base}/models`]);
});

test("a model list that answers with an error status returns null", async (t) => {
  const base = "https://denied.example/v1";
  const fetch = mockFetch(t, () => json({ error: "unauthorized" }, 401));
  assert.equal(await listModels(base, savedApiKey), null);
  assert.deepEqual(fetch.mock.calls.map((c) => String(c.arguments[0])), [`${base}/models`]);
});

const payloads = [
  {
    shape: "a { data } body",
    body: { data: [{ id: "b" }, { id: "a", capabilities: { reasoning: false } }] },
    models: [
      { id: "a", reasoning: false },
      { id: "b", reasoning: null },
    ],
  },
  { shape: "a { models } body", body: { models: [{ id: "m", reasoning: true }] }, models: [{ id: "m", reasoning: true }] },
  { shape: "plain string ids", body: ["plain-id"], models: [{ id: "plain-id", reasoning: null }] },
  { shape: "a name in place of an id", body: [{ name: "named" }], models: [{ id: "named", reasoning: null }] },
  { shape: "an empty { data } body", body: { data: [] }, models: [] },
];

for (const [index, { shape, body, models }] of payloads.entries()) {
  test(`the model list reads ${shape}`, async (t) => {
    const base = `https://payload-${index}.example/v1`;
    const fetch = mockFetch(t, (url) => (url === `${base}/models` ? json(body) : json({ error: "unexpected" }, 500)));
    assert.deepEqual(await listModels(base, savedApiKey), models);
    assert.deepEqual(fetch.mock.calls.map((c) => String(c.arguments[0])), [`${base}/models`]);
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
  const model = orbitModel({
    baseUrl,
    apiKey: "test",
    model: "test-model",
    chatId: "chat-1",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return respond(bodies.length);
    },
  });
  return { model, bodies };
}

test("the reasoning effort reaches the provider", async () => {
  const { model, bodies } = recordingModel("https://effort.example/v1", () => chatReply());
  await generateText({ model, prompt: "ping", maxRetries: 0, ...reasoningOptions("low") });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].reasoning_effort, "low");
});

test("a provider that rejects reasoning_effort gets the request again without it", async () => {
  const { model, bodies } = recordingModel("https://no-reasoning.example/v1", (attempt) =>
    attempt === 1 ? json({ error: { message: "reasoning_effort is not supported" } }, 400) : chatReply(),
  );
  const result = await generateText({ model, prompt: "ping", maxRetries: 0, ...reasoningOptions("high") });
  assert.equal(result.text, "ok");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning_effort, "high");
  assert.equal("reasoning_effort" in bodies[1], false);
});

test("an error unrelated to reasoning is not sent again", async () => {
  const { model, bodies } = recordingModel("https://too-long.example/v1", () =>
    json({ error: { message: "context length exceeded" } }, 400),
  );
  await assert.rejects(generateText({ model, prompt: "ping", maxRetries: 0, ...reasoningOptions("high") }));
  assert.equal(bodies.length, 1);
});
