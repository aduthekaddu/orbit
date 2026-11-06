# Design

orbit is a night-sky instrument. Dark only, quiet, fine lines, lit by one warm color: sunrise on the planet's limb. Personality comes from four things, used sparingly: the orbit mark, the sun color, hairline figures in empty and blocked states, and 1px borders with an inset highlight instead of heavy shadows. No purple. It reads as the stock AI color.

## Tokens

Every token is a CSS custom property in `src/app/globals.css`. `@theme inline` exposes them to Tailwind, so `bg-surface-raised` reads `var(--surface-raised)` at runtime. Change a value in `:root`, never in a component.

| Token | Value | Tailwind | Use |
| --- | --- | --- | --- |
| `--orbit-bg` | `#0b0c0f` | | Brand primitive behind `--background` |
| `--orbit-surface` | `#131418` | | Brand primitive behind `--card` |
| `--orbit-border` | `#23252b` | | Brand primitive behind `--border`, `--input` |
| `--orbit-text` | `#ecebe6` | | Brand primitive behind `--foreground` |
| `--orbit-muted` | `#8c8d94` | | Brand primitive behind `--muted-foreground` |
| `--orbit-ivory` | `#f1ece1` | | Brand primitive behind `--primary` |
| `--orbit-sun` | `#ff9e5e` | | Brand primitive behind `--sun`, `--ring` |
| `--background` | `--orbit-bg` | `bg-background` | Page |
| `--foreground` | `--orbit-text` | `text-foreground` | Body text |
| `--card`, `--card-foreground` | `--orbit-surface`, `--orbit-text` | `bg-card` | Cards, dialogs |
| `--popover`, `--popover-foreground` | `#18191e`, `--orbit-text` | `bg-popover` | Menus, tooltips, select lists |
| `--primary`, `--primary-foreground` | `--orbit-ivory`, `#0b0c0f` | `bg-primary` | Primary actions: Save, Send |
| `--sun` | `--orbit-sun` | `bg-sun`, `text-sun` | The one lit color. The mark, the active chat, the current prompt in the thread map, links' underline, focus |
| `--secondary`, `--muted` | `#1a1b20` | `bg-secondary`, `bg-muted` | Quiet fills |
| `--muted-foreground` | `--orbit-muted` | `text-muted-foreground` | Secondary text |
| `--accent` | `#1e1f25` | `bg-accent` | Hover fill |
| `--destructive`, `--negative` | `#ff6259` | `text-destructive` | Errors |
| `--border`, `--input` | `--orbit-border` | `border` (default color) | Hairline borders |
| `--border-strong` | `#33353d` | `border-border-strong` | Hover and selected borders |
| `--ring` | `--orbit-sun` | `ring-ring` | Focus rings |
| `--canvas` | `#07080a` | `bg-canvas` | Darker than the page, for wells |
| `--surface-sunken` | `#0e0f12` | `bg-surface-sunken` | Inputs, code blocks |
| `--surface-raised` | `#1d1e24` | `bg-surface-raised` | Kbd, slider track |
| `--positive`, `--warning`, `--info` | `#4fd18b`, `#f2cf4a`, `#5ec8f2` | `text-positive` | Status |
| `--skeleton`, `--skeleton-highlight` | `#1a1b20`, `#282a31` | `shimmer` | Loading placeholders |
| `--chart-1` to `--chart-5` | sun, sky, green, yellow, pink | `fill-chart-1` | Data series, in order |
| `--syntax-*` | keyword, string, number, function, comment, punctuation, builtin, class, operator | | Code highlighting |
| `--hairline-plate/hi/edge/mid/lo/stroke` | page, text, muted, muted mix, border, `0.9` | | Hairline figure theme |
| `--radius` | `0.625rem` | `rounded-sm` to `rounded-xl` | Corner radius scale |

Static theme values in `@theme`:

| Token | Value | Tailwind |
| --- | --- | --- |
| `--container-widget` | `42.5rem` | `max-w-widget` |
| `--text-2xs`, `--text-3xs` | `0.6875rem`, `0.5625rem` | `text-2xs`, `text-3xs` |
| `--shadow-card` | inset 1px top highlight plus a 1px drop | `shadow-card` |
| `--shadow-float` | long soft drop | `shadow-float` |
| `--ease-orbit` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | `ease-orbit` |
| `--animate-rise` | 220ms, 4px up and fade in | `animate-rise` |
| `--animate-shimmer`, `--animate-pulse-ring` | skeleton sweep, ping ring | `animate-shimmer` |
| `--animate-orbit-x`, `--animate-orbit-y` | the mark's satellite | used only by `OrbitMark` |

Utilities: `num` (Geist Mono, tabular figures), `shimmer`, `scrollbar-none`, `scrollbar-thin`.

## Rules

