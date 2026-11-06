import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const addon = path.join(path.dirname(require.resolve("ssh2/package.json")), "lib/protocol/crypto/build/Release/sshcrypto.node");
const created = !fs.existsSync(addon);
if (created) {
  fs.mkdirSync(path.dirname(addon), { recursive: true });
  fs.writeFileSync(addon, Buffer.alloc(0), { flag: "wx" });
}
try {
  const result = spawnSync("npm", ["run", "build"], { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0) console.log("PASS production build accepts an optional SSH native addon asset");
} finally {
  if (created) fs.unlinkSync(addon);
}
