import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { setModelHidden } from "./connections";
import { getDb } from "./db";
import { ensureChat } from "./messages";
import { cachedCaps } from "./model-list";
import { dataDirectory } from "./paths";
import { getPreferences, savePreferences } from "./preferences";
import { saveSettings } from "./settings";

const ONE = "u-connections-one";
const TWO = "u-connections-two";
const OPENAI_KEY = "made-up-openai-key-0001";
const ANTHROPIC_KEY = "made-up-anthropic-key-0001";
const URL_SECRET = "url-pass-secret-01";
const TAVILY_KEY = "made-up-tavily-key-0001";
// A provider can repeat any credential it was sent, or that the user gave it, in a model id.
const ECHOED = [OPENAI_KEY, ANTHROPIC_KEY, TAVILY_KEY];
const CLEARED_ENV = ["ORBIT_BASE_URL", "ORBIT_API_KEY", "ORBIT_MODEL", "ORBIT_SECRET_KEY", "ORBIT_ANTHROPIC_BASE_URL"];

type Seen = { path: string; headers: http.IncomingHttpHeaders };
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Connection = { id: string; kind: string; label: string; baseUrl?: string; keySet: boolean };

const sandbox = fs.mkdtempSync(path.join(process.env.ORBIT_DATA_DIR!, "cwd-"));
const stubFile = path.join(sandbox, "session-stub.cjs");
fs.writeFileSync(
  stubFile,
  `exports.getSession = async () => (globalThis.orbitTestUser ? { user: { id: globalThis.orbitTestUser } } : null);
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`,
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/session") return { url: pathToFileURL(stubFile).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const asUser = (id: string) => {
  (globalThis as { orbitTestUser?: string }).orbitTestUser = id;
};

const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(CLEARED_ENV.map((name) => [name, process.env[name]]));
const provider: Seen[] = [];
const elsewhere: Seen[] = [];
const servers: http.Server[] = [];
const bodies: string[] = [];
let providerBase = "";
let elsewhereBase = "";

let collection: { GET: () => Promise<Response>; POST: (request: Request) => Promise<Response> };
let item: { PATCH: Handler; DELETE: Handler };
let models: { GET: Handler };
let hiddenModels: { PUT: Handler };
let defaults: { GET: () => Promise<Response>; PUT: (request: Request) => Promise<Response> };

async function listen(log: Seen[], reply: (req: http.IncomingMessage) => object | null) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    log.push({ path: url.pathname, headers: req.headers });
    const payload = url.pathname === "/v1/models" ? reply(req) : null;
    if (!payload) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "fixture failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  for (const name of CLEARED_ENV) delete process.env[name];
  providerBase = await listen(provider, (req) => {
    if (req.headers["anthropic-version"]) {
      if (req.headers["x-api-key"] !== ANTHROPIC_KEY) return null;
      return {
        data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-10-01T00:00:00Z", max_input_tokens: 1_000_000, capabilities: {} }],
        has_more: false,
        first_id: "claude-opus-5-5",
        last_id: "claude-opus-5-5",
      };
    }
    if (req.headers.authorization !== `Bearer ${OPENAI_KEY}`) return null;
    return { object: "list", data: [{ id: "fixture-model" }, { id: "openai/gpt-5" }, ...ECHOED.map((secret) => ({ id: `echo-${secret}` }))] };
  });
  elsewhereBase = await listen(elsewhere, () => ({ object: "list", data: [{ id: "elsewhere-model" }] }));
  process.env.ORBIT_ANTHROPIC_BASE_URL = `${providerBase}/v1`;

  fs.cpSync(path.join(originalCwd, "drizzle"), path.join(sandbox, "drizzle"), { recursive: true });
  process.chdir(sandbox);
  const db = getDb();
  // Slice 18 adds accounts. Until then the database holds one user, so this file lifts that limit to test ownership.
  db.$client.exec("DROP TRIGGER IF EXISTS user_single_row");
  for (const id of [ONE, TWO]) {
    db.$client.prepare("insert into user (id, name, email, email_verified) values (?, ?, ?, 0)").run(id, id, `${id}@orbit.local`);
  }
  asUser(ONE);
  saveSettings({ tavilyApiKey: TAVILY_KEY });

  collection = await import("../app/api/connections/route");
  item = await import("../app/api/connections/[id]/route");
  models = await import("../app/api/connections/[id]/models/route");
  hiddenModels = await import("../app/api/connections/[id]/hidden-models/route");
  defaults = await import("../app/api/preferences/model/route");
});

