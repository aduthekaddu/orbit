import assert from "node:assert/strict";
import test from "node:test";
import { appliedSave, connectionFromResponse, type SettingsSnapshot } from "./settings-form";

const submitted: SettingsSnapshot = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-old",
  model: "gpt-4",
  effort: "medium",
  searxngUrl: "http://127.0.0.1:8888",
  tavilyApiKey: "test-tavily-key-not-real",
};

test("unchanged values clear the key and report saved", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted }), {
    clearKey: true,
    clearTavilyKey: true,
    applyKeySet: true,
    saved: true,
  });
});

test("a key typed during the save stays in the field", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, apiKey: "sk-new" }), {
    clearKey: false,
    clearTavilyKey: true,
    applyKeySet: true,
    saved: false,
  });
});

test("a base URL changed during the save keeps the previous keySet", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, baseUrl: "https://other.example.com/v1" }), {
    clearKey: true,
    clearTavilyKey: true,
    applyKeySet: false,
    saved: false,
  });
});

test("a model changed during the save is not reported as saved", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, model: "gpt-5" }), {
    clearKey: true,
    clearTavilyKey: true,
    applyKeySet: true,
    saved: false,
  });
});

test("an empty model list without a key stays idle", () => {
  assert.deepEqual(connectionFromResponse({ ok: true, status: 200 }, { models: [] }, false), { status: "idle" });
});

test("a model list from the provider is connected", () => {
  const models = [{ id: "gpt-4", reasoning: null }];
  assert.deepEqual(connectionFromResponse({ ok: true, status: 200 }, { models }, true), { status: "connected", models });
});

test("an unreachable provider is failed", () => {
  assert.deepEqual(connectionFromResponse({ ok: false, status: 502 }, { models: [] }, true), { status: "failed" });
});

test("a not-configured request without a key stays idle", () => {
  assert.deepEqual(connectionFromResponse({ ok: false, status: 400 }, { models: [] }, false), { status: "idle" });
});

test("a Tavily key typed during save remains in the field", () => {
  const applied = appliedSave(submitted, { ...submitted, tavilyApiKey: "new-test-key" });
  assert.equal(applied.clearTavilyKey, false);
  assert.equal(applied.saved, false);
});

test("a search URL edited during save is not reported as saved", () => {
  assert.equal(appliedSave(submitted, { ...submitted, searxngUrl: "http://127.0.0.1:9999" }).saved, false);
});
