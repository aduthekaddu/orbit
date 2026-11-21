import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const repoRoot = process.cwd();
const actionPath = path.join(repoRoot, ".github/actions/setup-orbit/action.yml");
const workflowPath = path.join(repoRoot, ".github/workflows/ci.yml");
const actionText = fs.readFileSync(actionPath, "utf8");
const workflowText = fs.readFileSync(workflowPath, "utf8");

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function extractStepBlock(yaml: string, stepName: string) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `missing step "${stepName}"`);
  const indent = lines[start].search(/\S/);
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && line.search(/\S/) <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

function extractFoldedField(stepBlock: string, fieldName: string) {
  const lines = stepBlock.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith(`${fieldName}:`));
  assert.notEqual(start, -1, `missing field "${fieldName}" in step`);
  const header = lines[start];
  const rest = header.slice(header.indexOf(":") + 1).trim();
  if (rest !== ">-" && rest !== ">" && rest !== "|" && rest !== "|-") {
    return rest;
  }
  const fieldIndent = header.search(/\S/);
  const content: string[] = [];
  let blockIndent: number | null = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      content.push("");
      continue;
    }
    const lineIndent = line.search(/\S/);
    if (lineIndent <= fieldIndent) break;
    if (blockIndent === null) blockIndent = lineIndent;
    content.push(line.slice(blockIndent));
  }
  return rest.startsWith(">") ? content.join(" ").replace(/\s+/g, " ").trim() : content.join("\n");
}

function parseGithubOutput(file: string) {
  const out: Record<string, string> = {};
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    assert.notEqual(eq, -1, `invalid GITHUB_OUTPUT line: ${line}`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function runBash(script: string, cwd: string, extraEnv: Record<string, string>) {
  const outputFile = path.join(makeTempDir("orbit-gh-out-"), "github-output");
  fs.writeFileSync(outputFile, "");
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    env: { ...process.env, GITHUB_OUTPUT: outputFile, ...extraEnv },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: parseGithubOutput(outputFile),
  };
}

function createFakeWorkspace(options?: {
  omitLockfile?: boolean;
  corruptLockfile?: boolean;
  omitPackage?: string;
  nonExecutableBin?: string;
  brokenSqlite?: boolean;
  brokenVec?: boolean;
  omitNativeModules?: boolean;
}) {
  const dir = makeTempDir("orbit-cache-ws-");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "orbit-fixture",
      dependencies: {
        "better-sqlite3": "13.0.3",
        "sqlite-vec": "0.1.9",
        zod: "4.6.7",
      },
      devDependencies: {
        next: "16.4.3",
        playwright: "1.64.1",
        tsx: "4.23.15",
        typescript: "5.9.3",
      },
    }),
  );

  const modulesDir = path.join(dir, "node_modules");
  const binDir = path.join(modulesDir, ".bin");
  fs.mkdirSync(binDir, { recursive: true });

  if (!options?.omitLockfile) {
    fs.writeFileSync(
      path.join(modulesDir, ".package-lock.json"),
      options?.corruptLockfile
        ? '{"lockfileVersion":3,"packages":{'
        : JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/zod": { version: "4.6.7" } } }),
    );
  }

  for (const bin of ["tsc", "next", "tsx", "playwright"]) {
    const binPath = path.join(binDir, bin);
    fs.writeFileSync(binPath, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(binPath, options?.nonExecutableBin === bin ? 0o644 : 0o755);
  }

  for (const pkg of ["better-sqlite3", "sqlite-vec", "zod", "next", "playwright", "tsx", "typescript"]) {
    if (options?.omitPackage === pkg) continue;
    if (options?.omitNativeModules && (pkg === "better-sqlite3" || pkg === "sqlite-vec")) continue;
    const pkgDir = path.join(modulesDir, pkg);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkg, main: "index.js" }));
    if (pkg === "better-sqlite3") {
      fs.writeFileSync(
        path.join(pkgDir, "index.js"),
        options?.brokenSqlite
          ? `throw new Error("ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch");\n`
          : `module.exports = class FakeDatabase {
              constructor() { this.vecLoaded = false; this.closed = false; }
              prepare(sql) {
                return {
                  get: () => {
                    if (sql !== "select vec_version()" || !this.vecLoaded) throw new Error("vec_version unavailable");
                    return { "vec_version()": "v0.1.9" };
                  },
                };
              }
              close() { this.closed = true; }
            };\n`,
      );
    } else if (pkg === "sqlite-vec") {
      fs.writeFileSync(
        path.join(pkgDir, "index.js"),
        options?.brokenVec
          ? `exports.load = () => { throw new Error("missing sqlite-vec shared library"); };\n`
          : `exports.load = (db) => { db.vecLoaded = true; };\n`,
      );
    }
  }

  return dir;
}

