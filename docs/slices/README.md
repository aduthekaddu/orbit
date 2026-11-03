# Slices

Orbit grows in slices. A slice is one pull request that ships one user-visible capability with its own proof. This page says how to build a slice. Each `NN.md` file is the plan for one slice.

| # | Slice | Branch | Status |
| --- | --- | --- | --- |
| 1 | [Walking skeleton](01.md) | `feat/walking-skeleton` | Shipped in #2 |
| 2 | [Generative UI](02.md) | `feat/generative-ui` | Shipped in #4 |
| 3 | [Chat polish](03.md) | `feat/chat-polish` | Shipped in #16 |
| 4 | [Branching](04.md) | `feat/branching` | Draft in #17 |
| 5 | [Artifact panel](05.md) | `feat/artifacts` | Draft in #18 |
| 6 | [Titles and history search](06.md) | `feat/history-search` | Draft in #19 |
| 7 | [Web search](07.md) | `feat/search` | Planned |
| 8 | [Code sandbox](08.md) | `feat/sandbox` | Planned |
| 9 | [GitHub](09.md) | `feat/github-mcp` | Planned |
| 10 | [Memory](10.md) | `feat/memory` | Planned |
| 11 | [Dreaming](11.md) | `feat/dreaming` | Planned |
| 12 | [Deploy](12.md) | `feat/deploy` | Planned |

The design system and inline editing shipped between slices, in #3 and #5.

## Order

Slice 3 comes first because it adds the browser drive to verify-orbit, and every later UI slice proves itself with that drive. Slices 4, 5, and 6 depend only on slice 3. Slice 7 adds the tool registry and the run card, so slices 8, 9, and 10 depend on it. Slice 11 depends on slice 10. Slice 12 can ship any time after slice 3, but it is last on purpose. The sandbox and GitHub tools should exist behind Cloudflare Access from the first day they are public.

## Build a slice in three turns

Every plan splits its work into the same three turns. One turn is one prompt to the implementing agent. Finish each turn's check before you start the next turn.

### Turn 1. Reproduce, then write failing tests

1. Branch from current `main` with the branch name in the plan.
2. Reproduce the gap on a running server, as the plan's **Reproduce** list says. For a bug, show the wrong behavior. For a feature, show that it is missing. Save the output or the screenshot.
3. Write the tests the plan names. Assert what a user or caller sees, not how the code does it.
4. Run the tests. They must fail, and the failure message must match the reason the plan gives. A test that fails for a different reason is not done.
5. Commit with a `test:` message, push, and open a draft pull request. Post the reproduction and the failing test output as the first PR comment.

### Turn 2. Make the tests pass

1. Make the smallest change that turns the new tests green.
2. Run `npm test`, `npm run typecheck`, and `npm run build`. All three exit 0.
3. Commit with a `feat:` or `fix:` message and push.

### Turn 3. Prove it with verify-orbit

1. Add the drive or browse scenario the plan names to [verify-orbit](../../.agents/skills/verify-orbit/SKILL.md). Document it in that skill's `features/` folder.
2. Run `launch`, `doctor`, the new drive, and `cleanup`.
3. Post the real terminal output as a PR comment. Paste it unedited. Redact only secrets. Attach every screenshot the plan lists. If your tools cannot upload images, list each file path and say that you did not upload it.
4. Add the change under `## [Unreleased]` in [CHANGELOG.md](../../CHANGELOG.md). Set the slice to **Shipped** in the table above and in [the roadmap](../roadmap.md).
5. Mark the PR ready with `gh pr ready`.

Proof lives in the PR thread, never in the repo. Do not commit logs, screenshots, or QA reports. `.verify/` is gitignored for this reason.

## What counts as proof

- The command you ran and its real output, from a server that this run started.
- For UI, a screenshot of the state after the action, with the action named. A final screen with no action before it proves nothing.
- For a fix, the same check failing before the change and passing after it.
- A unit test passing is necessary and never enough. Each plan's **Proof** section names the live check that must pass too.

## Providers in proofs

Use the mock provider in `scripts/qa/mock-provider.mjs` for any check that must be repeatable. It picks a scenario from a `[qa:<name>]` tag in the user message. Use a real provider once per slice for the main path. Pass the key through the environment as `ORBIT_API_KEY` and never print it.

## Plan layout

Each plan uses these sections, in this order:

1. **Why.** The user problem and who has it.
2. **Scope.** What ships and what does not.
3. **Design.** The data shape first, then the flow, then the boundaries.
4. **Files.** What to create, what to edit, and what to leave alone.
5. **Rules.** What to do and what to avoid.
6. **Build.** Turn 1, turn 2, and turn 3, with the slice's own steps.
7. **Done when.** The acceptance list.
8. **Proof.** The output and screenshots the PR must carry.
