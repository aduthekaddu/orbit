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
