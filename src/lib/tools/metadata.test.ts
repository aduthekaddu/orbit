import assert from "node:assert/strict";
import test from "node:test";
import {
  cardFor, isDisabledToolEntry, normalizeDisabledTools, summaryFor, titleFor, toolIdFor,
  TESTABLE_TOOL_IDS, TOGGLEABLE_TOOL_IDS, TOOL_CATALOG, TOOL_IDS, type ToolRun,
} from "./metadata";

const results = (count: number) => ({
  ok: true,
  query: "orbit",
  results: Array.from({ length: count }, (_, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}`, snippet: "", engine: "searxng" })),
});
const issues = (count: number) => ({
  content: [{ type: "text", text: JSON.stringify(Array.from({ length: count }, (_, index) => ({ title: `Issue ${index}`, html_url: `https://github.com/o/r/issues/${index + 1}` }))) }],
});

const run = (status: ToolRun["status"], output?: unknown, input: unknown = {}): ToolRun => ({ status, input, output });

test("each tool has one card kind", () => {
  assert.equal(cardFor("render_ui"), "genui");
  assert.equal(cardFor("run_code"), "code");
  assert.equal(cardFor("web_search"), "search");
  assert.equal(cardFor("remember"), "memory");
  assert.equal(cardFor("forget"), "memory");
  assert.equal(cardFor("github_list_issues"), "github");
  assert.equal(cardFor("do_thing"), "generic");
});

test("titles are plain names", () => {
  assert.equal(titleFor("web_search"), "Web search");
  assert.equal(titleFor("remember"), "Memory");
  assert.equal(titleFor("forget"), "Memory");
  assert.equal(titleFor("run_code"), "Run code");
  assert.equal(titleFor("github_list_issues"), "List issues on GitHub");
  assert.equal(titleFor("github_get_file_contents"), "Get file contents on GitHub");
  assert.equal(titleFor("do_thing"), "Do thing");
  assert.equal(titleFor("fetchPage"), "Fetch page");
});

const table: Array<[string, ToolRun, string]> = [
  ["web_search", run("running"), "Searching the web"],
  ["web_search", run("succeeded", results(3)), "Searched the web, 3 sources"],
  ["web_search", run("succeeded", results(1)), "Searched the web, 1 source"],
  ["web_search", run("succeeded", results(0)), "Searched the web, 0 sources"],
  ["web_search", run("succeeded", { ok: true, query: "orbit", results: "nope" }), "Searched the web"],
  ["web_search", run("failed", { ok: false, query: "orbit", error: "Unavailable" }), "Search failed"],
  ["web_search", run("cancelled"), "Search stopped"],
  ["remember", run("running"), "Saving to memory"],
  ["remember", run("succeeded", { id: "m1", text: "I deploy to Fly.io" }), "Saved to memory"],
  ["remember", run("failed", { error: "Too long" }), "Could not save to memory"],
  ["remember", run("cancelled"), "Stopped"],
  ["forget", run("running"), "Removing a memory"],
  ["forget", run("succeeded", { ok: true }), "Removed a memory"],
  ["forget", run("failed", { error: "Memory not found" }), "Could not remove the memory"],
  ["forget", run("cancelled"), "Stopped"],
  ["github_list_issues", run("running"), "List issues on GitHub"],
  ["github_list_issues", run("succeeded", issues(2)), "List issues on GitHub, 2 results"],
  ["github_list_issues", run("succeeded", issues(1)), "List issues on GitHub, 1 result"],
  ["github_list_issues", run("failed", { isError: true }), "List issues on GitHub failed"],
  ["github_list_issues", run("cancelled"), "List issues on GitHub stopped"],
  ["do_thing", run("running"), "Do thing"],
  ["do_thing", run("succeeded", { done: true }), "Do thing"],
  ["do_thing", run("failed"), "Do thing failed"],
  ["do_thing", run("cancelled"), "Do thing stopped"],
];

for (const [name, toolRun, expected] of table) {
  test(`${name} ${toolRun.status} says "${expected}"`, () => {
    assert.equal(summaryFor(name, toolRun), expected);
  });
}

test("no summary shows a raw tool name", () => {
  for (const [name, toolRun] of table) assert.doesNotMatch(summaryFor(name, toolRun), /_|remember|forget|github_/);
});

test("the tool catalog lists the five tools in page order with their scope and switches", () => {
  assert.deepEqual(TOOL_IDS, ["web_search", "run_code", "github", "memory", "render_ui"]);
  assert.deepEqual(TESTABLE_TOOL_IDS, ["web_search", "run_code", "github", "memory"]);
  assert.deepEqual(TOGGLEABLE_TOOL_IDS, ["web_search", "run_code", "github", "memory"]);
  assert.deepEqual(TOOL_CATALOG, {
    web_search: { id: "web_search", label: "Web search", scope: "instance", testable: true, toggleable: true },
    run_code: { id: "run_code", label: "Code sandbox", scope: "instance", testable: true, toggleable: true },
    github: { id: "github", label: "GitHub", scope: "personal", testable: true, toggleable: true },
    memory: { id: "memory", label: "Memory", scope: "personal", testable: true, toggleable: true },
    render_ui: { id: "render_ui", label: "Generated UI", scope: "built-in", testable: false, toggleable: false },
  });
});

test("catalog labels leave the tool card titles alone", () => {
  assert.equal(TOOL_CATALOG.run_code.label, "Code sandbox");
  assert.equal(titleFor("run_code"), "Run code");
  assert.equal(TOOL_CATALOG.render_ui.label, "Generated UI");
  assert.equal(titleFor("render_ui"), "View");
});

test("each model tool name maps to the tool that owns it", () => {
  const table: Array<[string, string | null]> = [
    ["web_search", "web_search"],
    ["run_code", "run_code"],
    ["remember", "memory"],
    ["forget", "memory"],
    ["render_ui", "render_ui"],
    ["github_list_issues", "github"],
    ["github_get_me", "github"],
    ["github", null],
    ["memory", null],
    ["mcp:server", null],
    ["web_search_v2", null],
    ["do_thing", null],
    ["", null],
  ];
  for (const [name, owner] of table) assert.equal(toolIdFor(name), owner, name);
});

test("a disabled tool entry is a switchable tool id or an MCP server id", () => {
  for (const value of ["web_search", "run_code", "github", "memory", "mcp:server", "mcp:A_b-9", `mcp:${"a".repeat(80)}`]) {
    assert.equal(isDisabledToolEntry(value), true, value);
  }
  for (const value of [
    "render_ui", "", "remember", "forget", "github_list_issues", "WEB_SEARCH", " web_search", "web_search ",
    "mcp:", `mcp:${"a".repeat(81)}`, "mcp:a b", "mcp:a/b", "mcp:a.b", "mcp:server\n", "MCP:server", "tool:server",
  ]) {
    assert.equal(isDisabledToolEntry(value), false, JSON.stringify(value));
  }
});

test("disabled tools normalize to sorted unique valid entries", () => {
  assert.deepEqual(normalizeDisabledTools([]), []);
  assert.deepEqual(
    normalizeDisabledTools(["web_search", "memory", "web_search", "render_ui", "mcp:b", "mcp:a", "bogus", "mcp:"]),
    ["mcp:a", "mcp:b", "memory", "web_search"],
  );
  assert.deepEqual(normalizeDisabledTools(["render_ui"]), []);
  assert.deepEqual(normalizeDisabledTools(["run_code", "github"]), ["github", "run_code"]);
});
