import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const providerEnvironment = { ORBIT_API_KEY: "test-key-not-real", ORBIT_BASE_URL: "https://provider.invalid/v1", ORBIT_MODEL: "mock-genui" };
const previousEnvironment = Object.fromEntries(Object.keys(providerEnvironment).map((key) => [key, process.env[key]]));
test.before(() => Object.assign(process.env, providerEnvironment));
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const scenarioUrl = pathToFileURL(path.resolve(".agents/skills/verify-orbit/scenarios/sandbox-real.mjs")).href;

type Program = (input: string, digest: string) => { language: "python" | "javascript"; code: string };

async function checkHashScenario(program: Program, result: { exitCode?: number; stdout?: string; answer?: string } = {}) {
  const checks = new Map<string, boolean>();
  let prompt = "";
  let input = "orbit";
  let digest = "";
  const page = {
    request: {
      post: async () => ({ json: async () => ({ id: "hash-check" }) }),
      get: async () => ({ json: async () => ({ messages: [{ message: { role: "assistant", parts: [
        { type: "tool-run_code", state: "output-available", input: program(input, digest), output: { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? `${digest}\n` } },
        { type: "text", text: result.answer ?? digest },
      ] } }] }) }),
    },
    goto: async () => {},
    getByPlaceholder: () => ({
      fill: async (value: string) => {
        prompt = value;
        input = value.match(/"(orbit[^"\n]*)"/)?.[1] ?? "orbit";
        digest = createHash("sha256").update(input).digest("hex");
      },
      press: async () => {},
    }),
    locator: () => ({ last: () => ({ getByRole: () => ({ waitFor: async () => {} }) }) }),
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
  };
  const { default: sandboxReal } = await import(scenarioUrl);
  await sandboxReal({ page, origin: "http://orbit.invalid", useProvider: async () => ({}), step: (name: string, ok: boolean) => checks.set(name, ok), shot: async () => {} });
  return { prompt, checks };
}

test("hash verification rejects a program that only prints the correct digest", async () => {
  const result = await checkHashScenario((input, digest) => ({ language: "python", code: `# ${input}\nprint("${digest}")` }));
  assert.equal(result.checks.get("real provider runs code to compute the hash"), false);
  assert.equal(result.checks.get("real provider hash matches sha256sum"), true);
});

for (const language of ["python", "javascript"] as const) {
  test(`hash verification accepts a ${language} calculation`, async () => {
    const result = await checkHashScenario((input) => ({ language, code: language === "python"
      ? `import hashlib\nprint(hashlib.sha256(b"${input}").hexdigest())`
      : `console.log(require("node:crypto").createHash("sha256").update("${input}").digest("hex"))` }));
    assert.equal(result.checks.get("real provider runs code to compute the hash"), true);
    assert.equal(result.checks.get("real provider hash matches sha256sum"), true);
  });
}

test("hash verification uses a fresh input for every attempt", async () => {
  const program: Program = (input) => ({ language: "python", code: `import hashlib\nprint(hashlib.sha256(b"${input}").hexdigest())` });
  const first = await checkHashScenario(program);
  const second = await checkHashScenario(program);
  assert.notEqual(first.prompt, second.prompt);
});

const calculation: Program = (input) => ({ language: "python", code: `import hashlib\nprint(hashlib.sha256(b"${input}").hexdigest())` });

test("hash verification rejects incorrect tool output even with a correct answer", async () => {
  const result = await checkHashScenario(calculation, { stdout: "incorrect digest" });
  assert.equal(result.checks.get("real provider runs code to compute the hash"), false);
  assert.equal(result.checks.get("real provider hash matches sha256sum"), true);
});

test("hash verification rejects a nonzero exit even with the correct digest", async () => {
  const result = await checkHashScenario(calculation, { exitCode: 7 });
  assert.equal(result.checks.get("real provider runs code to compute the hash"), false);
  assert.equal(result.checks.get("real provider hash matches sha256sum"), true);
});

test("hash verification rejects a wrong saved answer even with a correct calculation", async () => {
  const result = await checkHashScenario(calculation, { answer: "incorrect digest" });
  assert.equal(result.checks.get("real provider runs code to compute the hash"), true);
  assert.equal(result.checks.get("real provider hash matches sha256sum"), false);
});