function evaluateSaveCondition(
  expr: string,
  ctx: {
    jobSuccess: boolean;
    ref: string;
    eventName: string;
    cacheKey: string;
    cacheState: string;
  },
) {
  const jsExpr = expr
    .replaceAll("success()", String(ctx.jobSuccess))
    .replaceAll("github.ref", JSON.stringify(ctx.ref))
    .replaceAll("github.event_name", JSON.stringify(ctx.eventName))
    .replaceAll("steps.setup.outputs.cache-key", JSON.stringify(ctx.cacheKey))
    .replaceAll("steps.setup.outputs.cache-state", JSON.stringify(ctx.cacheState));
  assert.doesNotMatch(jsExpr, /\b(github|steps|inputs|matrix|runner|vars|secrets)\b/, `unresolved expression: ${jsExpr}`);
  return Boolean(new Function(`return (${jsExpr});`)());
}

const keyScript = extractFoldedField(extractStepBlock(actionText, "Compute the dependency cache key"), "run");
const verifyScript = extractFoldedField(extractStepBlock(actionText, "Verify restored node_modules"), "run");
const installScript = extractFoldedField(extractStepBlock(actionText, "Install dependencies"), "run");
const saveBlock = extractStepBlock(workflowText, "Save verified node_modules");
const saveIf = extractFoldedField(saveBlock, "if");

