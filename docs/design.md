# Design

orbit is a night-sky instrument. Dark by default, with dim, light, and system themes. Quiet, fine lines, lit by one warm color: sunrise on the planet's limb. Personality comes from four things, used sparingly: the orbit mark, the sun color, hairline figures in empty and blocked states, and 1px borders with an inset highlight instead of heavy shadows. No purple. It reads as the stock AI color.

## Tokens

Every token is a CSS custom property in `src/app/globals.css`. `@theme inline` exposes them to Tailwind, so `bg-surface-raised` reads `var(--surface-raised)` at runtime. Change a value in `:root`, never in a component.

Each color that differs by theme is written once as `light-dark(<light>, <dark>)`. `color-scheme` on `:root` picks the side: `dark` by default, `light` for `data-theme="light"`, and the operating system's choice for `data-theme="system"`, so system needs no script. `data-theme="dim"` keeps the dark side and overrides the page, surfaces, borders, popover, canvas, sunken and raised wells, skeleton, muted text, and code comments with a softer charcoal (page `#1c1d22`). `src/app/theme-contrast.test.ts` checks every pair below in all three palettes.

| Token | Light | Dark | Tailwind | Use |
| --- | --- | --- | --- | --- |
| `--orbit-bg` | `#f7f6f2` | `#0b0c0f` | | Brand primitive behind `--background`. `themeColorFor` in `src/lib/appearance.ts` repeats it for the theme-color meta |
| `--orbit-surface` | `#fdfdfb` | `#131418` | | Brand primitive behind `--card` |
| `--orbit-border` | `#e2e0d9` | `#23252b` | | Brand primitive behind `--border`, `--input` |
| `--orbit-text` | `#1c1d21` | `#ecebe6` | | Brand primitive behind `--foreground` |
| `--orbit-muted` | `#63646b` | `#8c8d94` | | Brand primitive behind `--muted-foreground` |
| `--orbit-ivory` | `#1c1d21` | `#f1ece1` | | Brand primitive behind `--primary`: ink on paper, ivory on dark |
| `--orbit-sun` | accent preset | accent preset | | Brand primitive behind `--sun`, `--ring`. Set by `data-accent` |
| `--accent-preset-sun/sky/rose/sand` | `#c85a1c`, `#1a72a6`, `#c23b5f`, `#8a6a2e` | `#ff9e5e`, `#5ec8f2`, `#ff7d9c`, `#dcc08e` | | The four accent presets. Each passes 3:1 on every surface |
| `--background` | `--orbit-bg` | `--orbit-bg` | `bg-background` | Page |
| `--foreground` | `--orbit-text` | `--orbit-text` | `text-foreground` | Body text. 4.5:1 on every surface |
| `--card`, `--card-foreground` | `--orbit-surface`, `--orbit-text` | same | `bg-card` | Cards, dialogs. Lighter than the page in every theme |
| `--popover`, `--popover-foreground` | `#ffffff` | `#18191e` | `bg-popover` | Menus, tooltips, select lists |
| `--primary`, `--primary-foreground` | `--orbit-ivory`, `#fbfaf7` | `--orbit-ivory`, `#0b0c0f` | `bg-primary` | Primary actions: Save, Send |
| `--sun` | `--orbit-sun` | `--orbit-sun` | `bg-sun`, `text-sun` | The one lit color. The mark, the active chat, the current prompt in the thread map, links' underline, focus |
| `--secondary`, `--muted` | `#efeee9` | `#1a1b20` | `bg-secondary`, `bg-muted` | Quiet fills |
| `--muted-foreground` | `--orbit-muted` | `--orbit-muted` | `text-muted-foreground` | Secondary text. 4.5:1 on every surface |
| `--accent` | `#ebeae4` | `#1e1f25` | `bg-accent` | Hover fill |
| `--destructive` | `--negative` | `--negative` | `text-destructive` | Errors. One source for error red |
| `--border`, `--input` | `--orbit-border` | `--orbit-border` | `border` (default color) | Hairline borders |
| `--border-strong` | `#cdcac1` | `#33353d` | `border-border-strong` | Hover and open borders |
| `--ring` | `--orbit-sun` | `--orbit-sun` | `ring-ring` | Focus rings |
| `--overlay` | `rgb(28 26 20 / 0.32)` | `rgb(0 0 0 / 0.75)` | `bg-overlay` | Behind dialogs |
| `--canvas` | `#eeede7` | `#07080a` | `bg-canvas` | Darker than the page, for wells |
| `--surface-sunken` | `#f1f0eb` | `#0e0f12` | `bg-surface-sunken` | Inputs, code blocks |
| `--surface-raised` | `#ffffff` | `#1d1e24` | `bg-surface-raised` | Kbd, slider track, the selected pill toggle |
| `--positive`, `--warning`, `--info`, `--negative` | `#18794a`, `#8a5c00`, `#0b6a9c`, `#c3322b` | `#4fd18b`, `#f2cf4a`, `#5ec8f2`, `#ff6259` | `text-positive` | Status only: success, warning, info, error. 4.5:1 on `--card` |
| `--skeleton`, `--skeleton-highlight` | `#ebeae4`, `#f6f5f1` | `#1a1b20`, `#282a31` | `shimmer` | Loading placeholders |
| `--chart-1` to `--chart-5` | orange, blue, green, ochre, pink | sun, sky, green, yellow, pink | `fill-chart-1` | Data series, in order. 3:1 on `--card`. An accent change never recolors them |
| `--syntax-*` | a light palette | the dark palette | | Code highlighting. 4.5:1 on `--surface-sunken`, comments 3:1. `--syntax-keyword` keeps its own value |
| `--shadow-highlight`, `--shadow-drop`, `--shadow-far`, `--shadow-near` | warm, faint | black | | The colors inside `shadow-card` and `shadow-float` |
| `--hairline-plate/hi/edge/mid/lo/stroke` | page, text, muted, muted mix, border, `0.9` | same | | Hairline figure theme. Follows the theme through the primitives |
| `--chat-column` | `34rem`, `48rem` when wide | same | | Behind `--container-chat` |
| `--reply-font` | Geist, Source Serif 4 when serif | same | | Behind `font-reply` |
| `--radius` | `0.625rem` | same | `rounded-sm` to `rounded-xl` | Corner radius scale |

