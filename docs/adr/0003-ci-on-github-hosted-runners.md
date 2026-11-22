Doc ID: orbit/adr-0003

# 0003. Run CI on GitHub-hosted runners with a fixed label

Status: Accepted (by the owner, 2026-11-22)

## Context and problem

[ADR 0001](0001-ci-on-romper.md) moved CI to the owner's machine romper because the account had no hosted Actions minutes left while the repository was private. Every job read its runner from the repository variable `CI_RUNNER`.

The repository is now public, and GitHub does not bill standard hosted runners on public repositories. The variable also caused failures of its own. GitHub reads it when it queues a run, so a run queued under an old value waits for a runner that is not there. That happened on 2026-11-20 and again on 2026-11-22, when 32 runs had to be started again.

## Decision

Every job names one fixed GitHub-hosted label: `runs-on: ubuntu-24.04`. No workflow reads a variable, a matrix value or a self-hosted label for its runner. `src/lib/fixed-runners.test.ts` parses every workflow file and fails a job whose `runs-on` is anything else, and a job that calls a reusable workflow outside this repository. It runs in the unit suite, which `main` requires.

The romper runbook `docs/ci-runners.md`, the files in `scripts/ci-runner/`, and `scripts/ci/install-gh.sh` are deleted. Hosted images ship `gh`.

## Alternatives and why rejected

- Keep `CI_RUNNER` with the hosted label as its value: the variable would still be a second place to get the runner wrong, with no use left.
- Keep the romper files for a later return: they would go stale unrun. They stay in git history.

## Consequences

- A run takes about 5 minutes on hosted runners against about 16 on romper (figures from ADR 0001).
- Pull requests from forks can run CI again.
- No token to renew, no runner-up to update, and no guest image to rebuild.
- If the repository goes private again, hosted runs draw on the plan's included minutes again and this decision needs another look.
- The repository variable `CI_RUNNER` is now unread. The services on romper (`runner-up`, `ci-guard`) are outside the repository and may still serve other repositories, so this decision does not touch them.

## Evidence

- The owner's instruction on 2026-11-22: the repository is public, use GitHub's runners and remove `vars.CI_RUNNER`.
- `src/lib/fixed-runners.test.ts` feeds the check the old `runs-on` line, self-hosted labels in several YAML forms and an outside reusable workflow, and each fails.
