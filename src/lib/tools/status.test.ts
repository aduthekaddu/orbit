import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import { jsonSchema, tool, type Tool } from "ai";
import { Redactor } from "../chat-errors";
import { getDb } from "../db";
import { toolStatus, user } from "../db/schema";
import { eventually } from "../eventually.mjs";
import { saveInstance } from "../instance-settings";
import { parseViewer, type HostingMode, type Viewer } from "../policy";
import { savePreferences } from "../preferences";
import { sandboxImages } from "../sandbox/images";
import { saveGithub } from "../user-github";
import { createForgetTool, createRememberTool } from "./memory";
import { STOP_MARKERS } from "./run-status";
import {
  listToolViews, loadToolContext, recordingTool, recordToolCall, sanitizeToolError, toolSetup, toolView,
  type ToolSetupInput, type ToolView,
} from "./status";

const sqlite = getDb().$client;
const admin = parseViewer({ id: "status-admin", role: "admin" });
const member = parseViewer({ id: "status-member", role: "member" });
const TAVILY_KEY = "made-up-tavily-key-0002";
const GITHUB_TOKEN = "made-up-github-token-0003";
const IMAGE_MISSING = `Sandbox image is missing. Run docker pull ${sandboxImages.python.image}`;
const ALLOWED_ERRORS = [
  "Search timed out",
  "Search is unavailable",
  "Sandbox configuration is invalid. Check DOCKER_HOST on the server.",
  "Sandbox access was denied. Check the Docker proxy.",
  IMAGE_MISSING,
  "Code sandbox failed. Check the server logs.",
  "Code sandbox timed out.",
  "Code sandbox out of memory.",
  "Code sandbox returned unexpected output.",
  "Saved GitHub token is unreadable. Enter it again.",
  "Add a GitHub token.",
  "GitHub MCP URL is not allowed.",
  "GitHub rejected the token (bad request).",
  "GitHub rejected the token.",
  "GitHub did not return a login.",
  "GitHub is unavailable.",
  "GitHub timed out.",
  "Memory storage is unavailable.",
];

type StatusRow = typeof toolStatus.$inferSelect;
type StoredRow = { lastOkAt: number | null; lastFailedAt: number | null; lastError: string | null };

let users = 0;

function addUser(id: string, role: "admin" | "member" = "member") {
  getDb().insert(user).values({ id, name: id, email: `${id}@orbit.test`, role }).run();
  return parseViewer({ id, role });
}

// Each recording test gets its own account, so "nothing recorded" reads an empty table for that account.
function freshUser() {
  users += 1;
  return addUser(`status-user-${users}`);
}

function stored(userId: string, toolId: string): StoredRow | undefined {
  return sqlite.prepare("SELECT last_ok_at AS lastOkAt, last_failed_at AS lastFailedAt, last_error AS lastError FROM tool_status WHERE user_id = ? AND tool_id = ?")
    .get(userId, toolId) as StoredRow | undefined;
}

function storedIds(userId: string) {
  return sqlite.prepare("SELECT tool_id FROM tool_status WHERE user_id = ? ORDER BY tool_id").pluck().all(userId);
}

function assertWorking(userId: string, toolId: string) {
  const row = stored(userId, toolId);
  assert.ok(row && row.lastOkAt !== null, `${toolId} has a good call`);
  assert.equal(row.lastFailedAt, null, `${toolId} has no failure`);
}

function assertFailing(userId: string, toolId: string, error: string) {
  const row = stored(userId, toolId);
  assert.ok(row && row.lastFailedAt !== null, `${toolId} has a failure`);
  assert.equal(row.lastOkAt, null, `${toolId} has no good call`);
  assert.equal(row.lastError, error);
}

function viewOf(viewer: Viewer, id: ToolView["id"]) {
  const view = listToolViews(viewer).find((entry) => entry.id === id);
  assert.ok(view, id);
  return view;
}