after(async () => {
  getDb().$client.close();
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hooks.deregister();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(`http://127.0.0.1${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read(response: Promise<Response>) {
  const settled = await response;
  const text = await settled.text();
  bodies.push(text);
  return { status: settled.status, text, json: () => JSON.parse(text) };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const list = async () => (await read(collection.GET())).json() as Connection[];
const create = (body: unknown) => read(collection.POST(jsonRequest("/api/connections", "POST", body)));
const patch = (id: string, body: unknown) => read(item.PATCH(jsonRequest(`/api/connections/${id}`, "PATCH", body), params(id)));
const remove = (id: string) => read(item.DELETE(jsonRequest(`/api/connections/${id}`, "DELETE"), params(id)));
const modelsOf = (id: string) => read(models.GET(jsonRequest(`/api/connections/${id}/models`, "GET"), params(id)));
const hide = (id: string, modelId: string, hidden: boolean) =>
  read(hiddenModels.PUT(jsonRequest(`/api/connections/${id}/hidden-models`, "PUT", { modelId, hidden }), params(id)));
const setDefaults = (body: unknown) => read(defaults.PUT(jsonRequest("/api/preferences/model", "PUT", body)));

function sql<T>(query: string, ...args: unknown[]) {
  return getDb().$client.prepare(query).get(...args) as T;
}

let openaiId = "";
let anthropicId = "";

test("a new connection lists its models with its key first, and every response shows keySet and no key", async () => {
  const from = provider.length;
  const saved = await create({ kind: "openai-compatible", label: "Local", baseUrl: `http://proxyuser:${URL_SECRET}@${providerBase.slice("http://".length)}/v1`, apiKey: OPENAI_KEY });
  assert.ok(saved.status >= 200 && saved.status < 300, `POST returned ${saved.status}: ${saved.text}`);
  const openai = saved.json() as Connection & Record<string, unknown>;
  assert.equal(openai.kind, "openai-compatible");
  assert.equal(openai.label, "Local");
  assert.equal(openai.keySet, true);
  assert.equal("apiKey" in openai, false);
  assert.equal(saved.text.includes(URL_SECRET), false, `the base URL is not masked: ${saved.text}`);
  openaiId = openai.id;
  assert.ok(provider.slice(from).some((request) => request.path === "/v1/models" && request.headers.authorization === `Bearer ${OPENAI_KEY}`), "the model list was not fetched first");

  const claude = await create({ kind: "anthropic", label: "Claude", apiKey: ANTHROPIC_KEY });
  assert.ok(claude.status >= 200 && claude.status < 300, `POST returned ${claude.status}: ${claude.text}`);
  assert.equal(claude.json().kind, "anthropic");
  anthropicId = claude.json().id;
  assert.ok(provider.some((request) => request.headers["x-api-key"] === ANTHROPIC_KEY), "the Anthropic model list was not fetched");

  const listed = await list();
  assert.deepEqual(listed.map((connection) => [connection.id, connection.kind, connection.keySet]).sort(), [
    [anthropicId, "anthropic", true],
    [openaiId, "openai-compatible", true],
  ].sort());
});

test("a provider that cannot list models is not saved", async () => {
  const before = (await list()).length;
  const refused = await create({ kind: "openai-compatible", label: "Broken", baseUrl: `${providerBase}/v1`, apiKey: "made-up-wrong-key-0001" });
  assert.equal(refused.status, 502);
  assert.equal((await list()).length, before);
});

test("the database file holds no key bytes", () => {
  for (const name of ["orbit.db", "orbit.db-wal"]) {
    const file = path.join(dataDirectory(), name);
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    for (const key of [OPENAI_KEY, ANTHROPIC_KEY]) assert.equal(bytes.includes(Buffer.from(key)), false, `${name} holds ${key}`);
  }
});

test("another user's connection is not found", async () => {
  asUser(TWO);
  try {
    assert.deepEqual(await list(), []);
    assert.equal((await patch(openaiId, { label: "Taken" })).status, 404);
    assert.equal((await remove(openaiId)).status, 404);
    assert.equal((await modelsOf(openaiId)).status, 404);
    assert.equal((await hide(openaiId, "fixture-model", true)).status, 404);
    assert.equal((await setDefaults({ connectionId: openaiId, model: "fixture-model", effort: "high" })).status, 404);
  } finally {
    asUser(ONE);
  }
  assert.equal((await list()).find((connection) => connection.id === openaiId)?.label, "Local");
});

test("hiding a model on another user's connection writes nothing and answers not found", () => {
  const hidden = setModelHidden(TWO, openaiId, "fixture-model", true);
  assert.deepEqual(sql("select count(*) as n from hidden_models where user_id = ?", TWO), { n: 0 });
  assert.equal(hidden, false);
});

test("a new base URL without a key is rejected, and the saved key goes nowhere", async () => {
  const from = provider.length;
  const moved = await patch(openaiId, { baseUrl: `${elsewhereBase}/v1` });
  assert.equal(moved.status, 400);
  assert.equal(elsewhere.length, 0, "the other host got a request");
  assert.equal(provider.slice(from).some((request) => request.headers.authorization === `Bearer ${OPENAI_KEY}`), false);
  const kept = (await list()).find((connection) => connection.id === openaiId);
  assert.ok(kept?.baseUrl?.includes(providerBase.slice("http://".length)), `the saved base URL changed: ${kept?.baseUrl}`);
});

test("resending the masked base URL keeps the saved URL and key", async () => {
  const shown = (await list()).find((connection) => connection.id === openaiId);
  assert.ok(shown?.baseUrl);
  const renamed = await patch(openaiId, { label: "Renamed", baseUrl: shown.baseUrl });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.json().label, "Renamed");
  const from = provider.length;
  const listed = await modelsOf(openaiId);
  assert.equal(listed.status, 200, listed.text);
  assert.ok((listed.json().models as { id: string }[]).some((model) => model.id === "fixture-model"));
  assert.ok(provider.slice(from).some((request) => request.path === "/v1/models" && request.headers.authorization === `Bearer ${OPENAI_KEY}`), "the saved key and URL were not used");
});

