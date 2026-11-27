import assert from "node:assert/strict";

export default async function settingsSearchRoute({ page, origin, step }) {
  const save = async (input) => {
    const response = await page.request.put(`${origin}/api/admin/settings`, { data: input });
    assert.equal(response.status(), 200);
    return response.json();
  };
  const redacted = (value) => !("tavilyApiKey" in value) && !JSON.stringify(value).includes("test-tavily-key-not-real");
  const initial = await save({ tavilyApiKey: "test-tavily-key-not-real", searxngUrl: "http://127.0.0.1:8888///" });
  step("PUT settings normalizes the search URL and redacts the Tavily key", initial.searxngUrl === "http://127.0.0.1:8888" && initial.tavilyKeySet && redacted(initial));
  const blank = await save({ tavilyApiKey: "  " });
  step("PUT settings keeps the saved Tavily key on blank input", blank.tavilyKeySet && redacted(blank));
  const omitted = await save({});
  step("PUT settings keeps the Tavily key and the search URL on omitted input", omitted.tavilyKeySet && omitted.searxngUrl === initial.searxngUrl && redacted(omitted));
  const invalid = await page.request.put(`${origin}/api/admin/settings`, { data: { tavilyApiKey: 42 } });
  step("PUT settings rejects an invalid removal value", invalid.status() === 400);
  const unchanged = await (await page.request.get(`${origin}/api/admin/settings`)).json();
  step("a rejected settings write leaves the Tavily key set and redacted", unchanged.tavilyKeySet && redacted(unchanged));
  const removed = await save({ tavilyApiKey: null, searxngUrl: "" });
  const repeated = await save({ tavilyApiKey: null });
  step("explicit removal clears the Tavily key and is repeatable", !removed.tavilyKeySet && !repeated.tavilyKeySet && redacted(removed) && redacted(repeated));
  const persisted = await (await page.request.get(`${origin}/api/admin/settings`)).json();
  step("GET settings reads the cleared search configuration without keys", !persisted.tavilyKeySet && persisted.searxngUrl === "" && redacted(persisted));
}