async function clockPast(mark: number) {
  await eventually(() => Date.now(), (now) => now > mark, { timeoutMs: 1_000, intervalMs: 1, what: "the clock to pass the last write" });
}

function withSandboxEnv(t: TestContext, value: string | undefined) {
  const original = process.env.ORBIT_SANDBOX;
  if (value === undefined) delete process.env.ORBIT_SANDBOX;
  else process.env.ORBIT_SANDBOX = value;
  t.after(() => {
    if (original === undefined) delete process.env.ORBIT_SANDBOX;
    else process.env.ORBIT_SANDBOX = original;
  });
}

before(() => {
  addUser(admin.id, "admin");
  addUser(member.id);
});

after(() => {
  sqlite.close();
});

function input(patch: {
  instance?: Partial<ToolSetupInput["instance"]>;
  sandboxEnvOn?: boolean;
  memory?: boolean;
  github?: Partial<ToolSetupInput["user"]["github"]>;
} = {}): ToolSetupInput {
  return {
    instance: { searxngUrl: "", tavilyApiKey: "", sandbox: "off", ...patch.instance },
    sandboxEnvOn: patch.sandboxEnvOn ?? false,
    user: { memory: patch.memory ?? false, github: { githubToken: "", ...patch.github } },
  };
}

test("toolSetup says whether each tool is ready, missing, unreadable, disabled, or off on the server", () => {
  const table: Array<[ToolView["id"], ToolSetupInput, unknown]> = [
    ["web_search", input({ instance: { searxngUrl: "https://search.example" } }), { state: "ready" }],
    ["web_search", input({ instance: { tavilyApiKey: TAVILY_KEY, tavilyKeySet: true, tavilyKeyReadable: true } }), { state: "ready" }],
    ["web_search", input({ instance: { searxngUrl: "https://search.example", tavilyKeySet: true, tavilyKeyReadable: false } }), { state: "ready" }],
    ["web_search", input({ instance: { tavilyKeySet: true, tavilyKeyReadable: false } }), { state: "unreadable", configure: "admin" }],
    ["web_search", input(), { state: "missing", configure: "admin" }],
    ["web_search", input({ instance: { tavilyKeySet: false, tavilyKeyReadable: true } }), { state: "missing", configure: "admin" }],
    ["run_code", input({ sandboxEnvOn: false, instance: { sandbox: "on" } }), { state: "server-off" }],
    ["run_code", input({ sandboxEnvOn: false, instance: { sandbox: "off" } }), { state: "server-off" }],
    ["run_code", input({ sandboxEnvOn: true, instance: { sandbox: "off" } }), { state: "disabled", configure: "admin" }],
    ["run_code", input({ sandboxEnvOn: true, instance: { sandbox: "on" } }), { state: "ready" }],
    ["github", input({ github: { githubToken: GITHUB_TOKEN, githubTokenSet: true, githubTokenReadable: true } }), { state: "ready" }],
    ["github", input({ github: { githubToken: GITHUB_TOKEN } }), { state: "ready" }],
    ["github", input({ github: { githubTokenSet: true, githubTokenReadable: false } }), { state: "unreadable", configure: "self" }],
    ["github", input(), { state: "missing", configure: "self" }],
    ["memory", input({ memory: true }), { state: "ready" }],
    ["memory", input({ memory: false }), { state: "disabled", configure: "self" }],
    ["render_ui", input(), { state: "ready" }],
  ];
  for (const [id, setupInput, expected] of table) {
    assert.deepEqual(toolSetup(id, setupInput), expected, `${id} ${JSON.stringify(setupInput)}`);
  }
});

test("toolSetup reads the server sandbox switch when the input leaves it out", (t) => {
  const context = { ...input({ instance: { sandbox: "on" } }), sandboxEnvOn: undefined };
  withSandboxEnv(t, undefined);
  assert.deepEqual(toolSetup("run_code", context), { state: "server-off" });
  process.env.ORBIT_SANDBOX = "on";
  assert.deepEqual(toolSetup("run_code", context), { state: "ready" });
});

