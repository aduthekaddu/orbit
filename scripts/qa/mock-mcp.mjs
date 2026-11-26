import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const mockGithubToken = "made-up-github-token-0003";

const issue = {
  number: 7,
  title: "Migration lock",
  html_url: "https://github.com/aduthekaddu/orbit/issues/7",
  url: "https://api.github.com/repos/aduthekaddu/orbit/issues/7",
  body: JSON.stringify({ html_url: "https://evil.example/phish", title: "Click me" }),
  labels: [{ name: "bug", url: "https://api.github.com/repos/aduthekaddu/orbit/labels/bug" }],
  user: { login: "octocat", html_url: "https://github.com/octocat" },
};

const pullRequest = {
  number: 42,
  title: "Add tools",
  html_url: "https://github.com/aduthekaddu/orbit/pull/42",
  url: "https://api.github.com/repos/aduthekaddu/orbit/pulls/42",
  user: { login: "octocat", html_url: "https://github.com/octocat" },
};

function headerList(value) {
  return String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

// Writes every character of the value as a JSON \u escape, so the raw text never holds the value.
function escapedJson(value) {
  return `"${[...value].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;
}

function createMcp(headers, mode, token, escapedLogin) {
  const toolsets = new Set(headerList(headers["x-mcp-toolsets"]));
  const named = new Set(headerList(headers["x-mcp-tools"]));
  const enabled = (name, toolset) => toolsets.has(toolset) || named.has(name);
  const login = mode === "echo-token" ? token : "octocat";
  const mcp = new McpServer({ name: "mock-github", version: "0.0.1" });
  if (enabled("get_me", "context")) {
    mcp.registerTool("get_me", { description: "Authenticated user" }, async () => ({
      content: [{ type: "text", text: escapedLogin ? `{"login":${escapedJson(escapedLogin)}}` : JSON.stringify({ login }) }],
    }));
  }
  if (enabled("list_issues", "issues")) {
    mcp.registerTool("list_issues", {
      description: "Open issues",
      inputSchema: { owner: z.string(), repo: z.string() },
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify(mode === "echo-token" ? { issues: [issue], echoed: token } : { issues: [issue] }) }],
      ...(mode === "echo-key" ? { structuredContent: { [token]: { title: issue.title } } } : {}),
    }));
  }
  if (enabled("get_pull_request", "pull_requests")) {
    mcp.registerTool("get_pull_request", {
      description: "One pull request",
      inputSchema: { owner: z.string(), repo: z.string(), pullNumber: z.number() },
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify(pullRequest) }],
    }));
  }
  if (enabled("get_file_contents", "repos")) {
    mcp.registerTool("get_file_contents", {
      description: "One file",
      inputSchema: { owner: z.string(), repo: z.string(), path: z.string() },
    }, async () => ({
      content: [
        { type: "text", text: "successfully downloaded text file (SHA: abcdef)" },
        { type: "resource", resource: { uri: "repo://aduthekaddu/orbit/contents/README.md", mimeType: "text/plain; charset=utf-8", text: "# Orbit" } },
      ],
    }));
  }
  return mcp;
}

export async function startMockMcp({ port = 0 } = {}) {
  const sessions = new Map();
  const requests = [];
  const timers = new Set();
  let listCount = 0;
  let callCount = 0;
  let closeCount = 0;
  let startHold;
  const methodHolds = new Map();
  let initResponseHold;
  const pendingReleases = new Set();

  const makeHold = () => {
    let arrive = () => {};
    let release = () => {};
    const arrived = new Promise((resolve) => {
      arrive = resolve;
    });
    const wait = new Promise((resolve) => {
      release = () => {
        pendingReleases.delete(release);
        resolve();
      };
    });
    pendingReleases.add(release);
    return { arrived, arrive, wait, release };
  };

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = body && typeof body === "object" ? body.method : undefined;
    const authorized = request.headers.authorization === `Bearer ${mockGithubToken}`;
    requests.push({
      http: request.method,
      method,
      authorized,
      readonly: request.headers["x-mcp-readonly"] ?? "",
      toolsets: request.headers["x-mcp-toolsets"] ?? "",
      tools: request.headers["x-mcp-tools"] ?? "",
    });
    if (!authorized) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    if (request.method === "DELETE") closeCount += 1;
    if (method === "tools/list") listCount += 1;
    if (method === "tools/call") callCount += 1;
    if (startHold && (method === "server/discover" || method === "initialize")) await startHold;
    const methodHold = method ? methodHolds.get(method) : undefined;
    if (methodHold) {
      methodHolds.delete(method);
      methodHold.arrive();
      await methodHold.wait;
      if (request.destroyed || response.destroyed) return;
    }
    const mode = url.searchParams.get("mode");
    if (mode === "bad-request") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    if (mode === "error-token" && method === "tools/call") {
      response.writeHead(200, { "content-type": "application/json" });
      const echoed = url.searchParams.get("echo") ?? "";
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: `token ${mockGithubToken} cannot read this repository${echoed ? ` with ${echoed}` : ""}` } }));
      return;
    }
    if (mode === "fail-list" && method === "tools/list") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    if (mode === "stall" || (mode === "stall-list" && method === "tools/list")) {
      await new Promise((resolve) => {
        const finish = () => {
          request.off("close", finish);
          request.off("aborted", finish);
          resolve();
        };
        request.on("close", finish);
        request.on("aborted", finish);
      });
      if (!response.headersSent) response.writeHead(499).end();
      return;
    }
    if (mode === "slow-list" && method === "tools/list") {
      await new Promise((resolve) => {
        const timer = setTimeout(finish, 15_000);
        timers.add(timer);
        function finish() {
          clearTimeout(timer);
          timers.delete(timer);
          request.off("close", finish);
          request.off("aborted", finish);
          resolve();
        }
        request.on("close", finish);
        request.on("aborted", finish);
      });
      if (!response.headersSent) response.writeHead(499).end();
      return;
    }
    const sessionHeader = request.headers["mcp-session-id"];
    const existing = typeof sessionHeader === "string" ? sessions.get(sessionHeader) : undefined;
    if (existing) {
      await existing.transport.handleRequest(request, response, body);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      async onsessioninitialized(id) {
        sessions.set(id, { transport });
        if (initResponseHold) {
          const hold = initResponseHold;
          initResponseHold = undefined;
          hold.arrive();
          await hold.wait;
        }
      },
      onsessionclosed(id) {
        sessions.delete(id);
      },
    });
    const mcp = createMcp(request.headers, mode, request.headers.authorization?.slice("Bearer ".length) ?? "", url.searchParams.get("escaped-login"));
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock MCP did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token: mockGithubToken,
    requests,
    openSessions: () => sessions.size,
    listCount: () => listCount,
    callCount: () => callCount,
    closeCount: () => closeCount,
    holdStart: () => {
      let release = () => {};
      startHold = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        startHold = undefined;
        release();
      };
    },
    holdMethod: (name) => {
      const hold = makeHold();
      methodHolds.set(name, hold);
      return {
        arrived: hold.arrived,
        release: () => {
          if (methodHolds.get(name) === hold) methodHolds.delete(name);
          hold.release();
        },
      };
    },
    holdInitializeResponse: () => {
      const hold = makeHold();
      initResponseHold = hold;
      return {
        arrived: hold.arrived,
        release: () => {
          if (initResponseHold === hold) initResponseHold = undefined;
          hold.release();
        },
      };
    },
    close: () => new Promise((resolve) => {
      for (const release of [...pendingReleases]) release();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startMockMcp({ port: Number(process.env.MOCK_MCP_PORT ?? 3301) }).then((mock) => {
    console.log(`mock MCP on ${mock.url}`);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        void mock.close().then(() => process.exit(0));
      });
    }
  });
}
