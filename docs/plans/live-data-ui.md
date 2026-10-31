# Live data in the UI

A plan for slice 3 to slice 6, after generative UI. No code here. The goal is one set of live-data components that the model can render through json-render and the app can render from tool parts, with the same shapes and the same visual rules.

## What this pass adds

- A tool run card that streams state, input, and output into the thread.
- A search results card that fills while the search runs.
- A sandbox run card with live stdout, stderr, duration, and exit code.
- A memory page and memory hit chips in the thread.
- One status model and one set of empty, loading, partial, failed, and cancelled states for all four.

## Design constraints

From `docs/DESIGN.md`.

- Cards sit on the chat column at `max-w-widget`: `bg-card`, `border`, `shadow-card`, `rounded-lg`.
- `OrbitMark` is the only loading indicator. Pass `busy` while a run is live. Pair it with a text label when screen readers need the state.
- Violet appears once per card at most, on the primary action or the active status.
- Numbers use tabular figures. Code and output use Geist Mono. Sentence case labels.
- Motion is 150 to 250ms with `ease-orbit`. New rows may use `animate-rise`. No bouncing.
- Loading placeholders use `Skeleton` in the shape of the content they replace. No layout shift when real content arrives.
- A card never widens the page. Long output scrolls inside the card.

## One status model

Every live artifact has a run with the same states. Tool parts, json-render cards, and the memory page read this shape.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `toolCallId` for tool runs, job id for sandbox, query id for search |
| `kind` | `"tool" \| "search" \| "sandbox" \| "memory"` | Picks the renderer |
| `name` | string | Display name, for example `web_search` |
| `status` | `"queued" \| "running" \| "succeeded" \| "failed" \| "cancelled"` | The only status enum |
| `startedAt` | number | Milliseconds |
| `endedAt` | number? | Absent while live |
| `summary` | string? | One line, for the collapsed state |
| `error` | string? | User-facing text, already sanitized by the server |
| `artifact` | unknown | The typed payload for the card |

Mapping from assistant-ui tool part states to this model:

| Tool part state | Run status |
| --- | --- |
| `input-streaming` | `running` |
| `input-available` | `running` |
| `output-available` | `succeeded` |
| `output-error` | `failed` |
| cancelled by the user | `cancelled` |

The client derives the run from the tool part. The server does not send a second copy of the status. Stores in `parts` already survive reload, so a finished run survives reload with no schema change.

## Transport

Use AI SDK data parts for progress that is not a tool result yet.

- `data-tool-status`: `{ id, status, summary }`, replaces the row with the same id.
- `data-search-results`: `{ id, results, done }`, replaces the whole result set. Send partial sets, not deltas, so a dropped chunk cannot leave a wrong list.
- `data-sandbox-output`: `{ id, stream: "stdout" \| "stderr", text, done }`. The client appends text and caps the buffer.
- `data-memory-hits`: `{ id, hits, done }`.

The server coalesces updates to one event per 60ms. The client keeps the last event per id and renders from that. A run that ends while the browser is closed is read back from the stored tool part on reload.

## Components

Shared pieces:

- `RunShell`: the card frame, header, status dot, elapsed time, collapse, and cancel or retry slot.
- `RunHeader`: name, status label, one line summary.
- `RunFooter`: duration, copy, open in new view.
- `RunError`: the existing destructive banner treatment, inside the card.

Per kind:

**Tool run.** A compact row, not a card, when the tool returns a short value. Expands in place to show input and output. A JSON view is a `pre` with the existing syntax theme. Unknown tools use the generic row and never crash. No raw tool names in the thread; map them through a registry.

**Search.** A card with the query as its header, then result rows. Each row has the domain, title, snippet, and a link. Rows appear as results arrive; a skeleton row holds the space for the first three. Dedupe by URL. Show 5 rows, then "Show all" opens a dialog with the full list. A source chip in the answer text links to the matching row. No favicon fetch from a third party; render the domain initial in a bordered square.

**Sandbox.** A card with a terminal well (`bg-canvas`, mono, `text-xs`), line numbers optional, and a bottom bar with exit code, duration, and Cancel while running. Follow the tail while live, stop following when the reader scrolls up, and show a "Jump to end" control. Cap at 2,000 lines in the DOM and keep the full output behind "Download". stderr uses `--negative` at 80 percent, not full saturation. A run with no output shows an empty well with a quiet label.

