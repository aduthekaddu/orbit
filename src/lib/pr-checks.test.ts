import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const script = path.join(process.cwd(), "scripts/ci/pr-checks.sh");
const template = fs.readFileSync(path.join(process.cwd(), ".github/PULL_REQUEST_TEMPLATE.md"), "utf8");
const goodBody = "## Why\n\nA real reason.\n\n## What changed\n\n- A change.\n\n## How I checked it\n\n- [x] ran it\n";
const tools = ["git", "jq", "bash"].every((tool) => spawnSync(tool, ["--version"]).status === 0);

let repo: string;
let docsOnly: string;
let sourceChange: string;
let sourceAndChangelog: string;
let sourceAndOldChangelog: string;
let sourceAndBlankLines: string;
let base: string;

const changelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [0.1.0] - 2026-11-01\n\n- An old entry.\n";

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(file: string, text: string, message: string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.appendFileSync(path.join(repo, file), text);
  git("add", ".");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-pr-checks-"));
  git("init", "-q", ".");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), changelog);
  base = commit("README.md", "base\n", "base");
  sourceChange = commit("src/a.ts", "x\n", "change src");
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), changelog.replace("### Added\n", "### Added\n\n- A new entry.\n"));
  git("add", ".");
  git("commit", "-q", "-m", "add an entry");
  sourceAndChangelog = git("rev-parse", "HEAD");
  git("checkout", "-q", sourceChange);
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), `${changelog}- Another old line.\n`);
  git("add", ".");
  git("commit", "-q", "-m", "edit a released section");
  sourceAndOldChangelog = git("rev-parse", "HEAD");
  git("checkout", "-q", sourceChange);
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), changelog.replace("### Added\n", "### Added\n\n\n"));
  git("add", ".");
  git("commit", "-q", "-m", "add blank lines under Unreleased");
  sourceAndBlankLines = git("rev-parse", "HEAD");
  git("checkout", "-q", base);
  docsOnly = commit("docs/a.md", "y\n", "change docs");
});

after(() => fs.rmSync(repo, { recursive: true, force: true }));

type Case = { name: string; commit: () => string; env: Record<string, string>; ok: boolean };

const ready = { TITLE: "fix: keep runs cancelled", HEAD_REF: "fix/keep-cancelled", BODY: goodBody, DRAFT: "false", LABELS: "[]", ACTOR: "someone" };

const cases: Case[] = [
  { name: "a fix that changes source and the changelog passes", commit: () => sourceAndChangelog, env: ready, ok: true },
  { name: "a fix that changes source without the changelog fails", commit: () => sourceChange, env: ready, ok: false },
  { name: "a changelog edit outside the Unreleased section does not count", commit: () => sourceAndOldChangelog, env: ready, ok: false },
  { name: "blank lines under Unreleased do not count", commit: () => sourceAndBlankLines, env: ready, ok: false },
  { name: "the skip-changelog label lets it pass", commit: () => sourceChange, env: { ...ready, LABELS: '["skip-changelog"]' }, ok: true },
  { name: "a draft skips the changelog check", commit: () => sourceChange, env: { ...ready, DRAFT: "true" }, ok: true },
  { name: "a ci title needs no changelog entry", commit: () => sourceChange, env: { ...ready, TITLE: "ci: add a check", HEAD_REF: "ci/add-a-check" }, ok: true },
  { name: "a fix that changes only docs needs no changelog entry", commit: () => docsOnly, env: ready, ok: true },
  { name: "a title without a type fails", commit: () => docsOnly, env: { ...ready, TITLE: "Keep runs cancelled" }, ok: false },
  { name: "a title with an unknown type fails", commit: () => docsOnly, env: { ...ready, TITLE: "wip: keep runs cancelled" }, ok: false },
  { name: "a title with a scope and a bang passes", commit: () => docsOnly, env: { ...ready, TITLE: "feat(chat)!: drop the old route", HEAD_REF: "feat/drop-route" }, ok: true },
  { name: "a branch without a type fails", commit: () => docsOnly, env: { ...ready, HEAD_REF: "keep-cancelled" }, ok: false },
  { name: "a branch with capitals fails", commit: () => docsOnly, env: { ...ready, HEAD_REF: "fix/Keep-Cancelled" }, ok: false },
  { name: "a branch type outside the list fails", commit: () => docsOnly, env: { ...ready, HEAD_REF: "wip/keep-cancelled" }, ok: false },
  { name: "a ready pull request with the untouched template fails", commit: () => docsOnly, env: { ...ready, BODY: template }, ok: false },
  { name: "a ready pull request missing a section fails", commit: () => docsOnly, env: { ...ready, BODY: "## Why\n\nBecause.\n\n## What changed\n\nStuff.\n" }, ok: false },
  { name: "a body with Windows line endings passes", commit: () => docsOnly, env: { ...ready, BODY: goodBody.replace(/\n/g, "\r\n") }, ok: true },
  { name: "a Why section that holds only a comment with a greater-than sign counts as empty", commit: () => docsOnly, env: { ...ready, BODY: "## Why\n\n<!-- Say what a > b means. -->\n\n## What changed\n\n- A change.\n\n## How I checked it\n\n- [x] ran it\n" }, ok: false },
  { name: "a comment that spans lines is removed before the section check", commit: () => docsOnly, env: { ...ready, BODY: "## Why\n\n<!--\nThe user problem.\n-->\n\n## What changed\n\n- A change.\n\n## How I checked it\n\n- [x] ran it\n" }, ok: false },
  { name: "a draft with the untouched template passes", commit: () => docsOnly, env: { ...ready, BODY: template, DRAFT: "true" }, ok: true },
  { name: "a draft with a bad title still fails", commit: () => docsOnly, env: { ...ready, BODY: template, DRAFT: "true", TITLE: "oops" }, ok: false },
  { name: "a person on a dependabot branch is still checked", commit: () => docsOnly, env: { TITLE: "Bump x from 1 to 2", HEAD_REF: "dependabot/npm_and_yarn/x-2", BODY: "", DRAFT: "false", LABELS: "[]", ACTOR: "someone" }, ok: false },
  { name: "ImgBot is exempt because of its author", commit: () => docsOnly, env: { TITLE: "[ImgBot] Optimize images", HEAD_REF: "imgbot", BODY: "", DRAFT: "false", LABELS: "[]", ACTOR: "imgbot[bot]" }, ok: true },
  { name: "a Dependabot pull request is exempt", commit: () => docsOnly, env: { TITLE: "Bump x from 1 to 2", HEAD_REF: "dependabot/npm_and_yarn/x-2", BODY: "", DRAFT: "false", LABELS: "[]", ACTOR: "dependabot[bot]" }, ok: true },
];

for (const item of cases) {
  test(item.name, { skip: tools ? false : "git, jq, and bash are needed" }, () => {
    git("checkout", "-q", item.commit());
    const result = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env: { ...process.env, ...item.env, BASE_SHA: base } });
    assert.equal(result.status === 0, item.ok, `${result.stdout}${result.stderr}`);
  });
}
