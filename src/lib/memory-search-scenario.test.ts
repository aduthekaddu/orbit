import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { visibleMemories } from "../components/memory/visible-memories";
import { eventually } from "./eventually.mjs";

const scenarioUrl = pathToFileURL(path.resolve(".agents/skills/verify-orbit/scenarios/memory.mjs")).href;
const originalCwd = process.cwd();
const previousOllamaUrl = process.env.ORBIT_OLLAMA_URL;
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-memory-scenario-"));
const STOP_AFTER_SEARCH = new Error("stop after search section");

let runMemoryScenario: (ctx: {
  page: unknown;
  origin: string;
  step: (name: string, ok: boolean, detail?: string) => boolean;
  shot: () => Promise<void>;
}) => Promise<void>;

test.before(async () => {
  delete process.env.ORBIT_OLLAMA_URL;
  process.chdir(scratchDir);
  ({ default: runMemoryScenario } = await import(scenarioUrl));
});

test.after(() => {
  process.chdir(originalCwd);
  if (previousOllamaUrl === undefined) delete process.env.ORBIT_OLLAMA_URL;
  else process.env.ORBIT_OLLAMA_URL = previousOllamaUrl;
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function deferTurns(turns: number, fn: () => void) {
  if (turns <= 0) {
    fn();
    return;
  }
  setImmediate(() => deferTurns(turns - 1, fn));
}

type SearchReply = {
  ok: boolean;
  rows: { text: string }[];
  headerTurns: number;
  commitTurns: number;
};

async function runSearchChecks(replies: Record<string, SearchReply>) {
  const origin = "http://127.0.0.1:3210";
  const initial = [{ text: "I deploy to Fly.io" }];
  let query = "";
  let fetched: { query: string; rows: { text: string }[] } | null = null;
  let searchSeq = 0;
  let chatCreates = 0;
  const checks = new Map<string, boolean>();
  const waiters: Array<{
    predicate: (response: { url: () => string; ok: () => boolean; finished: () => Promise<null> }) => boolean;
    resolve: (response: { url: () => string; ok: () => boolean; finished: () => Promise<null> }) => void;
  }> = [];

  const hasRow = () => visibleMemories(query, initial, fetched).some((item) => item.text === "I deploy to Fly.io");
  const ariaBusy = () => {
    const trimmed = query.trim();
    return trimmed.length > 0 && fetched?.query !== trimmed ? "true" : "false";
  };

  const deliverResponse = (q: string, reply: SearchReply) => {
    const response = {
      url: () => `${origin}/api/memories?q=${encodeURIComponent(q)}`,
      ok: () => reply.ok,
      finished: async () => null,
    };
    const index = waiters.findIndex((waiter) => waiter.predicate(response));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(response);
    }
  };

  const triggerSearch = (nextQuery: string) => {
    searchSeq += 1;
    const seq = searchSeq;
    query = nextQuery;
    const trimmed = nextQuery.trim();
    if (!trimmed) {
      fetched = null;
      return;
    }
    const reply = replies[trimmed] ?? { ok: true, rows: [], headerTurns: 1, commitTurns: 1 };
    deferTurns(reply.headerTurns, () => {
      if (seq !== searchSeq) return;
      deliverResponse(trimmed, reply);
      deferTurns(reply.commitTurns, () => {
        if (seq !== searchSeq) return;
        fetched = { query: trimmed, rows: reply.ok ? reply.rows : [] };
      });
    });
  };

  const noopLocator = {
    fill: async () => {},
    press: async () => {},
    waitFor: async () => {},
    isVisible: async () => true,
    getByText: () => noopLocator,
  };

  const rowLocator = {
    isVisible: async () => hasRow(),
    waitFor: async ({ state = "visible", timeout = 2_000 }: { state?: "visible" | "hidden"; timeout?: number } = {}) => {
      await eventually(
        () => hasRow(),
        (shown) => (state === "hidden" ? !shown : shown),
        { timeoutMs: timeout, intervalMs: 1, what: `memory row to become ${state}` },
      );
    },
  };

  const listLocator = {
    getAttribute: async (name: string) => (name === "aria-busy" ? ariaBusy() : null),
  };

  const page = {
    request: {
      post: async () => {
        chatCreates += 1;
        if (chatCreates > 1) throw STOP_AFTER_SEARCH;
        return { json: async () => ({ id: "chat-1" }) };
      },
    },
    goto: async () => {},
    getByRole: (_role: string, options?: { name?: string }) => {
      if (options?.name === "Search") {
        return {
          fill: async (value: string) => {
            triggerSearch(value);
          },
        };
      }
      return noopLocator;
    },
    getByText: (text: string) => {
      if (text === "I deploy to Fly.io") return rowLocator;
      return noopLocator;
    },
    locator: (selector: string) => {
      if (selector === 'input[aria-label="Search"] ~ ul') return listLocator;
      return noopLocator;
    },
    waitForResponse: (
      predicate: (response: { url: () => string; ok: () => boolean; finished: () => Promise<null> }) => boolean,
    ) =>
      new Promise((resolve) => {
        waiters.push({ predicate, resolve });
      }),
  };

  try {
    await runMemoryScenario({
      page,
      origin,
      step: (name, ok) => {
        checks.set(name, ok);
        return ok;
      },
      shot: async () => {},
    });
  } catch (error) {
    if (error !== STOP_AFTER_SEARCH) throw error;
  }

  return checks;
}

test("memory scenario waits for matching search results to render after response headers", async () => {
  const checks = await runSearchChecks({
    Fly: { ok: true, rows: [{ text: "I deploy to Fly.io" }], headerTurns: 1, commitTurns: 2 },
    nomatchtoken: { ok: true, rows: [], headerTurns: 1, commitTurns: 2 },
  });
  assert.equal(checks.get("search keeps the matching memory"), true);
  assert.equal(checks.get("search hides a memory that does not match"), true);
});

test("memory scenario fails when a non-matching search erroneously returns the memory", async () => {
  const checks = await runSearchChecks({
    Fly: { ok: true, rows: [{ text: "I deploy to Fly.io" }], headerTurns: 1, commitTurns: 0 },
    nomatchtoken: { ok: true, rows: [{ text: "I deploy to Fly.io" }], headerTurns: 2, commitTurns: 2 },
  });
  assert.equal(checks.get("search keeps the matching memory"), true);
  assert.equal(checks.get("search hides a memory that does not match"), false);
});

test("memory scenario fails the non-matching check when the search request fails", async () => {
  const checks = await runSearchChecks({
    Fly: { ok: true, rows: [{ text: "I deploy to Fly.io" }], headerTurns: 1, commitTurns: 0 },
    nomatchtoken: { ok: false, rows: [], headerTurns: 1, commitTurns: 1 },
  });
  assert.equal(checks.get("search keeps the matching memory"), true);
  assert.equal(checks.get("search hides a memory that does not match"), false);
});
