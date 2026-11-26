import assert from "node:assert/strict";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { parseSearchResults, searchSearxng, searchWeb, type SearchBackends } from "./search";

const searxng = {
  results: [
    { title: "<b>Orbit</b> &amp; space", url: "https://example.com/orbit", content: "A <b>small</b> &amp; bright orbit." },
    { title: "Duplicate", url: "https://example.com/orbit", content: "Duplicate" },
    { title: "Unsafe", url: "javascript:alert(1)", content: "Unsafe" },
    { title: "Relative", url: "/relative", content: "Relative" },
    { title: "Long", url: "http://example.org/long", content: "x".repeat(400) },
  ],
};
const tavily = {
  query: "orbit",
  results: [
    { title: "Orbit", url: "https://example.com/orbit", content: "<p>Space &amp; science</p>", score: 0.9 },
    { title: "Duplicate", url: "https://example.com/orbit", content: "Again", score: 0.8 },
    { title: "Unsafe", url: "javascript:alert(1)", content: "Unsafe", score: 0.7 },
  ],
};
const result = { title: "Orbit", url: "https://example.com/orbit", snippet: "Space", engine: "tavily" as const };
const settings = { searxngUrl: "http://127.0.0.1:8888", tavilyApiKey: "test-key-not-real" };

async function fixture(t: TestContext, body: unknown, status = 200) {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

test("recorded SearXNG results become safe plain text without duplicates", () => {
  assert.deepEqual(parseSearchResults(searxng, "searxng"), [
    { title: "Orbit & space", url: "https://example.com/orbit", snippet: "A small & bright orbit.", engine: "searxng" },
    { title: "Long", url: "http://example.org/long", snippet: "x".repeat(300), engine: "searxng" },
  ]);
});

test("recorded Tavily results become safe plain text without duplicates", () => {
  assert.deepEqual(parseSearchResults(tavily, "tavily"), [{ title: "Orbit", url: "https://example.com/orbit", snippet: "Space & science", engine: "tavily" }]);
});

test("search returns at most eight distinct results", () => {
  const results = Array.from({ length: 12 }, (_, index) => ({ title: String(index), url: `https://example.com/${index}`, content: "Text" }));
  assert.equal(parseSearchResults({ results }, "searxng").length, 8);
});

test("malformed backend data is rejected", () => {
  assert.throws(() => parseSearchResults({ results: "invalid" }, "searxng"));
});

test("SearXNG receives the query and requests JSON", async (t) => {
  const local = await fixture(t, searxng);
  assert.equal((await searchSearxng(local.url, "orbit & space")).length, 2);
  assert.equal(local.requests.length, 1);
  const url = new URL(local.requests[0], local.url);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), "orbit & space");
  assert.equal(url.searchParams.get("format"), "json");
});

test("SearXNG keeps a configured path and query when adding the search endpoint", async (t) => {
  const local = await fixture(t, searxng);
  await searchSearxng(`${local.url}/prefix/?mode=fixture#ignored`, "orbit & space");
  assert.equal(local.requests.length, 1);
  const url = new URL(local.requests[0], local.url);
  assert.equal(url.pathname, "/prefix/search");
  assert.equal(url.searchParams.get("mode"), "fixture");
  assert.equal(url.searchParams.get("q"), "orbit & space");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.hash, "");
});

test("a successful SearXNG search does not send the query to Tavily", async (t) => {
  const local = await fixture(t, searxng);
  let tavilyCalls = 0;
  const backends: SearchBackends = {
    searxng: searchSearxng,
    tavily: async () => { tavilyCalls += 1; return [result]; },
  };
  const output = await searchWeb({ ...settings, searxngUrl: local.url }, "orbit", undefined, backends);
  assert.equal(output.ok, true);
  if (output.ok) assert.equal(output.results[0]?.engine, "searxng");
  assert.equal(tavilyCalls, 0);
});

for (const [name, body, status] of [["empty", { results: [] }, 200], ["failed", {}, 503]] as const) {
  test(`Tavily runs after an ${name} SearXNG search`, async (t) => {
    const local = await fixture(t, body, status);
    let tavilyCalls = 0;
    const backends: SearchBackends = {
      searxng: searchSearxng,
      tavily: async (key, query) => { assert.equal(key, settings.tavilyApiKey); assert.equal(query, "orbit"); tavilyCalls += 1; return [result]; },
    };
    const output = await searchWeb({ ...settings, searxngUrl: local.url }, "orbit", undefined, backends);
    assert.deepEqual(output, { ok: true, query: "orbit", results: [result] });
    assert.equal(tavilyCalls, 1);
  });
}