Static theme values in `@theme`:

| Token | Value | Tailwind |
| --- | --- | --- |
| `--container-chat` | `var(--chat-column)` | `max-w-chat` |
| `--container-page` | `42.5rem` | `max-w-page` |
| `--spacing-picker` | `24rem` | `w-picker`, the model picker popover |
| `--spacing-picker-height` | `60vh` | `max-h-picker-height`, the popover and each model list in Settings |
| `--spacing-sheet-height` | `80dvh` | `max-h-sheet-height`, the bottom sheet |
| `--spacing-touch` | `max(2.75rem, 44px)` | `min-h-touch`, `h-touch`, rows and cells in the sheet, 44px at every text size |
| `--ring-width-focus` | `3px` | `ring-focus`, the focus ring width |
| `--text-prose` | `1rem`, line height `1.65` | `text-prose` |
| `--text-field` | `max(1rem, 16px)`, line height `1.5rem` | `text-field` |
| `--text-code` | `0.875rem`, line height `1.5rem` | `text-code` |
| `--text-meta` | `max(0.8125rem, 13px)`, line height `1.25rem` | `text-meta` |
| `--text-h1` to `--text-h6` | `1.5`, `1.25`, `1.125`, `1.0625`, `1`, `1rem` | `text-h1` to `text-h6` |
| `--text-2xs` | `0.6875rem` | `text-2xs`, for `Kbd` only |
| `--shadow-card` | inset 1px top highlight plus a 1px drop | `shadow-card` |
| `--shadow-float` | long soft drop | `shadow-float` |
| `--ease-orbit` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | `ease-orbit` |
| `--animate-rise` | 220ms, 4px up and fade in | `animate-rise` |
| `--animate-shimmer`, `--animate-pulse-ring` | skeleton sweep, ping ring | `animate-shimmer` |
| `--animate-orbit-x`, `--animate-orbit-y` | the mark's satellite | used only by `OrbitMark` |

