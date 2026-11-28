# Artifacts page

Slice 21 stores every HTML, SVG and React artifact, links its versions, and lists them on `/artifacts`. Run from the repo root after a build, with an empty verification sandbox.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse artifacts-page
node .agents/skills/verify-orbit/verify.mjs browse artifacts
node .agents/skills/verify-orbit/verify.mjs browse artifact-review
node .agents/skills/verify-orbit/verify.mjs browse security-headers
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario uses `[qa:artifact-version]`. The mock answers it with one HTML block titled `Counter` that holds `<p>Version N</p>`, where `N` counts up in each mock process. The scenario reads each reply's number from the saved chat, so it does not depend on how many times the mock answered before.

It checks, at 1280 by 800:

- **Versions.** Sends `[qa:artifact-version]`, presses **Regenerate**, then edits the prompt and sends it again. The chat panel shows `v1`, `v2` and `v3`, the card reads `HTML · v3`, and `GET /api/chats/<id>/artifacts` lists the three replies oldest first. `v1` opens its own branch and previews its version.
- **Rename and download.** **Rename artifact** renames `Counter` to `Tally`. The panel header, the card and every stored version show `Tally`, and **Download** saves `tally.html`. Escape cancels a rename and keeps the panel open. A blank title resets to `Counter`, then the scenario renames it back to `Tally`.
- **Diff.** Enter in rename puts focus back on **Rename artifact**, and a click on `v3` must still reach `v3`. When the button's tooltip takes the click, that step fails, saves `rename-tooltip.png`, and presses Escape to close the tooltip so the diff checks still run. On `v3`, **Diff** compares with `v2` by default. It marks one line removed with the old `Version` and one added with the new one, and counts `+1` and `-1`. Switching **Compare with** to `v1` compares `v1` with `v3`.
- **Keys.** Each `[qa:artifact-multiple]` card opens with the same `?artifact=` key that its stored row has.
- **Library.** The sidebar link opens `/artifacts` in two panes. Search and the **Kind** filter keep the old rows on screen, marked `aria-busy`, until the answer arrives, so the scenario reads the rows only after that. Search finds only `Tally` for `Tally`, and `Tally Version <v2's number>`, and a search with no hit says `No matching artifacts`. **HTML** and **SVG** show only their kind. `v1` and `v3` switch the preview and the diff, and `?id=` survives a reload. **Download** saves `tally.html`, and the preview frame has only `allow-scripts` and cannot read `parent.document`, `document.cookie` or fetch the app. Enter on a focused row opens it, and ArrowRight from **Code** reaches **Diff**. **Open in chat** lands on `v1`'s branch with its preview open. An unknown `?id=` says `Artifact not found`.
- **Chat delete.** Deleting a chat from the sidebar, after the five-second Undo ends, removes its artifact from the list and the search.
- **Privacy.** Signed out, the four artifact API routes answer 401 and `/artifacts` redirects to `/login`. In Team mode a seeded member sees `No artifacts`, an empty `GET /api/artifacts`, and 404 for the admin's artifact and chat. The scenario then removes the member and restores the hosting mode.
- **Phones.** At 390 by 844 and 360 by 740 with touch, `/artifacts` opens on the list. Rows, filter pills, Back, version buttons, tabs and actions are at least 44px tall. Preview, Code and Diff have no sideways scroll. The rename field is at least 16px. **Back** and browser Back return to the list.

`browse security-headers` also loads `/artifacts`, checks its `frame-ancestors 'none'` and `X-Frame-Options: DENY` headers, and checks that a page on another loopback port cannot frame it.

The labels and attributes the scenario finds are in the `UI` table at the top of `scenarios/artifacts-page.mjs`.

Proof goes in `.verify/evidence/artifacts-page/summary.txt` and the screenshots `versions.png`, `renamed.png`, `diff.png`, `list.png`, `search.png`, `open-in-chat.png`, `empty.png`, `list-390.png`, `detail-390.png`, `diff-390.png`, `list-360.png` and `diff-360.png`. Post them in the PR thread. Do not commit them.
