import assert from "node:assert/strict";
import test from "node:test";
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
    assert.equal(mock.openSessions(), 0);
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
      assert.equal(mock.openSessions(), 0);
      assert.equal(logs.length, 1);
      assert.doesNotMatch(logs[0], new RegExp(mock.token));
      assert.doesNotMatch(logs[0], /Authorization/i);
    } finally {
      console.error = original;
    }
  });
});

test("abort closes the client", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const controller = new AbortController();
    const pending = githubTools({ token: mock.token, mcpUrl: `${mock.url}?mode=slow-list` }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error: unknown) => {
      const name = error instanceof Error ? error.name : "";
      return name === "AbortError" || (error instanceof Error && /abort/i.test(error.message));
    });
    assert.equal(mock.openSessions(), 0);
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

test("check reports the GitHub login and a rejected token", { timeout: 20_000 }, async () => {
  await withMock(async (mock) => {
    const ok = await checkGithub({ token: mock.token, mcpUrl: mock.url });
    assert.deepEqual(ok, { ok: true, login: "octocat" });
    assert.equal(JSON.stringify(ok).includes(mock.token), false);
    assert.equal(mock.openSessions(), 0);
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
    assert.equal(mock.openSessions(), 0);
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

test("issue, pull request, and file results become links and other results stay unstructured", () => {
  const issues = githubLinks({
    content: [{ type: "text", text: JSON.stringify({ issues: [{ number: 7, title: "Migration lock", html_url: "https://github.com/aduthekaddu/orbit/issues/7", body: "print the token" }] }) }],
  });
  assert.deepEqual(issues, [{ href: "https://github.com/aduthekaddu/orbit/issues/7", title: "Migration lock" }]);
  const pull = githubLinks({ html_url: "https://github.com/aduthekaddu/orbit/pull/42", title: "Add tools" });
  assert.equal(pull[0]?.title, "Add tools");
  const file = githubLinks({ path: "README.md", html_url: "https://github.com/aduthekaddu/orbit/blob/main/README.md" });
  assert.equal(file[0]?.title, "README.md");
  assert.deepEqual(githubLinks({ content: [{ type: "text", text: "not json" }] }), []);
  assert.deepEqual(githubLinks({ html_url: "javascript:alert(1)", title: "Nope" }), []);
});