Utilities: `num` (Geist Mono, tabular figures), `shimmer`, `scrollbar-none`, `scrollbar-thin`.

## Rules

- **Type.** Geist Sans and Geist Mono from the `geist` package, self-hosted. The reply serif is Source Serif 4 from `@fontsource-variable/source-serif-4`, loaded by `next/font/local` without preload, so a sans reader never downloads it, and with `size-adjust: 107%` so it reads at Geist's size. No font CDN, no runtime requests. Numbers use tabular figures (`num` or `tabular-nums`). Sentence case everywhere.
- **Type scale.** Replies and user messages use `text-prose`, 16px at a 1.65 line height. Every input, textarea, and select uses `text-field`, so iOS never zooms. Code uses `text-code`. Labels, statuses, chips, and snippets use `text-meta`, never under 13px. `text-2xs` (11px) is for `Kbd` only, and `text-xs` is not used. Buttons, sidebar rows, and menu items keep `text-sm`. Markdown headings use `text-h1` to `text-h6` at weight 600, with `h6` at 500 and muted, so each level looks distinct from the next and from body text.
- **Text size.** `data-text-size` scales the root font size to 93.75%, 100%, 112.5%, or 125%. Percentages keep the browser's own font setting. Everything in rem scales with it, the chat column included, so a line holds the same number of characters at every size.
- **Copy.** Short labels only. No taglines, helper text, or secondary labels. If a screen needs explaining, fix the layout.
- **Lines, not shadows.** 1px `border`, `shadow-card` on raised surfaces, `shadow-float` only on things that float (menus, dialogs, tooltips).
- **Accent.** Primary actions are ivory. Sun appears once or twice per screen: the mark, the active chat, the current prompt. Marks repeated down the thread use `tone="mono"` and turn sun only while busy. A selected pill toggle is a raised surface, not a tint. A selected outline toggle, such as an effort level, has a `--foreground` border.
- **Depth.** In every theme, a card is lighter than the page and a well is darker. On dark and dim, depth comes from a lighter surface; on light, from a white card with a soft warm drop. The composer lifts to `bg-popover` on focus instead of drawing a ring.
- **Touch.** On `pointer: coarse` every control has a 44px hit area. `globals.css` grows buttons and links with a pseudo-element. A control whose parent clips it grows its own box with `pointer-coarse:`.
- **Icons.** `@phosphor-icons/react`, weight `light` by default, `regular` at 14px and below. Import the `*Icon` names (`XIcon`, not the deprecated `X`). In a server component import from `@phosphor-icons/react/ssr`.
- **Motion.** 150 to 250ms, `ease-orbit`. Messages enter with `animate-rise`. No bouncing. `prefers-reduced-motion` cuts every animation and transition to near zero, and the mark's satellite stops.
- **Status and series colors.** `--positive`, `--warning`, `--info`, and `--negative` mean status and nothing else. `--chart-1` to `--chart-5` are for data series and search tiles.
- **Width.** The chat column, tool cards, and every json-render widget are capped at `max-w-chat`, a 34rem reading column (48rem when wide), so a desktop line holds 65 to 75 characters. Settings and memory use `max-w-page`.

## Components

`src/components/ui/` holds shadcn-style primitives on individual `@radix-ui/react-*` packages: `Button`, `Input`, `Label`, `Slider`, `Tooltip`, `ToggleGroup`, `Select`, `Dialog`, `Popover`, `Sheet`, `Switch`, `Skeleton`, `Kbd`. Each sets `data-slot` for styling from a parent. `Sheet` is a bottom sheet on the Dialog primitives, built like the chat drawer: full width, `bg-popover`, rounded top corners, at most `max-h-sheet-height`, sliding up from the bottom edge. It focuses itself on open instead of its first field, so a phone keyboard does not cover it. `Switch` is a `role="switch"` button. `DESKTOP_QUERY` and `useDesktop()` in `src/components/use-desktop.ts` are the one 48rem breakpoint test for script.