const at = (ms: number) => new Date(Date.UTC(2026, 10, 28, 12, 0, 0, ms));

function row(patch: Partial<StatusRow> = {}): StatusRow {
  return { userId: admin.id, toolId: "web_search", lastOkAt: null, lastFailedAt: null, lastError: null, ...patch };
}

const ready = input({
  instance: { searxngUrl: "https://search.example", sandbox: "on" },
  sandboxEnvOn: true,
  memory: true,
  github: { githubToken: GITHUB_TOKEN },
});

test("a ready tool with no saved row is untested and can be tested", () => {
  assert.deepEqual(toolView("web_search", ready, undefined, member), {
    id: "web_search",
    label: "Web search",
    scope: "instance",
    setup: { state: "ready" },
    health: { state: "untested" },
    status: "untested",
    canTest: true,
    toggleable: true,
    configureHref: null,
  });
});

test("health follows the latest of the last good call and the last failure", () => {
  const table: Array<[StatusRow, ToolView["health"]]> = [
    [row(), { state: "untested" }],
    [row({ lastOkAt: at(1) }), { state: "working", lastGoodAt: at(1).toISOString() }],
    [row({ lastOkAt: at(1), lastFailedAt: at(2), lastError: "Search is unavailable" }),
      { state: "failing", lastGoodAt: at(1).toISOString(), failedAt: at(2).toISOString(), error: "Search is unavailable" }],
    [row({ lastFailedAt: at(2) }), { state: "failing", lastGoodAt: null, failedAt: at(2).toISOString(), error: "Tool check failed." }],
    [row({ lastOkAt: at(3), lastFailedAt: at(2), lastError: "Search timed out" }), { state: "working", lastGoodAt: at(3).toISOString() }],
    [row({ lastOkAt: at(2), lastFailedAt: at(2), lastError: "Search timed out" }),
      { state: "failing", lastGoodAt: at(2).toISOString(), failedAt: at(2).toISOString(), error: "Search timed out" }],
  ];
  for (const [saved, health] of table) {
    const view = toolView("web_search", ready, saved, admin);
    assert.deepEqual(view.health, health, JSON.stringify(saved));
    assert.equal(view.status, health.state, JSON.stringify(saved));
  }
});

test("a tool that is not set up shows Off whatever its saved timestamps say", () => {
  const off = input();
  const view = toolView("web_search", off, row({ lastOkAt: at(5) }), admin);
  assert.equal(view.status, "off");
  assert.equal(view.canTest, false);
  assert.deepEqual(view.health, { state: "working", lastGoodAt: at(5).toISOString() });
  const failing = toolView("github", off, row({ toolId: "github", lastFailedAt: at(6), lastError: "GitHub rejected the token." }), member);
  assert.equal(failing.status, "off");
  assert.equal(toolView("memory", off, undefined, member).status, "off");
  assert.equal(toolView("run_code", off, undefined, admin).status, "off");
});

