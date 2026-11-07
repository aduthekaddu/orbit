import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { checkGithub } from "./github";

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
    const result = await checkGithub({ token, mcpUrl: `http://127.0.0.1:${address.port}/mcp` });
    assert.equal(hits.length, 0);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(token), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
