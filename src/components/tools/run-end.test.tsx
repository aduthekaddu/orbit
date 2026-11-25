import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { restoreStoppedRuns } from "@/lib/chat-stopped-runs";
import { settleInterruptedParts } from "@/lib/genui/spec";
import { searchWeb } from "@/lib/tools/search";
import { RunCard } from "./run-card";

type Part =
  | { state: "input-streaming" | "input-available"; input: unknown }
  | { state: "output-available"; input: unknown; output: unknown }
  | { state: "output-error"; input: unknown; errorText?: string };
type Status = ToolCallMessagePartProps["status"];

const cancelledOnSend = "User cancelled tool call by sending a new message.";
const complete: Status = { type: "complete" };
const stoppedLive: Status = { type: "incomplete", reason: "cancelled" };
const code = { language: "python", code: "while True: pass" };
const genui = { root: "partial" };
const search = { query: "orbit" };
const partialRun = { stdout: "before-stop\n", stderr: "", exitCode: null, durationMs: 1500, timedOut: false, truncated: false, cancelled: true };

// The props @assistant-ui/ai-sdk passes a tool card for a UI part (convertMessage.ts, the output-available and output-error branches).
function props(toolName: string, part: Part, status: Status): ToolCallMessagePartProps {
  const result = part.state === "output-available" ? part.output : part.state === "output-error" ? { error: part.errorText } : undefined;
  return {
    type: "tool-call", toolCallId: "call-1", toolName, args: part.input, argsText: JSON.stringify(part.input), result,
    isError: part.state === "output-error", status, addResult() {}, resume() {},
  } as unknown as ToolCallMessagePartProps;
}

function saved(toolName: string, part: Part): Part {
  const [settled] = settleInterruptedParts([{ type: `tool-${toolName}`, toolCallId: "call-1", ...part }], true) as Part[];
  return settled;
}

function restored(part: Part): Part {
  const message = (parts: unknown[]) => ({ id: "reply", role: "assistant" as const, parts: parts as never });
  const live = [message([{ type: "tool-run_code", toolCallId: "call-1", ...part }])];
  const [next] = restoreStoppedRuns(live, message([{ type: "tool-run_code", toolCallId: "call-1", state: "output-available", input: code, output: partialRun }]));
  return next.parts[0] as unknown as Part;
}

const stoppedLine = /<p data-genui-fallback="[^"]*" class="text-sm text-muted-foreground">Stopped<\/p>/;

type Row = { name: string; tool: string; part: Part; status: Status; expected: "running" | "succeeded" | "failed" | "cancelled"; shows?: RegExp[]; hides?: RegExp[] };

