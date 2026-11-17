# Contributing to Orbit

Thanks for helping. This guide covers setting up Orbit for development, the checks a change must pass, and how pull requests work. Read [ARCHITECTURE.md](ARCHITECTURE.md) first if you plan to change a route, a table, or the chat stream.

## Set up

1. Install the tools in the README's [requirements table](README.md#requirements).
2. Clone the repository and run `npm ci`.
3. Run `npm run dev`. The dev server listens on `http://127.0.0.1:3210`.
4. Create the account, then add a provider on the **Settings** page. For work that does not need a real model, run the mock provider with `node scripts/qa/mock-provider.mjs` and use the base URL `http://127.0.0.1:3299/v1` with any key.

Development uses `data/orbit.db` in the repository. To start over, stop the server and delete `data/orbit.db`, `data/orbit.db-wal`, `data/orbit.db-shm`, and `data/auth-secret`.

## Check your change

Run these from the repository root. Each one must exit 0.

```sh
npm test
npm run typecheck
npm run build
```

Tests live next to the code as `*.test.ts` and `*.test.tsx`, and run with Node's test runner through `tsx`. Write a test that a user of the code would recognize: a return value, a stored row, a response status, or rendered text. Avoid tests that check which internal function ran.

A change that users can see also needs a live check. The [verify-orbit skill](.agents/skills/verify-orbit/SKILL.md) starts a server with an empty database in `.verify/sandbox` and drives each feature through the same requests the pages send. Its `features/` folder has one recipe per feature.

## Automated checks

GitHub Actions runs the checks on every pull request and every push to `main`, and once a week. The workflows live in `.github/workflows/`. The `CI` workflow runs these jobs, and the last one, `CI passed`, succeeds only when all of them do.

- **Typecheck, test, build.** `npm run typecheck`, `npm test`, and `npm run build` on Node 24, which the Docker image uses. The tests run the sandbox against real Docker, so the job pulls the pinned images first. A local run needs a Docker daemon and the same images, because the sandbox never pulls one. The pull commands are in the README.
- **End to end.** The verify-orbit drives and browser scenarios, in three suites. Each suite starts its own server and keeps its screenshots and logs as a workflow artifact for seven days. Run one locally with `scripts/qa/ci-e2e.sh core`, `browse`, or `sandbox`, after `npm run build` and with nothing on port 3210. The `sandbox` suite also needs Docker and the pinned images. The browse and sandbox suites find scenarios by name, so a new scenario runs without an edit. Scenarios that need a real provider are not run.
- **Docker image.** Lints the Dockerfile, validates both Compose files, builds the image, starts it, and waits for `/api/setup`. `scripts/qa/assert-nonroot.sh` starts the image three ways and requires a non-root server process each time. The ways are the default user, root the way Compose does, and a data volume that an older root image left behind.
- **Workflow files.** `actionlint` and `zizmor` check the workflows themselves.

Every third-party action is pinned to a commit SHA and every tool image to a digest. The local `setup-orbit` action comes with the checkout. Update a pin on purpose, and keep the version comment next to it.

## Security checks

The `Security` and `CodeQL` workflows run on every pull request, every push to `main`, and once a week. GitHub code scanning, dependency review, and secret scanning are not available on a private personal repository, so each job does its own failing. `Security passed` succeeds only when all the `Security` jobs do.

- **Secrets.** `gitleaks` scans the whole git history and redacts what it finds. `.gitleaks.toml` allows one fake secret that a test wrote in three old commits. Do not put a real key in a test. Make a fake one at run time.
- **Dependencies.** OSV-Scanner reads `package-lock.json` through `scripts/ci/osv-gate.sh`. On a pull request it fails only for vulnerabilities the change adds, which includes another copy of a vulnerable package and a dev dependency that becomes a production one. On `main` and on the weekly run it fails for a vulnerable production dependency and only warns about dev dependencies.
- **Semgrep.** Scans the source and the Docker files with the TypeScript, React, Next.js, OWASP, secrets, and Docker rule packs. The Dockerfile scan includes the non-root user rule.
- **CodeQL.** Runs the `security-extended` queries. The SARIF results are a workflow artifact. `scripts/ci/codeql-gate.sh` fails for any finding that is not in `.github/codeql/known-findings.txt`. A finding is a rule, a file, and a line hash, so a second finding in a listed file is new. Fix a finding. Do not list it. Delete a line from the file when its finding is gone, and the job warns until you do.

## Change the database

1. Edit `src/lib/db/schema.ts`.
2. Run `npm run db:generate` to write a migration into `drizzle/`.
3. For SQL that Drizzle cannot describe, such as FTS5 or `sqlite-vec` tables, run `npx drizzle-kit generate --custom --name <name>` and write the SQL by hand.
4. Run the migration against a copy of a real database before you open the pull request.

## Work on a planned slice

Planned features are built as slices. Each one has a plan in [`docs/slices/`](docs/slices/README.md) with its scope, files, and proof. Every slice follows the same three steps: reproduce the gap and write failing tests, make the tests pass, then prove the change with verify-orbit and post the output.

## Branches and commits

- Name branches `<type>/<kebab-topic>`, such as `fix/palette-escape`. The type is one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, or `ci`.
- Write commit subjects in the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) style: `feat: add web search tool`.
- Keep a pull request to one change. A refactor that a feature needs can go first, in its own pull request.

## Pull requests

1. Open the pull request as a draft while you work.
2. Fill in the template. Say what changed for the user and how you checked it.
3. Post your proof as a comment: the commands you ran with their real output, and screenshots when something visible changed. Do not commit logs, screenshots, or reports.
4. Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for any change a user would notice.
5. Mark the pull request ready when the checks pass and every review comment is fixed or answered.

Pull requests are squash-merged, so the pull request title becomes the commit subject on `main`.

A workflow, `Pull request checks`, enforces the rules above. It fails when the title does not start with one of the branch types and a colon, when the branch is not named `<type>/<kebab-topic>`, with a topic of lowercase words joined by hyphens, and, once the pull request is ready, when the description lacks the template sections or a `feat`, `fix`, or `perf` change to shipped code leaves the text under `## [Unreleased]` in `CHANGELOG.md` unchanged. A draft only needs a good title and branch. Add the `skip-changelog` label when nothing changes for a user. Pull requests that a bot opens, such as Dependabot and ImgBot, are exempt. The author decides, not the branch name. `scripts/ci/pr-checks.sh` holds the rules, and `src/lib/pr-checks.test.ts` tests them.

Dependabot opens update pull requests every Monday for npm packages, GitHub Actions, the Dockerfile, and the Compose files. It groups the npm packages and the GitHub Actions updates. It waits seven days after a release before it proposes it. Review them like any other pull request. It cannot update the image digests in `src/lib/sandbox/images.ts` or the tool images pinned in the workflows, so update those by hand.

## Report a bug or ask for a feature

Open an issue with the bug or feature template. For a security problem, follow [SECURITY.md](SECURITY.md) instead.

## Code of conduct

Everyone who takes part in this project follows the [code of conduct](CODE_OF_CONDUCT.md).