`OrbitMark` (`src/components/orbit-mark.tsx`) is the app's only loading indicator. Pass `busy` while the assistant is thinking or streaming and the moon travels the ring, passing behind the planet on the far side. `tone` is `"accent"` (sun ring and moon) or `"mono"` (muted). It is `aria-hidden`, so pair it with a status label where the state matters to a screen reader.

Appearance (`src/components/settings/appearance-settings.tsx`) is the first card on `/settings`. Theme, text size, reply font, chat width (hidden on phones), and accent are pill toggle groups that save on click, with no Save button. Each choice is a `data-*` attribute on `<html>`, written by the server on first paint from the `user_preferences` row and by the card at once on click. The text size glyphs and the accent swatches preview their choice. A failed save puts the choice back and shows one error line.

Each sidebar row has an actions button, `Actions for <title>`. With a mouse it shows on hover, on focus, and on the active row, and opens a dropdown (`src/components/ui/dropdown-menu.tsx`). On touch it always shows at 44px and opens a `Sheet` titled with the chat's name. Both menus hold **Rename** and **Delete**, with Delete in `text-destructive`. A menu closed without a choice gives focus back to its button.

The first Tab stop on every app page is a skip link, hidden until it has focus, because each sidebar chat adds two Tab stops. On a chat it reads **Skip to chat** and moves focus to the composer. Elsewhere it reads **Skip to content** and moves focus to the page's `<main>`.

**Rename** turns the row into a `text-field` input that holds the title, selected, up to 120 characters. Enter or leaving the field saves. Escape cancels, and in the phone drawer it does not close the drawer. Blank or unchanged text sends nothing. The new title shows at once in the sidebar, the header, and the palette. If the save fails, the title goes back to the last saved one and "Could not rename" shows.

**Delete** hides the chat at once and shows one toast, "Chat deleted" with **Undo**, at the top center: under the header on phones, and inside the drawer while it is open. The delete is sent after five seconds, or at once when the page is hidden or closed. Hover or focus on the toast pauses the count. Deleting the open chat opens a new draft, and **Undo** goes back to the chat while a draft is still open. A failed delete puts the row back and shows "Could not delete" for five seconds. After deleting a chat that is not open, focus moves to the next row.

`ThreadMap` (`src/components/chat/thread-map.tsx`) is a rail of ticks on the thread's right edge, one per prompt, shown from three prompts when the thread is at least 52rem wide. Ticks for turns in view are brighter and the current turn is sun. Hovering or focusing the rail opens the prompt list. A row jumps to its prompt and moves focus there. A narrower thread gets a **Prompts** button instead, which opens the same list in the bottom sheet. Exactly one of the two shows: `ThreadMap` reads whether the rail is displayed and puts the button in the header while the header shows, or at the right end of the Jump to latest strip from 768px with the sidebar open, where the header is hidden. `Alt+Up` and `Alt+Down` step between prompts when focus is outside a text field. The current-turn math lives in `src/lib/thread-map.ts`.

The **Prompts** button (`ListBulletsIcon`) takes the rail's place from three prompts whenever the rail does not fit. It opens the same list in a `Sheet` titled Prompts, with 44px rows, scrolled to the current prompt, which has a sun dot. A pick closes the sheet, scrolls to that prompt, and moves focus there. A page puts header buttons in the slot that `HeaderSlotContext` (`src/components/shell/header-slot.tsx`) provides.

The thread footer is opaque under a 16px fade. Its top row is a 44px strip (`data-jump-strip`) with **Jump to latest** centered in it as a pill. The button never covers text. The composer does not move when the button shows or hides, or while messages load. While a reply streams, `turnAnchor="top"` scrolls the new prompt once to 16px under the header, and the view stays at the start of the answer. assistant-ui never pins the first prompt of a chat.

