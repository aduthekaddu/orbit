# Check reading and appearance

Run these commands from the repo root. Set `ORBIT_VERIFY_PORT` first if the default port is in use.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse reading
node .agents/skills/verify-orbit/verify.mjs browse appearance
node .agents/skills/verify-orbit/verify.mjs cleanup
```

`reading` sends `[qa:markdown]`, a long deploy guide with every heading level, lists, a blockquote, a table, inline code, two code blocks, and a long URL. It saves each theme and text size through `PATCH /api/preferences` and measures the rendered page at 1440, 390 with touch, and 360 with touch. It checks that a reply is 16px at medium with a line height from 1.6 to 1.7, that a desktop line holds 65 to 75 characters, that the root size is 15, 16, 18, and 20px for the four text sizes, and that every input, textarea, and select is at least 16px. It checks that no visible text is under 13px outside `kbd` on the chat, the empty chat, settings, memory, and the palette, that `h1` to `h6` and body text look distinct, that no text fails contrast in dark, dim, light, or system, that the page never scrolls sideways on a phone, and that a sans reader downloads no serif font. It prints a role table in the shape of the slice 14 baseline. `ORBIT_READING_SWEEP=1` instead prints the characters per line for a 34 to 40rem column and asserts nothing.

`appearance` opens `/settings` and finds the Appearance card with five rows at 1440 and four on a phone, where Chat width is hidden, and checks that each toggle has a 44px touch target. It picks Light and checks that the page changes at once, survives a reload, and comes back from the server with `data-theme="light"` and the light theme color. It opens a chat with JavaScript off and checks that the page is already light, and checks that the background is the same before and after hydration. It checks that System follows the operating system with no reload. It holds the first save while it clicks Dim, Large, Serif, and Sky, then checks that all four persist, and makes a save fail and checks that only that choice reverts, with one "Could not save" line. It checks that Serif changes the reply font and leaves user messages sans, that Wide widens the column, and that each accent recolors the active chat marker. It checks that `PATCH /api/preferences` answers 400 for `{}`, `{"theme":"neon"}`, `{"colour":"red"}`, and invalid JSON, and 401 without a session. It signs out and checks that the login page is dark, then signs in and checks that Light returns.

Check `.verify/evidence/reading/summary.txt`, `.verify/evidence/appearance/summary.txt`, and the screenshots `markdown-1440-dark.png`, `markdown-1440-dim.png`, `markdown-1440-light.png`, `markdown-1440-serif.png`, `markdown-390-light.png`, `markdown-360-xl.png`, `settings-1440.png`, `settings-390.png`, `first-paint-light-nojs.png`, `system-light.png`, and `system-dark.png`.
