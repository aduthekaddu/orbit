import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { requestJson, useLatestRequest, type RequestFailure } from "./request-json";

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

type Seen = { ok: unknown } | { failed: RequestFailure } | "nothing";

async function outcome(answer: () => Promise<Response>, parse: z.ZodType<unknown> = z.object({ id: z.string() }), init: RequestInit = {}) {
  globalThis.fetch = answer;
  let seen: Seen = "nothing";
  await requestJson("/api/chats", init, { parse, onOk: (data) => (seen = { ok: data }), onFailed: (failure) => (seen = { failed: failure }) });
  return seen;
}

test("a parsed body goes to onOk", async () => {
  assert.deepEqual(await outcome(async () => Response.json({ id: "c1", extra: true }, { status: 201 })), { ok: { id: "c1" } });
});

test("a request that never reaches the server is a network failure", async () => {
  const offline = async (): Promise<Response> => {
    throw new TypeError("Failed to fetch");
  };
  assert.deepEqual(await outcome(offline), { failed: { kind: "network" } });
});

test("an HTTP error carries its status and the server's error text", async () => {
  assert.deepEqual(await outcome(async () => Response.json({ error: "Not found" }, { status: 404 })), {
    failed: { kind: "http", status: 404, error: "Not found" },
  });
});

test("an HTTP error without a JSON error has no error text", async () => {
  assert.deepEqual(await outcome(async () => new Response("<html>Bad Gateway</html>", { status: 502 })), {
    failed: { kind: "http", status: 502, error: null },
  });
});

test("a success body that does not match is invalid, not empty", async () => {
  assert.deepEqual(await outcome(async () => Response.json({}, { status: 201 })), { failed: { kind: "invalid" } });
  assert.deepEqual(await outcome(async () => new Response("<html></html>", { status: 200 })), { failed: { kind: "invalid" } });
  assert.deepEqual(await outcome(async () => new Response(null, { status: 204 })), { failed: { kind: "invalid" } });
});

test("a success body that is not JSON is invalid, even for a schema that allows null", async () => {
  assert.deepEqual(await outcome(async () => new Response("{not json", { status: 200 }), z.null()), { failed: { kind: "invalid" } });
});

const throws = () => {
  throw new Error("boom");
};

// Collects what console.error saw, so a handler's own bug still shows in the console.
function reported(run: () => Promise<unknown>) {
  const realError = console.error;
  const errors: unknown[] = [];
  console.error = (error: unknown) => errors.push(error);
  return run()
    .then((value) => ({ value, errors: errors.map((error) => (error instanceof Error ? error.message : error)) }))
    .finally(() => (console.error = realError));
}

test("a schema that throws makes the answer invalid and is reported", async () => {
  const { value, errors } = await reported(() => outcome(async () => Response.json({ id: "c1" }), z.custom(throws)));
  assert.deepEqual(value, { failed: { kind: "invalid" } });
  assert.deepEqual(errors, ["boom"]);
});

test("an onOk that throws or rejects ends in onFailed and is reported", async () => {
  globalThis.fetch = async () => Response.json({ id: "c1" });
  for (const onOk of [throws, async () => throws()]) {
    const failures: RequestFailure[] = [];
    const { errors } = await reported(() => requestJson("/api/chats", {}, { parse: z.object({ id: z.string() }), onOk, onFailed: (failure) => failures.push(failure) }));
    assert.deepEqual(failures, [{ kind: "handler" }]);
    assert.deepEqual(errors, ["boom"]);
  }
});

test("an onFailed that throws is reported, and requestJson still resolves", async () => {
  globalThis.fetch = async () => new Response(null, { status: 500 });
  for (const onFailed of [throws, async () => throws()]) {
    const { value, errors } = await reported(() => requestJson("/api/chats", {}, { parse: z.object({ id: z.string() }), onOk: () => {}, onFailed }));
    assert.equal(value, undefined);
    assert.deepEqual(errors, ["boom"]);
  }
});

test("a request aborted before its answer runs neither handler", async () => {
  const controller = new AbortController();
  const answer = async () => {
    controller.abort();
    return Response.json({ id: "late" });
  };
  assert.equal(await outcome(answer, undefined, { signal: controller.signal }), "nothing");
});

test("a newer request from useLatestRequest makes the older answer drop", async () => {
  let latest: (() => AbortSignal) | null = null;
  function Probe() {
    latest = useLatestRequest();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  assert.ok(latest);
  const next = latest as () => AbortSignal;
  const older = next();
  const newer = next();
  const answers: Array<() => void> = [];
  globalThis.fetch = (_input, init) =>
    new Promise((resolve) => answers.push(() => resolve(Response.json({ id: init?.signal === older ? "older" : "newer" }))));
  const shown: string[] = [];
  const handlers = { parse: z.object({ id: z.string() }), onOk: ({ id }: { id: string }) => shown.push(id), onFailed: () => shown.push("failed") };
  const first = requestJson("/api/chats", { signal: older }, handlers);
  const second = requestJson("/api/chats", { signal: newer }, handlers);
  answers[1]();
  answers[0]();
  await Promise.all([first, second]);
  assert.deepEqual(shown, ["newer"]);
});

// The PR 159 shape: a delete with a success branch and no failure branch. It must not compile.
export async function deleteWithoutFailureBranch(id: string, refresh: () => void) {
  // @ts-expect-error onFailed is required, so a failed delete cannot look like nothing happened.
  await requestJson(`/api/memories/${id}`, { method: "DELETE" }, { parse: z.object({ ok: z.literal(true) }), onOk: refresh });
}
