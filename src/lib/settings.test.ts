import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { seedTestConnection } from "./connection-fixture";
import { getDb } from "./db";
import * as settings from "./settings";
import { toolsFor } from "./tools";
import { openGithubTurn } from "./tools/github";

const originalCwd = process.cwd();
const envNames = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN", "ORBIT_SANDBOX"];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let sandbox: string;

before(() => {
  const repo = process.cwd();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-search-settings-"));
  fs.cpSync(path.join(repo, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  for (const name of envNames) delete process.env[name];
  process.env.ORBIT_SEARXNG_URL = "http://127.0.0.1:8888";
  process.env.ORBIT_TAVILY_API_KEY = "test-tavily-key-not-real";
  process.chdir(sandbox);
});

after(() => {
  getDb().$client.close();
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
    searxngUrl: "http://127.0.0.1:8888",
    tavilyApiKey: "test-tavily-key-not-real",
    githubToken: "",
    githubMcpUrl: "",
  };
  const value = settings.toPublicSettings(row);
  assert.deepEqual(value, {
    searxngUrl: "http://127.0.0.1:8888", tavilyKeySet: true, githubTokenSet: false, githubMcpUrl: "https://api.githubcopilot.com/mcp/", sandbox: false,
  });
  assert.equal(JSON.stringify(value).includes(row.tavilyApiKey), false);
});

test("an explicit GitHub token removal clears the stored token", async () => {
  settings.saveSettings({ githubToken: "good-token", githubMcpUrl: "https://api.githubcopilot.com/mcp/" });
  const removed = settings.saveSettings({ githubToken: null });
  assert.equal(removed.githubTokenSet, false);
  assert.equal(settings.getSettings().githubToken, "");
  assert.equal(JSON.stringify(removed).includes("good-token"), false);
  const stored = settings.getSettings();
  assert.ok(stored);
  const opened = await openGithubTurn({ ...stored, githubMcpUrl: "https://api.githubcopilot.com/mcp/" });
  assert.deepEqual(Object.keys(opened.tools), []);
  await opened.close();
});

test("a blank GitHub token keeps the stored token and an empty MCP URL uses the default", () => {
  settings.saveSettings({ githubToken: "good-token", githubMcpUrl: "http://127.0.0.1:9/mcp" });
  const cleared = settings.saveSettings({ githubToken: "  ", githubMcpUrl: "" });
  assert.equal(settings.getSettings().githubToken, "good-token");
  assert.equal(settings.getSettings().githubMcpUrl, "");
  assert.equal(cleared.githubTokenSet, true);
  assert.equal(cleared.githubMcpUrl, "https://api.githubcopilot.com/mcp/");
  assert.equal(JSON.stringify(cleared).includes("good-token"), false);
});

test("blank and omitted Tavily keys retain the saved key", () => {
  settings.saveSettings({ searxngUrl: "http://127.0.0.1:8888", tavilyApiKey: "test-tavily-key-not-real" });
  settings.saveSettings({ searxngUrl: "", tavilyApiKey: "  " });
  assert.equal(settings.getSettings().tavilyApiKey, "test-tavily-key-not-real");
  assert.equal(settings.getSettings().searxngUrl, "");
  settings.saveSettings({});
  assert.equal(settings.getSettings().tavilyApiKey, "test-tavily-key-not-real");
});

test("an explicit Tavily removal clears the key and disables its search backend", async () => {
  settings.saveSettings({ searxngUrl: "", tavilyApiKey: "test-tavily-key-not-real" });
  const saved = settings.saveSettings({ tavilyApiKey: null });
  assert.equal(saved.tavilyKeySet, false);
  const row = settings.getSettings();
  assert.ok(row);
  assert.equal(row.tavilyApiKey, "");
  assert.equal("web_search" in toolsFor(row), false);
});

test("public settings say whether the server enabled the code sandbox and expose no Docker detail", () => {
  const original = { sandbox: process.env.ORBIT_SANDBOX, docker: process.env.DOCKER_HOST };
  process.env.DOCKER_HOST = "tcp://private-proxy-not-real:2375";
  try {
    for (const value of [undefined, "off", "true", "ON", "on"]) {
      if (value === undefined) delete process.env.ORBIT_SANDBOX;
      else process.env.ORBIT_SANDBOX = value;
      const body = settings.toPublicSettings(settings.getSettings());
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

// The settings page renders toPublicSettings(getSettings()) and passes nothing else.
test("a provider key copied into a SearXNG URL is masked where the page shows it, and resending the masked URL keeps it", () => {
  const key = "made-up-connection-key-0001";
  const searxngUrl = `http://127.0.0.1:8888/k/${key}`;
  getDb().$client.prepare("insert into user (id, name, email, email_verified) values ('u-settings', 'Settings', 'settings@orbit.local', 0)").run();
  seedTestConnection("u-settings", { apiKey: key, model: "m" });
  settings.saveSettings({ searxngUrl });

  const shown = settings.toPublicSettings(settings.getSettings());
  assert.equal(JSON.stringify(shown).includes(key), false, `the page gets the key: ${JSON.stringify(shown)}`);
  settings.saveSettings({ searxngUrl: shown.searxngUrl });
  assert.equal(settings.getSettings().searxngUrl, searxngUrl, "resending the masked URL changed the saved URL");
});
