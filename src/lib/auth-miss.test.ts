import assert from "node:assert/strict";
import test from "node:test";
import { describeAuthMiss } from "./auth-miss";

const token = "x4IgYwimmqueI58USe4o6xEk5q4Wfisd.UQXhnLSJnNGU8HSDeva6ap975Udt%2F944AaUNHou7kcM%3D";
const userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) CriOS/142.0 Mobile/15E148 Safari/604.1";

test("a page load that passed Access but carried no session cookie says so", () => {
  const line = describeAuthMiss(
    "/c/abc",
    new Headers({
      cookie: "CF_Authorization=eyJhbGciOi.jwt.sig; sidebar=open",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "cross-site",
      "cf-ray": "9a1b2c3d4e5f-SIN",
      "user-agent": userAgent,
    }),
  );
  assert.match(line, /^auth miss path=\/c\/abc kind=document /);
  assert.match(line, / site=cross-site /);
  assert.match(line, / session=none /);
  assert.match(line, / access=yes /);
  assert.match(line, / ray=9a1b2c3d4e5f-SIN /);
});

test("a prefetch that carried a session cookie the server rejected names which cookie", () => {
  const line = describeAuthMiss(
    "/settings",
    new Headers({
      cookie: `__Secure-better-auth.session_token=${token}`,
      rsc: "1",
      "next-router-prefetch": "1",
      "sec-fetch-site": "same-origin",
    }),
  );
  assert.match(line, / kind=prefetch /);
  assert.match(line, / session=secure /);
  assert.match(line, / access=no /);
});

test("an API call with only the plain cookie from an http base URL is told apart", () => {
  const line = describeAuthMiss("/api/chats", new Headers({ cookie: `better-auth.session_token=${token}` }));
  assert.match(line, / kind=api /);
  assert.match(line, / session=plain /);
  assert.match(line, / site=- /);
});

test("the line holds no cookie value and no raw user agent", () => {
  const line = describeAuthMiss(
    "/c/abc",
    new Headers({ cookie: `__Secure-better-auth.session_token=${token}; CF_Authorization=eyJsecret`, "user-agent": userAgent }),
  );
  assert.ok(!line.includes(token.slice(0, 12)), line);
  assert.ok(!line.includes("eyJsecret"), line);
  assert.ok(!line.includes("iPhone"), line);
  assert.match(line, / ua=[0-9a-f]{8}$/);
});
