import assert from "node:assert/strict";
import test from "node:test";
import { toolsFor } from "./index";
import { runCodeInputSchema } from "../sandbox/spec";

test("run_code exists only when the server explicitly enables it", () => {
  const original = process.env.ORBIT_SANDBOX;
  const settings = { baseUrl: "http://localhost/v1", apiKey: "fake", model: "fake", reasoningEffort: "low", searxngUrl: "", tavilyApiKey: "" } as const;
  try {
    for (const value of [undefined, "off", "true", "ON", "on"]) {
      if (value === undefined) delete process.env.ORBIT_SANDBOX;
      else process.env.ORBIT_SANDBOX = value;
      assert.equal("run_code" in toolsFor(settings), value === "on");
    }
  } finally {
    if (original === undefined) delete process.env.ORBIT_SANDBOX;
    else process.env.ORBIT_SANDBOX = original;
  }
});

test("model input allows only the two languages and at most 20000 characters", () => {
  assert.ok(runCodeInputSchema.safeParse({ language: "python", code: "x".repeat(20000) }).success);
  assert.ok(runCodeInputSchema.safeParse({ language: "javascript", code: "" }).success);
  assert.ok(!runCodeInputSchema.safeParse({ language: "shell", code: "id" }).success);
  assert.ok(!runCodeInputSchema.safeParse({ language: "python", code: "x".repeat(20001) }).success);
});
