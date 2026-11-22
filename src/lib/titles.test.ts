import assert from "node:assert/strict";
import test, { before } from "node:test";

let cleanTitle: (raw: string) => string;
let chatTitle: (text: string) => string;

before(async () => {
  const titles = await import("./titles");
  const messages = await import("./messages");
  cleanTitle = titles.cleanTitle;
  chatTitle = messages.chatTitle;
});

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
