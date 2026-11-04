# History search

Run `node .agents/skills/verify-orbit/verify.mjs launch --mock`, then `doctor` and `browse search`.

The browser opens two chats. The second message is a stack trace tagged `[qa:zebracorn]`. The mock reply contains `zebracorn`. From the first chat, Ctrl+K and the word `zebracorn` show a Messages result. Choosing it opens that chat at the message and leaves the stored branch head unchanged. The sidebar title becomes `Mock title`.

The scenario saves `long-title.png`, `before.png` or `results.png`, `opened.png`, `title.png`, and `mobile.png` under `.verify/evidence/search/`. The mobile view is 390 by 844. On a build without message search, the palette step fails and the shot is `before.png`.

Run `browse search-focus` to check user-message focus in a long chat and scrolling during a follow-up reply on a phone. Opening the result must keep the saved branch head. The scenario saves `user-hit.png` and `follow-up-stream.png` under `.verify/evidence/search-focus/`.

Run `cleanup` after the server stops. Evidence stays on disk.
