import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantHasVisiblePart, parseRenderSpec, settleInterruptedParts } from "./spec";

function table(columns: string[], rows: Array<Array<string | number>>) {
  return {
    root: "table",
    elements: {
      table: { type: "Table", props: { columns, rows }, children: [] },
    },
  };
}

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

test("a card and a metric pass", () => {
  const outcome = parseRenderSpec(card);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.spec.root, "card");
});

test("a numeric metric value is stored as text", () => {
  const spec = structuredClone(card);
  spec.elements.metric.props.value = 1 as unknown as string;
  const outcome = parseRenderSpec(spec);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.spec.elements.metric.props.value, "1");
});

test("a bad prop fails and does not throw", () => {
  const bad = structuredClone(card);
  bad.elements.card.props.title = 1 as unknown as string;
  const outcome = parseRenderSpec(bad);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /title/);
  assert.equal(outcome.raw, bad);
});

test("an unknown component fails", () => {
  const outcome = parseRenderSpec({
    root: "a",
    elements: { a: { type: "Nope", props: {}, children: [] } },
  });
  assert.equal(outcome.ok, false);
});

test("a dangling child fails", () => {
  const outcome = parseRenderSpec({
    root: "card",
    elements: {
      card: {
        type: "Card",
        props: { title: "Smoke", description: null },
        children: ["missing"],
      },
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /missing/);
});

test("editable text passes and keeps its format", () => {
  const outcome = parseRenderSpec({
    root: "text",
    elements: {
      text: {
        type: "Text",
        props: { label: "Snippet", content: "const value = 1;", format: "code" },
        children: [],
      },
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.spec.elements.text.props.format, "code");
});

test("a text format outside plain and code fails", () => {
  const outcome = parseRenderSpec({
    root: "text",
    elements: {
      text: { type: "Text", props: { content: "x", format: "markdown" }, children: [] },
    },
  });
  assert.equal(outcome.ok, false);
});

test("a table row with more cells than columns fails", () => {
  const outcome = parseRenderSpec(table(["A", "B"], [["1", "2", "3"]]));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /elements\.table\.props\.rows\.0/);
  assert.match(outcome.error, /row 0 has width 3, expected width 2/);
});

test("a table row with fewer cells than columns fails", () => {
  const outcome = parseRenderSpec(table(["A", "B"], [["1"]]));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /elements\.table\.props\.rows\.0/);
  assert.match(outcome.error, /row 0 has width 1, expected width 2/);
});

test("a tool-only assistant part is worth saving", () => {
  assert.equal(assistantHasVisiblePart([]), false);
  assert.equal(
    assistantHasVisiblePart([{ type: "tool-render_ui", state: "output-available", output: { ok: true } }]),
    true,
  );
  assert.equal(assistantHasVisiblePart([{ type: "tool-render_ui", state: "input-streaming" }]), true);
  assert.equal(assistantHasVisiblePart([{ type: "text", text: "  " }]), false);
  assert.equal(assistantHasVisiblePart([{ type: "text", text: "pong" }]), true);
});

test("an interrupted reply settles streaming tool parts to a stopped error", () => {
  const streaming = {
    type: "tool-render_ui",
    toolCallId: "call_1",
    state: "input-streaming",
    input: { root: "card" },
  };
  const finished = { type: "tool-render_ui", toolCallId: "call_2", state: "output-available", output: { ok: true } };
  assert.deepEqual(settleInterruptedParts([streaming, finished], true), [
    { ...streaming, state: "output-error", errorText: "Stopped" },
    finished,
  ]);
  assert.deepEqual(settleInterruptedParts([streaming], false), [streaming]);
  assert.deepEqual(settleInterruptedParts(undefined, true), undefined);
});

test("reasoning counts as a visible reply when it has content", () => {
  assert.equal(assistantHasVisiblePart([{ type: "reasoning", text: "Working on it" }]), true);
  assert.equal(assistantHasVisiblePart([{ type: "reasoning", text: "  " }]), false);
  assert.equal(assistantHasVisiblePart([{ type: "data-reply-end", data: { reason: "stopped" } }]), false);
});
