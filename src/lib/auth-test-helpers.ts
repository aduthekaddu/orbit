import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { orbitAuthOptions } from "./auth";
import { parseViewer, type Role } from "./policy";

if (!process.env.NODE_TEST_CONTEXT) throw new Error("Account fixtures require the Node test runner.");

function createTestAuth() {
  return betterAuth({ ...orbitAuthOptions(), plugins: [testUtils()], telemetry: { enabled: false } });
}

let auth: ReturnType<typeof createTestAuth> | undefined;

export async function createTestAccount(input: { role: Role; email: string; name: string }) {
  const context = await (auth ??= createTestAuth()).$context;
  const saved = await context.test.saveUser(context.test.createUser(input));
  const viewer = parseViewer(saved);
  const login = await context.test.login({ userId: viewer.id });
  const cookie = login.headers.get("cookie");
  if (!cookie) throw new Error("Test account did not get a session cookie.");
  return { viewer, cookie };
}

export async function createTwoAccounts() {
  const admin = await createTestAccount({ role: "admin", email: "admin@orbit.test", name: "Admin A" });
  const member = await createTestAccount({ role: "member", email: "member@orbit.test", name: "Member B" });
  return { admin, member };
}
