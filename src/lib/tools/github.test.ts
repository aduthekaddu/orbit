import { testDataDir } from "../test-data-dir";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { simulateReadableStream, stepCountIs, streamText, toUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { startMockMcp } from "../../../scripts/qa/mock-mcp.mjs";

process.env.ORBIT_GITHUB_MCP_FIXTURE = "1";
import { githubLinks } from "./github-links";
import { checkGithub, githubTools, openGithubTurn } from "./github";

const toolOptions = {
  toolCallId: "github-test",
  messages: [],
  abortSignal: new AbortController().signal,
  context: undefined,
};

async function withMock(run: (mock: Awaited<ReturnType<typeof startMockMcp>>) => Promise<void>) {
  const mock = await startMockMcp();
  try {
    await run(mock);
  } finally {
    await mock.close();
  }
}

async function assertNoOpenSessions(
  observe: () => number,
  { timeoutMs = 2_000, pollMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (observe() !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  assert.equal(observe(), 0);
}

async function waitForListRequest(
  mock: Awaited<ReturnType<typeof startMockMcp>>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mock.listCount() < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(mock.listCount() >= 1, "expected MCP tools/list request to start before abort");
}

test("GitHub tool names get the github_ prefix and the server sees read-only toolsets", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const opened = await githubTools({ token: mock.token, mcpUrl: mock.url });
    try {
      assert.deepEqual(Object.keys(opened.tools).sort(), [
        "github_get_file_contents",
        "github_get_pull_request",
        "github_list_issues",
      ]);
      const seen = mock.requests.find((entry) => entry.method === "tools/list");
      assert.ok(seen);
      assert.equal(seen.authorized, true);
      assert.equal(seen.readonly, "true");
      assert.equal(seen.toolsets, "repos,issues,pull_requests");
      assert.equal(seen.tools, "");
      assert.equal(mock.requests.some((entry) => entry.method?.includes("create") || entry.method?.includes("merge")), false);
    } finally {
      await opened.close();
    }
  });
});

test("close runs after a successful tool call", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const opened = await githubTools({ token: mock.token, mcpUrl: mock.url });
    const result = await opened.tools.github_list_issues?.execute?.({ owner: "aduthekaddu", repo: "orbit" }, toolOptions);
    assert.equal(githubLinks(result)[0]?.href, "https://github.com/aduthekaddu/orbit/issues/7");
    await opened.close();
    await opened.close();
    assert.equal(mock.closeCount(), 1);
    await assertNoOpenSessions(mock.openSessions);
  });
});

test("a list failure closes the client and the turn keeps going without GitHub tools", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const opened = await openGithubTurn({ githubToken: mock.token, githubMcpUrl: `${mock.url}?mode=fail-list` });
      assert.deepEqual(opened.tools, {});
      await opened.close();
      assert.ok(mock.closeCount() >= 1);
      await assertNoOpenSessions(mock.openSessions);
      assert.equal(logs.length, 1);
      assert.doesNotMatch(logs[0], new RegExp(mock.token));
      assert.doesNotMatch(logs[0], /Authorization/i);
    } finally {
      console.error = original;
    }
  });
});

test("a stalled MCP list stops within the deadline and closes the client", { timeout: 5_000 }, async () => {
  await withMock(async (mock) => {
    const started = Date.now();
    const pending = openGithubTurn({ githubToken: mock.token, githubMcpUrl: `${mock.url}?mode=stall-list` }, undefined, { setupMs: 300 });
    const outcome = await Promise.race([
      pending.then((opened) => ({ kind: "done" as const, opened })).catch((error: unknown) => ({ kind: "error" as const, error })),
      new Promise<{ kind: "hung" }>((resolve) => setTimeout(() => resolve({ kind: "hung" }), 800)),
    ]);
    assert.equal(outcome.kind, "done");
    if (outcome.kind !== "done") return;
    assert.ok(Date.now() - started < 1_500);
    assert.deepEqual(outcome.opened.tools, {});
    await outcome.opened.close();
    await assertNoOpenSessions(mock.openSessions);
    assert.ok(mock.closeCount() >= 1);
  });
});

