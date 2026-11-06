import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const verify = path.join(repo, ".agents/skills/verify-orbit/verify.mjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-fixture-isolation-"));
try {
  for (const scenario of ["sandbox-stopped", "sandbox-tool-error", "sandbox-scroll"]) {
    const alternate = path.join(temporary, scenario);
    const result = spawnSync(process.execPath, [verify, "browse", scenario], { cwd: repo, env: { ...process.env, ORBIT_DATA_DIR: alternate }, stdio: "inherit" });
    assert.equal(result.status, 0, `${scenario} must use the controlled verification database`);
    assert.equal(fs.existsSync(alternate), false, "the parent data override must remain untouched");
    console.log(`PASS ${scenario} ignores the parent data override`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