A user message taller than 14 lines folds to 12 under a fade, with **Show more**, which then reads **Show less**. The fold is measured again when the width or the text size changes. Copy copies the whole message while it is folded.

With a mouse, Copy and Edit sit beside a user message on hover, and the bubble leaves them 4rem. On touch they sit under the bubble at 44px, on one line with the branch picker, so they take no width from the text. On touch the reply's action row grows to 44px, so its buttons and the reply label never clip.

A chat whose model choice does not resolve and that has no messages shows the first run in place, so it never leaves the chat. With no connection it shows the add connection form, kind first. Then it shows the default model card. Saving that refreshes the route and the composer appears. When the saved key cannot be read, it shows the connections card, so the key can be entered again.

### Model picker

The composer chip is a `button` (`data-model-chip`) in `font-mono text-meta`, reading `model · Effort`, such as `claude-opus-5-5 · High`, or the model alone when the model takes no effort. It truncates at the end and never pushes Send out of the row. It opens the picker: a `Popover` anchored above the chip on desktop (`w-picker`, at most `max-h-picker-height` or the room above the chip, `shadow-float`), and a `Sheet` under 48rem. Both hold the same panel:

- Models grouped under each connection's label, hidden models left out. A search field shows when the lists hold more than 8 rows. Each row shows the model id, its badges, and a check on the current one. Rows are at least 44px tall in the sheet at every text size (`min-h-touch`).
- A model list that is still loading shows skeleton rows. One that failed shows its error and **Retry** inside its group. A loaded list with nothing to show says `No models`. With no connection at all, the list holds one **Add connection** link to `/settings#connections`, so a chat with history reaches setup too.
- Under the list, the effort grid: 3 by 2, `None` to `Max`. Levels the model does not take are disabled, and all six are when it takes none. Picking a model that does not take the current effort moves it to the nearest level it takes. The selected level has a `--foreground` border, which reads at 12:1 or more on the popover and the card in every theme, where a raised surface or `--border-strong` reads under 2:1.
- **Manage** goes to `/settings#models`.

The choice is the chat's own until the next send pins it. Picking a model keeps the picker open, so the effort can follow. A pick whose connection is deleted is dropped, and the chat falls back to its pinned choice or the defaults as the page last resolved them.

**Badges.** Phosphor icons at 14px, `regular`, each with an `aria-label`: images, tools, reasoning. Then the context size in `num`, such as `200K` or `1M`. A capability the provider did not report gets no badge.

**Reply label.** Each assistant reply with a record shows `model · Effort` at the right end of its action row, in `font-mono text-meta text-muted-foreground`. It sits outside the action bar, so it stays visible when older action bars hide on hover devices and while a reply stops or reconnects. An effort the provider changed reads `High (adjusted)` or `High (ignored)`. A reply with no effort shows the model alone. No tooltip.

### Model settings

After Appearance, Settings has three cards. **Connections** lists each connection's label with its kind and host under it, then `Key unreadable` in `text-destructive` when this server cannot open the saved key, and **Edit** and **Delete** on the row. **Add** opens a dialog that asks the kind first; an Anthropic connection has no base URL field. **Delete** asks once in a dialog. Errors show inside the dialog. **Default model** holds the connection select, the model select with a **Custom** option for typing an id (a text field alone when the list is empty or failed), the effort grid, and **Save**. The model belongs to the chosen connection, so switching the connection or deleting it clears the model. **Models** (`#models`) lists every model of each connection with its badges and a show or hide `Switch`. Each connection's heading shows its list status: `Checking`, `N models`, or `Failed`.

`ScrollFade` (`src/components/ui/scroll-fade.tsx`) wraps anything that scrolls on one axis and fades the edge that has more content behind it. Pass `fade` as the color of the surface behind the content. Code blocks, markdown tables, and the command palette use it. A cut line or row without a fade reads as a layout bug.

