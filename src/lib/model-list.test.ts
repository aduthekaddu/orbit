import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import type { ProviderConnection } from "./connections";
import { EFFORTS, effortLevels, type Effort } from "./effort";
import { cachedCaps, listModels, type ListedModel } from "./model-list";

type Seen = { path: string; params: URLSearchParams; headers: http.IncomingHttpHeaders };

const ANTHROPIC_KEY = "anthropic-made-up-key-0001";
const seen: Seen[] = [];
let server: http.Server;
let base = "";
const originalAnthropicBase = process.env.ORBIT_ANTHROPIC_BASE_URL;

function claude(id: string, name: string, context: number, options: { efforts: string[]; canTurnOffThinking: boolean; budgetThinking?: boolean }) {
  const levels = ["low", "medium", "high", "xhigh", "max"];
  return {
    type: "model",
    id,
    display_name: name,
    created_at: "2026-10-01T00:00:00Z",
    max_input_tokens: context,
    max_tokens: 128000,
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: {
        supported: true,
        types: {
          adaptive: { supported: !options.budgetThinking },
          enabled: { supported: Boolean(options.budgetThinking) },
          disabled: { supported: options.canTurnOffThinking },
        },
      },
      effort: { supported: options.efforts.length > 0, ...Object.fromEntries(levels.map((level) => [level, { supported: options.efforts.includes(level) }])) },
    },
  };
}

