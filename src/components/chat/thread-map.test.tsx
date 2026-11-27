import assert from "node:assert/strict";
import test from "node:test";
import { promptsPlace } from "./thread-map";

test("a thread wide enough for the rail shows the rail and no Prompts button", () => {
  assert.equal(promptsPlace(true, true), "rail");
  assert.equal(promptsPlace(true, false), "rail");
});

test("without the rail the Prompts button goes in the header while the header shows", () => {
  assert.equal(promptsPlace(false, true), "header");
});

test("without the rail or the header, as from 768px with the sidebar open, the button goes in the strip", () => {
  assert.equal(promptsPlace(false, false), "strip");
});
