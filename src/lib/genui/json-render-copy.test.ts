import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("the app and @json-render/react load the same @json-render/core", () => {
  const react = path.dirname(require.resolve("@json-render/react"));
  const fromReact = require.resolve("@json-render/core", { paths: [react] });
  const fromApp = require.resolve("@json-render/core");
  assert.equal(fromReact, fromApp, "@json-render/react brings its own @json-render/core, so specs cross two versions. Bump both packages together.");
});