Code blocks longer than 20 lines open capped at 14 with a "N more lines" control. Lines scroll sideways under a fade until **Wrap** in the block header wraps them. Wrap is a toggle (`aria-pressed`) with the raised surface when on. It holds for that block only and resets on reload.

An artifact in a reply shows as a card (`src/components/chat/artifact-card.tsx`) instead of its code: a 36px tile with the kind icon, the title, the kind (HTML, SVG, or React), and **Open**. The title is the user's rename, else the title read from the code. When the artifact's lineage has more than one version, the kind reads `HTML · v2`, the number in `num`. **Edit** shows when the reply can be edited, and the code shows under the edit bar only while editing. While the reply streams, the tile holds a busy `OrbitMark` and **Open** is disabled. A code block inside reasoning stays a plain code block. The Code tab is highlighted with `orbitCodeTheme`. The preview frame gets one stylesheet in `@layer orbit-base` with Orbit's resolved colors, accent, and radius, so any rule the artifact writes wins. Changing the theme, accent, or text size reloads the preview.

`ArtifactPanel` (`src/components/artifacts/artifact-panel.tsx`) has three rows above its view. The header holds the same title and, for a saved artifact, a **Rename** pencil (`Rename artifact`). Rename turns the title into a `text-field` input that holds the title, selected, up to 80 characters. Enter or leaving the field saves the title for every version. Escape cancels and never closes the panel or its phone dialog. Blank text goes back to the title read from the code, and unchanged text sends nothing. A failed save puts the title back and shows "Could not rename". In the chat the header ends with **Close**; on `/artifacts` it ends with **Open in chat**, which opens the chat on that version's branch with the artifact open. Under the header, `ArtifactVersions` lists `v1`, `v2`, `v3` whenever the lineage has more than one version, so earlier versions are never hidden in a menu. The open version is a raised surface with a strong border and `aria-current`. Picking a version on the open branch swaps the preview in place. A version on another branch opens the chat on that branch. The third row holds the tabs, **Preview**, **Code**, and **Diff** (Diff only with more than one version), and on the right **Reload**, **Copy**, and **Download** as icon buttons with tooltips. On a narrow panel at a large text size the icons drop under the tabs. The tab stays when the version changes. **Download** names the file from the shown title, such as `tally.html` after a rename to "Tally".

**Diff** compares the open version with the one before it, or with `v2` when `v1` is open. It always reads oldest to newest: `v2 → v3`, with a select on the other version's side to pick any version of the lineage, and the counts `+3` in `text-positive` and `-1` in `text-destructive`. Lines show in one unified column in a sunken well with a sideways fade, never side by side, so a phone keeps its width. Added lines are tinted `bg-positive/12` with a `+`, removed lines `bg-destructive/12` with a `-`, and both line numbers sit in a muted gutter that does not copy. An unchanged run longer than six lines folds into a bar, "14 unchanged lines", keeping three lines next to each change; pressing it opens those lines in place. Matching versions say "No differences". Past 4,000 changed lines or 2,000,000 compared cells it says "Too large to compare". While the other version loads the well shows skeleton lines, and a failed load shows "Could not load version" with **Retry**.

`/artifacts` (`src/components/artifacts/artifact-library.tsx`) is each user's own library. From 1024px it has two panes. The left pane, 20rem wide, holds the `Artifacts` heading, a search field, the kind pills **All**, **HTML**, **SVG**, and **React**, the list, and **Show more** while another page exists. Each row (`data-artifact-row`) shows a 32px kind tile, the title, the date in the reader's time zone, the kind with the version count (`HTML · 3 versions`), and the chat's name. The open row has the sun rule of the active chat. A row is a link, so a middle click opens it in a new tab. The right pane is `ArtifactPanel`. Under 1024px one pane shows at a time: the list first, then a tapped row full width with **Back** at the top of its header, and the browser's Back returns to the list. The first artifact opens beside the list on first paint. A search keeps the old rows faded until its results arrive. An account with no artifacts shows the `stack` figure and "No artifacts". A search or filter with nothing shows "No matching artifacts". An unknown or deleted `?id=` shows "Artifact not found". A failed load shows "Could not load artifacts" or "Could not load artifact" with **Retry**.

