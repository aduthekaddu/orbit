# Generative UI visual findings

Date: 2026-11-01. Branch `feat/generative-ui`. Worktree `~/orbit/.worktrees/genui`.

These are visual and design issues from the browser QA pass. No design or polish changes were made on this branch. The functional report is `docs/qa/2026-11-01-genui-qa.md`.

## High

### Mobile layout does not fit 390x844

The sidebar is a fixed `w-60` (240px). At 390px wide it leaves about 150px for the chat. Cards, tables, and code blocks clip at the edge. Table columns disappear behind a narrow horizontal scroller. The composer is about 120px wide and the placeholder wraps to two lines.

The layout still accepts input, so this is a design problem, not a dead end. A phone layout likely needs a collapsible sidebar or a drawer, and a chat column that uses the full width.

Screenshots:
- `docs/qa/screenshots/genui-all-mobile.png`
- `docs/qa/screenshots/genui-huge-mobile.png`
- `docs/qa/screenshots/genui-long-mobile.png`
- `docs/qa/screenshots/genui-text-mobile.png`
- `docs/qa/screenshots/genui-real-mobile.png`

## Medium

### Generated long text and code make very tall blocks

A long paragraph, a long unbroken word, and a long code string all render without a max height or collapse control. The code block becomes a wall of wrapped monospace text that fills the viewport. The table rows grow tall for the same reason.

A design pass could cap the height and add an expand control, or keep code on one line with horizontal scroll instead of wrapping.

Screenshots:
- `docs/qa/screenshots/genui-long-desktop.png`
- `docs/qa/screenshots/genui-long-mobile.png`

### Editable text has no resting affordance

The generated `Text` component looks like plain text until the pointer hovers it. The only hint is a border on hover and focus. There is no edit icon, label, or short helper text, so a reader may not know the text can be changed. The label field is optional and the model often leaves it out.

A design pass could add a small edit control or a persistent subtle surface that says the text is editable.

Screenshots:
- `docs/qa/screenshots/genui-text-desktop.png`
- `docs/qa/screenshots/genui-all-desktop.png`
- `docs/qa/screenshots/genui-all-text-edited.png`

### The unknown-type fallback is a wall of raw error and JSON

The fallback is correct, but it prints the full validation payload, the allowed component list, and the raw spec. It fills most of the thread. A short summary line with a disclosure for the raw JSON would read better.

Screenshots:
- `docs/qa/screenshots/genui-unknown-desktop.png`
- `docs/qa/screenshots/genui-malformed-desktop.png`

## Low

### The button note appears twice

The generated Button shows its note below the button. The Callout with `statePath: "/note"` also shows the same note. It reads as a duplicate when both components are present.

Screenshots:
- `docs/qa/screenshots/genui-all-desktop.png`

### Numbers are not formatted

Metric and KeyValue values print exactly as stored. `1234` and `42000` stay unformatted. The catalog treats numbers as text, so this is a presentation choice for the design pass.

Screenshots:
- `docs/qa/screenshots/genui-all-desktop.png`

### The generated button uses the browser focus outline

The generated button has no custom focus ring. Keyboard focus falls back to a thin browser outline. It is visible, but it does not match the rest of the interface.

Screenshots:
- `docs/qa/screenshots/genui-button-focus.png`

### Long user prompts wrap into the sidebar edge on mobile

The user bubble is right aligned and uses `max-w-[80%]` of an already narrow chat column. The text stacks one or two words per line. This comes from the same mobile width problem above.

Screenshots:
- `docs/qa/screenshots/genui-all-mobile.png`
