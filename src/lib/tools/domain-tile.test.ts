import assert from "node:assert/strict";
import test from "node:test";
import { domainTile } from "./domain-tile";

test("a tile shows the host's first letter without www", () => {
  assert.equal(domainTile("https://www.github.com/x").letter, "G");
  assert.equal(domainTile("https://9to5mac.com/").letter, "9");
  assert.equal(domainTile("https://-odd.example/").letter, "O");
});

test("the same host always gets the same tone, and www does not change it", () => {
  assert.deepEqual(domainTile("https://example.com/a"), domainTile("https://example.com/b?q=1"));
  assert.deepEqual(domainTile("https://www.example.com/"), domainTile("https://example.com/"));
});

test("sibling hosts share a letter and get their own tones", () => {
  const tiles = ["https://example.com/orbit", "https://example.org/space", "https://example.net/news"].map(domainTile);
  assert.deepEqual(tiles.map((tile) => tile.letter), ["E", "E", "E"]);
  assert.equal(new Set(tiles.map((tile) => tile.tone)).size, 3);
});

test("tones fall in one to five", () => {
  for (const host of ["a.com", "b.org", "news.ycombinator.com", "developer.mozilla.org", "en.wikipedia.org", "x.y.z"]) {
    const { tone } = domainTile(`https://${host}/`);
    assert.ok(Number.isInteger(tone) && tone >= 1 && tone <= 5, `${host} gave ${tone}`);
  }
});
