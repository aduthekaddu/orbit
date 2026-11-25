import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getDb } from "../db";
import * as store from "../memory/store";
import * as tools from "./memory";

delete process.env.ORBIT_OLLAMA_URL;

after(() => {
  getDb().$client.close();
});

test("forget refuses a call that has no id and leaves the memory in place", () => {
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
  const saved = tools.rememberFact({ chatId: null, messageId: null }, { text: "I deploy to Fly.io", kind: "fact" });
  assert.deepEqual(saved, { id: "id" in saved ? saved.id : "", text: "I deploy to Fly.io" });
});
