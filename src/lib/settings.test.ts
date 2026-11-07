import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";

const originalCwd = process.cwd();
const envNames = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_DATA_DIR", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN", "ORBIT_SANDBOX"];
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

test("public settings report a GitHub token without returning it", () => {
  const row = {
    baseUrl: "https://example.com/v1",
    apiKey: "test-provider-key-not-real",
    model: "test-model",
    reasoningEffort: "medium" as const,
    searxngUrl: "",
    tavilyApiKey: "",
    githubToken: "good-token",
    githubMcpUrl: "http://127.0.0.1:9/mcp",
  };
  const value = settings.toPublicSettings(row);
  assert.equal(value.githubTokenSet, true);
  assert.equal(value.githubMcpUrl, "http://127.0.0.1:9/mcp");
  assert.equal(JSON.stringify(value).includes("good-token"), false);
  assert.equal("githubToken" in value, false);
});

test("public settings expose search configuration without either key", () => {
  const row = {
    baseUrl: "https://example.com/v1",
    apiKey: "test-provider-key-not-real",
    model: "test-model",
    reasoningEffort: "medium" as const,
    searxngUrl: "http://127.0.0.1:8888",
    tavilyApiKey: "test-tavily-key-not-real",
    githubToken: "",
    githubMcpUrl: "",
  };
  const value = settings.toPublicSettings(row);
  assert.deepEqual(value, {
    baseUrl: "https://example.com/v1", model: "test-model", reasoningEffort: "medium", keySet: true,
    searxngUrl: "http://127.0.0.1:8888", tavilyKeySet: true, githubTokenSet: false, githubMcpUrl: "https://api.githubcopilot.com/mcp/", sandbox: false,
  });
  assert.equal(JSON.stringify(value).includes(row.apiKey), false);
  assert.equal(JSON.stringify(value).includes(row.tavilyApiKey), false);
});

test("a blank GitHub token keeps the stored token and an empty MCP URL uses the default", () => {
  const provider = { baseUrl: "https://example.com/v1", apiKey: "test-provider-key-not-real", model: "test-model", reasoningEffort: "medium" as const };
  settings.saveSettings({ ...provider, githubToken: "good-token", githubMcpUrl: "http://127.0.0.1:9/mcp" });
  const cleared = settings.saveSettings({ ...provider, githubToken: "  ", githubMcpUrl: "" });
  assert.equal(settings.getSettings()?.githubToken, "good-token");
  assert.equal(settings.getSettings()?.githubMcpUrl, "");
  assert.equal(cleared.githubTokenSet, true);
  assert.equal(cleared.githubMcpUrl, "https://api.githubcopilot.com/mcp/");
  assert.equal(JSON.stringify(cleared).includes("good-token"), false);
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

test("public settings say whether the server enabled the code sandbox and expose no Docker detail", () => {
  const original = { sandbox: process.env.ORBIT_SANDBOX, docker: process.env.DOCKER_HOST };
  process.env.DOCKER_HOST = "tcp://private-proxy-not-real:2375";
  try {
    for (const value of [undefined, "off", "true", "ON", "on"]) {
      if (value === undefined) delete process.env.ORBIT_SANDBOX;
      else process.env.ORBIT_SANDBOX = value;
      const body = settings.toPublicSettings(null) as { sandbox?: boolean };
      assert.equal(body.sandbox, value === "on", `ORBIT_SANDBOX=${value}`);
      assert.equal(JSON.stringify(body).includes("private-proxy-not-real"), false);
    }
  } finally {
    if (original.sandbox === undefined) delete process.env.ORBIT_SANDBOX;
    else process.env.ORBIT_SANDBOX = original.sandbox;
    if (original.docker === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = original.docker;
  }
});
