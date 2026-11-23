import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const USER_ID = "u-limits";
const PROVIDER_KEY = "made-up-provider-key-0001";
const SEEDED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN"];
const EIGHTY_THOUSAND_LETTERS = "a".repeat(80_000);
// Words, so the check on a long prompt that is allowed does not depend on recall's regex cost.
const LONG_PROMPT_WITHIN_LIMIT = "ab ".repeat(16_000);

// The routes read the session from request headers and schedule the title with after(), and both
// need a Next.js request scope. These stubs stand in for them so the test drives the real handlers.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-route-limits-"));
const stubs: Record<string, string> = {
  "@/lib/session": `exports.getSession = async () => ({ user: { id: ${JSON.stringify(USER_ID)} } });
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`,
  "next/server": `exports.after = (task) => { globalThis.__orbitLimitsAfter.push(Promise.resolve(typeof task === "function" ? task() : task)); };`,
};
const stubUrls = Object.fromEntries(Object.entries(stubs).map(([specifier, source], index) => {
  const file = path.join(sandbox, `stub-${index}.cjs`);
  fs.writeFileSync(file, source);
  return [specifier, pathToFileURL(file).href];
}));

const afterTasks: Promise<unknown>[] = [];
(globalThis as { __orbitLimitsAfter?: Promise<unknown>[] }).__orbitLimitsAfter = afterTasks;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubUrls[specifier];
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

let chatRoute: typeof import("./chat/route");
let settingsRoute: typeof import("./settings/route");
let modelsRoute: typeof import("./models/route");
let getSettings: typeof import("@/lib/settings").getSettings;
let closeDb: () => void;
let provider: http.Server;
let providerRequests = 0;
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(["ORBIT_DATA_DIR", "ORBIT_OLLAMA_URL", ...SEEDED_ENV].map((name) => [name, process.env[name]]));

function sse(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: unknown, reason: string | null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  res.write(chunk({ role: "assistant", content: "Done." }, null));
  res.write(chunk({}, "stop"));
  res.end("data: [DONE]\n\n");
}

before(async () => {
  for (const name of SEEDED_ENV) delete process.env[name];
  process.env.ORBIT_DATA_DIR = path.join(sandbox, "data");
  process.env.ORBIT_OLLAMA_URL = "http://127.0.0.1:9";
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  provider = http.createServer((req, res) => {
    providerRequests += 1;
    let raw = "";
    req.on("data", (part) => (raw += part));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { stream?: boolean };
      if (body.stream === true) return sse(res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "t", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "Title" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;

  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const settings = await import("@/lib/settings");
  getSettings = settings.getSettings;
  closeDb = () => db.$client.close();
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Limits", email: "limits@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  settings.saveSettings({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: PROVIDER_KEY,
    model: "mock",
    reasoningEffort: "medium",
  });
  chatRoute = await import("./chat/route");
  settingsRoute = await import("./settings/route");
  modelsRoute = await import("./models/route");
});

after(async () => {
  await Promise.allSettled(afterTasks);
  closeDb?.();
  await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()));
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hooks.deregister();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function postJson(url: string, method: string, body: unknown) {
  return new Request(`http://127.0.0.1${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function chatBody(chatId: string, text: string) {
  return { id: chatId, trigger: "submit-message", messages: [{ id: `${chatId}-u1`, role: "user", parts: [{ type: "text", text }] }] };
}

test("an 80,000 letter chat message is refused at the route and never reaches the provider", async () => {
  const before = providerRequests;
  const response = await chatRoute.POST(postJson("/api/chat", "POST", chatBody("c-long", EIGHTY_THOUSAND_LETTERS)));
  const body = (await response.text()).slice(0, 200);
  await Promise.allSettled(afterTasks);
  assert.equal(response.status, 413, `the route answered ${response.status}: ${body}`);
  assert.deepEqual(JSON.parse(body), { error: "Message is too long." });
  assert.equal(providerRequests, before, "the provider received a request for a refused message");
});

test("a chat message inside the limit is accepted", async () => {
  const response = await chatRoute.POST(postJson("/api/chat", "POST", chatBody("c-ok", LONG_PROMPT_WITHIN_LIMIT)));
  assert.equal(response.status, 200);
  await response.text();
  await Promise.allSettled(afterTasks);
});

test("an 80,000 letter API key is refused by settings and leaves the saved key alone", async () => {
  const response = await settingsRoute.PUT(postJson("/api/settings", "PUT", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: EIGHTY_THOUSAND_LETTERS,
    model: "mock",
    reasoningEffort: "medium",
  }));
  assert.equal(response.status, 400);
  assert.equal(getSettings()?.apiKey, PROVIDER_KEY);
});

test("an 80,000 letter API key is refused by the model list before any provider request", async () => {
  const before = providerRequests;
  const response = await modelsRoute.POST(postJson("/api/models", "POST", { apiKey: EIGHTY_THOUSAND_LETTERS }));
  assert.equal(response.status, 400);
  assert.equal(providerRequests, before);
});
