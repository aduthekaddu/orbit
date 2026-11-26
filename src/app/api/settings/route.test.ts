import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const USER_ID = "u-settings-route";
const PROVIDER_KEY = "made-up-provider-key-0001";
const SEEDED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_GITHUB_TOKEN"];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-settings-route-"));
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

let settingsRoute: typeof import("./route");
let getSettings: typeof import("@/lib/settings").getSettings;
let db: typeof import("@/lib/db").db;
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(SEEDED_ENV.map((name) => [name, process.env[name]]));

before(async () => {
  for (const name of SEEDED_ENV) delete process.env[name];
  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);

  ({ db } = await import("@/lib/db"));
  const schema = await import("@/lib/db/schema");
  ({ getSettings } = await import("@/lib/settings"));
  const now = new Date();
  db.insert(schema.user).values({ id: USER_ID, name: "Settings", email: "settings@orbit.local", emailVerified: false, createdAt: now, updatedAt: now }).run();
  settingsRoute = await import("./route");
});

after(async () => {
  db?.$client.close();
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hooks.deregister();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("GET and PUT /api/settings mask userinfo, query credentials, and stored keys in saved URLs while keeping them on the server", async () => {
  const baseUrlWithCreds = `https://proxyuser:url-pass-secret-01@example.com/v1/${PROVIDER_KEY}?api_key=url-query-secret-01&extra=other-param-02`;
  const searxWithCreds = "http://searxuser:searx-pass-01@127.0.0.1:8888?token=searx-token-01";
  const put = await settingsRoute.PUT(
    new Request("http://127.0.0.1/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: baseUrlWithCreds,
        apiKey: PROVIDER_KEY,
        searxngUrl: searxWithCreds,
        model: "gpt-4",
        reasoningEffort: "medium",
      }),
    }),
  );
  assert.equal(put.status, 200);
  const putRaw = await put.text();
  const get = await settingsRoute.GET();
  assert.equal(get.status, 200);
  const getRaw = await get.text();
  for (const raw of [putRaw, getRaw]) {
    for (const secret of ["proxyuser", "url-pass-secret-01", "url-query-secret-01", "searxuser", "searx-pass-01", "searx-token-01", PROVIDER_KEY]) {
      assert.equal(raw.includes(secret), false, `settings response leaked ${secret}: ${raw}`);
    }
  }
  const shown = JSON.parse(getRaw) as { baseUrl: string; searxngUrl: string };
  assert.equal(shown.baseUrl, "https://[redacted]@example.com/v1/[redacted]?api_key=[redacted]&extra=other-param-02");
  assert.equal(shown.searxngUrl, "http://[redacted]@127.0.0.1:8888?token=[redacted]");

  // Re-submitting the masked URLs when changing another field keeps the real URLs and API key on the server.
  const second = await settingsRoute.PUT(
    new Request("http://127.0.0.1/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: shown.baseUrl,
        searxngUrl: shown.searxngUrl,
        model: "gpt-4",
        reasoningEffort: "high",
      }),
    }),
  );
  assert.equal(second.status, 200);
  const stored = getSettings();
  assert.equal(stored?.baseUrl, baseUrlWithCreds);
  assert.equal(stored?.searxngUrl, searxWithCreds);
  assert.equal(stored?.apiKey, PROVIDER_KEY);
  assert.equal(stored?.reasoningEffort, "high");
});
