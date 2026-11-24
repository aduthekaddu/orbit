import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { LOCAL_AUTH_URL } from "./lib/auth-origins";

test("the proxy refuses a signed-in API write from another origin", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "orbit-proxy-"));
  const saved = { ORBIT_DATA_DIR: process.env.ORBIT_DATA_DIR, BETTER_AUTH_URL: process.env.BETTER_AUTH_URL };
  process.env.ORBIT_DATA_DIR = dataDir;
  process.env.BETTER_AUTH_URL = LOCAL_AUTH_URL;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
  const { db } = await import("./lib/db");
  try {
    const { auth } = await import("./lib/auth");
    const { config, proxy } = await import("./proxy");
    t.mock.method(auth.api, "getSession", async () => ({}));

    // /api/memories/<id>.png ends in an image extension, which the page matcher skips.
    for (const [method, pathname] of [["POST", "/api/chats"], ["PATCH", "/api/memories/fixture.png"]]) {
      await t.test(`${method} ${pathname}`, async () => {
        const url = new URL(pathname, LOCAL_AUTH_URL);
        assert.equal(unstable_doesMiddlewareMatch({ config, url: url.href }), true, "Next.js must run the proxy");
        const send = (headers: Record<string, string>) => proxy(new NextRequest(url, { method, headers }));

        assert.equal((await send({ "sec-fetch-site": "same-site", origin: "http://127.0.0.1:18081" })).status, 403);
        assert.equal((await send({ origin: "http://other.example" })).status, 403);
        const sameOrigin = await send({ "sec-fetch-site": "same-origin", origin: LOCAL_AUTH_URL });
        assert.equal(sameOrigin.headers.get("x-middleware-next"), "1", "a same-origin write reaches the route");
      });
    }
  } finally {
    db.$client.close();
  }
});