- **Type.** Geist Sans and Geist Mono from the `geist` package, self-hosted. No font CDN, no runtime requests. Numbers use tabular figures (`num` or `tabular-nums`). Sentence case everywhere.
- **Copy.** Short labels only. No taglines, helper text, or secondary labels. If a screen needs explaining, fix the layout.
- **Lines, not shadows.** 1px `border`, `shadow-card` on raised surfaces, `shadow-float` only on things that float (menus, dialogs, tooltips).
- **Accent.** Primary actions are ivory. Sun appears once or twice per screen: the mark, the active chat, the current prompt. Marks repeated down the thread use `tone="mono"` and turn sun only while busy. A selected toggle is a raised surface, not a tint.
- **Depth.** On dark, depth comes from a lighter surface. The composer lifts to `bg-popover` on focus instead of drawing a ring.
- **Touch.** On `pointer: coarse` every control has a 44px hit area. `globals.css` grows buttons and links with a pseudo-element. A control whose parent clips it grows its own box with `pointer-coarse:`.
- **Icons.** `@phosphor-icons/react`, weight `light` by default, `regular` at 14px and below. Import the `*Icon` names (`XIcon`, not the deprecated `X`). In a server component import from `@phosphor-icons/react/ssr`.
- **Motion.** 150 to 250ms, `ease-orbit`. Messages enter with `animate-rise`. No bouncing. `prefers-reduced-motion` cuts every animation and transition to near zero, and the mark's satellite stops.
- **Width.** The chat column and every json-render widget are capped at `max-w-widget`.

## Components

`src/components/ui/` holds shadcn-style primitives on individual `@radix-ui/react-*` packages: `Button`, `Input`, `Label`, `Slider`, `Tooltip`, `ToggleGroup`, `Select`, `Dialog`, `Skeleton`, `Kbd`. Each sets `data-slot` for styling from a parent.

`OrbitMark` (`src/components/orbit-mark.tsx`) is the app's only loading indicator. Pass `busy` while the assistant is thinking or streaming and the moon travels the ring, passing behind the planet on the far side. `tone` is `"accent"` (violet ring and moon) or `"mono"` (muted). It is `aria-hidden`, so pair it with a status label where the state matters to a screen reader.

`ThreadMap` (`src/components/chat/thread-map.tsx`) is a rail of ticks on the thread's right edge, one per prompt, shown from three prompts when the thread is at least 52rem wide. Ticks for turns in view are brighter and the current turn is sun. Hovering or focusing the rail opens the prompt list. A row jumps to its prompt and moves focus there. `Alt+Up` and `Alt+Down` step between prompts. The current-turn math lives in `src/lib/thread-map.ts`.

A chat with no provider and no messages shows the provider form in place, so the first run never leaves the chat. Saving refreshes the route and the composer appears.

`ScrollFade` (`src/components/ui/scroll-fade.tsx`) wraps anything that scrolls on one axis and fades the edge that has more content behind it. Pass `fade` as the color of the surface behind the content. Code blocks, markdown tables, and the command palette use it. A cut line or row without a fade reads as a layout bug.

Code blocks longer than 20 lines open capped at 14 with a "N more lines" control. Lines never wrap; they scroll sideways under a fade.

`Figure` (`src/components/figure.tsx`) renders a hairline figure by name, `"dish"` for an empty chat, `"padlock"` on sign-in, `"plug"` when no provider is configured. It fills its parent's width at a 5:4 ratio, so size the parent. Plates are filled with `--hairline-plate`, which is the page color. On any other surface, set `--hairline-plate` on the parent to that surface's color. To add a figure, import it from `@lucasmarkes/hairline/react` and add it to the `figures` record.

## json-render widgets (slice 2)

Widgets are cards on the chat column: `bg-card`, `border`, `shadow-card`, `rounded-lg`, at most `max-w-widget`. Series take `--chart-1` onward in order. Code takes the `--syntax-*` tokens. Loading states use `Skeleton` in the shape of the content they replace.

- **Numbers.** Format with `Intl.NumberFormat` and set them in `num`. `42000` renders as `42,000`.
- **Long content.** Code goes through the markdown code block, so it gets the cap and the sideways scroll. Long text clamps with a "more" control. A wide table sits in `ScrollFade` with `fade="var(--card)"`.
- **Editable text.** Shows it is editable at rest: a dashed hairline border and a 14px pencil at the end of the line. Hover and focus solidify the border.
- **Actions.** Use `Button`, so focus gets the ring instead of the browser outline.
- **One place per value.** A value bound to state renders once. If a callout shows a note, the button does not repeat it.
- **Failures.** A spec that fails validation renders one line in `text-destructive` with a disclosure for the raw JSON, collapsed by default.

## Tool run cards

Every tool call uses a bordered card in the chat column. The header shows the tool name and Running, Succeeded, Failed, or Cancelled. Running uses `OrbitMark`. Status comes from the message part, so the same card appears after reload.

Web search results are text links with short snippets. Each result has a bordered square with the domain's first letter. Unknown tools show their JSON output in a collapsed Output disclosure.

Code runs show source, stdout, and stderr in separate code wells with scroll fades. A channel with no text, or only spaces and line breaks, has no well and no label, so a silent run shows only its source and result. Each well with text has an icon button at its top right that copies exactly that text. It shows a check for 1.5 seconds after a copy and a warning mark if the browser refuses, and a hidden live region announces the result. The result line states one outcome and a duration, and never repeats the header status: `Exit 0`, `Exit 3`, `Timed out after 10.1 s`, `Killed (exit 137)`, or `Stopped after 2.0 s`. A duration under one second shows milliseconds, and a longer one shows seconds. Nonzero exits, kills, and timeouts show Failed. Completed code and output survive reload.