test("a label that holds the API key is refused on create and edit, so no plain copy is stored", async () => {
  const before = await list();
  const pasted = await create({ kind: "anthropic", label: `Claude ${ANTHROPIC_KEY}`, apiKey: ANTHROPIC_KEY });
  assert.equal(pasted.status, 400, pasted.text);
  assert.equal((await list()).length, before.length, "the connection was saved");
  const renamed = await patch(openaiId, { label: `Local ${OPENAI_KEY}` });
  assert.equal(renamed.status, 400, renamed.text);
  const NEW_KEY = "made-up-anthropic-key-0002";
  const rekeyed = await patch(anthropicId, { label: `Claude ${NEW_KEY}`, apiKey: NEW_KEY });
  assert.equal(rekeyed.status, 400, rekeyed.text);
  assert.deepEqual(await list(), before, "a refused edit changed a connection");
  assert.deepEqual(sql("select count(*) as n from provider_connections where label like '%made-up%'"), { n: 0 });
});

test("an unreadable key's error does not name the connection", async () => {
  const LABEL = "Label that is not in the error";
  getDb()
    .$client.prepare("insert into provider_connections (id, user_id, kind, label, base_url, api_key_ciphertext, created_at) values ('conn-unreadable', ?, 'anthropic', ?, null, 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 0)")
    .run(ONE, LABEL);
  try {
    const listed = await modelsOf("conn-unreadable");
    assert.equal(listed.status, 400, listed.text);
    assert.equal(listed.text.includes(LABEL), false, listed.text);
  } finally {
    getDb().$client.prepare("delete from provider_connections where id = 'conn-unreadable'").run();
  }
});

