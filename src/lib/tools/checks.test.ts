import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before, beforeEach, type TestContext } from "node:test";
import type Docker from "dockerode";
import { startMockMcp, type MockMcp } from "../../../scripts/qa/mock-mcp.mjs";
import type { MockSearxng } from "../../../scripts/qa/mock-searxng.mjs";
import { getDb } from "../db";
import { user } from "../db/schema";
import { eventually } from "../eventually.mjs";
import { saveInstance } from "../instance-settings";
import { ollamaStatus } from "../memory/embed";
import { saveMemory } from "../memory/store";
import { parseViewer, type Viewer } from "../policy";
import { savePreferences } from "../preferences";
import { sandboxImages } from "../sandbox/images";
import { sandboxDocker, type runCode } from "../sandbox/run";
import { saveGithub } from "../user-github";
import { resetToolCheckRateLimit, runToolCheck } from "./checks";
import { searchSearxng, type SearchBackends } from "./search";

process.env.ORBIT_GITHUB_MCP_FIXTURE = "1";

// The test route reads the session from request headers, which need a Next.js request scope. This stub
// returns whichever user a test signs in as.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-tool-checks-"));
const sessionStub = path.join(stubDir, "session.cjs");
fs.writeFileSync(sessionStub, `exports.sessionFrom = async () => (globalThis.__orbitSignedIn ? { user: globalThis.__orbitSignedIn } : null);
exports.unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/session") return { url: pathToFileURL(sessionStub).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const signedIn = globalThis as { __orbitSignedIn?: Viewer | null };

const sqlite = getDb().$client;
const admin = parseViewer({ id: "checks-admin", role: "admin" });
const TAVILY_KEY = "made-up-tavily-key-0002";
const WRONG_TOKEN = "wrong-github-token-0004";
const CLOSED_URL = "http://127.0.0.1:9";
const IMAGE_MISSING = `Sandbox image is missing. Run docker pull ${sandboxImages.python.image}`;

let mcp: MockMcp;
let searxng: MockSearxng;
let ollama: { url: string; mode: "ok" | "fail"; close: () => Promise<void> };
let users = 0;
const restoreEnv = Object.fromEntries(["ORBIT_OLLAMA_URL", "ORBIT_SANDBOX", "DOCKER_HOST"].map((name) => [name, process.env[name]]));

function freshUser(): Viewer {
  users += 1;
  const id = `checks-user-${users}`;
  getDb().insert(user).values({ id, name: id, email: `${id}@orbit.test`, role: "member" }).run();
  return parseViewer({ id, role: "member" });
}

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

// An Ollama stand-in on one fixed URL, so a cached failure for that URL can go stale.
async function startOllama() {
  const state = { mode: "ok" as "ok" | "fail" };
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/embed") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (state.mode === "fail") {
        response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "ollama down" }));
        return;
      }
      const input = (JSON.parse(raw || "{}") as { input?: unknown }).input;
      const texts = Array.isArray(input) ? input : [input];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ embeddings: texts.map(() => Array.from({ length: 768 }, (_, index) => Number(index === 0))) }));
    });
  });
  const url = await listen(server);
  return {
    url,
    get mode() { return state.mode; },
    set mode(value: "ok" | "fail") { state.mode = value; },
    close: () => close(server),
  };
}

before(async () => {
  mcp = await startMockMcp();
  // The fixture keeps a top-level await for its command-line use, so it loads as ESM.
  const { startMockSearxng } = await import("../../../scripts/qa/mock-searxng.mjs");
  searxng = await startMockSearxng();
  ollama = await startOllama();
  process.env.ORBIT_OLLAMA_URL = ollama.url;
  getDb().insert(user).values({ id: admin.id, name: "Admin", email: "checks-admin@orbit.test", role: "admin" }).run();
});

after(async () => {
  hooks.deregister();
  await mcp?.close();
  await searxng?.close();
  await ollama?.close();
  for (const [name, value] of Object.entries(restoreEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  sqlite.close();
  fs.rmSync(stubDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetToolCheckRateLimit();
});

function setEnv(t: TestContext, name: string, value: string | undefined) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

function statusRows(userId: string) {
  return sqlite.prepare("SELECT tool_id AS toolId, last_ok_at AS lastOkAt, last_failed_at AS lastFailedAt, last_error AS lastError FROM tool_status WHERE user_id = ? ORDER BY tool_id")
    .all(userId) as { toolId: string; lastOkAt: number | null; lastFailedAt: number | null; lastError: string | null }[];
}

function statusRow(userId: string, toolId: string) {
  return statusRows(userId).find((row) => row.toolId === toolId);
}

const live = () => new AbortController().signal;

function assertPassed(response: Awaited<ReturnType<typeof runToolCheck>>, summary: string) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.ok && response.summary, summary);
  assert.equal(typeof response.ms, "number");
  assert.ok(response.ms >= 0);
  assert.equal(response.tool.status, "working");
  assert.equal(response.tool.health.state, "working");
}

function assertFailed(response: Awaited<ReturnType<typeof runToolCheck>>, error: string) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(!response.ok && response.error, error);
  assert.equal(response.tool.status, "failing");
  assert.equal(response.tool.health.state === "failing" && response.tool.health.error, error);
}

test("testing Web search against SearXNG reports the result count and records a good call", async () => {
  assert.ok(saveInstance(admin.id, { searxngUrl: searxng.url, tavilyApiKey: null }).ok);
  const seen = searxng.requests.length;
  const response = await runToolCheck(admin, "web_search", live());
  assertPassed(response, "3 results");
  assert.deepEqual(searxng.requests.slice(seen), ["orbit"]);
  assert.equal(response.tool.id, "web_search");
  const row = statusRow(admin.id, "web_search");
  assert.ok(row?.lastOkAt);
  assert.equal(row.lastFailedAt, null);
});

test("one search result reads as 1 result", async () => {
  assert.ok(saveInstance(admin.id, { searxngUrl: "https://search.example", tavilyApiKey: null }).ok);
  const one: SearchBackends["searxng"] = async () => [{ title: "Orbit", url: "https://example.com/orbit", snippet: "", engine: "searxng" }];
  assertPassed(await runToolCheck(admin, "web_search", live(), { searchBackends: { searxng: one, tavily: async () => [] } }), "1 result");
});

test("testing Web search against a closed port fails without the URL or the Tavily key", async () => {
  assert.ok(saveInstance(admin.id, { searxngUrl: CLOSED_URL, tavilyApiKey: TAVILY_KEY }).ok);
  const tavily: SearchBackends["tavily"] = async (key) => {
    throw new Error(`Tavily rejected ${key} at ${CLOSED_URL}`);
  };
  const response = await runToolCheck(admin, "web_search", live(), { searchBackends: { searxng: searchSearxng, tavily } });
  assertFailed(response, "Search is unavailable");
  const row = statusRow(admin.id, "web_search");
  assert.equal(row?.lastError, "Search is unavailable");
  for (const secret of [CLOSED_URL, "127.0.0.1:9", TAVILY_KEY]) {
    assert.equal(JSON.stringify(response).includes(secret), false, `the response holds ${secret}`);
    assert.equal(JSON.stringify(statusRows(admin.id)).includes(secret), false, `tool_status holds ${secret}`);
  }
});

test("a search backend that times out fails with Search timed out", async () => {
  assert.ok(saveInstance(admin.id, { searxngUrl: "https://search.example", tavilyApiKey: null }).ok);
  const slow: SearchBackends["searxng"] = async () => {
    throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  };
  assertFailed(await runToolCheck(admin, "web_search", live(), { searchBackends: { searxng: slow, tavily: async () => [] } }), "Search timed out");
});

function noOpenSessions() {
  return eventually(() => mcp.openSessions(), (open) => open === 0, { timeoutMs: 2_000, intervalMs: 20, what: "every MCP session to close" });
}

test("testing GitHub reports the login and closes the MCP session", async () => {
  const account = freshUser();
  assert.ok(saveGithub(account.id, { githubToken: mcp.token, githubMcpUrl: mcp.url }).ok);
  const response = await runToolCheck(account, "github", live());
  assertPassed(response, "octocat");
  await noOpenSessions();
  assert.equal(JSON.stringify(response).includes(mcp.token), false);
});

test("testing GitHub with a rejected token fails without the token in the answer or the database", async () => {
  const account = freshUser();
  assert.ok(saveGithub(account.id, { githubToken: WRONG_TOKEN, githubMcpUrl: mcp.url }).ok);
  const response = await runToolCheck(account, "github", live());
  assertFailed(response, "GitHub rejected the token.");
  assert.equal(JSON.stringify(response).includes(WRONG_TOKEN), false);
  assert.equal(statusRow(account.id, "github")?.lastError, "GitHub rejected the token.");
  assert.equal(JSON.stringify(statusRows(account.id)).includes(WRONG_TOKEN), false);
  await noOpenSessions();
});

const runOutput = (patch: Record<string, unknown> = {}) => ({ stdout: "1\n", stderr: "", exitCode: 0, durationMs: 40, timedOut: false, truncated: false, ...patch });

// A runner that records what it was asked to run and reports whether its cleanup finished before the check answered.
function runner(result: () => Promise<unknown>) {
  const received: unknown[] = [];
  const cleanup = { done: false };
  const run = ((_docker, input) => {
    received.push(input);
    return {
      result: result(),
      cleanup: new Promise((resolve) => setImmediate(() => setImmediate(() => {
        cleanup.done = true;
        resolve("removed");
      }))),
    };
  }) as typeof runCode;
  return { run, received, cleanup };
}

const fakeDocker = () => ({}) as Docker;

function sandboxReady(t: TestContext) {
  setEnv(t, "ORBIT_SANDBOX", "on");
  assert.ok(saveInstance(admin.id, { sandbox: "on" }).ok);
}

test("testing the sandbox runs print(1) and answers Exit 0 after the container is removed", async (t) => {
  sandboxReady(t);
  const fake = runner(async () => runOutput());
  const response = await runToolCheck(admin, "run_code", live(), { runCode: fake.run, docker: fakeDocker });
  assertPassed(response, "Exit 0");
  assert.deepEqual(fake.received, [{ language: "python", code: "print(1)" }]);
  assert.equal(fake.cleanup.done, true, "the check answered before the container was removed");
});

test("each sandbox failure answers its fixed message after the container is removed", async (t) => {
  sandboxReady(t);
  const dockerError = (statusCode: number) => Object.assign(new Error(`(HTTP code ${statusCode}) private-sandbox-payload`), { statusCode });
  const table: Array<[string, () => Promise<unknown>, string]> = [
    ["missing image", async () => { throw dockerError(404); }, IMAGE_MISSING],
    ["proxy denial", async () => { throw dockerError(403); }, "Sandbox access was denied. Check the Docker proxy."],
    ["Docker failure", async () => { throw dockerError(500); }, "Code sandbox failed. Check the server logs."],
    ["unexpected stdout", async () => runOutput({ stdout: "2\n" }), "Code sandbox returned unexpected output."],
    ["non-zero exit", async () => runOutput({ stdout: "", stderr: "Traceback", exitCode: 1 }), "Code sandbox returned unexpected output."],
    ["timeout", async () => runOutput({ stdout: "", exitCode: null, timedOut: true }), "Code sandbox timed out."],
    ["out of memory", async () => runOutput({ stdout: "", exitCode: 137, oomKilled: true }), "Code sandbox out of memory."],
  ];
  for (const [name, result, error] of table) {
    resetToolCheckRateLimit();
    const fake = runner(result);
    const response = await runToolCheck(admin, "run_code", live(), { runCode: fake.run, docker: fakeDocker });
    assertFailed(response, error);
    assert.equal(fake.cleanup.done, true, `${name}: the check answered before the container was removed`);
    assert.equal(statusRow(admin.id, "run_code")?.lastError, error, name);
    assert.equal(JSON.stringify(response).includes("private-sandbox"), false, name);
  }
});

test("an invalid DOCKER_HOST answers the configuration message without the endpoint", async (t) => {
  sandboxReady(t);
  setEnv(t, "DOCKER_HOST", "tcp://private-sandbox-endpoint:2375");
  const fake = runner(async () => runOutput());
  const response = await runToolCheck(admin, "run_code", live(), { runCode: fake.run });
  assertFailed(response, "Sandbox configuration is invalid. Check DOCKER_HOST on the server.");
  assert.deepEqual(fake.received, [], "nothing ran without a Docker client");
  assert.equal(JSON.stringify(response).includes("private-sandbox-endpoint"), false);
});

test("a real Docker sandbox answers Exit 0", { timeout: 90_000 }, async (t) => {
  try {
    const docker = sandboxDocker();
    await docker.ping();
    await docker.getImage(sandboxImages.python.image).inspect();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
    if (!["ECONNREFUSED", "ENOENT", "EACCES", "ENOTFOUND", "EHOSTUNREACH"].includes(code) && status !== 404) throw error;
    t.skip("Docker or the Python sandbox image is unavailable.");
    return;
  }
  sandboxReady(t);
  assertPassed(await runToolCheck(admin, "run_code", live()), "Exit 0");
});

test("testing Memory counts the account's memories while Ollama answers", async () => {
  const account = freshUser();
  assertPassed(await runToolCheck(account, "memory", live()), "0 memories");
  saveMemory(account.id, { text: "I prefer green tea", kind: "preference", source: "user" });
  resetToolCheckRateLimit();
  assertPassed(await runToolCheck(account, "memory", live()), "1 memory");
});

test("testing Memory with Ollama down still passes on text search", async (t) => {
  setEnv(t, "ORBIT_OLLAMA_URL", CLOSED_URL);
  const account = freshUser();
  saveMemory(account.id, { text: "I prefer green tea", kind: "preference", source: "user" });
  saveMemory(account.id, { text: "I deploy to Fly.io", kind: "fact", source: "user" });
  assertPassed(await runToolCheck(account, "memory", live()), "2 memories · Text search only");
});

test("testing Memory asks Ollama again instead of trusting a cached failure", async () => {
  ollama.mode = "fail";
  try {
    assert.equal((await ollamaStatus()).ok, false);
    ollama.mode = "ok";
    assert.equal((await ollamaStatus()).ok, false, "the failure is still cached for this URL");
    assertPassed(await runToolCheck(freshUser(), "memory", live()), "0 memories");
  } finally {
    ollama.mode = "ok";
  }
});

test("a Memory storage failure answers Memory storage is unavailable", async () => {
  const account = freshUser();
  const broken = () => {
    throw Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
  };
  assertFailed(await runToolCheck(account, "memory", live(), { memoryCount: broken }), "Memory storage is unavailable.");
  resetToolCheckRateLimit();
  assertFailed(await runToolCheck(account, "memory", live(), { textMatchIds: broken }), "Memory storage is unavailable.");
  assert.equal(statusRow(account.id, "memory")?.lastError, "Memory storage is unavailable.");
});

type TestRoute = typeof import("@/app/api/tools/[id]/test/route");

async function press(viewer: Viewer, id: string) {
  signedIn.__orbitSignedIn = viewer;
  const route: TestRoute = await import("@/app/api/tools/[id]/test/route");
  const response = await route.POST(new Request(`http://127.0.0.1/api/tools/${id}/test`, { method: "POST" }), { params: Promise.resolve({ id }) });
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
}

