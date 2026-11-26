import assert from "node:assert/strict";

const origin = `http://127.0.0.1:${process.env.ORBIT_VERIFY_PORT}`;
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

const responses = [
  { path: "/login", label: "login page", status: 200 },
  { path: `/c/${id}`, label: "chat page", status: 200, cookie },
  { path: "/response-headers-missing-page", label: "missing page", status: 404, cookie },
  { path: "/api/chats", label: "signed-in API", status: 200, cookie },
  { path: "/api/chats", label: "signed-out API", status: 401 },
];

for (const response of responses) {
  const { path, label, status } = response;
  const { headers, status: actualStatus, body } = await fetch(origin + path, {
    headers: response.cookie ? { cookie: response.cookie } : {},
    redirect: "manual",
  });
  await body?.cancel();
  check(`${label} returns HTTP ${status}`, actualStatus === status, `got ${actualStatus}`);
  for (const [name, expected] of Object.entries({
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-powered-by": null,
  })) {
    const actual = headers.get(name);
    check(`${label}: ${name} = ${expected ?? "absent"}`, actual === expected, `got ${actual ?? "absent"}`);
  }
  const csp = headers.get("content-security-policy");
  const directives = csp?.split(";").map(directive => directive.trim()) ?? [];
  const required = path.startsWith("/api/")
    ? ["default-src 'none'", "frame-ancestors 'none'"]
    : ["default-src 'self'", "frame-src 'none'", "frame-ancestors 'none'", "object-src 'none'"];
  check(`${label}: CSP includes ${required.join(", ")}`, required.every(directive => directives.includes(directive)), csp ?? "no CSP");
}

if (failures) process.exitCode = 1;