test("backend failure is returned without private exception text", async () => {
  const backends: SearchBackends = {
    searxng: async () => { throw new Error("private-provider-detail"); },
    tavily: async () => { throw new Error(settings.tavilyApiKey); },
  };
  const output = await searchWeb(settings, "orbit", undefined, backends);
  assert.equal(output.ok, false);
  assert.equal(JSON.stringify(output).includes(settings.tavilyApiKey), false);
  assert.equal(JSON.stringify(output).includes("private-provider-detail"), false);
});

test("a cancelled search does not start the fallback backend", async (t) => {
  const diagnostic = t.mock.method(console, "warn", () => {});
  const controller = new AbortController();
  let tavilyCalls = 0;
  const backends: SearchBackends = {
    searxng: async () => { controller.abort(); throw new Error("cancelled"); },
    tavily: async () => { tavilyCalls += 1; return [result]; },
  };
  const output = await searchWeb(settings, "orbit", controller.signal, backends);
  assert.equal(output.ok, false);
  assert.equal(tavilyCalls, 0);
  assert.equal(diagnostic.mock.callCount(), 0);
});

test("a stalled search returns a failure after its eight second deadline", { timeout: 12_000 }, async (t) => {
  const server = http.createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const output = await searchWeb({ searxngUrl: `http://127.0.0.1:${address.port}`, tavilyApiKey: "" }, "orbit");
  assert.equal(output.ok, false);
  if (!output.ok) assert.match(output.error, /timed out/i);
});


test("encoded HTML in titles and snippets becomes plain text", () => {
  assert.deepEqual(parseSearchResults({ results: [{ title: "&lt;b&gt;Orbit&lt;/b&gt;", url: "https://example.com/orbit", content: "&lt;p&gt;Space &amp; science&lt;/p&gt;" }] }, "searxng"), [{ title: "Orbit", url: "https://example.com/orbit", snippet: "Space & science", engine: "searxng" }]);
});

test("Tavily works without a SearXNG URL", async () => {
  let searxngCalls = 0;
  const backends: SearchBackends = {
    searxng: async () => { searxngCalls += 1; return []; },
    tavily: async () => [result],
  };
  assert.deepEqual(await searchWeb({ ...settings, searxngUrl: "" }, "orbit", undefined, backends), { ok: true, query: "orbit", results: [result] });
  assert.equal(searxngCalls, 0);
});

