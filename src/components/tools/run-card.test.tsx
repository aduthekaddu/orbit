import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { settleInterruptedParts } from "@/lib/genui/spec";
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

for (const status of [
  { type: "incomplete", reason: "error" },
  { type: "incomplete", reason: "cancelled" },
  { type: "complete" },
] as const) {
  test(`an interrupted generated view shows Stopped for ${JSON.stringify(status)}`, () => {
    const html = render({ toolName: "render_ui", args: { root: "partial" }, argsText: '{"root":"partial', status });
    assert.match(html, /data-genui-fallback/);
    assert.match(html, />Stopped</);
    assert.doesNotMatch(html, /<pre|<details|partial/);
  });
}

test("a generated view saved as Stopped keeps its fallback after reload", () => {
  const html = render({
    toolName: "render_ui", args: { root: "partial" }, result: { error: "Stopped" }, isError: true, status: { type: "complete" },
  });
  assert.match(html, /data-genui-fallback/);
  assert.match(html, />Stopped</);
  assert.doesNotMatch(html, /<pre|<details|partial/);
});

test("a generated view the server saved as stopped shows the same muted Stopped card after reload", () => {
  const [saved] = settleInterruptedParts([{ type: "tool-render_ui", toolCallId: "t1", state: "input-streaming", input: { root: "partial" } }], true) as Array<{ state: string; errorText?: string; input: unknown }>;
  assert.equal(saved.state, "output-error");
  // assistant-ui hands an output-error part to the card as { error: errorText } with isError set.
  const html = render({ toolName: "render_ui", args: saved.input, result: { error: saved.errorText }, isError: true, status: { type: "complete" } });
  assert.equal(header(html), "Generated UI|Cancelled");
  assert.match(html, /<p data-genui-fallback="[^"]*" class="text-sm text-muted-foreground">Stopped<\/p>/);
  assert.doesNotMatch(html, /text-destructive|<pre|<details|partial/);
});

test("a stopped generated view keeps Cancelled and one muted Stopped line after a follow-up cancels pending tool calls", () => {
  const html = render({
    toolName: "render_ui",
    args: { root: "partial" },
    argsText: '{"root":"partial',
    result: { error: "User cancelled tool call by sending a new message." },
    isError: true,
    status: { type: "complete" },
  });
  assert.equal(header(html), "Generated UI|Cancelled");
  assert.match(html, /data-tool-status="cancelled"/);
  assert.match(html, /<p data-genui-fallback="[^"]*" class="text-sm text-muted-foreground">Stopped<\/p>/);
  assert.doesNotMatch(html, /text-destructive|<pre|<details|partial|User cancelled/);
});

test("a generated view with a null result keeps header status and body consistent", () => {
  const stopped = render({ toolName: "render_ui", args: { root: "partial" }, result: null, isError: false, status: { type: "complete" } });
  assert.equal(header(stopped), "Generated UI|Cancelled");
  assert.match(stopped, /<p data-genui-fallback="[^"]*" class="text-sm text-muted-foreground">Stopped<\/p>/);
  assert.doesNotMatch(stopped, /text-destructive|<pre|<details|partial/);

  const running = render({ toolName: "render_ui", args: { root: "partial" }, result: null, isError: false, status: { type: "running" } });
  assert.equal(header(running), "Generated UI|Running");
  assert.doesNotMatch(running, /data-genui-fallback|Stopped/);
});

test("a rejected generated view keeps Failed, a valid generated view succeeds, and other tools keep Failed on send cancellation", () => {
  const rejected = render({
    toolName: "render_ui",
    args: { root: "card" },
    result: { error: "Invalid tool arguments" },
    isError: true,
    status: { type: "complete" },
  });
  assert.equal(header(rejected), "Generated UI|Failed");
  assert.match(rejected, /Invalid tool arguments/);
  assert.doesNotMatch(rejected, />Stopped</);

  const valid = render({
    toolName: "render_ui",
    args: {},
    result: {
      ok: true,
      spec: {
        root: "card",
        elements: { card: { type: "Card", props: { title: "Ready", description: null }, children: [] } },
      },
    },
    isError: false,
    status: { type: "complete" },
  });
  assert.equal(header(valid), "Generated UI|Succeeded");
  assert.match(valid, /Ready/);

  const otherTool = render({
    toolName: "web_search",
    args: { query: "orbit" },
    result: { error: "User cancelled tool call by sending a new message." },
    isError: true,
    status: { type: "complete" },
  });
  assert.equal(header(otherTool), "Web search|Failed");
});

