# Branching

Run `node .agents/skills/verify-orbit/verify.mjs launch --mock`, then `doctor` and `browse branches`.

The browser sends a prompt, regenerates its answer, and opens the first answer with Previous. It edits the prompt and reloads. The stored tree keeps both prompts and all three answers. Reload selects the last written branch. Switching to the original prompt restores its answer picker.

The scenario prints only message ids and trigger names from chat requests. It saves `regenerated.png`, `previous.png`, `edited.png`, `reloaded.png`, and `mobile.png` under `.verify/evidence/branches/`. The mobile view is 390 by 844. A request with a missing parent link must return 409 and leave the stored tree unchanged.

For real-provider proof, start a fresh sandbox without `--mock`. Provide `ORBIT_BASE_URL`, `ORBIT_API_KEY`, and `ORBIT_MODEL` through the environment. Run `drive chat`, then use a fresh sandbox and run `browse branches` against those settings. The scenario saves those environment settings through the settings API. Real-provider prompts ask for one word. Keep the output and picker screenshot in the PR comment.

Run `cleanup` after each server run. Evidence stays on disk.