test("caller cancellation closes a pending SearXNG request without fallback", { timeout: 5000 }, async (t) => {
  let received: () => void = () => {};
  const started = new Promise<void>((resolve) => { received = resolve; });
  let closed: () => void = () => {};
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
  const server = http.createServer((_request, response) => { received(); response.on("close", closed); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  let tavilyCalls = 0;
  const output = searchWeb({ ...settings, searxngUrl: `http://127.0.0.1:${address.port}` }, "orbit", controller.signal, {
    searxng: searchSearxng,
    tavily: async () => { tavilyCalls += 1; return [result]; },
  });
  await started;
  controller.abort();
  assert.equal((await output).ok, false);
  await disconnected;
  assert.equal(tavilyCalls, 0);
});

test("an HTTP search failure logs its backend and status without response data", async (t) => {
  const diagnostic = t.mock.method(console, "warn", () => {});
  const local = await fixture(t, { error: "private-provider-detail" }, 503);
  const output = await searchWeb({ searxngUrl: local.url, tavilyApiKey: "" }, "private-query");
  assert.deepEqual(output, { ok: false, query: "private-query", error: "Search is unavailable" });
  assert.equal(diagnostic.mock.callCount(), 1);
  assert.deepEqual(diagnostic.mock.calls[0]?.arguments, ["web search backend failed", { backend: "searxng", error: "HttpError", status: 503 }]);
});

test("Tavily failure diagnostics omit exception messages, names, keys and queries", async (t) => {
  const diagnostic = t.mock.method(console, "warn", () => {});
  const error = new Error("private-provider-detail");
  error.name = "private-error-name";
  await searchWeb({ searxngUrl: "", tavilyApiKey: "test-key-not-real" }, "private-query", undefined, {
    searxng: async () => [], tavily: async () => { throw error; },
  });
  assert.deepEqual(diagnostic.mock.calls.map((call) => call.arguments), [["web search backend failed", { backend: "tavily", error: "Error" }]]);
});

test("a malformed search response logs a safe failure category", async (t) => {
  const diagnostic = t.mock.method(console, "warn", () => {});
  const local = await fixture(t, { results: "private-provider-detail" });
  await searchWeb({ searxngUrl: local.url, tavilyApiKey: "" }, "private-query");
  assert.deepEqual(diagnostic.mock.calls.map((call) => call.arguments), [["web search backend failed", { backend: "searxng", error: "ZodError" }]]);
});

test("web_search masks stored credentials in titles, URLs, snippets, and queries, including keys straddling the snippet limit", async (t) => {
  const providerKey = "made-up-provider-key-0001";
  const tavilyKey = "made-up-tavily-key-0002";
  const githubToken = "made-up-github-token-0003";
  const local = await fixture(t, {
    results: [
      {
        title: `Docs for ${tavilyKey} &amp; ${providerKey}`,
        url: `https://example.com/search?k=${encodeURIComponent(tavilyKey)}&p=made%2Dup-provider-key-0001`,
        content: `${"a".repeat(290)}${tavilyKey} and ${githubToken}`,
      },
    ],
  });
  const { toolsFor } = await import("./index");
  const tools = toolsFor({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: providerKey,
    model: "mock",
    reasoningEffort: "low",
    searxngUrl: local.url,
    tavilyApiKey: tavilyKey,
    githubToken,
    githubMcpUrl: "",
  });
  const execute = tools.web_search?.execute;
  assert.ok(execute);
  const output = (await execute({ query: `lookup ${providerKey}` }, { toolCallId: "s1", messages: [], context: {} })) as {
    ok: boolean;
    query: string;
    results?: Array<{ title: string; url: string; snippet: string }>;
  };
  assert.equal(output.ok, true);
  assert.equal(output.query, "lookup [redacted]");
  const first = output.results?.[0];
  assert.ok(first);
  assert.equal(first.title, "Docs for [redacted] & [redacted]");
  assert.equal(first.url, "https://example.com/search?k=[redacted]&p=[redacted]");
  assert.equal(first.snippet.includes("made-up"), false, `snippet leaked clipped key: ${first.snippet}`);
  assert.equal(first.snippet.endsWith("[redacted]"), true, `expected masked tail in snippet: ${first.snippet}`);
  const serialized = JSON.stringify(output);
  for (const secret of [providerKey, tavilyKey, githubToken]) {
    assert.equal(serialized.includes(secret), false, `search output carried ${secret}`);
  }
});

test("searchWeb passes the redactor to configured backends and masks each search result once", async (t) => {
  const { Redactor } = await import("../chat-errors");
  const redactor = new Redactor({ apiKey: "made-up-provider-key-0001", tavilyApiKey: settings.tavilyApiKey, githubToken: "" });

  let searxRedact: unknown;
  let tavilyRedact: unknown;
  const fallback = await searchWeb(
    settings,
    "orbit",
    undefined,
    {
      searxng: async (_url, _query, _signal, redact) => {
        searxRedact = redact;
        return [];
      },
      tavily: async (_key, _query, _signal, redact) => {
        tavilyRedact = redact;
        return [result];
      },
    },
    redactor,
  );
  assert.equal(fallback.ok, true);
  assert.equal(searxRedact, redactor, "custom searxng backend did not receive the redactor");
  assert.equal(tavilyRedact, redactor, "custom tavily backend did not receive the redactor");

  const local = await fixture(t, {
    results: [{ title: "Orbit", url: "https://example.com/orbit", content: "Bright orbit" }],
  });
  const spy = t.mock.method(redactor, "text");
  const output = await searchWeb({ searxngUrl: local.url, tavilyApiKey: "" }, "orbit", undefined, undefined, redactor);
  assert.equal(output.ok, true);
  // 1 call for query + 1 each for url, title, and snippet (not masked a second time).
  assert.equal(spy.mock.callCount(), 4, `expected 4 redact.text calls, got ${spy.mock.callCount()}`);
});
