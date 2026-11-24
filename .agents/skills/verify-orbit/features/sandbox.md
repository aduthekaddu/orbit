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
node .agents/skills/verify-orbit/verify.mjs browse sandbox-output
node .agents/skills/verify-orbit/verify.mjs browse sandbox-unicode
node .agents/skills/verify-orbit/verify.mjs cleanup
```

`sandbox-stopped` saves the runner's stopped error through `upsertMessage` and checks Cancelled before and after reload. `sandbox-tool-error` saves a framework validation error and checks that its reason survives reload.

`sandbox-scroll` saves real Docker output near the output limit. Require bounded source, stdout, stderr, and error areas with their last lines reachable by scrolling. It checks keyboard access, horizontal scrolling, and page width on desktop and at 390 pixels.

`sandbox-output` runs Python through the chat tool and checks early stdout after a timeout, a memory kill, and reload.

`sandbox-unicode` checks incomplete UTF-8 at the output cap and requires the truncation marker to survive reload.

To check that fixture processes ignore a shell data-directory override, run:

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node scripts/qa/sandbox-fixture-isolation.mjs
node .agents/skills/verify-orbit/verify.mjs cleanup
```

Require all three scenarios to pass and leave the alternate directory untouched.

## Rejected tool input

The tool never runs for these calls, so Docker is not needed. Launch a fresh mock server.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-validation
node .agents/skills/verify-orbit/verify.mjs cleanup
```

`[qa:run-long]` repeats a 20,001 character program and `[qa:run-ruby]` repeats an unsupported language while the step offers `run_code`. The fifth and last step offers only `render_ui`, so the mock answers in text and the turn saves four rejected calls. Require every saved error to stay under 400 characters, name the reason, and leave out the program. The card must show the same reason before and after a reload. The check prints the saved error lengths and the message size.

## Configuration failure

Start a fresh server with the invalid Docker endpoint, then check the failed card and reload.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on DOCKER_HOST=tcp://not-the-local-proxy:2375 node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-failure
node .agents/skills/verify-orbit/verify.mjs cleanup
```

Require the failed card to identify the configuration error. Cleanup ensures this launch uses the requested endpoint.

## Stop keeps output

Launch a fresh mock sandbox. Docker must be reachable.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-stop-output
node .agents/skills/verify-orbit/verify.mjs cleanup
```

`[qa:run-timeout]` prints `before-timeout` and then loops. `[qa:run-spin]` prints nothing. The scenario waits two seconds and clicks Stop in Chrome, then types a draft in the composer before the saved result arrives. Require the live card, with no reload, to show Cancelled, a `Stopped` line with its duration, and the output printed before Stop. Require the draft, the messages on screen, and the branch to stay as they were, and no branch picker to appear. Require the saved part to be a completed result with `cancelled` set and the output printed before Stop, and require the reopened card to show the same header, result line, and output as the live card. The check also requires that no sandbox container remains.

The scenario then regenerates a stopped run and stops it again. Require the 2 / 2 picker, a `Stopped` line on the second card, and a `Stopped` line on both cards when Previous and Next switch between the versions.

Last, it clicks Regenerate the moment Stop lands, before the first card has its saved result, and stops the new run. Require Previous to show 1 / 2 with a `Stopped` line on the first card.

It also types a message while a `[qa:run-timeout]` run is going, clicks Stop, and sends the message at once. Require the stopped card to show Cancelled, a `Stopped` line, and `before-timeout`, not the error assistant-ui sets when a message is sent over an open tool call.

For these two steps the scenario holds the page's reads of the saved chat until just after the click, so the click always lands before the saved result. Require the card to have no `Stopped` line at the click and at least one held read.

## Copy buttons

Launch a fresh mock sandbox. Docker must be reachable.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-copy
node .agents/skills/verify-orbit/verify.mjs browse sandbox-copy-overlap
node .agents/skills/verify-orbit/verify.mjs cleanup
```

`[qa:run-copy]` prints indented text with accented letters, a check mark, and an emoji to standard output and standard error. The scenario clicks each copy button in Chrome and reads the clipboard. Require the clipboard to equal the saved text exactly, including indentation, line breaks, and Unicode. It also requires Enter and Space to copy, a confirmation after a copy, `Copy failed` when the clipboard rejects the write, and a 44 pixel touch area in a 390 pixel touch context.

`sandbox-copy-overlap` runs `[qa:run-wide]`, which prints a 153 character first line. After scrolling the well fully right, require the last three characters to clear the copy button. In a 390 pixel touch context, require a tap on the last character not to land on the button.

## Empty output

Launch a fresh mock sandbox. Docker must be reachable.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-empty-output
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario runs `[qa:run-pass]`, `[qa:run-python]`, `[qa:run-escape]`, `[qa:run-exit]`, `[qa:run-spin]`, and `[qa:run-blank]` in one chat. Their output is empty, stdout only, stderr only, empty with exit 3, empty with a timeout, and blank lines only. Require no empty output well on any card, a well and its label only for a channel with text, and the source, exit status, and duration on every card. A channel with only spaces or line breaks counts as empty. It runs the same checks on each card on desktop, after a reload, and at 390 pixels, and prints the card heights.

## Run outcome