// A SearXNG stand-in that holds its first answer until the test releases it.
async function heldSearxng(t: TestContext) {
  const held = Promise.withResolvers<void>();
  let count = 0;
  const server = http.createServer((request, response) => {
    count += 1;
    void held.promise.then(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [
        { title: "Orbit guide", url: "https://example.com/orbit", content: "A guide." },
        { title: "Space report", url: "https://example.org/space", content: "Space." },
        { title: "Orbit news", url: "https://example.net/news", content: "News." },
      ] }));
    });
  });
  const url = await listen(server);
  t.after(() => {
    held.resolve();
    return close(server);
  });
  return { url, count: () => count, release: () => held.resolve() };
}

function assertWait(answer: Awaited<ReturnType<typeof press>>) {
  assert.equal(answer.status, 429);
  assert.deepEqual(answer.body, { error: "Wait a moment before testing again." });
  const seconds = Number(answer.retryAfter);
  assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 10, `Retry-After ${answer.retryAfter}`);
}

test("a second test of the same tool waits while one runs and for 10 seconds after it starts, but not for another tool or user", async (t) => {
  const held = await heldSearxng(t);
  assert.ok(saveInstance(admin.id, { searxngUrl: held.url, tavilyApiKey: null }).ok);
  const member = freshUser();

  const first = press(admin, "web_search");
  await eventually(() => held.count(), (count) => count >= 1, { timeoutMs: 5_000, what: "the first test to reach SearXNG" });
  assertWait(await press(admin, "web_search"));
  assert.equal(held.count(), 1, "the refused test never reached SearXNG");
  held.release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(done.body.ok, true);
  assert.equal(done.body.summary, "3 results");

  assertWait(await press(admin, "web_search"));
  assert.equal(held.count(), 1);
  const otherTool = await press(admin, "memory");
  assert.equal(otherTool.status, 200, JSON.stringify(otherTool.body));
  const otherUser = await press(member, "web_search");
  assert.equal(otherUser.status, 200, JSON.stringify(otherUser.body));
  assert.equal(otherUser.body.summary, "3 results");
});

