import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { getDb, type OrbitDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { seedTestConnection } from "@/lib/connection-fixture";
import { connectionApiKey } from "@/lib/connections";
import { getSettings } from "@/lib/settings";
import { startMockMcp } from "../../../../scripts/qa/mock-mcp.mjs";

const USER_ID = "u-settings-route";
const PROVIDER_KEY = "made-up-provider-key-0001";
const SEEDED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN"];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-settings-route-"));
const stubFile = path.join(sandbox, "session-stub.cjs");
fs.writeFileSync(
  stubFile,
  `exports.sessionFrom = exports.getSession = async () => ({ user: { id: ${JSON.stringify(USER_ID)} } });
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`,
);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/session") return { url: pathToFileURL(stubFile).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

let settingsRoute: typeof import("./route");
let connectionsRoute: typeof import("../connections/route");
let connectionRoute: typeof import("../connections/[id]/route");
let provider: http.Server;
let providerHost = "";
let db: OrbitDb | undefined;
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(SEEDED_ENV.map((name) => [name, process.env[name]]));

before(async () => {
  for (const name of SEEDED_ENV) delete process.env[name];
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  db = getDb();
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Settings", email: "settings@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  settingsRoute = await import("./route");
  connectionsRoute = await import("../connections/route");
  connectionRoute = await import("../connections/[id]/route");
  provider = http.createServer((req, res) => {
    const ok = req.url?.endsWith("/models") && req.headers.authorization === "Bearer made-up-provider-key-next-02";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { data: [{ id: "gpt-4" }] } : { error: "no" }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  providerHost = `127.0.0.1:${(provider.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()));
  db?.$client.close();
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hooks.deregister();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function putSettings(body: unknown) {
  return settingsRoute.PUT(new Request("http://127.0.0.1/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

function patchConnection(id: string, body: unknown) {
  return connectionRoute.PATCH(
    new Request(`http://127.0.0.1/api/connections/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
}

function savedBaseUrl(id: string) {
  return (db!.$client.prepare("select base_url from provider_connections where id = ?").get(id) as { base_url: string }).base_url;
}

test("GET and PUT /api/settings and GET /api/connections mask userinfo, query credentials, and stored keys in saved URLs while keeping them on the server", async () => {
  const baseUrlWithCreds = `https://proxyuser:url-pass-secret-01@example.com/v1/${PROVIDER_KEY}?api_key=url-query-secret-01&extra=other-param-02`;
  const searxWithCreds = "http://searxuser:searx-pass-01@127.0.0.1:8888?token=searx-token-01";
  const connectionId = seedTestConnection(USER_ID, { baseUrl: baseUrlWithCreds, apiKey: PROVIDER_KEY, model: "gpt-4" });
  const put = await putSettings({ searxngUrl: searxWithCreds });
  assert.equal(put.status, 200);
  const putRaw = await put.text();
  const get = await settingsRoute.GET();
  assert.equal(get.status, 200);
  const getRaw = await get.text();
  const listed = await connectionsRoute.GET(new Request("http://localhost"));
  assert.equal(listed.status, 200);
  const listedRaw = await listed.text();
  for (const raw of [putRaw, getRaw, listedRaw]) {
    for (const secret of ["proxyuser", "url-pass-secret-01", "url-query-secret-01", "searxuser", "searx-pass-01", "searx-token-01", PROVIDER_KEY]) {
      assert.equal(raw.includes(secret), false, `response leaked ${secret}: ${raw}`);
    }
  }
  const [connection] = JSON.parse(listedRaw) as { baseUrl: string }[];
  assert.equal(connection.baseUrl, "https://[redacted]@example.com/v1/[redacted]?api_key=[redacted]&extra=other-param-02");
  const shown = JSON.parse(getRaw) as { searxngUrl: string };
  assert.equal(shown.searxngUrl, "http://[redacted]@127.0.0.1:8888?token=[redacted]");

  // Re-submitting the masked URLs when changing another field keeps the real URLs and API key on the server.
  assert.equal((await putSettings({ searxngUrl: shown.searxngUrl })).status, 200);
  assert.equal((await patchConnection(connectionId, { label: "Renamed", baseUrl: connection.baseUrl })).status, 200);
  assert.equal(getSettings().searxngUrl, searxWithCreds);
  assert.equal(savedBaseUrl(connectionId), baseUrlWithCreds);
  assert.equal(connectionApiKey(USER_ID, connectionId), PROVIDER_KEY);
});

test("editing non-secret parts of masked URLs merges saved credentials on the same origin and never stores the marker", async () => {
  const initialBase = `http://user:pw-secret-value-1234@${providerHost}/v1`;
  const initialSearx = "http://127.0.0.1:8888/search?token=searx-secret-01&format=json&language=en#top";
  const initialMcp = "https://api.githubcopilot.com/mcp/?token=gh-mcp-secret-01&mode=a";
  const connectionId = seedTestConnection(USER_ID, { baseUrl: initialBase, apiKey: PROVIDER_KEY, model: "gpt-4" });
  const first = await putSettings({ searxngUrl: initialSearx, githubMcpUrl: initialMcp });
  assert.equal(first.status, 200);
  const shown = (await first.json()) as { searxngUrl: string; githubMcpUrl: string };
  assert.equal(shown.searxngUrl, "http://127.0.0.1:8888/search?token=[redacted]&format=json&language=en#top");
  assert.equal(shown.githubMcpUrl, "https://api.githubcopilot.com/mcp/?token=[redacted]&mode=a");
  const [connection] = (await (await connectionsRoute.GET(new Request("http://localhost"))).json()) as { baseUrl: string }[];
  assert.equal(connection.baseUrl, `http://[redacted]@${providerHost}/v1`);

  const edited = await putSettings({
    searxngUrl: shown.searxngUrl.replace("language=en", "language=de"),
    githubMcpUrl: shown.githubMcpUrl.replace("mode=a", "mode=b"),
  });
  assert.equal(edited.status, 200);
  const moved = await patchConnection(connectionId, { baseUrl: connection.baseUrl.replace("/v1", "/v2"), apiKey: "made-up-provider-key-next-02" });
  assert.equal(moved.status, 200, await moved.clone().text());
  const stored = getSettings();
  assert.equal(savedBaseUrl(connectionId), `http://user:pw-secret-value-1234@${providerHost}/v2`);
  assert.equal(stored.searxngUrl, "http://127.0.0.1:8888/search?token=searx-secret-01&format=json&language=de#top");
  assert.equal(stored.githubMcpUrl, "https://api.githubcopilot.com/mcp/?token=gh-mcp-secret-01&mode=b");
});

test("an edited URL whose [redacted] marker cannot be resolved is rejected with its field named", async () => {
  const initialBase = `https://user:pw-secret-value-1234@proxy.example.com/v1/${PROVIDER_KEY}`;
  const initialSearx = "http://127.0.0.1:8888/search?token=searx-secret-01&language=en";
  const initialMcp = "https://api.githubcopilot.com/mcp/?token=gh-mcp-secret-01";
  const connectionId = seedTestConnection(USER_ID, { baseUrl: initialBase, apiKey: PROVIDER_KEY, model: "gpt-4" });
  const setup = await putSettings({ searxngUrl: initialSearx, githubMcpUrl: initialMcp });
  assert.equal(setup.status, 200);
  const shown = (await setup.json()) as { searxngUrl: string; githubMcpUrl: string };

  for (const baseUrl of ["https://[redacted]@other.example.com/v1", "https://[redacted]@proxy.example.com/v2/[redacted]"]) {
    const response = await patchConnection(connectionId, { baseUrl, apiKey: "made-up-provider-key-next-03" });
    assert.equal(response.status, 400, `expected 400 for ${baseUrl}`);
    assert.match(((await response.json()) as { error?: string }).error ?? "", /Base URL/i);
  }

  const cases: Array<{ label: RegExp; patch: Record<string, string> }> = [
    { label: /SearXNG URL/i, patch: { searxngUrl: "http://127.0.0.1:9999/search?token=[redacted]" } },
    { label: /SearXNG URL/i, patch: { searxngUrl: "http://127.0.0.1:8888/search?api_key=[redacted]" } },
    { label: /GitHub MCP URL/i, patch: { githubMcpUrl: "https://api.github.com/mcp/?token=[redacted]" } },
  ];
  for (const { label, patch } of cases) {
    const response = await putSettings({ searxngUrl: shown.searxngUrl, githubMcpUrl: shown.githubMcpUrl, ...patch });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(patch)}`);
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", label);
  }

  const stored = getSettings();
  assert.equal(savedBaseUrl(connectionId), initialBase);
  assert.equal(connectionApiKey(USER_ID, connectionId), PROVIDER_KEY);
  assert.equal(stored.searxngUrl, initialSearx);
  assert.equal(stored.githubMcpUrl, initialMcp);
});

test("Check matches the GitHub MCP URL that Settings shows, also when Settings masked a connection key in it", async () => {
  const originalFixture = process.env.ORBIT_GITHUB_MCP_FIXTURE;
  process.env.ORBIT_GITHUB_MCP_FIXTURE = "1";
  const mock = await startMockMcp();
  try {
    seedTestConnection(USER_ID, { baseUrl: `http://${providerHost}/v1`, apiKey: PROVIDER_KEY, model: "gpt-4" });
    const saved = await putSettings({ githubToken: mock.token, githubMcpUrl: `${mock.url}?escaped-login=custom-user&note=${PROVIDER_KEY}` });
    assert.equal(saved.status, 200, await saved.clone().text());
    const shown = ((await (await settingsRoute.GET()).json()) as { githubMcpUrl: string }).githubMcpUrl;
    assert.equal(shown.includes(PROVIDER_KEY), false, shown);
    const { POST: check } = await import("./github/check/route");
    const checked = await check(new Request("http://127.0.0.1/api/settings/github/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcpUrl: shown }) }));
    assert.deepEqual(await checked.json(), { ok: true, login: "custom-user" });
  } finally {
    await mock.close();
    if (originalFixture === undefined) delete process.env.ORBIT_GITHUB_MCP_FIXTURE;
    else process.env.ORBIT_GITHUB_MCP_FIXTURE = originalFixture;
  }
});
