import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderUiPart, SpecView } from "./render-ui";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { parseRenderSpec } from "../../lib/genui/spec";

const card = {
  root: "card",
  elements: {
    card: {
      type: "Card",
      props: { title: "Smoke", description: null },
      children: ["metric"],
    },
    metric: {
      type: "Metric",
      props: { label: "Checks", value: "1", hint: null },
      children: [],
    },
  },
};

function renderPart(overrides: Partial<ToolCallMessagePartProps>) {
  return renderToStaticMarkup(<RenderUiPart
    type="tool-call" toolCallId="view" toolName="render_ui" args={{}} argsText=""
    status={{ type: "running" }} addResult={() => {}} resume={() => {}}
    respondToApproval={async () => {}} {...overrides}
  />);
}

test("a stopped spec shows a muted fallback without raw arguments", () => {
  const html = renderPart({ argsText: '{"root":"unfinished', status: { type: "incomplete", reason: "error" } });
  assert.match(html, /data-genui-fallback/);
  assert.match(html, /text-muted-foreground/);
  assert.match(html, />Stopped</);
  assert.doesNotMatch(html, /unfinished|<pre|<details/);
});

test("a running spec keeps building until the stream stops", () => {
  const html = renderPart({ argsText: '{"root":"unfinished' });
  assert.match(html, />Building</);
  assert.doesNotMatch(html, /data-genui-fallback|Stopped/);
});

test("a rejected spec keeps its error fallback", () => {
  const html = renderPart({ result: { error: "Invalid tool arguments" }, isError: true, status: { type: "complete" } });
  assert.match(html, /data-genui-fallback/);
  assert.match(html, /Invalid tool arguments/);
  assert.doesNotMatch(html, />Stopped</);
});

test("a spec cancelled by a follow-up message shows one muted Stopped fallback without raw arguments", () => {
  const html = renderPart({
    argsText: '{"root":"unfinished',
    result: { error: "User cancelled tool call by sending a new message." },
    isError: true,
    status: { type: "complete" },
  });
  assert.match(html, /<p data-genui-fallback="[^"]*" class="text-sm text-muted-foreground">Stopped<\/p>/);
  assert.doesNotMatch(html, /text-destructive|unfinished|User cancelled|<pre|<details/);
});

test("a valid card renders its title and metric", () => {
  const outcome = parseRenderSpec(card);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const html = renderToStaticMarkup(<SpecView spec={outcome.spec} />);
  assert.match(html, /Smoke/);
  assert.match(html, /Checks/);
  assert.match(html, />1</);
});

test("editable text renders its content in a textbox", () => {
  const outcome = parseRenderSpec({
    root: "text",
    elements: {
      text: { type: "Text", props: { content: "const value = 1 < 2;" }, children: [] },
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const html = renderToStaticMarkup(<SpecView spec={outcome.spec} />);
  assert.match(html, /contenteditable="true"/i);
  assert.match(html, /role="textbox"/);
  assert.match(html, /const value = 1 &lt; 2;/);
});