test("setup-orbit and ci.yml scripts pass bash syntax check and avoid template injection", () => {
  for (const [label, script] of [
    ["key", keyScript],
    ["verify", verifyScript],
    ["install", installScript],
  ]) {
    const check = spawnSync("bash", ["-n", "-c", script], { encoding: "utf8" });
    assert.equal(check.status, 0, `${label} failed bash -n: ${check.stderr}`);
    assert.doesNotMatch(script, /\$\{\{/, `${label} must not interpolate GitHub expressions inside run`);
  }
});

test("workflow keeps pinned actions, disables setup-node cache, and saves only after checks pass", () => {
  assert.match(actionText, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7\.1\.0/);
  assert.match(actionText, /package-manager-cache:\s*false/);
  assert.match(actionText, /actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/);
  assert.doesNotMatch(actionText, /actions\/cache\/save/);
  assert.doesNotMatch(actionText, /seed-dependency-cache/);
  assert.doesNotMatch(workflowText, /seed-dependency-cache/);

  assert.match(extractStepBlock(actionText, "Compute the dependency cache key"), /continue-on-error:\s*true/);
  assert.match(extractStepBlock(actionText, "Restore locked node_modules"), /continue-on-error:\s*true/);
  assert.match(extractStepBlock(actionText, "Install dependencies"), /if:\s*steps\.verify\.outputs\.state != 'hit'/);
  assert.match(saveBlock, /continue-on-error:\s*true/);
  assert.match(saveBlock, /actions\/cache\/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/);

  const order = [
    "- uses: ./.github/actions/setup-orbit",
    "- name: Typecheck",
    "- name: Pull the pinned sandbox images",
    "- name: Test",
    "- name: Check that no sandbox container remains",
    "- name: Build",
    "- name: Save verified node_modules",
  ];
  let cursor = -1;
  for (const marker of order) {
    const idx = workflowText.indexOf(marker);
    assert.ok(idx > cursor, `expected "${marker}" after previous gate`);
    cursor = idx;
  }
});

test("cache key includes exact platform, glibc, Node target, ABI, Node version, and lock hash", () => {
  const result = runBash(keyScript, repoRoot, {
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    NODE_VERSION: "22.21.1",
    LOCK_HASH: "abc123def456",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.outputs.key,
    new RegExp(
      `^orbit-modules-Linux-X64-[a-z0-9._-]+-[0-9.]+-glibc-[0-9.]+-${process.platform}-${process.arch}-abi${process.versions.modules}-22\\.21\\.1-abc123def456$`,
    ),
  );
});

test("cache key computation fails loudly when a key input or getconf fails", () => {
  const missingHash = runBash(keyScript, repoRoot, {
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    NODE_VERSION: "22.21.1",
    LOCK_HASH: "",
  });
  assert.notEqual(missingHash.status, 0);
  assert.equal(missingHash.outputs.key, undefined);

  const stubBin = makeTempDir("orbit-bad-getconf-");
  const badGetconf = path.join(stubBin, "getconf");
  fs.writeFileSync(badGetconf, "#!/usr/bin/env bash\nexit 1\n");
  fs.chmodSync(badGetconf, 0o755);
  const failedGetconf = runBash(keyScript, repoRoot, {
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    NODE_VERSION: "22.21.1",
    LOCK_HASH: "abc123def456",
  });
  assert.notEqual(failedGetconf.status, 0);
  assert.equal(failedGetconf.outputs.key, undefined);
});

test("verify accepts a complete restored tree with loadable native modules", () => {
  const ws = createFakeWorkspace();
  const result = runBash(verifyScript, ws, {
    KEY_OUTCOME: "success",
    CACHE_KEY: "orbit-modules-test",
    RESTORE_OUTCOME: "success",
    CACHE_HIT: "true",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.outputs, { state: "hit" });
});

for (const [label, env] of [
  [
    "key computation error",
    { KEY_OUTCOME: "failure", CACHE_KEY: "", RESTORE_OUTCOME: "skipped", CACHE_HIT: "" },
  ],
  [
    "empty cache key",
    { KEY_OUTCOME: "success", CACHE_KEY: "", RESTORE_OUTCOME: "skipped", CACHE_HIT: "" },
  ],
  [
    "restore error",
    { KEY_OUTCOME: "success", CACHE_KEY: "orbit-modules-test", RESTORE_OUTCOME: "failure", CACHE_HIT: "" },
  ],
  [
    "cache miss",
    { KEY_OUTCOME: "success", CACHE_KEY: "orbit-modules-test", RESTORE_OUTCOME: "success", CACHE_HIT: "" },
  ],
] as const) {
  test(`verify classifies ${label} as non-usable without failing the job`, () => {
    const ws = createFakeWorkspace();
    const expectedState = label.startsWith("key") || label.startsWith("empty")
      ? "key-error"
      : label === "restore error"
        ? "restore-error"
        : "miss";
    const result = runBash(verifyScript, ws, { ...env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.outputs, { state: expectedState });
  });
}

for (const [label, opts] of [
  ["missing hidden lockfile", { omitLockfile: true }],
  ["corrupt hidden lockfile", { corruptLockfile: true }],
  ["missing direct dependency", { omitPackage: "zod" }],
  ["non-executable cli binary", { nonExecutableBin: "tsc" }],
  ["ABI-mismatched better-sqlite3", { brokenSqlite: true }],
  ["broken sqlite-vec loader", { brokenVec: true }],
] as const) {
  test(`verify rejects an incomplete hit (${label}) and triggers clean fallback`, () => {
    const ws = createFakeWorkspace(opts);
    const result = runBash(verifyScript, ws, {
      KEY_OUTCOME: "success",
      CACHE_KEY: "orbit-modules-test",
      RESTORE_OUTCOME: "success",
      CACHE_HIT: "true",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.outputs, { state: "invalid-restore" });
    assert.match(result.stdout, /::warning::Restored node_modules failed verification/);
  });
}

test("verify rejects native modules resolved outside workspace node_modules", () => {
  const parent = createFakeWorkspace();
  const child = path.join(parent, "nested");
  fs.mkdirSync(child);
  const childWs = createFakeWorkspace({ omitNativeModules: true });
  fs.cpSync(childWs, child, { recursive: true });
  fs.writeFileSync(
    path.join(child, "package.json"),
    JSON.stringify({
      name: "nested-fixture",
      dependencies: { zod: "4.6.7" },
      devDependencies: {},
    }),
  );
  const result = runBash(verifyScript, child, {
    KEY_OUTCOME: "success",
    CACHE_KEY: "orbit-modules-test",
    RESTORE_OUTCOME: "success",
    CACHE_HIT: "true",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.outputs, { state: "invalid-restore" });
});

test("install fallback removes partial read-only node_modules before npm ci and surfaces npm ci errors", () => {
  const ws = makeTempDir("orbit-install-fallback-");
  const partialDir = path.join(ws, "node_modules", "partial");
  fs.mkdirSync(partialDir, { recursive: true });
  fs.writeFileSync(path.join(partialDir, "stale.txt"), "corrupt");
  fs.chmodSync(path.join(partialDir, "stale.txt"), 0o444);
  fs.chmodSync(partialDir, 0o555);

  const stubBin = makeTempDir("orbit-stub-npm-");
  const marker = path.join(ws, "npm-args.txt");
  const stubNpm = path.join(stubBin, "npm");
  fs.writeFileSync(
    stubNpm,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -e node_modules ]]; then
  echo "stale node_modules still existed" >&2
  exit 99
fi
printf '%s\n' "$*" > "${marker}"
exit "\${STUB_NPM_EXIT:-0}"
`,
  );
  fs.chmodSync(stubNpm, 0o755);

  const ok = runBash(installScript, ws, {
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    STUB_NPM_EXIT: "0",
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "ci");

  const fail = runBash(installScript, ws, {
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    STUB_NPM_EXIT: "1",
  });
  assert.equal(fail.status, 1);
});

test("save condition writes only on main after a green verified run and never on PRs", () => {
  const cases: Array<{
    name: string;
    ctx: Parameters<typeof evaluateSaveCondition>[1];
    expected: boolean;
  }> = [
    {
      name: "push to main after miss",
      ctx: { jobSuccess: true, ref: "refs/heads/main", eventName: "push", cacheKey: "k", cacheState: "miss" },
      expected: true,
    },
    {
      name: "push to main after restore-error",
      ctx: { jobSuccess: true, ref: "refs/heads/main", eventName: "push", cacheKey: "k", cacheState: "restore-error" },
      expected: true,
    },
    {
      name: "weekly schedule on main after miss",
      ctx: { jobSuccess: true, ref: "refs/heads/main", eventName: "schedule", cacheKey: "k", cacheState: "miss" },
      expected: true,
    },
    {
      name: "manual dispatch on main after miss",
      ctx: { jobSuccess: true, ref: "refs/heads/main", eventName: "workflow_dispatch", cacheKey: "k", cacheState: "miss" },
      expected: true,
    },
    {
      name: "failed checks job on main",
      ctx: { jobSuccess: false, ref: "refs/heads/main", eventName: "push", cacheKey: "k", cacheState: "miss" },
      expected: false,
    },
    {
      name: "cache hit on main",
      ctx: { jobSuccess: true, ref: "refs/heads/main", eventName: "push", cacheKey: "k", cacheState: "hit" },
      expected: false,
    },
    {
      name: "invalid restore on main",
      ctx: { jobSuccess: true, ref: "refs/heads/main", eventName: "push", cacheKey: "k", cacheState: "invalid-restore" },
      expected: false,
    },
    {
      name: "key error on main",
      ctx: { jobSuccess: true, ref: "refs/heads/main", eventName: "push", cacheKey: "", cacheState: "key-error" },
      expected: false,
    },
    {
      name: "same-repo pull request",
      ctx: { jobSuccess: true, ref: "refs/pull/85/merge", eventName: "pull_request", cacheKey: "k", cacheState: "miss" },
      expected: false,
    },
    {
      name: "Dependabot pull request",
      ctx: { jobSuccess: true, ref: "refs/pull/91/merge", eventName: "pull_request", cacheKey: "k", cacheState: "miss" },
      expected: false,
    },
    {
      name: "pull_request_target against main",
      ctx: { jobSuccess: true, ref: "refs/heads/main", eventName: "pull_request_target", cacheKey: "k", cacheState: "miss" },
      expected: false,
    },
    {
      name: "workflow_dispatch on feature branch",
      ctx: { jobSuccess: true, ref: "refs/heads/ci/cache-node-modules", eventName: "workflow_dispatch", cacheKey: "k", cacheState: "miss" },
      expected: false,
    },
  ];

  for (const c of cases) {
    assert.equal(evaluateSaveCondition(saveIf, c.ctx), c.expected, `save condition mismatch for: ${c.name}`);
  }
});
