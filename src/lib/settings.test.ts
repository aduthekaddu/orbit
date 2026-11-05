import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";

const originalCwd = process.cwd();
const envNames = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_DATA_DIR", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY"];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let sandbox: string;
let settings: typeof import("./settings");

before(async () => {
  const repo = process.cwd();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-search-settings-"));
  fs.cpSync(path.join(repo, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  for (const name of envNames) delete process.env[name];
  process.env.ORBIT_SEARXNG_URL = "http://127.0.0.1:8888";
  process.env.ORBIT_TAVILY_API_KEY = "test-tavily-key-not-real";
  process.chdir(sandbox);
  settings = await import("./settings");
});

after(() => {
  process.chdir(originalCwd);
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("search-only environment settings seed a row without a model provider", () => {
  const row = settings.getSettings();
  assert.ok(row);
  assert.equal(row.searxngUrl, "http://127.0.0.1:8888");
  assert.equal(row.tavilyApiKey, "test-tavily-key-not-real");
});

test("public settings expose search configuration without either key", () => {
  const row = {
    baseUrl: "https://example.com/v1",
    apiKey: "test-provider-key-not-real",
    model: "test-model",
    reasoningEffort: "medium" as const,
    searxngUrl: "http://127.0.0.1:8888",
    tavilyApiKey: "test-tavily-key-not-real",
  };
  const value = settings.toPublicSettings(row);
  assert.deepEqual(value, {
    baseUrl: "https://example.com/v1", model: "test-model", reasoningEffort: "medium", keySet: true,
    searxngUrl: "http://127.0.0.1:8888", tavilyKeySet: true,
  });
  assert.equal(JSON.stringify(value).includes(row.apiKey), false);
  assert.equal(JSON.stringify(value).includes(row.tavilyApiKey), false);
});

test("blank and omitted Tavily keys retain the saved key", () => {
  const provider = { baseUrl: "https://example.com/v1", apiKey: "test-provider-key-not-real", model: "test-model", reasoningEffort: "medium" as const };
  settings.saveSettings({ ...provider, searxngUrl: "http://127.0.0.1:8888", tavilyApiKey: "test-tavily-key-not-real" });
  settings.saveSettings({ ...provider, searxngUrl: "", tavilyApiKey: "  " });
  assert.equal(settings.getSettings()?.tavilyApiKey, "test-tavily-key-not-real");
  assert.equal(settings.getSettings()?.searxngUrl, "");
  settings.saveSettings(provider);
  assert.equal(settings.getSettings()?.tavilyApiKey, "test-tavily-key-not-real");
});

test("an explicit Tavily removal clears the key and disables its search backend", async () => {
  const provider = { baseUrl: "https://example.com/v1", model: "test-model", reasoningEffort: "medium" as const };
  settings.saveSettings({ ...provider, apiKey: "test-provider-key-not-real", searxngUrl: "", tavilyApiKey: "test-tavily-key-not-real" });
  const saved = settings.saveSettings({ ...provider, tavilyApiKey: null });
  assert.equal(saved.tavilyKeySet, false);
  const row = settings.getSettings();
  assert.ok(row);
  assert.equal(row.tavilyApiKey, "");
  const { toolsFor } = await import("./tools");
  assert.equal("web_search" in toolsFor(row), false);
});
