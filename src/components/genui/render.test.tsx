import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SpecView } from "./render-ui";
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
