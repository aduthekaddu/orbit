import assert from "node:assert/strict";
import test from "node:test";
import { requestJson, type Loaded } from "./request-json";
import { appliedSave, connectionFrom, modelListBody, type ModelList, type SettingsSnapshot } from "./settings-form";

const submitted: SettingsSnapshot = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-old",
  model: "gpt-4",
  effort: "medium",
  searxngUrl: "http://127.0.0.1:8888",
  tavilyApiKey: "test-tavily-key-not-real",
  githubToken: "",
  githubMcpUrl: "https://api.githubcopilot.com/mcp/",
};

test("unchanged values clear the key and report saved", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted }), {
    clearKey: true,
    clearTavilyKey: true,
    clearGithubToken: true,
    applyKeySet: true,
    saved: true,
  });
});

test("a key typed during the save stays in the field", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, apiKey: "sk-new" }), {
    clearKey: false,
    clearTavilyKey: true,
    clearGithubToken: true,
    applyKeySet: true,
    saved: false,
  });
});

test("a base URL changed during the save keeps the previous keySet", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, baseUrl: "https://other.example.com/v1" }), {
    clearKey: true,
    clearTavilyKey: true,
    clearGithubToken: true,
    applyKeySet: false,
    saved: false,
  });
});

test("a model changed during the save is not reported as saved", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, model: "gpt-5" }), {
    clearKey: true,
    clearTavilyKey: true,
    clearGithubToken: true,
    applyKeySet: true,
    saved: false,
  });
});

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// Runs the settings page's model request against a canned answer and returns the status the page shows.
async function connectionFor(answer: () => Promise<Response>, hasKey = true) {
  globalThis.fetch = answer;
  let load: Loaded<ModelList> = { status: "pending" };
  await requestJson("/api/models", { method: "POST" }, {
    parse: modelListBody(hasKey),
    onOk: (data) => (load = { status: "done", data }),
    onFailed: (failure) => (load = { status: "failed", failure }),
  });
  return connectionFrom(load);
}

const json = (body: unknown, status = 200) => async () => Response.json(body, { status });

test("an empty model list without a key stays idle", async () => {
  assert.deepEqual(await connectionFor(json({ models: [] }), false), { status: "idle" });
});

test("a model list from the provider is connected", async () => {
  const models = [{ id: "gpt-4", reasoning: null }];
  assert.deepEqual(await connectionFor(json({ models })), { status: "connected", models });
});

test("an unreachable provider is failed", async () => {
  assert.deepEqual(await connectionFor(json({ error: "Could not reach the provider.", models: [] }, 502)), { status: "failed" });
});

test("a not-configured request without a key stays idle", async () => {
  assert.deepEqual(await connectionFor(json({ error: "Add a base URL and key.", models: [] }, 400), false), { status: "idle" });
});

test("a not-configured request for a new base URL with only the saved key stays idle", async () => {
  assert.deepEqual(await connectionFor(json({ error: "Add a base URL and key.", models: [] }, 400), true), { status: "idle" });
});

test("a model list 400 that is not the not-configured answer is failed", async () => {
  assert.deepEqual(await connectionFor(json({ error: "Invalid model request" }, 400)), { status: "failed" });
  const proxy = async () => new Response("<html>400 Bad Request</html>", { status: 400, headers: { "content-type": "text/html" } });
  assert.deepEqual(await connectionFor(proxy), { status: "failed" });
});

test("a model list that is not JSON is failed, not 0 models", async () => {
  const html = async () => new Response("<html>502 Bad Gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
  assert.deepEqual(await connectionFor(html), { status: "failed" });
});

test("a model list request that fails on the network is failed", async () => {
  const offline = async (): Promise<Response> => {
    throw new TypeError("Failed to fetch");
  };
  assert.deepEqual(await connectionFor(offline), { status: "failed" });
});

test("a model list still loading is checking", () => {
  assert.deepEqual(connectionFrom({ status: "pending" }), { status: "checking" });
});

test("a Tavily key typed during save remains in the field", () => {
  const applied = appliedSave(submitted, { ...submitted, tavilyApiKey: "new-test-key" });
  assert.equal(applied.clearTavilyKey, false);
  assert.equal(applied.saved, false);
});

test("a search URL edited during save is not reported as saved", () => {
  assert.equal(appliedSave(submitted, { ...submitted, searxngUrl: "http://127.0.0.1:9999" }).saved, false);
});

test("a GitHub token typed during save stays in the field", () => {
  const applied = appliedSave(submitted, { ...submitted, githubToken: "typed-during-save" });
  assert.equal(applied.clearGithubToken, false);
  assert.equal(applied.saved, false);
});

test("a GitHub MCP URL edited during save is not reported as saved", () => {
  assert.equal(appliedSave(submitted, { ...submitted, githubMcpUrl: "http://127.0.0.1:9/mcp" }).saved, false);
});

test("a key typed during a removal save stays in the field", () => {
  const removal = { ...submitted, tavilyApiKey: null };
  const applied = appliedSave(removal, { ...submitted, tavilyApiKey: "new-test-key" });
  assert.equal(applied.clearTavilyKey, false);
  assert.equal(applied.saved, false);
});
