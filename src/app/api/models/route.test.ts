import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const USER_ID = "u-models-route";
const PROVIDER_KEY = "made-up-provider-key-0001";
const TAVILY_KEY = "made-up-tavily-key-0002";
const GITHUB_TOKEN = "made-up-github-token-0003";
const SUBMITTED_KEY = "made-up-submitted-key-0004";
const SEEDED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN"];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-models-route-"));
const stubFile = path.join(sandbox, "session-stub.cjs");
fs.writeFileSync(
  stubFile,
  `exports.getSession = async () => ({ user: { id: ${JSON.stringify(USER_ID)} } });
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`,
);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/session") return { url: pathToFileURL(stubFile).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

let modelsRoute: typeof import("./route");
let saveSettings: typeof import("@/lib/settings").saveSettings;
let db: typeof import("@/lib/db").db;
let provider: http.Server;
let baseUrl = "";
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(SEEDED_ENV.map((name) => [name, process.env[name]]));

before(async () => {
  for (const name of SEEDED_ENV) delete process.env[name];
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  provider = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "gpt-4", capabilities: { reasoning: true } },
            { id: `echo-${PROVIDER_KEY}` },
            { id: `echo-${TAVILY_KEY}` },
            { id: `echo-${GITHUB_TOKEN}` },
            { id: `echo-${SUBMITTED_KEY}` },
            { id: "encoded-made%2Dup-provider-key-0001" },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}/v1`;

  ({ db } = await import("@/lib/db"));
  const schema = await import("@/lib/db/schema");
  ({ saveSettings } = await import("@/lib/settings"));
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Models", email: "models@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  saveSettings({
    baseUrl,
    apiKey: PROVIDER_KEY,
    tavilyApiKey: TAVILY_KEY,
    githubToken: GITHUB_TOKEN,
    githubMcpUrl: "",
    model: "gpt-4",
    reasoningEffort: "medium",
  });
  modelsRoute = await import("./route");
});

after(async () => {
  db?.$client.close();
  await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()));
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hooks.deregister();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("GET /api/models masks stored credentials (literal and encoded) echoed in provider model ids", async () => {
  const response = await modelsRoute.GET();
  assert.equal(response.status, 200);
  const raw = await response.text();
  const body = JSON.parse(raw) as { models: Array<{ id: string }> };
  assert.ok(body.models.some((model) => model.id === "gpt-4"));
  for (const secret of [PROVIDER_KEY, TAVILY_KEY, GITHUB_TOKEN, "made%2Dup-provider-key-0001"]) {
    assert.equal(raw.includes(secret), false, `GET /api/models leaked ${secret}: ${raw}`);
  }
  const ids = body.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate masked model ids: ${JSON.stringify(ids)}`);
});

test("POST /api/models masks stored and submitted credentials echoed in provider model ids", async () => {
  const response = await modelsRoute.POST(
    new Request("http://127.0.0.1/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey: SUBMITTED_KEY }),
    }),
  );
  assert.equal(response.status, 200);
  const raw = await response.text();
  for (const secret of [PROVIDER_KEY, TAVILY_KEY, GITHUB_TOKEN, SUBMITTED_KEY, "made%2Dup-provider-key-0001"]) {
    assert.equal(raw.includes(secret), false, `POST /api/models leaked ${secret}: ${raw}`);
  }
});

test("POST /api/models accepts the masked saved base URL without requiring the user to retype the API key", async () => {
  const withUserinfo = baseUrl.replace("http://", "http://proxyuser:url-pass-secret-01@");
  const saved = saveSettings({
    baseUrl: withUserinfo,
    apiKey: PROVIDER_KEY,
    tavilyApiKey: TAVILY_KEY,
    githubToken: GITHUB_TOKEN,
    githubMcpUrl: "",
    model: "gpt-4",
    reasoningEffort: "medium",
  });
  try {
    assert.equal(saved.baseUrl.includes("url-pass-secret-01"), false, `saveSettings leaked URL password: ${saved.baseUrl}`);
    const response = await modelsRoute.POST(
      new Request("http://127.0.0.1/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: saved.baseUrl }),
      }),
    );
    assert.equal(response.status, 200);
  } finally {
    saveSettings({
      baseUrl,
      apiKey: PROVIDER_KEY,
      tavilyApiKey: TAVILY_KEY,
      githubToken: GITHUB_TOKEN,
      githubMcpUrl: "",
      model: "gpt-4",
      reasoningEffort: "medium",
    });
  }
});
