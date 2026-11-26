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
| `--border-strong` | `#cdcac1` | `#33353d` | `border-border-strong` | Hover and selected borders |
| `--ring` | `--orbit-sun` | `--orbit-sun` | `ring-ring` | Focus rings |
| `--overlay` | `rgb(28 26 20 / 0.32)` | `rgb(0 0 0 / 0.75)` | `bg-overlay` | Behind dialogs |
| `--canvas` | `#eeede7` | `#07080a` | `bg-canvas` | Darker than the page, for wells |
| `--surface-sunken` | `#f1f0eb` | `#0e0f12` | `bg-surface-sunken` | Inputs, code blocks |
| `--surface-raised` | `#ffffff` | `#1d1e24` | `bg-surface-raised` | Kbd, slider track, the selected toggle |
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
- **Accent.** Primary actions are ivory. Sun appears once or twice per screen: the mark, the active chat, the current prompt. Marks repeated down the thread use `tone="mono"` and turn sun only while busy. A selected toggle is a raised surface, not a tint.
- **Depth.** In every theme, a card is lighter than the page and a well is darker. On dark and dim, depth comes from a lighter surface; on light, from a white card with a soft warm drop. The composer lifts to `bg-popover` on focus instead of drawing a ring.
- **Touch.** On `pointer: coarse` every control has a 44px hit area. `globals.css` grows buttons and links with a pseudo-element. A control whose parent clips it grows its own box with `pointer-coarse:`.
- **Icons.** `@phosphor-icons/react`, weight `light` by default, `regular` at 14px and below. Import the `*Icon` names (`XIcon`, not the deprecated `X`). In a server component import from `@phosphor-icons/react/ssr`.
- **Motion.** 150 to 250ms, `ease-orbit`. Messages enter with `animate-rise`. No bouncing. `prefers-reduced-motion` cuts every animation and transition to near zero, and the mark's satellite stops.
- **Width.** The chat column, tool cards, and every json-render widget are capped at `max-w-chat`, a 34rem reading column (48rem when wide), so a desktop line holds 65 to 75 characters. Settings and memory use `max-w-page`.

## Components

`src/components/ui/` holds shadcn-style primitives on individual `@radix-ui/react-*` packages: `Button`, `Input`, `Label`, `Slider`, `Tooltip`, `ToggleGroup`, `Select`, `Dialog`, `Popover`, `Sheet`, `Switch`, `Skeleton`, `Kbd`. Each sets `data-slot` for styling from a parent. `Sheet` is a bottom sheet on the Dialog primitives, built like the chat drawer: full width, `bg-popover`, rounded top corners, at most `max-h-sheet-height`, sliding up from the bottom edge. It focuses itself on open instead of its first field, so a phone keyboard does not cover it. `Switch` is a `role="switch"` button. `DESKTOP_QUERY` and `useDesktop()` in `src/components/use-desktop.ts` are the one 48rem breakpoint test for script.

`OrbitMark` (`src/components/orbit-mark.tsx`) is the app's only loading indicator. Pass `busy` while the assistant is thinking or streaming and the moon travels the ring, passing behind the planet on the far side. `tone` is `"accent"` (sun ring and moon) or `"mono"` (muted). It is `aria-hidden`, so pair it with a status label where the state matters to a screen reader.

Appearance (`src/components/settings/appearance-settings.tsx`) is the first card on `/settings`. Theme, text size, reply font, chat width (hidden on phones), and accent are pill toggle groups that save on click, with no Save button. Each choice is a `data-*` attribute on `<html>`, written by the server on first paint from the `user_preferences` row and by the card at once on click. The text size glyphs and the accent swatches preview their choice. A failed save puts the choice back and shows one error line.

`ThreadMap` (`src/components/chat/thread-map.tsx`) is a rail of ticks on the thread's right edge, one per prompt, shown from three prompts when the thread is at least 52rem wide. Ticks for turns in view are brighter and the current turn is sun. Hovering or focusing the rail opens the prompt list. A row jumps to its prompt and moves focus there. `Alt+Up` and `Alt+Down` step between prompts when focus is outside a text field. The current-turn math lives in `src/lib/thread-map.ts`.

A chat whose model choice does not resolve and that has no messages shows the first run in place, so it never leaves the chat. With no connection it shows the add connection form, kind first. Then it shows the default model card. Saving that refreshes the route and the composer appears. When the saved key cannot be read, it shows the connections card, so the key can be entered again.

### Model picker

The composer chip is a `button` (`data-model-chip`) in `font-mono text-meta`, reading `model · Effort`, such as `claude-opus-5-5 · High`, or the model alone when the model takes no effort. It truncates at the end and never pushes Send out of the row. It opens the picker: a `Popover` anchored above the chip on desktop (`w-picker`, at most `max-h-picker-height` or the room above the chip, `shadow-float`), and a `Sheet` under 48rem. Both hold the same panel:

- Models grouped under each connection's label, hidden models left out. A search field shows when the lists hold more than 8 rows. Each row shows the model id, its badges, and a check on the current one. Rows are at least 44px tall in the sheet.
- A model list that is still loading shows skeleton rows. One that failed shows its error and **Retry** inside its group. A loaded list with nothing to show says `No models`. With no connection at all, the list holds one **Add connection** link to `/settings#connections`, so a chat with history reaches setup too.
- Under the list, the effort grid: 3 by 2, `None` to `Max`. Levels the model does not take are disabled, and all six are when it takes none. Picking a model that does not take the current effort moves it to the nearest level it takes. The selected level is a raised surface.
- **Manage** goes to `/settings#models`.

