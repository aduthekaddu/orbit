import assert from "node:assert/strict";
import test from "node:test";
import { parseRun, storedRow, transition, type MemoryRun, type RunEvent } from "./run-state";

const CHATS = ["chat-a", "chat-b", "chat-c"];
const OWNERS = ["worker-a", "worker-b"];
const START = Date.parse("2099-01-01T03:00:00Z");

function random(seed: number) {
  let state = seed >>> 0;
  return (size: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) % size;
  };
}

function randomEvent(pick: (size: number) => number, clock: number): RunEvent {
  const owner = OWNERS[pick(OWNERS.length)];
  const at = new Date(clock);
  switch (pick(6)) {
    case 0:
      return { type: "claim", date: "2099-01-01", owner, at, chatIds: CHATS.slice(0, 1 + pick(CHATS.length)) };
    case 1:
      return { type: "reopen", owner, at };
    case 2:
      return { type: "renew", owner, at };
    case 3:
      return { type: "chat", owner, chatId: CHATS[pick(CHATS.length)], outcome: pick(2) === 0 ? "done" : "retry", added: pick(3), merged: pick(2) };
    case 4:
      return { type: "done", owner, at, embedded: { ok: true, embedded: pick(4) } };
    default:
      return { type: "fail", owner, at, error: "Ollama is unreachable" };
  }
}

function unsettled(run: MemoryRun): string[] {
  return run.chatIds.filter((id) => !run.doneChatIds.includes(id) && !run.retryChatIds.includes(id));
}

test("a finished run never leaves a chat outside the done and retry lists", () => {
  const reached = new Set<string>();
  for (let seed = 1; seed <= 400; seed += 1) {
    const pick = random(seed);
    let run: MemoryRun | null = null;
    let clock = START;
    for (let step = 0; step < 40; step += 1) {
      clock += pick(4) * 60_000;
      const event = randomEvent(pick, clock);
      const next = transition(run, event);
      if (next === null) continue;
      if (next.state !== "running") {
        assert.deepEqual(unsettled(next), [], `seed ${seed} step ${step}: ${event.type} left ${next.state} with unsettled chats`);
      }
      assert.deepEqual(parseRun(storedRow(next)), next, `seed ${seed} step ${step}: the stored row does not read back`);
      reached.add(`${run?.state ?? "none"} ${event.type}`);
      run = next;
    }
  }
  assert.deepEqual(
    [...reached].sort(),
    ["failed reopen", "none claim", "running chat", "running claim", "running done", "running fail", "running renew"],
    "the random walks must reach every transition",
  );
});

test("a failure before every chat finishes keeps the unfinished chats for the next night", () => {
  const claimed = transition(null, { type: "claim", date: "2099-01-01", owner: "worker-a", at: new Date(START), chatIds: CHATS });
  const first = transition(claimed, { type: "chat", owner: "worker-a", chatId: "chat-a", outcome: "done", added: 1, merged: 0 });
  const failed = transition(first, { type: "fail", owner: "worker-a", at: new Date(START + 1_000), error: "Ollama timed out" });
  assert.equal(failed?.state, "failed");
  assert.deepEqual(failed?.retryChatIds, ["chat-b", "chat-c"]);
  assert.deepEqual(failed?.doneChatIds, ["chat-a"]);
});

test("a run with a chat still pending cannot be marked done", () => {
  const claimed = transition(null, { type: "claim", date: "2099-01-01", owner: "worker-a", at: new Date(START), chatIds: CHATS });
  assert.equal(transition(claimed, { type: "done", owner: "worker-a", at: new Date(START), embedded: { ok: true, embedded: 0 } }), null);
});

// npm run typecheck fails if a done event stops requiring a successful final embed pass.
// @ts-expect-error a done event must carry the embed result
const doneWithoutEmbed: RunEvent = { type: "done", owner: "worker-a", at: new Date(START) };
// @ts-expect-error a failed embed pass is not proof
const doneAfterFailedEmbed: RunEvent = { type: "done", owner: "worker-a", at: new Date(START), embedded: { ok: false, error: "Ollama timed out", embedded: 0 } };

test("a stored row from before the transition function still reads", () => {
  const row = {
    date: "2026-11-08",
    state: "failed",
    startedAt: START,
    finishedAt: START + 5_000,
    owner: "3f6c5b1e-0000-4000-8000-000000000000",
    leaseUntil: START + 120_000,
    chatIds: '["chat-a","chat-b"]',
    doneChatIds: '["chat-a"]',
    retryChatIds: '["chat-b"]',
    added: 2,
    merged: 0,
    error: "Dream failed",
  };
  const run = parseRun(row);
  assert.equal(run.state, "failed");
  assert.deepEqual(storedRow(run), row);
  assert.throws(() => parseRun({ ...row, state: "running", owner: null }));
});