// Each early end the AI SDK, assistant-ui and Orbit's own producers write, live and after reload.
const rows: Row[] = [
  { name: "c88a3a5: a code run saved with the old abort text", tool: "run_code", part: { state: "output-error", input: code, errorText: "Code run was stopped" }, status: complete, expected: "cancelled", hides: [/text-destructive/, /Code run was stopped/] },
  { name: "c88a3a5: a code run stopped before it started", tool: "run_code", part: saved("run_code", { state: "input-available", input: code }), status: complete, expected: "cancelled", hides: [/text-destructive/, />Stopped</] },
  { name: "2cb7438: a stopped code run that saved its output", tool: "run_code", part: { state: "output-available", input: code, output: partialRun }, status: complete, expected: "cancelled", shows: [/before-stop/, />Stopped</], hides: [/text-destructive/] },
  { name: "8f9a580: a code run closed by a follow-up message gets its saved output back", tool: "run_code", part: restored({ state: "output-error", input: code, errorText: cancelledOnSend }), status: complete, expected: "cancelled", shows: [/before-stop/], hides: [/User cancelled/, /text-destructive/] },
  { name: "9b67369: a search that returned its stop result", tool: "web_search", part: { state: "output-available", input: search, output: { ok: false, query: "orbit", error: "Search was stopped" } }, status: complete, expected: "cancelled", hides: [/Search was stopped/, /text-destructive/] },
  { name: "9b67369: a search stopped before its result, live", tool: "web_search", part: { state: "input-available", input: search }, status: stoppedLive, expected: "cancelled" },
  { name: "9b67369: a search stopped before its result, after reload", tool: "web_search", part: saved("web_search", { state: "input-available", input: search }), status: complete, expected: "cancelled", hides: [/text-destructive/] },
  { name: "69fc394: a generated view stopped mid-input, live", tool: "render_ui", part: { state: "input-streaming", input: genui }, status: stoppedLive, expected: "cancelled", shows: [stoppedLine], hides: [/text-destructive/, /partial/] },
  { name: "69fc394: a generated view stopped mid-input, after reload", tool: "render_ui", part: saved("render_ui", { state: "input-streaming", input: genui }), status: complete, expected: "cancelled", shows: [stoppedLine], hides: [/text-destructive/, /partial/] },
  { name: "b0c2913: a generated view whose stream failed, live", tool: "render_ui", part: { state: "input-streaming", input: genui }, status: { type: "incomplete", reason: "error" }, expected: "cancelled", shows: [stoppedLine] },
  { name: "17ff93b: a generated view saved by a version before settleInterruptedParts", tool: "render_ui", part: { state: "input-streaming", input: genui }, status: complete, expected: "cancelled", shows: [stoppedLine], hides: [/partial/] },
  { name: "c2e32e2: a generated view closed by a follow-up message", tool: "render_ui", part: { state: "output-error", input: genui, errorText: cancelledOnSend }, status: complete, expected: "cancelled", shows: [stoppedLine], hides: [/User cancelled/, /text-destructive/, /partial/] },
  { name: "c2e32e2: a generated view with a null result after Stop", tool: "render_ui", part: { state: "output-available", input: genui, output: null }, status: complete, expected: "cancelled", shows: [stoppedLine] },
  { name: "c2e32e2: a generated view with a null result while streaming", tool: "render_ui", part: { state: "output-available", input: genui, output: null }, status: { type: "running" }, expected: "running", hides: [/Stopped/] },
  { name: "a generated view whose arguments were rejected", tool: "render_ui", part: { state: "output-error", input: genui, errorText: "Invalid tool arguments" }, status: complete, expected: "failed", shows: [/text-destructive/, /Invalid tool arguments/], hides: [/>Stopped</] },
  { name: "a GitHub call stopped before its result, after reload", tool: "github_list_issues", part: saved("github_list_issues", { state: "input-available", input: {} }), status: complete, expected: "cancelled" },
  { name: "a memory call stopped before its result, after reload", tool: "remember", part: saved("remember", { state: "input-available", input: { text: "x" } }), status: complete, expected: "cancelled" },
  // Kept as failed: c2e32e2 scoped the follow-up cancellation to render_ui. https://github.com/aduthekaddu/orbit/issues/194
  ...["web_search", "run_code", "github_list_issues", "remember"].map((tool): Row => ({ name: `${tool} closed by a follow-up message before its saved result`, tool, part: { state: "output-error", input: {}, errorText: cancelledOnSend }, status: complete, expected: "cancelled" })),
  { name: "fe04620: a code run killed for memory shows one outcome", tool: "run_code", part: { state: "output-available", input: code, output: { stdout: "", stderr: "", exitCode: 137, durationMs: 90, timedOut: false, truncated: false, oomKilled: true } }, status: complete, expected: "failed", shows: [/Out of memory \(exit 137\)/], hides: [/Exit 137|Killed|Timed out/] },
  { name: "fe04620: a code run that timed out shows one outcome", tool: "run_code", part: { state: "output-available", input: code, output: { stdout: "", stderr: "", exitCode: null, durationMs: 10000, timedOut: true, truncated: false } }, status: complete, expected: "failed", shows: [/Timed out/], hides: [/Killed|Exit /] },
  { name: "a code run that exited 0", tool: "run_code", part: { state: "output-available", input: code, output: { stdout: "1\n", stderr: "", exitCode: 0, durationMs: 20, timedOut: false, truncated: false } }, status: complete, expected: "succeeded", shows: [/Exit 0/], hides: [/text-destructive/] },
];

for (const row of rows) {
  test(row.name, () => {
    const html = renderToStaticMarkup(<RunCard {...props(row.tool, row.part, row.status)} />);
    assert.match(html, new RegExp(`data-tool-status="${row.expected}"`), `${row.tool} ${row.part.state} should be ${row.expected}`);
    for (const pattern of row.shows ?? []) assert.match(html, pattern);
    for (const pattern of row.hides ?? []) assert.doesNotMatch(html, pattern);
  });
}

test("9b67369: the result the search tool writes on Stop is cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const never = async () => { throw new Error("no backend runs after Stop"); };
  const output = await searchWeb({ searxngUrl: "searxng", tavilyApiKey: "tavily" }, "orbit", controller.signal, { searxng: never, tavily: never });
  const html = renderToStaticMarkup(<RunCard {...props("web_search", { state: "output-available", input: search, output }, complete)} />);
  assert.match(html, /data-tool-status="cancelled"/, `the search tool wrote ${JSON.stringify(output)}`);
});