`Figure` (`src/components/figure.tsx`) renders a hairline figure by name, `"dish"` for an empty chat, `"padlock"` on sign-in, `"plug"` when no provider is configured, `"stack"` for an empty artifact library. It sets `data-figure` to the name. It fills its parent's width at a 5:4 ratio, so size the parent. Plates are filled with `--hairline-plate`, which is the page color. On any other surface, set `--hairline-plate` on the parent to that surface's color. To add a figure, import it from `@lucasmarkes/hairline/react` and add it to the `figures` record.

## json-render widgets

A `render_ui` reply renders inline, as part of the answer. It has no run frame and no status word. `RenderUiPart` draws exactly one surface, `[data-genui]`: `bg-card`, `border`, `shadow-card`, `rounded-xl`, 16px padding (12px on phones), at most `max-w-chat`. Nothing inside it draws a border box or its own card. The only fills inside are the table header row, the status-tinted callout, and the sunken code well. Series take `--chart-1` onward in order. Code takes the `--syntax-*` tokens.

| Component | Looks like |
| --- | --- |
| `Card` | A `section` with a `text-h4` heading and an optional muted description. Children flow in a wrapping row, so metrics sit side by side and wrap on a phone. A nested `Card` starts with a top divider. |
| `Metric` | A muted label, the value at `text-2xl` with tabular figures, then a change line: `ArrowUpIcon` or `ArrowDownIcon` and the signed change, `text-positive`, `text-negative`, or muted, then the hint. `changeTone` lets the model say a drop is good. |
| `KeyValue` | Two columns. The label column is at most 40% wide and wraps. |
| `Table` | A header row filled 6% toward `--foreground`, so it reads raised in every theme. Number columns are right-aligned with tabular figures. Short text columns stay on one line, and a column with a cell over 32 characters wraps. The table scrolls sideways in `ScrollFade` with `fade="var(--card)"`. It opens at 12 rows with a full-width ghost **Show all N rows**. Expanded, every row renders in place and **Show fewer** collapses it and keeps the button in view. No inner vertical scroll. |
| `List` | Bullets at `text-prose`. |
| `Text` | A dashed hairline border and a 14px `PencilSimpleIcon` at rest. Hover and focus make the border solid, and focus turns it sun. Code format sits in a sunken well with `text-code`, no wrapping, and a sideways fade. |
| `Callout` | `info`, `warning`, and `success` use `--info`, `--warning`, and `--positive` for a 2px rule on the left and the icon (`InfoIcon`, `WarningIcon`, `CheckCircleIcon`), and a 10% tint of the same token for the fill. Title and text stay `text-foreground`. |
| `Button` | The `Button` primitive, `variant="secondary"`, `size="sm"`. A click shows its note once, below the button. When a callout's `statePath` is `/note`, that callout shows the note and the button does not repeat it. |

- **Numbers.** Every number a widget prints goes through `formatValue` in `src/lib/genui/format.ts`: `Intl.NumberFormat("en-US")` with `useGrouping: "min2"`, so `42000` reads `42,000` while `1234` and the year `2026` keep no comma. The locale is fixed so the server and the browser print the same text. A string prints as the model wrote it.
- **Long content.** The surface breaks long words anywhere, so a 1,000-character word never widens the page.
- **One place per value.** A value bound to state renders once. If a callout shows a note, the button does not repeat it. `calloutShowsNote` in `src/lib/genui/spec.ts` decides this from the spec.
- **Loading.** While the spec streams, the surface holds `Skeleton` blocks, a title bar and three lines, with a hidden "Building view" status.
- **Failures.** A spec that fails validation is one line, "Could not show this view", in `text-destructive` with `WarningCircleIcon`. It is a closed disclosure named **Details** that holds the error lines and the raw JSON in a sunken well capped at `max-h-tool-content`. A stopped spec is one muted line, "Stopped".