test("Generated UI is always On, never testable, and never switchable", () => {
  for (const viewer of [admin, member]) {
    assert.deepEqual(toolView("render_ui", input(), row({ toolId: "render_ui", lastFailedAt: at(7), lastError: "Tool check failed." }), viewer), {
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
  }
});

test("configure links point admins to Admin and everyone to their own Settings", () => {
  const sandboxOff = input({ sandboxEnvOn: false, instance: { sandbox: "on" } });
  const sandboxDisabled = input({ sandboxEnvOn: true, instance: { sandbox: "off" } });
  const table: Array<[ToolView["id"], ToolSetupInput, string | null, string | null]> = [
    ["web_search", ready, "/admin#search", null],
    ["web_search", input(), "/admin#search", null],
    ["run_code", ready, "/admin#sandbox", null],
    ["run_code", sandboxDisabled, "/admin#sandbox", null],
    ["run_code", sandboxOff, null, null],
    ["github", ready, "/settings#github", "/settings#github"],
    ["github", input(), "/settings#github", "/settings#github"],
    ["memory", ready, "/settings#memory", "/settings#memory"],
    ["memory", input(), "/settings#memory", "/settings#memory"],
    ["render_ui", ready, null, null],
  ];
  for (const [id, setupInput, adminHref, memberHref] of table) {
    assert.equal(toolView(id, setupInput, undefined, admin).configureHref, adminHref, `${id} admin`);
    assert.equal(toolView(id, setupInput, undefined, member).configureHref, memberHref, `${id} member`);
  }
});

test("only admins see that the saved Tavily key is unreadable; a member sees Web search as not set up", () => {
  const unreadable = input({ instance: { tavilyKeySet: true, tavilyKeyReadable: false } });
  const forAdmin = toolView("web_search", unreadable, undefined, admin);
  assert.deepEqual(forAdmin.setup, { state: "unreadable", configure: "admin" });
  assert.equal(forAdmin.status, "off");
  assert.equal(forAdmin.canTest, false);
  const forMember = toolView("web_search", unreadable, undefined, member);
  assert.deepEqual(forMember.setup, { state: "missing", configure: "admin" });
  assert.equal(forMember.status, "off");
  assert.equal(forMember.configureHref, null);
  const token = input({ github: { githubTokenSet: true, githubTokenReadable: false } });
  assert.deepEqual(toolView("github", token, undefined, member).setup, { state: "unreadable", configure: "self" });
});

test("only ready testable tools can be tested", () => {
  const table: Array<[ToolView["id"], ToolSetupInput, boolean]> = [
    ["web_search", ready, true],
    ["web_search", input(), false],
    ["run_code", ready, true],
    ["run_code", input({ sandboxEnvOn: true }), false],
    ["github", ready, true],
    ["github", input(), false],
    ["memory", ready, true],
    ["memory", input(), false],
    ["render_ui", ready, false],
  ];
  for (const [id, setupInput, canTest] of table) assert.equal(toolView(id, setupInput, undefined, member).canTest, canTest, id);
});

const hostingModes: HostingMode["kind"][] = ["personal", "team", "community"];

test("the tool list keeps the same links and key hiding in Personal, Team, and Community mode", (t) => {
  withSandboxEnv(t, "on");
  assert.ok(saveInstance(admin.id, { searxngUrl: "", tavilyApiKey: null, sandbox: "off" }).ok);
  sqlite.prepare("UPDATE instance_settings SET tavily_key_ciphertext = 'unreadable-ciphertext'").run();
  try {
    for (const mode of hostingModes) {
      assert.ok(saveInstance(admin.id, { hostingMode: mode }).ok, mode);
      const forAdmin = listToolViews(admin);
      const forMember = listToolViews(member);
      assert.deepEqual(forAdmin.map((view) => view.id), ["web_search", "run_code", "github", "memory", "render_ui"], mode);
      assert.deepEqual(forMember.map((view) => view.id), ["web_search", "run_code", "github", "memory", "render_ui"], mode);
      assert.deepEqual(forAdmin.map((view) => view.configureHref), ["/admin#search", "/admin#sandbox", "/settings#github", "/settings#memory", null], mode);
      assert.deepEqual(forMember.map((view) => view.configureHref), [null, null, "/settings#github", "/settings#memory", null], mode);
      assert.deepEqual(forAdmin[0].setup, { state: "unreadable", configure: "admin" }, mode);
      assert.deepEqual(forMember[0].setup, { state: "missing", configure: "admin" }, mode);
      assert.deepEqual(forAdmin.map((view) => view.status), ["off", "off", "off", "untested", "ready"], mode);
      assert.deepEqual(forMember.map((view) => view.status), ["off", "off", "off", "untested", "ready"], mode);
    }
  } finally {
    sqlite.prepare("UPDATE instance_settings SET tavily_key_ciphertext = '', hosting_mode = 'personal', signup_mode = 'invite'").run();
  }
});

test("loadToolContext reads the instance, the viewer's GitHub token, and the viewer's memory switch", (t) => {
  withSandboxEnv(t, "on");
  const reader = freshUser();
  assert.ok(saveInstance(admin.id, { searxngUrl: "https://search.example", sandbox: "on" }).ok);
  assert.ok(saveGithub(admin.id, { githubToken: GITHUB_TOKEN }).ok);
  savePreferences(reader.id, { memory: "off" });
  const adminContext = loadToolContext(admin.id);
  assert.equal(adminContext.user.id, admin.id);
  assert.deepEqual(toolSetup("web_search", adminContext), { state: "ready" });
  assert.deepEqual(toolSetup("run_code", adminContext), { state: "ready" });
  assert.deepEqual(toolSetup("github", adminContext), { state: "ready" });
  assert.deepEqual(toolSetup("memory", adminContext), { state: "ready" });
  const readerContext = loadToolContext(reader.id);
  assert.equal(readerContext.user.id, reader.id);
  assert.deepEqual(toolSetup("github", readerContext), { state: "missing", configure: "self" });
  assert.deepEqual(toolSetup("memory", readerContext), { state: "disabled", configure: "self" });
  assert.ok(saveGithub(admin.id, { githubToken: null }).ok);
});

test("a recorded call changes only the caller's status", async () => {
  const first = freshUser();
  const second = freshUser();
  recordToolCall(first.id, "web_search", { ok: true });
  assert.equal(viewOf(first, "web_search").health.state, "working");
  assert.equal(viewOf(second, "web_search").health.state, "untested");
  assert.deepEqual(storedIds(first.id), ["web_search"]);
  assert.deepEqual(storedIds(second.id), []);

  const good = stored(first.id, "web_search")?.lastOkAt;
  assert.ok(good);
  await clockPast(good);
  recordToolCall(first.id, "web_search", { ok: false, error: "Search is unavailable" });
  const failing = viewOf(first, "web_search").health;
  assert.equal(failing.state, "failing");
  assert.equal(failing.state === "failing" && failing.lastGoodAt, new Date(good).toISOString(), "a failure keeps the last good call");
  assert.equal(failing.state === "failing" && failing.error, "Search is unavailable");
  assert.equal(viewOf(second, "web_search").health.state, "untested");

  const failed = stored(first.id, "web_search")?.lastFailedAt;
  assert.ok(failed);
  await clockPast(failed);
  recordToolCall(first.id, "web_search", { ok: true });
  assert.equal(viewOf(first, "web_search").health.state, "working");
});

test("a recorded error is cleaned of saved credentials and capped at 200 characters", () => {
  const owner = freshUser();
  assert.ok(saveGithub(owner.id, { githubToken: GITHUB_TOKEN }).ok);
  recordToolCall(owner.id, "github", { ok: false, error: `GitHub answered 500 for ${GITHUB_TOKEN}` });
  const github = stored(owner.id, "github");
  assert.ok(github?.lastError);
  assert.equal(github.lastError.includes(GITHUB_TOKEN), false, github.lastError);
  assert.equal(JSON.stringify(listToolViews(owner)).includes(GITHUB_TOKEN), false);

  recordToolCall(owner.id, "memory", { ok: false, error: "x".repeat(500) });
  const memory = stored(owner.id, "memory");
  assert.ok(memory?.lastError);
  assert.ok(memory.lastError.length <= 200, `${memory.lastError.length} characters`);

  recordToolCall(owner.id, "run_code", { ok: false, error: IMAGE_MISSING });
  assert.equal(stored(owner.id, "run_code")?.lastError, IMAGE_MISSING);
});

test("sanitizeToolError keeps fixed messages and drops credentials, URLs, and length", () => {
  const searxngUrl = "http://127.0.0.1:4455";
  const redact = new Redactor({ searxngUrl, tavilyApiKey: TAVILY_KEY, githubToken: GITHUB_TOKEN, githubMcpUrl: "" });
  for (const message of ALLOWED_ERRORS) assert.equal(sanitizeToolError(message, redact), message);
  assert.equal(sanitizeToolError(`Tavily rejected ${TAVILY_KEY}`, redact), "Tool check failed.");
  assert.equal(sanitizeToolError(`token ${GITHUB_TOKEN} is bad`, redact), "Tool check failed.");
  assert.doesNotMatch(sanitizeToolError(`connect ${searxngUrl}/search?q=orbit refused`, redact), /127\.0\.0\.1:4455/);
  const long = sanitizeToolError("y".repeat(1_000), redact);
  assert.ok(long.length > 0 && long.length <= 200, `${long.length} characters`);
});

test("changing search or sandbox settings clears that tool's status for every account", () => {
  const first = freshUser();
  const second = freshUser();
  const seed = () => {
    for (const account of [first, second]) {
      for (const id of ["web_search", "run_code", "github"] as const) recordToolCall(account.id, id, { ok: true });
    }
  };
  assert.ok(saveInstance(admin.id, { searxngUrl: "https://search.example", sandbox: "on" }).ok);

  seed();
  assert.ok(saveInstance(admin.id, { searxngUrl: "https://search.example", dreamHour: 4 }).ok);
  for (const account of [first, second]) assert.deepEqual(storedIds(account.id), ["github", "run_code", "web_search"], "an unchanged URL keeps status");

  assert.ok(saveInstance(admin.id, { searxngUrl: "https://other.example" }).ok);
  for (const account of [first, second]) assert.deepEqual(storedIds(account.id), ["github", "run_code"], "a new SearXNG URL clears web_search");

  seed();
  assert.ok(saveInstance(admin.id, { tavilyApiKey: TAVILY_KEY }).ok);
  for (const account of [first, second]) assert.deepEqual(storedIds(account.id), ["github", "run_code"], "a new Tavily key clears web_search");

  seed();
  assert.ok(saveInstance(admin.id, { sandbox: "off" }).ok);
  for (const account of [first, second]) assert.deepEqual(storedIds(account.id), ["github", "web_search"], "a sandbox change clears run_code");
  assert.ok(saveInstance(admin.id, { searxngUrl: "", tavilyApiKey: null, sandbox: "on" }).ok);
});

test("changing a GitHub token or MCP URL clears only that account's GitHub status", () => {
  const owner = freshUser();
  const other = freshUser();
  for (const account of [owner, other]) {
    recordToolCall(account.id, "github", { ok: true });
    recordToolCall(account.id, "memory", { ok: true });
  }
  assert.ok(saveGithub(owner.id, { githubToken: GITHUB_TOKEN }).ok);
  assert.deepEqual(storedIds(owner.id), ["memory"]);
  assert.deepEqual(storedIds(other.id), ["github", "memory"]);

  recordToolCall(owner.id, "github", { ok: true });
  assert.ok(saveGithub(owner.id, { githubMcpUrl: "https://api.githubcopilot.com/mcp/x/repos" }).ok);
  assert.deepEqual(storedIds(owner.id), ["memory"]);
  assert.deepEqual(storedIds(other.id), ["github", "memory"]);
});

const callOptions = (abortSignal?: AbortSignal) => ({ toolCallId: "status-call", messages: [], abortSignal, context: {} });

function fakeTool(execute: (input: Record<string, unknown>) => unknown): Tool {
  return tool({ inputSchema: jsonSchema<Record<string, unknown>>({ type: "object" }), execute: async (input) => execute(input) });
}

async function run(wrapped: Tool, input: Record<string, unknown> = {}, abortSignal?: AbortSignal) {
  assert.ok(wrapped.execute);
  return wrapped.execute(input, callOptions(abortSignal));
}

const redact = new Redactor(null);
const found = { ok: true, query: "orbit", results: [{ title: "Orbit", url: "https://example.com/orbit", snippet: "", engine: "searxng" }] };

test("a web search that returns results marks Web search working and returns the same output", async () => {
  const account = freshUser();
  const output = await run(recordingTool(fakeTool(() => found), "web_search", "web_search", account.id, redact), { query: "orbit" });
  assert.deepEqual(output, found);
  assertWorking(account.id, "web_search");
});

test("a web search that times out or finds no backend marks Web search failing with that message", async () => {
  for (const error of ["Search timed out", "Search is unavailable"]) {
    const account = freshUser();
    const failed = { ok: false, query: "orbit", error };
    assert.deepEqual(await run(recordingTool(fakeTool(() => failed), "web_search", "web_search", account.id, redact)), failed);
    assertFailing(account.id, "web_search", error);
  }
});

test("a stopped web search records nothing", async () => {
  const account = freshUser();
  const stopped = { ok: false, query: "orbit", error: STOP_MARKERS.searchStopped };
  assert.deepEqual(await run(recordingTool(fakeTool(() => stopped), "web_search", "web_search", account.id, redact)), stopped);
  assert.deepEqual(storedIds(account.id), []);
});

test("an aborted call rethrows and records nothing", async () => {
  const account = freshUser();
  const controller = new AbortController();
  controller.abort();
  const aborting = fakeTool(() => {
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  });
  await assert.rejects(run(recordingTool(aborting, "web_search", "web_search", account.id, redact), {}, controller.signal), { name: "AbortError" });
  await assert.rejects(run(recordingTool(aborting, "run_code", "run_code", account.id, redact)), { name: "AbortError" });
  const late = fakeTool(() => {
    throw new Error("socket closed");
  });
  await assert.rejects(run(recordingTool(late, "github_list_issues", "github", account.id, redact), {}, controller.signal), /socket closed/);
  assert.deepEqual(storedIds(account.id), []);
});

test("a call that returns after its signal aborted records nothing", async () => {
  const account = freshUser();
  const controller = new AbortController();
  const stopping = (output: unknown) => fakeTool(() => {
    controller.abort();
    return output;
  });
  assert.deepEqual(await run(recordingTool(stopping(found), "web_search", "web_search", account.id, redact), {}, controller.signal), found);
  const failed = { ok: false, query: "orbit", error: "Search is unavailable" };
  assert.deepEqual(await run(recordingTool(stopping(failed), "web_search", "web_search", account.id, redact), {}, controller.signal), failed);
  const denied = { ok: false, error: "Sandbox access was denied. Check the Docker proxy." };
  assert.deepEqual(await run(recordingTool(stopping(denied), "run_code", "run_code", account.id, redact), {}, controller.signal), denied);
  assert.deepEqual(storedIds(account.id), []);
});

test("a thrown tool error rethrows and records the tool's fixed message", async () => {
  const account = freshUser();
  const throwing = (error: Error) => fakeTool(() => {
    throw error;
  });
  await assert.rejects(run(recordingTool(throwing(new Error(`backend http://10.0.0.5 said ${TAVILY_KEY}`)), "web_search", "web_search", account.id, redact)));
  assertFailing(account.id, "web_search", "Search is unavailable");
  await assert.rejects(run(recordingTool(throwing(Object.assign(new Error("denied"), { statusCode: 403 })), "run_code", "run_code", account.id, redact), { language: "python", code: "print(1)" }));
  assertFailing(account.id, "run_code", "Sandbox access was denied. Check the Docker proxy.");
  await assert.rejects(run(recordingTool(throwing(Object.assign(new Error(`HTTP 401 for ${GITHUB_TOKEN}`), { statusCode: 401 })), "github_list_issues", "github", account.id, redact)));
  assertFailing(account.id, "github", "GitHub rejected the token.");
  await assert.rejects(run(recordingTool(throwing(new Error("disk I/O error")), "remember", "memory", account.id, redact), { text: "x", kind: "fact" }));
  assertFailing(account.id, "memory", "Memory storage is unavailable.");
  assert.equal(JSON.stringify(sqlite.prepare("SELECT * FROM tool_status WHERE user_id = ?").all(account.id)).includes(GITHUB_TOKEN), false);
});

const runOutput = (patch: Record<string, unknown> = {}) => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 12, timedOut: false, truncated: false, ...patch });

