import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "commonjs", source: "module.exports = {}", shortCircuit: true };
    return nextLoad(url, context);
  },
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LookContext, type Fidelity, type Look } from "./looks";

const windowModule = import("./window");

const look: Look = { theme: "light", palette: "accent", fidelity: "standard", layout: "wide" };

async function render(fidelity: Fidelity, filler: boolean, style: CSSProperties) {
  const { Text } = await windowModule;
  return renderToStaticMarkup(
    createElement(LookContext.Provider, { value: { ...look, fidelity } }, createElement(Text, { filler, style, children: "Lisbon" })),
  );
}

test("Text keeps caller styles when it draws a placeholder bar", async () => {
  const cases = [
    { name: "minimal fidelity", fidelity: "minimal" as const, filler: false },
    { name: "filler text", fidelity: "standard" as const, filler: true },
  ];
  for (const { name, fidelity, filler } of cases) {
    const html = await render(fidelity, filler, { color: "red", fontSize: 14 });
    assert.match(html, /class="ss-bar"/, `${name}: draws a placeholder bar`);
    assert.match(html, /color:red/, `${name}: keeps the caller's color`);
    assert.match(html, /font-size:14px/, `${name}: keeps the caller's font size`);
  }
});
