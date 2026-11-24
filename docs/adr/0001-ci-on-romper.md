Doc ID: orbit/adr-0001

# 0001. Run CI on romper with runner-up KVM places

Status: Superseded by [ADR 0003](0003-ci-on-github-hosted-runners.md) on 2026-11-22. The runbook `docs/ci-runners.md` and `scripts/ci-runner/` were deleted with it; they remain in git history.

## Context and problem

GitHub's included Actions minutes for this account ran out in November 2026, and the owner will not pay past an $18 cap, so jobs on GitHub's hosted runners cannot start. The owner's machine romper (16 cores, 16 GB, no swap) is also their workstation and runs production Orbit.

## Decision

Every job's runner comes from the repository variable `CI_RUNNER`: `runs-on: ${{ vars.CI_RUNNER || '<the hosted label>' }}`. With `CI_RUNNER=romper-linux`, jobs run on romper through [runner-up](https://github.com/kunchenguid/runner-up), one fresh KVM virtual machine per job. The virtual machines run as a separate user `ci`, behind the `ci_guard` firewall and a 9 GB memory cap. romper runs two places of 4 cores and 4 GB. The same pool serves every private repository of the account that adds itself (see "Add a repository" in the runbook, `docs/ci-runners.md`, now deleted).

## Alternatives and why rejected

- Pay for hosted minutes: the owner set an $18 cap.
- A plain self-hosted runner on romper: jobs would run on the owner's workstation and share state between jobs.
- runner-up Docker places: no Docker daemon inside the job, and orbit's CI needs Docker.

## Consequences

- No per-minute cost. GitHub's planned fee for self-hosted runner minutes is postponed, not cancelled.
- A CI run takes about 16 minutes on two places against about 5 on hosted runners.
- romper keeps about 8 GB for its owner while two jobs run.
- Pull requests from forks are refused. Docker Hub allows romper 100 anonymous pulls an hour.
- Upkeep: renew the token before it expires (first: 2026-12-14), update runner-up before 2026-12-28, and rebuild the image monthly. Rollback is deleting `CI_RUNNER`.

## Evidence

- Pull request [aduthekaddu/orbit#67](https://github.com/aduthekaddu/orbit/pull/67) and its proof comment.
- `docs/ci-runners.md` (deleted, in git history before ADR 0003) for the setup, the firewall and the risks that stayed open.
