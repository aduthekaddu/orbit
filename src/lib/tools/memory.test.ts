import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-memory-tools-"));
process.env.ORBIT_DATA_DIR = dataDir;
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
