import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantHasVisiblePart, parseRenderSpec } from "./spec";

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

test("a tool-only assistant part is worth saving", () => {
  assert.equal(assistantHasVisiblePart([]), false);
  assert.equal(
    assistantHasVisiblePart([{ type: "tool-render_ui", state: "output-available", output: { ok: true } }]),
    true,
  );
  assert.equal(assistantHasVisiblePart([{ type: "tool-render_ui", state: "input-streaming" }]), false);
  assert.equal(assistantHasVisiblePart([{ type: "text", text: "  " }]), false);
  assert.equal(assistantHasVisiblePart([{ type: "text", text: "pong" }]), true);
});