## Tool run cards

Tool calls have three layouts, which `RunCard` picks from each tool's card kind in `src/lib/tools/metadata.ts`. `render_ui` is **inline**: the widget above. `run_code` is a **card**. Every other tool, web search, memory, GitHub, and unknown tools, is a **line**.

A line is one pill that says what happened, in the same family as the reasoning pill: both use `disclosureTrigger` from `src/components/chat/disclosure.ts`. It holds `OrbitMark` while running, else the tool's icon, then the summary. The summary is the only status, so a line never adds Succeeded or Failed.

| Tool | Running | Succeeded | Failed | Stopped |
| --- | --- | --- | --- | --- |
| Web search | Searching the web | Searched the web, 3 sources | Search failed | Search stopped |
| Save a memory | Saving to memory | Saved to memory | Could not save to memory | Stopped |
| Remove a memory | Removing a memory | Removed a memory | Could not remove the memory | Stopped |
| GitHub | List issues on GitHub | List issues on GitHub, 2 results | List issues on GitHub failed | List issues on GitHub stopped |
| Any other | Do thing | Do thing | Do thing failed | Do thing stopped |

Counts use the singular for one. Names come from the registry, never the raw tool name. A line with more to read is a `<details>` that opens on tap or with Enter and Space. Its body hangs from a hairline under the pill, like reasoning. A failed line starts open with its error. A finished search opens to its result links, or to "Search returned an invalid result" when its saved result does not parse, and the line then reads "Searched the web" with no count. A GitHub call opens to its links, and an unknown tool to its JSON output in a sunken well. A saved memory previews its text on the line after the label and opens to the whole text, a body that wraps long words and keeps line breaks. Every saved memory has that body, short or long, because the preview is capped at 24ch on a phone and 40ch elsewhere, and a narrow screen or a large text size cuts it sooner. The preview hides while the line is open, so the text shows once. A removed memory has no text and no body. On a touch screen the pill is 44px tall. On a phone the summary truncates with an ellipsis.

Each search result has a tile: the first letter or digit of its host, without `www.`, on a 20% tint of one of `--chart-1` to `--chart-5`. The letter is that chart color mixed 35% toward `--foreground`, so it reads at 4.5:1 in every theme. The tone is a stable hash of the whole host, so `example.com` and `example.org` share a letter and get their own colors. Tiles are computed in `src/lib/tools/domain-tile.ts`, and the browser fetches nothing from the site. The line shows up to five tiles, three on a phone. The open list shows each result's title link, its host, and its snippet.

The code-run card keeps its full layout, because its output is often the answer. Its header shows "Run code", the language, and the status word: muted while running or stopped, `text-positive` on success, `text-destructive` on failure. Status comes from the message part, so the same card appears after reload.

A code run also shows its language, Python or JavaScript, in a small bordered tag after the title. The tag comes from the validated tool input, so a rejected call has none. Code runs show source, stdout, and stderr in separate code wells with scroll fades. The source sits on the code surface and the output sits on the darker well surface. Output is untrusted text. The card removes terminal escape sequences and control characters before it shows or copies the text. Tabs and line breaks stay, and a carriage return becomes a line break. A channel with no text, or only spaces and line breaks, has no well and no label, so a silent run shows only its source and result. Each well with text has an icon button at its top right that copies exactly that text. It shows a check for 1.5 seconds after a copy and a warning mark if the browser refuses, and a hidden live region announces the result. The result line states one outcome and a duration, and never repeats the header status. The outcome is `Exit 0`, `Exit 3`, `Timed out`, `Out of memory (exit 137)`, or `Stopped`, and the duration is its own part, such as `174 ms` or `10.0 s`. A duration under one second shows milliseconds, and a longer one shows seconds. The runner records whether Docker killed the program for memory, so a program that exits 137 on its own shows `Exit 137`. Nonzero exits, kills, and timeouts show Failed. Completed code and output survive reload.
