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
  assert.match(html, />Building view</);
  assert.match(html, /data-slot="skeleton"/);
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

function element(type: string, props: Record<string, unknown>, children: string[] = []) {
  return { type, props, children };
}

const allSpec = {
  root: "card",
  elements: {
    card: element("Card", { title: "Quarterly report", description: "Every catalog component." }, ["metric", "kv", "table", "callout", "button"]),
    metric: element("Metric", { label: "Active users", value: 1234, hint: "Up 12% from last week" }),
    kv: element("KeyValue", { items: [{ label: "Owner", value: "Ada" }, { label: "Budget", value: 42000 }] }),
    table: element("Table", { columns: ["Name", "Role", "Score"], rows: [["Ada", "Engineer", 98], ["Grace", "Admiral", 91]] }),
    callout: element("Callout", { tone: "warning", title: "Heads up", text: "Check the budget.", statePath: "/note" }),
    button: element("Button", { label: "Save note", action: "note", note: "Saved." }),
  },
};

function renderSpec(spec: unknown) {
  return renderPart({ args: spec, result: { ok: true, spec }, status: { type: "complete" } });
}

test("a finished view renders on exactly one surface with grouped numbers", () => {
  const html = renderSpec(allSpec);
  assert.equal(html.match(/data-genui="/g)?.length, 1);
  assert.match(html, />42,000</);
  assert.match(html, />1234</);
  assert.doesNotMatch(html, />42000</);
  assert.doesNotMatch(html, /Generated UI|Succeeded/);
});

test("a metric change shows its sign, arrow, and tone", () => {
  const html = renderSpec({
    root: "up",
    elements: { up: element("Metric", { label: "Revenue", value: 1200, change: 12, changeFormat: "percent" }) },
  });
  assert.match(html, /data-tone="positive"[^>]*>.*data-arrow="up".*\+12%/s);
  const cheaper = renderSpec({
    root: "down",
    elements: { down: element("Metric", { label: "Cost", value: 9, change: -8, changeFormat: "percent", changeTone: "positive" }) },
  });
  assert.match(cheaper, /data-tone="positive"[^>]*>.*data-arrow="down".*-8%/s);
});

test("a metric change that rounds to zero shows no arrow and no tone", () => {
  for (const change of [-0.001, 0.004]) {
    const html = renderSpec({ root: "m", elements: { m: element("Metric", { label: "Drift", value: 50, change, changeFormat: "percent" }) } });
    assert.match(html, /data-tone="neutral"[^>]*>0%</, `change ${change}`);
    assert.doesNotMatch(html, /data-arrow/, `change ${change}`);
  }
  const moved = renderSpec({ root: "m", elements: { m: element("Metric", { label: "Drift", value: 50, change: 0.005, changeFormat: "percent" }) } });
  assert.match(moved, /data-tone="positive"[^>]*>.*data-arrow="up".*\+0\.01%/s);
});

test("a huge table opens at twelve rows with a control for the rest", () => {
  const rows = Array.from({ length: 220 }, (_, index) => [index + 1, `Team ${index % 12}`, (index + 1) * 1000]);
  const html = renderSpec({ root: "table", elements: { table: element("Table", { columns: ["Row", "Team", "Budget"], rows }) } });
  const body = /<tbody[^>]*>(.*?)<\/tbody>/s.exec(html)?.[1] ?? "";
  assert.equal(body.match(/<tr/g)?.length, 12);
  assert.match(html, />Show all 220 rows</);
  assert.match(html, />12,000</);
});

test("a callout carries its tone", () => {
  const html = renderSpec({ root: "c", elements: { c: element("Callout", { tone: "warning", text: "Careful" }) } });
  assert.match(html, /<div data-callout="[^"]*" data-tone="warning"/);
});

test("an invalid spec is one line with a closed Details disclosure", () => {
  const html = renderPart({ result: { ok: false, error: "elements.card.props.title: expected string", raw: { root: "card" } }, status: { type: "complete" } });
  assert.match(html, /<details data-genui-fallback="[^"]*"[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Could not show this view/);
  assert.match(html, />Details</);
});