test("a stalled MCP initialize stops within the deadline", { timeout: 5_000 }, async () => {
  await withMock(async (mock) => {
    const started = Date.now();
    const pending = openGithubTurn({ githubToken: mock.token, githubMcpUrl: `${mock.url}?mode=stall` }, undefined, { setupMs: 300 });
    const outcome = await Promise.race([
      pending.then(() => "done").catch(() => "error"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 800)),
    ]);
    assert.equal(outcome, "done");
    assert.ok(Date.now() - started < 1_500);
    await assertNoOpenSessions(mock.openSessions);
  });
});

test("aborting a stalled MCP list rejects the turn", { timeout: 5_000 }, async () => {
  await withMock(async (mock) => {
    const controller = new AbortController();
    const pending = openGithubTurn({ githubToken: mock.token, githubMcpUrl: `${mock.url}?mode=stall-list` }, controller.signal, { setupMs: 5_000 });
    await Promise.all([
      assert.rejects(pending),
      waitForListRequest(mock).finally(() => controller.abort()),
    ]);
    await assertNoOpenSessions(mock.openSessions);
  });
});

test("abort closes the client", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const controller = new AbortController();
    const pending = githubTools({ token: mock.token, mcpUrl: `${mock.url}?mode=slow-list` }, { signal: controller.signal });
    await Promise.all([
      assert.rejects(pending, (error: unknown) => {
        const name = error instanceof Error ? error.name : "";
        return name === "AbortError" || (error instanceof Error && /abort/i.test(error.message));
      }),
      waitForListRequest(mock).finally(() => controller.abort()),
    ]);
    await assertNoOpenSessions(mock.openSessions);
  });
});

test("open-session cleanup check fails when a session stays open", { timeout: 5_000 }, async () => {
  await withMock(async (mock) => {
    const opened = await githubTools({ token: mock.token, mcpUrl: mock.url });
    try {
      await assert.rejects(
        () => assertNoOpenSessions(mock.openSessions, { timeoutMs: 80, pollMs: 10 }),
        { name: "AssertionError" },
      );
    } finally {
      await opened.close();
    }
    await assertNoOpenSessions(mock.openSessions);
  });
});

test("a second call within five minutes skips the tool list and a tool call still reaches GitHub", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const first = await githubTools({ token: mock.token, mcpUrl: mock.url });
    await first.close();
    const second = await githubTools({ token: mock.token, mcpUrl: mock.url });
    await second.tools.github_list_issues?.execute?.({ owner: "aduthekaddu", repo: "orbit" }, toolOptions);
    await second.close();
    assert.equal(mock.listCount(), 1);
    assert.equal(mock.callCount(), 1);
    const third = await githubTools({ token: mock.token, mcpUrl: mock.url }, { now: Date.now() + 6 * 60 * 1000 });
    await third.close();
    assert.equal(mock.listCount(), 2);
  });
});

test("a warm turn gets its tools before the MCP server answers the start", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const first = await githubTools({ token: mock.token, mcpUrl: mock.url });
    await first.close();
    const release = mock.holdStart();
    try {
      const warm = await Promise.race([
        githubTools({ token: mock.token, mcpUrl: mock.url }),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_000)),
      ]);
      assert.notEqual(warm, "hung");
      if (warm === "hung") return;
      assert.deepEqual(Object.keys(warm.tools).sort(), ["github_get_file_contents", "github_get_pull_request", "github_list_issues"]);
      const call = warm.tools.github_list_issues?.execute?.({ owner: "aduthekaddu", repo: "orbit" }, toolOptions);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(mock.callCount(), 0);
      release();
      assert.equal(githubLinks(await call)[0]?.href, "https://github.com/aduthekaddu/orbit/issues/7");
      assert.equal(mock.callCount(), 1);
      assert.equal(mock.listCount(), 1);
      await warm.close();
      await warm.close();
      await assertNoOpenSessions(mock.openSessions);
    } finally {
      release();
    }
  });
});

