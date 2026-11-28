import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { startMockMcp, type MockMcp } from "../../../../scripts/qa/mock-mcp.mjs";
import { getDb } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { eventually } from "@/lib/eventually.mjs";
import { saveInstance } from "@/lib/instance-settings";
import { parseViewer, type Viewer } from "@/lib/policy";
import { saveGithub } from "@/lib/user-github";

process.env.ORBIT_GITHUB_MCP_FIXTURE = "1";

// The routes read the session from request headers, which need a Next.js request scope. This stub
// returns whichever user a test signs in as, or no session.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-tools-route-"));
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
const admin = parseViewer({ id: "tools-admin", role: "admin" });
const member = parseViewer({ id: "tools-member", role: "member" });
const TAVILY_KEY = "made-up-tavily-key-0002";
const CLOSED_URL = "http://127.0.0.1:9";
const DRAFT_TOKEN = "draft-github-token-0005";

type ListRoute = typeof import("./route");
type InspectRoute = typeof import("./[id]/route");
type TestRoute = typeof import("./[id]/test/route");
type CheckRoute = typeof import("../settings/github/check/route");

let mcp: MockMcp;
let checkRoute: CheckRoute;
const bodies: string[] = [];
const originalEnv = Object.fromEntries(["ORBIT_SANDBOX", "ORBIT_OLLAMA_URL"].map((name) => [name, process.env[name]]));
process.env.ORBIT_OLLAMA_URL = CLOSED_URL;

before(async () => {
  mcp = await startMockMcp();
  for (const viewer of [admin, member]) {
    getDb().insert(user).values({ id: viewer.id, name: viewer.id, email: `${viewer.id}@orbit.test`, role: viewer.role }).run();
  }
  assert.ok(saveInstance(admin.id, { searxngUrl: CLOSED_URL, tavilyApiKey: TAVILY_KEY }).ok);
  assert.ok(saveGithub(admin.id, { githubToken: mcp.token, githubMcpUrl: mcp.url }).ok);
  checkRoute = await import("../settings/github/check/route");
});

after(async () => {
  hooks.deregister();
  await mcp?.close();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  sqlite.close();
  fs.rmSync(stubDir, { recursive: true, force: true });
});

function signIn(viewer: Viewer | null) {
  signedIn.__orbitSignedIn = viewer;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function read(response: Response) {
  const text = await response.text();
  bodies.push(text);
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: text ? JSON.parse(text) : null };
}

async function list() {
  const route: ListRoute = await import("./route");
  return read(await route.GET(new Request("http://127.0.0.1/api/tools")));
}

async function inspect(id: string, signal?: AbortSignal) {
  const route: InspectRoute = await import("./[id]/route");
  return read(await route.GET(new Request(`http://127.0.0.1/api/tools/${id}`, { signal }), params(id)));
}

// Each (user, tool) pair is pressed in one test only, so the 10 second wait never crosses tests.
async function press(id: string, signal?: AbortSignal) {
  const route: TestRoute = await import("./[id]/test/route");
  return read(await route.POST(new Request(`http://127.0.0.1/api/tools/${id}/test`, { method: "POST", signal }), params(id)));
}

