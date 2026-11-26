import assert from "node:assert/strict";
import test, { before } from "node:test";

delete process.env.ORBIT_OLLAMA_URL;

type MemoryTools = typeof import("./memory");
type StoreModule = typeof import("../memory/store");

let tools: MemoryTools | undefined;
let store: StoreModule | undefined;
let importError = "";

before(async () => {
  try {
    tools = await import("./memory");
    store = await import("../memory/store");
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
});

function modules() {
  assert.equal(importError, "", `memory tools are missing: ${importError}`);
  if (!tools || !store) throw new Error("memory tools are missing");
  return { tools, store };
}

test("forget refuses a call that has no id and leaves the memory in place", () => {
  const { tools, store } = modules();
  const saved = store.saveMemory({ text: "Keep the forgetgate token", kind: "fact" });
  assert.deepEqual(tools.forgetMemory(""), { error: "Memory id is required" });
  assert.deepEqual(tools.forgetMemory("   "), { error: "Memory id is required" });
  assert.equal(store.getMemory(saved.id)?.text, "Keep the forgetgate token");
  assert.equal(tools.forgetIdSchema.safeParse({}).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: "" }).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: "   " }).success, false);
  assert.equal(tools.forgetIdSchema.safeParse({ id: saved.id }).success, true);
});

test("remember returns the saved text", () => {
  const { tools } = modules();
  const saved = tools.rememberFact({ chatId: null, messageId: null }, { text: "I deploy to Fly.io", kind: "fact" });
  assert.deepEqual(saved, { id: "id" in saved ? saved.id : "", text: "I deploy to Fly.io" });
});

test("remember masks stored credentials before saving to SQLite and returning tool output", async () => {
  const { store } = modules();
  const { toolsFor } = await import("./index");
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
