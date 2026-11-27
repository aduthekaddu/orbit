import assert from "node:assert/strict";
import test from "node:test";
import { appliedSave, type SettingsSnapshot } from "./settings-form";

const submitted: SettingsSnapshot = {
  searxngUrl: "http://127.0.0.1:8888",
  tavilyApiKey: "test-tavily-key-not-real",
  githubToken: "",
  githubMcpUrl: "https://api.githubcopilot.com/mcp/",
};

test("unchanged values clear the keys and report saved", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted }), { clearTavilyKey: true, clearGithubToken: true, saved: true });
});

test("a Tavily key typed during save remains in the field", () => {
  const applied = appliedSave(submitted, { ...submitted, tavilyApiKey: "new-test-key" });
  assert.equal(applied.clearTavilyKey, false);
  assert.equal(applied.saved, false);
});

test("a search URL edited during save is not reported as saved", () => {
  assert.equal(appliedSave(submitted, { ...submitted, searxngUrl: "http://127.0.0.1:9999" }).saved, false);
});

test("a GitHub token typed during save stays in the field", () => {
  const applied = appliedSave(submitted, { ...submitted, githubToken: "typed-during-save" });
  assert.equal(applied.clearGithubToken, false);
  assert.equal(applied.saved, false);
});

test("a GitHub MCP URL edited during save is not reported as saved", () => {
  assert.equal(appliedSave(submitted, { ...submitted, githubMcpUrl: "http://127.0.0.1:9/mcp" }).saved, false);
});

test("a key typed during a removal save stays in the field", () => {
  const removal = { ...submitted, tavilyApiKey: null };
  const applied = appliedSave(removal, { ...submitted, tavilyApiKey: "new-test-key" });
  assert.equal(applied.clearTavilyKey, false);
  assert.equal(applied.saved, false);
});
