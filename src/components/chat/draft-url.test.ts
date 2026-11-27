import assert from "node:assert/strict";
import test from "node:test";
import { withoutNewParam } from "./draft-url";

test("dropping ?new keeps the chat path", () => {
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/7f0c?new", "7f0c"), "http://127.0.0.1:3210/c/7f0c");
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/7f0c?new=", "7f0c"), "http://127.0.0.1:3210/c/7f0c");
});

test("dropping ?new keeps ?artifact=, ?m= and the hash", () => {
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/7f0c?new&artifact=a1%3A0", "7f0c"), "http://127.0.0.1:3210/c/7f0c?artifact=a1%3A0");
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/7f0c?m=u1&new#end", "7f0c"), "http://127.0.0.1:3210/c/7f0c?m=u1#end");
});

test("a URL without ?new needs no rewrite", () => {
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/7f0c", "7f0c"), null);
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/7f0c?m=u1&artifact=a1", "7f0c"), null);
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/7f0c?newer=1", "7f0c"), null);
});

test("a late answer for one draft leaves the ?new of the draft now open", () => {
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/second?new", "first"), null);
  assert.equal(withoutNewParam("http://127.0.0.1:3210/new", "first"), null);
  assert.equal(withoutNewParam("http://127.0.0.1:3210/c/first?new", "first"), "http://127.0.0.1:3210/c/first");
});