**Memory.** A `/memory` page in the app shell, same width as settings. A list of entries with kind, source chat, last used, and a score when searching. Filters are a pill row. Edit opens an inline textarea with Save and Cancel. Delete asks once in a dialog. Each row can open the source message. In the thread, memory hits render as a compact tool run with the top three chips and "Show all". A nightly consolidation job gets one status card at the top of the memory page.

## json-render

The catalog gains four components that take the same run shape:

| Component | Props |
| --- | --- |
| `toolStatus` | `run` |
| `searchResults` | `run`, `results`, `query` |
| `sandboxRun` | `run`, `output`, `exitCode` |
| `memoryHits` | `run`, `hits` |

Rules:

- The model may render these components through `render_ui`, but the app renders them from tool parts too. Both paths use the same React components.
- Every prop schema is strict and validated with zod at the boundary. A missing prop renders the generic fallback, not a crash.
- Unknown component names and invalid specs render `RunShell` with the error state and the raw JSON behind a disclosure. The thread keeps working.
- The model never supplies colors, sizes, or class names. The catalog owns presentation.
- Streaming specs are validated on each chunk only for the fields already present. A half-written spec renders skeletons, not errors.
- One `max-w-widget` cap applies to every widget, including inside dialogs.

## States per card

| State | What the reader sees |
| --- | --- |
| queued | header with a muted dot, no body |
| running | OrbitMark in the header, skeleton body sized to the expected content |
| succeeded | full body, duration, copy |
| failed | destructive banner with the sanitized message, retry when the tool allows it |
| cancelled | partial body, muted "Stopped" label, no retry |
| empty result | a short line in the body, not a full empty state |

## Accessibility

- The card header is a button with `aria-expanded` when it collapses.
- Status changes are announced once through a polite live region at the thread level. Streamed tokens and output lines are not announced.
- Cancel and retry are reachable by keyboard. Focus stays on the control that was pressed.
- Output regions use `aria-label`, for example "Sandbox output".
- `prefers-reduced-motion` removes the shimmer and the OrbitMark satellite, as it does now.

## Performance

- Reserve the body height with a skeleton before the first item arrives.
- Coalesce updates on the server to 60ms. Coalesce scroll writes in the client with `requestAnimationFrame`.
- Cap search rows at 50 in the dialog, sandbox lines at 2,000, memory rows at 50 per page.
- Virtualize the memory list above 100 rows.
- Do not re-render markdown when only a tool status changes. Keep tool state in its own part component.

## Order of work

1. **Run shell and tool status.** Tool part mapping, registry, generic fallback, header live region, cancel. Ships the shared components the rest use.
2. **Search.** SearXNG and Tavily in one adapter behind the tool name, partial result data part, the results card, source chips. Needs slice 3.
3. **Sandbox.** `dockerode` adapter, stdout and stderr data parts, terminal card, cancel, stored exit code. Needs slice 4.
4. **Memory.** FTS5 and `sqlite-vec`, memory page, hit chips, nightly job card. Needs slice 6.

Each step ends with a mock provider that emits the new parts, a real call, a reload check, a mobile check at 390x844, and screenshots under `docs/qa/screenshots/live-*`.

## Acceptance

- A tool run streams from running to succeeded without the thread jumping.
- Search rows appear before the run ends and a reload shows the same list.
- Sandbox output follows the tail while live and stops following when the reader scrolls up.
- A cancelled sandbox run keeps its partial output and shows "Stopped".
- A missing or invalid widget spec renders a fallback card, and the thread still accepts the next message.
- The memory page lists, filters, edits, and deletes entries, and a deleted entry disappears from the thread chips after reload.
- Every card fits at 390px with no horizontal page scroll.
- `npm run typecheck` and `npm run build` pass.

## Out of scope

- Editing tool output by hand. The inline editing pass covers message text and code, not run artifacts.
- Replaying a sandbox run from history.
- Multi-user sharing or permissions.
- Live collaboration.
- A second loading indicator.