Launch a fresh mock sandbox. Docker must be reachable.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-outcome
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario runs `[qa:run-pass]`, `[qa:run-exit]`, `[qa:run-exit-high]`, `[qa:run-spin]`, `[qa:run-oom]`, and `[qa:run-spin]` again with a click on Stop after two seconds. Require one outcome in each result line, worded `Exit 0`, `Exit 3`, `Exit 137`, `Timed out`, `Out of memory (exit 137)`, and `Stopped`. `[qa:run-exit-high]` is a program that exits 137 on its own, and it must not be called a memory kill. Each result line has exactly two parts, the outcome and a duration such as `174 ms` or `10.0 s`. The durations vary from run to run, so the scenario checks their shape and not their value. Require no `Exit killed`, no duration over 999 ms in raw milliseconds, and no `Failed`, `Succeeded`, or `Cancelled` in the result line. The header status must match, and the card must keep one status role after a reload. Right after Stop the live card shows Cancelled in its header, and the saved result line follows a moment later. The AI SDK drops the tool result on Stop, so the open chat asks the server for the saved reply. `sandbox-stop-output` checks the live result line, and this scenario checks the reloaded one. The check repeats at 390 pixels and prints the header and result line for every card.

## Language in the header

Launch a fresh mock sandbox. Docker must be reachable.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-language
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario runs `[qa:run-python]`, `[qa:run-js]`, `[qa:run-js-exit]`, `[qa:run-ruby]`, and `[qa:run-spin]` with a click on Stop. Require `Python` or `JavaScript` in the header of every card whose tool input was valid, while the run goes, after Stop, after a reload, and at 390 pixels. The Ruby call is rejected before it runs, and the mock repeats it while the step offers `run_code`, so require every one of its cards to show no language. Require the header to stay on one line with the tag inside it. Require the source and the output to sit on different surfaces. The check prints which part failed.

## Terminal escape sequences

Launch a fresh mock sandbox. Docker must be reachable.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-escapes
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario runs `[qa:run-color]`, `[qa:run-osc]`, `[qa:run-cut]`, and `[qa:run-html]`. The first prints red text to standard output and bold yellow text to standard error. The second prints a window title, a hyperlink, and an erase code. The third prints a color code that another escape interrupts, which must leave no stray digits. The fourth prints HTML-looking text. Require only the plain text in each well, no control character anywhere on the card, no link or image added to the card, and no page title set by the program. Require both copy buttons to copy the plain text, and require the same results after a reload and at 390 pixels. The HTML-looking text must show as text.

## Search the output

Launch a fresh mock sandbox. Docker must be reachable.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse sandbox-search
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario runs `[qa:run-token]`, `[qa:run-token-err]`, `[qa:run-token-echo]`, and `[qa:run-js-token]`. Each program builds its token from two strings, so the finished token is not in the program text. The first two print to standard output and standard error and the prompt and reply do not contain the token. The third prints a token that its reply repeats. Require each token to give exactly one search hit, in the right chat and on the assistant message that holds the run card. Require exactly one hit, on the right message, for a token that is only in the source of the first program and for one that is only in the source of the JavaScript program, which prints no token. Require the Ctrl+K palette to show a Messages result and open the message with its run card, and require the same hit after the chat is reopened and on a phone.

## Settings status

Run the check against a server with the sandbox on, then one with it off. Docker is not needed.

```sh
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=on node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse settings-sandbox
node .agents/skills/verify-orbit/verify.mjs cleanup
ORBIT_SANDBOX=off node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs browse settings-sandbox
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario reads the mode the server was launched with. Require `GET /api/settings` and the Settings page to agree with it, a read-only status under a Code sandbox heading, no key or Docker detail in the response, and no way to change the setting from the browser. It also checks the page at 390 pixels.

## Real provider

Launch with the sandbox enabled. Pass `ORBIT_BASE_URL`, `ORBIT_API_KEY`, and `ORBIT_MODEL` through the environment, then run `node .agents/skills/verify-orbit/verify.mjs browse sandbox-real`.

The scenario asks for the SHA-256 of a fresh `orbit-<UUID>` input. Require a completed `run_code` calculation whose source includes that input and does not contain the expected digest as a literal. Both stdout and the saved text answer must match the locally calculated hash. The screenshot waits for the full hash outside the code card. It writes `real-provider.png` and the check output under `.verify/evidence/sandbox-real/`. It never prints credentials.

## Production build

Run `node scripts/qa/sandbox-native-build.mjs`. It uses the optional SSH addon if present. Otherwise it creates a temporary asset at that path and removes it after the build. Require the build to pass. This checks native-asset bundling, not SSH cryptography.

## Isolation and timing

Run `node --import tsx --import ./scripts/test-data-dir.mjs --test src/lib/sandbox/run.test.ts`. It skips with a reason only if Docker is unreachable. A skipped run is not isolation proof. Require every escape case to run and no sandbox containers to remain.

Run `npx tsx scripts/qa/sandbox-timing.ts` with both images already pulled. It runs ten Python containers, validates each result, and reports p50 and p95 for start through result. The p95 budget is under 1,500 ms.

Finally, run `docker ps -a --filter label=orbit.sandbox`. It must list no containers.
