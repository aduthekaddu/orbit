import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBaseUrl } from "./base-url";
import { OPENCODE_GO_BASE_URL, openCodeSessionHeader } from "./provider";

test("a case variant of the OpenCode URL still gets the session header", () => {
  assert.equal(normalizeBaseUrl("https://OpenCode.AI/inference/go/openai/v1/"), OPENCODE_GO_BASE_URL);
  assert.deepEqual(openCodeSessionHeader("https://OpenCode.ai/inference/go/openai/v1", "chat-1"), {
    "x-opencode-session": "chat-1",
  });
});

test("normalizing removes a trailing slash and a default port", () => {
  assert.equal(normalizeBaseUrl(" https://example.com:443/v1/ "), "https://example.com/v1");
});

test("a different path case stays a different provider", () => {
  assert.equal(normalizeBaseUrl("https://opencode.ai/inference/go/openai/V1"), "https://opencode.ai/inference/go/openai/V1");
});
