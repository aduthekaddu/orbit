import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default async function launchMode({ page, origin, step }) {
  const verify = fileURLToPath(new URL("../verify.mjs", import.meta.url));
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  const launch = (mode) => spawnSync(process.execPath, [verify, "launch"], { env: { ...process.env, ORBIT_SANDBOX: mode }, encoding: "utf8" });
  const mismatch = launch("on");
  step("launch rejects enabling sandbox on a reused disabled server", mismatch.status !== 0 && /mode|sandbox/i.test(mismatch.stderr) && /cleanup/.test(mismatch.stderr), `exit ${mismatch.status}`);
  const match = launch("off");
  step("launch still reuses a server with the requested mode", match.status === 0 && /already/.test(match.stdout), `exit ${match.status}`);
  const chat = await page.request.get(`${origin}/api/chats/${id}`);
  step("a rejected launch keeps the running server and its data", chat.ok());
}
