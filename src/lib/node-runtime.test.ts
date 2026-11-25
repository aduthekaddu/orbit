import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

// The operator approved the Node 24 LTS line as the shipped runtime (#53). The major below is the
// one place it is written: every declaration that ships, types, or proposes a Node major must move
// with it, so the image never disagrees with the types or with what Dependabot proposes.
const MAJOR = 24;
const LINE = `node:${MAJOR}-bookworm-slim`;
const SKIP_ABOVE = `>=${MAJOR + 1}`;
const TYPES = new RegExp(`^${MAJOR}\\.\\d+\\.\\d+$`);
const FIX = `Ship Node ${MAJOR} LTS everywhere it is declared (#53): the Dockerfile base image, @types/node in package.json and package-lock.json, the Dependabot skip of ${SKIP_ABOVE} in .github/dependabot.yml, and the setup-orbit default.`;

type RuntimeFiles = {
  dockerfile: string;
  packageJson: string;
  packageLock: string;
  dependabot: string;
  setupAction: string;
};

type DependabotUpdate = { "package-ecosystem"?: unknown; ignore?: unknown };
type DependabotIgnore = { "dependency-name"?: unknown; versions?: unknown };

function runtimeProblems(files: RuntimeFiles) {
  const problems: string[] = [];

  const base = /^FROM (node:\S+)(?:\s.*)?$/m.exec(files.dockerfile)?.[1];
  if (base === undefined) {
    problems.push(`Dockerfile: no node:<major>-bookworm-slim base image. Ship ${LINE}. ${FIX}`);
  } else if (base !== LINE && !base.startsWith(`${LINE}@`)) {
    problems.push(`Dockerfile: the base image is ${base}, not the ${LINE} LTS line. ${FIX}`);
  }

  const pkg = JSON.parse(files.packageJson) as { devDependencies?: Record<string, unknown> };
  const types = pkg.devDependencies?.["@types/node"];
  if (typeof types !== "string" || !TYPES.test(types)) {
    problems.push(`package.json: @types/node is ${JSON.stringify(types)}, which does not type Node ${MAJOR}. ${FIX}`);
  } else {
    const lock = JSON.parse(files.packageLock) as { packages?: Record<string, { version?: unknown }> };
    const resolved = lock.packages?.["node_modules/@types/node"]?.version;
    if (resolved !== types) {
      problems.push(`package-lock.json: @types/node resolves to ${JSON.stringify(resolved)}, not the pinned ${types}. Run npm install. ${FIX}`);
    }
  }

  const config = parse(files.dependabot) as { updates?: DependabotUpdate[] } | null;
  for (const [ecosystem, name] of [["npm", "@types/node"], ["docker", "node"]] as const) {
    const block = (config?.updates ?? []).find((entry) => entry["package-ecosystem"] === ecosystem);
    const ignores = Array.isArray(block?.ignore) ? (block.ignore as DependabotIgnore[]) : [];
    const entry = ignores.find((ignore) => ignore["dependency-name"] === name);
    if (!Array.isArray(entry?.versions) || entry.versions.length !== 1 || entry.versions[0] !== SKIP_ABOVE) {
      problems.push(`.github/dependabot.yml: the ${ecosystem} update must ignore ${name} versions ["${SKIP_ABOVE}"], so Dependabot never proposes a Node major above the LTS line, as #45 and #48 did. ${FIX}`);
    }
  }

  const action = parse(files.setupAction) as { inputs?: Record<string, { default?: unknown }> } | null;
  const defaultNode = action?.inputs?.["node-version"]?.default;
  if (defaultNode === undefined || String(defaultNode) !== String(MAJOR)) {
    problems.push(`.github/actions/setup-orbit/action.yml: the default node-version is ${JSON.stringify(defaultNode)}, so the end-to-end suites would not run the shipped Node ${MAJOR}. ${FIX}`);
  }

  return problems;
}

// npm 10 rewrites the lockfile without the libc marks, so npm ci on the glibc Docker image then
// extracts the musl binaries too. npm 11 keeps them when it starts from a lock that still has them.
const MUSL_FIX = `Restore the last lockfile that carries the marks and rewrite it with npm 11 or newer (#53).`;

function muslProblems(source: string) {
  const lock = JSON.parse(source) as { packages?: Record<string, { libc?: unknown }> };
  return Object.entries(lock.packages ?? {})
    .filter(([name]) => /-musl$|linuxmusl-/.test(name))
    .filter(([, entry]) => JSON.stringify(entry.libc) !== JSON.stringify(["musl"]))
    .map(([name]) => `package-lock.json: ${name} carries no libc ["musl"] mark, so npm ci on the glibc Docker image cannot exclude the musl binary. ${MUSL_FIX}`);
}

const SHIPPED: RuntimeFiles = {
  dockerfile: `FROM ${LINE}\n`,
  packageJson: `${JSON.stringify({ devDependencies: { "@types/node": "24.19.4" } })}\n`,
  packageLock: `${JSON.stringify({ packages: { "node_modules/@types/node": { version: "24.19.4" } } })}\n`,
  dependabot: [
    "updates:",
    "  - package-ecosystem: npm",
    "    ignore:",
    '      - dependency-name: "@types/node"',
    `        versions: ["${SKIP_ABOVE}"]`,
    "  - package-ecosystem: docker",
    "    ignore:",
    "      - dependency-name: node",
    `        versions: ["${SKIP_ABOVE}"]`,
    "",
  ].join("\n"),
  setupAction: `inputs:\n  node-version:\n    default: "${MAJOR}"\n`,
};

