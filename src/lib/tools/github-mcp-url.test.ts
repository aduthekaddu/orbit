import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { checkGithub, githubMcpTarget } from "./github";

const production: NodeJS.ProcessEnv = { NODE_ENV: "test" };
const fixture: NodeJS.ProcessEnv = { NODE_ENV: "test", ORBIT_GITHUB_MCP_FIXTURE: "1" };

test("the GitHub token can go only to GitHub MCP hosts over HTTPS", () => {
  for (const url of ["https://api.githubcopilot.com/mcp/", "https://github.com/mcp/", "https://api.github.com/mcp", ""]) {
    assert.equal(githubMcpTarget(url, production).ok, true, url || "default");
  }
  for (const url of [
    "http://api.github.com/mcp",
    "https://api.github.com:444/mcp",
    "https://evil.example/mcp",
    "https://api.github.com.evil.example/mcp",
    "https://user:secret@api.github.com/mcp",
    "http://127.0.0.1:9/mcp",
    "http://169.254.169.254/mcp",
  ]) {
    assert.equal(githubMcpTarget(url, production).ok, false, url);
  }
  assert.equal(githubMcpTarget("http://127.0.0.1:9/mcp", fixture).ok, true);
  assert.equal(githubMcpTarget("http://localhost:9/mcp", fixture).ok, true);
  assert.equal(githubMcpTarget("https://evil.example/mcp", fixture).ok, false);
});

test("an arbitrary MCP URL does not receive the GitHub token", { timeout: 20_000 }, async () => {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fixture server did not bind a port");
  const token = "secret-token-value";
  try {
    const result = await checkGithub({ apiKey: "", tavilyApiKey: "", githubToken: token, githubMcpUrl: `http://127.0.0.1:${address.port}/mcp` });
    assert.equal(hits.length, 0);
    assert.deepEqual(result, { ok: false, error: "GitHub MCP URL is not allowed." });
    assert.equal(JSON.stringify(result).includes(token), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
