import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ownerFromEnv } from "./owner.mjs";

const repo = process.cwd();
const ownerModule = pathToFileURL(path.join(repo, "src/lib/sandbox/owner.mjs")).href;
const scanned = ["src", "scripts", ".agents", ".github"];
const thisFile = "src/lib/sandbox/owner.test.ts";
const bareLabel = ["orbit", "sandbox"].join(".");
// Files that may name the bare label: the helper that owns it, and the test that pins the container policy.
// Add a file here only when its job is to act on every Orbit container on the host. Each entry must still name the label.
const allowed = new Set(["src/lib/sandbox/owner.mjs", "src/lib/sandbox/spec.test.ts"]);
const helpers = "ownedSandboxFilter or ownedSandboxFilterArgs from src/lib/sandbox/owner.mjs";

const sourceFiles = scanned
  .flatMap((dir) =>
    readdirSync(path.join(repo, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(repo, path.join(entry.parentPath, entry.name))))
  .filter((file) => file !== thisFile);

// Finds container listings that skip the owner helpers. It reads text, so it cannot see a label built from parts,
// a listing through another client, or a docker CLI argument list whose filter sits in a different file.
function unfilteredListings(text: string): string[] {
  const found: string[] = [];
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  for (const match of text.matchAll(/\blistContainers\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    for (; end < text.length && depth > 0; end += 1) depth += text[end] === "(" ? 1 : text[end] === ")" ? -1 : 0;
    if (!text.slice(match.index, end).includes("ownedSandboxFilter")) found.push(`line ${lineOf(match.index)}: listContainers() without ownedSandboxFilter`);
  }
  for (const match of text.matchAll(/^.*\bdocker (?:ps|container ls)\b.*$/gm)) {
    if (!match[0].includes("ownedSandboxFilter")) found.push(`line ${lineOf(match.index)}: docker ps without ownedSandboxFilterArgs`);
  }
  const argv = text.match(/["']ps["']/);
  if (argv && !text.includes("ownedSandboxFilterArgs")) found.push(`line ${lineOf(argv.index ?? 0)}: a docker ps argument list in a file that never uses ownedSandboxFilterArgs`);
  return found;
}

function inChild(script: string) {
  const { ORBIT_SANDBOX_OWNER: _owner, ...env } = process.env;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as string[];
}

test("ORBIT_SANDBOX_OWNER names the owner, and a value that could change a Docker filter is refused", () => {
  assert.equal(ownerFromEnv({ ORBIT_SANDBOX_OWNER: "verify-3f2a.1_b" }), "verify-3f2a.1_b");
  assert.equal(ownerFromEnv({}), undefined);
  assert.equal(ownerFromEnv({ ORBIT_SANDBOX_OWNER: "" }), undefined);
  for (const value of ["a b", "--filter", "a=b", "x".repeat(129)]) {
    assert.throws(() => ownerFromEnv({ ORBIT_SANDBOX_OWNER: value }), /sandbox owner/);
  }
});

test("two copies of the module in one process share one owner, which a child process inherits", () => {
  const [first, second, fromEnv] = inChild(`
    const a = await import(${JSON.stringify(`${ownerModule}?copy=a`)});
    const b = await import(${JSON.stringify(`${ownerModule}?copy=b`)});
    console.log(JSON.stringify([a.sandboxOwner(), b.sandboxOwner(), process.env.ORBIT_SANDBOX_OWNER]));
  `);
  assert.equal(second, first);
  assert.equal(fromEnv, first);
});

test("two processes with no ORBIT_SANDBOX_OWNER get different owners", () => {
  const script = `const m = await import(${JSON.stringify(ownerModule)}); console.log(JSON.stringify([m.sandboxOwner()]));`;
  assert.notEqual(inChild(script)[0], inChild(script)[0]);
});

test(`no file lists Docker containers by the bare ${bareLabel} label`, () => {
  const stale = [...allowed].filter((file) => !readFileSync(path.join(repo, file), "utf8").includes(bareLabel));
  assert.deepEqual(stale, [], `These allowlist entries in ${thisFile} no longer name the ${bareLabel} label, so remove them:\n  ${stale.join("\n  ")}`);
  const offenders = sourceFiles.filter((file) => !allowed.has(file) && readFileSync(path.join(repo, file), "latin1").includes(bareLabel));
  assert.deepEqual(offenders, [], [
    `These files name the ${bareLabel} label, which every Orbit process's containers carry, so a check on it fails on another run's container:`,
    ...offenders.map((file) => `  ${file}`),
    `List or wait for containers with ${helpers}.`,
    `A file whose job is to act on every Orbit container on the host goes in the allowlist in ${thisFile}.`,
  ].join("\n"));
});

test("every container listing goes through the owner helpers", () => {
  const offenders = sourceFiles.flatMap((file) => unfilteredListings(readFileSync(path.join(repo, file), "utf8")).map((problem) => `  ${file} ${problem}`));
  assert.deepEqual(offenders, [], [
    "These container listings are not limited to one owner, so a check on them fails on another run's container:",
    ...offenders,
    `Filter every listing with ${helpers}. Use docker.ping() to test that Docker answers.`,
  ].join("\n"));
});

test("the listing check flags an unfiltered call and accepts a filtered one", () => {
  assert.equal(unfilteredListings("await docker.listContainers();").length, 1);
  assert.equal(unfilteredListings("await docker.listContainers({ all: true });").length, 1);
  assert.equal(unfilteredListings('execFileSync("docker", ["ps", "-a"]);').length, 1);
  assert.equal(unfilteredListings("run: docker ps -a").length, 1);
  assert.deepEqual(unfilteredListings("await docker.listContainers({ filters: { ...ownedSandboxFilter(owner), status: ['running'] } });"), []);
  assert.deepEqual(unfilteredListings('execFileSync("docker", ["ps", ...ownedSandboxFilterArgs(owner)]);'), []);
});
