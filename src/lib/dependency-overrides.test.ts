import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const NAME = "@esbuild-kit/core-utils";
const SECTION = 'List it under "Dependency overrides" in CONTRIBUTING.md.';
const TRACKED = `- \`${NAME}\` pins esbuild for drizzle-kit's deprecated loader chain. Tracked in #237.\n`;

function overrideProblems(overrides: Record<string, unknown>, lockPaths: string[], contributing: string): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(overrides)) {
    const installed = lockPaths.some((entry) => entry === `node_modules/${name}` || entry.endsWith(`/node_modules/${name}`));
    if (!installed) {
      problems.push(
        `package.json: the override for ${name} matches no package in package-lock.json. Delete the entry, run npm install, and close its tracking issue.`,
      );
    }
    const tracked = contributing.split("\n").some((line) => line.includes(name) && /#[0-9]+|issues\/[0-9]+/.test(line));
    if (!tracked) {
      problems.push(`CONTRIBUTING.md: the override for ${name} has no line linking its tracking issue. ${SECTION}`);
    }
  }
  return problems;
}

test("an installed override whose CONTRIBUTING.md line links a tracking issue passes", () => {
  assert.deepEqual(overrideProblems({ [NAME]: { esbuild: "0.25.12" } }, ["node_modules/@esbuild-kit/core-utils"], TRACKED), []);
});

test("a nested lockfile copy of the package counts as installed", () => {
  assert.deepEqual(
    overrideProblems({ [NAME]: {} }, ["node_modules/drizzle-kit/node_modules/@esbuild-kit/core-utils"], TRACKED),
    [],
  );
});

test("an override whose package left the lockfile fails, and the error names the removal", () => {
  const [problem, ...rest] = overrideProblems({ [NAME]: { esbuild: "0.25.12" } }, ["node_modules/tsx"], TRACKED);
  assert.deepEqual(rest, []);
  assert.ok(problem.startsWith(`package.json: the override for ${NAME} matches no package`), problem);
  assert.ok(problem.endsWith("close its tracking issue."), problem);
});

test("an override with no CONTRIBUTING.md line fails, and the error names the section", () => {
  const [problem, ...rest] = overrideProblems({ [NAME]: {} }, ["node_modules/@esbuild-kit/core-utils"], "");
  assert.deepEqual(rest, []);
  assert.ok(problem.startsWith(`CONTRIBUTING.md: the override for ${NAME} has no line`), problem);
  assert.ok(problem.endsWith(SECTION), problem);
});

test("a CONTRIBUTING.md line without an issue link does not track an override", () => {
  const problems = overrideProblems({ [NAME]: {} }, ["node_modules/@esbuild-kit/core-utils"], `- \`${NAME}\` pins esbuild.\n`);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].startsWith("CONTRIBUTING.md:"), problems[0]);
});

test("no overrides means no problems", () => {
  assert.deepEqual(overrideProblems({}, [], ""), []);
});

test("every override in this repository matches a lockfile package and a CONTRIBUTING.md tracking line", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const pkg = JSON.parse(read("package.json")) as { overrides?: Record<string, unknown> };
  const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, unknown> };
  assert.deepEqual(overrideProblems(pkg.overrides ?? {}, Object.keys(lock.packages), read("CONTRIBUTING.md")), []);
});