test("a hidden model stays listed and is named in hidden until it is shown again", async () => {
  assert.equal((await hide(openaiId, "openai/gpt-5", true)).status, 200);
  const hidden = (await modelsOf(openaiId)).json() as { models: { id: string }[]; hidden: string[] };
  assert.deepEqual(hidden.hidden, ["openai/gpt-5"]);
  assert.ok(hidden.models.some((model) => model.id === "openai/gpt-5"));
  assert.equal((await hide(openaiId, "openai/gpt-5", false)).status, 200);
  assert.deepEqual(((await modelsOf(openaiId)).json() as { hidden: string[] }).hidden, []);
});

test("a model id that repeats a credential of the user is masked before the list is cached or returned", async () => {
  const listed = await modelsOf(openaiId);
  assert.equal(listed.status, 200, listed.text);
  for (const secret of ECHOED) {
    assert.equal(listed.text.includes(secret), false, `the list returned ${secret}`);
    assert.equal(cachedCaps(openaiId, `echo-${secret}`), null, `the caps cache holds the plain id echo-${secret}`);
  }
  assert.ok((listed.json().models as { id: string }[]).some((model) => model.id === "echo-[redacted]"), listed.text);
  assert.ok(cachedCaps(openaiId, "echo-[redacted]"), "the masked id has no cached caps");
});

test("deleting a connection clears the chats and defaults that use it, and old replies keep their model and effort", async () => {
  savePreferences(ONE, { theme: "light", accent: "rose" });
  assert.equal((await setDefaults({ connectionId: openaiId, model: "fixture-model", effort: "high" })).status, 200);
  for (const [chatId, connectionId, model] of [["chat-uses-openai", openaiId, "fixture-model"], ["chat-uses-claude", anthropicId, "claude-opus-5-5"]]) {
    ensureChat(chatId, ONE);
    getDb().$client.prepare("update chats set connection_id = ?, model = ?, reasoning_effort = 'high' where id = ?").run(connectionId, model, chatId);
  }
  getDb()
    .$client.prepare(
      "insert into messages (id, chat_id, parent_id, role, content, parts, position, created_at, connection_id, model, reasoning_effort, effort_outcome) values ('reply-old', 'chat-uses-openai', null, 'assistant', 'old reply', '[]', 0, 0, ?, 'fixture-model', 'high', 'applied')",
    )
    .run(openaiId);

  const deleted = await remove(openaiId);
  assert.ok(deleted.status >= 200 && deleted.status < 300, `DELETE returned ${deleted.status}: ${deleted.text}`);

  assert.deepEqual((await list()).map((connection) => connection.id), [anthropicId]);
  assert.deepEqual(sql("select connection_id, model, reasoning_effort from chats where id = 'chat-uses-openai'"), { connection_id: null, model: null, reasoning_effort: null });
  assert.deepEqual(sql("select connection_id, model, reasoning_effort from chats where id = 'chat-uses-claude'"), { connection_id: anthropicId, model: "claude-opus-5-5", reasoning_effort: "high" });
  assert.deepEqual(sql("select default_connection_id, default_model from user_preferences where user_id = ?", ONE), { default_connection_id: null, default_model: null });
  assert.deepEqual(sql("select connection_id, model, reasoning_effort, effort_outcome, content from messages where id = 'reply-old'"), {
    connection_id: null,
    model: "fixture-model",
    reasoning_effort: "high",
    effort_outcome: "applied",
    content: "old reply",
  });
  const appearance = getPreferences(ONE);
  assert.equal(appearance.theme, "light");
  assert.equal(appearance.accent, "rose");
});

test("no response in this file carried a key", () => {
  assert.ok(bodies.length > 0);
  for (const body of bodies) {
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, TAVILY_KEY, URL_SECRET]) assert.equal(body.includes(secret), false, `a response carried ${secret}: ${body}`);
  }
});