test("a repository that ships Node LTS everywhere it declares a Node major has no problems", () => {
  assert.deepEqual(runtimeProblems(SHIPPED), []);
});

test("a digest-pinned base image still declares the LTS line", () => {
  assert.deepEqual(runtimeProblems({ ...SHIPPED, dockerfile: `FROM ${LINE}@sha256:${"a".repeat(64)}\n` }), []);
});

test("the non-LTS image bump Dependabot proposed in #45 fails, and the error names the fix", () => {
  const [problem, ...rest] = runtimeProblems({ ...SHIPPED, dockerfile: "FROM node:25-bookworm-slim\n" });
  assert.deepEqual(rest, []);
  assert.equal(problem, `Dockerfile: the base image is node:25-bookworm-slim, not the ${LINE} LTS line. ${FIX}`);
});

test("the @types/node bump past the shipped runtime Dependabot proposed in #48 fails once, at the pin", () => {
  const problems = runtimeProblems({
    ...SHIPPED,
    packageJson: JSON.stringify({ devDependencies: { "@types/node": "26.6.6" } }),
    packageLock: JSON.stringify({ packages: { "node_modules/@types/node": { version: "26.6.6" } } }),
  });
  assert.deepEqual(problems, [`package.json: @types/node is "26.6.6", which does not type Node ${MAJOR}. ${FIX}`]);
});

test("a Dependabot skip left at the old major fails for both ecosystems", () => {
  const problems = runtimeProblems({ ...SHIPPED, dependabot: SHIPPED.dependabot.replaceAll(`["${SKIP_ABOVE}"]`, '[">=23"]') });
  assert.equal(problems.length, 2);
  assert.ok(problems.every((problem) => problem.startsWith(".github/dependabot.yml:")));
});

test("a Dependabot config without the ignores fails for both ecosystems", () => {
  const problems = runtimeProblems({ ...SHIPPED, dependabot: "updates:\n  - package-ecosystem: npm\n  - package-ecosystem: docker\n" });
  assert.equal(problems.length, 2);
});

test("a half-done bump that leaves the lockfile behind fails", () => {
  const problems = runtimeProblems({
    ...SHIPPED,
    packageJson: JSON.stringify({ devDependencies: { "@types/node": "24.19.4" } }),
    packageLock: JSON.stringify({ packages: { "node_modules/@types/node": { version: "22.20.5" } } }),
  });
  assert.deepEqual(problems, [`package-lock.json: @types/node resolves to "22.20.5", not the pinned 24.19.4. Run npm install. ${FIX}`]);
});

test("a setup action whose default is not the shipped major fails", () => {
  const [problem, ...rest] = runtimeProblems({ ...SHIPPED, setupAction: `inputs:\n  node-version:\n    default: "22"\n` });
  assert.deepEqual(rest, []);
  assert.equal(problem, `.github/actions/setup-orbit/action.yml: the default node-version is "22", so the end-to-end suites would not run the shipped Node ${MAJOR}. ${FIX}`);
});

test("every problem names the fix", () => {
  const problems = [
    ...runtimeProblems({ ...SHIPPED, dockerfile: "FROM python:3.13-slim\n" }),
    ...runtimeProblems({ ...SHIPPED, dependabot: "updates: []\n", setupAction: "inputs: {}\n" }),
    ...runtimeProblems({ ...SHIPPED, packageJson: "{}" }),
  ];
  assert.ok(problems.length >= 4);
  assert.ok(problems.every((problem) => problem.endsWith(FIX)));
});

test("a lockfile that marks its musl binaries has no problems", () => {
  assert.deepEqual(muslProblems(JSON.stringify({ packages: { "node_modules/@next/swc-linux-x64-musl": { libc: ["musl"] } } })), []);
});

test("a lockfile that drops the libc marks fails", () => {
  assert.deepEqual(muslProblems(JSON.stringify({ packages: { "node_modules/@next/swc-linux-x64-musl": {} } })), [
    `package-lock.json: node_modules/@next/swc-linux-x64-musl carries no libc ["musl"] mark, so npm ci on the glibc Docker image cannot exclude the musl binary. ${MUSL_FIX}`,
  ]);
});

test("a musl binary whose upstream package has no libc field does not fail the mark check", () => {
  assert.deepEqual(muslProblems(JSON.stringify({ packages: { "node_modules/@oxlint/binding-linux-arm-musleabihf": {} } })), []);
});

test("the sharp naming form, linuxmusl as an infix, is also guarded", () => {
  assert.deepEqual(muslProblems(JSON.stringify({ packages: { "node_modules/@img/sharp-linuxmusl-x64": {} } })), [
    `package-lock.json: node_modules/@img/sharp-linuxmusl-x64 carries no libc ["musl"] mark, so npm ci on the glibc Docker image cannot exclude the musl binary. ${MUSL_FIX}`,
  ]);
});

test("this repository ships, types, and proposes one Node major, the 24 LTS line", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  assert.deepEqual(runtimeProblems({
    dockerfile: read("Dockerfile"),
    packageJson: read("package.json"),
    packageLock: read("package-lock.json"),
    dependabot: read(".github/dependabot.yml"),
    setupAction: read(".github/actions/setup-orbit/action.yml"),
  }), []);
});

test("this repository marks the lockfile's musl binaries so the glibc Docker image skips them", () => {
  const lock = fs.readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8");
  assert.deepEqual(muslProblems(lock), []);
});