test("a check that outlives a settings save records nothing and answers the tool as the new settings leave it", async (t) => {
  const held = await heldSearxng(t);
  assert.ok(saveInstance(admin.id, { searxngUrl: held.url, tavilyApiKey: null }).ok);
  const checking = runToolCheck(admin, "web_search", live());
  await eventually(() => held.count(), (count) => count >= 1, { timeoutMs: 5_000, what: "the check to reach SearXNG" });
  assert.ok(saveInstance(admin.id, { searxngUrl: "https://search.example" }).ok);
  held.release();
  const response = await checking;
  assert.equal(response.ok && response.summary, "3 results");
  assert.equal(response.tool.health.state, "untested");
  assert.equal(statusRow(admin.id, "web_search"), undefined);
});

test("an off tool answers 409 with its fixed message, writes nothing, and leaves the next test free", async (t) => {
  const account = freshUser();
  const refusals: Array<[string, Viewer, () => void, string]> = [
    ["web_search", admin, () => { assert.ok(saveInstance(admin.id, { searxngUrl: "", tavilyApiKey: null }).ok); }, "Web search is not configured."],
    ["web_search", admin, () => { sqlite.prepare("UPDATE instance_settings SET searxng_url = '', tavily_key_ciphertext = 'unreadable-ciphertext'").run(); }, "Saved Tavily key is unreadable."],
    ["web_search", account, () => { sqlite.prepare("UPDATE instance_settings SET searxng_url = '', tavily_key_ciphertext = 'unreadable-ciphertext'").run(); }, "Web search is not configured."],
    ["run_code", account, () => { delete process.env.ORBIT_SANDBOX; }, "Code sandbox is off on this server."],
    ["run_code", account, () => { process.env.ORBIT_SANDBOX = "on"; assert.ok(saveInstance(admin.id, { sandbox: "off" }).ok); }, "Code sandbox is turned off."],
    ["github", account, () => { assert.ok(saveGithub(account.id, { githubToken: null }).ok); }, "Add a GitHub token."],
    ["github", account, () => {
      assert.ok(saveGithub(account.id, { githubToken: WRONG_TOKEN }).ok);
      sqlite.prepare("UPDATE user_github SET token_ciphertext = 'unreadable-ciphertext' WHERE user_id = ?").run(account.id);
    }, "Saved GitHub token is unreadable. Enter it again."],
    ["memory", account, () => { savePreferences(account.id, { memory: "off" }); }, "Memory is turned off."],
  ];
  setEnv(t, "ORBIT_SANDBOX", process.env.ORBIT_SANDBOX);
  try {
    for (const [id, viewer, arrange, error] of refusals) {
      arrange();
      const answer = await press(viewer, id);
      assert.deepEqual({ status: answer.status, body: answer.body }, { status: 409, body: { error } }, `${id} for ${viewer.role}`);
      assert.equal(statusRow(viewer.id, id), undefined, `${id} wrote tool_status`);
    }
  } finally {
    sqlite.prepare("UPDATE instance_settings SET tavily_key_ciphertext = ''").run();
  }
  savePreferences(account.id, { memory: "on" });
  const next = await press(account, "memory");
  assert.equal(next.status, 200, "a refused test does not start the 10 second wait");
  assert.equal(next.body.ok, true);
});