test("a code run that ran the model's script marks the sandbox working, even when the script failed", async () => {
  for (const output of [runOutput({ stdout: "1\n" }), runOutput({ exitCode: 1, stderr: "Traceback" }), runOutput({ exitCode: null, timedOut: true }), runOutput({ exitCode: 137, oomKilled: true })]) {
    const account = freshUser();
    assert.deepEqual(await run(recordingTool(fakeTool(() => output), "run_code", "run_code", account.id, redact)), output);
    assertWorking(account.id, "run_code");
  }
});

test("a Docker failure marks the sandbox failing, and a stopped run records nothing", async () => {
  const account = freshUser();
  const denied = { ok: false, error: "Sandbox access was denied. Check the Docker proxy." };
  assert.deepEqual(await run(recordingTool(fakeTool(() => denied), "run_code", "run_code", account.id, redact)), denied);
  assertFailing(account.id, "run_code", "Sandbox access was denied. Check the Docker proxy.");
  const other = freshUser();
  await run(recordingTool(fakeTool(() => runOutput({ exitCode: null, cancelled: true })), "run_code", "run_code", other.id, redact));
  assert.deepEqual(storedIds(other.id), []);
});

test("a rejected memory proves storage answered, and a storage failure marks Memory failing", async () => {
  const account = freshUser();
  const empty = await run(recordingTool(createRememberTool(account.id, undefined, redact), "remember", "memory", account.id, redact), { text: "   ", kind: "fact" });
  assert.deepEqual(empty, { error: "Memory text is empty" });
  assertWorking(account.id, "memory");

  const missing = freshUser();
  assert.deepEqual(await run(recordingTool(createForgetTool(missing.id), "forget", "memory", missing.id, redact), { id: "no-such-memory" }), { error: "No memory with that id" });
  assertWorking(missing.id, "memory");

  const saved = freshUser();
  const kept = await run(recordingTool(createRememberTool(saved.id, undefined, redact), "remember", "memory", saved.id, redact), { text: "I prefer green tea", kind: "preference" });
  assert.equal((kept as { text?: string }).text, "I prefer green tea");
  assertWorking(saved.id, "memory");

  const broken = freshUser();
  const storageFailure = { error: "Could not save memory" };
  assert.deepEqual(await run(recordingTool(fakeTool(() => storageFailure), "remember", "memory", broken.id, redact), { text: "x", kind: "fact" }), storageFailure);
  assertFailing(broken.id, "memory", "Memory storage is unavailable.");
});

test("any returned GitHub result marks GitHub working, since an error result such as a wrong path still came from GitHub", async () => {
  const account = freshUser();
  await run(recordingTool(fakeTool(() => ({ content: [{ type: "text", text: "[]" }] })), "github_list_issues", "github", account.id, redact));
  assertWorking(account.id, "github");
  const other = freshUser();
  recordToolCall(other.id, "github", { ok: false, error: "GitHub is unavailable." });
  await run(recordingTool(fakeTool(() => ({ isError: true, content: [{ type: "text", text: "Not Found: file not found" }] })), "github_get_file_contents", "github", other.id, redact));
  assertWorking(other.id, "github");
});

test("recording a call for a deleted account does not break the call", async () => {
  const output = await run(recordingTool(fakeTool(() => found), "web_search", "web_search", parseViewer({ id: "status-deleted", role: "member" }).id, redact));
  assert.deepEqual(output, found);
  assert.deepEqual(storedIds("status-deleted"), []);
});
