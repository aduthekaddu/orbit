# Artifact previews

Run from the repo root after a build. Start with an empty verification sandbox.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse artifacts
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario sends `[qa:artifact-html]`, `[qa:artifact-svg]`, `[qa:artifact-react]` and `[qa:artifact-error]` through the composer. It opens each reply's Preview button and checks the running output. React needs access to esm.sh.

A pass requires the HTML button and React counter to respond to clicks. Each kind must block access to `parent.document`, `document.cookie` and fetch requests to the app origin. The frame's only sandbox flag must be `allow-scripts`. A message sent from the parent window must not appear as a runtime error.

The scenario also checks the Code tab, Reload, Copy and Download. An Edit code save updates the open preview. A page reload restores it from `?artifact=`, and Escape and Close remove that parameter. A runtime error appears under the preview, and Fix puts it in the composer.

Last, it saves a reply whose reasoning holds an HTML block before the reply's own HTML block. Thought must show no Preview button for its block, and the reply's Preview must show the reply's HTML while Thought is open and after Thought closes.

The layout checks use 1440 by 900 and 390 by 844 viewports. The phone preview must fill a dialog, and neither page may scroll horizontally.

Proof goes in `.verify/evidence/artifacts/summary.txt` and the screenshots `html.png`, `svg.png`, `react-clicked.png`, `error.png`, `reloaded.png`, `mobile.png` and `reasoning-open.png`. Before implementation, the missing Preview action produces `before.png` and a failed step. Copy that evidence elsewhere under `.verify/` before a later run, since browse replaces the scenario's evidence folder.

Run the real-provider check with `ORBIT_BASE_URL`, `ORBIT_API_KEY` and `ORBIT_MODEL` in the environment:

```sh
node .agents/skills/verify-orbit/verify.mjs launch
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse artifacts-real
node .agents/skills/verify-orbit/verify.mjs cleanup
```

It asks for a small HTML page with a button that changes color, opens Preview and clicks the button. The scenario waits for hover and click animations to finish. A pass requires the button's computed color to change after the click. It saves `.verify/evidence/artifacts-real/real-provider-clicked.png`. Post the command output and screenshots in the PR thread. Do not commit proof files.


Run `node .agents/skills/verify-orbit/verify.mjs browse artifact-review` after `launch --mock` for the PR review regressions. It checks older branches, earlier code edits that grow and shrink, TSX downloads, editor Escape, keyboard tabs, long-error fades and phone Fix focus. Evidence goes to `.verify/evidence/artifact-review/`.
