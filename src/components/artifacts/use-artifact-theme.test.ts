import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ARTIFACT_THEME_TOKENS, artifactScheme } from "./use-artifact-theme";

test("the frame scheme follows the page's computed color-scheme", () => {
  assert.equal(artifactScheme("dark", true), "dark");
  assert.equal(artifactScheme("light", false), "light");
  assert.equal(artifactScheme("light dark", true), "light");
  assert.equal(artifactScheme("light dark", false), "dark");
  assert.equal(artifactScheme("dark light", true), "light");
  assert.equal(artifactScheme("normal", true), "light");
  assert.equal(artifactScheme("normal", false), "dark");
});

test("every theme token the frame reads is defined on :root in globals.css", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const start = css.indexOf(":root {");
  const root = css.slice(start, css.indexOf("\n}", start));
  for (const [field, token] of Object.entries(ARTIFACT_THEME_TOKENS)) {
    assert.match(root, new RegExp(`\\n\\s*${token}:`), `${field} reads ${token}`);
  }
  assert.deepEqual(Object.keys(ARTIFACT_THEME_TOKENS).sort(), ["accent", "background", "border", "foreground", "muted", "radius", "ring", "surface"]);
});
