import assert from "node:assert/strict";

export default async function settingsSearchRoute({ page, origin, step }) {
  const provider = { baseUrl: "http://127.0.0.1:3299/v1", model: "mock-genui", reasoningEffort: "low" };
  const save = async (input) => {
    const response = await page.request.put(`${origin}/api/settings`, { data: { ...provider, ...input } });
    assert.equal(response.status(), 200);
    return response.json();
  };
  const redacted = (value) => !("apiKey" in value) && !("tavilyApiKey" in value) && !JSON.stringify(value).includes("test-key-not-real") && !JSON.stringify(value).includes("test-tavily-key-not-real");
  const initial = await save({ apiKey: "test-key-not-real", tavilyApiKey: "test-tavily-key-not-real", searxngUrl: "http://127.0.0.1:8888///" });
  step("PUT settings normalizes the search URL and redacts both keys", initial.searxngUrl === "http://127.0.0.1:8888" && initial.keySet && initial.tavilyKeySet && redacted(initial));
  const blank = await save({ apiKey: "  ", tavilyApiKey: "  " });
  step("PUT settings preserves both saved keys on blank input", blank.keySet && blank.tavilyKeySet && redacted(blank));
  const omitted = await save({});
  step("PUT settings preserves both keys and the search URL on omitted input", omitted.keySet && omitted.tavilyKeySet && omitted.searxngUrl === initial.searxngUrl && redacted(omitted));
  const invalid = await page.request.put(`${origin}/api/settings`, { data: { ...provider, tavilyApiKey: 42 } });
  step("PUT settings rejects an invalid removal value", invalid.status() === 400);
  const unchanged = await (await page.request.get(`${origin}/api/settings`)).json();
  step("a rejected settings write leaves both keys set and redacted", unchanged.keySet && unchanged.tavilyKeySet && redacted(unchanged));
  const removed = await save({ tavilyApiKey: null, searxngUrl: "" });
  const repeated = await save({ tavilyApiKey: null });
  step("explicit removal clears only the Tavily key and is repeatable", removed.keySet && !removed.tavilyKeySet && repeated.keySet && !repeated.tavilyKeySet && redacted(removed) && redacted(repeated));
  const persisted = await (await page.request.get(`${origin}/api/settings`)).json();
  step("GET settings reads the cleared search configuration without keys", persisted.keySet && !persisted.tavilyKeySet && persisted.searxngUrl === "" && redacted(persisted));
}