async function check(input: object) {
  return read(await checkRoute.POST(new Request("http://127.0.0.1/api/settings/github/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })));
}

function githubRow(userId: string) {
  return sqlite.prepare("SELECT last_ok_at AS lastOkAt, last_failed_at AS lastFailedAt, last_error AS lastError FROM tool_status WHERE user_id = ? AND tool_id = 'github'")
    .get(userId) as { lastOkAt: number | null; lastFailedAt: number | null; lastError: string | null } | undefined;
}

function noOpenSessions() {
  return eventually(() => mcp.openSessions(), (open) => open === 0, { timeoutMs: 2_000, intervalMs: 20, what: "every MCP session to close" });
}

test("every tools route answers 401 when signed out", async () => {
  signIn(null);
  assert.equal((await list()).status, 401);
  assert.equal((await inspect("web_search")).status, 401);
  assert.equal((await press("web_search")).status, 401);
});

test("GET /api/tools lists the five tools in order without connecting to GitHub", async () => {
  signIn(admin);
  const seen = mcp.requests.length;
  const answer = await list();
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.tools.map((tool: { id: string }) => tool.id), ["web_search", "run_code", "github", "memory", "render_ui"]);
  assert.equal(mcp.requests.length, seen, "listing tools never reached the MCP server");
  assert.deepEqual(answer.body.tools[4], {
    id: "render_ui",
    label: "Generated UI",
    scope: "built-in",
    setup: { state: "ready" },
    health: { state: "untested" },
    status: "ready",
    canTest: false,
    toggleable: false,
    configureHref: null,
  });
  assert.equal(answer.body.tools[2].status, "untested", "a saved GitHub token is ready but untested");
});

test("GET /api/tools/[id] answers 404 for an unknown or oversized id", async () => {
  signIn(admin);
  for (const id of ["nope", "remember", "mcp:server", "x".repeat(101)]) {
    assert.equal((await inspect(id)).status, 404, id);
  }
  assert.deepEqual((await inspect("web_search")).body.id, "web_search");
});

test("GET /api/tools/github shows a member's own empty GitHub setup, not the admin's token", async () => {
  signIn(member);
  const seen = mcp.requests.length;
  const answer = await inspect("github");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { id: "github", setup: { state: "missing", configure: "self" }, instruction: null, tools: [] });
  assert.equal(mcp.requests.length, seen);
});

test("POST /api/tools/[id]/test refuses Generated UI with 400 and an unknown id with 404", async () => {
  signIn(admin);
  const ui = await press("render_ui");
  assert.equal(ui.status, 400);
  assert.equal(typeof ui.body.error, "string");
  assert.equal((await press("nope")).status, 404);
  assert.equal((await press("x".repeat(101))).status, 404);
});

test("POST /api/tools/[id]/test answers 409 for a tool that is off", async () => {
  delete process.env.ORBIT_SANDBOX;
  signIn(admin);
  assert.deepEqual(await press("run_code"), { status: 409, retryAfter: null, body: { error: "Code sandbox is off on this server." } });
});

test("a failing backend answers 200 with ok false and the row it updated, then a repeat press waits", async () => {
  // SearXNG alone, so the check never calls Tavily over the network.
  assert.ok(saveInstance(admin.id, { tavilyApiKey: null }).ok);
  signIn(admin);
  const failed = await press("web_search");
  assert.equal(failed.status, 200);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.error, "Search is unavailable");
  assert.equal(typeof failed.body.ms, "number");
  assert.equal(failed.body.tool.id, "web_search");
  assert.equal(failed.body.tool.status, "failing");
  const again = await press("web_search");
  assert.equal(again.status, 429);
  assert.deepEqual(again.body, { error: "Wait a moment before testing again." });
  assert.ok(Number(again.retryAfter) >= 1, `Retry-After ${again.retryAfter}`);
  const listed = await list();
  assert.equal(listed.body.tools[0].status, "failing", "the 429 left the stored status alone");
});

test("a test the client abandons answers 499 and records nothing", async () => {
  signIn(member);
  const controller = new AbortController();
  controller.abort();
  const answer = await press("memory", controller.signal);
  assert.equal(answer.status, 499);
  assert.equal(sqlite.prepare("SELECT count(*) FROM tool_status WHERE user_id = ?").pluck().get(member.id), 0);
});

test("Check in Settings records GitHub status for the saved token and leaves it alone for a draft token or URL", async () => {
  signIn(admin);
  const saved = await check({});
  assert.deepEqual(saved.body, { ok: true, login: "octocat" });
  await noOpenSessions();
  const recorded = githubRow(admin.id);
  assert.ok(recorded?.lastOkAt, "a check of the saved token is recorded");
  assert.equal(recorded.lastFailedAt, null);
  assert.equal((await list()).body.tools[2].status, "working");

  const draft = await check({ token: DRAFT_TOKEN });
  assert.deepEqual(draft.body, { ok: false, error: "GitHub rejected the token." });
  assert.deepEqual(githubRow(admin.id), recorded, "a draft token leaves the saved status alone");

  const draftUrl = await check({ mcpUrl: `${mcp.url}?mode=bad-request` });
  assert.deepEqual(draftUrl.body, { ok: false, error: "GitHub rejected the token (bad request)." });
  assert.deepEqual(githubRow(admin.id), recorded, "a draft URL leaves the saved status alone");

  await eventually(() => Date.now(), (now) => now > (recorded.lastOkAt ?? 0), { timeoutMs: 1_000, intervalMs: 1, what: "the clock to pass the first check" });
  const sameUrl = await check({ mcpUrl: mcp.url });
  assert.deepEqual(sameUrl.body, { ok: true, login: "octocat" });
  assert.ok((githubRow(admin.id)?.lastOkAt ?? 0) > (recorded.lastOkAt ?? 0), "the saved URL sent again counts as the saved credentials");
  await noOpenSessions();
});

test("no tools response carries the Tavily key, a GitHub token, or the SearXNG URL", async () => {
  assert.ok(saveInstance(admin.id, { tavilyApiKey: TAVILY_KEY }).ok);
  signIn(admin);
  await list();
  await inspect("web_search");
  await inspect("github");
  await noOpenSessions();
  signIn(member);
  await list();
  await inspect("web_search");
  assert.ok(bodies.length > 10);
  for (const body of bodies) {
    for (const secret of [TAVILY_KEY, mcp.token, DRAFT_TOKEN, CLOSED_URL, "127.0.0.1:9", mcp.url]) {
      assert.equal(body.includes(secret), false, `a response holds ${secret}: ${body.slice(0, 200)}`);
    }
  }
});
