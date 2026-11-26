import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getDb } from "../db";
import * as store from "../memory/store";
import { toolsFor } from "./index";
import * as tools from "./memory";

delete process.env.ORBIT_OLLAMA_URL;

after(() => {
  getDb().$client.close();
});

test("forget refuses a call that has no id and leaves the memory in place", () => {
  const saved = store.saveMemory({ text: "Keep the forgetgate token", kind: "fact", source: "tool" });
  assert.deepEqual(tools.forgetMemory(""), { error: "Memory id is required" });
  assert.deepEqual(tools.forgetMemory("   "), { error: "Memory id is required" });
  assert.equal(store.getMemory(saved.id)?.text, "Keep the forgetgate token");
  assert.equal(tools.forgetIdSchema.safeParse({}).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: "" }).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: "   " }).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: saved.id }).success, true);
});

test("remember returns the saved text", () => {
  const saved = tools.rememberFact({ chatId: null, messageId: null }, { text: "I deploy to Fly.io", kind: "fact" });
  assert.deepEqual(saved, { id: "id" in saved ? saved.id : "", text: "I deploy to Fly.io" });
});

test("remember masks stored credentials before saving to SQLite and returning tool output", async () => {
  const providerKey = "made-up-provider-key-0001";
  const tavilyKey = "made-up-tavily-key-0002";
  const tool = toolsFor({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: providerKey,
    model: "mock",
    reasoningEffort: "low",
    searxngUrl: "",
    tavilyApiKey: tavilyKey,
    githubToken: "",
    githubMcpUrl: "",
  }).remember;
  assert.ok(tool?.execute);
  const result = (await tool.execute(
    { text: `Use ${providerKey} and made%2Dup-tavily-key-0002`, kind: "fact" },
    { toolCallId: "rem-1", messages: [], context: {} },
  )) as { id?: string; text?: string };
  assert.ok(result.id);
  assert.equal(result.text, "Use [redacted] and [redacted]");
  assert.equal(store.getMemory(result.id)?.text, "Use [redacted] and [redacted]");
});
