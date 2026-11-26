import assert from "node:assert/strict";
import test from "node:test";
import { layoutFor, summaryFor, titleFor, type ToolRun } from "./metadata";

const results = (count: number) => ({
  ok: true,
  query: "orbit",
  results: Array.from({ length: count }, (_, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}`, snippet: "", engine: "searxng" })),
});
const issues = (count: number) => ({
  content: [{ type: "text", text: JSON.stringify(Array.from({ length: count }, (_, index) => ({ title: `Issue ${index}`, html_url: `https://github.com/o/r/issues/${index + 1}` }))) }],
});

const run = (status: ToolRun["status"], output?: unknown, input: unknown = {}): ToolRun => ({ status, input, output });

test("each tool has one layout", () => {
  assert.equal(layoutFor("render_ui"), "inline");
  assert.equal(layoutFor("run_code"), "card");
  for (const name of ["web_search", "remember", "forget", "github_list_issues", "do_thing"]) assert.equal(layoutFor(name), "line", name);
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
