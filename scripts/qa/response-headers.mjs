import assert from "node:assert/strict";

const origin = `http://127.0.0.1:${process.env.ORBIT_VERIFY_PORT ?? 3210}`;
const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ email: "verify@orbit.local", password: "orbit-verify-pass" }),
});
assert.equal(signIn.status, 200, "sign in to the verify account");
const cookie = signIn.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
await signIn.body?.cancel();
assert.ok(cookie, "sign-in response sets a session cookie");

const created = await fetch(`${origin}/api/chats`, { method: "POST", headers: { origin, cookie } });
assert.ok(created.ok, `create a chat (HTTP ${created.status})`);
const { id } = await created.json();
assert.ok(id, "chat creation returns an ID");

let failures = 0;
function check(name, ok, detail) {
  console.log(ok ? `PASS ${name}` : `FAIL ${name} (${detail})`);
  if (!ok) failures += 1;
}

const login = await fetch(`${origin}/login`);
const script = (await login.text()).match(/\/_next\/static\/[^"']+\.js/)?.[0];
assert.ok(script, "the login page references a static script");

const page = ["frame-src 'none'", "frame-ancestors 'none'"];
const responses = [
  { path: "/login", label: "login page", status: 200, frame: page },
  { path: "/admin", label: "admin page", status: 200, cookie, frame: page },
  { path: "/admin", label: "signed-out admin page", status: 307, frame: page, location: "/login" },
  { path: `/c/${id}`, label: "chat page", status: 200, cookie, frame: page },
  { path: "/response-headers-missing-page", label: "missing page", status: 404, cookie },
  { path: "/api/chats", label: "signed-in API", status: 200, cookie },
  { path: "/api/chats", label: "signed-out API", status: 401 },
  { path: script, label: "static script", status: 200 },
];

for (const response of responses) {
  const { path, label, status, frame } = response;
  const { headers, status: actualStatus, body } = await fetch(origin + path, {
    headers: response.cookie ? { cookie: response.cookie } : {},
    redirect: "manual",
  });
  await body?.cancel();
  check(`${label} returns HTTP ${status}`, actualStatus === status, `got ${actualStatus}`);
  if (response.location) {
    const location = headers.get("location");
    check(`${label} redirects to ${response.location}`, location !== null && new URL(location, origin).pathname === response.location, `got ${location}`);
  }
  for (const [name, expected] of Object.entries({
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-powered-by": null,
    ...(frame ? { "x-frame-options": "DENY" } : {}),
  })) {
    const actual = headers.get(name);
    check(`${label}: ${name} = ${expected ?? "absent"}`, actual === expected, `got ${actual ?? "absent"}`);
  }
  if (!frame) continue;
  const csp = headers.get("content-security-policy");
  const directives = csp?.split(";").map(directive => directive.trim()) ?? [];
  check(`${label}: CSP includes ${frame.join(", ")}`, frame.every(directive => directives.includes(directive)), csp ?? "no CSP");
}

if (failures) process.exitCode = 1;
