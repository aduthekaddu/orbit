# Check durable replies

Run these commands from the repo root. Set `ORBIT_VERIFY_PORT` first if the default port is in use.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse durable-reply
node .agents/skills/verify-orbit/verify.mjs browse retry-stop
node .agents/skills/verify-orbit/verify.mjs browse reply-actions
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario first drops the initial reply before the app receives the response headers, then checks that the open tab fetches the same reply and shows all 50 words. It also drops the connection after text reaches Chrome while the browser stays online. It checks that Chrome shows **Reconnecting**, renders all 50 words, and has one copy of the reply after a reload. The scenario repeats this check at 390 by 844 pixels.

It also checks that the live thinking timer stays accurate when the browser clock runs two minutes ahead of or behind the server, drops the connection during thinking, and checks that the timer survives reload. It presses **Stop** during a second reply and checks that the reasoning, duration, and **Stopped** label survive. Switching chats must leave the reply running. A second tab can watch that reply but gets HTTP 409 if it sends another prompt. A tab focused on an older branch stays on that branch.

`reply-actions` checks that **Stop** cancels a send before response headers arrive, whether the server already reserved the turn or the request stalled before reaching it. It also holds the Retry response while it checks that the old status clears and only one request goes out, and checks that a pending Stop or reconnect blocks edit submission without losing the draft or the active reply.

Check `.verify/evidence/durable-reply/summary.txt` and the screenshots `dropped.png`, `finished.png`, `thinking.png`, `thought.png`, `stopped.png`, and `phone.png`.

To check Stop with a running code tool, launch a fresh [sandbox verification server](sandbox.md) and run `browse sandbox-stop-output`.
