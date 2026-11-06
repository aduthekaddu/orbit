# Code sandbox

This recipe runs real containers through the mock provider in Chrome. Docker must be reachable, and both digests in `src/lib/sandbox/images.ts` must already be pulled. Pull commands are in [README](../../../../README.md#enable-the-code-sandbox).

## Run

After `npm run build`, run these commands from the repo root.

```sh
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse sandbox
node .agents/skills/verify-orbit/verify.mjs cleanup
```

For the launch-mode check, run:

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=off node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse launch-mode
node .agents/skills/verify-orbit/verify.mjs cleanup
```

Require every printed check to pass. `[qa:run-python]` must create a code card with `print(1+1)`, stdout `2`, exit code `0`, and a duration. The code and output must survive reload. The card must fit a 390 by 844 viewport. `[qa:run-escape]` must show a failed card with a network error.

Screenshots and output remain under `.verify/evidence/sandbox/` after cleanup. The screenshots are `python.png`, `escape.png`, and `mobile.png`.

## Saved cards and scrolling

Launch a fresh mock sandbox for these checks.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-stopped
node .agents/skills/verify-orbit/verify.mjs browse sandbox-tool-error
node .agents/skills/verify-orbit/verify.mjs browse sandbox-scroll
node .agents/skills/verify-orbit/verify.mjs cleanup
```

`sandbox-stopped` saves the runner's stopped error through `upsertMessage` and checks Cancelled before and after reload. `sandbox-tool-error` saves a framework validation error and checks that its reason survives reload.

`sandbox-scroll` saves real Docker output near the output limit. Require bounded source, stdout, stderr, and error areas with their last lines reachable by scrolling. It checks keyboard access, horizontal scrolling, and page width on desktop and at 390 pixels.

## Configuration failure

`browse sandbox-failure` checks a configuration failure and reload. Launch its server with `ORBIT_SANDBOX=on DOCKER_HOST=tcp://not-the-local-proxy:2375` and `launch --mock`. Require the failed card to identify the configuration error.

## Real provider

Launch with the sandbox enabled. Pass `ORBIT_BASE_URL`, `ORBIT_API_KEY`, and `ORBIT_MODEL` through the environment, then run `node .agents/skills/verify-orbit/verify.mjs browse sandbox-real`.

The scenario asks for the SHA-256 of a fresh `orbit-<UUID>` input. Require a completed `run_code` calculation whose source includes that input and does not contain the expected digest as a literal. Both stdout and the saved text answer must match the locally calculated hash. The screenshot waits for the full hash outside the code card. It writes `real-provider.png` and the check output under `.verify/evidence/sandbox-real/`. It never prints credentials.

## Isolation and timing

Run `node --import tsx --test src/lib/sandbox/run.test.ts`. It skips with a reason only if Docker is unreachable. A skipped run is not isolation proof. Require every escape case to run and no sandbox containers to remain.

Run `npx tsx scripts/qa/sandbox-timing.ts` with both images already pulled. It runs ten Python containers, validates each result, and reports p50 and p95 for start through result. The p95 budget is under 1,500 ms.

Finally, run `docker ps -a --filter label=orbit.sandbox`. It must list no containers.