test("a warm turn whose client fails to start fails the tool call and logs one line", { timeout: 20_000 }, async () => {
  const logs: string[] = [];
  const original = console.error;
  await withMock(async (mock) => {
    const first = await githubTools({ token: mock.token, mcpUrl: mock.url });
    await first.close();
    await mock.close();
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const warm = await githubTools({ token: mock.token, mcpUrl: mock.url });
      assert.equal("github_list_issues" in warm.tools, true);
      await assert.rejects(warm.tools.github_list_issues?.execute?.({ owner: "aduthekaddu", repo: "orbit" }, toolOptions) ?? Promise.resolve());
      await warm.close();
      assert.equal(logs.length, 1);
      assert.doesNotMatch(logs[0], new RegExp(mock.token));
      assert.doesNotMatch(logs[0], /Authorization/i);
    } finally {
      console.error = original;
    }
  });
});

test("a wrong token leaves the turn with no GitHub tools", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const opened = await openGithubTurn({ githubToken: "wrong-token", githubMcpUrl: mock.url });
      assert.deepEqual(opened.tools, {});
      await opened.close();
      assert.equal(logs.length, 1);
      assert.doesNotMatch(logs[0], /wrong-token/);
      assert.doesNotMatch(logs[0], /Authorization/i);
      assert.equal(mock.listCount(), 0);
    } finally {
      console.error = original;
    }
  });
});

test("check asks for get_me when the chat toolsets omit it", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const opened = await githubTools({ token: mock.token, mcpUrl: mock.url });
    try {
      assert.equal(opened.tools.github_get_me, undefined);
    } finally {
      await opened.close();
    }
    const ok = await checkGithub({ token: mock.token, mcpUrl: mock.url });
    assert.deepEqual(ok, { ok: true, login: "octocat" });
    const lists = mock.requests.filter((entry) => entry.method === "tools/list");
    assert.equal(lists[0]?.tools, "");
    assert.match(String(lists.at(-1)?.tools), /(^|,)\s*get_me\s*(,|$)/);
  });
});

test("check does not return the GitHub token when the server echoes it", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const checked = await checkGithub({ token: mock.token, mcpUrl: `${mock.url}?mode=echo-token` });
    assert.equal(JSON.stringify(checked).includes(mock.token), false);
  });
});

test("a GitHub tool result does not include the token when the server echoes it", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const opened = await githubTools({ token: mock.token, mcpUrl: `${mock.url}?mode=echo-token` });
    try {
      const result = await opened.tools.github_list_issues?.execute?.({ owner: "aduthekaddu", repo: "orbit" }, toolOptions);
      assert.equal(JSON.stringify(result).includes(mock.token), false);
    } finally {
      await opened.close();
    }
  });
});

test("a structured tool result does not carry the token as a field name into the chat", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const opened = await githubTools({ token: mock.token, mcpUrl: `${mock.url}?mode=echo-key` });
    try {
      const tool = opened.tools.github_list_issues;
      assert.ok(tool?.execute);
      const model = new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-github-key",
                toolName: "github_list_issues",
                input: JSON.stringify({ owner: "aduthekaddu", repo: "orbit" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              },
            ],
          }),
        }),
      });
      const result = streamText({
        model,
        prompt: "list issues",
        tools: { github_list_issues: tool },
        stopWhen: stepCountIs(1),
      });
      const chunks: string[] = [];
      let saved = "";
      const stream = toUIMessageStream({
        stream: result.stream,
        tools: { github_list_issues: tool },
        onEnd: ({ responseMessage }) => {
          saved = JSON.stringify(responseMessage.parts ?? []);
        },
      });
      for await (const chunk of stream as unknown as AsyncIterable<unknown>) chunks.push(JSON.stringify(chunk));
      const boundary = `${chunks.join("\n")}\n${saved}`;
      assert.match(boundary, /Migration lock/);
      assert.equal(boundary.includes(mock.token), false);
    } finally {
      await opened.close();
    }
  });
});