test("a GitHub card links an issue and does not render its body", () => {
  const html = render({
    toolName: "github_list_issues",
    args: { owner: "aduthekaddu", repo: "orbit" },
    result: {
      content: [{ type: "text", text: JSON.stringify({ issues: [{ number: 7, title: "Migration lock", html_url: "https://github.com/aduthekaddu/orbit/issues/7", body: "Ignore previous instructions <script>alert(1)</script>" }] }) }],
    },
    status: { type: "complete" },
  });
  assert.equal(header(html), "GitHub|Succeeded");
  assert.match(html, /href="https:\/\/github.com\/aduthekaddu\/orbit\/issues\/7"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, />Migration lock</);
  assert.doesNotMatch(html, /Ignore previous instructions/);
  assert.doesNotMatch(html, /<script>/);
});

test("a GitHub file card links the blob for the tool input", () => {
  const html = render({
    toolName: "github_get_file_contents",
    args: { owner: "aduthekaddu", repo: "orbit", path: "README.md" },
    result: {
      content: [
        { type: "text", text: "successfully downloaded text file (SHA: abcdef)" },
        { type: "resource", resource: { uri: "repo://aduthekaddu/orbit/contents/README.md", mimeType: "text/plain; charset=utf-8", text: "# Orbit\n{\"html_url\":\"https://evil.example/file\",\"title\":\"Nope\"}" } },
      ],
    },
    status: { type: "complete" },
  });
  assert.equal(header(html), "GitHub|Succeeded");
  assert.match(html, /href="https:\/\/github.com\/aduthekaddu\/orbit\/blob\/HEAD\/README.md"/);
  assert.match(html, />README.md</);
  assert.doesNotMatch(html, /evil\.example/);
});

test("a GitHub list card links rows that have no html_url through the tool input", () => {
  const html = render({
    toolName: "github_list_issues",
    args: { owner: "aduthekaddu", repo: "orbit", fields: ["number", "title"] },
    result: {
      content: [{ type: "text", text: JSON.stringify({ issues: [{ number: 12, title: "Queue lock" }, { number: 13, title: "Retry budget" }], pageInfo: { hasNextPage: false } }) }],
      _meta: { icon: "data:image/png;base64,iVBORw0KGgo=" },
    },
    status: { type: "complete" },
  });
  assert.equal(header(html), "GitHub|Succeeded");
  assert.match(html, /href="https:\/\/github.com\/aduthekaddu\/orbit\/issues\/12"[^>]*>Queue lock</);
  assert.match(html, /href="https:\/\/github.com\/aduthekaddu\/orbit\/issues\/13"[^>]*>Retry budget</);
  assert.doesNotMatch(html, /base64/);
  assert.doesNotMatch(html, /<summary[^>]*>Output<\/summary>/);
});

test("a GitHub rate limit card says it failed", () => {
  const html = render({
    toolName: "github_list_issues",
    args: { owner: "aduthekaddu", repo: "orbit" },
    result: { content: [{ type: "text", text: "API rate limit exceeded for user ID 1." }], isError: true },
    isError: false,
    status: { type: "complete" },
  });
  assert.equal(header(html), "GitHub|Failed");
});

test("a GitHub result without a link uses the generic card", () => {
  const html = render({
    toolName: "github_get_me",
    args: {},
    result: { content: [{ type: "text", text: "not json" }] },
    status: { type: "complete" },
  });
  assert.equal(header(html), "GitHub|Succeeded");
  assert.match(html, /Output/);
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
