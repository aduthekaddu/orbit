import assert from "node:assert/strict";
import test from "node:test";
import { chatTitle } from "./messages";
import { cleanTitle, titlePrompt } from "./titles";

test("cleanTitle drops wrapping quotes and a trailing period", () => {
  assert.equal(cleanTitle('"Stack trace."'), "Stack trace");
});

test("cleanTitle drops markdown before the sidebar cut", () => {
  assert.equal(cleanTitle("**Bold** idea."), "Bold idea");
});

test("cleanTitle keeps the sidebar length cut", () => {
  const long = `${"word ".repeat(30).trim()}.`;
  assert.equal(cleanTitle(long), chatTitle(long.slice(0, -1)));
  assert.ok(cleanTitle(long).endsWith("…"));
});

test("titlePrompt sends only the first 2,000 characters of a long first message", () => {
  const instructions = Array.from(titlePrompt("")).length;
  const prompt = titlePrompt(`${"a".repeat(2_000)}${"b".repeat(198_000)}`);
  assert.equal(Array.from(prompt).length, instructions + 2_000);
  assert.ok(prompt.endsWith("a".repeat(2_000)));
});

test("titlePrompt counts characters outside the Basic Multilingual Plane as one each", () => {
  const instructions = Array.from(titlePrompt("")).length;
  const prompt = titlePrompt("😀".repeat(5_000));
  assert.equal(Array.from(prompt).length, instructions + 2_000);
  assert.ok(prompt.isWellFormed());
  assert.ok(prompt.endsWith("😀".repeat(2_000)));
});

test("titlePrompt keeps a short first message whole", () => {
  assert.ok(titlePrompt("short question").endsWith("short question"));
});
