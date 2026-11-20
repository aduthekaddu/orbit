Doc ID: orbit/adr-0003

# 0003. Run CI on Freestyle VMs when GitHub's allowance runs out

Status: Proposed

## Context and problem

[ADR 0001](0001-ci-on-romper.md) moved Orbit's CI to romper after GitHub's included Actions minutes ran out. romper is also the owner's workstation and runs production Orbit, so every CI round loads the machine the owner works on. On 2026-11-19 a burst of CI and local tests nearly crashed it. The owner wants CI off romper when the GitHub allowance is used up, and still will not pay past the $18 cap.

## Decision

When GitHub's allowance is used up, Orbit's CI runs on Freestyle VMs through [freestyle-runners](https://github.com/aduthekaddu/freestyle-runners), a systemd user service on romper. The owner sets `CI_RUNNER=freestyle-linux`, and the service starts one fresh Freestyle VM with 4 vCPU and 8 GiB for each queued job with that label. The VM runs that one job and is deleted afterwards. The order of use is GitHub's runners, then Freestyle, then romper.

The service keeps its own estimate of Freestyle usage. At 85% of the free plan it stops creating VMs, sets Orbit's `CI_RUNNER` back to `romper-linux`, and opens a `budget-limit` issue in aduthekaddu/freestyle-runners. After the allowance resets, it sets `CI_RUNNER` to `freestyle-linux` again.

This decision adds to ADR 0001 and does not replace it. romper stays the fallback, and its setup does not change. [The runbook](../ci-runners.md#freestyle-overflow) has the commands.

## Alternatives and why rejected

- Daytona. Its free tier restricts network egress, and it gives containers by default rather than VMs. Orbit's CI needs Docker.
- Blacksmith. It serves organizations only, and aduthekaddu is a personal account.
- A Freestyle provider in runner-up. It is out of runner-up's scope.
- Pay for hosted minutes. The owner set an $18 cap, as in ADR 0001.

## Consequences

- The free plan covers about 35 rounds a month before the 85% switch, at the cost measured on 2026-11-20 (4.8 vCPU-hours a round, 41 rounds to the full 200). If downloads ran at the speed of 2026-11-19, it would cover about 58 rounds. That is an estimate from one round. After the switch, CI runs on romper until the allowance resets on the 13th at 00:16 IST (18:46 UTC on the 12th).
- A round took 12 minutes (713 s) on Freestyle on 2026-11-20, against 28 minutes (1,657 s) on romper. The first round, on 2026-11-19, took 40 minutes because VM creation was slow. [freestyle-runners#12](https://github.com/aduthekaddu/freestyle-runners/issues/12) and [freestyle-runners#13](https://github.com/aduthekaddu/freestyle-runners/issues/13) tracked the causes, and [freestyle-runners#15](https://github.com/aduthekaddu/freestyle-runners/pull/15) fixed them.
- romper runs only the service. During the proof round the service used 5.7 s of CPU in 65 minutes.
- Jobs run on Freestyle's machines, so a job's checkout and its short-lived `GITHUB_TOKEN` reach a third party, as they do on GitHub's hosted runners.
- Freestyle's API reports no usage, so the 85% switch acts on the service's estimate.
- Switching to Freestyle is a manual step. Only the switch to romper at 85% and the switch back after the reset are automatic.

## Evidence

- The [proof comment](https://github.com/aduthekaddu/orbit/pull/94#issuecomment-7021145263) on pull request 94 records the first full round of 14 jobs on Freestyle, with its cost, its timing, and romper's load. The [second round](https://github.com/aduthekaddu/freestyle-runners/pull/15#issuecomment-7031596476), on a throwaway pull request 96 after the fixes in freestyle-runners#15, is measured there. The proof's workflows named `freestyle-linux` directly and left `CI_RUNNER` at `romper-linux`, so the variable switch itself was not part of it.
- [aduthekaddu/freestyle-runners#3](https://github.com/aduthekaddu/freestyle-runners/pull/3) builds the VM image and runs one job. [aduthekaddu/freestyle-runners#6](https://github.com/aduthekaddu/freestyle-runners/pull/6) adds the service.
- The [freestyle-runners design](https://github.com/aduthekaddu/freestyle-runners/blob/main/docs/design.md), with the free plan's limits and the budget rules.
- The [Notion decision](https://app.notion.com/p/41d52153fdc981fca60ffd45d6a4a616), status Proposed.
- [docs/ci-runners.md](../ci-runners.md#freestyle-overflow) for the commands and the numbers.
