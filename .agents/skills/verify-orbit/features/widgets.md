# Widgets and tool lines

This recipe checks how a `render_ui` reply and finished tool calls look in Chrome, at 1440 by 900, at 390 and 360 wide with touch, and once in the light theme. It uses the local model fixture and the local SearXNG fixture. It calls no provider and no search engine.

## Run

1. `node .agents/skills/verify-orbit/verify.mjs launch --mock`
2. `node .agents/skills/verify-orbit/verify.mjs doctor`
3. `node .agents/skills/verify-orbit/verify.mjs browse widgets`
4. `node .agents/skills/verify-orbit/verify.mjs browse tool-cards`
5. `node .agents/skills/verify-orbit/verify.mjs cleanup`

On macOS, run these inside the Linux Playwright image, because verify-orbit reads `/proc` (#257).

## `browse widgets`

- `[qa:all]` renders inside `[data-tool-name="render_ui"]` with no "Generated UI" or "Succeeded" text, on one `[data-genui]` surface. No element inside the surface has a solid border on all four sides. `42,000` shows with tabular figures. The editable text has a dashed border at rest and a solid one on focus. **Save note** shows a focus ring after Tab.
- `[qa:tones]` shows each callout's left rule in `--info`, `--warning`, or `--positive`. A rise shows an up arrow in the positive color. A drop of 8% with `changeTone: "positive"` is positive. `2026` has no comma.
- `[qa:huge]` opens at 12 rows, under 900px tall at 390 wide, with a fade on the right edge. Number cells align right. **Show all 220 rows** shows 220 rows, and **Show fewer** returns to 12.
- `[qa:invalid]` shows one line, "Could not show this view", and no JSON until **Details** opens.
- `[qa:long]` leaves no page-level sideways scroll at 360 wide.
- After a reload, the `[qa:all]`, `[qa:tones]`, and `[qa:huge]` checks still hold.
- The run prints `MEASURE` lines: the huge widget's height, the depth of nested border boxes, the share of text under 13px on the error screen, and the number of text colors in the widget.

## `browse tool-cards`

- `[qa:search] orbit` reads "Searching the web", then "Searched the web, 3 sources", closed, with three tiles in at least two colors. Opening the line shows three links with `target="_blank"` and `rel="noopener noreferrer nofollow"`.
- `[qa:remember] I deploy to Fly.io` reads "Saved to memory" with the saved text. No visible text says `remember`.
- With the SearXNG fixture stopped, `[qa:search] orbit` reads "Search failed" and starts open.
- After a reload, each line keeps its text, its status, and its open or closed state.
- At 360 wide with touch, each line is at least 44px tall and the page does not scroll sideways.