const CLAUDE_PAGES: Record<string, object> = {
  first: {
    data: [
      claude("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, { efforts: ["low", "medium", "high", "xhigh", "max"], canTurnOffThinking: false }),
      claude("claude-opus-5", "Claude Opus 5", 1_000_000, { efforts: ["low", "medium", "high", "xhigh", "max"], canTurnOffThinking: true }),
    ],
    has_more: true,
    first_id: "claude-opus-5-5",
    last_id: "claude-opus-5",
  },
  "claude-opus-5": {
    data: [claude("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, { efforts: [], canTurnOffThinking: true, budgetThinking: true })],
    has_more: false,
    first_id: "claude-haiku-4-5",
    last_id: "claude-haiku-4-5",
  },
};

const OPENAI_LISTS: Record<string, object | null> = {
  "Bearer router-key": {
    object: "list",
    data: [
      {
        id: "router/reasoner",
        name: "Router Reasoner",
        context_length: 131072,
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["max_tokens", "tools", "reasoning"],
      },
      { id: "window-model", context_window: 32768 },
      { id: "plain-model" },
      { id: "no-reasoning", capabilities: { reasoning: false } },
    ],
  },
  "Bearer key-a": { object: "list", data: [{ id: "shared-model", capabilities: { reasoning: false } }] },
  "Bearer key-b": { object: "list", data: [{ id: "shared-model", supported_parameters: ["reasoning"], context_length: 8192 }] },
  "Bearer empty-key": { object: "list", data: [] },
  "Bearer failing-key": null,
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    seen.push({ path: url.pathname, params: url.searchParams, headers: req.headers });
    if (url.pathname !== "/v1/models") {
      res.writeHead(404).end();
      return;
    }
    const payload = req.headers["anthropic-version"]
      ? req.headers["x-api-key"] === ANTHROPIC_KEY ? CLAUDE_PAGES[url.searchParams.get("after_id") ?? "first"] : null
      : OPENAI_LISTS[String(req.headers.authorization)];
    if (!payload) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "fixture failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ORBIT_ANTHROPIC_BASE_URL = `${base}/v1`;
});

after(async () => {
  if (originalAnthropicBase === undefined) delete process.env.ORBIT_ANTHROPIC_BASE_URL;
  else process.env.ORBIT_ANTHROPIC_BASE_URL = originalAnthropicBase;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function openai(id: string): ProviderConnection {
  return { id, userId: "u-models", kind: "openai-compatible", label: "Fixture", baseUrl: `${base}/v1`, createdAt: new Date() };
}

function anthropic(id: string): ProviderConnection {
  return { id, userId: "u-models", kind: "anthropic", label: "Claude", createdAt: new Date() };
}

function byId(models: ListedModel[] | null, id: string) {
  assert.ok(models, "the list loaded");
  const model = models.find((entry) => entry.id === id);
  assert.ok(model, `${id} is listed: ${models.map((entry) => entry.id).join(", ")}`);
  return model;
}

function inEffortOrder(levels: readonly Effort[] | null) {
  return levels === null ? null : [...levels].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
}

test("an Anthropic model list parses into context, images, and effort levels, following every page", async () => {
  const from = seen.length;
  const models = await listModels(anthropic("conn-claude"), ANTHROPIC_KEY);
  assert.deepEqual(models?.map((model: ListedModel) => model.id).sort(), ["claude-haiku-4-5", "claude-opus-5", "claude-opus-5-5"]);

  const opus = byId(models, "claude-opus-5-5");
  assert.equal(opus.label, "Claude Opus 5.5");
  assert.deepEqual({ ...opus.caps, efforts: inEffortOrder(opus.caps.efforts) }, {
    images: true,
    tools: true,
    reasoning: true,
    contextTokens: 1_000_000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  });
  assert.deepEqual(inEffortOrder(byId(models, "claude-opus-5").caps.efforts), ["none", "low", "medium", "high", "xhigh", "max"]);
  const haiku = byId(models, "claude-haiku-4-5");
  assert.equal(haiku.caps.contextTokens, 200_000);
  assert.deepEqual(haiku.caps.efforts, ["none"], "Haiku 4.5 takes no effort level and can turn thinking off");

  const requests = seen.slice(from);
  assert.deepEqual(requests.map((request) => request.path), ["/v1/models", "/v1/models"]);
  assert.equal(requests[0].params.get("limit"), "1000");
  assert.equal(requests[0].params.has("after_id"), false);
  assert.equal(requests[1].params.get("after_id"), "claude-opus-5");
  for (const request of requests) {
    assert.equal(request.headers["x-api-key"], ANTHROPIC_KEY);
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers.authorization, undefined, "the Anthropic key goes in x-api-key only");
  }
});

test("None is disabled for claude-opus-5-5, whose list entry says thinking cannot be turned off", async () => {
  const models = await listModels(anthropic("conn-claude-levels"), ANTHROPIC_KEY);
  const levels = effortLevels("anthropic", byId(models, "claude-opus-5-5").caps);
  assert.ok(levels);
  assert.equal(levels.includes("none"), false);
  assert.equal(effortLevels("anthropic", byId(models, "claude-opus-5").caps)?.includes("none"), true);
});

test("an OpenRouter-style entry gets its badges, and a capability the list does not name stays unknown", async () => {
  const from = seen.length;
  const models = await listModels(openai("conn-router"), "router-key");
  assert.deepEqual(byId(models, "router/reasoner").caps, { images: true, tools: true, reasoning: true, contextTokens: 131072, efforts: null });
  assert.equal(byId(models, "window-model").caps.contextTokens, 32768);
  assert.deepEqual(byId(models, "plain-model").caps, { images: null, tools: null, reasoning: null, contextTokens: null, efforts: null });
  assert.equal(byId(models, "no-reasoning").caps.reasoning, false);
  assert.deepEqual(effortLevels("openai-compatible", byId(models, "no-reasoning").caps), []);
  const request = seen.slice(from).find((entry) => entry.path === "/v1/models");
  assert.equal(request?.headers.authorization, "Bearer router-key");
  assert.equal(request?.headers["x-api-key"], undefined);
});

test("two connections with the same base URL keep separate cached caps", async () => {
  await listModels(openai("conn-a"), "key-a");
  await listModels(openai("conn-b"), "key-b");
  assert.equal(cachedCaps("conn-a", "shared-model")?.reasoning, false);
  assert.equal(cachedCaps("conn-b", "shared-model")?.reasoning, true);
  assert.equal(cachedCaps("conn-b", "shared-model")?.contextTokens, 8192);
});

test("a cache miss answers with no caps and sends no model-list request", async () => {
  const from = seen.length;
  assert.equal(cachedCaps("conn-never-listed", "shared-model"), null);
  assert.equal(cachedCaps("conn-a", "not-in-the-list"), null);
  await listModels(openai("conn-sentinel"), "empty-key");
  assert.deepEqual(
    seen.slice(from).map((request) => request.headers.authorization),
    ["Bearer empty-key"],
    "only the sentinel listing reached the provider",
  );
});

test("a list that fails is null, and a provider with no models is an empty list", async () => {
  assert.equal(await listModels(openai("conn-failing"), "failing-key"), null);
  assert.equal(await listModels(anthropic("conn-claude-bad-key"), "wrong-anthropic-key"), null);
  assert.deepEqual(await listModels(openai("conn-empty"), "empty-key"), []);
});
