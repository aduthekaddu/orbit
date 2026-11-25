import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { parse } from "yaml";

const oxlint = path.join(process.cwd(), "node_modules/.bin/oxlint");
const config = path.join(process.cwd(), ".oxlintrc.json");
let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-lint-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function lint(name: string, source: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  const result = spawnSync(oxlint, ["--config", config, "--format", "json", file], { encoding: "utf8" });
  assert.equal(result.error, undefined, `oxlint did not run: ${result.error}`);
  const { diagnostics } = JSON.parse(result.stdout) as {
    diagnostics: { code: string; labels: { span: { line: number } }[] }[];
  };
  return diagnostics.map((item) => `${item.code} ${item.labels[0].span.line}`);
}

test("a hook called inside a condition in a TSX component is reported", () => {
  const findings = lint("conditional.tsx", `import { useEffect, useState } from "react";

export function Panel({ open }: { open: boolean }) {
  const [count, setCount] = useState<number>(0);
  if (open) {
    useEffect(() => setCount(1), []);
  }
  return <div>{count}</div>;
}
`);
  assert.deepEqual(findings, ["react-hooks(rules-of-hooks) 6"]);
});

test("a dependency list that leaves out a value the callback reads is reported", () => {
  const findings = lint("stale.ts", `import { useCallback } from "react";

export function useJump(index: number, go: (target: number) => void) {
  return useCallback(() => go(index + 1), [go]);
}
`);
  assert.deepEqual(findings, ["react-hooks(exhaustive-deps) 4"]);
});

test("an effect with no dependency list and a type key named like a variable are not reported", () => {
  const findings = lint("every-render.tsx", `import { useCallback, useEffect, useState } from "react";

export function Jumps({ turns }: { turns: string[] }) {
  const [current, setCurrent] = useState(0);
  const load = useCallback(async () => {
    const body = (await fetch("/api/models").then((response) => response.json())) as { models?: string[] };
    setCurrent(body.models?.length ?? 0);
  }, []);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "j") setCurrent(Math.min(current + 1, turns.length - 1));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  const models = turns.map((turn) => turn.toUpperCase());
  return <button onClick={() => void load()}>{models[current]}</button>;
}
`);
  assert.deepEqual(findings, []);
});

test("CI runs the hook lint as a required check", () => {
  type Step = { name?: string; run?: string; "continue-on-error"?: boolean };
  type Workflow = { jobs?: Record<string, { steps?: Step[] }> };
  const workflow = parse(fs.readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8")) as Workflow;
  const step = workflow.jobs?.checks?.steps?.find((item) => item.name === "Lint the React hooks");
  assert.ok(step, "the checks job must include Lint the React hooks");
  assert.equal(step.run, "npm run lint -- --format github");
  assert.equal(step["continue-on-error"], undefined);
});
