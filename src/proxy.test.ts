import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { LOCAL_AUTH_URL } from "./lib/auth-origins";
import { getAuth } from "./lib/auth";
import { getDb } from "./lib/db";
import { config, proxy } from "./proxy";

const DAY = 86_400_000;
const EMAIL = "proxy-test@orbit.local";
const PASSWORD = "proxy-test-password-1";
const ENV_KEYS = ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "ORBIT_PUBLIC_URL", "ORBIT_TRUSTED_ORIGINS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let activeCookie = "";
let activeToken = "";

function extractSessionCookie(headers: Headers) {
  const line = headers.getSetCookie().find((entry) => entry.startsWith("better-auth.session_token="));
  assert.ok(line, `expected a better-auth.session_token Set-Cookie header, got ${JSON.stringify(headers.getSetCookie())}`);
  return line;
}

function backdateSession(token: string) {
  getDb().$client
    .prepare("UPDATE session SET expires_at = ?, updated_at = ? WHERE token = ?")
    .run(Date.now() + 6 * DAY - 60_000, Date.now() - DAY - 60_000, token);
}

function expireSession(token: string) {
  getDb().$client.prepare("UPDATE session SET expires_at = ? WHERE token = ?").run(Date.now() - 60_000, token);
}

function sessionExpiresAt(token: string) {
  const row = getDb().$client.prepare("SELECT expires_at AS expiresAt FROM session WHERE token = ?").get(token) as
    | { expiresAt: number }
    | undefined;
  return row?.expiresAt;
}

async function signInFreshSession() {
  const result = await getAuth().api.signInEmail({
    body: { email: EMAIL, password: PASSWORD },
    headers: new Headers({ origin: LOCAL_AUTH_URL }),
    returnHeaders: true,
  });
  const line = extractSessionCookie(result.headers);
  return { cookie: line.split(";")[0], token: result.response.token };
}

before(async () => {
  process.env.BETTER_AUTH_URL = LOCAL_AUTH_URL;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ORBIT_PUBLIC_URL;
  delete process.env.ORBIT_TRUSTED_ORIGINS;
  const signedUp = await getAuth().api.signUpEmail({
    body: { name: "Proxy Test", email: EMAIL, password: PASSWORD },
    headers: new Headers({ origin: LOCAL_AUTH_URL }),
    returnHeaders: true,
  });
  activeCookie = extractSessionCookie(signedUp.headers).split(";")[0];
  assert.ok(signedUp.response.token, "signUpEmail must return a session token");
  activeToken = signedUp.response.token;
});

after(() => {
  getDb().$client.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("signed-out API paths next to /api/auth require a session", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const pathname of ["/api/authors", "/api/auth-x"]) {
    await t.test(pathname, async () => {
      const url = new URL(pathname, LOCAL_AUTH_URL);
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig, url: url.href }), true);
      const response = await proxy(new NextRequest(url));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Unauthorized" });
    });
  }
});

test("a signed-out page next to /_next redirects to login", async (t) => {
  t.mock.method(console, "warn", () => {});
  const url = new URL("/_next-fixture", LOCAL_AUTH_URL);
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig, url: url.href }), true);
  const response = await proxy(new NextRequest(url));
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location") ?? "").pathname, "/login");
});

test("auth and Next.js paths can still pass through without a session", async (t) => {
  const requests = [
    { pathname: "/api/auth", method: "GET" },
    { pathname: "/api/auth/sign-in/email", method: "POST" },
    { pathname: "/_next", method: "GET" },
    { pathname: "/_next/webpack-hmr", method: "GET" },
  ];
  for (const { pathname, method } of requests) {
    await t.test(`${method} ${pathname}`, async () => {
      const request = new NextRequest(new URL(pathname, LOCAL_AUTH_URL), { method });
      const response = await proxy(request);
      assert.equal(response.headers.get("x-middleware-next"), "1");
    });
  }
});

test("the proxy refuses a signed-in API write from another origin", async (t) => {
  // /api/memories/<id>.png ends in an image extension, which the page matcher skips.
  for (const [method, pathname] of [["POST", "/api/chats"], ["PATCH", "/api/memories/fixture.png"]]) {
    await t.test(`${method} ${pathname}`, async () => {
      const url = new URL(pathname, LOCAL_AUTH_URL);
      assert.equal(unstable_doesMiddlewareMatch({ config, url: url.href }), true, "Next.js must run the proxy");
      const send = (headers: Record<string, string>) =>
        proxy(new NextRequest(url, { method, headers: { cookie: activeCookie, ...headers } }));

      assert.equal((await send({ "sec-fetch-site": "same-site", origin: "http://127.0.0.1:18081" })).status, 403);
      assert.equal((await send({ origin: "http://other.example" })).status, 403);
      const sameOrigin = await send({ "sec-fetch-site": "same-origin", origin: LOCAL_AUTH_URL });
      assert.equal(sameOrigin.headers.get("x-middleware-next"), "1", "a same-origin write reaches the route");
    });
  }
});

