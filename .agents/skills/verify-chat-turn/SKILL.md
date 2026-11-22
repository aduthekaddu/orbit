---
name: verify-chat-turn
description: Model-check how Orbit writes chat messages, with TLC on the TLA+ models in docs/architecture. Use when a change touches POST /api/chat, planChatWrite, persistIncoming, replyGuard, upsertMessage, shouldSaveReply, updateMessageText, messageRepository or assistantHasVisiblePart, when src/lib/model-sync.test.ts fails, or to check a new order of sends, regenerates, edits and stops across tabs.
---

# Verify the chat turn

TLC, the TLA+ model checker, tries every order of the steps in a model, within small bounds, and reports the shortest path to any state that breaks a rule. Two models describe the chat write path:

- `docs/architecture/ChatTurn.tla`: one tab sends, regenerates, retries, stops, or meets a provider failure. Its four rules are in `ARCHITECTURE.md` under "The rules of a turn". Bound: three reply attempts per prompt.
- `docs/architecture/ChatWrite.tla`: two tabs share a prompt P and its saved reply R. Bound: two tabs, three versions of each text.
  - `ReplyKeepsNewestText`: a saved reply keeps the last text written to it. If this breaks, an edit made in one tab is undone when a stale tab sends.
  - `ReplyAnswersItsPrompt`: every reply saved under a prompt answers the prompt's current text. If this breaks, an answer appears under a prompt it did not answer.

At this repo's code, `ReplyAnswersItsPrompt` holds because no writer changes a prompt row: an edit is a new sibling. The prompt row compare in `upsertMessage`, with the copy `replyGuard` reads, is a second layer. `ChatWrite.in-place-edit.cfg` checks that layer alone.

## Know what the check covers

Each model action has one `\* code: <path> <function>` line per function it describes. `src/lib/model-sync.test.ts`, part of `npm test`, hashes each named function and compares the hash with `docs/architecture/model-sync.json`. The hashed text runs from the function's top-level `function <name>(` line to the next line that is a lone `}`. `syncCommit` in that file is the last commit at which someone confirmed that the models describe those functions.

The hash leaves out the helpers those functions call (`isPath`, `pathTo`, `storedMessages`, `searchTextFromParts`, `settleInterruptedParts`, `createStoppedRuns`), types, module constants, the schema, the AI SDK, and the browser code. If your change touches one of those, read the actions that depend on it yourself. One AI SDK fact matters here: when a request's last message is an assistant message, the reply reuses that message's id, so `upsertMessage` updates the row in place. Neither model covers that path.

`Plan` in `ChatWrite.tla` treats `planChatWrite` and `replyGuard` as one step, because no `await` separates them in `POST`. If a change adds an `await` between them, split `Plan` into two actions. `ChatWrite.in-place-edit.cfg` then shows the gap between them.

## Run the check

```sh
scripts/ci/tlc.sh
```

The script prints one line per config and exits 1 on any failure. It downloads the pinned `tla2tools.jar`, checks its SHA-256, and runs Java from a pinned Docker image when `java` is not installed. A full run takes about six seconds. CI runs it in the `checks` job.

A config named `NAME.cfg` or `NAME.<label>.cfg` checks `NAME.tla`. The script fails on a `.tla` file that no config checks. A config with an `\* Expect: <Rule> fails after <Action>, ...` line is a mutant: it switches off one guard and passes only when TLC breaks that rule on exactly that trace. Each mutant names the test in `src/lib/chat-write.test.ts` that replays its trace against real SQLite.

Read every TLC result with the pstack `/statechart` skill, pass or fail, on the same model and config. Give it `docs/architecture/chat-turn.view.mjs` for `ChatTurn` and `docs/architecture/chat-write.view.mjs` for `ChatWrite`. It tells a broken rule as its shortest path in plain words, and it charts a passing model.

## Tell a real bug from a modeling error

1. Write the failing trace as one call per action against the code: the `code:` lines name the call. Use the tests in `src/lib/chat-write.test.ts` as the pattern.
2. If the code refuses the step that broke the rule, the model is wrong. Find the action whose effect differs from the function it names, fix the action, and run the check again.
3. If the code does what the trace says, it is a real bug. Report it with the trace in the code's words. Keep the rule as it is, and change product code only when you were asked to.

## Update the models for an intended change

1. For each function that `model-sync.test.ts` reports, read the new code and every action whose `code:` line names it.
2. Change those actions so each does what its functions now do. Keep one `code:` line per function beside each action. A new step gets a new action.
3. Run `scripts/ci/tlc.sh` and read the results with `/statechart`. The configs without an `Expect` line must pass. Each mutant must still fail on its past bug. Change an `Expect` line only when `/statechart` shows that the new trace is still that bug.
4. Put the new hash of each changed function in `docs/architecture/model-sync.json`. The test's message prints it. Then set `syncCommit` to the commit whose code you checked.
5. For a new model, add a config, `code:` lines, a mutant for each rule, and a replay test for each mutant.