The choice is the chat's own until the next send pins it. Picking a model keeps the picker open, so the effort can follow. A pick whose connection is deleted is dropped, and the chat falls back to its pinned choice or the defaults as the page last resolved them.

**Badges.** Phosphor icons at 14px, `regular`, each with an `aria-label`: images, tools, reasoning. Then the context size in `num`, such as `200K` or `1M`. A capability the provider did not report gets no badge.

**Reply label.** Each assistant reply with a record shows `model · Effort` at the right end of its action row, in `font-mono text-meta text-muted-foreground`. It sits outside the action bar, so it stays visible when older action bars hide on hover devices. An effort the provider changed reads `High (adjusted)` or `High (ignored)`. A reply with no effort shows the model alone. No tooltip.

### Model settings

After Appearance, Settings has three cards. **Connections** lists each connection's label with its kind and host under it, then `Key unreadable` in `text-destructive` when this server cannot open the saved key, and **Edit** and **Delete** on the row. **Add** opens a dialog that asks the kind first; an Anthropic connection has no base URL field. **Delete** asks once in a dialog. Errors show inside the dialog. **Default model** holds the connection select, the model select with a **Custom** option for typing an id (a text field alone when the list is empty or failed), the effort grid, and **Save**. The model belongs to the chosen connection, so switching the connection or deleting it clears the model. **Models** (`#models`) lists every model of each connection with its badges and a show or hide `Switch`. Each connection's heading shows its list status: `Checking`, `N models`, or `Failed`.

`ScrollFade` (`src/components/ui/scroll-fade.tsx`) wraps anything that scrolls on one axis and fades the edge that has more content behind it. Pass `fade` as the color of the surface behind the content. Code blocks, markdown tables, and the command palette use it. A cut line or row without a fade reads as a layout bug.

Code blocks longer than 20 lines open capped at 14 with a "N more lines" control. Lines never wrap; they scroll sideways under a fade.

`Figure` (`src/components/figure.tsx`) renders a hairline figure by name, `"dish"` for an empty chat, `"padlock"` on sign-in, `"plug"` when no provider is configured. It fills its parent's width at a 5:4 ratio, so size the parent. Plates are filled with `--hairline-plate`, which is the page color. On any other surface, set `--hairline-plate` on the parent to that surface's color. To add a figure, import it from `@lucasmarkes/hairline/react` and add it to the `figures` record.

## json-render widgets (slice 2)

Widgets are cards on the chat column: `bg-card`, `border`, `shadow-card`, `rounded-lg`, at most `max-w-chat`. Series take `--chart-1` onward in order. Code takes the `--syntax-*` tokens. Loading states use `Skeleton` in the shape of the content they replace.

- **Numbers.** Format with `Intl.NumberFormat` and set them in `num`. `42000` renders as `42,000`.
- **Long content.** Code goes through the markdown code block, so it gets the cap and the sideways scroll. Long text clamps with a "more" control. A wide table sits in `ScrollFade` with `fade="var(--card)"`.
- **Editable text.** Shows it is editable at rest: a dashed hairline border and a 14px pencil at the end of the line. Hover and focus solidify the border.
- **Actions.** Use `Button`, so focus gets the ring instead of the browser outline.
- **One place per value.** A value bound to state renders once. If a callout shows a note, the button does not repeat it.
- **Failures.** A spec that fails validation renders one line in `text-destructive` with a disclosure for the raw JSON, collapsed by default.

## Tool run cards

Every tool call uses a bordered card in the chat column. The header shows the tool name and Running, Succeeded, Failed, or Cancelled. Running uses `OrbitMark`. Status comes from the message part, so the same card appears after reload.

Web search results are text links with short snippets. Each result has a bordered square with the domain's first letter. A remember card shows the saved text. Unknown tools show their JSON output in a collapsed Output disclosure.

A code run also shows its language, Python or JavaScript, in a small bordered tag after the title. The tag comes from the validated tool input, so a rejected call has none. Code runs show source, stdout, and stderr in separate code wells with scroll fades. The source sits on the code surface and the output sits on the darker well surface. Output is untrusted text. The card removes terminal escape sequences and control characters before it shows or copies the text. Tabs and line breaks stay, and a carriage return becomes a line break. A channel with no text, or only spaces and line breaks, has no well and no label, so a silent run shows only its source and result. Each well with text has an icon button at its top right that copies exactly that text. It shows a check for 1.5 seconds after a copy and a warning mark if the browser refuses, and a hidden live region announces the result. The result line states one outcome and a duration, and never repeats the header status. The outcome is `Exit 0`, `Exit 3`, `Timed out`, `Out of memory (exit 137)`, or `Stopped`, and the duration is its own part, such as `174 ms` or `10.0 s`. A duration under one second shows milliseconds, and a longer one shows seconds. The runner records whether Docker killed the program for memory, so a program that exits 137 on its own shows `Exit 137`. Nonzero exits, kills, and timeouts show Failed. Completed code and output survive reload.