test("the proxy forwards a refreshed session cookie on every signed-in response path", async (t) => {
  const cases = [
    {
      name: "GET /",
      request: () => new NextRequest(new URL("/", LOCAL_AUTH_URL), { headers: { cookie: activeCookie } }),
      check: (response: Response) => assert.equal(response.headers.get("x-middleware-next"), "1"),
    },
    {
      name: "GET /api/chats",
      request: () => new NextRequest(new URL("/api/chats", LOCAL_AUTH_URL), { headers: { cookie: activeCookie } }),
      check: (response: Response) => assert.equal(response.headers.get("x-middleware-next"), "1"),
    },
    {
      name: "GET /login redirect",
      request: () => new NextRequest(new URL("/login", LOCAL_AUTH_URL), { headers: { cookie: activeCookie } }),
      check: (response: Response) => {
        assert.equal(response.status, 307);
        assert.equal(new URL(response.headers.get("location") ?? "").pathname, "/");
      },
    },
    {
      name: "POST /api/chats cross-origin 403",
      request: () =>
        new NextRequest(new URL("/api/chats", LOCAL_AUTH_URL), {
          method: "POST",
          headers: { cookie: activeCookie, origin: "http://other.example" },
        }),
      check: (response: Response) => assert.equal(response.status, 403),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      backdateSession(activeToken);
      const response = await proxy(entry.request());
      entry.check(response);
      const cookieLine = extractSessionCookie(response.headers);
      assert.match(cookieLine, /;\s*Max-Age=604800(?:;|$)/i);
      assert.match(cookieLine, /;\s*Path=\/(?:;|$)/i);
      assert.match(cookieLine, /;\s*HttpOnly(?:;|$)/i);
      assert.match(cookieLine, /;\s*SameSite=Lax(?:;|$)/i);
      assert.equal(response.headers.get("cache-control"), null);
      const extended = sessionExpiresAt(activeToken);
      assert.ok(extended !== undefined && extended > Date.now() + 6.9 * DAY);
    });
  }
});

test("the proxy sends no Set-Cookie when the session is not due for refresh", async () => {
  const page = await proxy(new NextRequest(new URL("/", LOCAL_AUTH_URL), { headers: { cookie: activeCookie } }));
  assert.equal(page.headers.get("x-middleware-next"), "1");
  assert.deepEqual(page.headers.getSetCookie(), []);

  const api = await proxy(new NextRequest(new URL("/api/chats", LOCAL_AUTH_URL), { headers: { cookie: activeCookie } }));
  assert.equal(api.headers.get("x-middleware-next"), "1");
  assert.deepEqual(api.headers.getSetCookie(), []);
});

test("the proxy clears an expired session cookie while keeping redirect, 401, and auth-miss behavior", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => {
    warnings.push(String(line));
  });

  const expiredPageSession = await signInFreshSession();
  expireSession(expiredPageSession.token);
  const page = await proxy(new NextRequest(new URL("/", LOCAL_AUTH_URL), { headers: { cookie: expiredPageSession.cookie } }));
  assert.equal(page.status, 307);
  assert.equal(new URL(page.headers.get("location") ?? "").pathname, "/login");
  assert.match(extractSessionCookie(page.headers), /;\s*Max-Age=0(?:;|$)/i);
  assert.match(warnings.at(-1) ?? "", /auth miss path=\/ .* session=plain /);

  const expiredApiSession = await signInFreshSession();
  expireSession(expiredApiSession.token);
  const api = await proxy(new NextRequest(new URL("/api/chats", LOCAL_AUTH_URL), { headers: { cookie: expiredApiSession.cookie } }));
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: "Unauthorized" });
  assert.match(extractSessionCookie(api.headers), /;\s*Max-Age=0(?:;|$)/i);

  const unauthApi = await proxy(new NextRequest(new URL("/api/chats", LOCAL_AUTH_URL)));
  assert.equal(unauthApi.status, 401);
  assert.deepEqual(await unauthApi.json(), { error: "Unauthorized" });
  assert.deepEqual(unauthApi.headers.getSetCookie(), []);

  const publicLogin = await proxy(new NextRequest(new URL("/login", LOCAL_AUTH_URL)));
  assert.equal(publicLogin.headers.get("x-middleware-next"), "1");
  assert.deepEqual(publicLogin.headers.getSetCookie(), []);
});