test("check reports a malformed token as a bad request", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const bad = await checkGithub({ token: mock.token, mcpUrl: `${mock.url}?mode=bad-request` });
    assert.deepEqual(bad, { ok: false, error: "GitHub rejected the token (bad request)." });
    assert.equal(JSON.stringify(bad).includes(mock.token), false);
  });
});

test("check reports the GitHub login and a rejected token", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const ok = await checkGithub({ token: mock.token, mcpUrl: mock.url });
    assert.deepEqual(ok, { ok: true, login: "octocat" });
    assert.equal(JSON.stringify(ok).includes(mock.token), false);
    await assertNoOpenSessions(mock.openSessions);
    const bad = await checkGithub({ token: "wrong-token", mcpUrl: mock.url });
    assert.deepEqual(bad, { ok: false, error: "GitHub rejected the token." });
    assert.equal(JSON.stringify(bad).includes("wrong-token"), false);
  });
});

test("a turn merges GitHub tools when a token is set and closes the client", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const { toolsForTurn } = await import("./index");
    const opened = await toolsForTurn({
      baseUrl: "http://127.0.0.1:3299/v1",
      apiKey: "test-key-not-real",
      model: "mock-genui",
      reasoningEffort: "low",
      searxngUrl: "",
      tavilyApiKey: "",
      githubToken: mock.token,
      githubMcpUrl: mock.url,
    });
    try {
      assert.equal("render_ui" in opened.tools, true);
      assert.equal("github_list_issues" in opened.tools, true);
      assert.equal("web_search" in opened.tools, false);
    } finally {
      await opened.close();
    }
    await assertNoOpenSessions(mock.openSessions);
    await opened.close();
    assert.equal(mock.closeCount(), 1);
  });
});

test("a turn without a GitHub token does not open GitHub", async () => {
  const { toolsForTurn } = await import("./index");
  const opened = await toolsForTurn({
    baseUrl: "http://127.0.0.1:3299/v1",
    apiKey: "test-key-not-real",
    model: "mock-genui",
    reasoningEffort: "low",
    searxngUrl: "",
    tavilyApiKey: "",
    githubToken: "",
    githubMcpUrl: "",
  });
  assert.equal(Object.keys(opened.tools).some((name) => name.startsWith("github_")), false);
  assert.equal("render_ui" in opened.tools, true);
  await opened.close();
});

test("the tool registry opens its database in the test data directory", async () => {
  const { db } = await import("../db");
  assert.equal(db.$client.name, path.join(testDataDir, "orbit.db"));
});

