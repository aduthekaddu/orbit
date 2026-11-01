import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Slider } from "./slider";

function thumbCount(props: Parameters<typeof Slider>[0]) {
  const html = renderToStaticMarkup(createElement(Slider, props));
  return html.split('data-slot="slider-thumb"').length - 1;
}

test("an empty value array still renders one thumb", () => {
  assert.equal(thumbCount({ value: [] }), 1);
});

test("a one-value range renders one thumb", () => {
  assert.equal(thumbCount({ value: [25] }), 1);
});

test("no value props renders one thumb", () => {
  assert.equal(thumbCount({}), 1);
});
