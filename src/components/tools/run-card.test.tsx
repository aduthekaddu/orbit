import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunCard } from "./run-card";

const finished = { stdout: "", stderr: "", exitCode: 0, durationMs: 20, timedOut: false, truncated: false };

function render(overrides: Record<string, unknown>) {
  const props = {
    type: "tool-call", toolCallId: "t1", toolName: "run_code", args: { language: "python", code: "print(1)" }, argsText: "",
    result: undefined, isError: false, status: { type: "running" }, addResult() {}, resume() {}, ...overrides,
  };
  return renderToStaticMarkup(<RunCard {...(props as unknown as ToolCallMessagePartProps)} />);
}

function header(html: string) {
  const match = /<section[^>]*>\s*<div[^>]*>(.*?)<\/div>/s.exec(html);
  assert.ok(match, "the card has a header");
  return match[1].replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/^\||\|$/g, "");
}

test("a running Python card names its language in the header", () => {
  assert.equal(header(render({})), "Run code|Python|Running");
});

test("a finished JavaScript card names its language in the header", () => {
  const html = render({ args: { language: "javascript", code: "console.log(1)" }, result: finished, status: { type: "complete" } });
  assert.equal(header(html), "Run code|JavaScript|Succeeded");
});

test("a failed card keeps its language", () => {
  const html = render({ result: { ...finished, exitCode: 3 }, status: { type: "complete" } });
  assert.equal(header(html), "Run code|Python|Failed");
});

test("a cancelled card with no result keeps its language", () => {
  assert.equal(header(render({ status: { type: "complete" } })), "Run code|Python|Cancelled");
});

test("a card whose tool input was rejected names no language", () => {
  const rejected = render({ args: { language: "ruby", code: "puts 1" }, result: { error: "Unsupported language" }, isError: true, status: { type: "complete" } });
  assert.equal(header(rejected), "Run code|Failed");
  assert.equal(header(render({ args: { code: "print(1)" } })), "Run code|Running");
  assert.equal(header(render({ args: undefined })), "Run code|Running");
});

test("other tools show no language", () => {
  assert.equal(header(render({ toolName: "web_search", args: { query: "orbit" } })), "Web search|Running");
});

test("a remember card shows the saved text", () => {
  const html = render({
    toolName: "remember",
    args: { text: "I deploy to Fly.io", kind: "fact" },
    result: { id: "mem-1", text: "I deploy to Fly.io" },
    status: { type: "complete" },
  });
  assert.match(html, /I deploy to Fly\.io/);
  assert.doesNotMatch(html, /<summary[^>]*>Output<\/summary>/);
});

test("a remember card whose save failed says Failed and does not show the text as saved", () => {
  const html = render({
    toolName: "remember",
    args: { text: "I deploy to Fly.io", kind: "fact" },
    result: { error: "Could not save memory" },
    status: { type: "complete" },
  });
  assert.equal(header(html), "remember|Failed");
  assert.doesNotMatch(html, /I deploy to Fly\.io/);
  assert.match(html, /Could not save memory/);
});