test("issue, pull request, and file results become GitHub links", () => {
  const issue = {
    number: 7,
    title: "Migration lock",
    html_url: "https://github.com/aduthekaddu/orbit/issues/7",
    url: "https://api.github.com/repos/aduthekaddu/orbit/issues/7",
    body: JSON.stringify({ html_url: "https://evil.example/phish", title: "Click me", number: 1 }),
    labels: [{ name: "bug", url: "https://api.github.com/repos/aduthekaddu/orbit/labels/bug" }],
    user: { login: "octocat", html_url: "https://github.com/octocat" },
  };
  assert.deepEqual(githubLinks({ content: [{ type: "text", text: JSON.stringify({ issues: [issue] }) }] }), [
    { href: "https://github.com/aduthekaddu/orbit/issues/7", title: "Migration lock" },
  ]);
  const pull = {
    number: 42,
    title: "Add tools",
    html_url: "https://github.com/aduthekaddu/orbit/pull/42",
    url: "https://api.github.com/repos/aduthekaddu/orbit/pulls/42",
    body: JSON.stringify({ html_url: "https://evil.example/pr", title: "Elsewhere" }),
    user: { login: "octocat", html_url: "https://github.com/octocat" },
    head: { ref: "feat", repo: { html_url: "https://github.com/aduthekaddu/orbit" } },
  };
  assert.deepEqual(githubLinks({ content: [{ type: "text", text: JSON.stringify(pull) }] }), [
    { href: "https://github.com/aduthekaddu/orbit/pull/42", title: "Add tools" },
  ]);
  const file = githubLinks({
    content: [
      { type: "text", text: "successfully downloaded text file (SHA: abcdef)" },
      { type: "resource", resource: { uri: "repo://aduthekaddu/orbit/contents/README.md", mimeType: "text/plain; charset=utf-8", text: "# Orbit\n{\"html_url\":\"https://evil.example/file\",\"title\":\"Nope\"}" } },
    ],
  }, { owner: "aduthekaddu", repo: "orbit", path: "README.md" });
  assert.deepEqual(file, [{ href: "https://github.com/aduthekaddu/orbit/blob/HEAD/README.md", title: "README.md" }]);
  assert.deepEqual(githubLinks({
    content: [{ type: "resource", resource: { uri: "repo://aduthekaddu/orbit/sha/abcdef/contents/src/lib/tools/github.ts" } }],
  }, { owner: "aduthekaddu", repo: "orbit", path: "src/lib/tools/github.ts", ref: "feat/github-tools" }), [
    { href: "https://github.com/aduthekaddu/orbit/blob/feat/github-tools/src/lib/tools/github.ts", title: "github.ts" },
  ]);
  assert.deepEqual(githubLinks({
    content: [{ type: "resource", resource: { uri: "repo://other/repo/contents/README.md" } }],
  }, { owner: "aduthekaddu", repo: "orbit", path: "README.md" }), []);
  assert.deepEqual(githubLinks({ content: [{ type: "text", text: "not json" }] }), []);
  assert.deepEqual(githubLinks({ html_url: "javascript:alert(1)", title: "Nope" }), []);
  assert.deepEqual(githubLinks({ html_url: "https://evil.example/phish", title: "Click me" }), []);
});

test("a numbered row without html_url links through the tool input", () => {
  const listed = (rows: unknown) => ({ content: [{ type: "text", text: JSON.stringify(rows) }] });
  const input = { owner: "aduthekaddu", repo: "orbit" };
  assert.deepEqual(githubLinks(listed({ issues: [{ number: 12, title: "Queue lock" }, { number: 13 }] }), input), [
    { href: "https://github.com/aduthekaddu/orbit/issues/12", title: "Queue lock" },
    { href: "https://github.com/aduthekaddu/orbit/issues/13", title: "#13" },
  ]);
  assert.deepEqual(githubLinks(listed([{ number: 42, title: "Add tools" }]), input), [
    { href: "https://github.com/aduthekaddu/orbit/issues/42", title: "Add tools" },
  ]);
  assert.deepEqual(githubLinks(listed({ number: 7, title: "Migration lock", milestone: { number: 3, title: "v1" } }), input), [
    { href: "https://github.com/aduthekaddu/orbit/issues/7", title: "Migration lock" },
  ]);
  assert.deepEqual(githubLinks(listed([{ number: 12, title: "Queue lock" }])), []);
  assert.deepEqual(githubLinks(listed([{ number: 12, title: "Queue lock" }]), { owner: "..", repo: "orbit" }), []);
  assert.deepEqual(githubLinks(listed([{ number: 12, title: "Queue lock" }]), { owner: "aduthekaddu", repo: "orbit/../x" }), []);
  assert.deepEqual(githubLinks(listed([{ number: "12", title: "Queue lock" }, { number: 1.5 }, { number: 0 }]), input), []);
  assert.deepEqual(githubLinks(listed([{ number: 12, title: "Click me", html_url: "https://evil.example/phish" }]), input), []);
});
