---
name: verify-chat-turn
description: Model-check how Orbit writes chat messages, with TLC on the TLA+ models in docs/architecture. Use when a change touches POST /api/chat, beginTurn, planChatWrite, persistIncoming, finishChatReply, insertMessage, savedText, unchanged, updateMessageText, messageRepository, assistantHasVisiblePart, settleInterruptedParts, isPath or replaceTextParts, when src/lib/model-sync.test.ts fails, or to check a new order of sends, regenerates, edits and stops across tabs.
---

# Verify the chat turn

TLC, the TLA+ model checker, tries every order of the steps in a model, within small bounds, and reports the shortest path to any state that breaks a rule. Two models describe the chat write path:

- `docs/architecture/ChatTurn.tla`: one tab sends, regenerates, retries, stops, or meets a provider failure. Its four rules are in `ARCHITECTURE.md` under "The rules of a turn". Bound: three reply attempts per prompt.
- `docs/architecture/ChatWrite.tla`: two tabs share a prompt P and its reply R, which may be unsaved at the start. Bound: two tabs, three versions of each text.
  - `ReplyKeepsNewestText`: a saved reply keeps the last text written to it. If this breaks, an edit made in one tab is undone when a stale tab sends, or when a request that continues the reply ends.
  - `ReplyAnswersItsPrompt`: every reply saved under a prompt answers the prompt's current text. If this breaks, an answer appears under a prompt it did not answer.

At this repo's code, `ReplyAnswersItsPrompt` holds because no writer changes a prompt row: an edit is a new sibling. The prompt row compare in `finishChatReply`, with the copy in the `ReplyPlan`, is a second layer. `ChatWrite.in-place-edit.cfg` checks that layer alone.

## What each step assumes

Each action is one step that no other step can split. Three actions join a server effect with a later one:

- `ChatWrite.Plan` joins `beginTurn` with the `storedAssistantParts` call in `POST` that reads the saved reply a request continues. `beginTurn` creates the chat row for a first prompt and runs `planChatWrite` in one transaction. `planChatWrite` checks P and copies P and R. No `await` separates `beginTurn` from `storedAssistantParts`, so in one Node process no other request runs between them. Orbit runs one server process on one SQLite file, in one container. With two processes another request could edit R between the two calls. The stream would then continue the edited R, and `finishChatReply` would refuse the reply because R no longer matches its copy. If a change adds an `await` between the calls, or Orbit runs more than one server process, split `Plan`.
- `ChatWrite.Load` joins the server's read of the rows with the browser showing them. The tab cannot send or edit until it shows them, and no other action reads its copy. A split version found nothing new in any config.
- `ChatTurn` joins each write with the status the browser shows, though provider setup, `stopped.apply` and tool cleanup are awaited around the write.

`ChatWrite.EditReply` is split: the `PATCH` writes the row, and `ShowReplyEdit` puts the text in the tab's thread after the awaited response (`src/components/chat/use-save-message.ts`). Between the two the tab still holds the old text.

## What the models leave out

These past bugs and gaps are outside both models. A pass says nothing about them:

- A reply attached to the wrong prompt when two sends interleave (61637b7).
- Rejection of a request built on replaced or stale history (f3da71c, c435e64). The models check the text of P, not the shape of the path.
- A retry blocked by an unsaved assistant message in the history (889e201).
- A Send or Regenerate right after Stop, before the stopped run's output arrives (8f9a580, 9d72c39).
- The selected head: an off-branch search hit becomes the head even when it has later turns (`src/lib/chat-tree.ts` `focusedHead`, fixed by open PR #171).
- Tool calls, the new prompt's own turn after `Send`, and which reply text a regenerate wrote.

The `ChatTurn` rules can miss some wrong behavior even where they apply. Only `ShownTextKept` has a mutant (`ChatTurn.stopped-retry.cfg`). `NothingSavedWithoutText` misses an invisible insert while `stored` stays `full`. `RegenerateKeepsOldReply` passes when a regenerate adds no sibling, and tracks no text. `StoppedSendKeepsText` and `ShownTextKept` check a status, so they miss truncated text and a wrong head after reload. `ChatTurnRegression` checks the count after one finished regenerate.

## Know what the check covers

Each model action has one `\* code: <path> <function>` line per function it describes. `src/lib/model-sync.test.ts`, part of `npm test`, hashes each named function and compares the hash with `docs/architecture/model-sync.json`. The hashed text runs from the function's top-level `function <name>(` line to the next line that is a lone `}`. Before hashing, the test drops `//` and `/* */` comments, all whitespace, and a comma right before `)`, `]` or `}`, outside string and template literals. It keeps one space between two word characters. A reformat or a comment edit keeps the hash. Any other edit, a type annotation included, changes it. `git log -1 -- docs/architecture/model-sync.json` gives the last commit at which someone confirmed that the models describe those functions.

The hash cannot see a change outside the named functions. Read the actions that depend on these yourself when your change touches them:

- `pathTo` and `focusedHead` in `src/lib/chat-tree.ts`, and `storedMessages`, `searchTextFromParts` and `textFromParts` in `src/lib/messages.ts`.
- `replaceTextPart` in `src/lib/chat-parts.ts`, used when a reply edit names one part.
- Stopped-run handling: `createStoppedRuns` and `stopped.apply` in `src/lib/tools/stopped-runs.ts`, and `src/components/chat/stopped-run-sync.tsx`.
- `bodySchema` and `messageSchema` in `src/app/api/chat/route.ts`, `CHAT_STEP_LIMIT` in `src/lib/tools/answer-step.ts`, and other module constants and types.
- The SQL schema in `src/lib/db/schema.ts` and the migrations in `drizzle/`.
- The AI SDK and assistant-ui under `node_modules`, and the browser code under `src/components/chat/`.

## Run the check

```sh
scripts/ci/tlc.sh
```

The script prints one line per config and exits 1 on any failure. It downloads the pinned `tla2tools.jar`, checks its SHA-256, and runs Java from a pinned Docker image when `java` is not installed. A full run takes about ten seconds. CI runs it in the `checks` job.

A config named `NAME.cfg` or `NAME.<label>.cfg` checks `NAME.tla`. The script fails on a `.tla` file that no config checks. Every config has exactly one `\* Expect:` line, and the script fails a config without one:

- `\* Expect: pass`: TLC must exit 0. The config must list as an `INVARIANT` every definition without parameters that `NAME.tla` makes below the definition of the config's `NEXT` operator. Put a helper that is not a rule above `Next`.
- `\* Expect: fails`: a mutant that switches off one guard to replay a past bug. TLC must exit 12, its invariant-violation status, and its counterexample must match `NAME.<label>.trace` state by state. The script prints a diff when it does not. Each mutant names the test that replays its trace against the real code.

Read every TLC result with the pstack `/statechart` skill, pass or fail, on the same model and config. Give it `docs/architecture/chat-turn.view.mjs` for `ChatTurn` and `docs/architecture/chat-write.view.mjs` for `ChatWrite`. It tells a broken rule as its shortest path in plain words, and it charts a passing model.

## Tell a real bug from a modeling error

1. Write the failing trace as one call per action against the code: the `code:` lines name the call. Use the tests in `src/lib/chat-write.test.ts` as the pattern.
2. If the code refuses the step that broke the rule, the model is wrong. Find the action whose effect differs from the function it names, fix the action, and run the check again.
3. If the code does what the trace says, it is a real bug. Report it with the trace in the code's words. Keep the rule as it is, and change product code only when you were asked to.

## Update the models for an intended change

1. For each function that `model-sync.test.ts` reports, read the new code and every action whose `code:` line names it. Check the list under "What each step assumes" too.
2. Change those actions so each does what its functions now do. Keep one `code:` line per function beside each action. A new step gets a new action.
3. Run `scripts/ci/tlc.sh` and read the results with `/statechart`. Each `pass` config must pass. Each mutant must still fail on its past bug. When a model change alters a mutant's counterexample, run `scripts/ci/tlc.sh --update-traces`, read the `git diff` of the `.trace` files with `/statechart`, and commit the new trace only when it still tells that bug.
4. Put the new hash of each changed function in `docs/architecture/model-sync.json`. The test's message prints it.
5. For a new model, add a `pass` config, `code:` lines, a mutant with its `.trace` for each rule, and a replay test for each mutant.
