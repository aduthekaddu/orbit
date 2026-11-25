import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { pollSavedReplies } from "./stopped-run-sync";

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const stoppedOutput = { stdout: "", stderr: "", exitCode: null, durationMs: 20, timedOut: false, truncated: false, cancelled: true };
const savedReply = { id: "m1", role: "assistant", parts: [{ type: "tool-run_code", toolCallId: "t1", state: "output-available", output: stoppedOutput }] };

// Answers every read of the saved chat with `answer` and returns what the poll saw.
async function poll(answer: () => Promise<Response>, signal = new AbortController().signal) {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return answer();
  };
  const found: UIMessage[][] = [];
  const missing = await pollSavedReplies("c1", ["m1"], signal, (replies) => found.push(replies));
  return { missing, found, requests };
}

test("a saved reply ends the poll with nothing missing", async () => {
  const { missing, found } = await poll(async () => Response.json({ messages: [{ message: savedReply }] }));
  assert.deepEqual(missing, []);
  assert.deepEqual(found.at(-1)?.map(({ id }) => id), ["m1"]);
});

test("a saved reply whose parts are not message parts is not taken as the reply", async () => {
  const { missing, found } = await poll(async () => Response.json({ messages: [{ message: { id: "m1", role: "assistant", parts: [null] } }] }));
  assert.deepEqual(found, []);
  assert.deepEqual(missing, ["m1"]);
});

test("a saved chat that cannot be read ends the poll with the reply missing", async () => {
  for (const answer of [
    async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    },
    async () => Response.json({ error: "Not found" }, { status: 404 }),
  ]) {
    const { missing, requests } = await poll(answer);
    assert.deepEqual(missing, ["m1"]);
    assert.equal(requests, 1);
  }
});

test("an aborted poll reports nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const { missing, requests } = await poll(async () => Response.json({ messages: [] }), controller.signal);
  assert.equal(missing, null);
  assert.equal(requests, 0);
});
