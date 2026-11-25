import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import axios from "axios";
import { tavily } from "@tavily/core";
import { z } from "zod";
import { eventually } from "../eventually.mjs";
import { parseSearchResults, searchWeb } from "./search";
import { withTavilySignal } from "./tavily-signal";

function latch() {
  let released = false;
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = () => { released = true; resolve(); }; });
  return { promise, release, isReleased: () => released };
}

async function fixture(t: TestContext, handle: (query: string, response: http.ServerResponse) => void) {
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const query = request.method === "GET" ? "unrelated" : z.object({ query: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString())).query;
    handle(query, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  return { url, client: tavily({ apiKey: "test-key-not-real", apiBaseURL: url }) };
}

function finish(response: http.ServerResponse, query: string) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ query, images: [], results: [{ title: "Orbit", url: "https://example.com/orbit", content: "Space", score: 1 }], response_time: 0.01 }));
}

function waitForClose(closed: ReturnType<typeof latch>, what: string) {
  return eventually(() => closed.isReleased(), (done) => done, { timeoutMs: 500, what });
}

test("stopping Tavily closes the actual SDK request", { timeout: 3000 }, async (t) => {
  const started = latch();
  const closed = latch();
  let finished = false;
  const { client } = await fixture(t, (_query, response) => {
    response.on("close", () => { finished = response.writableEnded; closed.release(); });
    started.release();
  });
  const controller = new AbortController();
  const reason = new DOMException("Stopped", "AbortError");
  const pending = withTavilySignal(controller.signal, () => client.search("orbit", { timeout: 8 }));
  const rejected = assert.rejects(pending, (error: unknown) => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejected;
  await waitForClose(closed, "the SDK connection to close after cancellation");
  assert.equal(finished, false);
});

test("a cancelled SDK call leaves concurrent and unrelated requests running", { timeout: 3000 }, async (t) => {
  const firstStarted = latch();
  const secondStarted = latch();
  const firstClosed = latch();
  let received = 0;
  const { client, url } = await fixture(t, (query, response) => {
    if (query === "unrelated") { finish(response, query); return; }
    received += 1;
    if (received === 1) {
      response.on("close", firstClosed.release);
      firstStarted.release();
    } else {
      secondStarted.release();
      const timer = setTimeout(() => finish(response, query), 100);
      response.on("close", () => clearTimeout(timer));
    }
  });
  const controller = new AbortController();
  const first = withTavilySignal(controller.signal, () => client.search("same query", { timeout: 8 }));
  const rejected = assert.rejects(first);
  await firstStarted.promise;
  const second = withTavilySignal(new AbortController().signal, () => client.search("same query", { timeout: 8 }));
  await secondStarted.promise;
  controller.abort();
  const unrelated = axios.get(url);
  await rejected;
  await waitForClose(firstClosed, "the cancelled connection to close");
  assert.equal((await second).results[0]?.url, "https://example.com/orbit");
  assert.equal((await unrelated).status, 200);
});

test("a Tavily deadline closes its request and returns a search failure", { timeout: 3000 }, async (t) => {
  const started = latch();
  const closed = latch();
  const { client } = await fixture(t, (_query, response) => {
    response.on("close", closed.release);
    started.release();
  });
  const controller = new AbortController();
  const pending = searchWeb({ searxngUrl: "", tavilyApiKey: "test-key-not-real" }, "orbit", undefined, {
    searxng: async () => [],
    tavily: async (_key, query) => parseSearchResults(await withTavilySignal(controller.signal, async () => { await delay(150); return client.search(query, { timeout: 8 }); }), "tavily"),
  });
  await started.promise;
  const timer = setTimeout(() => controller.abort(new DOMException("Search timed out", "TimeoutError")), 100);
  t.after(() => clearTimeout(timer));
  const output = await pending;
  assert.deepEqual(output, { ok: false, query: "orbit", error: "Search timed out" });
  await waitForClose(closed, "the SDK connection to close after the deadline");
});
