# Artifact previews

Run from the repo root after a build. Start with an empty verification sandbox.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse artifacts
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario sends `[qa:artifact-html]`, `[qa:artifact-svg]`, `[qa:artifact-react]` and `[qa:artifact-error]` through the composer. Each reply shows an artifact card instead of its code. The scenario clicks the card's **Open** button (`Open <title>`) and checks the running output. React needs access to esm.sh.

A pass requires the HTML button and React counter to respond to clicks. Each kind must block access to `parent.document`, `document.cookie` and fetch requests to the app origin. The frame's only sandbox flag must be `allow-scripts`. A message sent from the parent window must not appear as a runtime error.

The scenario also checks the Code tab, Reload, Copy and Download, and verifies that Copy put the artifact source on the clipboard. An Edit code save updates the open preview. A page reload restores it from `?artifact=`, and Escape and Close remove that parameter. A runtime error appears under the preview, and Fix puts it in the composer.

Last, it saves a reply whose reasoning holds an HTML block before the reply's own HTML block. Thought must show no artifact card for its block, and the reply's **Open** must show the reply's HTML while Thought is open and after Thought closes.

The layout checks use 1440 by 900 and 390 by 844 viewports. The phone preview must fill a dialog, and neither page may scroll horizontally.

Proof goes in `.verify/evidence/artifacts/summary.txt` and the screenshots `html.png`, `svg.png`, `react-clicked.png`, `error.png`, `reloaded.png`, `mobile.png` and `reasoning-open.png`. When the reply has no card with **Open**, the scenario saves `before.png` and fails a step. Copy that evidence elsewhere under `.verify/` before a later run, since browse replaces the scenario's evidence folder.

Run the real-provider check with `ORBIT_BASE_URL`, `ORBIT_API_KEY` and `ORBIT_MODEL` in the environment. The scenario connects that provider and makes `ORBIT_MODEL` the default:

```sh
node .agents/skills/verify-orbit/verify.mjs launch
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse artifacts-real
node .agents/skills/verify-orbit/verify.mjs cleanup
```

It asks for a small HTML page with a button that changes color, clicks the card's **Open**, and clicks the button. The scenario waits for hover and click animations to finish. A pass requires the button's computed color to change after the click. It saves `.verify/evidence/artifacts-real/real-provider-clicked.png`. Post the command output and screenshots in the PR thread. Do not commit proof files.


Run `node .agents/skills/verify-orbit/verify.mjs browse artifact-navigation` after `launch --mock` to check that a preview cannot load another URL into its frame. It starts a probe on a free loopback port and edits an HTML block to send the frame there, at load, after a delay, and again after Reload. A pass requires the artifact's error report to show that the code ran, and the probe to get no request from the frame. Evidence goes to `.verify/evidence/artifact-navigation/`.

Run `node .agents/skills/verify-orbit/verify.mjs browse artifact-review` after `launch --mock` for the PR review regressions. It checks older branches, earlier code edits that grow and shrink, TSX downloads, editor Escape, keyboard tabs, long-error fades and phone Fix focus. Evidence goes to `.verify/evidence/artifact-review/`.

Stored versions, rename, Diff and the `/artifacts` library have their own scenario, `browse artifacts-page`. See [Artifacts page](artifacts-page.md).

Run `node .agents/skills/verify-orbit/verify.mjs browse security-headers` after `launch --mock` to check the response headers in Chrome. It records every `securitypolicyviolation` event on the page and in the preview frame, and first proves it sees one in each. A pass requires the chat page, Settings, Memory, Artifacts and the HTML, SVG and React previews to raise no other violation, and the Artifacts page to send `frame-ancestors 'none'` and `X-Frame-Options: DENY`. A page served from a free loopback port then frames the login, chat, Settings, Memory and Artifacts pages beside a frame of its own. Each Orbit frame must show Chrome's error page while the probe's own frame loads. Evidence goes to `.verify/evidence/security-headers/`.
